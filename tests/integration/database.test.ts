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

  it("migrates v4 Run data through the current schema", async () => {
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
      database.prepare("SELECT source FROM runs WHERE id = 'run-v4'").get(),
    ).toEqual({ source: "text" });
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
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'voice_sessions'")
        .get(),
    ).toEqual({ name: "voice_sessions" });
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

  it("migrates v6 data by adding Territory image candidates", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v6-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.transaction(() => {
      database.exec("DROP TABLE territory_image_candidates");
      database
        .prepare(
          "UPDATE app_metadata SET value = '6' WHERE key = 'schema_version'",
        )
        .run();
    })();
    database.close();

    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("territory_image_candidates"),
    ).toEqual({ name: "territory_image_candidates" });
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: CURRENT_SCHEMA_VERSION });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates v8 data by adding Automation definitions and run history", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v8-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.transaction(() => {
      database.exec("DROP TABLE automation_runs");
      database.exec("DROP TABLE automations");
      database
        .prepare(
          "UPDATE app_metadata SET value = '8' WHERE key = 'schema_version'",
        )
        .run();
    })();
    database.close();

    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("automations"),
    ).toEqual({ name: "automations" });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("automation_runs"),
    ).toEqual({ name: "automation_runs" });
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: CURRENT_SCHEMA_VERSION });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates v9 Territory image candidates into sourced item history", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v9-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.transaction(() => {
      database.exec(
        "ALTER TABLE territory_image_candidates DROP COLUMN item_candidate_id",
      );
      database.exec("DROP TABLE territory_item_sources");
      database.exec("DROP TABLE territory_item_candidates");
      database.exec("DROP INDEX territory_placements_scene_age_idx");
      database
        .prepare(
          `INSERT INTO territory_image_candidates (
             candidate_id, provider_profile_id, scene_id, operation,
             source_candidate_id, request_json, status, error_json,
             accepted_item_id, created_at, updated_at
           ) VALUES (?, ?, 'forest-cabin', 'generate', NULL, ?, 'ready',
                     NULL, NULL, ?, ?)`,
        )
        .run(
          "4382a540-0ed1-472c-a9b7-9e320fd0906a",
          "0114dfa3-c4b8-4b06-87c2-06451d079d93",
          JSON.stringify({
            description: "迁移前的图片候选。",
            editInstruction: null,
            name: "旧候选",
            structure: null,
            visualPrompt: "一件迁移后仍可确认的小物",
          }),
          "2026-08-11T08:00:00.000Z",
          "2026-08-11T08:00:00.000Z",
        );
      database
        .prepare(
          "UPDATE app_metadata SET value = '9' WHERE key = 'schema_version'",
        )
        .run();
    })();
    database.close();

    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT status FROM territory_image_candidates WHERE candidate_id = ?",
        )
        .get("4382a540-0ed1-472c-a9b7-9e320fd0906a"),
    ).toEqual({ status: "ready" });
    expect(
      (
        database.pragma("table_info(territory_image_candidates)") as Array<{
          name: string;
        }>
      ).some(({ name }) => name === "item_candidate_id"),
    ).toBe(true);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("territory_item_sources"),
    ).toEqual({ name: "territory_item_sources" });
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: CURRENT_SCHEMA_VERSION });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates v10 Skills into versioned Evolution state", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v10-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      database.exec(`
        CREATE TABLE skill_versions_v10 (
          skill_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          source TEXT NOT NULL CHECK (source IN ('workspace', 'user')),
          content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          archived_at TEXT,
          last_used_at TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (skill_id, revision)
        ) STRICT;
        INSERT INTO skill_versions_v10 (
          skill_id, revision, source, content_sha256, enabled,
          archived_at, last_used_at, created_at
        ) VALUES (
          'user:release-flow', 1, 'user',
          '${"a".repeat(64)}', 1, NULL, NULL, '2026-08-12T00:00:00.000Z'
        );
        DROP TABLE skill_versions;
        ALTER TABLE skill_versions_v10 RENAME TO skill_versions;
        DROP TABLE evolution_candidates;
        DROP TABLE evolution_reviews;
      `);
      database
        .prepare(
          "UPDATE app_metadata SET value = '10' WHERE key = 'schema_version'",
        )
        .run();
    })();
    database.close();

    database = openApplicationDatabase(databasePath);
    const columns = database.pragma("table_info(skill_versions)") as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "content",
        "lifecycle",
        "pinned",
        "use_count",
        "success_count",
        "last_success_at",
        "patch_count",
        "source_candidate_id",
      ]),
    );
    expect(
      database
        .prepare(
          "SELECT lifecycle, pinned, use_count, success_count, patch_count FROM skill_versions",
        )
        .get(),
    ).toEqual({
      lifecycle: "active",
      patch_count: 0,
      pinned: 0,
      success_count: 0,
      use_count: 0,
    });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("evolution_candidates"),
    ).toEqual({ name: "evolution_candidates" });
    expect(
      (
        database.pragma("foreign_key_list(skill_versions)") as Array<{
          on_delete: string;
          table: string;
        }>
      ).find(({ table }) => table === "evolution_candidates")?.on_delete,
    ).toBe("SET NULL");
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: CURRENT_SCHEMA_VERSION });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates v11 data by adding Journey and Together Session state", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-v11-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.transaction(() => {
      database.exec("DROP TABLE journey_moments");
      database.exec("DROP TABLE together_sessions");
      database.exec("DROP TABLE journeys");
      database
        .prepare(
          "UPDATE app_metadata SET value = '11' WHERE key = 'schema_version'",
        )
        .run();
    })();
    database.close();

    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'journeys', 'together_sessions', 'journey_moments'
           ) ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "journey_moments" },
      { name: "journeys" },
      { name: "together_sessions" },
    ]);
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: CURRENT_SCHEMA_VERSION });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("keeps Automation revisions, occurrence identity and lifecycle constraints in SQLite", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-automation-schema-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const database = openApplicationDatabase(databasePath);
    const timestamp = "2026-08-11T12:00:00.000Z";
    const scheduledFor = "2026-08-12T01:00:00.000Z";
    const definitionValueV1 = {
      name: "晨间提醒",
      schedule: {
        kind: "daily",
        localTime: "09:00",
        timeZone: "Asia/Shanghai",
      },
      task: {
        delivery: "bubble",
        kind: "reminder",
        message: "开始今天的计划。",
      },
    };
    const definitionV1 = JSON.stringify(definitionValueV1);
    const definitionV2 = JSON.stringify({
      ...definitionValueV1,
      name: "每日晨间提醒",
    });
    database
      .prepare(
        `INSERT INTO automations (
           id, revision, definition_json, state, next_run_at,
           created_at, updated_at
         ) VALUES ('automation-1', 1, ?, 'active', ?, ?, ?)`,
      )
      .run(definitionV1, scheduledFor, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO automation_runs (
           id, automation_id, automation_revision, definition_json,
           trigger_json, status, requested_at, created_at, updated_at
         ) VALUES (
           'automation-run-1', 'automation-1', 1, ?, ?, 'queued', ?, ?, ?
         )`,
      )
      .run(
        definitionV1,
        JSON.stringify({ kind: "scheduled", scheduledFor }),
        timestamp,
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `UPDATE automations
         SET revision = 2, definition_json = ?, updated_at = ?
         WHERE id = 'automation-1'`,
      )
      .run(definitionV2, timestamp);

    expect(
      database
        .prepare(
          `SELECT automation_revision, definition_json
           FROM automation_runs
           WHERE id = 'automation-run-1'`,
        )
        .get(),
    ).toEqual({ automation_revision: 1, definition_json: definitionV1 });
    expect(() =>
      database
        .prepare(
          `INSERT INTO automation_runs (
             id, automation_id, automation_revision, definition_json,
             trigger_json, status, requested_at, created_at, updated_at
           ) VALUES (
             'automation-run-duplicate', 'automation-1', 2, ?, ?,
             'queued', ?, ?, ?
           )`,
        )
        .run(
          definitionV2,
          JSON.stringify({ kind: "scheduled", scheduledFor }),
          timestamp,
          timestamp,
          timestamp,
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO automation_runs (
             id, automation_id, automation_revision, definition_json,
             trigger_json, status, requested_at, created_at, updated_at
           ) VALUES (
             'automation-run-invalid-trigger', 'automation-1', 2, ?, ?,
             'queued', ?, ?, ?
           )`,
        )
        .run(
          definitionV2,
          JSON.stringify({ kind: "manual", scheduledFor }),
          timestamp,
          timestamp,
          timestamp,
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO automations (
             id, revision, definition_json, state, next_run_at,
             created_at, updated_at
           ) VALUES (
             'automation-invalid', 1, ?, 'active', NULL, ?, ?
           )`,
        )
        .run(definitionV1, timestamp, timestamp),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO automation_runs (
             id, automation_id, automation_revision, definition_json,
             trigger_json, status, requested_at, started_at, ended_at,
             created_at, updated_at
           ) VALUES (
             'automation-run-invalid-error', 'automation-1', 2, ?, ?,
             'failed', ?, ?, ?, ?, ?
           )`,
        )
        .run(
          definitionV2,
          JSON.stringify({ kind: "manual" }),
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        ),
    ).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
