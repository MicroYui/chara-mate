import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formationIntake,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import type { MemoryFormationSource } from "../../shared/contracts/memoryRecall";
import { openApplicationDatabase } from "../db/database";
import { MemoryFormationRepository } from "./memoryFormationRepository";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((done) => done()));
const now = "2026-09-15T12:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canonical-memory-"));
  let db = openApplicationDatabase(path.join(dir, "app.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = new MemoryFormationRepository(db);
  return {
    db,
    repo,
    reopen: () => {
      db.close();
      db = openApplicationDatabase(path.join(dir, "app.sqlite"));
      return { db, repo: new MemoryFormationRepository(db) };
    },
  };
}
function source(content = "我准备学陶艺。"): MemoryFormationSource {
  return {
    id: randomUUID(),
    referenceId: randomUUID(),
    type: "chat",
    speaker: "user",
    content,
    occurredAt: now,
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

describe("canonical formation sources and reference work", () => {
  it("stores a canonical body once across jobs and reads exact bounded UTF-16 windows", () => {
    const f = fixture();
    const original = source("前文😀\ud800".repeat(12000) + "\udfff尾句");
    const input = episode([original]);
    const first = f.repo.enqueue(formationIntake(input), "v8", now);
    const second = f.repo.enqueue(
      formationIntake({ ...input, id: randomUUID() }),
      "v8",
      now,
    );
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) n, SUM(length(content)) bytes,MAX(length(content)) maximum FROM memory_source_text_chunks",
        )
        .get(),
    ).toMatchObject({ bytes: original.content.length * 2, maximum: 65536 });
    expect(f.db.prepare("SELECT COUNT(*) n FROM memory_sources").get()).toEqual(
      { n: 1 },
    );
    for (const [start, end] of [
      [0, 32],
      [32760, 32785],
      [original.content.length - 50, original.content.length],
    ])
      expect(f.repo.sourceWindow(first.workId, original.id, start!, end!)).toBe(
        original.content.slice(start, end),
      );
    expect(
      f.repo.getFormationSource(original.type, original.referenceId),
    ).toEqual(original);
    expect(f.repo.sourceWindow(second.workId, original.id, 32767, 32769)).toBe(
      original.content.slice(32767, 32769),
    );
    const row = f.db
      .prepare("SELECT payload_json FROM memory_work WHERE id=?")
      .get(first.workId) as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toEqual(
      formationIntake(input).episode,
    );
    expect(
      f.db.prepare("SELECT raw_json_bytes n FROM memory_sources").get(),
    ).toEqual({ n: Buffer.byteLength(JSON.stringify(original.content)) - 2 });
  });
  it("resolves only missing raw originals and enriches an existing metadata-only source", () => {
    const f = fixture();
    const raw = source();
    f.db
      .prepare(
        "INSERT INTO memory_sources(id,type,reference_id,label,created_at) VALUES(?,?,?,?,?)",
      )
      .run(raw.id, raw.type, raw.referenceId, "真实旧来源标签", now);
    expect(f.repo.getSourceMetadata(raw.id)).toBeUndefined();
    const input = formationIntake(episode([raw]));
    const resolve = vi.fn(input.resolveSource);
    const work = f.repo.enqueue(
      { ...input, resolveSource: resolve },
      "v8",
      now,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(f.repo.sourceProvenance(raw.id).label).toBe("真实旧来源标签");
    f.repo.enqueue(
      {
        ...input,
        resolveSource: () => {
          throw Error("must not read raw again");
        },
      },
      "v8",
      now,
    );
    expect(f.repo.getSourceMetadata(raw.id)).toEqual({
      id: raw.id,
      type: raw.type,
      referenceId: raw.referenceId,
      speaker: raw.speaker,
      occurredAt: raw.occurredAt,
    });
    expect(f.repo.work(work.workId).episode).toEqual(input.episode);
  });
  it("rejects every explicit canonical identity mismatch and rolls an incomplete intake back", () => {
    const f = fixture();
    const raw = source();
    f.repo.registerSource(raw);
    for (const patch of [
      { content: "改变原文" },
      { speaker: "assistant" as const },
      { referenceId: randomUUID() },
      { type: "voice" as const },
      { occurredAt: "2026-09-15T13:00:00.000Z" },
    ])
      expect(() => f.repo.registerSource({ ...raw, ...patch })).toThrow(
        "reused",
      );
    const other = source("另一个来源");
    const input = formationIntake(episode([other, source()]));
    expect(() =>
      f.repo.enqueue(
        {
          ...input,
          resolveSource: (id) => (id === other.id ? other : undefined),
        },
        "v8",
        now,
      ),
    ).toThrow("unavailable");
    expect(f.db.prepare("SELECT COUNT(*) n FROM memory_work").get()).toEqual({
      n: 0,
    });
    expect(f.repo.getSourceMetadata(other.id)).toBeUndefined();
    expect(f.repo.getFormationSource(raw.type, raw.referenceId)).toEqual(raw);
  });
  it("requires a nonempty primary set and rejects duplicate or reordered source uses", () => {
    const f = fixture(),
      a = source(),
      b = source();
    const input = episode([a, b]);
    const intake = formationIntake(input);
    expect(() =>
      f.repo.enqueue(
        {
          ...intake,
          sources: function* () {
            yield { sourceId: a.id, primary: false };
          },
        },
        "v8",
        now,
      ),
    ).toThrow("primary");
    expect(f.repo.getSourceMetadata(a.id)).toBeUndefined();
    expect(() =>
      f.repo.enqueue(formationIntake(episode([a, a])), "v8", now),
    ).toThrow("UNIQUE");
    f.repo.enqueue(intake, "v8", now);
    expect(() =>
      f.repo.enqueue(formationIntake({ ...input, sources: [b, a] }), "v8", now),
    ).toThrow("different source uses");
  });
  it("does not resolve an ambiguous Activity reference or release it as a unique snapshot", () => {
    const f = fixture();
    const a = {
      ...source(),
      type: "activity_event" as const,
      speaker: "environment" as const,
    };
    f.repo.registerSource(a);
    expect(
      f.repo.snapshottedActivitySourceIds([a.referenceId]).has(a.referenceId),
    ).toBe(true);
    f.repo.registerSource({ ...a, id: randomUUID() });
    expect(f.repo.getFormationSource(a.type, a.referenceId)).toBeUndefined();
    expect(f.repo.snapshottedActivitySourceIds([a.referenceId]).size).toBe(0);
  });
  it("covers only failed work by one complete source-and-role superset, preserving failure evidence", () => {
    const f = fixture();
    const a = {
        ...source(),
        type: "activity_event" as const,
        speaker: "environment" as const,
      },
      b = source();
    const failed = f.repo.enqueue(formationIntake(episode([a, b])), "v8", now);
    f.repo.failPending(failed.workId, "model_failure", now);
    const first = f.repo.enqueue(formationIntake(episode([a])), "v8", now);
    const firstExecution = f.repo.startWork(
      first.workId,
      "v8",
      undefined,
      now,
    )!;
    f.repo.finish(firstExecution, { changes: [] }, now);
    const second = f.repo.enqueue(formationIntake(episode([b])), "v8", now);
    const secondExecution = f.repo.startWork(
      second.workId,
      "v8",
      undefined,
      now,
    )!;
    f.repo.finish(secondExecution, { changes: [] }, now);
    expect(f.repo.incomplete({ owner: "user" })).toBe(true);
    const context = f.repo.enqueue(
      formationIntake(episode([a, b], [b.id])),
      "v8",
      now,
    );
    const contextExecution = f.repo.startWork(
      context.workId,
      "v8",
      undefined,
      now,
    )!;
    f.repo.finish(contextExecution, { changes: [] }, now);
    expect(
      f.repo.protectedActivitySourceIds([a.referenceId]).has(a.referenceId),
    ).toBe(true);
    const complete = f.repo.enqueue(
      formationIntake(episode([a, b, source()])),
      "v8",
      now,
    );
    const completeExecution = f.repo.startWork(
      complete.workId,
      "v8",
      undefined,
      now,
    )!;
    f.repo.finish(completeExecution, { changes: [] }, now);
    expect(f.repo.incomplete({ owner: "user" })).toBe(false);
    expect(f.repo.protectedActivitySourceIds([a.referenceId]).size).toBe(0);
    expect(
      f.db
        .prepare("SELECT status,error_code FROM memory_work WHERE id=?")
        .get(failed.workId),
    ).toEqual({ status: "failed", error_code: "model_failure" });
    f.repo.enqueue(formationIntake(episode([a, b])), "v8", now);
    expect(f.repo.incomplete({ owner: "user" })).toBe(true);
  });
  it.each([
    "complete",
    "partial",
    "split-completions",
    "context-only",
  ] as const)(
    "configuration retry preserves covered failures and requeues %s coverage only when work remains",
    (coverage) => {
      const f = fixture();
      const a = source(),
        b = source();
      const failed = f.repo.enqueue(
        formationIntake(episode([a, b])),
        "v8",
        now,
      );
      const execution = f.repo.startWork(failed.workId, "v8", undefined, now)!;
      f.repo.fail(execution, "original_failure", now);
      const complete = (
        sources: FormationFixture["sources"],
        primary?: string[],
      ) => {
        const ref = f.repo.enqueue(
          formationIntake(episode(sources, primary)),
          "v8",
          now,
        );
        const owned = f.repo.startWork(ref.workId, "v8", undefined, now)!;
        f.repo.finish(owned, { changes: [], processorVersion: "v8" }, now);
      };
      if (coverage === "complete") complete([a, b, source()]);
      else if (coverage === "context-only") complete([a, b], [b.id]);
      else {
        complete([a]);
        if (coverage === "split-completions") complete([b]);
      }
      const before = f.db
        .prepare("SELECT * FROM memory_work WHERE id=?")
        .get(failed.workId);
      f.repo.retryFailed("2026-09-15T12:01:00.000Z");
      if (coverage === "complete") {
        expect(
          f.db
            .prepare("SELECT * FROM memory_work WHERE id=?")
            .get(failed.workId),
        ).toEqual(before);
        expect([...f.repo.pendingWork()]).toEqual([]);
        expect(f.repo.incomplete({ owner: "user" })).toBe(false);
      } else {
        expect(f.repo.work(failed.workId)).toMatchObject({
          status: "pending",
          attempt: 1,
          errorCode: "original_failure",
          processorVersion: "v8",
        });
        expect([...f.repo.pendingWork()].map((x) => x.workId)).toEqual([
          failed.workId,
        ]);
      }
    },
  );
});

describe("unattempted formation queue replacement", () => {
  it("replaces only an ordered strict superset and keeps exact canonical input after restart", () => {
    const f = fixture();
    const a = source("我周六想去看展。"),
      b = source("这是前一句的补充语境。"),
      c = source("出发时间改为十点。"),
      d = source("更早的原始语境。");
    const original = episode([a, b], [a.id]);
    const first = f.repo.enqueue(formationIntake(original), "v8", now);
    const expanded = episode([d, a, c, b], [a.id, c.id]);
    const next = f.repo.enqueue(formationIntake(expanded), "v8", now);
    expect(() => f.repo.work(first.workId)).toThrow("does not exist");
    expect([...f.repo.pendingWork()].map((work) => work.workId)).toEqual([
      next.workId,
    ]);
    expect(f.repo.sourceCounts(next.workId)).toEqual({
      primary: 2,
      context: 2,
    });
    for (const raw of expanded.sources)
      expect(
        f.repo.sourceWindow(next.workId, raw.id, 0, raw.content.length),
      ).toBe(raw.content);
    const reopened = f.reopen();
    expect(reopened.repo.work(next.workId).episode).toEqual(
      formationIntake(expanded).episode,
    );
    // A later real request for the old input is exact, not a redirected receipt.
    const repeated = reopened.repo.enqueue(
      formationIntake(original),
      "v8",
      now,
    );
    expect(repeated.workId).toBe(first.workId);
    expect(reopened.repo.sourceCounts(repeated.workId)).toEqual({
      primary: 1,
      context: 1,
    });
    expect(reopened.repo.work(repeated.workId).result).toBeUndefined();
    expect([...reopened.repo.pendingWork()]).toHaveLength(2);
    expect(() =>
      reopened.repo.sourceWindow(repeated.workId, c.id, 0, 1),
    ).toThrow();
  });

  it.each([
    "equal input",
    "omitted source",
    "reversed order",
    "primary becomes context",
    "context becomes primary",
    "different persona",
    "missing persona",
    "different situation",
    "missing situation",
    "different processor",
  ])("preserves %s as a separate exact work", (reason) => {
    const f = fixture();
    const a = source(),
      b = source(),
      c = source();
    const original = {
      ...episode([a, b], [a.id]),
      personaId: randomUUID(),
      situationId: randomUUID(),
    };
    const first = f.repo.enqueue(formationIntake(original), "v8", now);
    let expanded: FormationFixture = {
      ...original,
      id: randomUUID(),
      sources: [a, b, c],
      evidenceSourceIds: [a.id, c.id],
    };
    if (reason === "equal input") expanded = { ...original, id: randomUUID() };
    if (reason === "omitted source") expanded.sources = [a, c, source()];
    if (reason === "reversed order") expanded.sources = [b, a, c];
    if (reason === "primary becomes context")
      expanded.evidenceSourceIds = [c.id];
    if (reason === "context becomes primary")
      expanded.evidenceSourceIds = [a.id, b.id, c.id];
    if (reason === "different persona") expanded.personaId = randomUUID();
    if (reason === "missing persona") delete expanded.personaId;
    if (reason === "different situation") expanded.situationId = randomUUID();
    if (reason === "missing situation") delete expanded.situationId;
    const next = f.repo.enqueue(
      formationIntake(expanded),
      reason === "different processor" ? "v9" : "v8",
      now,
    );
    expect(f.repo.work(first.workId).episode).toEqual(
      formationIntake(original).episode,
    );
    expect(f.repo.work(next.workId).episode).toEqual(
      formationIntake(expanded).episode,
    );
    expect([...f.repo.pendingWork()]).toHaveLength(2);
  });

  it("preserves every attempted, partial, failed and completed work byte for byte", () => {
    const f = fixture();
    const a = source(),
      b = source();
    const ids: string[] = [];
    for (const state of [
      "running",
      "cancelled",
      "partial",
      "failed",
      "failed-before-attempt",
      "complete",
    ]) {
      const work = f.repo.enqueue(formationIntake(episode([a])), "v8", now);
      ids.push(work.workId);
      const execution =
        state !== "failed-before-attempt"
          ? f.repo.startWork(work.workId, "v8", undefined, now)
          : undefined;
      if (state === "partial")
        f.repo.saveProgress(
          execution!,
          {
            changes: [{ revisionId: "retained" }],
            cursor: { ordinal: 1, start: 0 },
          },
          now,
        );
      if (state === "cancelled" || state === "partial")
        f.repo.suspend(execution!, now);
      if (state === "failed-before-attempt")
        f.repo.failPending(work.workId, "original_failure", now);
      if (state === "failed") f.repo.fail(execution!, "original_failure", now);
      if (state === "complete")
        f.repo.finish(
          execution!,
          {
            changes: [],
            processorVersion: "v8",
            receipt: "original exact result",
          },
          now,
        );
    }
    // Defensive result preservation also covers a pending row before attempts.
    const resultOnly = f.repo.enqueue(formationIntake(episode([a])), "v8", now);
    ids.push(resultOnly.workId);
    f.db
      .prepare("UPDATE memory_work SET result_json='{}' WHERE id=?")
      .run(resultOnly.workId);
    const read = f.db.prepare("SELECT * FROM memory_work WHERE id=?");
    const before = ids.map((id) => read.get(id));
    f.repo.enqueue(formationIntake(episode([a, b])), "v8", now);
    expect(ids.map((id) => read.get(id))).toEqual(before);
    f.repo.recover(now);
    const attempted = f.db
      .prepare("SELECT attempt FROM memory_work WHERE id=?")
      .get(ids[0]!);
    expect(attempted).toEqual({ attempt: 1 });
    f.repo.enqueue(formationIntake(episode([a, b, source()])), "v8", now);
    expect(f.repo.work(ids[0]!).status).toBe("pending");
  });

  it("rolls replacement back with its intake and outer handoff transaction", () => {
    const f = fixture();
    const a = source(),
      b = source();
    const original = episode([a]);
    const first = f.repo.enqueue(formationIntake(original), "v8", now);
    const expanded = formationIntake(episode([a, b]));
    expect(() =>
      f.repo.enqueue(
        { ...expanded, resolveSource: () => undefined },
        "v8",
        now,
      ),
    ).toThrow("unavailable");
    expect([...f.repo.pendingWork()].map((work) => work.workId)).toEqual([
      first.workId,
    ]);
    expect(() =>
      f.repo.transaction(() => {
        f.repo.enqueue(expanded, "v8", now);
        throw new Error("outbox acknowledgement failed");
      }),
    ).toThrow("acknowledgement failed");
    expect([...f.repo.pendingWork()].map((work) => work.workId)).toEqual([
      first.workId,
    ]);
    expect(f.repo.getSourceMetadata(b.id)).toBeUndefined();
    expect(() =>
      f.repo.enqueue(
        formationIntake({ ...original, sources: [a, b] }),
        "v8",
        now,
      ),
    ).toThrow("different source uses");
    expect(f.repo.sourceCounts(first.workId)).toEqual({
      primary: 1,
      context: 0,
    });
  });

  it("retains incomplete and Activity source coverage until the replacement is processed", () => {
    const f = fixture();
    const a = {
      ...source(),
      type: "activity_event" as const,
      speaker: "environment" as const,
    };
    const first = f.repo.enqueue(formationIntake(episode([a])), "v8", now);
    expect(f.repo.incomplete({ owner: "user" })).toBe(true);
    const next = f.repo.enqueue(
      formationIntake(episode([a, source()])),
      "v8",
      now,
    );
    expect(() => f.repo.work(first.workId)).toThrow("does not exist");
    expect(f.repo.incomplete({ owner: "user" })).toBe(true);
    expect(f.repo.protectedActivitySourceIds([a.referenceId])).toEqual(
      new Set([a.referenceId]),
    );
    const nextExecution = f.repo.startWork(next.workId, "v8", undefined, now)!;
    f.repo.finish(nextExecution, { changes: [] }, now);
    expect(f.repo.incomplete({ owner: "user" })).toBe(false);
    expect(f.repo.protectedActivitySourceIds([a.referenceId]).size).toBe(0);
    expect(f.repo.getFormationSource(a.type, a.referenceId)).toEqual(a);
  });
});
