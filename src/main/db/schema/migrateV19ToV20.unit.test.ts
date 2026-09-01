import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { METADATA_SCHEMA_SQL } from "./current";
import { migrateV18ToV19 } from "./migrateV18ToV19";
import { migrateV19ToV20 } from "./migrateV19ToV20";

describe("migrateV19ToV20", () => {
  it("adds event timing, outreach permission, and proactive opportunities", () => {
    const database = new Database(":memory:");
    database.exec(METADATA_SCHEMA_SQL);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "18");
    migrateV18ToV19(database);

    database.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE runs (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE messages (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE memories (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE memory_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (id, memory_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE memory_candidates (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL
      ) STRICT;
      CREATE TABLE companion_initiative_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        app_name TEXT NOT NULL,
        window_title TEXT NOT NULL,
        grounding TEXT NOT NULL,
        message TEXT NOT NULL,
        outcome TEXT NOT NULL,
        shown_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);

    migrateV19ToV20(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "20" });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proactive_opportunities'",
        )
        .get(),
    ).toEqual({ name: "proactive_opportunities" });
    expect(
      database
        .prepare("PRAGMA table_info(memory_revisions)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining(["occurs_at", "time_zone", "important_moment"]),
    );
    expect(
      database
        .prepare("PRAGMA table_info(companion_initiative_settings)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        "important_moment_outreach_enabled",
        "important_moment_outreach_prompted",
      ]),
    );
    database.close();
  });
});
