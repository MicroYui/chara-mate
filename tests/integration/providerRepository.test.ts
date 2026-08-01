import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { ProviderRepository } from "../../src/main/providers/providerRepository";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Provider Profile repository", () => {
  it("owns one strict table containing metadata and a secret reference only", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-provider-repository-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const database = openApplicationDatabase(databasePath);
    databases.push(database);
    const repository = new ProviderRepository(database);
    const secret = "sk-plaintext-must-not-enter-sqlite";
    const record = {
      apiKeyRef: "66666666-6666-4666-8666-666666666666",
      apiStyle: "azure-openai",
      apiVersion: "2025-04-01-preview",
      baseUrl: "https://example.openai.azure.com",
      chatModel: "deployment-a",
      createdAt: "2026-08-01T08:00:00.000Z",
      id: "77777777-7777-4777-8777-777777777777",
      name: "Azure",
      updatedAt: "2026-08-01T08:00:00.000Z",
    } as const;

    expect(repository.save(record)).toEqual(record);
    expect(repository.list()).toEqual([record]);
    expect(repository.listSecretReferences()).toEqual(
      new Set([record.apiKeyRef]),
    );

    const row = database
      .prepare(
        "SELECT api_style, api_version, api_key_ref FROM provider_profiles WHERE id = ?",
      )
      .get(record.id);
    expect(row).toEqual({
      api_key_ref: record.apiKeyRef,
      api_style: "azure-openai",
      api_version: "2025-04-01-preview",
    });
    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      false,
    );

    expect(repository.delete(record.id)).toEqual(record);
    expect(repository.get(record.id)).toBeUndefined();
  });

  it("enforces the Azure API Version invariant in SQLite itself", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-provider-check-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const database = openApplicationDatabase(databasePath);
    databases.push(database);
    new ProviderRepository(database);

    expect(() =>
      database
        .prepare(
          `INSERT INTO provider_profiles (
            id, name, api_style, base_url, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "77777777-7777-4777-8777-777777777777",
          "Invalid Azure",
          "azure-openai",
          "https://example.openai.azure.com",
          "2026-08-01T08:00:00.000Z",
          "2026-08-01T08:00:00.000Z",
        ),
    ).toThrow();
  });
});
