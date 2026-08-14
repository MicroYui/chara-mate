import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateV12ToV13 } from "./migrateV12ToV13";

const NOW = "2026-08-14T00:00:00.000Z";

describe("migrateV12ToV13", () => {
  it("preserves companionship records and lets their ordinary Chat own deletion", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '12');

      CREATE TABLE chats (
        id TEXT PRIMARY KEY NOT NULL
      ) STRICT;

      CREATE TABLE journeys (
        id TEXT PRIMARY KEY NOT NULL,
        home_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        purpose TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
        current_position TEXT,
        next_step TEXT,
        follow_up_json TEXT,
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

      CREATE TABLE together_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        journey_id TEXT REFERENCES journeys(id),
        chat_id TEXT NOT NULL REFERENCES chats(id),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
        resume_note TEXT,
        recap TEXT,
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

      CREATE UNIQUE INDEX together_sessions_one_active_idx
        ON together_sessions(status) WHERE status = 'active';
      CREATE INDEX together_sessions_journey_status_idx
        ON together_sessions(journey_id, status, updated_at DESC);

      CREATE TABLE journey_moments (
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
      CREATE INDEX journey_moments_journey_time_idx
        ON journey_moments(journey_id, occurred_at, id);

      INSERT INTO chats VALUES ('chat-1');
      INSERT INTO journeys VALUES (
        'journey-1', 'chat-1', '毕业论文', '完成毕业论文', 'active',
        '研究方法', '核对方法', NULL, '${NOW}', '${NOW}', NULL, NULL
      );
      INSERT INTO together_sessions VALUES (
        'session-1', 'journey-1', 'chat-1', '修改研究方法', 'paused',
        '从方法部分继续', NULL, '${NOW}', '${NOW}', '${NOW}', NULL
      );
      INSERT INTO journey_moments VALUES (
        'moment-1', 'journey-1', 'session-1', NULL, 'milestone',
        '确定研究方法', '${NOW}', '${NOW}'
      );
    `);

    migrateV12ToV13(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "13" });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM journeys").get(),
    ).toEqual({ count: 1 });
    expect(database.pragma("foreign_key_check")).toEqual([]);

    database.prepare("DELETE FROM chats WHERE id = 'chat-1'").run();

    for (const table of ["journeys", "together_sessions", "journey_moments"]) {
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    }
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
