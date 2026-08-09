import type Database from "better-sqlite3";

interface ColumnRow {
  readonly name: string;
}

export function migrateV7ToV8(database: Database.Database): void {
  database.transaction(() => {
    const source = database
      .prepare("SELECT name FROM pragma_table_info('runs') WHERE name = ?")
      .get("source") as ColumnRow | undefined;
    if (!source) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'voice'))",
      );
    }
    database
      .prepare(
        "UPDATE app_metadata SET value = '8' WHERE key = 'schema_version'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
