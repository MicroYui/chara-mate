import type Database from "better-sqlite3";

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS memory_claims (
    memory_id TEXT PRIMARY KEY NOT NULL
      REFERENCES memories(id) ON DELETE CASCADE,
    claim_slot TEXT NOT NULL UNIQUE CHECK (
      claim_slot IN (
        'profile.name',
        'profile.pronouns',
        'profile.home_location',
        'profile.timezone',
        'profile.occupation',
        'profile.languages',
        'profile.birth_date',
        'preference.hobbies',
        'preference.likes',
        'preference.dislikes',
        'preference.response_style',
        'preference.communication_style',
        'preference.food',
        'preference.music',
        'preference.media',
        'preference.travel',
        'preference.schedule',
        'preference.tools'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_candidate_formation (
    candidate_id TEXT PRIMARY KEY NOT NULL
      REFERENCES memory_candidates(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (
      operation IN ('create', 'replace', 'append', 'remove')
    ),
    claim_slot TEXT CHECK (
      claim_slot IS NULL OR claim_slot IN (
        'profile.name',
        'profile.pronouns',
        'profile.home_location',
        'profile.timezone',
        'profile.occupation',
        'profile.languages',
        'profile.birth_date',
        'preference.hobbies',
        'preference.likes',
        'preference.dislikes',
        'preference.response_style',
        'preference.communication_style',
        'preference.food',
        'preference.music',
        'preference.media',
        'preference.travel',
        'preference.schedule',
        'preference.tools'
      )
    )
  ) STRICT;
`;

export function migrateV5ToV6(database: Database.Database): void {
  database.transaction(() => {
    database.exec(MIGRATION_SQL);
    database
      .prepare(
        "UPDATE app_metadata SET value = '6' WHERE key = 'schema_version'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
