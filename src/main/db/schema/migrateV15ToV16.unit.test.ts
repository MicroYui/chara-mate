import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateV15ToV16 } from "./migrateV15ToV16";

describe("migrateV15ToV16", () => {
  it("adds an off-by-default wake setting without changing Voice config", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '15');
      CREATE TABLE voice_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'voice'),
        provider_profile_id TEXT NOT NULL,
        voice TEXT NOT NULL,
        instructions TEXT NOT NULL,
        input_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO voice_settings VALUES (
        'voice', 'profile-1', 'verse', '自然回应', 'hands_free',
        '2026-08-25T00:00:00.000Z'
      );
    `);

    migrateV15ToV16(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "16" });
    expect(
      database
        .prepare(
          "SELECT provider_profile_id, voice, instructions, input_mode, wake_enabled FROM voice_settings",
        )
        .get(),
    ).toEqual({
      input_mode: "hands_free",
      instructions: "自然回应",
      provider_profile_id: "profile-1",
      voice: "verse",
      wake_enabled: 0,
    });

    database.close();
  });

  it("advances metadata when the current table shape is already installed", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '15');
      CREATE TABLE voice_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'voice'),
        provider_profile_id TEXT NOT NULL,
        voice TEXT NOT NULL,
        instructions TEXT NOT NULL,
        input_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        wake_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (wake_enabled IN (0, 1))
      ) STRICT;
    `);

    migrateV15ToV16(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "16" });
    database.close();
  });
});
