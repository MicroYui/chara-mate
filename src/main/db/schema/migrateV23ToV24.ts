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

function territorySourcesSupportChatMoments(
  database: Database.Database,
): boolean {
  const row = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'territory_instance_sources'",
    )
    .get() as { readonly sql: string } | undefined;
  if (!row) {
    throw new Error("Schema v23 is missing territory_instance_sources.");
  }
  return row.sql.includes("'chat_moment'");
}

export function migrateV23ToV24(database: Database.Database): void {
  database.transaction(() => {
    if (!hasColumn(database, "territory_change_candidates", "moment_key")) {
      database.exec(`
        ALTER TABLE territory_change_candidates
          ADD COLUMN moment_key TEXT CHECK (
            moment_key IS NULL OR (
              length(moment_key) = 64 AND
              moment_key NOT GLOB '*[^0-9a-f]*'
            )
          )
      `);
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS territory_change_candidates_moment_key_idx
        ON territory_change_candidates(moment_key)
        WHERE moment_key IS NOT NULL
    `);

    if (!territorySourcesSupportChatMoments(database)) {
      database.exec(`
        CREATE TABLE territory_instance_sources_v24 (
          source_kind TEXT NOT NULL CHECK (
            source_kind IN ('memory', 'activity_digest', 'chat_moment')
          ),
          source_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
          PRIMARY KEY (source_kind, source_id),
          UNIQUE (instance_id, source_kind, source_id)
        ) STRICT;

        INSERT INTO territory_instance_sources_v24 (
          source_kind, source_id, instance_id, snapshot_json
        )
        SELECT source_kind, source_id, instance_id, snapshot_json
        FROM territory_instance_sources;

        DROP TABLE territory_instance_sources;
        ALTER TABLE territory_instance_sources_v24
          RENAME TO territory_instance_sources;
      `);
    }

    if (
      !hasColumn(
        database,
        "companion_initiative_settings",
        "territory_moment_surprises_enabled",
      )
    ) {
      database.exec(`
        ALTER TABLE companion_initiative_settings
          ADD COLUMN territory_moment_surprises_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (territory_moment_surprises_enabled IN (0, 1))
      `);
    }
    if (
      !hasColumn(
        database,
        "companion_initiative_settings",
        "territory_moment_surprises_prompted",
      )
    ) {
      database.exec(`
        ALTER TABLE companion_initiative_settings
          ADD COLUMN territory_moment_surprises_prompted INTEGER NOT NULL DEFAULT 0
          CHECK (territory_moment_surprises_prompted IN (0, 1))
      `);
    }

    database
      .prepare(
        "UPDATE app_metadata SET value = '24' WHERE key = 'schema_version' AND value = '23'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
