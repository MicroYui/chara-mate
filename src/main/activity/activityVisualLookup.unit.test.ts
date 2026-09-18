import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeClock } from "../../../tests/fixtures/fakeClock";
import type {
  ActivityActor,
  ActivityEvent,
  ActivitySurface,
  ActivityVisualLookupRequest,
} from "../../shared/contracts/activity";
import { openApplicationDatabase } from "../db/database";
import { MemoryRepository } from "../memory/memoryRepository";
import { MemoryService } from "../memory/memoryService";
import { ActivityAssetStore } from "./activityAssetStore";
import { ActivityRepository } from "./activityRepository";
import { ActivityService } from "./activityService";
import {
  visualPngFixture,
  visualSurfaceFixture,
} from "./activityVisual.fixture";

const NOW = "2026-09-17T12:00:00.000Z";
const EARLIER = "2026-09-17T11:00:00.000Z";
const resources = { maxReadBytes: 1024 * 1024 };
interface VisualOptions {
  readonly actor?: ActivityActor;
  readonly surface?: Partial<ActivitySurface>;
  readonly ocr?: string;
}
interface VisualLookupFixture {
  readonly root: string;
  readonly database: ReturnType<typeof openApplicationDatabase>;
  readonly repository: ActivityRepository;
  readonly clock: FakeClock;
  readonly service: ActivityService;
  readonly add: (
    capturedAt: string,
    options?: VisualOptions,
  ) => Promise<ActivityEvent>;
}
const opened: VisualLookupFixture[] = [];
let serial = 0;
const ids = {
  generate: () =>
    `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
};

function fixture(): VisualLookupFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "activity-visual-lookup-"));
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const repository = new ActivityRepository(database);
  const clock = new FakeClock(NOW);
  repository.initialize(clock.now());
  const memory = new MemoryService(
    new MemoryRepository(database),
    { search: () => [] },
    ids,
    clock,
  );
  const assets = new ActivityAssetStore(path.join(root, "assets"));
  const service = new ActivityService(
    repository,
    memory,
    assets,
    ids,
    clock,
    "UTC",
  );
  const add = async (
    capturedAt: string,
    options: VisualOptions = {},
  ): Promise<ActivityEvent> => {
    const asset = await assets.save(
      ids.generate(),
      { bytes: visualPngFixture, width: 1, height: 1, mediaType: "image/png" },
      capturedAt,
    );
    const event: ActivityEvent = {
      id: ids.generate(),
      actor: options.actor ?? "unknown",
      startedAt: capturedAt,
      endedAt: capturedAt,
      details: {
        source: "screenshot",
        artifactId: asset.id,
        storageKey: asset.storageKey,
        width: asset.width,
        height: asset.height,
        mediaType: asset.mediaType,
        ocrText: options.ocr ?? "",
        visual: {
          surface: { ...visualSurfaceFixture, ...options.surface },
          capturedAt,
          receivedAt: NOW,
          contentRevision: asset.sha256,
          sequence: serial,
          coalescedFrames: 0,
          trigger: "frame",
          redactedRegions: 0,
          ocr: {
            engine: "apple_vision",
            revision: 1,
            languages: ["zh-Hans"],
            status: options.ocr ? "complete" : "empty",
            lines: options.ocr
              ? [
                  {
                    text: options.ocr,
                    confidence: 1,
                    bounds: { x: 0, y: 0, width: 1, height: 1 },
                  },
                ]
              : [],
          },
        },
      },
    };
    repository.insertScreenshot(asset, event, NOW);
    return event;
  };
  const result = { root, database, repository, clock, service, add };
  opened.push(result);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of opened.splice(0)) {
    if (f.database.open) f.database.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

const observedIds = (
  result: Awaited<ReturnType<ActivityService["lookupVisualEvidence"]>>,
) => result.observations.map(({ reference }) => reference.eventId);

describe("Activity retained visual lookup", () => {
  it("lists raw observations before Claim or Episode formation without a recent-N or age cut", async () => {
    const f = fixture();
    const old = await f.add("2020-01-01T00:00:00.000Z");
    const sameTime: ActivityEvent[] = [];
    for (let index = 0; index < 12; index += 1)
      sameTime.push(
        await f.add(NOW, { actor: index === 0 ? "agent" : "unknown" }),
      );
    await f.add("2026-09-17T12:00:00.001Z");
    f.service.recordEvent({ source: "active_app", appName: "Other" }, "user");

    const result = await f.service.lookupVisualEvidence({}, resources);

    expect(result).toMatchObject({
      request: { periodEnd: NOW },
      complete: true,
      loaded: false,
      retainedOnly: true,
      order: "newest_first",
    });
    expect(result.continuation).toBeUndefined();
    expect(observedIds(result)).toEqual([
      ...sameTime.toReversed().map(({ id }) => id),
      old.id,
    ]);
    expect(
      result.observations.find(
        ({ reference }) => reference.eventId === sameTime[0]!.id,
      )?.actor,
    ).toBe("agent");
    expect(
      f.database.prepare("SELECT COUNT(*) AS n FROM activity_episodes").get(),
    ).toEqual({ n: 0 });
    expect(
      f.database.prepare("SELECT COUNT(*) AS n FROM cognition_evidence").get(),
    ).toEqual({ n: 0 });
    expect(JSON.stringify(result)).not.toContain("storageKey");
    expect(result.readBytes).toBeGreaterThan(0);
    expect(result.readBytes).toBeLessThanOrEqual(resources.maxReadBytes);
  });

  it("matches literal app, title and captured OCR while respecting surface epoch and inclusive capture times", async () => {
    const f = fixture();
    const start = await f.add(EARLIER, {
      surface: { appName: "Diagram Studio" },
    });
    const title = await f.add(NOW, { surface: { windowTitle: "发布草稿" } });
    const ocr = await f.add(NOW, { ocr: "值 value_1 为 100%" });
    const otherEpoch = await f.add(NOW, {
      surface: { epoch: "next-epoch" },
      ocr: "值 value_1 为 100%",
    });
    await f.add("2026-09-17T12:00:00.001Z", { ocr: "值 value_1 为 100%" });
    for (const [query, expected] of [
      ["Diagram", [start.id]],
      ["发布草稿", [title.id]],
      ["100%", [otherEpoch.id, ocr.id]],
      ["value_1", [otherEpoch.id, ocr.id]],
      ["does-not-exist%", []],
    ] as const) {
      const result = await f.service.lookupVisualEvidence(
        { query, periodStart: EARLIER, periodEnd: NOW },
        resources,
      );
      expect(observedIds(result)).toEqual(expected);
    }
    const selected = await f.service.lookupVisualEvidence(
      {
        query: "100%",
        periodStart: "2026-09-17T12:00:00Z",
        periodEnd: "2026-09-17T12:00:00Z",
        surface: {
          id: visualSurfaceFixture.id,
          epoch: visualSurfaceFixture.epoch,
        },
      },
      resources,
    );
    expect(selected.request).toMatchObject({
      periodStart: NOW,
      periodEnd: NOW,
    });
    expect(observedIds(selected)).toEqual([ocr.id]);
    expect(selected.observations[0]!.reference.capturedAt).toBe(NOW);
    expect(selected.observations[0]!.position.startedAt).toBe(NOW);
  });

  it("counts compact returned metadata rather than returning a large OCR body to JavaScript", async () => {
    const f = fixture();
    const marker = "匹配的实际局部文字";
    const event = await f.add(NOW, {
      ocr: `${"观察内容".repeat(100_000)}${marker}`,
    });
    const raw = f.database
      .prepare(
        "SELECT length(CAST(details_json AS BLOB)) AS n FROM activity_events WHERE id=?",
      )
      .get(event.id) as { n: number };
    const getEvent = vi.spyOn(f.repository, "getEvent");
    const result = await f.service.lookupVisualEvidence(
      { query: marker },
      { maxReadBytes: 2048 },
    );
    expect(raw.n).toBeGreaterThan(1024 * 1024);
    expect(observedIds(result)).toEqual([event.id]);
    expect(result.complete).toBe(true);
    expect(result.readBytes).toBe(
      Buffer.byteLength(JSON.stringify(result.observations[0]), "utf8"),
    );
    expect(result.readBytes).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(result)).not.toContain("观察内容");
    expect(getEvent).not.toHaveBeenCalled();
  });

  it("continues after the last returned tie-breaker and fixes the effective end without pretending to freeze the database", async () => {
    const f = fixture();
    const older = await f.add(EARLIER);
    const first = await f.add(NOW);
    const newest = await f.add(NOW);
    const all = await f.service.lookupVisualEvidence({}, resources);
    const firstBytes = Buffer.byteLength(
      JSON.stringify(all.observations[0]),
      "utf8",
    );
    const page = await f.service.lookupVisualEvidence(
      {},
      { maxReadBytes: firstBytes },
    );
    expect(observedIds(page)).toEqual([newest.id]);
    expect(page).toMatchObject({
      complete: false,
      omittedReason: "read_budget",
      readBytes: firstBytes,
    });
    expect(page.continuation).toEqual({
      periodEnd: NOW,
      before: { startedAt: NOW, eventId: newest.id },
    });

    f.clock.advance(1000);
    await f.add(f.clock.now());
    f.database.prepare("DELETE FROM activity_events WHERE id=?").run(first.id);
    const arrivedLate = await f.add("2026-09-17T11:30:00.000Z");
    const next = await f.service.lookupVisualEvidence(
      page.continuation!,
      resources,
    );
    expect(next.request.periodEnd).toBe(NOW);
    expect(next.complete).toBe(true);
    expect(observedIds(next)).toEqual([arrivedLate.id, older.id]);
    expect(next.continuation).toBeUndefined();
  });

  it("does not skip an oversized first match, including a zero-budget continuation", async () => {
    const f = fixture();
    const older = await f.add(EARLIER);
    const newest = await f.add(NOW, {
      surface: { windowTitle: "宽标题".repeat(2000) },
    });
    const input: ActivityVisualLookupRequest = { periodEnd: NOW };
    const small = await f.service.lookupVisualEvidence(input, {
      maxReadBytes: 1024,
    });
    expect(small).toMatchObject({
      observations: [],
      readBytes: 0,
      complete: false,
      omittedReason: "read_budget",
      continuation: input,
    });
    const zero = await f.service.lookupVisualEvidence(small.continuation!, {
      maxReadBytes: 0,
    });
    expect(zero.continuation).toEqual(input);
    expect(zero.observations).toEqual([]);
    const expanded = await f.service.lookupVisualEvidence(
      zero.continuation!,
      resources,
    );
    expect(observedIds(expanded)).toEqual([newest.id, older.id]);
    const empty = await f.service.lookupVisualEvidence(
      { query: "absent" },
      { maxReadBytes: 0 },
    );
    expect(empty).toMatchObject({
      complete: true,
      observations: [],
      readBytes: 0,
    });
  });

  it("honours cancellation before lookup and after a completed row without leaving an active SQLite iterator", async () => {
    const f = fixture();
    await f.add(EARLIER);
    await f.add(NOW);
    const before = new AbortController();
    before.abort();
    const query = vi.spyOn(f.database, "prepare");
    await expect(
      f.service.lookupVisualEvidence({}, resources, before.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();

    const during = new AbortController();
    const pending = f.service.lookupVisualEvidence(
      {},
      resources,
      during.signal,
    );
    // Lookup is suspended at its real per-row setImmediate. A busy iterator
    // would prevent close; an aborted continuation must not access this DB later.
    during.abort();
    expect(() => f.database.close()).not.toThrow();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns references rather than a pixel-read promise and revalidates them through the existing resolver", async () => {
    const f = fixture();
    const event = await f.add(NOW);
    const lookup = await f.service.lookupVisualEvidence({}, resources);
    const reference = lookup.observations[0]!.reference;
    expect(lookup.loaded).toBe(false);
    expect(await f.service.resolveVisualEvidence(reference)).toMatchObject({
      status: "available",
      bytes: visualPngFixture,
    });
    expect(
      await f.service.resolveVisualEvidence({
        ...reference,
        contentRevision: "changed",
      }),
    ).toEqual({ status: "unavailable", reason: "source_changed" });
    f.database.prepare("DELETE FROM activity_events WHERE id=?").run(event.id);
    expect(await f.service.resolveVisualEvidence(reference)).toEqual({
      status: "unavailable",
      reason: "source_missing",
    });
  });

  it("rejects invalid ranges and raw budgets and treats a blank query as an omitted literal", async () => {
    const f = fixture();
    await f.add(NOW);
    await expect(
      f.service.lookupVisualEvidence(
        { periodStart: "2026-09-18T00:00:00.000Z" },
        resources,
      ),
    ).rejects.toThrow("start must not follow");
    for (const maxReadBytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(
        f.service.lookupVisualEvidence({}, { maxReadBytes }),
      ).rejects.toThrow("raw-read budget");
    const blank = await f.service.lookupVisualEvidence(
      { query: "   " },
      resources,
    );
    expect(blank.request.query).toBeUndefined();
    expect(blank.observations).toHaveLength(1);
  });
});
