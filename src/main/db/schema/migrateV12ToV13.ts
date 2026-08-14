import type Database from "better-sqlite3";

const REBUILD_JOURNEY_SCHEMA_SQL = `
  CREATE TABLE journeys_v13 (
    id TEXT PRIMARY KEY NOT NULL,
    home_chat_id TEXT NOT NULL UNIQUE
      REFERENCES chats(id) ON DELETE CASCADE,
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

  CREATE TABLE together_sessions_v13 (
    id TEXT PRIMARY KEY NOT NULL,
    journey_id TEXT REFERENCES journeys_v13(id) ON DELETE CASCADE,
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

  CREATE TABLE journey_moments_v13 (
    id TEXT PRIMARY KEY NOT NULL,
    journey_id TEXT NOT NULL
      REFERENCES journeys_v13(id) ON DELETE CASCADE,
    session_id TEXT
      REFERENCES together_sessions_v13(id) ON DELETE SET NULL,
    memory_id TEXT,
    kind TEXT NOT NULL CHECK (
      kind IN ('milestone', 'memory', 'closure', 'reopened')
    ),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  INSERT INTO journeys_v13
  SELECT * FROM journeys;

  INSERT INTO together_sessions_v13
  SELECT * FROM together_sessions;

  INSERT INTO journey_moments_v13
  SELECT * FROM journey_moments;

  DROP TABLE journey_moments;
  DROP TABLE together_sessions;
  DROP TABLE journeys;

  ALTER TABLE journeys_v13 RENAME TO journeys;
  ALTER TABLE together_sessions_v13 RENAME TO together_sessions;
  ALTER TABLE journey_moments_v13 RENAME TO journey_moments;

  CREATE UNIQUE INDEX together_sessions_one_active_idx
    ON together_sessions(status) WHERE status = 'active';

  CREATE INDEX together_sessions_journey_status_idx
    ON together_sessions(journey_id, status, updated_at DESC);

  CREATE INDEX journey_moments_journey_time_idx
    ON journey_moments(journey_id, occurred_at, id);
`;

export function migrateV12ToV13(database: Database.Database): void {
  database.transaction(() => {
    database.exec(REBUILD_JOURNEY_SCHEMA_SQL);
    database
      .prepare(
        "UPDATE app_metadata SET value = '13' WHERE key = 'schema_version' AND value = '12'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
