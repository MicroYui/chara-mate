import type Database from "better-sqlite3";

import type {
  PersonaKind,
  PersonaLibrarySnapshot,
  PersonaRecord,
  PersonaSnapshot,
} from "../../shared/contracts/persona";
import { PersonaSnapshotSchema } from "../../shared/schemas/persona";
import { parseSchema } from "../../shared/schemas/validation";
import { serializeForPersistence } from "../db/persistenceBoundary";
import { bundledPersonaSnapshots, DEFAULT_PERSONA_ID } from "./personaPresets";

interface PersonaRow {
  readonly created_at: string;
  readonly kind: PersonaKind;
  readonly snapshot_json: string;
  readonly updated_at: string;
}

interface ActivePersonaRow {
  readonly active_persona_id: string;
}

function readRecord(row: PersonaRow): PersonaRecord {
  return {
    createdAt: row.created_at,
    kind: row.kind,
    snapshot: parseSchema(PersonaSnapshotSchema, JSON.parse(row.snapshot_json)),
    updatedAt: row.updated_at,
  };
}

export class PersonaRepository {
  constructor(private readonly database: Database.Database) {}

  initialize(now: string): void {
    this.database.transaction(() => {
      for (const snapshot of bundledPersonaSnapshots(now)) {
        this.database
          .prepare(
            `INSERT OR IGNORE INTO personas (
               id, kind, current_revision, created_at, updated_at
             ) VALUES (?, 'preset', 1, ?, ?)`,
          )
          .run(snapshot.personaId, now, now);
        this.database
          .prepare(
            `INSERT OR IGNORE INTO persona_revisions (
               persona_id, revision, snapshot_json, created_at
             ) VALUES (?, 1, ?, ?)`,
          )
          .run(
            snapshot.personaId,
            serializeForPersistence(snapshot),
            snapshot.revisionCreatedAt,
          );
      }
      this.database
        .prepare(
          `INSERT OR IGNORE INTO persona_settings (
             settings_id, active_persona_id, updated_at
           ) VALUES ('persona', ?, ?)`,
        )
        .run(DEFAULT_PERSONA_ID, now);
    })();
  }

  getLibrary(): PersonaLibrarySnapshot {
    const active = this.database
      .prepare(
        `SELECT active_persona_id
         FROM persona_settings
         WHERE settings_id = 'persona'`,
      )
      .get() as ActivePersonaRow | undefined;
    if (!active) throw new Error("Persona 设置尚未初始化。");
    const rows = this.database
      .prepare(
        `SELECT p.kind, p.created_at, p.updated_at, r.snapshot_json
         FROM personas p
         JOIN persona_revisions r
           ON r.persona_id = p.id AND r.revision = p.current_revision
         ORDER BY CASE p.kind WHEN 'preset' THEN 0 ELSE 1 END,
                  p.created_at, p.id`,
      )
      .all() as PersonaRow[];
    return {
      activePersonaId: active.active_persona_id,
      personas: rows.map(readRecord),
    };
  }

  getSnapshot(personaId: string): PersonaSnapshot | undefined {
    const row = this.database
      .prepare(
        `SELECT r.snapshot_json
         FROM personas p
         JOIN persona_revisions r
           ON r.persona_id = p.id AND r.revision = p.current_revision
         WHERE p.id = ?`,
      )
      .get(personaId) as Pick<PersonaRow, "snapshot_json"> | undefined;
    return row
      ? parseSchema(PersonaSnapshotSchema, JSON.parse(row.snapshot_json))
      : undefined;
  }

  getActiveSnapshot(): PersonaSnapshot {
    const library = this.getLibrary();
    const record = library.personas.find(
      ({ snapshot }) => snapshot.personaId === library.activePersonaId,
    );
    if (!record) throw new Error("当前 Persona 不存在。");
    return record.snapshot;
  }

  insertCustom(input: {
    readonly createdAt: string;
    readonly snapshot: PersonaSnapshot;
  }): PersonaLibrarySnapshot {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO personas (
             id, kind, current_revision, created_at, updated_at
           ) VALUES (?, 'custom', 1, ?, ?)`,
        )
        .run(input.snapshot.personaId, input.createdAt, input.createdAt);
      this.database
        .prepare(
          `INSERT INTO persona_revisions (
             persona_id, revision, snapshot_json, created_at
           ) VALUES (?, 1, ?, ?)`,
        )
        .run(
          input.snapshot.personaId,
          serializeForPersistence(input.snapshot),
          input.snapshot.revisionCreatedAt,
        );
    })();
    return this.getLibrary();
  }

  updateCustom(input: {
    readonly expectedRevision: number;
    readonly snapshot: PersonaSnapshot;
    readonly updatedAt: string;
  }): PersonaLibrarySnapshot {
    this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE personas
           SET current_revision = ?, updated_at = ?
           WHERE id = ? AND kind = 'custom' AND current_revision = ?`,
        )
        .run(
          input.snapshot.revision,
          input.updatedAt,
          input.snapshot.personaId,
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        throw new Error("Persona 已更新、不是自定义 Persona，或当前不存在。");
      }
      this.database
        .prepare(
          `INSERT INTO persona_revisions (
             persona_id, revision, snapshot_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.snapshot.personaId,
          input.snapshot.revision,
          serializeForPersistence(input.snapshot),
          input.snapshot.revisionCreatedAt,
        );
    })();
    return this.getLibrary();
  }

  select(personaId: string, updatedAt: string): PersonaLibrarySnapshot {
    if (!this.getSnapshot(personaId)) throw new Error("Persona 不存在。");
    this.database
      .prepare(
        `UPDATE persona_settings
         SET active_persona_id = ?, updated_at = ?
         WHERE settings_id = 'persona'`,
      )
      .run(personaId, updatedAt);
    return this.getLibrary();
  }
}
