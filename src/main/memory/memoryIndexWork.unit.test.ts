import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../db/database";
import { MemoryRepository } from "./memoryRepository";
import { memoryContentHash } from "./memoryRecallRepository";

const cleanups: Array<() => void> = [];
const now = "2026-09-15T12:00:00.000Z";
const modelKey = "index-work-fixture";
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memory-index-work-"));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(database);
  const create = (content = "我想下次继续讨论这件事。") =>
    repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      type: "event",
      content,
      confidence: 1,
      importance: 0.5,
      reason: "fixture",
      now,
      sources: [],
    });
  return { database, repository, create };
}

describe("pending Memory index work", () => {
  it("reads lazily in original work order with only the requested model and undeleted memories", async () => {
    const f = fixture();
    const pending = f.repository.recall.indexWork(modelKey);
    const records = [f.create(), f.create(), f.create()];
    await f.repository.recall.scheduleIndex(modelKey, now);
    await f.repository.recall.scheduleIndex("another-model", now);
    f.repository.softDelete(records[0]!.memory.id, now);
    const expected = f.database
      .prepare(
        `SELECT w.id,w.subject_id,w.source_version,r.content FROM memory_work w
         JOIN memory_revisions r ON r.id=w.subject_id JOIN memories m ON m.id=r.memory_id
         WHERE w.kind='embed' AND w.processor_version=? AND w.status='pending' AND m.deleted_at IS NULL
         ORDER BY w.updated_at,w.id`,
      )
      .all(modelKey);
    expect([...pending]).toEqual(expected);
    expect(expected).toHaveLength(2);
  });

  it("closes each read before completion and rechecks eligibility after the encoder awaits", async () => {
    const f = fixture();
    f.create("第一条。");
    f.create("第二条。");
    f.create("第三条。");
    await f.repository.recall.scheduleIndex(modelKey, now);
    const all = [...f.repository.recall.indexWork(modelKey)];
    const pending = f.repository.recall.indexWork(modelKey)[Symbol.iterator]();
    const first = pending.next().value as (typeof all)[number];
    expect(f.repository.recall.startWork(first.id, now)).toBe(true);
    await Promise.resolve();
    expect(
      f.repository.recall.finishIndex(
        first,
        [first.content],
        [new Float32Array([1, 0])],
        modelKey,
        2,
        now,
      ),
    ).toBe(true);
    const deleted = all[1]!;
    const { memory_id: memoryId } = f.database
      .prepare("SELECT memory_id FROM memory_revisions WHERE id=?")
      .get(deleted.subject_id) as { memory_id: string };
    f.repository.softDelete(memoryId, now);
    expect(
      [...{ [Symbol.iterator]: () => pending }].map(({ id }) => id),
    ).toEqual([all[2]!.id]);
    expect(
      [...f.repository.recall.indexWork(modelKey)].map(({ id }) => id),
    ).toEqual([all[2]!.id]);
  });

  it("retains failed work without implicitly retrying and recovers interrupted work", async () => {
    const f = fixture();
    f.create();
    f.create();
    await f.repository.recall.scheduleIndex(modelKey, now);
    const [failed, interrupted] = [...f.repository.recall.indexWork(modelKey)];
    f.repository.recall.failWork(failed!.id, "embedding_failed", now);
    f.repository.recall.startWork(interrupted!.id, now);
    await f.repository.recall.scheduleIndex(modelKey, now);
    expect([...f.repository.recall.indexWork(modelKey)]).toEqual([]);
    f.repository.recall.recoverWork(now);
    expect(
      [...f.repository.recall.indexWork(modelKey)].map(({ id }) => id),
    ).toEqual([interrupted!.id]);
    f.repository.recall.retryFailedIndex(modelKey, now);
    expect([...f.repository.recall.indexWork(modelKey)]).toHaveLength(2);
  });

  it("reschedules missing vectors but leaves complete vectors and deleted revisions out", async () => {
    const f = fixture();
    const indexed = f.create("已有完整向量。");
    const removed = f.create("已经删除。");
    await f.repository.recall.scheduleIndex(modelKey, now);
    const work = [...f.repository.recall.indexWork(modelKey)].find(
      ({ subject_id }) => subject_id === indexed.memory.currentRevisionId,
    )!;
    f.repository.recall.startWork(work.id, now);
    f.repository.recall.finishIndex(
      work,
      [work.content],
      [new Float32Array([1, 0])],
      modelKey,
      2,
      now,
    );
    f.repository.softDelete(removed.memory.id, now);
    await f.repository.recall.scheduleIndex(modelKey, now);
    expect([...f.repository.recall.indexWork(modelKey)]).toEqual([]);
    f.database
      .prepare("DELETE FROM memory_chunk_embeddings WHERE model_key=?")
      .run(modelKey);
    await f.repository.recall.scheduleIndex(modelKey, now);
    expect(
      [...f.repository.recall.indexWork(modelKey)].map(
        ({ subject_id }) => subject_id,
      ),
    ).toEqual([indexed.memory.currentRevisionId]);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_work WHERE processor_version='pending-model'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});

describe("cooperative Memory index scheduling", () => {
  it("uses revision range order without a repeated temporary sort", async () => {
    const f = fixture();
    f.create();
    f.create();
    const prepare = vi.spyOn(f.database, "prepare");
    await f.repository.recall.scheduleIndex(modelKey, now);
    const next = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("SELECT r.id") && /r.id\s*>/.test(sql))!;
    expect(next).toBeDefined();
    const rows = f.database.prepare("EXPLAIN QUERY PLAN " + next).all({
      modelKey,
      lastId: "00000000-0000-4000-8000-000000000000",
    }) as Array<{ detail: string }>;
    expect(rows.some(({ detail }) => /SEARCH r .*id>/.test(detail))).toBe(true);
    expect(rows.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(
      false,
    );
  });

  it("commits a cancellable prefix without holding a transaction while awaiting", async () => {
    const f = fixture();
    for (let index = 0; index < 3; index++) f.create(`经历 ${index}`);
    const controller = new AbortController();
    const operation = f.repository.recall.scheduleIndex(
      modelKey,
      now,
      controller.signal,
    );
    expect(f.database.inTransaction).toBe(false);
    const scheduled = () =>
      f.database
        .prepare(
          "SELECT subject_id,source_version FROM memory_work WHERE processor_version=?",
        )
        .all(modelKey) as Array<{ subject_id: string; source_version: string }>;
    expect(scheduled()).toHaveLength(1);
    controller.abort();
    await expect(operation).rejects.toThrow();
    expect(scheduled()).toHaveLength(1);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) count FROM memory_work WHERE processor_version='pending-model'",
        )
        .get(),
    ).toEqual({ count: 2 });
    await f.repository.recall.scheduleIndex(modelKey, now);
    const work = scheduled();
    expect(work).toHaveLength(3);
    for (const row of work) {
      const revision = f.database
        .prepare("SELECT content FROM memory_revisions WHERE id=?")
        .get(row.subject_id) as { content: string };
      expect(row.source_version).toBe(memoryContentHash(revision.content));
    }
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) count FROM memory_work WHERE processor_version='pending-model'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retains a concurrent revision behind the cursor and clears only real deleted placeholders", async () => {
    const f = fixture();
    const createAt = (revisionId: string) =>
      f.repository.create({
        memoryId: randomUUID(),
        revisionId,
        type: "event",
        content: revisionId,
        confidence: 1,
        importance: 0.5,
        reason: "fixture",
        now,
        sources: [],
      });
    const first = createAt("20000000-0000-4000-8000-000000000000");
    const deleted = createAt("30000000-0000-4000-8000-000000000000");
    const purged = createAt("40000000-0000-4000-8000-000000000000");
    f.repository.softDelete(purged.memory.id, now);
    f.repository.purge(purged.memory.id);
    const operation = f.repository.recall.scheduleIndex(modelKey, now);
    const behind = createAt("10000000-0000-4000-8000-000000000000");
    f.repository.softDelete(deleted.memory.id, now);
    await operation;
    expect(
      [...f.repository.recall.indexWork(modelKey)].map(
        ({ subject_id }) => subject_id,
      ),
    ).toEqual([first.memory.currentRevisionId]);
    expect(
      f.database
        .prepare(
          "SELECT subject_id FROM memory_work WHERE processor_version='pending-model'",
        )
        .all(),
    ).toEqual([{ subject_id: behind.memory.currentRevisionId }]);
    await f.repository.recall.scheduleIndex(modelKey, now);
    expect(
      [...f.repository.recall.indexWork(modelKey)]
        .map(({ subject_id }) => subject_id)
        .sort(),
    ).toEqual(
      [behind.memory.currentRevisionId, first.memory.currentRevisionId].sort(),
    );
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) count FROM memory_work WHERE processor_version='pending-model'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("skips already indexed revisions instead of transacting each one for an incremental change", async () => {
    const f = fixture();
    f.create();
    f.create();
    f.create();
    await f.repository.recall.scheduleIndex(modelKey, now);
    for (const work of f.repository.recall.indexWork(modelKey)) {
      f.repository.recall.startWork(work.id, now);
      expect(
        f.repository.recall.finishIndex(
          work,
          [work.content],
          [new Float32Array([1, 0])],
          modelKey,
          2,
          now,
        ),
      ).toBe(true);
    }
    const extra = f.create("唯一新增经历");
    const prepare = vi.spyOn(f.database, "prepare");
    await f.repository.recall.scheduleIndex(modelKey, now);
    const selects = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("SELECT r.id"));
    const parameters = { modelKey, lastId: extra.memory.currentRevisionId };
    expect(selects).toHaveLength(2);
    for (const sql of selects) {
      const statement = f.database.prepare(sql);
      // All work is now scheduled: neither query returns indexed revisions.
      expect(
        sql.includes("@lastId")
          ? statement.get(parameters)
          : statement.get({ modelKey }),
      ).toBeUndefined();
    }
    expect(
      [...f.repository.recall.indexWork(modelKey)].map(
        ({ subject_id }) => subject_id,
      ),
    ).toEqual([extra.memory.currentRevisionId]);
  });
});
