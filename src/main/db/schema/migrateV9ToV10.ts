import type Database from "better-sqlite3";

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS territory_item_candidates (
    candidate_id TEXT PRIMARY KEY NOT NULL,
    primary_source_kind TEXT NOT NULL CHECK (
      primary_source_kind IN ('memory', 'activity_digest')
    ),
    primary_source_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    visual_prompt TEXT NOT NULL CHECK (length(trim(visual_prompt)) > 0),
    suggested_scene_id TEXT NOT NULL CHECK (
      suggested_scene_id IN (
        'forest-cabin',
        'seaside-room',
        'city-rooftop',
        'star-workshop'
      )
    ),
    sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'materialized')),
    accepted_item_id TEXT REFERENCES territory_items(item_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (primary_source_kind, primary_source_id),
    CHECK (
      (status = 'pending' AND accepted_item_id IS NULL) OR
      (status = 'materialized' AND accepted_item_id IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS territory_item_sources (
    item_id TEXT NOT NULL
      REFERENCES territory_items(item_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (
      source_kind IN ('memory', 'activity_digest')
    ),
    source_id TEXT NOT NULL,
    revision_id TEXT,
    label TEXT NOT NULL CHECK (length(trim(label)) > 0),
    occurred_at TEXT NOT NULL,
    candidate_id TEXT REFERENCES territory_item_candidates(candidate_id),
    PRIMARY KEY (item_id, source_kind, source_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS territory_placements_scene_age_idx
    ON territory_placements(location, scene_id, pinned, placed_at, item_id);
`;

export function migrateV9ToV10(database: Database.Database): void {
  database.transaction(() => {
    database.exec(MIGRATION_SQL);
    const columns = database.pragma(
      "table_info(territory_image_candidates)",
    ) as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "item_candidate_id")) {
      database.exec(`
        ALTER TABLE territory_image_candidates
          ADD COLUMN item_candidate_id TEXT
            REFERENCES territory_item_candidates(candidate_id)
      `);
    }
    database
      .prepare(
        "UPDATE app_metadata SET value = '10' WHERE key = 'schema_version'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
