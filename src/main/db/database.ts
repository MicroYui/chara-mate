import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

interface MetadataRow {
  value: string;
}

function openDatabase(databasePath: string): Database.Database {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT
  `);
  return database;
}

export function verifyDatabaseRoundTrip(databasePath: string): true {
  const probeKey = `foundation-probe-${randomUUID()}`;
  const probeValue = randomUUID();
  let database = openDatabase(databasePath);

  const writeProbe = database.transaction(() => {
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run(probeKey, probeValue);
  });
  writeProbe();
  database.close();

  database = openDatabase(databasePath);
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
