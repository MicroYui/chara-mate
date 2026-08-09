import type Database from "better-sqlite3";

import type {
  MemoryCandidate,
  MemoryCreateRequest,
  MemoryDetail,
  MemoryHit,
  MemoryProposalInput,
  MemoryRecord,
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
import { memorySearchDocument } from "./memorySearchText";

interface MemoryRow {
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

interface RevisionRow {
  content: string;
  created_at: string;
  id: string;
  memory_id: string;
  reason: string;
  source_type: MemorySourceType;
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
  confidence: number;
  content: string;
  created_at: string;
  id: string;
  importance: number;
  novelty: number;
  reason: string;
  source_ids_json: string;
  source_labels_json: string;
  source_type: MemorySourceType;
  status: MemoryCandidate["status"];
  supersedes_memory_id: string | null;
  type: MemoryType;
  updated_at: string;
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

export interface CreateMemoryInput extends MemoryCreateRequest {
  readonly memoryId: string;
  readonly now: Timestamp;
  readonly revisionId: string;
}

export interface ReviseMemoryInput extends MemoryReviseRequest {
  readonly now: Timestamp;
  readonly revisionId: string;
}

export interface ProposeMemoryInput extends MemoryProposalInput {
  readonly candidateId: string;
  readonly now: Timestamp;
}

export interface MemoryHitSelection {
  readonly memoryId: string;
  readonly revisionId: string;
}

const memorySelect = `
  SELECT m.id, m.type, m.status, m.current_revision_id, m.importance,
         m.confidence, m.valid_from, m.valid_to, m.pinned_at,
         m.superseded_by_id, m.deleted_at, m.created_at, m.updated_at,
         (SELECT MAX(u.used_at) FROM memory_usage u WHERE u.memory_id = m.id)
           AS last_accessed_at
  FROM memories m
`;

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
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
    confidence: row.confidence,
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    importance: row.importance,
    novelty: row.novelty,
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
  const sourceType = sources[0]?.type;
  if (!sourceType || sources.some((source) => source.type !== sourceType)) {
    throw new MemoryError(
      "MEMORY.CONFLICT",
      "同一个 Revision 的来源类型必须一致。",
      false,
    );
  }
  return sourceType;
}

export class MemoryRepository {
  constructor(private readonly database: Database.Database) {}

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
        `SELECT id, memory_id, content, source_type, reason, created_at
         FROM memory_revisions
         WHERE memory_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(memoryId) as RevisionRow[];
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
        content: revision.content,
        createdAt: revision.created_at,
        id: revision.id,
        memoryId: revision.memory_id,
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

  hitsFor(selections: readonly MemoryHitSelection[]): MemoryHit[] {
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
            `SELECT id, memory_id, content, source_type, reason, created_at
             FROM memory_revisions
             WHERE id IN (SELECT value FROM json_each(?))`,
          )
          .all(revisionIds) as RevisionRow[]
      ).map((row) => [row.id, row]),
    );
    const sourcesByRevision = new Map<string, MemorySource[]>();
    const sources = this.database
      .prepare(
        `SELECT s.id, s.type, s.reference_id, s.label, s.created_at,
                rs.revision_id
         FROM memory_revision_sources rs
         JOIN memory_sources s ON s.id = rs.source_id
         WHERE rs.revision_id IN (SELECT value FROM json_each(?))
         ORDER BY s.created_at, s.id`,
      )
      .all(revisionIds) as SourceRow[];
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
          content: revision.content,
          createdAt: revision.created_at,
          id: revision.id,
          memoryId: revision.memory_id,
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
    return this.database.transaction(() => {
      const current = this.requireDetail(input.memoryId);
      if (current.memory.deletedAt || current.memory.status !== "active") {
        throw new MemoryError(
          "MEMORY.INVALID_STATE",
          "只有当前有效的记忆可以编辑。",
          false,
        );
      }
      const sourceType = revisionSourceType(input.sources);
      this.database
        .prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, content, source_type, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.revisionId,
          input.memoryId,
          input.content,
          sourceType,
          input.reason,
          input.now,
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
    })();
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
         )`,
      );
      for (const sourceId of sourceIds) removeOrphan.run(sourceId, sourceId);
    })();
  }

  propose(input: ProposeMemoryInput): MemoryCandidate {
    this.database
      .prepare(
        `INSERT INTO memory_candidates (
           id, type, status, content, reason, source_ids_json,
           source_labels_json, source_type,
           confidence, importance, novelty, valid_from, valid_to,
           supersedes_memory_id, accepted_memory_id, created_at, updated_at
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
        input.validFrom ?? null,
        input.validTo ?? null,
        input.supersedesMemoryId ?? null,
        input.now,
        input.now,
      );
    return this.requireCandidate(input.candidateId);
  }

  listPendingCandidates(): MemoryCandidate[] {
    return (
      this.database
        .prepare(
          `SELECT id, type, status, content, reason, source_ids_json,
                  source_labels_json,
                  source_type, confidence, importance, novelty, valid_from,
                  valid_to, supersedes_memory_id, created_at, updated_at
           FROM memory_candidates
           WHERE status = 'pending'
           ORDER BY created_at DESC, id`,
        )
        .all() as CandidateRow[]
    ).map(candidateFromRow);
  }

  hasCandidateReason(reason: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM memory_candidates WHERE reason = ? LIMIT 1")
        .get(reason),
    );
  }

  requireCandidate(candidateId: string): MemoryCandidate {
    const row = this.database
      .prepare(
        `SELECT id, type, status, content, reason, source_ids_json,
                source_labels_json,
                source_type, confidence, importance, novelty, valid_from,
                valid_to, supersedes_memory_id, created_at, updated_at
         FROM memory_candidates WHERE id = ?`,
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
           id, memory_id, content, source_type, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.revisionId,
        input.memoryId,
        input.content,
        sourceType,
        input.reason,
        input.now,
      );
    this.#indexRevision(input.memoryId, input.revisionId, input.content);
    this.#attachSources(input.revisionId, input.sources);
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
       VALUES (?, ?)`,
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
