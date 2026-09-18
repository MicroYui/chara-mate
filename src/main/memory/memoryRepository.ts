import type Database from "better-sqlite3";

import type {
  MemoryCandidate,
  MemoryClaimOperation,
  MemoryClaimSlot,
  MemoryCreateRequest,
  MemoryDetail,
  MemoryHit,
  MemoryProposalInput,
  MemoryRecord,
  MemoryPriorDisposition,
  MemoryRevision,
  MemoryReviseRequest,
  MemorySource,
  MemorySourceType,
  MemoryStatus,
  MemoryType,
  MemoryUsage,
} from "../../shared/contracts/memory";
import type { Timestamp } from "../../shared/contracts/primitives";
import { MemoryError } from "./memoryError";
import { MemoryFormationRepository } from "./memoryFormationRepository";
import { MemoryLearningRepository } from "./memoryLearningRepository";
import { MemoryRecallRepository } from "./memoryRecallRepository";
import { memorySearchDocument } from "./memorySearchText";
import {
  memoryRevisionHistoryColumns,
  memoryRevisionHistoryCte,
  revisionHistoryValue,
  validatePriorDispositions,
  type MemoryRevisionHistoryRow,
} from "./memoryRevisionHistory";

interface MemoryRow {
  claim_slot: MemoryClaimSlot | null;
  confidence: number;
  created_at: string;
  current_revision_id: string;
  deleted_at: string | null;
  id: string;
  importance: number;
  last_accessed_at: string | null;
  pinned_at: string | null;
  status: MemoryStatus;
  superseded_by_id: string | null;
  type: MemoryType;
  updated_at: string;
  valid_from: string | null;
  valid_to: string | null;
}

interface RevisionRow extends MemoryRevisionHistoryRow {
  predecessor_revision_id: string | null;
  prior_dispositions_json: string;
  content: string;
  created_at: string;
  id: string;
  important_moment: number;
  memory_id: string;
  occurs_at: string | null;
  reason: string;
  source_type: MemorySourceType;
  time_zone: string | null;
}

interface SourceRow {
  created_at: string;
  id: string;
  label: string | null;
  reference_id: string;
  revision_id: string;
  type: MemorySourceType;
}

interface CandidateRow {
  accepted_memory_id: string | null;
  claim_operation: MemoryClaimOperation | null;
  claim_slot: MemoryClaimSlot | null;
  confidence: number;
  content: string;
  created_at: string;
  id: string;
  important_moment: number;
  importance: number;
  novelty: number;
  occurs_at: string | null;
  reason: string;
  source_ids_json: string;
  source_labels_json: string;
  source_type: MemorySourceType;
  status: MemoryCandidate["status"];
  supersedes_memory_id: string | null;
  type: MemoryType;
  updated_at: string;
  time_zone: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

interface UsageRow {
  consumer: MemoryUsage["consumer"];
  id: string;
  memory_id: string;
  revision_id: string;
  used_at: string;
}

export type CreateMemoryInput = Omit<
  MemoryCreateRequest,
  "occursAt" | "timeZone"
> & {
  readonly memoryId: string;
  readonly now: Timestamp;
  readonly occursAt?: Timestamp;
  readonly revisionId: string;
  readonly timeZone?: string;
};

export type ReviseMemoryInput = Omit<
  MemoryReviseRequest,
  "occursAt" | "timeZone"
> & {
  readonly predecessorRevisionId: string;
  readonly priorDispositions: readonly MemoryPriorDisposition[];
  readonly now: Timestamp;
  readonly occursAt?: Timestamp;
  readonly revisionId: string;
  readonly timeZone?: string;
};

export type ProposeMemoryInput = Omit<
  MemoryProposalInput,
  "occursAt" | "timeZone"
> & {
  readonly candidateId: string;
  readonly formation?: {
    readonly operation: MemoryClaimOperation;
    readonly slot?: MemoryClaimSlot;
  };
  readonly now: Timestamp;
  readonly occursAt?: Timestamp;
  readonly timeZone?: string;
};

export interface MemoryHitSelection {
  readonly memoryId: string;
  readonly revisionId: string;
}

const memorySelect = `
  SELECT m.id, mc.claim_slot, m.type, m.status,
         m.current_revision_id, m.importance,
         m.confidence, m.valid_from, m.valid_to, m.pinned_at,
         m.superseded_by_id, m.deleted_at, m.created_at, m.updated_at,
         (SELECT MAX(u.used_at) FROM memory_usage u WHERE u.memory_id = m.id)
           AS last_accessed_at
  FROM memories m
  LEFT JOIN memory_claims mc ON mc.memory_id = m.id
`;

const candidateSelect = `
  SELECT c.id, c.type, c.status, c.content, c.reason, c.source_ids_json,
         c.source_labels_json, c.source_type, c.confidence, c.importance,
         c.novelty, c.important_moment, c.occurs_at, c.time_zone,
         c.valid_from, c.valid_to,
         c.supersedes_memory_id,
         c.accepted_memory_id, c.created_at, c.updated_at,
         mcf.operation AS claim_operation,
         mcf.claim_slot
  FROM memory_candidates c
  LEFT JOIN memory_candidate_formation mcf ON mcf.candidate_id = c.id
`;

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    ...(row.claim_slot ? { claimSlot: row.claim_slot } : {}),
    confidence: row.confidence,
    createdAt: row.created_at,
    currentRevisionId: row.current_revision_id,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    id: row.id,
    importance: row.importance,
    ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    status: row.status,
    ...(row.superseded_by_id ? { supersededById: row.superseded_by_id } : {}),
    type: row.type,
    updatedAt: row.updated_at,
    ...(row.valid_from ? { validFrom: row.valid_from } : {}),
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
  };
}

function mapSource(row: SourceRow): MemorySource {
  return {
    createdAt: row.created_at,
    id: row.id,
    ...(row.label ? { label: row.label } : {}),
    referenceId: row.reference_id,
    type: row.type,
  };
}

function candidateFromRow(row: CandidateRow): MemoryCandidate {
  return {
    ...(row.claim_operation ? { claimOperation: row.claim_operation } : {}),
    ...(row.claim_slot ? { claimSlot: row.claim_slot } : {}),
    confidence: row.confidence,
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    importantMoment: row.important_moment === 1,
    importance: row.importance,
    novelty: row.novelty,
    ...(row.occurs_at && row.time_zone
      ? { occursAt: row.occurs_at, timeZone: row.time_zone }
      : {}),
    reason: row.reason,
    sourceIds: JSON.parse(row.source_ids_json) as string[],
    sourceLabels: JSON.parse(row.source_labels_json) as string[],
    sourceType: row.source_type,
    status: row.status,
    ...(row.supersedes_memory_id
      ? { supersedesMemoryId: row.supersedes_memory_id }
      : {}),
    type: row.type,
    updatedAt: row.updated_at,
    ...(row.valid_from ? { validFrom: row.valid_from } : {}),
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
  };
}

function revisionSourceType(
  sources: readonly MemorySource[],
): MemorySourceType {
  if (sources.length === 0) return "user_edit";
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    throw new MemoryError(
      "MEMORY.CONFLICT",
      "同一个 Revision 不能重复引用同一来源。",
      false,
    );
  }
  const sourceType = sources[0]!.type;
  // A revision can synthesize evidence from a message and a tool or activity.
  // Keep each source's actual provenance; this field only labels the revision.
  return sources.every((source) => source.type === sourceType)
    ? sourceType
    : "distillation";
}

export class MemoryRepository {
  readonly recall: MemoryRecallRepository;
  readonly formation: MemoryFormationRepository;
  readonly learning: MemoryLearningRepository;

  constructor(private readonly database: Database.Database) {
    this.formation = new MemoryFormationRepository(database);
    this.recall = new MemoryRecallRepository(database, this);
    this.learning = new MemoryLearningRepository(database);
  }

  hasMemorySource(memoryId: string, sourceId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM memory_revision_sources rs
         JOIN memory_revisions r ON r.id=rs.revision_id
         WHERE r.memory_id=? AND rs.source_id=? LIMIT 1`,
        )
        .get(memoryId, sourceId) !== undefined
    );
  }

  attachEvidence(revisionId: string, sources: readonly MemorySource[]): void {
    // Existing support still validates the immutable source binding. The join
    // insert is idempotent; filtering it out earlier would skip that validation.
    this.#attachSources(revisionId, sources);
    const types = this.database
      .prepare(
        `SELECT DISTINCT s.type
         FROM memory_sources s
         JOIN memory_revision_sources rs ON rs.source_id=s.id
         WHERE rs.revision_id=?`,
      )
      .all(revisionId) as { type: MemorySourceType }[];
    if (types.length > 1)
      this.database
        .prepare(
          "UPDATE memory_revisions SET source_type='distillation' WHERE id=?",
        )
        .run(revisionId);
  }

  getDetail(memoryId: string, includeDeleted = true): MemoryDetail | undefined {
    const row = this.database
      .prepare(
        `${memorySelect}
         WHERE m.id = ? ${includeDeleted ? "" : "AND m.deleted_at IS NULL"}`,
      )
      .get(memoryId) as MemoryRow | undefined;
    if (!row) return undefined;

    const revisionRows = this.database
      .prepare(
        `${memoryRevisionHistoryCte("SELECT id,memory_id FROM memory_revisions WHERE memory_id=@memoryId")}
         SELECT r.id,r.memory_id,r.content,r.source_type,r.reason,
                r.important_moment,r.occurs_at,r.time_zone,r.created_at,
                r.predecessor_revision_id,r.prior_dispositions_json,${memoryRevisionHistoryColumns()}
         FROM memory_revisions r JOIN memories m ON m.id=r.memory_id JOIN revision_history rh ON rh.id=r.id
         WHERE r.memory_id = @memoryId
         ORDER BY (r.id = @currentId) DESC, r.created_at DESC, r.rowid DESC`,
      )
      .all({ memoryId, currentId: row.current_revision_id }) as RevisionRow[];
    const sourceRows = this.database
      .prepare(
        `SELECT s.id, s.type, s.reference_id, s.label, s.created_at,
                rs.revision_id
         FROM memory_sources s
         JOIN memory_revision_sources rs ON rs.source_id = s.id
         JOIN memory_revisions r ON r.id = rs.revision_id
         WHERE r.memory_id = ?
         ORDER BY s.created_at, s.id`,
      )
      .all(memoryId) as SourceRow[];
    const usages = (
      this.database
        .prepare(
          `SELECT id, memory_id, revision_id, consumer, used_at
           FROM memory_usage
           WHERE memory_id = ?
           ORDER BY used_at DESC, id DESC`,
        )
        .all(memoryId) as UsageRow[]
    ).map((usage): MemoryUsage => ({
      consumer: usage.consumer,
      id: usage.id,
      memoryId: usage.memory_id,
      revisionId: usage.revision_id,
      usedAt: usage.used_at,
    }));
    const sourceIdsByRevision = new Map<string, string[]>();
    for (const source of sourceRows) {
      const ids = sourceIdsByRevision.get(source.revision_id) ?? [];
      ids.push(source.id);
      sourceIdsByRevision.set(source.revision_id, ids);
    }
    return {
      memory: mapMemory(row),
      revisions: revisionRows.map((revision): MemoryRevision => ({
        ...revisionHistoryValue(revision),
        priorDispositions: JSON.parse(
          revision.prior_dispositions_json,
        ) as MemoryPriorDisposition[],
        ...(revision.predecessor_revision_id
          ? { predecessorRevisionId: revision.predecessor_revision_id }
          : {}),
        content: revision.content,
        createdAt: revision.created_at,
        id: revision.id,
        importantMoment: revision.important_moment === 1,
        memoryId: revision.memory_id,
        ...(revision.occurs_at && revision.time_zone
          ? { occursAt: revision.occurs_at, timeZone: revision.time_zone }
          : {}),
        reason: revision.reason,
        sourceIds: sourceIdsByRevision.get(revision.id) ?? [],
        sourceType: revision.source_type,
      })),
      sources: [
        ...new Map(
          sourceRows.map((source) => [source.id, mapSource(source)]),
        ).values(),
      ],
      usages,
    };
  }

  requireDetail(memoryId: string): MemoryDetail {
    const detail = this.getDetail(memoryId);
    if (!detail) {
      throw new MemoryError("MEMORY.NOT_FOUND", "找不到这条记忆。", false);
    }
    return detail;
  }

  findDetailByClaimSlot(slot: MemoryClaimSlot): MemoryDetail | undefined {
    const row = this.database
      .prepare(
        `SELECT memory_id AS id
         FROM memory_claims
         WHERE claim_slot = ?`,
      )
      .get(slot) as { id: string } | undefined;
    return row ? this.requireDetail(row.id) : undefined;
  }

  findActiveDetailByContent(content: string): MemoryDetail | undefined {
    const row = this.database
      .prepare(
        `SELECT m.id
         FROM memories m
         JOIN memory_revisions r ON r.id = m.current_revision_id
         WHERE m.status = 'active'
           AND m.deleted_at IS NULL
           AND r.content = ? COLLATE NOCASE
         ORDER BY m.updated_at DESC, m.id
         LIMIT 1`,
      )
      .get(content) as { id: string } | undefined;
    return row ? this.requireDetail(row.id) : undefined;
  }

  findDetailBySourceReference(referenceId: string): MemoryDetail | undefined {
    const row = this.database
      .prepare(
        `SELECT r.memory_id AS id
         FROM memory_sources s
         JOIN memory_revision_sources rs ON rs.source_id = s.id
         JOIN memory_revisions r ON r.id = rs.revision_id
         WHERE s.reference_id = ?
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1`,
      )
      .get(referenceId) as { id: string } | undefined;
    return row ? this.requireDetail(row.id) : undefined;
  }

  listRecords(options: {
    readonly includeDeleted?: boolean;
    readonly sourceType?: MemorySourceType;
    readonly status?: MemoryStatus;
    readonly type?: MemoryType;
  }): MemoryRecord[] {
    const clauses = [];
    const parameters: Array<string | number> = [];
    if (!options.includeDeleted) clauses.push("m.deleted_at IS NULL");
    if (options.status) {
      clauses.push("m.status = ?");
      parameters.push(options.status);
    }
    if (options.type) {
      clauses.push("m.type = ?");
      parameters.push(options.type);
    }
    if (options.sourceType) {
      clauses.push(`EXISTS (
        SELECT 1
        FROM memory_revisions r
        JOIN memory_revision_sources rs ON rs.revision_id = r.id
        JOIN memory_sources s ON s.id = rs.source_id
        WHERE r.memory_id = m.id AND s.type = ?
      )`);
      parameters.push(options.sourceType);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `${memorySelect}
         ${where}
         ORDER BY m.pinned_at IS NOT NULL DESC, m.updated_at DESC, m.id`,
      )
      .all(...parameters) as MemoryRow[];
    return rows.map(mapMemory);
  }

  hitsFor(
    selections: readonly MemoryHitSelection[],
    sourceLimit?: number,
  ): MemoryHit[] {
    if (selections.length === 0) return [];
    const memoryIds = JSON.stringify([
      ...new Set(selections.map(({ memoryId }) => memoryId)),
    ]);
    const revisionIds = JSON.stringify([
      ...new Set(selections.map(({ revisionId }) => revisionId)),
    ]);
    const memories = new Map(
      (
        this.database
          .prepare(
            `${memorySelect}
             WHERE m.id IN (SELECT value FROM json_each(?))`,
          )
          .all(memoryIds) as MemoryRow[]
      ).map((row) => [row.id, mapMemory(row)]),
    );
    const revisions = new Map(
      (
        this.database
          .prepare(
            `${memoryRevisionHistoryCte("SELECT id,memory_id FROM memory_revisions WHERE id IN (SELECT value FROM json_each(@revisionIds))")}
             SELECT r.id,r.memory_id,r.content,r.source_type,r.reason,
                    r.important_moment,r.occurs_at,r.time_zone,r.created_at,
                    r.predecessor_revision_id,r.prior_dispositions_json,${memoryRevisionHistoryColumns()}
             FROM memory_revisions r JOIN memories m ON m.id=r.memory_id JOIN revision_history rh ON rh.id=r.id
             WHERE r.id IN (SELECT value FROM json_each(@revisionIds))`,
          )
          .all({ revisionIds }) as RevisionRow[]
      ).map((row) => [row.id, row]),
    );
    const sourcesByRevision = new Map<string, MemorySource[]>();
    const sources = this.database
      .prepare(
        `SELECT id,type,reference_id,label,created_at,revision_id FROM (
           SELECT s.id, s.type, s.reference_id, s.label, s.created_at, rs.revision_id,
             ROW_NUMBER() OVER (PARTITION BY rs.revision_id ORDER BY s.created_at,s.id) AS ordinal
           FROM memory_revision_sources rs JOIN memory_sources s ON s.id=rs.source_id
           WHERE rs.revision_id IN (SELECT value FROM json_each(@revisionIds))
         ) WHERE @sourceLimit IS NULL OR ordinal<=@sourceLimit
         ORDER BY created_at,id`,
      )
      .all({ revisionIds, sourceLimit: sourceLimit ?? null }) as SourceRow[];
    for (const source of sources) {
      const values = sourcesByRevision.get(source.revision_id) ?? [];
      values.push(mapSource(source));
      sourcesByRevision.set(source.revision_id, values);
    }

    return selections.map(({ memoryId, revisionId }, index) => {
      const memory = memories.get(memoryId);
      const revision = revisions.get(revisionId);
      if (!memory || !revision || revision.memory_id !== memoryId) {
        throw new MemoryError(
          "MEMORY.STORAGE_FAILED",
          "记忆的当前 Revision 不存在。",
          false,
        );
      }
      return {
        memory,
        rank: index + 1,
        revision: {
          ...revisionHistoryValue(revision),
          priorDispositions: JSON.parse(
            revision.prior_dispositions_json,
          ) as MemoryPriorDisposition[],
          ...(revision.predecessor_revision_id
            ? { predecessorRevisionId: revision.predecessor_revision_id }
            : {}),
          content: revision.content,
          createdAt: revision.created_at,
          id: revision.id,
          importantMoment: revision.important_moment === 1,
          memoryId: revision.memory_id,
          ...(revision.occurs_at && revision.time_zone
            ? { occursAt: revision.occurs_at, timeZone: revision.time_zone }
            : {}),
          reason: revision.reason,
          sourceIds: (sourcesByRevision.get(revisionId) ?? []).map(
            ({ id }) => id,
          ),
          sourceType: revision.source_type,
        },
        sources: sourcesByRevision.get(revisionId) ?? [],
      };
    });
  }

  profileHits(): MemoryHit[] {
    const selections = this.database
      .prepare(
        `SELECT p.memory_id AS memoryId, p.revision_id AS revisionId
         FROM profile_fields p
         JOIN memories m ON m.id = p.memory_id
         WHERE m.status = 'active' AND m.deleted_at IS NULL
         ORDER BY p.updated_at DESC, p.memory_id`,
      )
      .all() as MemoryHitSelection[];
    return this.hitsFor(selections);
  }

  hitFor(
    memory: MemoryRecord,
    revisionId = memory.currentRevisionId,
    rank = 1,
  ): MemoryHit {
    const detail = this.requireDetail(memory.id);
    const revision = detail.revisions.find(({ id }) => id === revisionId);
    if (!revision) {
      throw new MemoryError(
        "MEMORY.STORAGE_FAILED",
        "记忆的当前 Revision 不存在。",
        false,
      );
    }
    const sourceIds = new Set(revision.sourceIds);
    return {
      memory,
      rank,
      revision,
      sources: detail.sources.filter(({ id }) => sourceIds.has(id)),
    };
  }

  create(input: CreateMemoryInput): MemoryDetail {
    return this.database.transaction(() => this.#insertMemory(input))();
  }

  revise(input: ReviseMemoryInput): MemoryDetail {
    return this.database.transaction(() => this.#reviseMemory(input))();
  }

  revisionIdsFor(memoryId: string): string[] {
    return (
      this.database
        .prepare(
          "SELECT id FROM memory_revisions WHERE memory_id=? ORDER BY id",
        )
        .all(memoryId) as { id: string }[]
    ).map(({ id }) => id);
  }

  currentRevisionIds(revisionIds: readonly string[]): ReadonlySet<string> {
    if (!revisionIds.length) return new Set();
    const rows = this.database
      .prepare(
        `SELECT r.id FROM memory_revisions r JOIN memories m ON m.id=r.memory_id
         WHERE r.id IN (SELECT value FROM json_each(?))
           AND m.current_revision_id=r.id AND m.status='active' AND m.deleted_at IS NULL`,
      )
      .all(JSON.stringify([...new Set(revisionIds)])) as { id: string }[];
    return new Set(rows.map(({ id }) => id));
  }

  setPinned(memoryId: string, pinned: boolean, now: Timestamp): MemoryDetail {
    const result = this.database
      .prepare(
        `UPDATE memories
         SET pinned_at = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(pinned ? now : null, now, memoryId);
    if (result.changes !== 1) this.#throwMissingOrDeleted(memoryId);
    return this.requireDetail(memoryId);
  }

  archive(memoryId: string, now: Timestamp): MemoryDetail {
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE memories SET status = 'archived', updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(now, memoryId);
      if (result.changes !== 1) this.#throwMissingOrDeleted(memoryId);
      this.#removeProfile(memoryId);
      return this.requireDetail(memoryId);
    })();
  }

  softDelete(memoryId: string, now: Timestamp): MemoryDetail {
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE memories
           SET status = 'archived', deleted_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(now, now, memoryId);
      if (result.changes !== 1) this.#throwMissingOrDeleted(memoryId);
      this.#removeProfile(memoryId);
      return this.requireDetail(memoryId);
    })();
  }

  restore(memoryId: string, now: Timestamp): MemoryDetail {
    return this.database.transaction(() => {
      const current = this.requireDetail(memoryId);
      if (!current.memory.deletedAt && current.memory.status !== "archived") {
        throw new MemoryError(
          "MEMORY.INVALID_STATE",
          "这条记忆当前不需要恢复。",
          false,
        );
      }
      const status: MemoryStatus = current.memory.supersededById
        ? "superseded"
        : "active";
      this.database
        .prepare(
          `UPDATE memories
           SET status = ?, deleted_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(status, now, memoryId);
      if (status === "active" && current.memory.type === "profile") {
        this.#projectProfile(memoryId, current.memory.currentRevisionId, now);
      }
      return this.requireDetail(memoryId);
    })();
  }

  purge(memoryId: string): void {
    const current = this.requireDetail(memoryId);
    if (!current.memory.deletedAt) {
      throw new MemoryError(
        "MEMORY.INVALID_STATE",
        "永久删除前请先将记忆移到可恢复删除状态。",
        false,
      );
    }
    this.database.transaction(() => {
      const sourceIds = (
        this.database
          .prepare(
            `SELECT DISTINCT rs.source_id AS id
             FROM memory_revisions r
             JOIN memory_revision_sources rs ON rs.revision_id = r.id
             WHERE r.memory_id = ?`,
          )
          .all(memoryId) as Array<{ id: string }>
      ).map(({ id }) => id);
      this.database
        .prepare("DELETE FROM memory_fts WHERE memory_id = ?")
        .run(memoryId);
      this.database.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
      const removeOrphan = this.database.prepare(
        `DELETE FROM memory_sources
         WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM memory_revision_sources WHERE source_id = ?
         ) AND NOT EXISTS (SELECT 1 FROM memory_work_sources WHERE source_id = ?)`,
      );
      for (const sourceId of sourceIds)
        removeOrphan.run(sourceId, sourceId, sourceId);
    })();
  }

  propose(input: ProposeMemoryInput): MemoryCandidate {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO memory_candidates (
             id, type, status, content, reason, source_ids_json,
             source_labels_json, source_type,
             confidence, importance, novelty, important_moment,
             occurs_at, time_zone,
             valid_from, valid_to,
             supersedes_memory_id, accepted_memory_id, created_at, updated_at
           ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.candidateId,
          input.type,
          input.content,
          input.reason,
          JSON.stringify(input.sourceIds),
          JSON.stringify(input.sourceLabels),
          input.sourceType,
          input.confidence,
          input.importance,
          input.novelty,
          input.importantMoment ? 1 : 0,
          input.occursAt ?? null,
          input.timeZone ?? null,
          input.validFrom ?? null,
          input.validTo ?? null,
          input.supersedesMemoryId ?? null,
          input.now,
          input.now,
        );
      if (input.formation) {
        this.database
          .prepare(
            `INSERT INTO memory_candidate_formation (
               candidate_id, operation, claim_slot
             ) VALUES (?, ?, ?)`,
          )
          .run(
            input.candidateId,
            input.formation.operation,
            input.formation.slot ?? null,
          );
      }
    })();
    return this.requireCandidate(input.candidateId);
  }

  listPendingCandidates(): MemoryCandidate[] {
    return (
      this.database
        .prepare(
          `${candidateSelect}
           WHERE c.status = 'pending'
           ORDER BY c.created_at DESC, c.id`,
        )
        .all() as CandidateRow[]
    ).map(candidateFromRow);
  }

  findPendingCandidateByContent(
    content: string,
    options: {
      readonly importantMoment?: boolean;
      readonly operation?: MemoryClaimOperation;
      readonly occursAt?: string;
      readonly slot?: MemoryClaimSlot;
      readonly supersedesMemoryId?: string;
      readonly timeZone?: string;
    } = {},
  ): MemoryCandidate | undefined {
    const row = this.database
      .prepare(
        `${candidateSelect}
         WHERE c.status = 'pending'
           AND c.content = ? COLLATE NOCASE
           AND c.important_moment = ?
           AND (
             (? IS NULL AND c.occurs_at IS NULL)
             OR c.occurs_at = ?
           )
           AND (
             (? IS NULL AND c.time_zone IS NULL)
             OR c.time_zone = ?
           )
           AND (
             (? IS NULL AND c.supersedes_memory_id IS NULL)
             OR c.supersedes_memory_id = ?
           )
           AND (
             (? IS NULL AND mcf.claim_slot IS NULL)
             OR mcf.claim_slot = ?
           )
           AND (
             (? IS NULL AND mcf.operation IS NULL)
             OR mcf.operation = ?
           )
         ORDER BY c.created_at, c.id
         LIMIT 1`,
      )
      .get(
        content,
        options.importantMoment ? 1 : 0,
        options.occursAt ?? null,
        options.occursAt ?? null,
        options.timeZone ?? null,
        options.timeZone ?? null,
        options.supersedesMemoryId ?? null,
        options.supersedesMemoryId ?? null,
        options.slot ?? null,
        options.slot ?? null,
        options.operation ?? null,
        options.operation ?? null,
      ) as CandidateRow | undefined;
    return row ? candidateFromRow(row) : undefined;
  }

  requireCandidate(candidateId: string): MemoryCandidate {
    const row = this.database
      .prepare(
        `${candidateSelect}
         WHERE c.id = ?`,
      )
      .get(candidateId) as CandidateRow | undefined;
    if (!row) {
      throw new MemoryError(
        "MEMORY.CANDIDATE_NOT_FOUND",
        "找不到这条记忆候选。",
        false,
      );
    }
    return candidateFromRow(row);
  }

  rejectCandidate(candidateId: string, now: Timestamp): MemoryCandidate {
    const result = this.database
      .prepare(
        `UPDATE memory_candidates
         SET status = 'rejected', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, candidateId);
    if (result.changes !== 1) this.#throwCandidateState(candidateId);
    return this.requireCandidate(candidateId);
  }

  discardPendingCandidate(candidateId: string): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM memory_candidates WHERE id = ? AND status = 'pending'",
        )
        .run(candidateId).changes === 1
    );
  }

  acceptCandidate(candidateId: string, input: CreateMemoryInput): MemoryDetail {
    return this.database.transaction(() => {
      const candidate = this.requireCandidate(candidateId);
      if (candidate.status !== "pending")
        this.#throwCandidateState(candidateId);
      if (candidate.claimSlot !== input.claimSlot) {
        throw new MemoryError(
          "MEMORY.CONFLICT",
          "候选的稳定字段与目标记忆不一致。",
          false,
        );
      }
      const detail = this.#insertMemory(input);
      this.database
        .prepare(
          `UPDATE memory_candidates
           SET status = 'accepted', accepted_memory_id = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(detail.memory.id, input.now, candidateId);
      return detail;
    })();
  }

  acceptCandidateAsRevision(
    candidateId: string,
    input: ReviseMemoryInput,
    claimSlot?: MemoryClaimSlot,
  ): MemoryDetail {
    return this.database.transaction(() => {
      const candidate = this.requireCandidate(candidateId);
      if (
        candidate.status !== "pending" ||
        !candidate.claimOperation ||
        candidate.supersedesMemoryId !== input.memoryId ||
        candidate.claimSlot !== claimSlot
      ) {
        this.#throwCandidateState(candidateId);
      }
      if (claimSlot) this.#bindClaim(input.memoryId, claimSlot, input.now);
      const detail = this.#reviseMemory(input);
      this.database
        .prepare(
          `UPDATE memory_candidates
           SET status = 'accepted', accepted_memory_id = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(input.memoryId, input.now, candidateId);
      return detail;
    })();
  }

  recordUsages(
    inputs: readonly {
      readonly consumer: "context" | "tool";
      readonly id: string;
      readonly memoryId: string;
      readonly revisionId: string;
      readonly usedAt: Timestamp;
    }[],
  ): void {
    if (inputs.length === 0) return;
    const insert = this.database.prepare(
      `INSERT INTO memory_usage (
         id, memory_id, revision_id, consumer, used_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.database.transaction(() => {
      for (const input of inputs) {
        insert.run(
          input.id,
          input.memoryId,
          input.revisionId,
          input.consumer,
          input.usedAt,
        );
      }
    })();
  }

  #insertMemory(input: CreateMemoryInput): MemoryDetail {
    const sourceType = revisionSourceType(input.sources);
    if (input.supersedesMemoryId === input.memoryId) {
      throw new MemoryError("MEMORY.CONFLICT", "记忆不能取代自身。", false);
    }
    this.database
      .prepare(
        `INSERT INTO memories (
           id, type, status, current_revision_id, importance, confidence,
           valid_from, valid_to, pinned_at, superseded_by_id, deleted_at,
           created_at, updated_at
         ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.memoryId,
        input.type,
        input.revisionId,
        input.importance,
        input.confidence,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.now,
        input.now,
      );
    this.database
      .prepare(
        `INSERT INTO memory_revisions (
           id, memory_id, content, source_type, reason,
           important_moment, occurs_at, time_zone, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.revisionId,
        input.memoryId,
        input.content,
        sourceType,
        input.reason,
        input.importantMoment ? 1 : 0,
        input.occursAt ?? null,
        input.timeZone ?? null,
        input.now,
      );
    this.#indexRevision(input.memoryId, input.revisionId, input.content);
    this.#attachSources(input.revisionId, input.sources);
    if (input.claimSlot) {
      this.#bindClaim(input.memoryId, input.claimSlot, input.now);
    }
    if (input.type === "profile") {
      this.#projectProfile(input.memoryId, input.revisionId, input.now);
    }
    if (input.supersedesMemoryId) {
      const result = this.database
        .prepare(
          `UPDATE memories
           SET status = 'superseded', superseded_by_id = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL AND status = 'active'`,
        )
        .run(input.memoryId, input.now, input.supersedesMemoryId);
      if (result.changes !== 1) {
        throw new MemoryError(
          "MEMORY.CONFLICT",
          "要取代的旧记忆不存在或已不再有效。",
          false,
        );
      }
      this.#removeProfile(input.supersedesMemoryId);
    }
    return this.requireDetail(input.memoryId);
  }

  #reviseMemory(input: ReviseMemoryInput): MemoryDetail {
    const current = this.requireDetail(input.memoryId);
    if (current.memory.deletedAt || current.memory.status !== "active") {
      throw new MemoryError(
        "MEMORY.INVALID_STATE",
        "只有当前有效的记忆可以编辑。",
        false,
      );
    }
    const priorDispositions = validatePriorDispositions(this.database, input);
    const sourceType = revisionSourceType(input.sources);
    this.database
      .prepare(
        `INSERT INTO memory_revisions (
           id, memory_id, content, source_type, reason,
           important_moment, occurs_at, time_zone, created_at, predecessor_revision_id, prior_dispositions_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.revisionId,
        input.memoryId,
        input.content,
        sourceType,
        input.reason,
        input.importantMoment ? 1 : 0,
        input.occursAt ?? null,
        input.timeZone ?? null,
        input.now,
        input.predecessorRevisionId,
        JSON.stringify(priorDispositions),
      );
    this.#indexRevision(input.memoryId, input.revisionId, input.content);
    this.#attachSources(input.revisionId, input.sources);
    this.database
      .prepare(
        `UPDATE memories
         SET current_revision_id = ?, importance = COALESCE(?, importance),
             confidence = COALESCE(?, confidence),
             valid_from = COALESCE(?, valid_from),
             valid_to = COALESCE(?, valid_to),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.revisionId,
        input.importance ?? null,
        input.confidence ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.now,
        input.memoryId,
      );
    if (current.memory.type === "profile") {
      this.#projectProfile(input.memoryId, input.revisionId, input.now);
    }
    return this.requireDetail(input.memoryId);
  }

  #bindClaim(
    memoryId: string,
    claimSlot: MemoryClaimSlot,
    now: Timestamp,
  ): void {
    const memoryClaim = this.database
      .prepare(
        `SELECT claim_slot
         FROM memory_claims
         WHERE memory_id = ?`,
      )
      .get(memoryId) as { claim_slot: MemoryClaimSlot } | undefined;
    if (memoryClaim && memoryClaim.claim_slot !== claimSlot) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "这条记忆已经绑定到另一个稳定字段。",
        false,
      );
    }
    const slotOwner = this.database
      .prepare(
        `SELECT memory_id
         FROM memory_claims
         WHERE claim_slot = ?`,
      )
      .get(claimSlot) as { memory_id: string } | undefined;
    if (slotOwner && slotOwner.memory_id !== memoryId) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "这个稳定字段已经绑定到另一条记忆。",
        false,
      );
    }
    if (!memoryClaim) {
      this.database
        .prepare(
          `INSERT INTO memory_claims (
             memory_id, claim_slot, created_at, updated_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(memoryId, claimSlot, now, now);
    }
  }

  #attachSources(revisionId: string, sources: readonly MemorySource[]): void {
    const insertSource = this.database.prepare(
      `INSERT INTO memory_sources (
         id, type, reference_id, label, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const readSource = this.database.prepare(
      `SELECT id, type, reference_id, label, created_at, '' AS revision_id
       FROM memory_sources WHERE id = ?`,
    );
    const attach = this.database.prepare(
      `INSERT INTO memory_revision_sources (revision_id, source_id)
       VALUES (?, ?) ON CONFLICT(revision_id,source_id) DO NOTHING`,
    );
    for (const source of sources) {
      insertSource.run(
        source.id,
        source.type,
        source.referenceId,
        source.label ?? null,
        source.createdAt,
      );
      const stored = readSource.get(source.id) as SourceRow;
      if (
        stored.type !== source.type ||
        stored.reference_id !== source.referenceId ||
        stored.label !== (source.label ?? null) ||
        stored.created_at !== source.createdAt
      ) {
        throw new MemoryError(
          "MEMORY.CONFLICT",
          "来源 ID 已存在且内容不同。",
          false,
        );
      }
      attach.run(revisionId, source.id);
    }
  }

  #indexRevision(memoryId: string, revisionId: string, content: string): void {
    this.database
      .prepare("DELETE FROM memory_fts WHERE revision_id = ?")
      .run(revisionId);
    this.database
      .prepare(
        `INSERT INTO memory_fts (tokens, memory_id, revision_id)
         VALUES (?, ?, ?)`,
      )
      .run(memorySearchDocument(content), memoryId, revisionId);
    const revision = this.database
      .prepare("SELECT created_at FROM memory_revisions WHERE id=?")
      .get(revisionId) as { created_at: string };
    this.recall.enqueueRevision(revisionId, content, revision.created_at);
  }

  #projectProfile(memoryId: string, revisionId: string, now: Timestamp): void {
    this.database
      .prepare(
        `INSERT INTO profile_fields (memory_id, revision_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           revision_id = excluded.revision_id,
           updated_at = excluded.updated_at`,
      )
      .run(memoryId, revisionId, now);
  }

  #removeProfile(memoryId: string): void {
    this.database
      .prepare("DELETE FROM profile_fields WHERE memory_id = ?")
      .run(memoryId);
  }

  #throwMissingOrDeleted(memoryId: string): never {
    const existing = this.getDetail(memoryId);
    throw new MemoryError(
      existing ? "MEMORY.INVALID_STATE" : "MEMORY.NOT_FOUND",
      existing ? "这条记忆当前不能执行该操作。" : "找不到这条记忆。",
      false,
    );
  }

  #throwCandidateState(candidateId: string): never {
    const candidate = this.requireCandidate(candidateId);
    throw new MemoryError(
      "MEMORY.INVALID_STATE",
      `这条候选已${candidate.status === "accepted" ? "接受" : "拒绝"}。`,
      false,
    );
  }
}
