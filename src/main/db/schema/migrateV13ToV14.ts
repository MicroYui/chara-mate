import type Database from "better-sqlite3";

export function migrateV13ToV14(database: Database.Database): void {
  const hasProvisionalColumn = (
    database.pragma("table_info(chats)") as Array<{ name: string }>
  ).some(({ name }) => name === "is_provisional");
  database.transaction(() => {
    if (!hasProvisionalColumn) {
      database.exec(`
        ALTER TABLE chats
        ADD COLUMN is_provisional INTEGER NOT NULL DEFAULT 0
          CHECK (is_provisional IN (0, 1));
      `);
    }
    database
      .prepare(
        "UPDATE app_metadata SET value = '14' WHERE key = 'schema_version' AND value = '13'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
