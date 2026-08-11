import type Database from "better-sqlite3";

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed')),
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'active' AND next_run_at IS NOT NULL) OR
      (state IN ('paused', 'completed') AND next_run_at IS NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    automation_id TEXT NOT NULL
      REFERENCES automations(id) ON DELETE CASCADE,
    automation_revision INTEGER NOT NULL CHECK (automation_revision >= 1),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'running',
        'waiting_approval',
        'needs_input',
        'interrupted',
        'completed',
        'failed',
        'cancelled'
      )
    ),
    chat_id TEXT REFERENCES chats(id),
    run_id TEXT UNIQUE,
    summary TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    requested_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id, chat_id) REFERENCES runs(id, chat_id),
    CHECK (run_id IS NULL OR chat_id IS NOT NULL),
    CHECK (json_extract(trigger_json, '$.kind') IN ('scheduled', 'manual')),
    CHECK (
      (
        json_extract(trigger_json, '$.kind') = 'scheduled' AND
        json_type(trigger_json, '$.scheduledFor') = 'text'
      ) OR (
        json_extract(trigger_json, '$.kind') = 'manual' AND
        json_type(trigger_json, '$.scheduledFor') IS NULL
      )
    ),
    CHECK (
      (status = 'queued' AND started_at IS NULL AND ended_at IS NULL) OR
      (
        status IN ('running', 'waiting_approval', 'needs_input') AND
        started_at IS NOT NULL AND ended_at IS NULL
      ) OR (
        status IN ('interrupted', 'completed', 'failed', 'cancelled') AND
        started_at IS NOT NULL AND ended_at IS NOT NULL
      )
    ),
    CHECK (
      (status = 'failed' AND error_json IS NOT NULL) OR
      (status <> 'failed' AND error_json IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS automations_state_next_idx
    ON automations(state, next_run_at, id);
  CREATE INDEX IF NOT EXISTS automation_runs_history_idx
    ON automation_runs(automation_id, requested_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_occurrence_idx
    ON automation_runs(
      automation_id,
      json_extract(trigger_json, '$.scheduledFor')
    )
    WHERE json_extract(trigger_json, '$.kind') = 'scheduled';
`;

export function migrateV8ToV9(database: Database.Database): void {
  database.transaction(() => {
    database.exec(MIGRATION_SQL);
    database
      .prepare(
        "UPDATE app_metadata SET value = '9' WHERE key = 'schema_version'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
