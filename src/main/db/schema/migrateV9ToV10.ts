import type Database from "better-sqlite3";

export function migrateV9ToV10(database: Database.Database): void {
  database
    .prepare(
      "UPDATE app_metadata SET value = '10' WHERE key = 'schema_version'",
    )
    .run();
}
