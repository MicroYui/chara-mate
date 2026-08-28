import type Database from "better-sqlite3";

export function migrateV15ToV16(database: Database.Database): void {
  const hasWakeEnabledColumn = (
    database.pragma("table_info(voice_settings)") as Array<{ name: string }>
  ).some(({ name }) => name === "wake_enabled");
  database.transaction(() => {
    if (!hasWakeEnabledColumn) {
      database.exec(`
        ALTER TABLE voice_settings
        ADD COLUMN wake_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (wake_enabled IN (0, 1));
      `);
    }
    database
      .prepare(
        "UPDATE app_metadata SET value = '16' WHERE key = 'schema_version' AND value = '15'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
