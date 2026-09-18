import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  MemoryEvidenceItem,
  MemoryEvidenceReadCost,
  MemoryEvidenceReference,
} from "../../shared/contracts/memoryRecall";
import { memoryRevisionHistorySql } from "./memoryRevisionHistory";
import type { ProviderRequestIdentity } from "../providers/providerError";
import { redactBoundaryValue } from "../../shared/pure/redaction";

export const MEMORY_CONSOLIDATION_VERSION = "grounded-consolidation-v1";
/** Execution changes must not invalidate the stable derived-evidence format. */
export const MEMORY_CONSOLIDATION_PROCESSOR_VERSION =
  "grounded-consolidation-processing-v4";
export const CONSOLIDATION_KEYS = [
  "consolidationVersion",
  "consolidationDependencyCount",
] as const;

/** Both SQL aliases belong to the enclosing revision query. No recursive derived
 * parents are admitted: the complete, immutable expected dependency count makes
 * FK-cascaded deletion invalid rather than accidentally reviving an orphan.
 * Child span coverage is set inclusion of non-null, binary-comparable tuples;
 * expanding linked parent spans once avoids scanning every link per child span. */
export const LIVE_DERIVATION_SQL = `(json_extract(s.qualifiers_json,'$.consolidationVersion') IS NULL OR (
  json_extract(s.qualifiers_json,'$.consolidationVersion')='${MEMORY_CONSOLIDATION_VERSION}'
  AND CAST(json_extract(s.qualifiers_json,'$.consolidationDependencyCount') AS INTEGER)>0
  AND (SELECT COUNT(*) FROM memory_revision_links dl
    WHERE dl.from_revision_id=r.id AND dl.relation='derived_from')=
    CAST(json_extract(s.qualifiers_json,'$.consolidationDependencyCount') AS INTEGER)
  AND NOT EXISTS (SELECT 1 FROM memory_revision_links dl
    LEFT JOIN memory_revisions dr ON dr.id=dl.to_revision_id
    LEFT JOIN memories dm ON dm.id=dr.memory_id
    LEFT JOIN memory_revision_semantics ds ON ds.revision_id=dr.id
    WHERE dl.from_revision_id=r.id AND dl.relation='derived_from' AND (
      dm.id IS NULL OR ds.revision_id IS NULL OR dm.deleted_at IS NOT NULL OR dm.status='archived'
      OR json_extract(ds.qualifiers_json,'$.consolidationVersion') IS NOT NULL
      OR ${memoryRevisionHistorySql("dr", "dm").status} IN ('corrected','unresolved')
      OR NOT (ds.owner=s.owner AND ds.persona_id IS s.persona_id)
      OR NOT EXISTS (SELECT 1 FROM memory_revision_source_spans dp JOIN memory_revision_source_spans sp
        ON sp.source_id=dp.source_id AND sp.span_start=dp.span_start AND sp.span_end=dp.span_end AND sp.quote=dp.quote
        WHERE dp.revision_id=dr.id AND sp.revision_id=r.id AND dp.source_id=dl.evidence_source_id)
      OR (dl.dependency_use='current' AND (dm.status<>'active' OR dm.current_revision_id<>dr.id
        OR (COALESCE(ds.valid_to,dm.valid_to) IS NOT NULL AND COALESCE(ds.valid_to,dm.valid_to)<=@derivationNow)
        OR (COALESCE(ds.valid_from,dm.valid_from) IS NOT NULL AND COALESCE(ds.valid_from,dm.valid_from)>@derivationNow)))
    ))
  AND NOT EXISTS (
    SELECT sp.source_id,sp.span_start,sp.span_end,sp.quote
      FROM memory_revision_source_spans sp WHERE sp.revision_id=r.id
    EXCEPT
    SELECT dp.source_id,dp.span_start,dp.span_end,dp.quote
      FROM memory_revision_links dl JOIN memory_revision_source_spans dp
        ON dp.revision_id=dl.to_revision_id AND dp.source_id=dl.evidence_source_id
      WHERE dl.from_revision_id=r.id AND dl.relation='derived_from')))`;

export interface MemoryConsolidationWork {
  id: string;
  subjectId: string;
  sourceVersion: string;
  attempt: number;
  updatedAt: string;
}

/** Measure exactly the result columns of a Memory-owned query in SQLite.
 * No projected text crosses into JS; this is scalar data size, not a heap bound.
 * Fresh statements and the caller's synchronous transaction avoid stale column metadata. */
export function measureMemoryEvidenceRows(
  database: Database.Database,
  sql: string,
  parameters: Readonly<Record<string, string | number | null>>,
): MemoryEvidenceReadCost {
  const columns = database.prepare(sql).columns();
  const values = columns.map(
    ({ name }) =>
      `COALESCE(length(CAST(read_rows."${name.replaceAll('"', '""')}" AS BLOB)),0)`,
  );
  const cost = database
    .prepare(
      `SELECT COALESCE(SUM(${values.join("+")}),0) AS rawValueBytes,
       COUNT(*) AS rowCount FROM (${sql}) AS read_rows`,
    )
    .get(parameters) as MemoryEvidenceReadCost;
  if (
    !Number.isSafeInteger(cost.rawValueBytes) ||
    cost.rawValueBytes < 0 ||
    !Number.isSafeInteger(cost.rowCount) ||
    cost.rowCount < 0
  )
    throw new RangeError(
      "Memory evidence read cost is not a finite safe count",
    );
  return cost;
}

const DERIVATION_QUALIFIERS_SQL = `SELECT qualifiers_json
  FROM memory_revision_semantics WHERE revision_id=@revisionId
  AND json_extract(qualifiers_json,'$.consolidationVersion') IS NOT NULL
  AND json_extract(qualifiers_json,'$.consolidationVersion')<>''`;

const DERIVATION_DEPENDENCIES_SQL = `SELECT DISTINCT dr.memory_id AS memoryId,
  dl.to_revision_id AS revisionId,dl.dependency_use AS use
  FROM memory_revision_links dl JOIN memory_revisions dr ON dr.id=dl.to_revision_id
  WHERE dl.from_revision_id=@revisionId AND dl.relation='derived_from' ORDER BY revisionId`;

function memorySupportSql(revisionIds: string): string {
  return `SELECT COUNT(DISTINCT substr(ws.occurred_at,1,10)) AS distinctUserDays,
    COUNT(DISTINCT NULLIF(json_extract(w.payload_json,'$.situationId'),'')) AS distinctContexts,
    COUNT(DISTINCT rs.source_id) AS sourceCount
  FROM memory_revision_sources rs JOIN memory_sources src ON src.id=rs.source_id AND src.raw_speaker='user'
  JOIN memory_work_sources ws ON ws.source_id=rs.source_id AND ws.is_primary=1
  JOIN memory_work w ON w.id=ws.work_id
  WHERE rs.revision_id IN (${revisionIds})
    AND (@day IS NULL OR substr(ws.occurred_at,1,10)<=@day)
    AND (@citedSourceIds IS NULL OR rs.source_id IN (SELECT value FROM json_each(@citedSourceIds)))`;
}

export class MemoryLearningRepository {
  constructor(private readonly database: Database.Database) {}

  /** Canonical raw-user primary sources are candidate support, not a semantic
   * independence verdict. Reusing a source in revisions or work adds no source.
   * Days and all non-empty situation labels describe coverage only, not certainty.
   * Undefined citations supplies all metadata; an explicit empty list counts none. */
  support(
    revisionIds: readonly string[],
    observedBy?: string,
    citedSourceIds?: readonly string[],
  ): {
    distinctUserDays: number;
    distinctContexts: number;
    sourceCount: number;
  } {
    const row = this.database
      .prepare(memorySupportSql("SELECT value FROM json_each(@revisionIds)"))
      .get({
        revisionIds: JSON.stringify(revisionIds),
        day: observedBy?.slice(0, 10) ?? null,
        citedSourceIds:
          citedSourceIds === undefined ? null : JSON.stringify(citedSourceIds),
      }) as {
      distinctUserDays: number;
      distinctContexts: number;
      sourceCount: number;
    };
    return row;
  }

  /** Counts only persisted citation material versus the exact supplied tuples.
   * Complete projection is not a claim that every clause of a memory is true,
   * or that all relevant experiences have ever been recorded. */
  evidenceSupply(evidence: readonly MemoryEvidenceItem[]): {
    revisionId: string;
    storedSourceCount: number;
    suppliedSourceCount: number;
    unavailableSourceCount: number;
    storedSpanCount: number;
    suppliedSpanCount: number;
    omittedStoredSpanCount: number;
    unavailableSpanCount: number;
  }[] {
    const counts = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM memory_revision_sources WHERE revision_id=@revisionId) AS sourceCount,
      (SELECT COUNT(*) FROM memory_revision_source_spans WHERE revision_id=@revisionId) AS spanCount`);
    const hasSource = this.database.prepare(
      "SELECT 1 FROM memory_revision_sources WHERE revision_id=? AND source_id=?",
    );
    const hasSpan = this.database.prepare(
      "SELECT 1 FROM memory_revision_source_spans WHERE revision_id=? AND source_id=? AND span_start=? AND span_end=? AND quote=?",
    );
    return evidence.map((item) => {
      const stored = counts.get({ revisionId: item.revisionId }) as {
        sourceCount: number;
        spanCount: number;
      };
      const sources = new Set<string>();
      const spans = new Set<string>();
      let suppliedSourceCount = 0,
        suppliedSpanCount = 0,
        unavailableSpanCount = 0;
      for (const source of item.sourceRefs) {
        if (!sources.has(source.sourceId)) {
          sources.add(source.sourceId);
          if (hasSource.get(item.revisionId, source.sourceId))
            suppliedSourceCount++;
        }
        for (const span of source.spans ?? []) {
          const key = JSON.stringify([
            source.sourceId,
            span.start,
            span.end,
            span.quote,
          ]);
          if (spans.has(key)) continue;
          spans.add(key);
          if (
            hasSpan.get(
              item.revisionId,
              source.sourceId,
              span.start,
              span.end,
              span.quote,
            )
          )
            suppliedSpanCount++;
          else unavailableSpanCount++;
        }
      }
      return {
        revisionId: item.revisionId,
        storedSourceCount: stored.sourceCount,
        suppliedSourceCount,
        unavailableSourceCount: sources.size - suppliedSourceCount,
        storedSpanCount: stored.spanCount,
        suppliedSpanCount,
        omittedStoredSpanCount: stored.spanCount - suppliedSpanCount,
        unavailableSpanCount,
      };
    });
  }

  derivation(
    revisionId: string,
    now: string,
  ): MemoryEvidenceItem["derivation"] {
    const row = this.database
      .prepare(DERIVATION_QUALIFIERS_SQL)
      .get({ revisionId }) as { qualifiers_json: string } | undefined;
    const qualifiers = row
      ? (JSON.parse(row.qualifiers_json) as Record<string, string>)
      : {};
    if (!qualifiers["consolidationVersion"]) return undefined;
    const dependencies = this.database
      .prepare(DERIVATION_DEPENDENCIES_SQL)
      .all({ revisionId }) as MemoryEvidenceReference[];
    const support = this.support(
      dependencies.map(({ revisionId: id }) => id),
      now,
    );
    return {
      kind: "consolidation",
      dependencies,
      sourceRevisionCount: dependencies.length,
      distinctUserDays: support.distinctUserDays,
      distinctContexts: support.distinctContexts,
    };
  }

  /** The same derivation queries as the real projection, without reading its
   * qualifiers or dynamic parent list into JS during the cost phase. */
  derivationReadCost(revisionId: string, now: string): MemoryEvidenceReadCost {
    const qualifiers = measureMemoryEvidenceRows(
      this.database,
      DERIVATION_QUALIFIERS_SQL,
      { revisionId },
    );
    if (!qualifiers.rowCount) return qualifiers;
    const dependencies = measureMemoryEvidenceRows(
      this.database,
      DERIVATION_DEPENDENCIES_SQL,
      { revisionId },
    );
    const support = measureMemoryEvidenceRows(
      this.database,
      memorySupportSql(
        "SELECT revisionId FROM (" + DERIVATION_DEPENDENCIES_SQL + ")",
      ),
      { revisionId, day: now.slice(0, 10), citedSourceIds: null },
    );
    return {
      rawValueBytes:
        qualifiers.rawValueBytes +
        dependencies.rawValueBytes +
        support.rawValueBytes,
      rowCount: qualifiers.rowCount + dependencies.rowCount + support.rowCount,
    };
  }

  anchor(
    memoryId: string,
  ): { revisionId: string; content: string } | undefined {
    return this.database
      .prepare(
        `SELECT r.id AS revisionId,r.content FROM memories m JOIN memory_revisions r ON r.id=m.current_revision_id
      WHERE m.id=? AND m.deleted_at IS NULL AND m.status='active'`,
      )
      .get(memoryId) as { revisionId: string; content: string } | undefined;
  }

  snapshot(memoryId: string): string | undefined {
    const row = this.database
      .prepare(
        `SELECT m.current_revision_id AS revisionId,s.qualifiers_json AS qualifiers
      FROM memories m LEFT JOIN memory_revision_semantics s ON s.revision_id=m.current_revision_id
      WHERE m.id=? AND m.deleted_at IS NULL AND m.status='active'`,
      )
      .get(memoryId) as
      { revisionId: string; qualifiers: string | null } | undefined;
    if (
      !row ||
      (row.qualifiers &&
        (JSON.parse(row.qualifiers) as Record<string, string>)[
          "consolidationVersion"
        ])
    )
      return undefined;
    const sources = this.database
      .prepare(
        "SELECT source_id FROM memory_revision_sources WHERE revision_id=? ORDER BY source_id",
      )
      .all(row.revisionId);
    return createHash("sha256")
      .update(JSON.stringify({ revisionId: row.revisionId, sources }))
      .digest("hex");
  }

  enqueue(memoryId: string, now: string): void {
    const version = this.snapshot(memoryId);
    if (!version) return;
    const id = `reconcile:${memoryId}:${version}`;
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE memory_work SET status='complete',result_json='{"disposition":"superseded_before_start"}',updated_at=? WHERE kind='reconcile' AND subject_id=? AND status='pending' AND attempt=0 AND source_version<>?`,
        )
        .run(now, memoryId, version);
      this.database
        .prepare(
          `INSERT INTO memory_work(id,kind,subject_id,source_version,processor_version,status,updated_at) VALUES (?,'reconcile',?,? ,?,'pending',?) ON CONFLICT DO NOTHING`,
        )
        .run(
          id,
          memoryId,
          version,
          MEMORY_CONSOLIDATION_PROCESSOR_VERSION,
          now,
        );
    })();
  }

  /** Keyset cursor freezes one finite FIFO cohort; later events enter the next. */
  *pending(): Iterable<MemoryConsolidationWork> {
    const boundary = this.database
      .prepare(
        "SELECT updated_at,id FROM memory_work WHERE kind='reconcile' AND status='pending' ORDER BY updated_at DESC,id DESC LIMIT 1",
      )
      .get() as { updated_at: string; id: string } | undefined;
    if (!boundary) return;
    let cursor = { updated_at: "", id: "" };
    const next = this.database.prepare(
      `SELECT id,subject_id AS subjectId,source_version AS sourceVersion,attempt,updated_at AS updatedAt FROM memory_work WHERE kind='reconcile' AND status='pending' AND (updated_at,id)>(?,?) AND (updated_at,id)<=(?,?) ORDER BY updated_at,id LIMIT 1`,
    );
    for (;;) {
      const row = next.get(
        cursor.updated_at,
        cursor.id,
        boundary.updated_at,
        boundary.id,
      ) as MemoryConsolidationWork | undefined;
      if (!row) return;
      cursor = { updated_at: row.updatedAt, id: row.id };
      yield row;
    }
  }
  /** Group request transport by the actual latest completed Formation batch,
   * never by a shared user/entity/day. Each member retains its own question and
   * durable work; an ungrouped/manual record remains a singleton. */
  *pendingGroups(): Iterable<MemoryConsolidationWork[]> {
    const boundary = this.database
      .prepare(
        "SELECT updated_at,id FROM memory_work WHERE kind='reconcile' AND status='pending' ORDER BY updated_at DESC,id DESC LIMIT 1",
      )
      .get() as { updated_at: string; id: string } | undefined;
    if (!boundary) return;
    const batchFor = this.database.prepare(`
      SELECT fw.id,s.owner,s.persona_id AS personaId
      FROM memories m JOIN memory_revision_semantics s ON s.revision_id=m.current_revision_id
      JOIN memory_revision_sources rs ON rs.revision_id=m.current_revision_id
      JOIN memory_work_sources ws ON ws.source_id=rs.source_id AND ws.is_primary=1
      JOIN memory_work fw ON fw.id=ws.work_id
      WHERE m.id=@memoryId AND fw.kind='form' AND fw.status='complete'
        AND EXISTS (SELECT 1 FROM json_each(fw.result_json,'$.changes') change
          WHERE json_extract(change.value,'$.memoryId')=m.id
            AND json_extract(change.value,'$.revisionId')=m.current_revision_id)
      ORDER BY fw.updated_at DESC,fw.id DESC LIMIT 1`);
    const members = this.database.prepare(`
      SELECT DISTINCT w.id,w.subject_id AS subjectId,w.source_version AS sourceVersion,
        w.attempt,w.updated_at AS updatedAt
      FROM memory_work fw,json_each(fw.result_json,'$.changes') change
      JOIN memories m ON m.id=json_extract(change.value,'$.memoryId')
        AND m.current_revision_id=json_extract(change.value,'$.revisionId')
      JOIN memory_revision_semantics s ON s.revision_id=m.current_revision_id
      JOIN memory_work w ON w.subject_id=m.id AND w.kind='reconcile' AND w.status='pending'
      WHERE fw.id=@batchId AND s.owner=@owner AND s.persona_id IS @personaId
        AND (w.updated_at,w.id)<=(@throughAt,@throughId)
      ORDER BY w.updated_at,w.id`);
    for (const first of this.pending()) {
      const batch = batchFor.get({ memoryId: first.subjectId }) as
        { id: string; owner: string; personaId: string | null } | undefined;
      if (!batch) {
        yield [first];
        continue;
      }
      const rows = members.all({
        batchId: batch.id,
        owner: batch.owner,
        personaId: batch.personaId,
        throughAt: boundary.updated_at,
        throughId: boundary.id,
      }) as MemoryConsolidationWork[];
      const group = rows.filter((row) => {
        const owner = batchFor.get({ memoryId: row.subjectId }) as
          { id: string } | undefined;
        return owner?.id === batch.id;
      });
      yield group.some(({ id }) => id === first.id) ? group : [first];
    }
  }

  start(id: string, processorVersion: string, now: string): number | undefined {
    return this.database.transaction(() => {
      const prior = this.database
        .prepare(
          "SELECT processor_version AS processorVersion,attempt,error_code AS errorCode FROM memory_work WHERE id=? AND kind='reconcile' AND status='pending'",
        )
        .get(id) as
        | {
            processorVersion: string;
            attempt: number;
            errorCode: string | null;
          }
        | undefined;
      if (!prior) return undefined;
      // Older error_code values were human messages. Keep the existing boundary
      // when copying them into structured transition history.
      const transition =
        prior.attempt > 0 && prior.processorVersion !== processorVersion
          ? JSON.stringify(
              redactBoundaryValue({
                fromProcessorVersion: prior.processorVersion,
                toProcessorVersion: processorVersion,
                priorAttempt: prior.attempt,
                priorErrorCode: prior.errorCode,
                recordedAt: now,
              }),
            )
          : null;
      const row = this.database
        .prepare(
          `UPDATE memory_work SET status='running',
          result_json=CASE WHEN @transition IS NOT NULL THEN
            json_set(COALESCE(result_json,'{}'),'$.processorTransitions',
              json_insert(COALESCE(json_extract(result_json,'$.processorTransitions'),'[]'),'$[#]',
                json(@transition)))
            ELSE result_json END,
          processor_version=@processorVersion,attempt=attempt+1,updated_at=@now
          WHERE id=@id AND kind='reconcile' AND status='pending' RETURNING attempt`,
        )
        .get({ id, processorVersion, now, transition }) as
        { attempt: number } | undefined;
      return row?.attempt;
    })();
  }
  complete(id: string, attempt: number, result: unknown, now: string): void {
    if (
      this.database
        .prepare(
          "UPDATE memory_work SET status='complete',result_json=json_patch(COALESCE(result_json,'{}'),?),error_code=NULL,updated_at=? WHERE id=? AND kind='reconcile' AND status='running' AND attempt=?",
        )
        .run(JSON.stringify(result), now, id, attempt).changes !== 1
    )
      throw new Error("Consolidation work attempt changed");
  }
  fail(
    id: string,
    attempt: number,
    error: {
      code: string;
      message: string;
      requestIdentity?: ProviderRequestIdentity;
    },
    now: string,
    cancelled: boolean,
  ): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status=?,error_code=?,result_json=json_set(COALESCE(result_json,'{}'),'$.lastFailure',json(?)),updated_at=? WHERE id=? AND kind='reconcile' AND status='running' AND attempt=?",
      )
      .run(
        cancelled ? "pending" : "failed",
        error.code,
        JSON.stringify(
          redactBoundaryValue({ ...error, attempt, recordedAt: now }),
        ),
        now,
        id,
        attempt,
      );
  }
  /** Discard one obsolete output, preserving its failure and durable owner.
   * A newer anchor gets its own existing version key; no broad failed retry. */
  deferInputChange(
    work: MemoryConsolidationWork,
    attempt: number,
    error: { code: string; message: string; cause?: unknown },
    now: string,
  ): void {
    this.database.transaction(() => {
      const updated = this.database
        .prepare(
          `UPDATE memory_work
        SET status='pending',error_code=@code,
          result_json=json_set(COALESCE(result_json,'{}'),'$.lastFailure',json(@failure)),updated_at=@now
        WHERE id=@id AND kind='reconcile' AND status='running' AND attempt=@attempt`,
        )
        .run({
          id: work.id,
          attempt,
          code: error.code,
          now,
          failure: JSON.stringify(
            redactBoundaryValue({ ...error, attempt, recordedAt: now }),
          ),
        });
      if (updated.changes !== 1)
        throw new Error("Consolidation work attempt changed");
      if (this.snapshot(work.subjectId) === work.sourceVersion) return;
      this.enqueue(work.subjectId, now);
      this.database
        .prepare(
          `UPDATE memory_work SET status='complete',
        result_json=json_patch(result_json,'{"disposition":"source_changed"}'),updated_at=?
        WHERE id=? AND kind='reconcile' AND status='pending' AND attempt=?`,
        )
        .run(now, work.id, attempt);
    })();
  }

  recover(now: string): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status='pending',error_code='interrupted',updated_at=? WHERE kind='reconcile' AND status='running'",
      )
      .run(now);
  }
  retry(now: string): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status='pending',error_code=NULL,updated_at=? WHERE kind='reconcile' AND status='failed'",
      )
      .run(now);
  }

  retryFailedForProcessor(processorVersion: string, now: string): number {
    return this.#retryCurrentFailures("processor_version<>@processorVersion", {
      processorVersion,
      now,
    });
  }

  retryFailedForProvider(
    processorVersion: string,
    requestIdentity: ProviderRequestIdentity,
    now: string,
  ): number {
    return this.#retryCurrentFailures(
      `processor_version=@processorVersion
        AND error_code IN ('PROVIDER.TIMEOUT','PROVIDER.UNREACHABLE','PROVIDER.RATE_LIMITED','PROVIDER.UNAVAILABLE')
        AND json_extract(result_json,'$.lastFailure.requestIdentity.profileId')=@profileId
        AND json_extract(result_json,'$.lastFailure.requestIdentity.apiStyle')=@apiStyle
        AND json_extract(result_json,'$.lastFailure.requestIdentity.modelId')=@modelId`,
      { processorVersion, now, ...requestIdentity },
    );
  }

  #retryCurrentFailures(
    condition: string,
    parameters: {
      now: string;
      processorVersion: string;
    } & Partial<ProviderRequestIdentity>,
  ): number {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id,subject_id AS subjectId,source_version AS sourceVersion
            FROM memory_work WHERE kind='reconcile' AND status='failed' AND ${condition}`,
        )
        .all(parameters) as Pick<
        MemoryConsolidationWork,
        "id" | "subjectId" | "sourceVersion"
      >[];
      const retry = this.database.prepare(
        "UPDATE memory_work SET status='pending',updated_at=? WHERE id=? AND kind='reconcile' AND status='failed'",
      );
      let changed = 0;
      for (const row of rows) {
        if (this.snapshot(row.subjectId) === row.sourceVersion)
          changed += retry.run(parameters.now, row.id).changes;
      }
      return changed;
    })();
  }
  derivedTarget(
    memoryIds: readonly string[],
    owner: string,
    personaId: string | undefined,
    now: string,
  ): { memoryId: string; revisionId: string } | undefined {
    return this.database
      .prepare(
        `SELECT m.id AS memoryId,r.id AS revisionId FROM memory_revision_links dl JOIN memory_revisions raw ON raw.id=dl.to_revision_id JOIN memory_revisions r ON r.id=dl.from_revision_id JOIN memories m ON m.current_revision_id=r.id JOIN memory_revision_semantics s ON s.revision_id=r.id WHERE dl.relation='derived_from' AND raw.memory_id IN (SELECT value FROM json_each(@memoryIds)) AND m.deleted_at IS NULL AND m.status='active' AND s.owner=@owner AND s.persona_id IS @personaId AND json_extract(s.qualifiers_json,'$.consolidationVersion')=@version AND (s.valid_from IS NULL OR s.valid_from<=@derivationNow) AND (s.valid_to IS NULL OR s.valid_to>@derivationNow) AND ${LIVE_DERIVATION_SQL} ORDER BY m.updated_at DESC,m.id LIMIT 1`,
      )
      .get({
        memoryIds: JSON.stringify(memoryIds),
        owner,
        personaId: personaId ?? null,
        version: MEMORY_CONSOLIDATION_VERSION,
        derivationNow: now,
      }) as { memoryId: string; revisionId: string } | undefined;
  }
}
