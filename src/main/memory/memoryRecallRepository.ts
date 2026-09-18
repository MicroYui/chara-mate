import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import type Database from "better-sqlite3";

import type {
  MemoryEvidenceReference,
  MemoryEvidenceReferenceRequest,
  MemoryEvidenceItem,
  MemoryEvidenceReadCost,
  MemoryRevisionSemantics,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import { MemoryRevisionSemanticsSchema } from "../../shared/schemas/memoryRecall";
import { parseSchema } from "../../shared/schemas/validation";
import type { MemoryRepository } from "./memoryRepository";
import {
  LIVE_DERIVATION_SQL,
  measureMemoryEvidenceRows,
} from "./memoryLearningRepository";
import {
  memoryRevisionHistoryColumns,
  memoryRevisionHistoryCte,
  revisionHistoryValue,
  type MemoryRevisionHistoryRow,
} from "./memoryRevisionHistory";
import { memoryMatchExpression } from "./memorySearchText";
import type { MemoryVectorRow } from "./memoryVectorSearch";

interface SemanticRow {
  revision_id: string;
  kind: MemoryRevisionSemantics["kind"];
  owner: MemoryRevisionSemantics["owner"];
  persona_id: string | null;
  basis: MemoryRevisionSemantics["basis"];
  occurred_from: string | null;
  occurred_to: string | null;
  valid_from: string | null;
  valid_to: string | null;
  time_precision: MemoryRevisionSemantics["timePrecision"] | null;
  subject_entity_id: string | null;
  predicate: string | null;
  object_entity_id: string | null;
  object_value: string | null;
  qualifiers_json: string;
  commitment_state: MemoryRevisionSemantics["commitmentState"] | null;
}

export interface MemoryIndexWork {
  id: string;
  subject_id: string;
  source_version: string;
  content: string;
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface MemoryEvidenceProjection {
  readonly sourceLimit: number;
  readonly quoteBytes: number;
  readonly knownAt?: string;
}

function evidenceRevisionSql(): string {
  return `${memoryRevisionHistoryCte("SELECT id,memory_id FROM memory_revisions WHERE id IN (SELECT value FROM json_each(@input))")}
    SELECT r.id AS revisionId,r.memory_id AS memoryId,r.content,
    r.created_at AS createdAt,r.occurs_at AS occursAt,
    m.current_revision_id AS currentRevisionId,m.status,m.type,
    m.valid_from AS validFrom,m.valid_to AS validTo,${memoryRevisionHistoryColumns()}
    FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
    JOIN revision_history rh ON rh.id=r.id LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
    WHERE r.id IN (SELECT value FROM json_each(@input)) AND m.deleted_at IS NULL AND ${LIVE_DERIVATION_SQL}`;
}

const EVIDENCE_SOURCES_SQL = `SELECT id,type,reference_id,revision_id FROM (
  SELECT s.id,s.type,s.reference_id,rs.revision_id,
    ROW_NUMBER() OVER (PARTITION BY rs.revision_id ORDER BY s.created_at,s.id) AS ordinal
  FROM memory_revision_sources rs JOIN memory_sources s ON s.id=rs.source_id
  WHERE rs.revision_id IN (SELECT value FROM json_each(@input))
) WHERE @sourceLimit IS NULL OR ordinal<=@sourceLimit ORDER BY revision_id,ordinal`;

const EVIDENCE_SOURCE_COUNTS_SQL = `SELECT revision_id,COUNT(*) AS count
  FROM memory_revision_sources WHERE revision_id IN (SELECT value FROM json_each(@input)) GROUP BY revision_id`;
const EVIDENCE_SEMANTICS_SQL = `SELECT * FROM memory_revision_semantics
  WHERE revision_id IN (SELECT value FROM json_each(@input))`;
const EVIDENCE_ENTITIES_SQL = `SELECT revision_id,entity_id FROM memory_revision_entities
  WHERE revision_id IN (SELECT value FROM json_each(@input))`;
const EVIDENCE_LINKS_SQL = `SELECT DISTINCT from_revision_id,to_revision_id,relation
  FROM memory_revision_links WHERE from_revision_id IN (SELECT value FROM json_each(@input))
  ORDER BY from_revision_id,to_revision_id,relation`;

function evidenceSpansSql(sourceIds: string): string {
  return `SELECT revision_id,source_id,span_start,span_end,quote FROM (
    SELECT *, SUM(length(CAST(quote AS BLOB))) OVER (PARTITION BY revision_id,source_id ORDER BY span_start,span_end) AS quote_bytes
    FROM memory_revision_source_spans
    WHERE revision_id IN (SELECT value FROM json_each(@input))
      AND source_id IN (${sourceIds})
      AND (@quoteBytes IS NULL OR length(CAST(quote AS BLOB))<=@quoteBytes)
  ) WHERE @quoteBytes IS NULL OR quote_bytes<=@quoteBytes`;
}

/** Relation neighbors may introduce another entity; all other scopes still apply. */
export function memoryExpansionPlan(plan: RecallPlan): RecallPlan {
  const expansion = {
    ...plan,
    timeScope: { ...plan.timeScope, includeSuperseded: true },
  };
  delete expansion.entityIds;
  delete expansion.entityNames;
  return expansion;
}

export class MemoryRecallRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly memories: MemoryRepository,
  ) {}

  get formation() {
    return this.memories.formation;
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  resolveEntityNames(names: readonly string[]): string[] {
    const ids = new Set<string>();
    const read = this.database.prepare(
      "SELECT entity_id FROM memory_entity_aliases WHERE normalized_alias = ?",
    );
    for (const name of names) {
      for (const row of read.all(
        name.normalize("NFKC").toLowerCase().trim(),
      ) as { entity_id: string }[])
        ids.add(row.entity_id);
    }
    return [...ids];
  }

  entities(
    ids: readonly string[],
  ): { id: string; name: string; kind: string }[] {
    return this.database
      .prepare(
        "SELECT id, canonical_name AS name, kind FROM memory_entities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
      )
      .all(JSON.stringify(ids)) as { id: string; name: string; kind: string }[];
  }

  formationComparisonEntityReadCost(
    revisionIds: readonly string[],
  ): MemoryEvidenceReadCost {
    return measureMemoryEvidenceRows(
      this.database,
      `SELECT DISTINCT e.id,e.canonical_name AS name,e.kind FROM memory_entities e
       JOIN memory_revision_entities re ON re.entity_id=e.id
       WHERE re.revision_id IN (SELECT value FROM json_each(@ids)) ORDER BY e.id`,
      { ids: JSON.stringify(revisionIds) },
    );
  }

  formationRevisionReferences(
    revisionIds: readonly string[],
  ): MemoryEvidenceReference[] {
    return (
      this.database
        .prepare(
          "SELECT memory_id AS memoryId,id AS revisionId FROM memory_revisions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
        )
        .all(JSON.stringify(revisionIds)) as {
        memoryId: string;
        revisionId: string;
      }[]
    ).map((row) => ({ ...row, use: "history" }));
  }

  putEntity(
    entity: {
      id: string;
      name: string;
      kind: string;
      aliases: readonly string[];
    },
    now: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO memory_entities(id,kind,canonical_name,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(entity.id, entity.kind, entity.name, now);
    const add = this.database.prepare(
      "INSERT INTO memory_entity_aliases(entity_id,normalized_alias) VALUES (?,?) ON CONFLICT DO NOTHING",
    );
    for (const name of new Set([entity.name, ...entity.aliases]))
      add.run(entity.id, name.normalize("NFKC").toLowerCase().trim());
  }

  putSemantics(
    revisionId: string,
    semantics: MemoryRevisionSemantics,
    entityIds: readonly string[],
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_revision_semantics (
      revision_id,kind,owner,persona_id,basis,occurred_from,occurred_to,time_precision,
      valid_from,valid_to,subject_entity_id,predicate,object_entity_id,object_value,qualifiers_json,commitment_state
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        revisionId,
        semantics.kind,
        semantics.owner,
        semantics.personaId ?? null,
        semantics.basis,
        semantics.occurredFrom ?? null,
        semantics.occurredTo ?? null,
        semantics.timePrecision ?? null,
        semantics.validFrom ?? null,
        semantics.validTo ?? null,
        semantics.subjectEntityId ?? null,
        semantics.predicate ?? null,
        semantics.objectEntityId ?? null,
        semantics.objectValue ?? null,
        JSON.stringify(semantics.qualifiers),
        semantics.commitmentState ?? null,
      );
    const insert = this.database.prepare(
      "INSERT INTO memory_revision_entities(revision_id,entity_id,role) VALUES (?,?,?) ON CONFLICT DO NOTHING",
    );
    for (const id of new Set(entityIds))
      insert.run(revisionId, id, "mentioned");
    if (semantics.subjectEntityId)
      insert.run(revisionId, semantics.subjectEntityId, "subject");
    if (semantics.objectEntityId)
      insert.run(revisionId, semantics.objectEntityId, "object");
  }

  hasSpan(
    revisionId: string,
    sourceId: string,
    start: number,
    end: number,
    quote: string,
  ): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM memory_revision_source_spans WHERE revision_id=? AND source_id=? AND span_start=? AND span_end=? AND quote=?",
        )
        .get(revisionId, sourceId, start, end, quote),
    );
  }

  addSpan(
    revisionId: string,
    sourceId: string,
    start: number,
    end: number,
    quote: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_revision_source_spans
      (revision_id,source_id,span_start,span_end,quote) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(revisionId, sourceId, start, end, quote);
  }

  link(
    from: string,
    to: string,
    relation: string,
    sourceId: string,
    dependencyUse?: "current" | "history",
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_revision_links
      (from_revision_id,to_revision_id,relation,evidence_source_id,dependency_use) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(from, to, relation, sourceId, dependencyUse ?? null);
  }

  enqueueRevision(revisionId: string, content: string, now: string): void {
    const hash = memoryContentHash(content);
    this.database
      .prepare(
        `INSERT INTO memory_work
      (id,kind,subject_id,source_version,processor_version,status,updated_at)
      VALUES (?,'embed',?,?,'pending-model','pending',?) ON CONFLICT DO NOTHING`,
      )
      .run(`embed-pending:${revisionId}`, revisionId, hash, now);
  }

  async scheduleIndex(
    modelKey: string,
    now: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    // Drive the range by revision ID, not a reordered memories JOIN. Existing
    // non-complete work is already scheduled and must not be implicitly retried.
    const needsIndex = `EXISTS (SELECT 1 FROM memories m WHERE m.id=r.memory_id AND m.deleted_at IS NULL)
      AND (NOT EXISTS (SELECT 1 FROM memory_search_chunks c WHERE c.revision_id=r.id)
        OR EXISTS (SELECT 1 FROM memory_search_chunks c LEFT JOIN memory_chunk_embeddings e ON e.chunk_id=c.id AND e.model_key=@modelKey
          WHERE c.revision_id=r.id AND e.chunk_id IS NULL))`;
    const eligible = `(${needsIndex} AND NOT EXISTS (
        SELECT 1 FROM memory_work w WHERE w.kind='embed' AND w.subject_id=r.id
          AND w.processor_version=@modelKey AND w.status<>'complete'))
      OR EXISTS (SELECT 1 FROM memory_work w WHERE w.kind='embed'
        AND w.subject_id=r.id AND w.processor_version='pending-model')`;
    const first = this.database.prepare(
      `SELECT r.id,CASE WHEN ${needsIndex} THEN r.content END AS content
        FROM memory_revisions r WHERE (${eligible}) ORDER BY r.id LIMIT 1`,
    );
    const next = this.database.prepare(
      `SELECT r.id,CASE WHEN ${needsIndex} THEN r.content END AS content
        FROM memory_revisions r WHERE r.id>@lastId AND (${eligible}) ORDER BY r.id LIMIT 1`,
    );
    const add = this.database.prepare(`INSERT INTO memory_work
      (id,kind,subject_id,source_version,processor_version,status,updated_at)
      VALUES (?,'embed',?,?,?,'pending',?) ON CONFLICT DO UPDATE SET status='pending',updated_at=excluded.updated_at WHERE memory_work.status='complete'`);
    const removePlaceholder = this.database.prepare(
      "DELETE FROM memory_work WHERE kind='embed' AND processor_version='pending-model' AND subject_id=?",
    );
    const schedule = this.database.transaction(
      (revision: { id: string; content: string | null }) => {
        if (revision.content !== null)
          add.run(
            `embed:${memoryContentHash(modelKey + ":" + revision.id)}`,
            revision.id,
            memoryContentHash(revision.content),
            modelKey,
            now,
          );
        removePlaceholder.run(revision.id);
      },
    );
    // Purge can remove a revision before its model is known. Do not remove
    // placeholders for live revisions created while this pass yields.
    this.database
      .prepare(
        `DELETE FROM memory_work AS w WHERE w.kind='embed'
          AND w.processor_version='pending-model'
          AND NOT EXISTS (SELECT 1 FROM memory_revisions r WHERE r.id=w.subject_id)`,
      )
      .run();
    let lastId: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const revision = (
        lastId ? next.get({ modelKey, lastId }) : first.get({ modelKey })
      ) as { id: string; content: string | null } | undefined;
      if (!revision) break;
      lastId = revision.id;
      schedule(revision);
      // No SQLite read or transaction crosses this await. A new revision behind
      // the cursor keeps its own placeholder for the next scheduling pass.
      await setImmediate(undefined, signal ? { signal } : undefined);
    }
  }

  recoverWork(now: string): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status='pending',updated_at=? WHERE kind='embed' AND status='running'",
      )
      .run(now);
  }

  *indexWork(modelKey: string): Iterable<MemoryIndexWork> {
    interface IndexRow extends MemoryIndexWork {
      updated_at: string;
    }
    const eligible = `FROM memory_work w
      JOIN memory_revisions r ON r.id=w.subject_id
      JOIN memories m ON m.id=r.memory_id
      WHERE w.kind='embed' AND w.processor_version=? AND w.status='pending'
        AND m.deleted_at IS NULL`;
    const first = this.database.prepare(
      `SELECT w.id,w.subject_id,w.source_version,w.updated_at,r.content
        ${eligible} ORDER BY w.updated_at,w.id LIMIT 1`,
    );
    const next = this.database.prepare(
      `SELECT w.id,w.subject_id,w.source_version,w.updated_at,r.content
        ${eligible} AND (w.updated_at,w.id)>(?,?)
        ORDER BY w.updated_at,w.id LIMIT 1`,
    );
    let cursor: Pick<IndexRow, "id" | "updated_at"> | undefined;
    for (;;) {
      const row = (
        cursor
          ? next.get(modelKey, cursor.updated_at, cursor.id)
          : first.get(modelKey)
      ) as IndexRow | undefined;
      if (!row) return;
      cursor = { id: row.id, updated_at: row.updated_at };
      yield {
        id: row.id,
        subject_id: row.subject_id,
        source_version: row.source_version,
        content: row.content,
      };
    }
  }

  startWork(id: string, now: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE memory_work SET status='running',attempt=attempt+1,error_code=NULL,updated_at=? WHERE id=? AND kind='embed' AND status='pending'",
        )
        .run(now, id).changes === 1
    );
  }

  suspendWork(id: string, now: string): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status='pending',updated_at=? WHERE id=? AND kind='embed' AND status='running'",
      )
      .run(now, id);
  }

  failWork(id: string, code: string, now: string): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status='failed',error_code=?,updated_at=? WHERE id=? AND kind='embed'",
      )
      .run(code, now, id);
  }

  retryFailedIndex(modelKey: string, now: string): void {
    this.database
      .prepare(
        "UPDATE memory_work SET status='pending',updated_at=? WHERE kind='embed' AND processor_version=? AND status='failed'",
      )
      .run(now, modelKey);
  }

  finishIndex(
    work: MemoryIndexWork,
    chunks: readonly string[],
    vectors: readonly Float32Array[],
    modelKey: string,
    dimensions: number,
    now: string,
  ): boolean {
    return this.transaction(() => {
      const target = this.database
        .prepare(
          `SELECT r.content FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
        WHERE r.id=? AND m.deleted_at IS NULL`,
        )
        .get(work.subject_id) as { content: string } | undefined;
      if (
        !target ||
        memoryContentHash(target.content) !== work.source_version
      ) {
        this.database
          .prepare(
            "UPDATE memory_work SET status='complete',updated_at=? WHERE id=?",
          )
          .run(now, work.id);
        return false;
      }
      if (chunks.length === 0 || chunks.length !== vectors.length)
        throw new Error("Embedding batch does not match memory chunks");
      const addChunk = this.database
        .prepare(`INSERT INTO memory_search_chunks(id,revision_id,ordinal,text,content_hash) VALUES (?,?,?,?,?)
        ON CONFLICT(revision_id,ordinal) DO UPDATE SET text=excluded.text,content_hash=excluded.content_hash`);
      const addVector = this.database
        .prepare(`INSERT INTO memory_chunk_embeddings(chunk_id,model_key,dimensions,vector,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(chunk_id,model_key) DO UPDATE SET vector=excluded.vector,dimensions=excluded.dimensions,created_at=excluded.created_at`);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const vector = vectors[index]!;
        if (
          vector.length !== dimensions ||
          !vector.every(Number.isFinite) ||
          !vector.some((value) => value !== 0)
        )
          throw new Error("Invalid memory embedding");
        const chunkId = `${work.subject_id}:${String(index)}`;
        // A new tokenizer/model can change chunk boundaries. Vectors from the
        // old text must never remain attached to the replacement chunk.
        this.database
          .prepare(
            `DELETE FROM memory_chunk_embeddings WHERE chunk_id=? AND EXISTS
          (SELECT 1 FROM memory_search_chunks WHERE id=? AND content_hash!=?)`,
          )
          .run(chunkId, chunkId, memoryContentHash(chunk));
        addChunk.run(
          chunkId,
          work.subject_id,
          index,
          chunk,
          memoryContentHash(chunk),
        );
        const bytes = Buffer.allocUnsafe(dimensions * 4);
        vector.forEach((value, offset) =>
          bytes.writeFloatLE(value, offset * 4),
        );
        addVector.run(chunkId, modelKey, dimensions, bytes, now);
      }
      this.database
        .prepare(
          "DELETE FROM memory_search_chunks WHERE revision_id=? AND ordinal>=?",
        )
        .run(work.subject_id, chunks.length);
      this.database
        .prepare(
          "UPDATE memory_work SET status='complete',result_json=?,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify({ modelKey, chunks: chunks.length }), now, work.id);
      return true;
    });
  }

  indexIncomplete(modelKey: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
      WHERE m.deleted_at IS NULL AND (NOT EXISTS (SELECT 1 FROM memory_search_chunks c WHERE c.revision_id=r.id)
        OR EXISTS (SELECT 1 FROM memory_search_chunks c LEFT JOIN memory_chunk_embeddings e ON e.chunk_id=c.id AND e.model_key=?
        WHERE c.revision_id=r.id AND e.chunk_id IS NULL)) LIMIT 1`,
        )
        .get(modelKey),
    );
  }

  #where(
    plan: Pick<
      RecallPlan,
      | "purpose"
      | "timeScope"
      | "owner"
      | "personaId"
      | "entityIds"
      | "excludeRevisionIds"
    >,
    now: string,
  ): { text: string; params: Record<string, string | number> } {
    const params: Record<string, string | number> = { derivationNow: now };
    const clauses = [
      "m.deleted_at IS NULL",
      "m.status <> 'archived'",
      LIVE_DERIVATION_SQL,
    ];
    const scope = plan.timeScope;
    if (scope?.knownAt) {
      params["knownAt"] = scope.knownAt;
      clauses.push(
        `r.created_at<=@knownAt`,
        `NOT EXISTS (SELECT 1 FROM memory_revisions newer WHERE newer.memory_id=m.id
        AND newer.created_at<=@knownAt AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.rowid>r.rowid)))`,
      );
    } else if (!scope?.includeSuperseded)
      clauses.push("r.id=m.current_revision_id", "m.status='active'");
    if (
      scope?.validAt ||
      (!scope?.knownAt &&
        !scope?.includeSuperseded &&
        plan.purpose !== "formation")
    ) {
      params["validAt"] = scope?.validAt ?? now;
      clauses.push(
        "(CASE WHEN s.revision_id IS NOT NULL THEN s.valid_from WHEN r.id=m.current_revision_id THEN m.valid_from END IS NULL OR CASE WHEN s.revision_id IS NOT NULL THEN s.valid_from WHEN r.id=m.current_revision_id THEN m.valid_from END<=@validAt)",
        "(CASE WHEN s.revision_id IS NOT NULL THEN s.valid_to WHEN r.id=m.current_revision_id THEN m.valid_to END IS NULL OR CASE WHEN s.revision_id IS NOT NULL THEN s.valid_to WHEN r.id=m.current_revision_id THEN m.valid_to END>@validAt)",
      );
    }
    if (scope?.occurredFrom) {
      params["occurredFrom"] = scope.occurredFrom;
      clauses.push(
        "COALESCE(s.occurred_to,s.occurred_from,r.occurs_at)>=@occurredFrom",
      );
    }
    if (scope?.occurredTo) {
      params["occurredTo"] = scope.occurredTo;
      clauses.push("COALESCE(s.occurred_from,r.occurs_at)<@occurredTo");
    }
    if (plan.owner) {
      params["owner"] = plan.owner;
      clauses.push("s.owner=@owner");
    }
    if (plan.personaId) {
      params["personaId"] = plan.personaId;
      clauses.push(
        "(s.owner IS NULL OR s.owner='user' OR s.persona_id=@personaId)",
      );
    }
    if (plan.entityIds?.length) {
      params["entityIds"] = JSON.stringify(plan.entityIds);
      clauses.push(
        "EXISTS (SELECT 1 FROM memory_revision_entities re WHERE re.revision_id=r.id AND re.entity_id IN (SELECT value FROM json_each(@entityIds)))",
      );
    }
    if (plan.excludeRevisionIds?.length) {
      params["excluded"] = JSON.stringify(plan.excludeRevisionIds);
      clauses.push("r.id NOT IN (SELECT value FROM json_each(@excluded))");
    }
    return { text: clauses.join(" AND "), params };
  }

  eligibleIds(
    ids: readonly string[],
    plan: RecallPlan,
    now: string,
  ): Set<string> {
    const where = this.#where(plan, now);
    return new Set(
      (
        this.database
          .prepare(
            `SELECT r.id FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
      LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id WHERE ${where.text}
      AND r.id IN (SELECT value FROM json_each(@ids))`,
          )
          .all({ ...where.params, ids: JSON.stringify(ids) }) as {
          id: string;
        }[]
      ).map(({ id }) => id),
    );
  }

  revisionScope(
    revisionId: string,
  ): Pick<MemoryRevisionSemantics, "owner" | "personaId"> | undefined {
    const row = this.database
      .prepare(
        "SELECT owner,persona_id FROM memory_revision_semantics WHERE revision_id=?",
      )
      .get(revisionId) as
      | { owner: MemoryRevisionSemantics["owner"]; persona_id: string | null }
      | undefined;
    return row
      ? {
          owner: row.owner,
          ...(row.persona_id ? { personaId: row.persona_id } : {}),
        }
      : undefined;
  }

  unavailableDerivationReasons(ids: readonly string[], now: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT r.id FROM memory_revisions r
      JOIN memories m ON m.id=r.memory_id JOIN memory_revision_semantics s ON s.revision_id=r.id
      WHERE r.id IN (SELECT value FROM json_each(@ids)) AND NOT ${LIVE_DERIVATION_SQL}`,
      )
      .all({ ids: JSON.stringify(ids), derivationNow: now }) as {
      id: string;
    }[];
    return rows.map(({ id }) => `derived_memory_dependency_unavailable:${id}`);
  }

  /** Exact reference validation reads identity and lifecycle metadata only. */
  validateEvidenceReferences(
    request: MemoryEvidenceReferenceRequest,
    now: string,
  ): MemoryEvidenceReference[] {
    if (!request.references.length) return [];
    return this.transaction(() => {
      const ids = [
        ...new Set(request.references.map(({ revisionId }) => revisionId)),
      ];
      const pairs = new Map(
        (
          this.database
            .prepare(
              `${memoryRevisionHistoryCte("SELECT id,memory_id FROM memory_revisions WHERE id IN (SELECT value FROM json_each(@revisionIds))")}
             SELECT r.id,r.memory_id,${memoryRevisionHistoryColumns()} FROM memory_revisions r
             JOIN memories m ON m.id=r.memory_id JOIN revision_history rh ON rh.id=r.id
             WHERE r.id IN (SELECT value FROM json_each(@revisionIds))`,
            )
            .all({
              revisionIds: JSON.stringify(ids),
            }) as (MemoryRevisionHistoryRow & {
            id: string;
            memory_id: string;
          })[]
        ).map((row) => [row.id, row]),
      );
      const plan: RecallPlan = {
        purpose: "recollection",
        personaId: request.personaId,
        query: "",
        questions: [],
        contextBudget: { maxTokens: 1 },
        timeScope: { ...request.retrieval?.timeScope, includeSuperseded: true },
      };
      const scoped = this.eligibleIds(ids, plan, now);
      const currentPlan = { ...plan };
      delete currentPlan.timeScope;
      // A known record was read by identity. Related-search filters did not
      // select it and must not subsequently disqualify it at Agent dispatch.
      const directIds = request.references
        .filter((ref) =>
          request.retrieval?.references?.some(
            (direct) =>
              direct.memoryId === ref.memoryId &&
              direct.revisionId === ref.revisionId,
          ),
        )
        .map(({ revisionId }) => revisionId);
      for (const id of this.eligibleIds(
        directIds,
        {
          ...currentPlan,
          timeScope: { includeSuperseded: true },
        },
        now,
      ))
        scoped.add(id);
      const current = this.eligibleIds(
        request.references
          .filter(({ use }) => use === "current")
          .map(({ revisionId }) => revisionId),
        currentPlan,
        now,
      );
      return request.references.filter(
        ({ memoryId, revisionId, use }) =>
          pairs.get(revisionId)?.memory_id !== memoryId ||
          (request.expectedHistory?.some(
            (expected) =>
              expected.memoryId === memoryId &&
              expected.revisionId === revisionId &&
              (expected.historyStatus !==
                pairs.get(revisionId)?.history_status ||
                (expected.historyStatusRevisionId ?? null) !==
                  pairs.get(revisionId)?.history_status_revision_id),
          ) ??
            false) ||
          (request.usage === "grounding" &&
            ["corrected", "unresolved"].includes(
              pairs.get(revisionId)?.history_status ?? "unresolved",
            )) ||
          !scoped.has(revisionId) ||
          (use === "current" && !current.has(revisionId)),
      );
    });
  }

  /** Existing optional Recall preliminary variable-field estimate. Source/quote
   * projection and fit still follow; this is not the complete evidence read size. */
  statementReadBytes(ids: readonly string[]): ReadonlyMap<string, number> {
    if (!ids.length) return new Map();
    const rows = this.database
      .prepare(
        `${memoryRevisionHistoryCte("SELECT id,memory_id FROM memory_revisions WHERE id IN (SELECT value FROM json_each(@revisionIds))")}
         SELECT r.id,
         length(CAST(r.content AS BLOB))
         + COALESCE(length(CAST(s.qualifiers_json AS BLOB)),0)
         + COALESCE(length(CAST(s.predicate AS BLOB)),0)
         + COALESCE(length(CAST(s.object_value AS BLOB)),0)
         + COALESCE(length(CAST(s.subject_entity_id AS BLOB)),0)
         + COALESCE(length(CAST(s.object_entity_id AS BLOB)),0)
         + COALESCE((SELECT SUM(length(CAST(entity_id AS BLOB)))
             FROM memory_revision_entities WHERE revision_id=r.id),0)
         + COALESCE((SELECT SUM(length(CAST(to_revision_id AS BLOB))+length(CAST(relation AS BLOB)))
             FROM memory_revision_links WHERE from_revision_id=r.id),0)
         + length(CAST(rh.history_status AS BLOB))
         + COALESCE(length(CAST(rh.history_status_revision_id AS BLOB)),0) AS bytes
       FROM memory_revisions r JOIN memories m ON m.id=r.memory_id JOIN revision_history rh ON rh.id=r.id
       LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
       WHERE r.id IN (SELECT value FROM json_each(@revisionIds))`,
      )
      .all({ revisionIds: JSON.stringify([...new Set(ids)]) }) as {
      id: string;
      bytes: number;
    }[];
    return new Map(rows.map(({ id, bytes }) => [id, bytes]));
  }

  /** Full selected projection cost. Call after qualification in the same read
   * transaction as evidence(); no content, source IDs or parent lists are read early. */
  evidenceReadCost(
    ids: readonly string[],
    now: string,
  ): MemoryEvidenceReadCost {
    const unique = [...new Set(ids)];
    if (!unique.length) return { rawValueBytes: 0, rowCount: 0 };
    const input = JSON.stringify(unique);
    const queries: {
      sql: string;
      parameters: Readonly<Record<string, string | number | null>>;
    }[] = [
      { sql: evidenceRevisionSql(), parameters: { input, derivationNow: now } },
      { sql: EVIDENCE_SOURCES_SQL, parameters: { input, sourceLimit: null } },
      { sql: EVIDENCE_SOURCE_COUNTS_SQL, parameters: { input } },
      { sql: EVIDENCE_SEMANTICS_SQL, parameters: { input } },
      { sql: EVIDENCE_ENTITIES_SQL, parameters: { input } },
      {
        sql: evidenceSpansSql(`SELECT s.id FROM memory_revision_sources rs
          JOIN memory_sources s ON s.id=rs.source_id
          WHERE rs.revision_id IN (SELECT value FROM json_each(@input))`),
        parameters: { input, quoteBytes: null },
      },
      { sql: EVIDENCE_LINKS_SQL, parameters: { input } },
    ];
    const costs = queries.map(({ sql, parameters }) =>
      measureMemoryEvidenceRows(this.database, sql, parameters),
    );
    for (const id of unique)
      costs.push(this.memories.learning.derivationReadCost(id, now));
    const total = costs.reduce(
      (sum, cost) => ({
        rawValueBytes: sum.rawValueBytes + cost.rawValueBytes,
        rowCount: sum.rowCount + cost.rowCount,
      }),
      { rawValueBytes: 0, rowCount: 0 },
    );
    if (
      !Number.isSafeInteger(total.rawValueBytes) ||
      !Number.isSafeInteger(total.rowCount)
    )
      throw new RangeError(
        "Memory evidence read cost exceeds safe count precision",
      );
    return total;
  }

  lexical(
    query: string,
    plan: RecallPlan,
    limit: number,
    now: string,
  ): string[] {
    const match = memoryMatchExpression(query);
    if (!match) return [];
    const where = this.#where(plan, now);
    return (
      this.database
        .prepare(
          `SELECT r.id FROM memory_fts JOIN memory_revisions r ON r.id=memory_fts.revision_id
      JOIN memories m ON m.id=r.memory_id LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
      WHERE ${where.text} AND memory_fts MATCH @match ORDER BY bm25(memory_fts),r.id LIMIT @limit`,
        )
        .all({ ...where.params, match, limit }) as { id: string }[]
    ).map(({ id }) => id);
  }

  hasIndexedVectors(plan: RecallPlan, modelKey: string, now: string): boolean {
    const where = this.#where(plan, now);
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM memory_chunk_embeddings e
      JOIN memory_search_chunks c ON c.id=e.chunk_id JOIN memory_revisions r ON r.id=c.revision_id
      JOIN memories m ON m.id=r.memory_id LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
      WHERE ${where.text} AND e.model_key=@modelKey LIMIT 1`,
        )
        .get({ ...where.params, modelKey }),
    );
  }

  *vectors(
    plan: RecallPlan,
    modelKey: string,
    now: string,
  ): Iterable<MemoryVectorRow> {
    const where = this.#where(plan, now);
    const rows = this.database
      .prepare(
        `SELECT c.revision_id AS id,e.vector,e.dimensions FROM memory_chunk_embeddings e
      JOIN memory_search_chunks c ON c.id=e.chunk_id JOIN memory_revisions r ON r.id=c.revision_id
      JOIN memories m ON m.id=r.memory_id LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
      WHERE ${where.text} AND e.model_key=@modelKey ORDER BY c.id`,
      )
      .iterate({ ...where.params, modelKey });
    for (const value of rows) {
      const row = value as { id: string; vector: Buffer; dimensions: number };
      const vector = new Float32Array(row.dimensions);
      for (let index = 0; index < row.dimensions; index += 1)
        vector[index] = row.vector.readFloatLE(index * 4);
      yield { id: row.id, vector };
    }
  }

  structured(
    plan: RecallPlan,
    limit: number,
    now: string,
    candidateEntityIds: readonly string[] = [],
  ): string[] {
    // Knowledge/validity scopes filter eligibility; they do not establish
    // relevance for an additional recency-ordered retrieval channel.
    const scopedMatch = Boolean(
      plan.entityIds?.length ||
      plan.timeScope?.occurredFrom ||
      plan.timeScope?.occurredTo,
    );
    if (!scopedMatch && !candidateEntityIds.length) return [];
    const where = this.#where(plan, now);
    // Preserve explicit entity/event scopes. Otherwise these host hints only
    // seed this lane; lexical/vector searches retain the original plan.
    if (!scopedMatch) {
      where.params["candidateEntityIds"] = JSON.stringify(candidateEntityIds);
      where.text +=
        " AND EXISTS (SELECT 1 FROM memory_revision_entities re WHERE re.revision_id=r.id AND re.entity_id IN (SELECT value FROM json_each(@candidateEntityIds)))";
    }
    return (
      this.database
        .prepare(
          `SELECT r.id FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
      LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id WHERE ${where.text}
      ORDER BY r.created_at DESC,r.id LIMIT @limit`,
        )
        .all({ ...where.params, limit }) as { id: string }[]
    ).map(({ id }) => id);
  }

  currentRevisionsForSources(
    sourceIds: readonly string[],
    scope: Pick<RecallPlan, "owner" | "personaId">,
    limit: number,
    now: string,
  ): string[] {
    if (!sourceIds.length || limit < 1) return [];
    const where = this.#where(
      {
        ...scope,
        purpose: "formation",
      },
      now,
    );
    // A source attached to a superseded revision identifies the same memory's
    // current statement. Replaying its old episode must not resurrect old facts.
    return (
      this.database
        .prepare(
          `SELECT r.id FROM memory_revisions r
           JOIN memories m ON m.id=r.memory_id
           LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
           WHERE ${where.text} AND m.id IN (
             SELECT prior.memory_id FROM memory_revision_sources rs
             JOIN memory_revisions prior ON prior.id=rs.revision_id
             WHERE rs.source_id IN (SELECT value FROM json_each(@sourceIds))
           ) ORDER BY r.created_at DESC,r.id LIMIT @limit`,
        )
        .all({
          ...where.params,
          sourceIds: JSON.stringify(sourceIds),
          limit,
        }) as {
        id: string;
      }[]
    ).map(({ id }) => id);
  }

  /** Complete identity discovery for this segment's actual primary sources.
   * No body is read here. SQL may scan/sort more rows than the returned prefix;
   * maxReadBytes bounds returned values, not query latency or total I/O. */
  formationSourceComparisonReferences(
    sourceIds: readonly string[],
    scope: Pick<RecallPlan, "owner" | "personaId">,
    resourceBudget: { maxReadBytes: number },
    now: string,
  ):
    | {
        status: "resolved";
        references: MemoryEvidenceReference[];
        readCost: MemoryEvidenceReadCost;
      }
    | { status: "resource_limit"; readCost: MemoryEvidenceReadCost } {
    if (
      !Number.isSafeInteger(resourceBudget.maxReadBytes) ||
      resourceBudget.maxReadBytes < 1
    )
      throw new RangeError(
        "Formation comparison raw resource budget must be positive",
      );
    const where = this.#where({ ...scope, purpose: "formation" }, now);
    const references: MemoryEvidenceReference[] = [];
    let rawValueBytes = 0,
      rowCount = 0;
    const rows = this.database
      .prepare(
        `SELECT m.id AS memoryId,r.id AS revisionId
      FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
      LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
      WHERE ${where.text} AND m.id IN (
        SELECT prior.memory_id FROM memory_revision_sources rs
        JOIN memory_revisions prior ON prior.id=rs.revision_id
        WHERE rs.source_id IN (SELECT value FROM json_each(@sourceIds))
      ) ORDER BY r.created_at DESC,r.id`,
      )
      .iterate({ ...where.params, sourceIds: JSON.stringify(sourceIds) });
    for (const value of rows) {
      const row = value as { memoryId: string; revisionId: string };
      rawValueBytes +=
        Buffer.byteLength(row.memoryId) + Buffer.byteLength(row.revisionId);
      rowCount++;
      if (rawValueBytes > resourceBudget.maxReadBytes)
        return {
          status: "resource_limit",
          readCost: { rawValueBytes, rowCount },
        };
      references.push({ ...row, use: "history" });
    }
    return {
      status: "resolved",
      references,
      readCost: { rawValueBytes, rowCount },
    };
  }

  /** Metadata only: do not load all historical bodies during asynchronous CAS. */
  formationCurrentTargets(
    memoryIds: readonly string[],
    scope: Pick<RecallPlan, "owner" | "personaId">,
    now: string,
  ) {
    const where = this.#where(
      {
        ...(scope.personaId ? { personaId: scope.personaId } : {}),
        purpose: "formation",
      },
      now,
    );
    if (scope.owner) {
      where.text += " AND COALESCE(s.owner,'user')=@owner";
      where.params["owner"] = scope.owner;
    }
    return this.database
      .prepare(
        `SELECT m.id AS memoryId,r.id AS revisionId,m.type,
      COALESCE(s.owner,'user') AS owner,s.persona_id AS personaId
      FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
      LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id
      WHERE ${where.text} AND m.id IN (SELECT value FROM json_each(@ids))`,
      )
      .all({ ...where.params, ids: JSON.stringify(memoryIds) }) as {
      memoryId: string;
      revisionId: string;
      type: MemoryEvidenceItem["type"];
      owner: "user" | "character";
      personaId: string | null;
    }[];
  }

  linked(
    ids: readonly string[],
    plan: RecallPlan,
    limit: number,
    now: string,
  ): string[] {
    if (!ids.length) return [];
    const where = this.#where(memoryExpansionPlan(plan), now);
    return (
      this.database
        .prepare(
          `SELECT DISTINCT r.id FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
      LEFT JOIN memory_revision_semantics s ON s.revision_id=r.id WHERE ${where.text} AND r.id NOT IN (SELECT value FROM json_each(@seeds))
      AND (EXISTS (SELECT 1 FROM memory_revision_links l WHERE
        (l.from_revision_id=r.id AND l.to_revision_id IN (SELECT value FROM json_each(@seeds))) OR
        (l.to_revision_id=r.id AND l.from_revision_id IN (SELECT value FROM json_each(@seeds)))) OR
      EXISTS (SELECT 1 FROM memory_revision_sources rs JOIN memory_revision_sources other ON other.source_id=rs.source_id
        WHERE rs.revision_id=r.id AND other.revision_id IN (SELECT value FROM json_each(@seeds))))
      ORDER BY r.id LIMIT @limit`,
        )
        .all({ ...where.params, seeds: JSON.stringify(ids), limit }) as {
        id: string;
      }[]
    ).map(({ id }) => id);
  }

  evidence(
    ids: readonly string[],
    now: string,
    projection?: MemoryEvidenceProjection,
  ): MemoryEvidenceItem[] {
    if (!ids.length) return [];
    const input = JSON.stringify([...new Set(ids)]);
    const rows = this.database
      .prepare(evidenceRevisionSql())
      .all({ input, derivationNow: now }) as (MemoryRevisionHistoryRow & {
      revisionId: string;
      memoryId: string;
      content: string;
      createdAt: string;
      occursAt: string | null;
      currentRevisionId: string;
      status: string;
      type: MemoryEvidenceItem["type"];
      validFrom: string | null;
      validTo: string | null;
    })[];
    const byId = new Map(rows.map((row) => [row.revisionId, row]));
    // Evidence does not consume revision editing reasons or source labels.
    // Do not materialize those potentially large UI-only fields via hitsFor.
    const sourceRows = this.database
      .prepare(EVIDENCE_SOURCES_SQL)
      .all({ input, sourceLimit: projection?.sourceLimit ?? null }) as {
      id: string;
      type: MemoryEvidenceItem["sourceRefs"][number]["type"];
      reference_id: string;
      revision_id: string;
    }[];
    const sourcesByRevision = new Map<
      string,
      {
        id: string;
        referenceId: string;
        type: MemoryEvidenceItem["sourceRefs"][number]["type"];
      }[]
    >();
    for (const source of sourceRows) {
      const sources = sourcesByRevision.get(source.revision_id) ?? [];
      sources.push({
        id: source.id,
        referenceId: source.reference_id,
        type: source.type,
      });
      sourcesByRevision.set(source.revision_id, sources);
    }
    const hits = ids.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [
            {
              memory: {
                id: row.memoryId,
                type: row.type,
                status: row.status,
                currentRevisionId: row.currentRevisionId,
                validFrom: row.validFrom ?? undefined,
                validTo: row.validTo ?? undefined,
              },
              revision: {
                id: row.revisionId,
                ...revisionHistoryValue(row),
                content: row.content,
                createdAt: row.createdAt,
                occursAt: row.occursAt ?? undefined,
              },
              sources: sourcesByRevision.get(id) ?? [],
            },
          ]
        : [];
    });
    const projectedSources = [
      ...new Set(hits.flatMap(({ sources }) => sources.map(({ id }) => id))),
    ];
    const projectedSourceIds = JSON.stringify(projectedSources);
    const quoteBytesPerSource = projection
      ? Math.floor(
          projection.quoteBytes /
            Math.max(
              1,
              hits.reduce((count, hit) => count + hit.sources.length, 0),
            ),
        )
      : null;
    const sourceCounts = new Map(
      (
        this.database.prepare(EVIDENCE_SOURCE_COUNTS_SQL).all({ input }) as {
          revision_id: string;
          count: number;
        }[]
      ).map((row) => [row.revision_id, row.count]),
    );
    const semantics = new Map(
      (
        this.database
          .prepare(EVIDENCE_SEMANTICS_SQL)
          .all({ input }) as SemanticRow[]
      ).map((row) => [row.revision_id, row]),
    );
    const entityRows = this.database
      .prepare(EVIDENCE_ENTITIES_SQL)
      .all({ input }) as { revision_id: string; entity_id: string }[];
    const spans = this.database
      .prepare(evidenceSpansSql("SELECT value FROM json_each(@sourceIds)"))
      .all({
        input,
        sourceIds: projectedSourceIds,
        quoteBytes: quoteBytesPerSource,
      }) as {
      revision_id: string;
      source_id: string;
      span_start: number;
      span_end: number;
      quote: string;
    }[];
    const links = this.database.prepare(EVIDENCE_LINKS_SQL).all({ input }) as {
      from_revision_id: string;
      to_revision_id: string;
      relation: NonNullable<
        MemoryEvidenceItem["relations"]
      >[number]["relation"];
    }[];
    return hits.map(({ memory, revision, sources }) => {
      const semantic = semantics.get(revision.id);
      const semanticValue = semantic
        ? parseSchema(MemoryRevisionSemanticsSchema, {
            kind: semantic.kind,
            owner: semantic.owner,
            basis: semantic.basis,
            qualifiers: JSON.parse(semantic.qualifiers_json) as unknown,
            ...(semantic.persona_id ? { personaId: semantic.persona_id } : {}),
            ...(semantic.occurred_from
              ? { occurredFrom: semantic.occurred_from }
              : {}),
            ...(semantic.occurred_to
              ? { occurredTo: semantic.occurred_to }
              : {}),
            ...(semantic.time_precision
              ? { timePrecision: semantic.time_precision }
              : {}),
            ...(semantic.valid_from ? { validFrom: semantic.valid_from } : {}),
            ...(semantic.valid_to ? { validTo: semantic.valid_to } : {}),
            ...(semantic.subject_entity_id
              ? { subjectEntityId: semantic.subject_entity_id }
              : {}),
            ...(semantic.predicate ? { predicate: semantic.predicate } : {}),
            ...(semantic.object_entity_id
              ? { objectEntityId: semantic.object_entity_id }
              : {}),
            ...(semantic.object_value
              ? { objectValue: semantic.object_value }
              : {}),
            ...(semantic.commitment_state
              ? { commitmentState: semantic.commitment_state }
              : {}),
          })
        : undefined;
      const validFrom = semantic
        ? semantic.valid_from
        : revision.id === memory.currentRevisionId
          ? memory.validFrom
          : undefined;
      const validTo = semantic
        ? semantic.valid_to
        : revision.id === memory.currentRevisionId
          ? memory.validTo
          : undefined;
      const derivation = semanticValue?.qualifiers["consolidationVersion"]
        ? this.memories.learning.derivation(revision.id, now)
        : undefined;
      return {
        memoryId: memory.id,
        revisionId: revision.id,
        type: memory.type,
        content: revision.content,
        ...(semantic ? { basis: semantic.basis, owner: semantic.owner } : {}),
        ...(semantic?.persona_id ? { personaId: semantic.persona_id } : {}),
        entityIds: [
          ...new Set(
            entityRows
              .filter((row) => row.revision_id === revision.id)
              .map((row) => row.entity_id),
          ),
        ],
        ...(semanticValue ? { semantics: semanticValue } : {}),
        sourceCount: sourceCounts.get(revision.id) ?? 0,
        ...(derivation ? { derivation } : {}),
        sourceRefs: sources.map((source) => ({
          sourceId: source.id,
          referenceId: source.referenceId,
          type: source.type,
          spans: spans
            .filter(
              (span) =>
                span.revision_id === revision.id &&
                span.source_id === source.id,
            )
            .map((span) => ({
              start: span.span_start,
              end: span.span_end,
              quote: span.quote,
            })),
        })),
        historyStatus: revision.historyStatus,
        ...(revision.historyStatusRevisionId
          ? { historyStatusRevisionId: revision.historyStatusRevisionId }
          : {}),
        recordedAt: revision.createdAt,
        ...((semantic?.occurred_from ?? revision.occursAt)
          ? { occurredFrom: semantic?.occurred_from ?? revision.occursAt! }
          : {}),
        ...(semantic?.occurred_to ? { occurredTo: semantic.occurred_to } : {}),
        ...(validFrom ? { validFrom } : {}),
        ...(validTo ? { validTo } : {}),
        current:
          revision.id === memory.currentRevisionId &&
          memory.status === "active" &&
          (!validFrom || validFrom <= now) &&
          (!validTo || validTo > now),
        questionIds: [],
        relations: links
          .filter((link) => link.from_revision_id === revision.id)
          .map((link) => ({
            revisionId: link.to_revision_id,
            relation: link.relation,
          })),
      };
    });
  }
}
