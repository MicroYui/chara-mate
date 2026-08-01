import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { verifyDatabaseRoundTrip } from "../../src/main/db/database";
import { serializeForPersistence } from "../../src/main/db/persistenceBoundary";
import { CURRENT_SCHEMA_VERSION } from "../../src/main/db/schema/current";

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
    const metadata = database
      .prepare("SELECT key, value FROM app_metadata ORDER BY key")
      .all() as { key: string; value: string }[];
    const foreignKeys = database.pragma("foreign_keys", { simple: true });
    database.close();

    expect(metadata).toEqual([
      { key: "schema_version", value: CURRENT_SCHEMA_VERSION },
    ]);
    expect(foreignKeys).toBe(1);
  });

  it("redacts credentials before a JSON payload reaches SQLite", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-redaction-database-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE payloads (payload TEXT NOT NULL) STRICT");
    const secret = "sk-1234567890abcdef";
    database
      .prepare("INSERT INTO payloads (payload) VALUES (?)")
      .run(serializeForPersistence({ apiKey: secret, result: "safe" }));
    database.close();

    const reopened = new Database(databasePath, { readonly: true });
    const row = reopened.prepare("SELECT payload FROM payloads").get() as {
      payload: string;
    };
    reopened.close();

    expect(row.payload).toContain("[REDACTED]");
    expect(row.payload).not.toContain(secret);
    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      false,
    );
  });
});
