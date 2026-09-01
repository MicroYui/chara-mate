import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { METADATA_SCHEMA_SQL } from "./current";
import { migrateV20ToV21 } from "./migrateV20ToV21";
import { migrateV21ToV22 } from "./migrateV21ToV22";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("migrateV21ToV22", () => {
  it("adds and backfills the predecessor cursor for a recoverable claimed share", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(METADATA_SCHEMA_SQL);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "20");
    database.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY NOT NULL
      ) STRICT;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        UNIQUE (id, chat_id)
      ) STRICT;
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY NOT NULL
      ) STRICT;
    `);
    migrateV20ToV21(database);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run(
        "companion_desktop_instance_id",
        "44444444-4444-4444-8444-444444444444",
      );
    database
      .prepare(
        `INSERT INTO companion_mailbox_cursors (
           desktop_instance_id, recipient_kind, cursor, updated_at
         ) VALUES (?, 'desktop', ?, ?)`,
      )
      .run(
        "44444444-4444-4444-8444-444444444444",
        "cursor-1",
        "2026-09-01T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO companion_share_imports (
           submission_id, device_id, envelope_id, payload_sha256,
           source_kind, relay_asset_id, cursor, state, run_id, expires_at,
           chat_id, message_id, attachment_id, claimed_at, imported_at,
           relay_acked_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, 'text', NULL, ?, 'claimed', NULL, ?,
           NULL, NULL, NULL, ?, NULL, NULL, ?
         )`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "a".repeat(64),
        "cursor-2",
        "2026-09-02T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
      );

    migrateV21ToV22(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "22" });
    expect(
      database
        .prepare(
          `SELECT cursor, predecessor_cursor
           FROM companion_share_imports
           WHERE submission_id = ?`,
        )
        .get("11111111-1111-4111-8111-111111111111"),
    ).toEqual({ cursor: "cursor-2", predecessor_cursor: "cursor-1" });

    database
      .prepare(
        `UPDATE companion_share_imports
         SET predecessor_cursor = 'cursor-1'
         WHERE submission_id = ?`,
      )
      .run("11111111-1111-4111-8111-111111111111");
    expect(() =>
      database!
        .prepare(
          `UPDATE companion_share_imports
           SET predecessor_cursor = '   '
           WHERE submission_id = ?`,
        )
        .run("11111111-1111-4111-8111-111111111111"),
    ).toThrow();
  });
});
