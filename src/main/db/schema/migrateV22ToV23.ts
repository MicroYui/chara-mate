import type Database from "better-sqlite3";

function hasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const columns = database.pragma(`table_info(${table})`) as Array<{
    readonly name: string;
  }>;
  return columns.some(({ name }) => name === column);
}

export function migrateV22ToV23(database: Database.Database): void {
  const hasShownAt = hasColumn(
    database,
    "companion_initiative_records",
    "shown_at",
  );
  const hasAcceptedAt = hasColumn(
    database,
    "companion_initiative_records",
    "accepted_at",
  );
  if (hasShownAt === hasAcceptedAt) {
    throw new Error(
      "Schema v22 companion initiative records have an unsupported time column shape.",
    );
  }
  database.transaction(() => {
    if (hasShownAt) {
      database.exec(`
        CREATE TABLE companion_initiative_records_v23 (
          id TEXT PRIMARY KEY NOT NULL,
          source_kind TEXT NOT NULL DEFAULT 'activity' CHECK (
            source_kind IN ('activity', 'memory_event')
          ),
          kind TEXT NOT NULL CHECK (kind IN ('invitation', 'continuation')),
          app_id TEXT,
          app_name TEXT NOT NULL CHECK (length(trim(app_name)) > 0),
          window_title TEXT NOT NULL CHECK (length(trim(window_title)) > 0),
          grounding TEXT NOT NULL CHECK (length(trim(grounding)) > 0),
          message TEXT NOT NULL CHECK (length(trim(message)) > 0),
          outcome TEXT NOT NULL CHECK (
            outcome IN (
              'accepted', 'replied', 'dismissed', 'expired', 'interrupted'
            )
          ),
          accepted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO companion_initiative_records_v23 (
          id, source_kind, kind, app_id, app_name, window_title, grounding,
          message, outcome, accepted_at, updated_at
        )
        SELECT
          id, source_kind, kind, app_id, app_name, window_title, grounding,
          message,
          CASE outcome WHEN 'shown' THEN 'accepted' ELSE outcome END,
          shown_at, updated_at
        FROM companion_initiative_records;

        DROP TABLE companion_initiative_records;
        ALTER TABLE companion_initiative_records_v23
          RENAME TO companion_initiative_records;

        CREATE INDEX companion_initiative_records_time_idx
          ON companion_initiative_records(accepted_at DESC, id DESC);
      `);
    }
    database
      .prepare(
        "UPDATE app_metadata SET value = '23' WHERE key = 'schema_version' AND value = '22'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
