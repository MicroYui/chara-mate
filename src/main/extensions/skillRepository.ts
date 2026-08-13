import type Database from "better-sqlite3";

import type { Timestamp } from "../../shared/contracts/primitives";
import type { SkillSource } from "../../shared/contracts/extensions";
import type { SkillLifecycle } from "../../shared/contracts/extensions";

export interface SkillVersionRecord {
  readonly archivedAt?: Timestamp;
  readonly contentSha256: string;
  readonly content?: string;
  readonly createdAt: Timestamp;
  readonly enabled: boolean;
  readonly lastSuccessAt?: Timestamp;
  readonly lastUsedAt?: Timestamp;
  readonly lifecycle: SkillLifecycle;
  readonly patchCount: number;
  readonly pinned: boolean;
  readonly revision: number;
  readonly skillId: string;
  readonly source: SkillSource;
  readonly sourceCandidateId?: string;
  readonly successCount: number;
  readonly useCount: number;
}

interface SkillVersionRow {
  archived_at: Timestamp | null;
  content_sha256: string;
  content: string | null;
  created_at: Timestamp;
  enabled: number;
  last_success_at: Timestamp | null;
  last_used_at: Timestamp | null;
  lifecycle: SkillLifecycle;
  patch_count: number;
  pinned: number;
  revision: number;
  skill_id: string;
  source: SkillSource;
  source_candidate_id: string | null;
  success_count: number;
  use_count: number;
}

function record(row: SkillVersionRow): SkillVersionRecord {
  return {
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    contentSha256: row.content_sha256,
    ...(row.content === null ? {} : { content: row.content }),
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    lifecycle: row.lifecycle,
    patchCount: row.patch_count,
    pinned: row.pinned === 1,
    revision: row.revision,
    skillId: row.skill_id,
    source: row.source,
    ...(row.source_candidate_id
      ? { sourceCandidateId: row.source_candidate_id }
      : {}),
    successCount: row.success_count,
    useCount: row.use_count,
  };
}

export class SkillRepository {
  constructor(private readonly database: Database.Database) {}

  getLatest(skillId: string): SkillVersionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM skill_versions
         WHERE skill_id = ?
         ORDER BY revision DESC
         LIMIT 1`,
      )
      .get(skillId) as SkillVersionRow | undefined;
    return row ? record(row) : undefined;
  }

  getVersion(
    skillId: string,
    revision: number,
  ): SkillVersionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM skill_versions
         WHERE skill_id = ? AND revision = ?`,
      )
      .get(skillId, revision) as SkillVersionRow | undefined;
    return row ? record(row) : undefined;
  }

  listVersions(skillId: string): SkillVersionRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM skill_versions
           WHERE skill_id = ?
           ORDER BY revision DESC`,
        )
        .all(skillId) as SkillVersionRow[]
    ).map(record);
  }

  ensureContentSnapshot(
    skillId: string,
    revision: number,
    contentSha256: string,
    content: string,
  ): SkillVersionRecord {
    const current = this.getVersion(skillId, revision);
    if (!current || current.contentSha256 !== contentSha256) {
      throw new Error(`Skill ${skillId} revision ${String(revision)} changed`);
    }
    if (current.content === undefined) {
      this.database
        .prepare(
          `UPDATE skill_versions SET content = ?
           WHERE skill_id = ? AND revision = ? AND content IS NULL`,
        )
        .run(content, skillId, revision);
    }
    return this.getVersion(skillId, revision) ?? current;
  }

  recordContent(
    skillId: string,
    source: SkillSource,
    contentSha256: string,
    content: string,
    createdAt: Timestamp,
    sourceCandidateId?: string,
  ): SkillVersionRecord {
    const current = this.getLatest(skillId);
    if (
      current?.contentSha256 === contentSha256 &&
      current.source === source &&
      current.archivedAt === undefined
    ) {
      if (current.content === undefined) {
        this.database
          .prepare(
            `UPDATE skill_versions SET content = ?
             WHERE skill_id = ? AND revision = ?`,
          )
          .run(content, skillId, current.revision);
        return this.#requireLatest(skillId);
      }
      return current;
    }
    if (current?.lifecycle === "active") {
      this.database
        .prepare(
          `UPDATE skill_versions SET lifecycle = 'stale'
           WHERE skill_id = ? AND revision = ?`,
        )
        .run(skillId, current.revision);
    }
    const next: SkillVersionRecord = {
      contentSha256,
      content,
      createdAt,
      enabled: current?.enabled ?? true,
      ...(current?.lastSuccessAt
        ? { lastSuccessAt: current.lastSuccessAt }
        : {}),
      ...(current?.lastUsedAt ? { lastUsedAt: current.lastUsedAt } : {}),
      lifecycle: "active",
      patchCount:
        (current?.patchCount ?? 0) + (sourceCandidateId && current ? 1 : 0),
      pinned: current?.pinned ?? false,
      revision: (current?.revision ?? 0) + 1,
      skillId,
      source,
      ...(sourceCandidateId ? { sourceCandidateId } : {}),
      successCount: current?.successCount ?? 0,
      useCount: current?.useCount ?? 0,
    };
    this.database
      .prepare(
        `INSERT INTO skill_versions (
           skill_id, revision, source, content_sha256, content, enabled,
           lifecycle, pinned, use_count, success_count, last_success_at,
           patch_count, source_candidate_id, archived_at, last_used_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        next.skillId,
        next.revision,
        next.source,
        next.contentSha256,
        next.content,
        next.enabled ? 1 : 0,
        next.lifecycle,
        next.pinned ? 1 : 0,
        next.useCount,
        next.successCount,
        next.lastSuccessAt ?? null,
        next.patchCount,
        next.sourceCandidateId ?? null,
        next.lastUsedAt ?? null,
        next.createdAt,
      );
    return this.getLatest(skillId) ?? next;
  }

  claimEvolutionSource(
    skillId: string,
    candidateId: string,
    incrementPatchCount: boolean,
  ): SkillVersionRecord {
    const current = this.#requireLatest(skillId);
    if (
      current.sourceCandidateId !== undefined &&
      current.sourceCandidateId !== candidateId
    ) {
      throw new Error(`Skill ${skillId} already belongs to another candidate`);
    }
    this.database
      .prepare(
        `UPDATE skill_versions
         SET source_candidate_id = ?,
             patch_count = patch_count + ?
         WHERE skill_id = ? AND revision = ?`,
      )
      .run(
        candidateId,
        current.sourceCandidateId === undefined && incrementPatchCount ? 1 : 0,
        skillId,
        current.revision,
      );
    return this.#requireLatest(skillId);
  }

  setArchived(skillId: string, archivedAt: Timestamp): SkillVersionRecord {
    const current = this.#requireLatest(skillId);
    this.database
      .prepare(
        `UPDATE skill_versions
         SET archived_at = ?, lifecycle = 'archived'
         WHERE skill_id = ? AND revision = ?`,
      )
      .run(archivedAt, skillId, current.revision);
    return this.#requireLatest(skillId);
  }

  setEnabled(skillId: string, enabled: boolean): SkillVersionRecord {
    this.#updateLatest(skillId, "enabled = ?", enabled ? 1 : 0);
    return this.#requireLatest(skillId);
  }

  setLastUsed(skillId: string, lastUsedAt: Timestamp): SkillVersionRecord {
    const current = this.#requireLatest(skillId);
    this.database
      .prepare(
        `UPDATE skill_versions
         SET last_used_at = ?, use_count = use_count + 1
         WHERE skill_id = ? AND revision = ?`,
      )
      .run(lastUsedAt, skillId, current.revision);
    return this.#requireLatest(skillId);
  }

  setPinned(skillId: string, pinned: boolean): SkillVersionRecord {
    this.#updateLatest(skillId, "pinned = ?", pinned ? 1 : 0);
    return this.#requireLatest(skillId);
  }

  recordSuccess(skillId: string, succeededAt: Timestamp): SkillVersionRecord {
    const current = this.#requireLatest(skillId);
    this.database
      .prepare(
        `UPDATE skill_versions
         SET last_success_at = ?, success_count = success_count + 1
         WHERE skill_id = ? AND revision = ?`,
      )
      .run(succeededAt, skillId, current.revision);
    return this.#requireLatest(skillId);
  }

  #requireLatest(skillId: string): SkillVersionRecord {
    const current = this.getLatest(skillId);
    if (!current) throw new Error(`Skill ${skillId} does not exist`);
    return current;
  }

  #updateLatest(skillId: string, assignment: string, value: unknown): void {
    const current = this.#requireLatest(skillId);
    this.database
      .prepare(
        `UPDATE skill_versions SET ${assignment}
         WHERE skill_id = ? AND revision = ?`,
      )
      .run(value, skillId, current.revision);
  }
}
