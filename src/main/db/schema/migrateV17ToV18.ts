import type Database from "better-sqlite3";

import { defaultPersonaSnapshot } from "../../persona/personaPresets";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hasColumn(
  database: Database.Database,
  table: "automation_runs" | "runs" | "voice_sessions",
  column: string,
): boolean {
  const columns = database.pragma(`table_info(${table})`) as {
    readonly name: string;
  }[];
  return columns.some(({ name }) => name === column);
}

export function migrateV17ToV18(database: Database.Database): void {
  const defaultSnapshot = sqlString(JSON.stringify(defaultPersonaSnapshot()));
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('preset', 'custom')),
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS persona_revisions (
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (persona_id, revision)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS persona_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'persona'),
        active_persona_id TEXT NOT NULL REFERENCES personas(id),
        updated_at TEXT NOT NULL
      ) STRICT;

      ALTER TABLE voice_settings RENAME TO voice_settings_v17;
      CREATE TABLE voice_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'voice'),
        provider_profile_id TEXT NOT NULL,
        input_mode TEXT NOT NULL CHECK (
          input_mode IN ('hands_free', 'push_to_talk')
        ),
        wake_enabled INTEGER NOT NULL DEFAULT 0 CHECK (wake_enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO voice_settings (
        settings_id, provider_profile_id, input_mode, wake_enabled, updated_at
      )
      SELECT
        settings_id, provider_profile_id, input_mode, wake_enabled, updated_at
      FROM voice_settings_v17;
      DROP TABLE voice_settings_v17;

      CREATE INDEX IF NOT EXISTS persona_revisions_created_idx
        ON persona_revisions(persona_id, revision DESC);
    `);
    for (const table of [
      "runs",
      "automation_runs",
      "voice_sessions",
    ] as const) {
      if (!hasColumn(database, table, "persona_json")) {
        database.exec(`
          ALTER TABLE ${table}
            ADD COLUMN persona_json TEXT NOT NULL DEFAULT ${defaultSnapshot}
            CHECK (json_valid(persona_json))
        `);
      }
    }
    database
      .prepare(
        "UPDATE app_metadata SET value = '18' WHERE key = 'schema_version' AND value = '17'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
