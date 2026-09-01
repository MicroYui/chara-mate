import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { DEFAULT_PERSONA_ID } from "../../persona/personaPresets";
import { migrateV17ToV18 } from "./migrateV17ToV18";

describe("migrateV17ToV18", () => {
  it("adds Persona ownership and immutable runtime snapshots", () => {
    const database = new Database(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '17');
      CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL) STRICT;
      CREATE TABLE automation_runs (id TEXT PRIMARY KEY NOT NULL) STRICT;
      CREATE TABLE voice_sessions (id TEXT PRIMARY KEY NOT NULL) STRICT;
      CREATE TABLE voice_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'voice'),
        provider_profile_id TEXT NOT NULL,
        voice TEXT NOT NULL,
        instructions TEXT NOT NULL,
        input_mode TEXT NOT NULL,
        wake_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO voice_settings VALUES (
        'voice', 'profile-1', 'coral', '自然回应', 'push_to_talk', 1,
        '2026-08-31T00:00:00.000Z'
      );
      INSERT INTO runs VALUES ('run-1');
      INSERT INTO automation_runs VALUES ('automation-run-1');
      INSERT INTO voice_sessions VALUES ('voice-1');
    `);

    migrateV17ToV18(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "18" });
    for (const table of ["runs", "automation_runs", "voice_sessions"]) {
      const row = database
        .prepare(`SELECT persona_json FROM ${table}`)
        .get() as { persona_json: string };
      expect(JSON.parse(row.persona_json)).toMatchObject({
        personaId: DEFAULT_PERSONA_ID,
        revision: 1,
      });
    }
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'persona_revisions'",
        )
        .get(),
    ).toEqual({ name: "persona_revisions" });
    expect(database.prepare("SELECT * FROM voice_settings").get()).toEqual({
      input_mode: "push_to_talk",
      provider_profile_id: "profile-1",
      settings_id: "voice",
      updated_at: "2026-08-31T00:00:00.000Z",
      wake_enabled: 1,
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
