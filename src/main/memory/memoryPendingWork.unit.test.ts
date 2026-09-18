import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formationIntake,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import type { MemoryFormationWorkRef } from "../../shared/contracts/memoryRecall";
import { openApplicationDatabase } from "../db/database";
import { MemoryRepository } from "./memoryRepository";

const cleanups: Array<() => void> = [];
const now = "2026-09-15T12:00:00.000Z";
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memory-pending-"));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(database);
  const enqueue = (recordedAt = now) => {
    const episode: FormationFixture = {
      id: randomUUID(),
      version: "original-source",
      recordedAt,
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: "我下周想再聊这件事。",
          occurredAt: recordedAt,
        },
      ],
    };
    const work = repository.formation.enqueue(
      formationIntake(episode),
      "processor",
      recordedAt,
    );
    return { episode, workId: work.workId };
  };
  return { database, repository, enqueue };
}

describe("pending Memory formation work", () => {
  it("defers reading until iteration and preserves equal-time work order", () => {
    const f = fixture();
    const pending = f.repository.formation.pendingWork();
    const queued = [f.enqueue(), f.enqueue(), f.enqueue()];
    const expected = queued
      .sort((a, b) => a.workId.localeCompare(b.workId))
      .map(({ episode }) => episode.id);
    expect([...pending].map(({ episodeId }) => episodeId)).toEqual(expected);
  });

  it("finishes each read before formation changes rows and processes earlier arrivals on the next pass", async () => {
    const f = fixture();
    const queued = [f.enqueue(), f.enqueue(), f.enqueue()];
    const episodes = f.repository.formation.pendingWork();
    const pending = episodes[Symbol.iterator]();
    const first = pending.next().value as MemoryFormationWorkRef;
    const work = queued.find(({ episode }) => episode.id === first.episodeId)!;
    const execution = f.repository.formation.startWork(
      work.workId,
      "test",
      undefined,
      now,
    )!;
    expect(execution.attempt).toBe(1);
    await Promise.resolve();
    f.repository.formation.finish(execution, { changes: [] }, now);
    const earlier = f.enqueue("2026-09-15T11:59:00.000Z");
    const seen = [first.episodeId];
    for (let row = pending.next(); !row.done; row = pending.next()) {
      seen.push(row.value.episodeId);
      const current = queued.find(
        ({ episode }) => episode.id === row.value.episodeId,
      )!;
      const currentExecution = f.repository.formation.startWork(
        current.workId,
        "test",
        undefined,
        now,
      )!;
      f.repository.formation.finish(currentExecution, { changes: [] }, now);
    }
    expect(seen).toEqual(
      queued
        .sort((a, b) => a.workId.localeCompare(b.workId))
        .map(({ episode }) => episode.id),
    );
    expect(
      [...f.repository.formation.pendingWork()].map(
        ({ episodeId }) => episodeId,
      ),
    ).toEqual([earlier.episode.id]);
  });

  it("leaves unread and interrupted work available after cancellation and restart", () => {
    const f = fixture();
    const queued = [f.enqueue(), f.enqueue()];
    const episodes = f.repository.formation.pendingWork();
    const pending = episodes[Symbol.iterator]();
    const first = pending.next().value as MemoryFormationWorkRef;
    pending.return?.();
    const work = queued.find(({ episode }) => episode.id === first.episodeId)!;
    f.repository.formation.startWork(work.workId, "test", undefined, now);
    expect([...f.repository.formation.pendingWork()]).toHaveLength(1);
    f.repository.formation.recover(now);
    expect([...f.repository.formation.pendingWork()]).toHaveLength(2);
  });

  it("does not reread an unchanged pending key and requires explicit retry for failed work", () => {
    const f = fixture();
    const queued = [f.enqueue(), f.enqueue()];
    expect([...f.repository.formation.pendingWork()]).toHaveLength(2);
    f.repository.formation.failPending(
      queued[0]!.workId,
      "formation_failed",
      now,
    );
    expect(
      [...f.repository.formation.pendingWork()].map(
        ({ episodeId }) => episodeId,
      ),
    ).toEqual([queued[1]!.episode.id]);
    f.repository.formation.retryFailed(now);
    expect([...f.repository.formation.pendingWork()]).toHaveLength(2);
  });
});
