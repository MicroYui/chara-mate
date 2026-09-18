import { createHash } from "node:crypto";
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
import {
  CURRENT_SCHEMA_VERSION,
  METADATA_SCHEMA_SQL,
} from "../../src/main/db/schema/current";
import { defaultPersonaSnapshot } from "../../src/main/persona/personaPresets";

const temporaryDirectories: string[] = [];
const PERSONA_JSON = JSON.stringify(defaultPersonaSnapshot());

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
  it("rejects an unsupported development database without replacing its schema or data", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-unsupported-schema-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const previous = new Database(databasePath);
    try {
      previous.exec(METADATA_SCHEMA_SQL);
      previous.exec(`
        INSERT INTO app_metadata VALUES ('schema_version', '25');
        CREATE TABLE development_notes (content TEXT NOT NULL) STRICT;
        INSERT INTO development_notes VALUES ('保留开发数据');
      `);
    } finally {
      previous.close();
    }

    expect(() => openApplicationDatabase(databasePath)).toThrow(
      "Unsupported database schema version: 25",
    );
    const unchanged = new Database(databasePath, { readonly: true });
    try {
      expect(
        unchanged
          .prepare("SELECT value FROM app_metadata WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: "25" });
      expect(
        unchanged.prepare("SELECT content FROM development_notes").all(),
      ).toEqual([{ content: "保留开发数据" }]);
      expect(
        unchanged
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name='provider_profiles'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it("creates current Territory sources and Cognition indexes directly and preserves them on reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-current-schema-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.exec(`
      INSERT INTO territory_instance_sources
        VALUES ('chat_moment', 'saved-moment', 'saved-item', '{"label":"保留的约定"}');
    `);
    database.close();
    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT snapshot_json FROM territory_instance_sources WHERE source_id = 'saved-moment'",
        )
        .get(),
    ).toEqual({ snapshot_json: '{"label":"保留的约定"}' });
    expect(() =>
      database
        .prepare(
          "INSERT INTO territory_instance_sources VALUES ('character_creation', 'tool-item', 'new-item', '{}')",
        )
        .run(),
    ).not.toThrow();
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'companion_life'")
        .get(),
    ).toBeUndefined();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='cognition_evidence_current_user_idx'",
        )
        .get(),
    ).toEqual({ name: "cognition_evidence_current_user_idx" });
    database.close();
  });

  it("persists current Memory sources, raw text and revision links across reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-current-memory-source-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.transaction(() => {
      database.exec(`
        INSERT INTO memories (id,type,status,current_revision_id,importance,confidence,created_at,updated_at)
          VALUES ('memory','event','active','revision',0.5,1,'2026-09-15','2026-09-15');
        INSERT INTO memory_revisions (id,memory_id,content,source_type,reason,created_at)
          VALUES ('revision','memory','保留原始经历','activity','source','2026-09-15');
        INSERT INTO memory_sources (id,type,reference_id,created_at) VALUES ('source','activity','episode','2026-09-15');
        INSERT INTO memory_revision_sources VALUES ('revision','source');
        INSERT INTO memory_revision_source_spans VALUES ('revision','source',0,2,'保留');
      `);
    })();
    database.close();
    database = openApplicationDatabase(databasePath);
    expect(
      database.prepare("SELECT * FROM memory_revision_sources").all(),
    ).toEqual([{ revision_id: "revision", source_id: "source" }]);
    expect(
      database.prepare("SELECT quote FROM memory_revision_source_spans").get(),
    ).toEqual({ quote: "保留" });
    expect(
      database
        .prepare("SELECT content FROM memory_revisions WHERE id = 'revision'")
        .get(),
    ).toEqual({ content: "保留原始经历" });
    expect(
      database
        .prepare(
          "SELECT predecessor_revision_id,prior_dispositions_json FROM memory_revisions WHERE id='revision'",
        )
        .get(),
    ).toEqual({ predecessor_revision_id: null, prior_dispositions_json: "[]" });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='memory_canonical_present'",
        )
        .get(),
    ).toEqual({ name: "memory_canonical_present" });
    database.exec(`INSERT INTO memory_sources (id,type,reference_id,created_at) VALUES ('new','activity_event','event','2026-09-15');
      INSERT INTO memory_revisions (id,memory_id,content,source_type,reason,created_at) VALUES ('new-revision','memory','新观察','activity_event','source','2026-09-15');`);
    for (const table of [
      "memory_revisions",
      "memory_sources",
      "memory_candidates",
    ]) {
      expect(
        (
          database
            .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
            .get(table) as { sql: string }
        ).sql,
      ).toContain("'activity_event'");
    }
    expect(
      database
        .prepare(
          "SELECT raw_speaker,raw_length,raw_json_bytes FROM memory_sources WHERE id='source'",
        )
        .get(),
    ).toEqual({ raw_speaker: null, raw_length: null, raw_json_bytes: null });
    expect(() =>
      database
        .prepare(
          "UPDATE memory_sources SET raw_speaker='user' WHERE id='source'",
        )
        .run(),
    ).toThrow();
    const sourceText = "保留";
    const sourceBytes = Buffer.from(sourceText, "utf16le");
    database
      .prepare(
        "UPDATE memory_sources SET raw_speaker='user',raw_length=2,raw_json_bytes=?,raw_digest=?,raw_present=1 WHERE id='source'",
      )
      .run(
        Buffer.byteLength(JSON.stringify(sourceText)),
        createHash("sha256").update(sourceBytes).digest("hex"),
      );
    database
      .prepare("INSERT INTO memory_source_text_chunks VALUES('source',0,?)")
      .run(sourceBytes);
    database.close();
    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT content FROM memory_source_text_chunks WHERE source_id='source'",
        )
        .get(),
    ).toEqual({ content: Buffer.from("保留", "utf16le") });
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("keeps revision predecessors in their Memory and purges the whole deferred chain", () => {
    const database = openApplicationDatabase(":memory:");
    try {
      const addMemory = database.prepare(`INSERT INTO memories
        (id,type,status,current_revision_id,importance,confidence,created_at,updated_at)
        VALUES (?, 'event', 'active', ?, 0.5, 1, '2026-09-16', '2026-09-16')`);
      const addRevision = database.prepare(`INSERT INTO memory_revisions
        (id,memory_id,content,source_type,reason,created_at,predecessor_revision_id,prior_dispositions_json)
        VALUES (?, ?, '原始经历', 'chat', 'source', '2026-09-16', ?, ?)`);
      database.transaction(() => {
        addMemory.run("first", "first-r0");
        addRevision.run("first-r0", "first", null, "[]");
        addMemory.run("second", "second-r0");
        addRevision.run("second-r0", "second", null, "[]");
      })();
      database.transaction(() => {
        addRevision.run(
          "first-r1",
          "first",
          "first-r0",
          JSON.stringify([
            { revisionId: "first-r0", disposition: "retained_history" },
          ]),
        );
        database
          .prepare(
            "UPDATE memories SET current_revision_id='first-r1' WHERE id='first'",
          )
          .run();
      })();
      expect(() =>
        database.transaction(() => {
          addRevision.run(
            "cross-memory",
            "first",
            "second-r0",
            JSON.stringify([
              { revisionId: "second-r0", disposition: "corrected" },
            ]),
          );
        })(),
      ).toThrow(/FOREIGN KEY/u);
      expect(
        database
          .prepare("SELECT id FROM memory_revisions WHERE id='cross-memory'")
          .get(),
      ).toBeUndefined();
      expect(() =>
        addRevision.run("invalid-json", "first", "first-r1", "{}"),
      ).toThrow();
      expect(() =>
        addRevision.run("unpaired", "first", "first-r1", "[]"),
      ).toThrow();
      expect(database.pragma("foreign_key_check")).toEqual([]);
      database.transaction(() => {
        database.prepare("DELETE FROM memories WHERE id='first'").run();
      })();
      expect(
        database.prepare("SELECT id FROM memory_revisions ORDER BY id").all(),
      ).toEqual([{ id: "second-r0" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("persists observation attribution and receipt ordering across reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-observation-actor-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    let database = openApplicationDatabase(databasePath);
    database.exec(`
      INSERT INTO personas VALUES ('persona','preset',1,'2026-09-15','2026-09-15');
      INSERT INTO activity_episodes (id,actor,title,summary,started_at,ended_at,source_types_json,app_names_json,domains_json,screenshot_storage_keys_json,event_count,created_at,updated_at)
        VALUES ('episode','user','window','observed text','2026-09-15','2026-09-15','["active_app"]','["Fixture"]','[]','[]',1,'2026-09-15','2026-09-15');
      INSERT INTO activity_events (id,actor,source,details_json,started_at,ended_at,episode_id,created_at)
        VALUES ('event','user','active_app','{"text":"kept"}','2026-09-15','2026-09-15','episode','2026-09-15');
      INSERT INTO cognition_evidence (receipt_sequence,id,persona_id,source_kind,source_id,actor,kind,observed_at,received_at,payload_json)
        VALUES (9,'evidence','persona','activity','event','user','observation','2026-09-15','2026-09-15','{}');
    `);
    database.close();
    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT actor,episode_id,details_json FROM activity_events WHERE id='event'",
        )
        .get(),
    ).toEqual({
      actor: "user",
      episode_id: "episode",
      details_json: '{"text":"kept"}',
    });
    expect(
      database
        .prepare("SELECT title,actor FROM activity_episodes WHERE id='episode'")
        .get(),
    ).toEqual({ title: "window", actor: "user" });
    expect(
      database
        .prepare(
          "SELECT receipt_sequence,source_id FROM cognition_evidence WHERE id='evidence'",
        )
        .get(),
    ).toEqual({ receipt_sequence: 9, source_id: "event" });
    database.exec(`UPDATE activity_events SET actor='unknown'; UPDATE activity_episodes SET actor='unknown';
      INSERT INTO cognition_evidence (id,persona_id,source_kind,source_id,actor,kind,observed_at,received_at,payload_json)
      VALUES ('next','persona','activity','next-event','unknown','observation','2026-09-16','2026-09-16','{}');`);
    expect(
      database
        .prepare(
          "SELECT receipt_sequence FROM cognition_evidence WHERE id='next'",
        )
        .get(),
    ).toEqual({ receipt_sequence: 10 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
    database = openApplicationDatabase(databasePath);
    expect(
      database
        .prepare("SELECT actor FROM activity_events WHERE id='event'")
        .get(),
    ).toEqual({ actor: "unknown" });
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    database.close();
  });

  it.each([
    { name: "the highest receipt was deleted", keepEarlier: true },
    { name: "all prior receipts were deleted", keepEarlier: false },
  ])(
    "preserves the receipt high-water mark through deletion and reopen when $name",
    async ({ keepEarlier }) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "chara-mate-receipt-highwater-"),
      );
      temporaryDirectories.push(directory);
      const databasePath = path.join(directory, "charamate.sqlite");
      let database = openApplicationDatabase(databasePath);
      try {
        database.exec(`
          INSERT INTO personas VALUES ('persona','preset',1,'2026-09-15','2026-09-15');
          INSERT INTO cognition_evidence
            (receipt_sequence,id,persona_id,source_kind,source_id,actor,kind,observed_at,received_at,payload_json)
          VALUES
            (9,'earlier','persona','activity','earlier-event','user','observation','2026-09-15','2026-09-15','{"kept":true}'),
            (40,'latest','persona','activity','latest-event','user','observation','2026-09-15','2026-09-15','{}');
          INSERT INTO cognition_state
            (persona_id,revision,user_generation,focus_revision,last_receipt_sequence,analyzed_through_sequence,payload_json,updated_at)
          VALUES ('persona',0,0,0,40,40,'{}','2026-09-15');
        `);
        database
          .prepare("DELETE FROM cognition_evidence WHERE id='latest' OR ?=0")
          .run(Number(keepEarlier));
        const retained = database
          .prepare("SELECT * FROM cognition_evidence ORDER BY receipt_sequence")
          .all();
        expect(retained).toHaveLength(keepEarlier ? 1 : 0);
        expect(
          database
            .prepare(
              "SELECT seq FROM sqlite_sequence WHERE name='cognition_evidence'",
            )
            .get(),
        ).toEqual({ seq: 40 });
        database.close();

        database = openApplicationDatabase(databasePath);
        expect(
          database
            .prepare(
              "SELECT * FROM cognition_evidence ORDER BY receipt_sequence",
            )
            .all(),
        ).toEqual(retained);
        expect(
          database
            .prepare(
              "SELECT seq FROM sqlite_sequence WHERE name='cognition_evidence'",
            )
            .get(),
        ).toEqual({ seq: 40 });
        database.exec(`
          INSERT INTO cognition_evidence
            (id,persona_id,source_kind,source_id,actor,kind,observed_at,received_at,payload_json)
          VALUES ('next','persona','activity','next-event','unknown','observation','2026-09-16','2026-09-16','{}');
        `);
        expect(
          database
            .prepare(
              "SELECT receipt_sequence FROM cognition_evidence WHERE id='next'",
            )
            .get(),
        ).toEqual({ receipt_sequence: 41 });
        expect(
          database
            .prepare(
              `SELECT id FROM cognition_evidence
              WHERE receipt_sequence > (SELECT analyzed_through_sequence FROM cognition_state WHERE persona_id='persona')
              ORDER BY receipt_sequence`,
            )
            .all(),
        ).toEqual([{ id: "next" }]);
        expect(database.pragma("foreign_key_check")).toEqual([]);
        database.close();

        database = openApplicationDatabase(databasePath);
        database.exec(`
          INSERT INTO cognition_evidence
            (id,persona_id,source_kind,source_id,actor,kind,observed_at,received_at,payload_json)
          VALUES ('after-reopen','persona','activity','reopen-event','unknown','observation','2026-09-16','2026-09-16','{}');
        `);
        expect(
          database
            .prepare(
              "SELECT id,receipt_sequence FROM cognition_evidence WHERE receipt_sequence>40 ORDER BY receipt_sequence",
            )
            .all(),
        ).toEqual([
          { id: "next", receipt_sequence: 41 },
          { id: "after-reopen", receipt_sequence: 42 },
        ]);
        expect(
          database
            .prepare(
              "SELECT last_receipt_sequence,analyzed_through_sequence FROM cognition_state WHERE persona_id='persona'",
            )
            .get(),
        ).toEqual({ last_receipt_sequence: 40, analyzed_through_sequence: 40 });
        expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(database.pragma("foreign_key_check")).toEqual([]);
      } finally {
        if (database.open) database.close();
      }
    },
  );

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
           persona_json, trigger_json, status, requested_at, created_at,
           updated_at
         ) VALUES (
           'automation-run-1', 'automation-1', 1, ?, ?, ?, 'queued', ?, ?, ?
         )`,
      )
      .run(
        definitionV1,
        PERSONA_JSON,
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
             persona_json, trigger_json, status, requested_at, created_at,
             updated_at
           ) VALUES (
             'automation-run-duplicate', 'automation-1', 2, ?, ?, ?,
             'queued', ?, ?, ?
           )`,
        )
        .run(
          definitionV2,
          PERSONA_JSON,
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
             persona_json, trigger_json, status, requested_at, created_at,
             updated_at
           ) VALUES (
             'automation-run-invalid-trigger', 'automation-1', 2, ?, ?, ?,
             'queued', ?, ?, ?
           )`,
        )
        .run(
          definitionV2,
          PERSONA_JSON,
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
             persona_json, trigger_json, status, requested_at, started_at,
             ended_at, created_at, updated_at
           ) VALUES (
             'automation-run-invalid-error', 'automation-1', 2, ?, ?, ?,
             'failed', ?, ?, ?, ?, ?
           )`,
        )
        .run(
          definitionV2,
          PERSONA_JSON,
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
