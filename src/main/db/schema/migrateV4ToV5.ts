import type Database from "better-sqlite3";

const MIGRATION_SQL = `
  DROP INDEX IF EXISTS runs_one_active_turn_per_chat_idx;

  CREATE TABLE run_items_v5 (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    kind TEXT NOT NULL CHECK (
      kind IN (
        'user_message', 'assistant_message', 'plan', 'input_request',
        'tool_call', 'command', 'file_change', 'approval',
        'context_compaction', 'error'
      )
    ),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'running', 'waiting_approval', 'waiting_input',
        'completed', 'failed', 'cancelled', 'interrupted'
      )
    ),
    input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
    output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
    display_output TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    UNIQUE (run_id, sequence),
    UNIQUE (id, run_id)
  ) STRICT;

  INSERT INTO run_items_v5 (
    id, run_id, sequence, kind, status, input_json, output_json,
    display_output, started_at, ended_at, duration_ms, error_json
  )
  SELECT
    id, run_id, sequence, kind, status, input_json, output_json,
    display_output, started_at, ended_at, duration_ms, error_json
  FROM run_items;

  DROP TABLE run_items;
  ALTER TABLE run_items_v5 RENAME TO run_items;

  CREATE TABLE checkpoints_v5 (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    phase TEXT NOT NULL CHECK (
      phase IN ('model', 'tool', 'approval', 'input', 'interrupted')
    ),
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    last_completed_sequence INTEGER NOT NULL CHECK (
      last_completed_sequence >= 0
    ),
    updated_at TEXT NOT NULL
  ) STRICT;

  INSERT INTO checkpoints_v5 (
    run_id, generation, phase, context_json, last_completed_sequence, updated_at
  )
  SELECT
    run_id, generation, phase, context_json, last_completed_sequence, updated_at
  FROM checkpoints;

  DROP TABLE checkpoints;
  ALTER TABLE checkpoints_v5 RENAME TO checkpoints;
`;

export function migrateV4ToV5(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(MIGRATION_SQL);
      database
        .prepare(
          "UPDATE app_metadata SET value = '5' WHERE key = 'schema_version'",
        )
        .run();
    })();
  } finally {
    database.pragma("foreign_keys = ON");
  }
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
