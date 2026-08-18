import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateV14ToV15 } from "./migrateV14ToV15";

describe("migrateV14ToV15", () => {
  it("adds the durable per-Chat context snapshot without changing messages", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '14');
      CREATE TABLE chats (
        id TEXT PRIMARY KEY NOT NULL
      ) STRICT;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (id, chat_id)
      ) STRICT;
      INSERT INTO chats VALUES ('chat-1');
      INSERT INTO messages VALUES (
        'message-1', 'chat-1', 'keep me', '2026-08-18T00:00:00.000Z'
      );
    `);

    migrateV14ToV15(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "15" });
    expect(
      database
        .prepare(
          `SELECT chat_id, generation, format_version, summary_text,
                  covered_through_message_id, covered_through_created_at
           FROM chat_context_snapshots`,
        )
        .all(),
    ).toEqual([]);
    expect(database.prepare("SELECT content FROM messages").all()).toEqual([
      { content: "keep me" },
    ]);

    database.close();
  });
});
