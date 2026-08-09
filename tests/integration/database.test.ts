import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  openApplicationDatabase,
  verifyDatabaseRoundTrip,
} from "../../src/main/db/database";
import { serializeForPersistence } from "../../src/main/db/persistenceBoundary";
import { CURRENT_SCHEMA_VERSION } from "../../src/main/db/schema/current";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("foundation database", () => {
  it("commits a prepared transaction and reads it after close and reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-database-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");

    expect(verifyDatabaseRoundTrip(databasePath)).toBe(true);

    const database = new Database(databasePath, { readonly: true });
    const metadata = database
      .prepare("SELECT key, value FROM app_metadata ORDER BY key")
      .all() as { key: string; value: string }[];
    const foreignKeys = database.pragma("foreign_keys", { simple: true });
    database.close();

    expect(metadata).toEqual([
      { key: "schema_version", value: CURRENT_SCHEMA_VERSION },
    ]);
    expect(foreignKeys).toBe(1);
  });

  it("redacts credentials before a JSON payload reaches SQLite", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-redaction-database-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE payloads (payload TEXT NOT NULL) STRICT");
    const secret = "sk-1234567890abcdef";
    database
      .prepare("INSERT INTO payloads (payload) VALUES (?)")
      .run(serializeForPersistence({ apiKey: secret, result: "safe" }));
    database.close();

    const reopened = new Database(databasePath, { readonly: true });
    const row = reopened.prepare("SELECT payload FROM payloads").get() as {
      payload: string;
    };
    reopened.close();

    expect(row.payload).toContain("[REDACTED]");
    expect(row.payload).not.toContain(secret);
    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      false,
    );
  });

  it("migrates v4 Run data through the current Phase 3 schema", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v4-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database
      .prepare(
        `INSERT INTO chats (id, title, status, created_at, updated_at)
         VALUES ('chat-v4', '保留的会话', 'active', ?, ?)`,
      )
      .run("2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO runs (
           id, chat_id, execution_json, provider_json, status,
           latest_sequence, created_at
         ) VALUES ('run-v4', 'chat-v4', ?, ?, 'interrupted', 1, ?)`,
      )
      .run(
        JSON.stringify({ mode: "chat" }),
        JSON.stringify({ modelId: "model", profileId: "profile" }),
        "2026-08-08T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO run_items (
           id, run_id, sequence, kind, status, input_json
         ) VALUES ('item-v4', 'run-v4', 1, 'plan', 'completed', '{}')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO checkpoints (
           run_id, generation, phase, context_json,
           last_completed_sequence, updated_at
         ) VALUES ('run-v4', 1, 'interrupted', '{}', 1, ?)`,
      )
      .run("2026-08-08T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO tool_artifacts (
           artifact_id, run_item_id, run_id, position, kind,
           display_name, storage_key
         ) VALUES ('artifact-v4', 'item-v4', 'run-v4', 0, 'data',
                   '保留的工件', 'artifact-v4.json')`,
      )
      .run();
    database
      .prepare(
        "UPDATE app_metadata SET value = '4' WHERE key = 'schema_version'",
      )
      .run();
    database.close();

    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare("SELECT kind, status FROM run_items WHERE id = 'item-v4'")
        .get(),
    ).toEqual({ kind: "plan", status: "completed" });
    expect(
      database
        .prepare(
          "SELECT run_item_id FROM tool_artifacts WHERE artifact_id = 'artifact-v4'",
        )
        .get(),
    ).toEqual({ run_item_id: "item-v4" });
    database
      .prepare(
        `INSERT INTO run_items (
           id, run_id, sequence, kind, status, input_json
         ) VALUES ('item-v5', 'run-v4', 2, 'input_request', 'waiting_input', '{}')`,
      )
      .run();
    database
      .prepare("UPDATE checkpoints SET phase = 'input' WHERE run_id = 'run-v4'")
      .run();
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: CURRENT_SCHEMA_VERSION });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memories'")
        .get(),
    ).toEqual({ name: "memories" });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memory_claims'")
        .get(),
    ).toEqual({ name: "memory_claims" });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates v5 Memory data without inventing claim identities", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v5-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO memories (
             id, type, status, current_revision_id, importance, confidence,
             created_at, updated_at
           ) VALUES ('memory-v5', 'preference', 'active', 'revision-v5',
                     0.5, 1, ?, ?)`,
        )
        .run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
      database
        .prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, content, source_type, reason, created_at
           ) VALUES ('revision-v5', 'memory-v5', '用户喜欢徒步。',
                     'user_edit', 'v5 数据', ?)`,
        )
        .run("2026-08-09T00:00:00.000Z");
      database.exec("DROP TABLE memory_candidate_formation");
      database.exec("DROP TABLE memory_claims");
      database
        .prepare(
          "UPDATE app_metadata SET value = '5' WHERE key = 'schema_version'",
        )
        .run();
    })();
    database.close();

    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT content FROM memory_revisions WHERE id = 'revision-v5'",
        )
        .get(),
    ).toEqual({ content: "用户喜欢徒步。" });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memory_claims").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("memory_candidate_formation"),
    ).toEqual({ name: "memory_candidate_formation" });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
