import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formationIntake,
  collectFormationSegments,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import { estimateInputBudget } from "../providers/inputBudget";
import { openApplicationDatabase } from "../db/database";
import { MemoryFormationRepository } from "./memoryFormationRepository";
import {
  segmentMemoryEpisode,
  type MemoryFormationSegment,
} from "./memoryFormationSegments";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((done) => done()));
const now = "2026-09-15T12:00:00.000Z";
function episode(content: string): FormationFixture {
  return {
    id: randomUUID(),
    version: "1",
    recordedAt: now,
    sources: [
      {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        speaker: "user",
        occurredAt: now,
        content,
      },
    ],
  };
}
function fixture(original: FormationFixture) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "source-window-"));
  const db = openApplicationDatabase(path.join(dir, "app.sqlite"));
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = new MemoryFormationRepository(db);
  const ref = repo.enqueue(formationIntake(original), "window-test", now);
  return {
    db,
    repo,
    ref,
    collect: (budget: number) =>
      collectFormationSegments(repo, ref.workId, budget),
  };
}
const estimate = (segment: MemoryFormationSegment) =>
  estimateInputBudget({
    episode: segment.episode,
    sourceWindows: segment.sourceWindows,
    sourceCoverage: segment.sourceCoverage,
    existing: [],
    entities: [],
  }).estimatedTokens;

describe("durable source window formation", () => {
  it.each([
    "Plain ASCII sentence. ",
    "中文与 emoji 🐱 和 𠀀。",
    'quoted "value" and \\path. ',
    "line\nwith\ttabs. ",
    "isolated \ud800 and \udfff. ",
  ])("matches the full wire heuristic at exact budget for %j", async (text) => {
    const original = episode("我们接着讨论昨天的事。");
    const context = {
      ...episode(text.repeat(4)).sources[0]!,
      occurredAt: "2026-09-14T12:00:00.000Z",
    };
    original.evidenceSourceIds = [original.sources[0]!.id];
    original.sources.push(context);
    const f = fixture(original);
    const complete = await f.collect(16000);
    expect(complete).toHaveLength(1);
    const exact = estimate(complete[0]!);
    expect(await f.collect(exact)).toEqual(complete);
    const smaller = await f.collect(exact - 1);
    expect(smaller).not.toEqual(complete);
    for (const segment of smaller)
      expect(estimate(segment)).toBeLessThanOrEqual(exact - 1);
  });
  it("packs four short primary messages and their shared prior context into one model request", async () => {
    const original = episode("昨天你想做的那东西弄成了吗？");
    original.sources.push(
      ...[
        "我想做的是灯塔。",
        "今天可以继续自己的生活。",
        "不用一直围着拒信转。",
      ].map((t) => episode(t).sources[0]!),
    );
    const primary = original.sources.map((s) => s.id);
    const context = {
      ...episode("这是用户和同一角色的对话。").sources[0]!,
      occurredAt: "2026-09-14T12:00:00.000Z",
    };
    original.sources.unshift(context);
    original.evidenceSourceIds = primary;
    const segments = await fixture(original).collect(8000);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.episode.evidenceSourceIds).toEqual(primary);
    expect(segments[0]!.episode.sources.map((s) => s.content)).toEqual(
      [...original.sources.slice(1), context].map((s) => s.content),
    );
  });
  it("retains every primary Unicode span, while context remains verbatim, bounded and time-scoped", async () => {
    const original = episode(
      "那天我们去了海边😀。后来又看了月亮。\n".repeat(130),
    );
    const primary = original.sources[0]!;
    const future = {
      ...episode("未来不能预知的内容").sources[0]!,
      occurredAt: "2026-09-16T12:00:00.000Z",
    };
    original.sources.push(
      {
        ...episode("前文只解释主体。".repeat(100)).sources[0]!,
        occurredAt: "2026-09-14T12:00:00.000Z",
      },
      future,
    );
    original.evidenceSourceIds = [primary.id];
    const f = fixture(original);
    const segments = await f.collect(2100);
    expect(segments.length).toBeGreaterThan(1);
    expect(
      segments
        .map((s) => s.episode.sources.find((x) => x.id === primary.id)!.content)
        .join(""),
    ).toBe(primary.content);
    for (const segment of segments) {
      expect(estimate(segment)).toBeLessThanOrEqual(2100);
      expect(segment.episode.sources.some((x) => x.id === future.id)).toBe(
        false,
      );
      for (const window of segment.sourceWindows)
        expect(
          segment.episode.sources.find((s) => s.id === window.sourceId)!
            .content,
        ).toBe(
          original.sources
            .find((s) => s.id === window.sourceId)!
            .content.slice(window.start, window.end),
        );
      expect(
        segment.sourceCoverage.omittedContextSourceCount,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(await f.collect(2100)).toEqual(segments);
  });
  it("does not let context size multiply paid primary fragments or form standalone context", async () => {
    const original = episode("有完整句义的主材。".repeat(80));
    const primary = original.sources[0]!,
      context = episode("大量背景😀。".repeat(20000)).sources[0]!;
    const large = await fixture({
      ...original,
      sources: [primary, context],
      evidenceSourceIds: [primary.id],
    }).collect(1800);
    const small = await fixture({
      ...original,
      sources: [primary, { ...context, content: "背景" }],
      evidenceSourceIds: [primary.id],
    }).collect(1800);
    expect(
      large.map((s) => s.sourceWindows.find((w) => w.sourceId === primary.id)),
    ).toEqual(
      small.map((s) => s.sourceWindows.find((w) => w.sourceId === primary.id)),
    );
    expect(
      large.every(
        (s) =>
          s.episode.evidenceSourceIds.includes(primary.id) &&
          s.episode.sources[0]!.content.length > 1,
      ),
    ).toBe(true);
  });
  it("resumes from a durable source cursor without reading previous source bodies", async () => {
    const original = episode("第一条主体陈述。".repeat(60));
    original.sources.push(episode("第二条主体陈述。".repeat(80)).sources[0]!);
    const f = fixture(original);
    const complete = await f.collect(1800);
    const stop = complete.findIndex((s) => s.nextCursor.ordinal === 1);
    expect(stop).toBeGreaterThanOrEqual(0);
    const read = vi.spyOn(f.repo, "sourceWindow");
    const resumed: MemoryFormationSegment[] = [];
    for await (const segment of segmentMemoryEpisode(
      f.repo,
      f.repo.work(f.ref.workId),
      1800,
      complete[stop]!.nextCursor,
    ))
      resumed.push(segment);
    expect(resumed).toEqual(complete.slice(stop + 1));
    expect(
      read.mock.calls.every(
        ([, sourceId]) => sourceId !== original.sources[0]!.id,
      ),
    ).toBe(true);
  });
  it("loads bounded windows lazily and cancels before the next source is read", async () => {
    const original = episode("很长的第一条来源。".repeat(10000));
    original.sources.push(episode("第二条不应被读取的正文").sources[0]!);
    const f = fixture(original);
    const read = vi.spyOn(f.repo, "sourceWindow");
    const abort = new AbortController();
    const iterator = segmentMemoryEpisode(
      f.repo,
      f.repo.work(f.ref.workId),
      1800,
      undefined,
      abort.signal,
    )[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(
      read.mock.calls.every(
        ([, id, start, end]) =>
          id === original.sources[0]!.id && end - start <= 1801,
      ),
    ).toBe(true);
    abort.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
  it("rejects unusably small budgets and never silently drops an unbroken primary", async () => {
    const original = episode("长".repeat(2000));
    const f = fixture(original);
    const segments = await f.collect(1300);
    expect(segments.map((s) => s.episode.sources[0]!.content).join("")).toBe(
      original.sources[0]!.content,
    );
    await expect(f.collect(1)).rejects.toThrow("budget cannot contain");
  });
});
