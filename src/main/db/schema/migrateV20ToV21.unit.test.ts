import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { METADATA_SCHEMA_SQL } from "./current";
import { migrateV20ToV21 } from "./migrateV20ToV21";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("migrateV20ToV21", () => {
  it("adds the single-device bridge state and advances the schema version", () => {
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

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "21" });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'companion_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "companion_mailbox_cursors" },
      { name: "companion_message_projections" },
      { name: "companion_share_imports" },
    ]);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'paired_companion_devices'`,
        )
        .get(),
    ).toEqual({ name: "paired_companion_devices" });

    const insertDevice = database.prepare(`
      INSERT INTO paired_companion_devices (
        slot, device_id, installation_id, display_name, relay_origin,
        credential_ref, protocol_version,
        notification_permission, notifications_enabled, status_state,
        status_message, status_observed_at, paired_at, updated_at
      ) VALUES (
        'android', ?, ?, 'Pixel', 'https://relay.example.test', ?, 1,
        'granted', 1, 'online', NULL, ?, ?, ?
      )
    `);
    insertDevice.run(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "44444444-4444-4444-8444-444444444444",
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(() =>
      insertDevice.run(
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
        "88888888-8888-4888-8888-888888888888",
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      database!
        .prepare(
          `INSERT INTO companion_mailbox_cursors (
           desktop_instance_id, recipient_kind, cursor, updated_at
         ) VALUES (?, 'android', 'opaque-1', ?)`,
        )
        .run(
          "33333333-3333-4333-8333-333333333333",
          "2026-09-01T00:00:00.000Z",
        ),
    ).toThrow();
    database
      .prepare(
        `INSERT INTO companion_mailbox_cursors (
           desktop_instance_id, recipient_kind, cursor, updated_at
         ) VALUES (?, 'desktop', 'opaque-1', ?)`,
      )
      .run("33333333-3333-4333-8333-333333333333", "2026-09-01T00:00:00.000Z");
    database.prepare("DELETE FROM paired_companion_devices").run();
    expect(
      database.prepare("SELECT cursor FROM companion_mailbox_cursors").get(),
    ).toEqual({ cursor: "opaque-1" });
  });
});
