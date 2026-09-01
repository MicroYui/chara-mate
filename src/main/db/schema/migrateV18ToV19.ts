import type Database from "better-sqlite3";

export function migrateV18ToV19(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS companion_initiative_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'companion'),
        level TEXT NOT NULL CHECK (
          level IN ('off', 'quiet', 'balanced', 'lively')
        ),
        quiet_hours_enabled INTEGER NOT NULL CHECK (
          quiet_hours_enabled IN (0, 1)
        ),
        quiet_hours_start_minute INTEGER NOT NULL CHECK (
          quiet_hours_start_minute BETWEEN 0 AND 1439
        ),
        quiet_hours_end_minute INTEGER NOT NULL CHECK (
          quiet_hours_end_minute BETWEEN 0 AND 1439
        ),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '19' WHERE key = 'schema_version' AND value = '18'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
