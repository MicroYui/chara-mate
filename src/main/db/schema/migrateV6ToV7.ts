import type Database from "better-sqlite3";

export function migrateV6ToV7(database: Database.Database): void {
  database
    .prepare("UPDATE app_metadata SET value = '7' WHERE key = 'schema_version'")
    .run();
}
