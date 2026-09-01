import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_SQL, METADATA_SCHEMA_SQL } from "./current";
import { migrateV23ToV24 } from "./migrateV23ToV24";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("migrateV23ToV24", () => {
  it("preserves Territory sources and adds durable chat-moment idempotency", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(METADATA_SCHEMA_SQL);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "23");
    database.exec(`
      CREATE TABLE territory_world_revisions (
        revision_id TEXT PRIMARY KEY NOT NULL
      ) STRICT;

      CREATE TABLE territory_change_candidates (
        candidate_id TEXT PRIMARY KEY NOT NULL,
        base_revision_id TEXT NOT NULL
          REFERENCES territory_world_revisions(revision_id),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        edit_request_json TEXT CHECK (
          edit_request_json IS NULL OR json_valid(edit_request_json)
        ),
        status TEXT NOT NULL CHECK (
          status IN (
            'draft', 'generating', 'ready', 'failed', 'stale', 'cancelled',
            'applied'
          )
        ),
        change_set_json TEXT CHECK (
          change_set_json IS NULL OR json_valid(change_set_json)
        ),
        preview_groups_json TEXT NOT NULL CHECK (json_valid(preview_groups_json)),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        applied_revision_id TEXT REFERENCES territory_world_revisions(revision_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE territory_instance_sources (
        source_kind TEXT NOT NULL CHECK (
          source_kind IN ('memory', 'activity_digest')
        ),
        source_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        PRIMARY KEY (source_kind, source_id),
        UNIQUE (instance_id, source_kind, source_id)
      ) STRICT;

      CREATE TABLE companion_initiative_settings (
        settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'companion'),
        level TEXT NOT NULL CHECK (
          level IN ('off', 'quiet', 'balanced', 'lively')
        ),
        quiet_hours_enabled INTEGER NOT NULL CHECK (
          quiet_hours_enabled IN (0, 1)
        ),
        quiet_hours_start_minute INTEGER NOT NULL,
        quiet_hours_end_minute INTEGER NOT NULL,
        important_moment_outreach_enabled INTEGER NOT NULL DEFAULT 0 CHECK (
          important_moment_outreach_enabled IN (0, 1)
        ),
        important_moment_outreach_prompted INTEGER NOT NULL DEFAULT 0 CHECK (
          important_moment_outreach_prompted IN (0, 1)
        ),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO territory_world_revisions VALUES ('revision-v23');
      INSERT INTO territory_instance_sources VALUES (
        'memory', 'memory-v23', 'instance-memory', '{"kind":"memory"}'
      );
      INSERT INTO territory_instance_sources VALUES (
        'activity_digest', 'digest-v23', 'instance-activity',
        '{"kind":"activity_digest"}'
      );
      INSERT INTO companion_initiative_settings (
        settings_id, level, quiet_hours_enabled, quiet_hours_start_minute,
        quiet_hours_end_minute, updated_at
      ) VALUES ('companion', 'balanced', 1, 1320, 480, '2026-09-01T00:00:00.000Z');
    `);

    migrateV23ToV24(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "24" });
    expect(
      database
        .prepare(
          `SELECT source_kind, source_id, instance_id
             FROM territory_instance_sources
            ORDER BY source_kind`,
        )
        .all(),
    ).toEqual([
      {
        instance_id: "instance-activity",
        source_id: "digest-v23",
        source_kind: "activity_digest",
      },
      {
        instance_id: "instance-memory",
        source_id: "memory-v23",
        source_kind: "memory",
      },
    ]);

    const momentKey = "a".repeat(64);
    database
      .prepare(
        `INSERT INTO territory_instance_sources (
           source_kind, source_id, instance_id, snapshot_json
         ) VALUES ('chat_moment', ?, 'instance-moment', '{"kind":"chat_moment"}')`,
      )
      .run(momentKey);
    const insertCandidate = database.prepare(
      `INSERT INTO territory_change_candidates (
         candidate_id, moment_key, base_revision_id, request_json, status,
         preview_groups_json, created_at, updated_at
       ) VALUES (?, ?, 'revision-v23', '{}', 'draft', '[]', ?, ?)`,
    );
    insertCandidate.run(
      "candidate-one",
      momentKey,
      "2026-09-01T00:01:00.000Z",
      "2026-09-01T00:01:00.000Z",
    );
    expect(() =>
      insertCandidate.run(
        "candidate-two",
        momentKey,
        "2026-09-01T00:02:00.000Z",
        "2026-09-01T00:02:00.000Z",
      ),
    ).toThrow();
    expect(
      database
        .prepare(
          `SELECT territory_moment_surprises_enabled,
                  territory_moment_surprises_prompted
             FROM companion_initiative_settings`,
        )
        .get(),
    ).toEqual({
      territory_moment_surprises_enabled: 0,
      territory_moment_surprises_prompted: 0,
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts an already-current table shape when metadata alone is rewound", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(METADATA_SCHEMA_SQL);
    database.exec(CURRENT_SCHEMA_SQL);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "23");

    migrateV23ToV24(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "24" });
  });
});
