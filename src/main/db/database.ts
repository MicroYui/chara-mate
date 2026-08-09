import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  CURRENT_SCHEMA_SQL,
  CURRENT_SCHEMA_VERSION,
  METADATA_SCHEMA_SQL,
} from "./schema/current";
import { migrateV4ToV5 } from "./schema/migrateV4ToV5";

interface MetadataRow {
  value: string;
}

function initializeCurrentSchema(database: Database.Database): void {
  database.exec(METADATA_SCHEMA_SQL);
  const schemaVersion = database
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get("schema_version") as MetadataRow | undefined;

  if (schemaVersion?.value === "4") {
    migrateV4ToV5(database);
  } else if (
    schemaVersion !== undefined &&
    schemaVersion.value !== CURRENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported database schema version: ${schemaVersion.value}`,
    );
  }

  const installSchema = database.transaction(() => {
    database.exec(CURRENT_SCHEMA_SQL);
    database
      .prepare(
        "INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('schema_version', ?)",
      )
      .run(CURRENT_SCHEMA_VERSION);
  });
  installSchema();
}

export function openApplicationDatabase(
  databasePath: string,
): Database.Database {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    initializeCurrentSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function verifyDatabaseRoundTrip(databasePath: string): true {
  const probeKey = `foundation-probe-${randomUUID()}`;
  const probeValue = randomUUID();
  let database = openApplicationDatabase(databasePath);

  const writeProbe = database.transaction(() => {
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run(probeKey, probeValue);
  });
  writeProbe();
  database.close();

  database = openApplicationDatabase(databasePath);
  const row = database
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get(probeKey) as MetadataRow | undefined;

  if (row?.value !== probeValue) {
    database.close();
    throw new Error("SQLite transaction did not survive close and reopen.");
  }

  database.prepare("DELETE FROM app_metadata WHERE key = ?").run(probeKey);
  database.close();
  return true;
}
