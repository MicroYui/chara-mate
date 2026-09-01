import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateV18ToV19 } from "./migrateV18ToV19";

describe("migrateV18ToV19", () => {
  it("adds the single companion initiative settings table", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '18');
    `);

    migrateV18ToV19(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "19" });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companion_initiative_settings'",
        )
        .get(),
    ).toEqual({ name: "companion_initiative_settings" });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
