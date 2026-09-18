import type Database from "better-sqlite3";

import type {
  MemoryHit,
  MemoryListRequest,
  MemoryRecord,
  MemoryStatus,
} from "../../shared/contracts/memory";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { Clock } from "../../shared/pure/clock";
import type { MemoryRepository } from "./memoryRepository";
import { memoryMatchExpression } from "./memorySearchText";
import type { RetrievalPipeline } from "./retrievalPipeline";

interface RetrievalRow {
  last_accessed_at: Timestamp | null;
  memory_id: string;
  revision_id: string;
  status_at: MemoryStatus;
  updated_at: Timestamp;
}

function projectHistoricalMemory(
  memory: MemoryRecord,
  revisionId: string,
  status: MemoryStatus,
  asOf: Timestamp,
  updatedAt: Timestamp,
  lastAccessedAt: Timestamp | null,
): MemoryRecord {
  return {
    ...(memory.claimSlot ? { claimSlot: memory.claimSlot } : {}),
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    currentRevisionId: revisionId,
    ...(memory.deletedAt && memory.deletedAt <= asOf
      ? { deletedAt: memory.deletedAt }
      : {}),
    id: memory.id,
    importance: memory.importance,
    ...(lastAccessedAt ? { lastAccessedAt } : {}),
    ...(memory.pinnedAt && memory.pinnedAt <= asOf
      ? { pinnedAt: memory.pinnedAt }
      : {}),
    status,
    ...(status === "superseded" && memory.supersededById
      ? { supersededById: memory.supersededById }
      : {}),
    type: memory.type,
    updatedAt,
    ...(memory.validFrom ? { validFrom: memory.validFrom } : {}),
    ...(memory.validTo ? { validTo: memory.validTo } : {}),
  };
}

export class LexicalRetrievalPipeline implements RetrievalPipeline {
  constructor(
    private readonly database: Database.Database,
    private readonly repository: MemoryRepository,
    private readonly clock: Clock,
  ) {}

  search(request: MemoryListRequest, limit?: number): MemoryHit[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new RangeError("Memory retrieval limit must be a positive integer");
    }
    const asOf = request.asOf;
    const at = asOf ?? this.clock.now();
    const match = request.query
      ? memoryMatchExpression(request.query)
      : undefined;
    const historical = asOf !== undefined;
    const revisionExpression = historical
      ? `(SELECT r.id
          FROM memory_revisions r
          WHERE r.memory_id = m.id AND r.created_at <= @at
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1)`
      : "m.current_revision_id";
    const statusExpression = historical
      ? `CASE
           WHEN m.status IN ('superseded', 'archived') AND m.updated_at > @at
             THEN 'active'
           ELSE m.status
         END`
      : "m.status";
    const pinnedExpression = historical
      ? "CASE WHEN m.pinned_at <= @at THEN m.pinned_at ELSE NULL END"
      : "m.pinned_at";
    const updatedExpression = historical
      ? `(SELECT r.created_at
          FROM memory_revisions r
          WHERE r.memory_id = m.id AND r.created_at <= @at
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1)`
      : "m.updated_at";
    const lastAccessedExpression = historical
      ? `(SELECT MAX(u.used_at)
          FROM memory_usage u
          WHERE u.memory_id = m.id AND u.used_at <= @at)`
      : `(SELECT MAX(u.used_at)
          FROM memory_usage u
          WHERE u.memory_id = m.id)`;
    const memoryClauses = [
      "(m.valid_from IS NULL OR m.valid_from <= @at)",
      "(m.valid_to IS NULL OR m.valid_to > @at)",
    ];
    if (historical) memoryClauses.push("m.created_at <= @at");
    if (!request.includeDeleted) {
      memoryClauses.push(
        historical
          ? "(m.deleted_at IS NULL OR m.deleted_at > @at)"
          : "m.deleted_at IS NULL",
      );
    }
    if (request.type) memoryClauses.push("m.type = @type");
    if (request.claimSlot) {
      memoryClauses.push("mc.claim_slot = @claimSlot");
      if (historical) memoryClauses.push("mc.created_at <= @at");
    }

    const candidateClauses = ["c.revision_id IS NOT NULL"];
    if (request.status) candidateClauses.push("c.status_at = @status");
    else if (!request.includeInactive) {
      candidateClauses.push("c.status_at = 'active'");
    }
    if (request.sourceType) {
      candidateClauses.push(`EXISTS (
        SELECT 1
        FROM memory_revision_sources rs
        JOIN memory_sources s ON s.id = rs.source_id
        WHERE rs.revision_id = c.revision_id AND s.type = @sourceType
      )`);
    }

    const queryJoin = match
      ? `JOIN memory_fts
           ON memory_fts.memory_id = c.memory_id
          AND memory_fts.revision_id = c.revision_id`
      : "";
    if (match) candidateClauses.push("memory_fts MATCH @match");
    const score = match ? ", bm25(memory_fts) AS relevance" : "";
    const order = match
      ? "relevance ASC, c.pinned_at IS NOT NULL DESC, c.importance DESC, c.confidence DESC, c.updated_at DESC, c.memory_id"
      : "c.pinned_at IS NOT NULL DESC, c.importance DESC, c.confidence DESC, c.updated_at DESC, c.memory_id";
    const limitClause = limit === undefined ? "" : "LIMIT @limit";
    const rows = this.database
      .prepare(
        `WITH candidates AS (
           SELECT m.id AS memory_id,
                  ${revisionExpression} AS revision_id,
                  ${statusExpression} AS status_at,
                  ${pinnedExpression} AS pinned_at,
                  m.importance, m.confidence,
                  ${lastAccessedExpression} AS last_accessed_at,
                  ${updatedExpression} AS updated_at
           FROM memories m
           LEFT JOIN memory_claims mc ON mc.memory_id = m.id
           WHERE ${memoryClauses.join(" AND ")}
         )
         SELECT c.memory_id, c.revision_id, c.status_at,
                c.last_accessed_at, c.updated_at${score}
         FROM candidates c
         ${queryJoin}
         WHERE ${candidateClauses.join(" AND ")}
         ORDER BY ${order}
         ${limitClause}`,
      )
      .all({
        at,
        ...(match ? { match } : {}),
        ...(request.claimSlot ? { claimSlot: request.claimSlot } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(request.sourceType ? { sourceType: request.sourceType } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...(request.type ? { type: request.type } : {}),
      }) as RetrievalRow[];

    const hits = this.repository.hitsFor(
      rows.map((row) => ({
        memoryId: row.memory_id,
        revisionId: row.revision_id,
      })),
    );
    return hits.map((hit, index) => {
      const row = rows[index]!;
      const memory = asOf
        ? projectHistoricalMemory(
            hit.memory,
            row.revision_id,
            row.status_at,
            asOf,
            row.updated_at,
            row.last_accessed_at,
          )
        : hit.memory;
      return { ...hit, memory, rank: index + 1 };
    });
  }
}
