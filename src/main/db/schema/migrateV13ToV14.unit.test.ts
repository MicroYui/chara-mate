import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateV13ToV14 } from "./migrateV13ToV14";

describe("migrateV13ToV14", () => {
  it("adds hidden provisional Chat state without changing existing Chats", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '13');

      CREATE TABLE chats (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        pinned_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO chats (
        id, title, status, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        '已有对话',
        'active',
        '2026-08-14T00:00:00.000Z',
        '2026-08-14T00:00:00.000Z'
      );
    `);

    migrateV13ToV14(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "14" });
    expect(
      database
        .prepare(
          "SELECT title, is_provisional FROM chats WHERE title = '已有对话'",
        )
        .get(),
    ).toEqual({ is_provisional: 0, title: "已有对话" });
    expect(() =>
      database.exec(`
        INSERT INTO chats (
          id, title, status, is_provisional, created_at, updated_at
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',
          '临时邀请',
          'active',
          2,
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.000Z'
        );
      `),
    ).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
