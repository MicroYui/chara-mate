import type Database from "better-sqlite3";

function hasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const columns = database.pragma(`table_info(${table})`) as {
    readonly name: string;
  }[];
  return columns.some(({ name }) => name === column);
}

export function migrateV21ToV22(database: Database.Database): void {
  database.transaction(() => {
    if (!hasColumn(database, "companion_share_imports", "predecessor_cursor")) {
      database.exec(`
        ALTER TABLE companion_share_imports
          ADD COLUMN predecessor_cursor TEXT CHECK (
            predecessor_cursor IS NULL OR
            length(trim(predecessor_cursor)) > 0
          )
      `);
    }
    database.exec(`
      UPDATE companion_share_imports
      SET predecessor_cursor = (
        SELECT cursor
        FROM companion_mailbox_cursors
        WHERE recipient_kind = 'desktop'
          AND desktop_instance_id = (
            SELECT value
            FROM app_metadata
            WHERE key = 'companion_desktop_instance_id'
          )
      )
      WHERE state = 'claimed' AND predecessor_cursor IS NULL
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '22' WHERE key = 'schema_version' AND value = '21'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
