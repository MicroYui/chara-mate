import type Database from "better-sqlite3";

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS territory_image_candidates (
    candidate_id TEXT PRIMARY KEY NOT NULL,
    provider_profile_id TEXT NOT NULL,
    scene_id TEXT NOT NULL CHECK (
      scene_id IN (
        'forest-cabin',
        'seaside-room',
        'city-rooftop',
        'star-workshop'
      )
    ),
    operation TEXT NOT NULL CHECK (operation IN ('generate', 'edit')),
    source_candidate_id TEXT REFERENCES territory_image_candidates(candidate_id),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    status TEXT NOT NULL CHECK (
      status IN ('generating', 'ready', 'failed', 'accepted')
    ),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    accepted_item_id TEXT REFERENCES territory_items(item_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (operation = 'generate' AND source_candidate_id IS NULL) OR
      (operation = 'edit' AND source_candidate_id IS NOT NULL)
    ),
    CHECK (
      (
        status IN ('generating', 'ready') AND
        error_json IS NULL AND accepted_item_id IS NULL
      ) OR (
        status = 'failed' AND
        error_json IS NOT NULL AND accepted_item_id IS NULL
      ) OR (
        status = 'accepted' AND
        error_json IS NULL AND accepted_item_id IS NOT NULL
      )
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS territory_image_candidates_created_idx
    ON territory_image_candidates(created_at DESC, candidate_id DESC);
`;

export function migrateV6ToV7(database: Database.Database): void {
  database.transaction(() => {
    database.exec(MIGRATION_SQL);
    database
      .prepare(
        "UPDATE app_metadata SET value = '7' WHERE key = 'schema_version'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
