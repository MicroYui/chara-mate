import type Database from "better-sqlite3";

import type { Timestamp } from "../../shared/contracts/primitives";
import type { SkillSource } from "../../shared/contracts/extensions";

export interface SkillVersionRecord {
  readonly archivedAt?: Timestamp;
  readonly contentSha256: string;
  readonly createdAt: Timestamp;
  readonly enabled: boolean;
  readonly lastUsedAt?: Timestamp;
  readonly revision: number;
  readonly skillId: string;
  readonly source: SkillSource;
}

interface SkillVersionRow {
  archived_at: Timestamp | null;
  content_sha256: string;
  created_at: Timestamp;
  enabled: number;
  last_used_at: Timestamp | null;
  revision: number;
  skill_id: string;
  source: SkillSource;
}

function record(row: SkillVersionRow): SkillVersionRecord {
  return {
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    revision: row.revision,
    skillId: row.skill_id,
    source: row.source,
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

  recordContent(
    skillId: string,
    source: SkillSource,
    contentSha256: string,
    createdAt: Timestamp,
  ): SkillVersionRecord {
    const current = this.getLatest(skillId);
    if (
      current?.contentSha256 === contentSha256 &&
      current.source === source &&
      current.archivedAt === undefined
    ) {
      return current;
    }
    const next: SkillVersionRecord = {
      contentSha256,
      createdAt,
      enabled: current?.enabled ?? true,
      ...(current?.lastUsedAt ? { lastUsedAt: current.lastUsedAt } : {}),
      revision: (current?.revision ?? 0) + 1,
      skillId,
      source,
    };
    this.database
      .prepare(
        `INSERT INTO skill_versions (
           skill_id, revision, source, content_sha256, enabled,
           archived_at, last_used_at, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        next.skillId,
        next.revision,
        next.source,
        next.contentSha256,
        next.enabled ? 1 : 0,
        next.lastUsedAt ?? null,
        next.createdAt,
      );
    return this.getLatest(skillId) ?? next;
  }

  setArchived(skillId: string, archivedAt: Timestamp): SkillVersionRecord {
    this.#updateLatest(skillId, "archived_at = ?", archivedAt);
    return this.#requireLatest(skillId);
  }

  setEnabled(skillId: string, enabled: boolean): SkillVersionRecord {
    this.#updateLatest(skillId, "enabled = ?", enabled ? 1 : 0);
    return this.#requireLatest(skillId);
  }

  setLastUsed(skillId: string, lastUsedAt: Timestamp): SkillVersionRecord {
    this.#updateLatest(skillId, "last_used_at = ?", lastUsedAt);
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
