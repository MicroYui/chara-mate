import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateV16ToV17 } from "./migrateV16ToV17";

describe("migrateV16ToV17", () => {
  it("adds bounded proactive-conversation history storage", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_metadata VALUES ('schema_version', '16');
    `);

    migrateV16ToV17(database);

    expect(
      database
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "17" });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("companion_initiative_records"),
    ).toEqual({ name: "companion_initiative_records" });
    expect(database.pragma("foreign_key_check")).toEqual([]);

    database.close();
  });
});
