import type Database from "better-sqlite3";

const JOURNEY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS journeys (
    id TEXT PRIMARY KEY NOT NULL,
    home_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    purpose TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
    current_position TEXT CHECK (
      current_position IS NULL OR length(trim(current_position)) > 0
    ),
    next_step TEXT CHECK (next_step IS NULL OR length(trim(next_step)) > 0),
    follow_up_json TEXT CHECK (
      follow_up_json IS NULL OR json_valid(follow_up_json)
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    paused_at TEXT,
    completed_at TEXT,
    CHECK (
      (status = 'active' AND paused_at IS NULL AND completed_at IS NULL) OR
      (status = 'paused' AND paused_at IS NOT NULL AND completed_at IS NULL) OR
      (status = 'completed' AND paused_at IS NULL AND completed_at IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS together_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    journey_id TEXT REFERENCES journeys(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
    resume_note TEXT CHECK (
      resume_note IS NULL OR length(trim(resume_note)) > 0
    ),
    recap TEXT CHECK (recap IS NULL OR length(trim(recap)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    paused_at TEXT,
    ended_at TEXT,
    CHECK (
      (status = 'active' AND paused_at IS NULL AND ended_at IS NULL) OR
      (status = 'paused' AND paused_at IS NOT NULL AND ended_at IS NULL) OR
      (status = 'ended' AND paused_at IS NULL AND ended_at IS NOT NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS together_sessions_one_active_idx
    ON together_sessions(status) WHERE status = 'active';

  CREATE INDEX IF NOT EXISTS together_sessions_journey_status_idx
    ON together_sessions(journey_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS journey_moments (
    id TEXT PRIMARY KEY NOT NULL,
    journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES together_sessions(id) ON DELETE SET NULL,
    memory_id TEXT,
    kind TEXT NOT NULL CHECK (
      kind IN ('milestone', 'memory', 'closure', 'reopened')
    ),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS journey_moments_journey_time_idx
    ON journey_moments(journey_id, occurred_at, id);
`;

export function migrateV11ToV12(database: Database.Database): void {
  const migrate = database.transaction(() => {
    database.exec(JOURNEY_SCHEMA_SQL);
    database
      .prepare(
        "UPDATE app_metadata SET value = '12' WHERE key = 'schema_version' AND value = '11'",
      )
      .run();
  });
  migrate();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
