import type Database from "better-sqlite3";

const EVOLUTION_SQL = `
  CREATE TABLE IF NOT EXISTS evolution_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN ('queued', 'running', 'completed', 'skipped', 'failed')
    ),
    triggers_json TEXT NOT NULL CHECK (json_valid(triggers_json)),
    tool_signature TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS evolution_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    review_id TEXT NOT NULL
      REFERENCES evolution_reviews(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (
      kind IN ('memory', 'persona_preference', 'skill_patch', 'new_skill')
    ),
    status TEXT NOT NULL CHECK (
      status IN ('draft', 'accepted', 'active', 'rejected', 'stale', 'archived')
    ),
    proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
    rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    replay_cases_json TEXT NOT NULL CHECK (json_valid(replay_cases_json)),
    replay_status TEXT NOT NULL CHECK (
      replay_status IN ('not_required', 'pending', 'running', 'passed', 'failed')
    ),
    replay_failure_reason TEXT,
    replay_completed_at TEXT,
    source_run_ids_json TEXT NOT NULL CHECK (json_valid(source_run_ids_json)),
    source_item_ids_json TEXT NOT NULL CHECK (json_valid(source_item_ids_json)),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    activated_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    activated_skill_id TEXT,
    activated_skill_revision INTEGER CHECK (
      activated_skill_revision IS NULL OR activated_skill_revision >= 1
    ),
    activated_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (review_id, kind, proposal_json)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS evolution_reviews_state_idx
    ON evolution_reviews(status, created_at, id);
  CREATE INDEX IF NOT EXISTS evolution_reviews_signature_idx
    ON evolution_reviews(tool_signature, status, created_at, id);
  CREATE INDEX IF NOT EXISTS evolution_candidates_chat_idx
    ON evolution_candidates(chat_id, status, created_at DESC, id);
`;

const SKILL_COLUMNS = [
  ["content", "TEXT"],
  [
    "lifecycle",
    "TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'stale', 'archived'))",
  ],
  ["pinned", "INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))"],
  ["use_count", "INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)"],
  ["success_count", "INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0)"],
  ["last_success_at", "TEXT"],
  ["patch_count", "INTEGER NOT NULL DEFAULT 0 CHECK (patch_count >= 0)"],
  [
    "source_candidate_id",
    "TEXT REFERENCES evolution_candidates(id) ON DELETE SET NULL",
  ],
] as const;

export function migrateV10ToV11(database: Database.Database): void {
  database.transaction(() => {
    database.exec(EVOLUTION_SQL);
    const columns = new Set(
      (
        database.pragma("table_info(skill_versions)") as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    for (const [name, declaration] of SKILL_COLUMNS) {
      if (!columns.has(name)) {
        database.exec(
          `ALTER TABLE skill_versions ADD COLUMN ${name} ${declaration}`,
        );
      }
    }
    database.exec(`
      UPDATE skill_versions
      SET lifecycle = 'stale'
      WHERE archived_at IS NULL
        AND revision < (
          SELECT MAX(newer.revision)
          FROM skill_versions AS newer
          WHERE newer.skill_id = skill_versions.skill_id
        );
      UPDATE skill_versions
      SET lifecycle = 'archived'
      WHERE archived_at IS NOT NULL;
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '11' WHERE key = 'schema_version'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
