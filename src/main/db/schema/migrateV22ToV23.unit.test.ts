import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { METADATA_SCHEMA_SQL } from "./current";
import { migrateV22ToV23 } from "./migrateV22ToV23";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("migrateV22ToV23", () => {
  it("renames shown delivery history to surface acceptance without losing outcomes", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(METADATA_SCHEMA_SQL);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "22");
    database.exec(`
      CREATE TABLE companion_initiative_records (
        id TEXT PRIMARY KEY NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'activity' CHECK (
          source_kind IN ('activity', 'memory_event')
        ),
        kind TEXT NOT NULL CHECK (kind IN ('invitation', 'continuation')),
        app_id TEXT,
        app_name TEXT NOT NULL,
        window_title TEXT NOT NULL,
        grounding TEXT NOT NULL,
        message TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (
          outcome IN (
            'shown', 'replied', 'dismissed', 'expired', 'interrupted'
          )
        ),
        shown_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        `INSERT INTO companion_initiative_records (
           id, source_kind, kind, app_name, window_title, grounding, message,
           outcome, shown_at, updated_at
         ) VALUES (?, 'memory_event', 'continuation', ?, ?, ?, ?, 'shown', ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        "CharaMate",
        "重要时刻",
        "用户此前提到今天有分享。",
        "要准备上场了吗？放轻松，照你的节奏来。",
        "2026-09-01T06:30:00.000Z",
        "2026-09-01T06:30:00.000Z",
      );

    migrateV22ToV23(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "23" });
    expect(
      database
        .prepare(
          `SELECT outcome, accepted_at
           FROM companion_initiative_records`,
        )
        .get(),
    ).toEqual({
      accepted_at: "2026-09-01T06:30:00.000Z",
      outcome: "accepted",
    });
  });

  it("accepts an already-current table shape when a fixture only rewinds metadata", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(METADATA_SCHEMA_SQL);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "22");
    database.exec(`
      CREATE TABLE companion_initiative_records (
        id TEXT PRIMARY KEY NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'activity' CHECK (
          source_kind IN ('activity', 'memory_event')
        ),
        kind TEXT NOT NULL CHECK (kind IN ('invitation', 'continuation')),
        app_id TEXT,
        app_name TEXT NOT NULL CHECK (length(trim(app_name)) > 0),
        window_title TEXT NOT NULL CHECK (length(trim(window_title)) > 0),
        grounding TEXT NOT NULL CHECK (length(trim(grounding)) > 0),
        message TEXT NOT NULL CHECK (length(trim(message)) > 0),
        outcome TEXT NOT NULL CHECK (
          outcome IN (
            'accepted', 'replied', 'dismissed', 'expired', 'interrupted'
          )
        ),
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);

    migrateV22ToV23(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "23" });
    expect(
      (
        database.pragma("table_info(companion_initiative_records)") as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    ).toContain("accepted_at");
  });
});
