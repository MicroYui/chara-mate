import type Database from "better-sqlite3";

export function migrateV16ToV17(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS companion_initiative_records (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('invitation', 'continuation')),
        app_id TEXT,
        app_name TEXT NOT NULL CHECK (length(trim(app_name)) > 0),
        window_title TEXT NOT NULL CHECK (length(trim(window_title)) > 0),
        grounding TEXT NOT NULL CHECK (length(trim(grounding)) > 0),
        message TEXT NOT NULL CHECK (length(trim(message)) > 0),
        outcome TEXT NOT NULL CHECK (
          outcome IN (
            'shown', 'replied', 'dismissed', 'expired', 'interrupted'
          )
        ),
        shown_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS companion_initiative_records_time_idx
        ON companion_initiative_records(shown_at DESC, id DESC);
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '17' WHERE key = 'schema_version' AND value = '16'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
