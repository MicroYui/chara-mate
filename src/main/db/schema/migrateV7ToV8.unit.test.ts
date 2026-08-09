import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrateV7ToV8 } from "./migrateV7ToV8";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("v7 to v8 database migration", () => {
  it("classifies existing Runs as text without rewriting their data", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata (key, value) VALUES ('schema_version', '7');
      CREATE TABLE runs (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      INSERT INTO runs (id, payload) VALUES ('run-existing', 'preserved');
    `);

    migrateV7ToV8(database);

    expect(
      database
        .prepare("SELECT source, payload FROM runs WHERE id = ?")
        .get("run-existing"),
    ).toEqual({ payload: "preserved", source: "text" });
    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "8" });
  });
});
