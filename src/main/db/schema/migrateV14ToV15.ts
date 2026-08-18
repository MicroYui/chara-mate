import type Database from "better-sqlite3";

export function migrateV14ToV15(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS chat_context_snapshots (
        chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        format_version INTEGER NOT NULL CHECK (format_version = 1),
        summary_text TEXT NOT NULL,
        covered_through_message_id TEXT,
        covered_through_created_at TEXT,
        last_request_bytes INTEGER CHECK (
          last_request_bytes IS NULL OR last_request_bytes > 0
        ),
        last_input_tokens INTEGER CHECK (
          last_input_tokens IS NULL OR last_input_tokens > 0
        ),
        last_model_id TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (covered_through_message_id, chat_id)
          REFERENCES messages(id, chat_id),
        CHECK (
          (
            covered_through_message_id IS NULL AND
            covered_through_created_at IS NULL AND
            summary_text = ''
          ) OR (
            covered_through_message_id IS NOT NULL AND
            covered_through_created_at IS NOT NULL AND
            length(trim(summary_text)) > 0
          )
        ),
        CHECK (
          (
            last_request_bytes IS NULL AND
            last_input_tokens IS NULL AND
            last_model_id IS NULL
          ) OR (
            last_request_bytes IS NOT NULL AND
            last_input_tokens IS NOT NULL AND
            last_model_id IS NOT NULL AND
            length(trim(last_model_id)) > 0
          )
        )
      ) STRICT;
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '15' WHERE key = 'schema_version' AND value = '14'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
