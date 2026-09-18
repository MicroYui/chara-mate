import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";

import type { MemorySource } from "../../shared/contracts/memory";
import type {
  MemoryCanonicalSourceCandidate,
  MemoryCanonicalStorageStats,
  MemoryFormationEpisode,
  MemoryFormationIntake,
  MemoryFormationSource,
  MemoryFormationWorkRef,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import {
  MemoryFormationEpisodeSchema,
  MemoryFormationSourceSchema,
  MemoryFormationSourceUseSchema,
} from "../../shared/schemas/memoryRecall";
import { parseSchema } from "../../shared/schemas/validation";
import { redactText } from "../../shared/pure/redaction";

// Measured on the pinned SQLite/better-sqlite3 stack. This is a local storage
// tradeoff, not a model or protocol limit; no full source body is duplicated.
const SOURCE_CHUNK_UNITS = 32768;

export interface FormationSourceMetadata extends Omit<
  MemoryFormationSource,
  "content"
> {
  ordinal: number;
  primary: boolean;
  length: number;
  jsonBytes: number;
}
interface SourceRow {
  id: string;
  type: MemoryFormationSource["type"];
  reference_id: string;
  label: string | null;
  created_at: string;
  raw_speaker: MemoryFormationSource["speaker"] | null;
  raw_length: number | null;
  raw_json_bytes: number | null;
  raw_digest: string | null;
  raw_present: number;
}
interface WorkRow {
  id: string;
  subject_id: string;
  source_version: string;
  processor_version: string;
  attempt: number;
  error_code: string | null;
  status: MemoryFormationWorkRef["status"];
  payload_json: string;
  result_json: string | null;
  updated_at: string;
}
export interface FormationExecution {
  readonly workId: string;
  readonly processorVersion: string;
  readonly attempt: number;
}
export interface FormationWork extends MemoryFormationWorkRef {
  attempt: number;
  errorCode?: string;
  episode: MemoryFormationEpisode;
  result: unknown;
}
const workRef = (row: WorkRow): MemoryFormationWorkRef => ({
  workId: row.id,
  episodeId: row.subject_id,
  sourceVersion: row.source_version,
  processorVersion: row.processor_version,
  status: row.status,
});
const uncovered = `(work.status <> 'failed' OR NOT EXISTS (
  SELECT 1 FROM memory_work_sources first_source
  CROSS JOIN memory_work completed ON completed.id=first_source.work_id
  WHERE first_source.source_id=(SELECT source_id FROM memory_work_sources
      WHERE work_id=work.id ORDER BY ordinal LIMIT 1)
    AND completed.kind='form' AND completed.status='complete'
    AND json_extract(completed.payload_json,'$.personaId') IS json_extract(work.payload_json,'$.personaId')
    AND json_extract(completed.payload_json,'$.situationId') IS json_extract(work.payload_json,'$.situationId')
    AND NOT EXISTS (SELECT 1 FROM memory_work_sources prior_source
      WHERE prior_source.work_id=work.id AND NOT EXISTS (
        SELECT 1 FROM memory_work_sources completed_source
        WHERE completed_source.work_id=completed.id
          AND completed_source.source_id=prior_source.source_id
          AND completed_source.is_primary=prior_source.is_primary))
))`;

function jsonContentBytes(text: string): number {
  let sum = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + SOURCE_CHUNK_UNITS);
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(text[end]!)
    )
      end -= 1;
    sum +=
      Buffer.byteLength(JSON.stringify(text.slice(start, end)), "utf8") - 2;
    start = end;
  }
  return sum;
}

/** Owns the durable formation lifecycle and canonical originals. All writes
 * use the same application connection, so Main can atomically intake and ack
 * its source outbox. No statement remains open across a yielded source/window. */
export class MemoryFormationRepository {
  constructor(private readonly database: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  registerSource(input: MemoryFormationSource): void {
    const source = parseSchema(MemoryFormationSourceSchema, {
      ...input,
      content: redactText(input.content),
    });
    const hash = createHash("sha256");
    for (
      let start = 0;
      start < source.content.length;
      start += SOURCE_CHUNK_UNITS
    )
      hash.update(
        Buffer.from(
          source.content.slice(start, start + SOURCE_CHUNK_UNITS),
          "utf16le",
        ),
      );
    const digest = hash.digest("hex");
    this.transaction(() => {
      const stored = this.#source(source.id);
      if (
        stored &&
        (stored.type !== source.type ||
          stored.reference_id !== source.referenceId ||
          stored.created_at !== source.occurredAt)
      )
        throw new Error(
          "Canonical source ID was reused with different metadata",
        );
      if (
        stored?.raw_speaker !== null &&
        stored?.raw_speaker !== undefined &&
        (stored.raw_speaker !== source.speaker ||
          stored.raw_length !== source.content.length ||
          (stored.raw_digest !== null && stored.raw_digest !== digest))
      )
        throw new Error(
          "Canonical source ID was reused with different content",
        );
      if (stored?.raw_present === 1) return;
      this.database
        .prepare(
          `INSERT INTO memory_sources(id,type,reference_id,created_at)
          VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(source.id, source.type, source.referenceId, source.occurredAt);
      // An unavailable source becomes readable only with all canonical chunks
      // and its verified identity in this same transaction.
      this.database
        .prepare("DELETE FROM memory_source_text_chunks WHERE source_id=?")
        .run(source.id);
      const insert = this.database.prepare(
        `INSERT INTO memory_source_text_chunks(source_id,start_utf16,content) VALUES(?,?,?)`,
      );
      for (
        let start = 0;
        start < source.content.length;
        start += SOURCE_CHUNK_UNITS
      )
        insert.run(
          source.id,
          start,
          Buffer.from(
            source.content.slice(start, start + SOURCE_CHUNK_UNITS),
            "utf16le",
          ),
        );
      this.database
        .prepare(
          `UPDATE memory_sources SET raw_speaker=?,raw_length=?,raw_json_bytes=?,raw_digest=?,raw_present=1 WHERE id=?`,
        )
        .run(
          source.speaker,
          source.content.length,
          jsonContentBytes(source.content),
          digest,
          source.id,
        );
    });
  }

  enqueue(
    input: MemoryFormationIntake,
    processor: string,
    now: string,
  ): MemoryFormationWorkRef {
    const episode = parseSchema(MemoryFormationEpisodeSchema, input.episode);
    const payload = JSON.stringify(episode);
    const id = `form:${createHash("sha256")
      .update(episode.id + ":" + episode.version)
      .digest("hex")}`;
    return this.transaction(() => {
      const prior = this.#work(id);
      if (
        prior &&
        !isDeepStrictEqual(JSON.parse(prior.payload_json), JSON.parse(payload))
      )
        throw new Error(
          "Formation episode version was reused for different metadata",
        );
      if (!prior)
        this.database
          .prepare(
            `INSERT INTO memory_work
        (id,kind,subject_id,source_version,processor_version,status,payload_json,updated_at)
        VALUES(?,'form',?,?,?,'pending',?,?)`,
          )
          .run(id, episode.id, episode.version, processor, payload, now);
      const insert = this.database.prepare(`INSERT INTO memory_work_sources
        (work_id,ordinal,source_id,is_primary,occurred_at) VALUES(?,?,?,?,?)`);
      const read = this.database.prepare(
        `SELECT source_id,is_primary FROM memory_work_sources WHERE work_id=? AND ordinal=?`,
      );
      let ordinal = 0;
      let primaryCount = 0;
      for (const raw of input.sources()) {
        const use = parseSchema(MemoryFormationSourceUseSchema, raw);
        if (prior) {
          const existing = read.get(id, ordinal) as
            { source_id: string; is_primary: number } | undefined;
          if (
            !existing ||
            existing.source_id !== use.sourceId ||
            existing.is_primary !== Number(use.primary)
          )
            throw new Error(
              "Formation episode version was reused for different source uses",
            );
        }
        if (prior?.status !== "complete") {
          let stored = this.#source(use.sourceId);
          if (stored?.raw_present !== 1) {
            const source = input.resolveSource(use.sourceId);
            if (!source || source.id !== use.sourceId)
              throw new Error(
                "Canonical formation source is unavailable or has a different ID",
              );
            this.registerSource(source);
            stored = this.#source(use.sourceId)!;
          }
          if (!prior)
            insert.run(
              id,
              ordinal,
              use.sourceId,
              Number(use.primary),
              stored.created_at,
            );
        }
        ordinal += 1;
        primaryCount += Number(use.primary);
      }
      if (primaryCount === 0)
        throw new Error(
          "Formation intake requires at least one canonical primary source",
        );
      if (prior && read.get(id, ordinal))
        throw new Error(
          "Formation episode version was reused for different source uses",
        );
      if (!prior)
        this.#replaceUnattemptedSubsets(id, episode, processor, ordinal);
      return workRef(this.#work(id)!);
    });
  }

  /** Current consumers start an explicit request before yielding; background
   * intake does not retain a work handle. Only unattempted queued input can be
   * replaced, never redirected to a different input's completed receipt. */
  #replaceUnattemptedSubsets(
    id: string,
    episode: MemoryFormationEpisode,
    processor: string,
    sourceCount: number,
  ): void {
    // Every valid work has a primary source; a singleton cannot strictly cover it.
    if (sourceCount === 1) return;
    this.database
      .prepare(
        `DELETE FROM memory_work WHERE id IN (
          SELECT prior.id FROM memory_work prior
          WHERE prior.kind='form' AND prior.status='pending'
            AND prior.attempt=0 AND prior.result_json IS NULL AND prior.id<>@id
            AND prior.processor_version=@processor
            AND json_extract(prior.payload_json,'$.personaId') IS @persona
            AND json_extract(prior.payload_json,'$.situationId') IS @situation
            AND EXISTS (SELECT 1 FROM memory_work_sources incoming
              WHERE incoming.work_id=@id AND incoming.is_primary=1
                AND incoming.source_id=(SELECT source_id FROM memory_work_sources
                  WHERE work_id=prior.id AND is_primary=1 ORDER BY ordinal LIMIT 1))
            AND (SELECT COUNT(*) FROM memory_work_sources WHERE work_id=prior.id)<@sourceCount
            AND NOT EXISTS (
              SELECT 1 FROM memory_work_sources previous
              LEFT JOIN memory_work_sources incoming
                ON incoming.work_id=@id AND incoming.source_id=previous.source_id
              LEFT JOIN memory_work_sources predecessor
                ON predecessor.work_id=previous.work_id AND predecessor.ordinal=previous.ordinal-1
              LEFT JOIN memory_work_sources incoming_predecessor
                ON incoming_predecessor.work_id=@id AND incoming_predecessor.source_id=predecessor.source_id
              WHERE previous.work_id=prior.id AND (
                incoming.source_id IS NULL OR incoming.is_primary<>previous.is_primary
                OR incoming_predecessor.ordinal>=incoming.ordinal))
        )`,
      )
      .run({
        id,
        processor,
        persona: episode.personaId ?? null,
        situation: episode.situationId ?? null,
        sourceCount,
      });
  }

  work(id: string): FormationWork {
    const row = this.#work(id);
    if (!row) throw new Error("Memory formation work does not exist");
    return {
      ...workRef(row),
      attempt: row.attempt,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      episode: parseSchema(
        MemoryFormationEpisodeSchema,
        JSON.parse(row.payload_json),
      ),
      result: row.result_json
        ? (JSON.parse(row.result_json) as unknown)
        : undefined,
    };
  }

  *pendingWork(): Iterable<MemoryFormationWorkRef> {
    const first = this.database.prepare(
      `SELECT id,subject_id,source_version,processor_version,status,updated_at FROM memory_work WHERE kind='form' AND status='pending' ORDER BY updated_at,id LIMIT 1`,
    );
    const next = this.database.prepare(
      `SELECT id,subject_id,source_version,processor_version,status,updated_at FROM memory_work WHERE kind='form' AND status='pending' AND (updated_at,id)>(?,?) ORDER BY updated_at,id LIMIT 1`,
    );
    let cursor: { updated_at: string; id: string } | undefined;
    for (;;) {
      const row = (
        cursor ? next.get(cursor.updated_at, cursor.id) : first.get()
      ) as WorkRow | undefined;
      if (!row) return;
      cursor = { updated_at: row.updated_at, id: row.id };
      yield workRef(row);
    }
  }

  sourceCounts(workId: string): { primary: number; context: number } {
    return this.database
      .prepare(
        `SELECT COALESCE(SUM(is_primary),0) AS "primary",
      COALESCE(SUM(1-is_primary),0) AS context FROM memory_work_sources WHERE work_id=?`,
      )
      .get(workId) as { primary: number; context: number };
  }

  *primarySources(
    workId: string,
    fromOrdinal = 0,
  ): Iterable<FormationSourceMetadata> {
    let ordinal = fromOrdinal - 1;
    const read = this.database
      .prepare(`SELECT s.*,u.ordinal,u.is_primary FROM memory_work_sources u
      JOIN memory_sources s ON s.id=u.source_id WHERE u.work_id=? AND u.ordinal>? AND u.is_primary=1 ORDER BY u.ordinal LIMIT 1`);
    for (;;) {
      const row = read.get(workId, ordinal) as
        (SourceRow & { ordinal: number; is_primary: number }) | undefined;
      if (!row) return;
      ordinal = row.ordinal;
      yield this.#metadata(row);
    }
  }

  *contextSources(
    workId: string,
    through: string,
  ): Iterable<FormationSourceMetadata> {
    let cursor: { occurredAt: string; id: string } | undefined;
    const base = `SELECT s.*,u.ordinal,u.is_primary FROM memory_work_sources u JOIN memory_sources s ON s.id=u.source_id
      WHERE u.work_id=? AND u.is_primary=0 AND u.occurred_at<=?`;
    const first = this.database.prepare(
      `${base} ORDER BY u.occurred_at DESC,u.source_id LIMIT 1`,
    );
    const sameTime = this.database
      .prepare(`SELECT s.*,u.ordinal,u.is_primary FROM memory_work_sources u
      JOIN memory_sources s ON s.id=u.source_id WHERE u.work_id=? AND u.is_primary=0
      AND u.occurred_at=? AND u.source_id>? ORDER BY u.source_id LIMIT 1`);
    const earlier = this.database
      .prepare(`SELECT s.*,u.ordinal,u.is_primary FROM memory_work_sources u
      JOIN memory_sources s ON s.id=u.source_id WHERE u.work_id=? AND u.is_primary=0
      AND u.occurred_at<? ORDER BY u.occurred_at DESC,u.source_id LIMIT 1`);
    for (;;) {
      const row = (
        cursor
          ? (sameTime.get(workId, cursor.occurredAt, cursor.id) ??
            earlier.get(workId, cursor.occurredAt))
          : first.get(workId, through)
      ) as (SourceRow & { ordinal: number; is_primary: number }) | undefined;
      if (!row) return;
      const meta = this.#metadata(row);
      cursor = meta;
      yield meta;
    }
  }

  sourceWindow(
    workId: string,
    sourceId: string,
    start: number,
    end: number,
  ): string {
    const row = this.database
      .prepare(
        `SELECT s.raw_length,s.raw_present FROM memory_work_sources u
      JOIN memory_sources s ON s.id=u.source_id WHERE u.work_id=? AND u.source_id=?`,
      )
      .get(workId, sourceId) as
      { raw_length: number | null; raw_present: number } | undefined;
    if (
      !row?.raw_length ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > row.raw_length
    )
      throw new RangeError(
        "Formation source window is outside its canonical source use",
      );
    if (row.raw_present !== 1)
      throw new Error("Canonical formation source text is unavailable");
    return this.#readWindow(sourceId, start, end);
  }

  getSourceMetadata(
    id: string,
  ): Omit<MemoryFormationSource, "content"> | undefined {
    const row = this.#source(id);
    if (!row || row.raw_digest === null) return undefined;
    return this.#identity(row);
  }

  sourceProvenance(id: string): MemorySource {
    const source = this.#source(id);
    if (!source) throw new Error("Canonical source is unavailable");
    return {
      id,
      type: source.type,
      referenceId: source.reference_id,
      createdAt: source.created_at,
      ...(source.label === null ? {} : { label: source.label }),
    };
  }

  getFormationSource(
    type: MemoryFormationSource["type"],
    referenceId: string,
  ): MemoryFormationSource | undefined {
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_sources WHERE type=? AND reference_id=? AND raw_digest IS NOT NULL ORDER BY id LIMIT 2`,
      )
      .all(type, referenceId) as SourceRow[];
    if (rows.length !== 1) return undefined;
    const row = rows[0]!;
    if (row.raw_present !== 1) return undefined;
    const identity = this.#identity(row);
    if (!identity) return undefined;
    return {
      ...identity,
      content: this.#readWindow(row.id, 0, row.raw_length!),
    };
  }

  snapshottedActivitySourceIds(
    eventIds: readonly string[],
  ): ReadonlySet<string> {
    if (!eventIds.length) return new Set();
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_sources
      WHERE type='activity_event' AND reference_id IN (SELECT value FROM json_each(?)) AND raw_digest IS NOT NULL
      GROUP BY reference_id HAVING COUNT(*)=1 AND MIN(raw_present)=1`,
      )
      .all(JSON.stringify(eventIds)) as SourceRow[];
    return new Set(
      rows.filter((row) => this.#identity(row)).map((row) => row.reference_id),
    );
  }

  nextReclaimableSource(
    afterSourceId?: string,
  ): MemoryCanonicalSourceCandidate | undefined {
    const row = this.database
      .prepare(
        `SELECT source.* FROM memory_sources source
      WHERE source.raw_present=1 ${afterSourceId === undefined ? "" : "AND source.id>@afterId"}
        AND NOT EXISTS (SELECT 1 FROM memory_work_sources lookup
          CROSS JOIN memory_work work ON work.id=lookup.work_id
          WHERE lookup.source_id=source.id AND work.kind='form'
            AND work.status IN ('pending','running','failed') AND ${uncovered})
      ORDER BY source.id LIMIT 1`,
      )
      .get(afterSourceId === undefined ? {} : { afterId: afterSourceId }) as
      SourceRow | undefined;
    if (!row) return undefined;
    const identity = this.#identity(row);
    if (!identity || row.raw_length === null || row.raw_json_bytes === null)
      throw new Error("A complete canonical source has no valid identity");
    return {
      ...identity,
      length: row.raw_length,
      jsonBytes: row.raw_json_bytes,
    };
  }

  releaseCanonicalSource(sourceId: string): boolean {
    return this.transaction(() => {
      const eligible = this.database
        .prepare(
          `SELECT 1 FROM memory_sources source
        WHERE source.id=? AND source.raw_present=1
          AND NOT EXISTS (SELECT 1 FROM memory_work_sources lookup
            CROSS JOIN memory_work work ON work.id=lookup.work_id
            WHERE lookup.source_id=source.id AND work.kind='form'
              AND work.status IN ('pending','running','failed') AND ${uncovered})`,
        )
        .get(sourceId);
      if (!eligible) return false;
      this.database
        .prepare("DELETE FROM memory_source_text_chunks WHERE source_id=?")
        .run(sourceId);
      this.database
        .prepare("UPDATE memory_sources SET raw_present=0 WHERE id=?")
        .run(sourceId);
      return true;
    });
  }

  canonicalStorageStats(): MemoryCanonicalStorageStats {
    const states = this.database
      .prepare(
        `SELECT
      COALESCE(SUM(raw_present=1),0) presentSources,
      COALESCE(SUM(raw_digest IS NOT NULL AND raw_present=0),0) releasedSources
      FROM memory_sources`,
      )
      .get() as Pick<
      MemoryCanonicalStorageStats,
      "presentSources" | "releasedSources"
    >;
    const raw = this.database
      .prepare(
        "SELECT COALESCE(SUM(length(content)),0) bytes FROM memory_source_text_chunks",
      )
      .get() as { bytes: number };
    const quotes = this.database
      .prepare(
        "SELECT COALESCE(SUM(length(CAST(quote AS BLOB))),0) bytes FROM memory_revision_source_spans",
      )
      .get() as { bytes: number };
    return {
      ...states,
      rawUtf16Bytes: raw.bytes,
      quoteUtf8Bytes: quotes.bytes,
    };
  }

  protectedActivitySourceIds(eventIds: readonly string[]): ReadonlySet<string> {
    if (!eventIds.length) return new Set();
    const rows = this.database
      .prepare(
        `SELECT DISTINCT source.reference_id AS id FROM memory_sources source
      CROSS JOIN memory_work_sources lookup ON lookup.source_id=source.id
      CROSS JOIN memory_work work ON work.id=lookup.work_id
      WHERE source.type='activity_event' AND source.reference_id IN (SELECT value FROM json_each(?))
      AND work.kind='form' AND work.status IN ('pending','running','failed') AND ${uncovered}`,
      )
      .all(JSON.stringify(eventIds)) as { id: string }[];
    return new Set(rows.map(({ id }) => id));
  }

  incomplete(
    scope: Pick<RecallPlan, "owner" | "personaId">,
    excluding?: Pick<MemoryFormationEpisode, "id" | "version">,
  ): boolean {
    if (scope.owner === "character" && !scope.personaId) return false;
    const clauses = [
      "work.kind='form'",
      "work.status IN ('pending','running','failed')",
      uncovered,
    ];
    const params: Record<string, string> = {};
    if (scope.owner === "character") {
      clauses.push("json_extract(work.payload_json,'$.personaId')=@personaId");
      params["personaId"] = scope.personaId!;
    }
    if (excluding) {
      clauses.push(
        "NOT (work.subject_id=@episodeId AND work.source_version=@sourceVersion)",
      );
      params["episodeId"] = excluding.id;
      params["sourceVersion"] = excluding.version;
    }
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM memory_work work WHERE ${clauses.join(" AND ")} LIMIT 1`,
        )
        .get(params),
    );
  }

  /** Observed connections to these actually supplied sources only. A source
   * used as context connects an unfinished episode; it does not make that
   * unseen episode's contents supplied or prove its topic is related. */
  connectedIncompleteSources(
    scope: Pick<RecallPlan, "owner" | "personaId">,
    sourceIds: readonly string[],
  ): {
    sourceId: string;
    role: "primary" | "context";
    status: "pending" | "running" | "failed";
    workCount: number;
  }[] {
    if (!sourceIds.length || (scope.owner === "character" && !scope.personaId))
      return [];
    return this.database
      .prepare(
        `
      SELECT uses.source_id AS sourceId,
        CASE WHEN uses.is_primary=1 THEN 'primary' ELSE 'context' END AS role,
        work.status AS status,COUNT(DISTINCT work.id) AS workCount
      FROM memory_work_sources uses JOIN memory_work work ON work.id=uses.work_id
      WHERE uses.source_id IN (SELECT value FROM json_each(@sourceIds))
        AND work.kind='form' AND work.status IN ('pending','running','failed')
        AND (@owner<>'character' OR json_extract(work.payload_json,'$.personaId')=@personaId)
        AND ${uncovered}
      GROUP BY uses.source_id,uses.is_primary,work.status
      ORDER BY uses.source_id,uses.is_primary DESC,work.status
    `,
      )
      .all({
        sourceIds: JSON.stringify([...new Set(sourceIds)]),
        owner: scope.owner,
        personaId: scope.personaId ?? null,
      }) as {
      sourceId: string;
      role: "primary" | "context";
      status: "pending" | "running" | "failed";
      workCount: number;
    }[];
  }

  startWork(
    id: string,
    processorVersion: string,
    progress: unknown,
    now: string,
  ): FormationExecution | undefined {
    const row = this.database
      .prepare(
        `UPDATE memory_work
      SET status='running',processor_version=?,attempt=attempt+1,error_code=NULL,result_json=?,updated_at=?
      WHERE id=? AND kind='form' AND status='pending' RETURNING attempt`,
      )
      .get(
        processorVersion,
        progress === undefined ? null : JSON.stringify(progress),
        now,
        id,
      ) as { attempt: number } | undefined;
    return row
      ? { workId: id, processorVersion, attempt: row.attempt }
      : undefined;
  }
  assertRunning(execution: FormationExecution): void {
    if (
      !this.database
        .prepare(
          `SELECT 1 FROM memory_work WHERE id=@workId AND kind='form'
      AND status='running' AND processor_version=@processorVersion AND attempt=@attempt`,
        )
        .get(execution)
    )
      throw new Error("Memory formation execution no longer owns this work");
  }
  saveProgress(
    execution: FormationExecution,
    progress: unknown,
    now: string,
  ): void {
    const changed = this.database
      .prepare(
        `UPDATE memory_work SET result_json=@result,updated_at=@now
      WHERE id=@workId AND kind='form' AND status='running' AND processor_version=@processorVersion AND attempt=@attempt`,
      )
      .run({ ...execution, result: JSON.stringify(progress), now }).changes;
    if (changed !== 1)
      throw new Error("Memory formation execution no longer owns this work");
  }
  finish(execution: FormationExecution, result: unknown, now: string): void {
    const changed = this.database
      .prepare(
        `UPDATE memory_work SET status='complete',result_json=@result,updated_at=@now
      WHERE id=@workId AND kind='form' AND status='running' AND processor_version=@processorVersion AND attempt=@attempt`,
      )
      .run({ ...execution, result: JSON.stringify(result), now }).changes;
    if (changed !== 1)
      throw new Error("Memory formation execution no longer owns this work");
  }
  fail(execution: FormationExecution, code: string, now: string): void {
    this.database
      .prepare(
        `UPDATE memory_work SET status='failed',error_code=@code,updated_at=@now
      WHERE id=@workId AND kind='form' AND status='running' AND processor_version=@processorVersion AND attempt=@attempt`,
      )
      .run({ ...execution, code, now });
  }
  failPending(id: string, code: string, now: string): void {
    this.database
      .prepare(
        `UPDATE memory_work SET status='failed',error_code=?,updated_at=?
      WHERE id=? AND kind='form' AND status='pending'`,
      )
      .run(code, now, id);
  }
  suspend(execution: FormationExecution, now: string): void {
    this.database
      .prepare(
        `UPDATE memory_work SET status='pending',updated_at=@now
      WHERE id=@workId AND kind='form' AND status='running' AND processor_version=@processorVersion AND attempt=@attempt`,
      )
      .run({ ...execution, now });
  }
  recover(now: string): void {
    this.database
      .prepare(
        `UPDATE memory_work SET status='pending',updated_at=? WHERE kind='form' AND status='running'`,
      )
      .run(now);
  }
  retryFailed(now: string, workId?: string): void {
    this.database
      .prepare(
        `UPDATE memory_work AS work SET status='pending',updated_at=@now WHERE kind='form' AND status='failed'
      AND (@workId IS NULL OR id=@workId) AND ${uncovered}`,
      )
      .run({ now, workId: workId ?? null });
  }
  retryFailedForProcessor(processorVersion: string, now: string): void {
    this.database
      .prepare(
        `UPDATE memory_work AS work SET status='pending',updated_at=?
      WHERE kind='form' AND status='failed' AND processor_version<>? AND ${uncovered}`,
      )
      .run(now, processorVersion);
  }
  retryFailedForProvider(processorVersion: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE memory_work AS work SET status='pending',updated_at=@now
      WHERE kind='form' AND status='failed' AND processor_version=@processorVersion
      AND error_code IN ('PROVIDER.TIMEOUT','PROVIDER.UNREACHABLE','PROVIDER.RATE_LIMITED','PROVIDER.UNAVAILABLE')
      AND ${uncovered}`,
      )
      .run({ processorVersion, now }).changes;
  }
  #work(id: string): WorkRow | undefined {
    return this.database
      .prepare("SELECT * FROM memory_work WHERE id=? AND kind='form'")
      .get(id) as WorkRow | undefined;
  }
  #source(id: string): SourceRow | undefined {
    return this.database
      .prepare("SELECT * FROM memory_sources WHERE id=?")
      .get(id) as SourceRow | undefined;
  }
  #identity(
    row: SourceRow,
  ): Omit<MemoryFormationSource, "content"> | undefined {
    if (row.raw_speaker === null) return undefined;
    try {
      const source = parseSchema(MemoryFormationSourceSchema, {
        id: row.id,
        type: row.type,
        referenceId: row.reference_id,
        speaker: row.raw_speaker,
        occurredAt: row.created_at,
        content: "canonical",
      });
      return {
        id: source.id,
        type: source.type,
        referenceId: source.referenceId,
        speaker: source.speaker,
        occurredAt: source.occurredAt,
      };
    } catch {
      return undefined;
    }
  }
  #metadata(
    row: SourceRow & { ordinal: number; is_primary: number },
  ): FormationSourceMetadata {
    if (
      row.raw_speaker === null ||
      row.raw_length === null ||
      row.raw_json_bytes === null
    )
      throw new Error("Formation source has no canonical original");
    return {
      id: row.id,
      referenceId: row.reference_id,
      type: row.type,
      speaker: row.raw_speaker,
      occurredAt: row.created_at,
      ordinal: row.ordinal,
      primary: Boolean(row.is_primary),
      length: row.raw_length,
      jsonBytes: row.raw_json_bytes,
    };
  }
  #readWindow(sourceId: string, start: number, end: number): string {
    const read = this.database.prepare(
      `SELECT start_utf16,content FROM memory_source_text_chunks WHERE source_id=? AND start_utf16<=? ORDER BY start_utf16 DESC LIMIT 1`,
    );
    const pieces: Buffer[] = [];
    let position = start;
    while (position < end) {
      const row = read.get(sourceId, position) as
        { start_utf16: number; content: Buffer } | undefined;
      if (!row || row.start_utf16 + row.content.length / 2 <= position)
        throw new Error("Canonical source text has an incomplete window");
      const through = Math.min(end, row.start_utf16 + row.content.length / 2);
      pieces.push(
        row.content.subarray(
          (position - row.start_utf16) * 2,
          (through - row.start_utf16) * 2,
        ),
      );
      position = through;
    }
    return Buffer.concat(pieces).toString("utf16le");
  }
}
