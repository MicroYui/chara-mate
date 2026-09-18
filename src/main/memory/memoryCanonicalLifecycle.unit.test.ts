import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../../../tests/fixtures/formationModel";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formationIntake,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import type { MemoryFormationSource } from "../../shared/contracts/memoryRecall";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { openApplicationDatabase } from "../db/database";
import { LexicalRetrievalPipeline } from "./lexicalRetrievalPipeline";

import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((done) => done());
});
const now = "2026-09-15T12:00:00.000Z";
function source(
  content = "这是确切的原始来源。",
  type: MemoryFormationSource["type"] = "chat",
): MemoryFormationSource {
  return {
    id: randomUUID(),
    referenceId: randomUUID(),
    type,
    speaker: "user",
    occurredAt: now,
    content,
  };
}
function episode(
  sources: MemoryFormationSource[],
  primary?: string[],
): FormationFixture {
  return {
    id: randomUUID(),
    version: "1",
    recordedAt: now,
    sources,
    ...(primary ? { evidenceSourceIds: primary } : {}),
  };
}
function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "memory-raw-lifecycle-"),
  );
  const dbPath = path.join(directory, "app.sqlite");
  let db = openApplicationDatabase(dbPath);
  const repository = new MemoryRepository(db);
  const clock = { now: () => now };
  const form = vi.fn<FormationModelMock["form"]>(() =>
    Promise.resolve({ entities: [], units: [] }),
  );
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(db, repository, clock),
    new CryptoIdGenerator(),
    clock,
    {
      embedding: {
        modelKey: "raw-lifecycle-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: () =>
          Promise.reject(new Error("No embedding is needed for raw lifecycle")),
        embedQuery: () =>
          Promise.reject(new Error("No embedding is needed for raw lifecycle")),
      },
      vectorSearch: {
        search: () =>
          Promise.reject(
            new Error("No vector search is needed for raw lifecycle"),
          ),
      },
      selector: {
        select: () =>
          Promise.reject(new Error("No selection is needed for raw lifecycle")),
      },
      formation: formationRuntime({
        version: "raw-lifecycle-fixture-v1",
        form,
      }),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 8000 }),
    },
  );
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    memory,
    repository,
    raw: repository.formation,
    form,
    complete: async (input: FormationFixture) => {
      const intake = formationIntake(input);
      const work = memory.enqueueEpisode(intake);
      const receipt = await memory.formEpisode(work.workId);
      return { work, receipt, intake };
    },
    reopen: () => {
      db.close();
      db = openApplicationDatabase(dbPath);
      return { db, raw: new MemoryRepository(db).formation };
    },
  };
}

describe("canonical raw text lifecycle", () => {
  it("hashes exact UTF-16LE bytes including NUL and unpaired surrogates, retaining identity across release", () => {
    const f = fixture();
    const original = source("前文\0😀\ud800".repeat(7000) + "尾\udfff");
    f.raw.registerSource(original);
    const row = f.db
      .prepare(
        "SELECT raw_digest,raw_present,raw_length FROM memory_sources WHERE id=?",
      )
      .get(original.id);
    expect(row).toEqual({
      raw_digest: createHash("sha256")
        .update(Buffer.from(original.content, "utf16le"))
        .digest("hex"),
      raw_present: 1,
      raw_length: original.content.length,
    });
    expect(
      f.raw.getFormationSource(original.type, original.referenceId),
    ).toEqual(original);
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(true);
    const identity = {
      id: original.id,
      type: original.type,
      referenceId: original.referenceId,
      speaker: original.speaker,
      occurredAt: original.occurredAt,
    };
    expect(f.memory.getFormationSourceMetadata(original.id)).toEqual(identity);
    expect(
      f.memory.getFormationSource(original.type, original.referenceId),
    ).toBeUndefined();
    expect(f.memory.canonicalStorageStats()).toEqual({
      presentSources: 0,
      releasedSources: 1,
      rawUtf16Bytes: 0,
      quoteUtf8Bytes: 0,
    });
    const before = f.db
      .prepare("SELECT * FROM memory_sources WHERE id=?")
      .get(original.id);
    expect(() =>
      f.raw.registerSource({
        ...original,
        content: original.content.replace("\ud800", "\ud801"),
      }),
    ).toThrow("different content");
    expect(
      f.db.prepare("SELECT * FROM memory_sources WHERE id=?").get(original.id),
    ).toEqual(before);
    f.raw.registerSource(original);
    expect(
      f.raw.getFormationSource(original.type, original.referenceId),
    ).toEqual(original);
    expect(f.memory.canonicalStorageStats().rawUtf16Bytes).toBe(
      original.content.length * 2,
    );
  });

  it("releases zero-change primary and pure context bodies but replays the exact completed input without resolving either", async () => {
    const f = fixture();
    const primary = source("今天聊了聊。"),
      context = source("一段过去的阅读材料。");
    const input = episode([context, primary], [primary.id]);
    const { work, intake, receipt } = await f.complete(input);
    expect(receipt.changes).toEqual([]);
    const before = f.raw.work(work.workId);
    const ids = [context.id, primary.id].sort();
    expect(f.memory.nextReclaimableSource()?.id).toBe(ids[0]);
    expect(f.memory.nextReclaimableSource(ids[0])?.id).toBe(ids[1]);
    expect(f.memory.releaseCanonicalSource(ids[0]!)).toBe(true);
    expect(f.memory.releaseCanonicalSource(ids[1]!)).toBe(true);
    const resolver = vi.fn(() => {
      throw new Error("Original owners no longer retain text");
    });
    const replay = f.memory.enqueueEpisode({
      ...intake,
      resolveSource: resolver,
    });
    expect(await f.memory.formEpisode(replay.workId)).toMatchObject({
      ...receipt,
      replayed: true,
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(f.form).toHaveBeenCalledTimes(1);
    expect(f.raw.work(work.workId)).toEqual(before);
    expect(f.memory.canonicalStorageStats()).toEqual({
      presentSources: 0,
      releasedSources: 2,
      rawUtf16Bytes: 0,
      quoteUtf8Bytes: 0,
    });
    expect(() => f.raw.sourceWindow(work.workId, primary.id, 0, 1)).toThrow(
      "text is unavailable",
    );
  });

  it("validates complete replay order and primary uses before any missing-body loader", async () => {
    const f = fixture(),
      a = source(),
      b = source("另一个来源");
    const { intake } = await f.complete(episode([a, b], [a.id]));
    f.memory.releaseCanonicalSource(a.id);
    f.memory.releaseCanonicalSource(b.id);
    const resolveSource = vi.fn(() => {
      throw Error("must not resolve");
    });
    for (const uses of [
      [],
      [
        { sourceId: b.id, primary: true },
        { sourceId: a.id, primary: false },
      ],
      [
        { sourceId: a.id, primary: false },
        { sourceId: b.id, primary: true },
      ],
      [{ sourceId: a.id, primary: true }],
    ]) {
      expect(() =>
        f.memory.enqueueEpisode({
          ...intake,
          resolveSource,
          sources: () => uses,
        }),
      ).toThrow();
    }
    expect(resolveSource).not.toHaveBeenCalled();
    expect(f.form).toHaveBeenCalledTimes(1);
  });

  it("restores real identical originals for a new work and keeps its source protected until completion", async () => {
    const f = fixture(),
      original = source("我仍希望保留这段经历。");
    const { intake } = await f.complete(episode([original]));
    f.memory.releaseCanonicalSource(original.id);
    const resolver = vi.fn(() => original);
    const next = f.memory.enqueueEpisode({
      ...intake,
      episode: { ...intake.episode, id: randomUUID() },
      resolveSource: resolver,
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(original.id);
    expect(
      f.memory.getFormationSource(original.type, original.referenceId),
    ).toEqual(original);
    expect(f.memory.nextReclaimableSource()).toBeUndefined();
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(false);
    await f.memory.formEpisode(next.workId);
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(true);
    expect(f.form).toHaveBeenCalledTimes(2);
  });

  it.each(["unavailable", "content", "speaker", "reference", "time"] as const)(
    "does not form from a %s replacement after raw release",
    async (kind) => {
      const f = fixture(),
        original = source("真实原文甲。");
      const { intake } = await f.complete(episode([original]));
      f.memory.releaseCanonicalSource(original.id);
      const value =
        kind === "unavailable"
          ? undefined
          : {
              ...original,
              ...(kind === "content" ? { content: "真实原文乙。" } : {}),
              ...(kind === "speaker" ? { speaker: "assistant" as const } : {}),
              ...(kind === "reference" ? { referenceId: randomUUID() } : {}),
              ...(kind === "time"
                ? { occurredAt: "2026-09-16T12:00:00.000Z" }
                : {}),
            };
      const oldCount = f.db.prepare("SELECT COUNT(*) n FROM memory_work").get();
      expect(() =>
        f.memory.enqueueEpisode({
          ...intake,
          episode: { ...intake.episode, id: randomUUID() },
          resolveSource: () => value,
        }),
      ).toThrow();
      expect(f.form).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT COUNT(*) n FROM memory_work").get()).toEqual(
        oldCount,
      );
      expect(
        f.memory.getFormationSource(original.type, original.referenceId),
      ).toBeUndefined();
      expect(f.memory.canonicalStorageStats().releasedSources).toBe(1);
    },
  );

  it("preserves exact source quotes, current evidence and history after releasing the larger original", async () => {
    const f = fixture(),
      original = source("背景信息。用户原话：我喜欢乌龙茶。更多背景信息。");
    await f.complete(episode([original]));
    const detail = f.repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content: "用户喜欢乌龙茶。",
      type: "preference",
      confidence: 1,
      importance: 0.5,
      reason: "Source-grounded fixture",
      now,
      sources: [f.raw.sourceProvenance(original.id)],
    });
    const revisionId = detail.memory.currentRevisionId;
    f.repository.recall.putSemantics(
      revisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    const quote = "我喜欢乌龙茶。",
      start = original.content.indexOf(quote);
    f.repository.recall.addSpan(
      revisionId,
      original.id,
      start,
      start + quote.length,
      quote,
    );
    const request = {
      personaId: randomUUID(),
      references: [
        { memoryId: detail.memory.id, revisionId, use: "current" as const },
      ],
      resourceBudget: { maxReadBytes: 3000 },
    };
    const before = f.memory.resolveEvidence(request);
    expect(before.status).toBe("resolved");
    if (before.status !== "resolved")
      throw new Error(`Unexpected ${before.status}`);
    const stats = f.memory.canonicalStorageStats();
    expect(stats.rawUtf16Bytes).toBe(original.content.length * 2);
    expect(stats.quoteUtf8Bytes).toBe(Buffer.byteLength(quote, "utf8"));
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(true);
    expect(f.memory.resolveEvidence(request)).toEqual(before);
    const history = f.memory.resolveEvidence({
      ...request,
      references: [{ ...request.references[0]!, use: "history" }],
    });
    expect(history.status).toBe("resolved");
    if (history.status !== "resolved")
      throw new Error(`Unexpected ${history.status}`);
    expect(history.items).toEqual(before.items);
    expect(f.memory.canonicalStorageStats()).toEqual({
      ...stats,
      presentSources: 0,
      releasedSources: 1,
      rawUtf16Bytes: 0,
    });
    expect(f.repository.requireDetail(detail.memory.id).sources).toEqual(
      detail.sources,
    );
  });

  it("keeps unfinished sources, except a failed work covered by one complete source-role superset", () => {
    const f = fixture(),
      a = source(),
      b = source("第二条");
    const first = f.raw.enqueue(formationIntake(episode([a, b])), "v10", now);
    expect(f.memory.releaseCanonicalSource(a.id)).toBe(false);
    const execution = f.raw.startWork(first.workId, "v10", undefined, now)!;
    expect(f.memory.nextReclaimableSource()).toBeUndefined();
    f.raw.fail(execution, "model_failed", now);
    const state = f.raw.work(first.workId);
    expect(f.memory.releaseCanonicalSource(a.id)).toBe(false);
    const contextOnly = f.raw.enqueue(
      formationIntake(episode([a, b], [b.id])),
      "v10",
      now,
    );
    f.raw.finish(
      f.raw.startWork(contextOnly.workId, "v10", undefined, now)!,
      { changes: [] },
      now,
    );
    expect(f.memory.releaseCanonicalSource(a.id)).toBe(false);
    const full = f.raw.enqueue(
      formationIntake(episode([a, b, source("第三条")])),
      "v10",
      now,
    );
    f.raw.finish(
      f.raw.startWork(full.workId, "v10", undefined, now)!,
      { changes: [] },
      now,
    );
    expect(f.memory.releaseCanonicalSource(a.id)).toBe(true);
    expect(f.memory.releaseCanonicalSource(b.id)).toBe(true);
    expect(f.raw.work(first.workId)).toEqual(state);
    f.memory.retryFailedFormationWork();
    expect(f.raw.work(first.workId)).toEqual(state);
  });

  it("rechecks work at release and rolls a release back with Main's surrounding transaction", async () => {
    const f = fixture(),
      original = source();
    const { intake } = await f.complete(episode([original]));
    expect(f.memory.nextReclaimableSource()?.id).toBe(original.id);
    const pending = f.memory.enqueueEpisode({
      ...intake,
      episode: { ...intake.episode, id: randomUUID() },
    });
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(false);
    await f.memory.formEpisode(pending.workId);
    expect(() =>
      f.raw.transaction(() => {
        expect(f.memory.releaseCanonicalSource(original.id)).toBe(true);
        throw new Error("consumer transaction rollback");
      }),
    ).toThrow("rollback");
    expect(
      f.memory.getFormationSource(original.type, original.referenceId),
    ).toEqual(original);
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(true);
    expect(f.memory.releaseCanonicalSource(original.id)).toBe(false);
  });

  it("rolls failed multi-chunk restoration back and reopens with its previous unavailable identity intact", async () => {
    const f = fixture(),
      original = source("😀中文\0".repeat(20000));
    const { intake } = await f.complete(episode([original]));
    f.memory.releaseCanonicalSource(original.id);
    const before = f.db
      .prepare("SELECT * FROM memory_sources WHERE id=?")
      .get(original.id);
    f.db.exec(
      "CREATE TEMP TRIGGER fail_raw_restore BEFORE INSERT ON memory_source_text_chunks WHEN NEW.start_utf16>0 BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
    );
    expect(() =>
      f.memory.enqueueEpisode({
        ...intake,
        episode: { ...intake.episode, id: randomUUID() },
      }),
    ).toThrow("fixture write failure");
    expect(
      f.db.prepare("SELECT * FROM memory_sources WHERE id=?").get(original.id),
    ).toEqual(before);
    expect(f.memory.canonicalStorageStats().rawUtf16Bytes).toBe(0);
    f.db.exec("DROP TRIGGER fail_raw_restore");
    const reopened = f.reopen();
    expect(reopened.raw.getSourceMetadata(original.id)).toBeDefined();
    expect(
      reopened.raw.getFormationSource(original.type, original.referenceId),
    ).toBeUndefined();
    reopened.raw.registerSource(original);
    expect(
      reopened.raw.getFormationSource(original.type, original.referenceId),
    ).toEqual(original);
  });

  it("does not call an unavailable or ambiguous Activity body a usable snapshot", () => {
    const f = fixture(),
      a = source("窗口显示文档。", "activity_event");
    f.raw.registerSource(a);
    expect(f.memory.snapshottedActivitySourceIds([a.referenceId])).toEqual(
      new Set([a.referenceId]),
    );
    f.memory.releaseCanonicalSource(a.id);
    expect(f.memory.snapshottedActivitySourceIds([a.referenceId]).size).toBe(0);
    const b = { ...a, id: randomUUID() };
    f.raw.registerSource(b);
    expect(f.memory.getFormationSource(a.type, a.referenceId)).toBeUndefined();
    expect(f.memory.snapshottedActivitySourceIds([a.referenceId]).size).toBe(0);
    expect(f.memory.getFormationSourceMetadata(a.id)).toBeDefined();
  });

  it("distinguishes never-registered metadata and reads reclamation candidates without raw chunks", () => {
    const f = fixture(),
      original = source();
    f.db
      .prepare(
        "INSERT INTO memory_sources(id,type,reference_id,created_at) VALUES(?,?,?,?)",
      )
      .run(
        original.id,
        original.type,
        original.referenceId,
        original.occurredAt,
      );
    expect(f.memory.getFormationSourceMetadata(original.id)).toBeUndefined();
    expect(f.memory.canonicalStorageStats()).toEqual({
      presentSources: 0,
      releasedSources: 0,
      rawUtf16Bytes: 0,
      quoteUtf8Bytes: 0,
    });
    f.raw.registerSource(original);
    const read = vi.spyOn(f.db, "prepare");
    expect(f.memory.nextReclaimableSource()).toMatchObject({
      id: original.id,
      length: original.content.length,
    });
    expect(
      read.mock.calls.some(([sql]) =>
        sql.includes("memory_source_text_chunks"),
      ),
    ).toBe(false);
    expect(f.memory.nextReclaimableSource(original.id)).toBeUndefined();
  });
});
