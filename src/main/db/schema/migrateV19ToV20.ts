import type Database from "better-sqlite3";

function hasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const columns = database.pragma(`table_info(${table})`) as {
    readonly name: string;
  }[];
  return columns.some(({ name }) => name === column);
}

export function migrateV19ToV20(database: Database.Database): void {
  database.transaction(() => {
    if (!hasColumn(database, "companion_initiative_records", "source_kind")) {
      database.exec(`
        ALTER TABLE companion_initiative_records
          ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'activity'
          CHECK (source_kind IN ('activity', 'memory_event'))
      `);
    }
    if (
      !hasColumn(
        database,
        "companion_initiative_settings",
        "important_moment_outreach_enabled",
      )
    ) {
      database.exec(`
        ALTER TABLE companion_initiative_settings
          ADD COLUMN important_moment_outreach_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (important_moment_outreach_enabled IN (0, 1))
      `);
    }
    if (
      !hasColumn(
        database,
        "companion_initiative_settings",
        "important_moment_outreach_prompted",
      )
    ) {
      database.exec(`
        ALTER TABLE companion_initiative_settings
          ADD COLUMN important_moment_outreach_prompted INTEGER NOT NULL DEFAULT 0
          CHECK (important_moment_outreach_prompted IN (0, 1))
      `);
    }
    if (!hasColumn(database, "memory_revisions", "occurs_at")) {
      database.exec("ALTER TABLE memory_revisions ADD COLUMN occurs_at TEXT");
    }
    if (!hasColumn(database, "memory_revisions", "time_zone")) {
      database.exec("ALTER TABLE memory_revisions ADD COLUMN time_zone TEXT");
    }
    if (!hasColumn(database, "memory_revisions", "important_moment")) {
      database.exec(`
        ALTER TABLE memory_revisions
          ADD COLUMN important_moment INTEGER NOT NULL DEFAULT 0
          CHECK (important_moment IN (0, 1))
      `);
    }
    if (!hasColumn(database, "memory_candidates", "occurs_at")) {
      database.exec("ALTER TABLE memory_candidates ADD COLUMN occurs_at TEXT");
    }
    if (!hasColumn(database, "memory_candidates", "time_zone")) {
      database.exec("ALTER TABLE memory_candidates ADD COLUMN time_zone TEXT");
    }
    if (!hasColumn(database, "memory_candidates", "important_moment")) {
      database.exec(`
        ALTER TABLE memory_candidates
          ADD COLUMN important_moment INTEGER NOT NULL DEFAULT 0
          CHECK (important_moment IN (0, 1))
      `);
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS proactive_opportunities (
        id TEXT PRIMARY KEY NOT NULL,
        source_memory_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL UNIQUE,
        target_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        evaluate_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'evaluating', 'resolved', 'cancelled')
        ),
        outcome TEXT CHECK (outcome IN ('silent', 'delivered', 'failed')),
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        claimed_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_revision_id, source_memory_id)
          REFERENCES memory_revisions(id, memory_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS proactive_opportunities_due_idx
        ON proactive_opportunities(state, evaluate_at, id);
      CREATE INDEX IF NOT EXISTS proactive_opportunities_memory_idx
        ON proactive_opportunities(source_memory_id, created_at DESC, id);
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '20' WHERE key = 'schema_version' AND value = '19'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
