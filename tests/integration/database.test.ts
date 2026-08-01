import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { verifyDatabaseRoundTrip } from "../../src/main/db/database";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("foundation database", () => {
  it("commits a prepared transaction and reads it after close and reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-database-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");

    expect(verifyDatabaseRoundTrip(databasePath)).toBe(true);

    const database = new Database(databasePath, { readonly: true });
    const metadataCount = database
      .prepare("SELECT COUNT(*) AS count FROM app_metadata")
      .get() as { count: number };
    const foreignKeys = database.pragma("foreign_keys", { simple: true });
    database.close();

    expect(metadataCount.count).toBe(0);
    expect(foreignKeys).toBe(1);
  });
});
