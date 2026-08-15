import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { ProductMetrics } from "../../src/main/observability/productMetrics";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-14T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Dev Dashboard product metrics", () => {
  it("queries Memory, Storage and Image aggregates without reading content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "charamate-metrics-"));
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    const insertMemory = database.transaction(() => {
      database
        .prepare(
          `INSERT INTO memories (
             id, type, status, current_revision_id, importance, confidence,
             created_at, updated_at
           ) VALUES (?, 'project', 'active', ?, 0.8, 0.9, ?, ?)`,
        )
        .run("memory-1", "revision-1", NOW, NOW);
      database
        .prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, content, source_type, reason, created_at
           ) VALUES (?, ?, ?, 'user_edit', ?, ?)`,
        )
        .run("revision-1", "memory-1", "private content", "created", NOW);
    });
    insertMemory();
    database
      .prepare(
        `INSERT INTO memory_usage (
           id, memory_id, revision_id, consumer, used_at
         ) VALUES ('usage-1', 'memory-1', 'revision-1', 'context', ?)`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO memory_candidates (
           id, type, status, content, reason, source_ids_json,
           source_labels_json, source_type, confidence, importance, novelty,
           created_at, updated_at
         ) VALUES (
           'candidate-1', 'preference', 'pending', 'candidate content',
           'observed', '[]', '[]', 'chat', 0.7, 0.6, 0.5, ?, ?
         )`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `INSERT INTO territory_world_assets (
           asset_id, media_type, origin, width, height, byte_length, sha256,
           storage_key, created_at
         ) VALUES (?, 'image/png', ?, 64, 64, ?, ?, ?, ?)`,
      )
      .run("asset-1", "generated", 2048, "a".repeat(64), "generated.png", NOW);
    database
      .prepare(
        `INSERT INTO activity_assets (
           id, storage_key, media_type, width, height, byte_length, sha256,
           created_at
         ) VALUES (
           'activity-1', 'capture.png', 'image/png', 64, 64, 1024, ?, ?
         )`,
      )
      .run("b".repeat(64), NOW);

    const snapshot = new ProductMetrics(database).snapshot();

    expect(snapshot.memory).toEqual({
      active: 1,
      pendingCandidates: 1,
      revisions: 1,
      usages: 1,
    });
    expect(snapshot.storage).toMatchObject({
      activityAssetBytes: 1024,
      territoryAssetBytes: 2048,
    });
    expect(snapshot.storage.sqliteAllocatedBytes).toBeGreaterThan(0);
    expect(snapshot.image.assets.generated).toBe(1);
    expect(snapshot.image.assetBytes.generated).toBe(2048);
    expect(JSON.stringify(snapshot)).not.toContain("private content");
    database.close();
  });
});
