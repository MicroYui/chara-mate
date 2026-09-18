import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  visualFrameFixture,
  visualSurfaceFixture,
} from "../../src/main/activity/activityVisual.fixture";
import { ActivityAssetStore } from "../../src/main/activity/activityAssetStore";
import { ActivityRepository } from "../../src/main/activity/activityRepository";
import { ActivityService } from "../../src/main/activity/activityService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import type { RetrievalPipeline } from "../../src/main/memory/retrievalPipeline";
import type { MemoryListRequest } from "../../src/shared/contracts/memory";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(now = "2026-08-10T12:00:00.000Z", existingRoot?: string) {
  const root =
    existingRoot ?? mkdtempSync(path.join(os.tmpdir(), "charamate-activity-"));
  if (!existingRoot) roots.push(root);
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const memoryRepository = new MemoryRepository(database);
  const retrieval: RetrievalPipeline = {
    search(query: MemoryListRequest) {
      return memoryRepository.listRecords(query).map((memory, index) => ({
        ...memoryRepository.hitFor(memory),
        rank: index + 1,
      }));
    },
  };
  const clock = new FakeClock(now);
  const ids = new CryptoIdGenerator();
  const memory = new MemoryService(memoryRepository, retrieval, ids, clock);
  const repository = new ActivityRepository(database);
  repository.initialize(clock.now());
  const assets = new ActivityAssetStore(path.join(root, "activity-assets"));
  const service = new ActivityService(
    repository,
    memory,
    assets,
    ids,
    clock,
    "Asia/Shanghai",
  );
  service.setSourceRetentionGuard(() => new Set());
  return {
    assets,
    clock,
    database,
    memory,
    repository,
    root,
    service,
  };
}

function recordEditorDays(service: ActivityService, days: readonly string[]) {
  for (const day of days) {
    service.recordEvent(
      {
        appName: "Visual Studio Code",
        source: "active_app",
        windowTitle: `private-project-${day}`,
      },
      "user",
      `2026-08-${day}T01:00:00.000Z`,
      `2026-08-${day}T02:00:00.000Z`,
    );
  }
}

describe("Activity persistence and distillation", () => {
  it("keeps native collection completion distinct from database receipt time", () => {
    const { database, service } = harness("2026-09-16T04:00:01.000Z");
    const id = service.startEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        boundary: "interaction",
        inputOrigin: "hid_reported",
        interaction: { clicks: 1, keystrokes: 0, scrolls: 0 },
      },
      "unknown",
      "2026-09-16T04:00:00.500Z",
    );
    expect(service.getEvent(id!)).toMatchObject({
      actor: "unknown",
      startedAt: "2026-09-16T04:00:00.500Z",
      details: { inputOrigin: "hid_reported" },
    });
    expect(
      database
        .prepare("SELECT created_at FROM activity_events WHERE id = ?")
        .get(id),
    ).toEqual({ created_at: "2026-09-16T04:00:01.000Z" });
    database.close();
  });

  it("persists fine-grained semantic events through redaction and keeps system events out of user patterns", () => {
    const { clock, database, service } = harness();
    const id = service.recordEvent(
      {
        source: "active_app",
        appName: "Notes",
        windowTitle: "work.md",
        boundary: "content",
        contentStatus: "available",
        content: {
          source: "accessibility",
          scope: "focused_element",
          text: "Plan: access_token=synthetic-secret",
        },
        interaction: { clicks: 1, keystrokes: 10, scrolls: 2 },
      },
      "user",
    );
    expect(id).toBeTypeOf("string");
    clock.advance(1000);
    service.recordEvent(
      {
        source: "active_app",
        appName: "Notes",
        boundary: "interaction",
        contentStatus: "protected",
        content: {
          source: "accessibility",
          scope: "focused_element",
          text: "synthetic-password-value",
        },
        interaction: { clicks: 0, keystrokes: 20, scrolls: 0 },
      },
      "user",
    );
    service.recordEvent(
      {
        source: "managed_browser",
        domain: "example.com",
        url: "https://example.com/docs",
        boundary: "content",
        content: { source: "dom", scope: "viewport", text: "自动刷新内容" },
      },
      "system",
    );
    const raw = JSON.stringify(
      database.prepare("SELECT * FROM activity_events").all(),
    );
    expect(raw).toContain("focused_element");
    expect(raw).not.toContain("synthetic-secret");
    expect(raw).not.toContain("synthetic-password-value");
    clock.advance(9 * 60_000);
    service.distill();
    const snapshot = service.getSnapshot("2026-08-10");
    expect(
      snapshot.episodes.some(({ summary }) => summary.includes("按键 10 次")),
    ).toBe(true);
    expect(
      snapshot.episodes.some(({ summary }) => summary.includes("未读取内容")),
    ).toBe(true);
    expect(
      snapshot.episodes.some(
        ({ actor, summary }) =>
          actor === "system" && summary.includes("自动刷新内容"),
      ),
    ).toBe(true);
    database.close();
  });

  it("persists a consumed source-bound visual without putting PNG bytes into event state", async () => {
    const { database, root, service } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
        visualStatus: "available",
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const frame = await visualFrameFixture();
    const captured = await service.recordVisualFrame(frame, "foreground");
    expect(captured?.event.details.visual.surface).toEqual(
      visualSurfaceFixture,
    );
    expect(JSON.stringify(captured)).not.toContain(
      frame.bytes.toString("base64"),
    );
    const row = database
      .prepare("SELECT storage_key FROM activity_assets")
      .get() as { storage_key: string };
    expect(
      readFileSync(path.join(root, "activity-assets", row.storage_key)),
    ).toEqual(frame.bytes);
    expect(
      await service.resolveVisualEvidence(captured!.reference),
    ).toMatchObject({ status: "available", bytes: frame.bytes });
    database.close();
  });

  it("resolves a raw source by exact event ID before and after aggregation, using local calendar date", () => {
    const { database, service, clock } = harness("2026-08-10T20:00:00.000Z");
    const id = service.recordEvent(
      { source: "active_app", appName: "Synthetic fixture" },
      "user",
    )!;
    expect(service.resolveEventReference(id)).toMatchObject({
      date: "2026-08-11",
      event: { id },
    });
    expect(service.resolveEventReference(id).episodeId).toBeUndefined();
    clock.advance(10 * 60_000);
    service.distill();
    const reference = service.resolveEventReference(id);
    expect(reference.episodeId).toBeTypeOf("string");
    expect(service.getEpisode(reference.episodeId!).id).toBe(
      reference.episodeId,
    );
    expect(() => service.resolveEventReference(reference.episodeId!)).toThrow(
      "不存在",
    );
    database.prepare("DELETE FROM activity_events WHERE id = ?").run(id);
    expect(() => service.resolveEventReference(id)).toThrow("不存在");
    database.close();
  });

  it("consumes the latest image without publishing a recursive attention event and reuses exact unchanged content", async () => {
    const { database, service } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const frame = await visualFrameFixture();
    service.setVisualFrameSupplier(() => Promise.resolve(frame));
    const published = vi.fn();
    service.setEventListener(published);
    const first = await service.consumeLatestVisualEvidence();
    const second = await service.consumeLatestVisualEvidence();
    expect(first?.event.details.visual.trigger).toBe("frame");
    expect(second?.event.id).toBe(first?.event.id);
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM activity_assets").get(),
    ).toEqual({ n: 1 });
    expect(published).not.toHaveBeenCalled();
    database.close();
  });

  it("forwards changed-frame metadata only for the current actor and surface, without recording frames", () => {
    const { database, service } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const listener = vi.fn();
    service.setVisualChangeListener(listener);
    const change = {
      actor: "user" as const,
      surface: visualSurfaceFixture,
      capturedAt: "2026-08-10T12:00:00.000Z",
      sequence: 3,
    };
    service.notifyVisualChanged(change);
    expect(service.isCurrentVisualSource(change)).toBe(true);
    expect(service.isCurrentVisualSource({ ...change, actor: "agent" })).toBe(
      false,
    );
    expect(
      service.isCurrentVisualSource({
        ...change,
        surface: { ...visualSurfaceFixture, epoch: "old" },
      }),
    ).toBe(false);
    service.notifyVisualChanged({ ...change, actor: "agent" });
    service.notifyVisualChanged({
      ...change,
      surface: { ...visualSurfaceFixture, epoch: "old" },
    });
    service.setPaused(true);
    expect(service.isCurrentVisualSource(change)).toBe(false);
    service.notifyVisualChanged(change);
    expect(listener).toHaveBeenCalledExactlyOnceWith(change);
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM activity_events").get(),
    ).toEqual({ n: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM activity_assets").get(),
    ).toEqual({ n: 0 });
    database.close();
  });

  it("rejects expired and changed image references, including a removed local PNG", async () => {
    const { database, service, root } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const observation = (await service.recordVisualFrame(
      await visualFrameFixture(),
      "foreground",
    ))!;
    expect(
      await service.resolveVisualEvidence({
        ...observation.reference,
        contentRevision: "different",
      }),
    ).toEqual({ status: "unavailable", reason: "source_changed" });
    rmSync(
      path.join(root, "activity-assets", observation.event.details.storageKey),
    );
    expect(await service.resolveVisualEvidence(observation.reference)).toEqual({
      status: "unavailable",
      reason: "asset_missing",
    });
    database
      .prepare("DELETE FROM activity_events WHERE id = ?")
      .run(observation.event.id);
    expect(await service.resolveVisualEvidence(observation.reference)).toEqual({
      status: "unavailable",
      reason: "source_missing",
    });
    database.close();
  });

  it("removes an in-flight PNG when the source epoch changes before persistence", async () => {
    const { database, service, assets, root } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const original = assets.save.bind(assets);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    vi.spyOn(assets, "save").mockImplementation(async (...args) => {
      const record = await original(...args);
      wrote();
      await deferred;
      return record;
    });
    const capture = service.recordVisualFrame(
      await visualFrameFixture(),
      "foreground",
    );
    await written;
    service.setVisualContext(undefined);
    release();
    expect(await capture).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM activity_assets").get(),
    ).toEqual({ n: 0 });
    await expect(
      (await import("node:fs/promises")).readdir(
        path.join(root, "activity-assets"),
      ),
    ).resolves.toEqual([]);
    database.close();
  });

  it("serializes reclamation after a new PNG and its source commit", async () => {
    const { database, service, assets } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const written = deferred();
    const release = deferred();
    const save = assets.save.bind(assets);
    vi.spyOn(assets, "save").mockImplementation(async (...args) => {
      const record = await save(...args);
      written.resolve();
      await release.promise;
      return record;
    });
    const capture = service.recordVisualFrame(
      await visualFrameFixture(),
      "foreground",
    );
    await written.promise;
    let completed = false;
    const cleanup = service.cleanup(false).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release.resolve();
    const observation = (await capture)!;
    await cleanup;
    expect(
      (await service.resolveVisualEvidence(observation.reference)).status,
    ).toBe("available");
    database.close();
  });

  it("keeps an old asset while a queued observation adds a current reference", async () => {
    const { database, service, repository, clock } = harness();
    const observe = async (epoch: string, sequence: number) => {
      const surface = { ...visualSurfaceFixture, epoch };
      const eventId = service.recordEvent(
        { source: "active_app", appName: "Synthetic fixture", surface },
        "user",
      )!;
      service.setVisualContext({ actor: "user", surface, eventId });
      const frame = await visualFrameFixture(sequence);
      return service.recordVisualFrame(
        {
          ...frame,
          visual: {
            ...frame.visual,
            surface,
            capturedAt: clock.now(),
            receivedAt: clock.now(),
          },
        },
        "foreground",
      );
    };
    const first = (await observe("old", 1))!;
    database
      .prepare("UPDATE activity_events SET distilled_at = ? WHERE id = ?")
      .run(clock.now(), first.event.id);
    clock.advance(8 * 86_400_000);
    const find = repository.findAssetByHash.bind(repository);
    let cleanup: Promise<unknown> | undefined;
    vi.spyOn(repository, "findAssetByHash").mockImplementation((hash) => {
      const asset = find(hash);
      cleanup = service.cleanup(false);
      return asset;
    });
    const second = (await observe("current", 2))!;
    await cleanup;
    expect(second.reference.artifactId).toBe(first.reference.artifactId);
    expect((await service.resolveVisualEvidence(second.reference)).status).toBe(
      "available",
    );
    database.close();
  });

  it("orders episode deletion after a pending shared-asset reference", async () => {
    const { database, service, repository, clock } = harness();
    const observe = async (epoch: string, sequence: number) => {
      const surface = { ...visualSurfaceFixture, epoch };
      const eventId = service.recordEvent(
        { source: "active_app", appName: "Synthetic fixture", surface },
        "user",
      )!;
      service.setVisualContext({ actor: "user", surface, eventId });
      const frame = await visualFrameFixture(sequence);
      return service.recordVisualFrame(
        {
          ...frame,
          visual: {
            ...frame.visual,
            surface,
            capturedAt: clock.now(),
            receivedAt: clock.now(),
          },
        },
        "foreground",
      );
    };
    const first = (await observe("old", 1))!;
    clock.advance(10 * 60_000);
    service.distill();
    const oldEpisode = service.resolveEventReference(first.event.id).episodeId!;
    clock.advance(86_400_000);
    const find = repository.findAssetByHash.bind(repository);
    let deletion: Promise<unknown> | undefined;
    vi.spyOn(repository, "findAssetByHash").mockImplementation((hash) => {
      const asset = find(hash);
      deletion = service.deleteEpisode(oldEpisode);
      return asset;
    });
    const second = (await observe("current", 2))!;
    await deletion;
    expect(service.getEvent(first.event.id)).toBeUndefined();
    expect(second.reference.artifactId).toBe(first.reference.artifactId);
    expect((await service.resolveVisualEvidence(second.reference)).status).toBe(
      "available",
    );
    database.close();
  });

  it("invalidates in-flight pixels immediately and waits for reclamation on clear", async () => {
    const { database, service, assets, root } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const written = deferred(),
      release = deferred();
    const save = assets.save.bind(assets);
    vi.spyOn(assets, "save").mockImplementation(async (...args) => {
      const record = await save(...args);
      written.resolve();
      await release.promise;
      return record;
    });
    const capture = service.recordVisualFrame(
      await visualFrameFixture(),
      "foreground",
    );
    await written.promise;
    const cleanup = service.cleanup(false);
    const clear = service.stopVisualCapture();
    release.resolve();
    expect(await capture).toBeUndefined();
    await Promise.all([cleanup, clear]);
    expect(
      database.prepare("SELECT count(*) n FROM activity_assets").get(),
    ).toEqual({ n: 0 });
    await expect(
      (await import("node:fs/promises")).readdir(
        path.join(root, "activity-assets"),
      ),
    ).resolves.toEqual([]);
    database.close();
  });

  it("keeps a deduplicated PNG while another episode or an undistilled source still references it", async () => {
    const { database, service, clock, repository, root } = harness();
    async function observe(epoch: string, sequence: number) {
      const surface = { ...visualSurfaceFixture, epoch };
      const eventId = service.recordEvent(
        { source: "active_app", appName: "Synthetic fixture", surface },
        "user",
      )!;
      service.setVisualContext({ actor: "user", surface, eventId });
      const frame = await visualFrameFixture(sequence);
      return (await service.recordVisualFrame(
        {
          ...frame,
          visual: {
            ...frame.visual,
            surface,
            capturedAt: clock.now(),
            receivedAt: clock.now(),
          },
        },
        "foreground",
      ))!;
    }
    const first = await observe("first", 1);
    clock.advance(10 * 60_000);
    service.distill();
    const episodeId = service.resolveEventReference(first.event.id).episodeId!;
    clock.advance(8 * 24 * 60 * 60_000);
    const second = await observe("second", 2);
    expect(second.reference.artifactId).toBe(first.reference.artifactId);
    const plan = await repository.cleanup(clock.now(), false, () => new Set());
    expect(plan.storageKeys).toEqual([]);
    await service.deleteEpisode(episodeId);
    expect(
      existsSync(
        path.join(root, "activity-assets", second.event.details.storageKey),
      ),
    ).toBe(true);
    expect(await service.resolveVisualEvidence(second.reference)).toMatchObject(
      { status: "available" },
    );
    database.close();
  });

  it("closes stale capture and maintenance work conservatively on restart", () => {
    const { clock, database, repository, service } = harness();
    const startedAt = clock.now();
    expect(
      service.startEvent({ appName: "Notes", source: "active_app" }, "user"),
    ).toBeDefined();
    repository.beginDistillation(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-01T00:00:00.000Z",
      startedAt,
      startedAt,
    );
    repository.beginRetention(
      "22222222-2222-4222-8222-222222222222",
      startedAt,
    );

    clock.advance(60_000);
    repository.initialize(clock.now());

    expect(
      database
        .prepare("SELECT started_at, ended_at FROM activity_events LIMIT 1")
        .get(),
    ).toEqual({ ended_at: startedAt, started_at: startedAt });
    expect(
      database
        .prepare(
          `SELECT status, completed_at FROM distillation_runs
           WHERE id = '11111111-1111-4111-8111-111111111111'`,
        )
        .get(),
    ).toEqual({ completed_at: clock.now(), status: "failed" });
    expect(
      database
        .prepare(
          `SELECT status, completed_at FROM retention_runs
           WHERE id = '22222222-2222-4222-8222-222222222222'`,
        )
        .get(),
    ).toEqual({ completed_at: clock.now(), status: "failed" });
    database.close();
  });

  it("waits for the selected Episode merge window before closing a recent event", () => {
    const { clock, database, service } = harness();
    service.recordEvent(
      { appName: "Notes", source: "active_app" },
      "user",
      clock.now(),
      clock.now(),
    );

    service.distill();
    expect(service.getSnapshot("2026-08-10").episodes).toEqual([]);

    clock.advance(8 * 60_000 + 1);
    service.distill();
    const [episode] = service.getSnapshot("2026-08-10").episodes;
    expect(episode).toBeDefined();
    expect(service.getEpisode(episode!.id)).toEqual(episode);
    database.close();
  });

  it("redacts detected credentials before Activity persistence", () => {
    const { clock, database, service } = harness();
    service.recordEvent(
      {
        appName: "Notes",
        source: "active_app",
        windowTitle: "Token sk-activitysecret123456",
      },
      "user",
      clock.now(),
      clock.now(),
    );

    const stored = database
      .prepare("SELECT details_json FROM activity_events LIMIT 1")
      .get() as { details_json: string };
    expect(stored.details_json).not.toContain("activitysecret");
    expect(stored.details_json).toContain("[REDACTED]");
    database.close();
  });

  it("keeps one completed week in Activity without proposing long-term Memory", () => {
    const { database, memory, service } = harness();
    service.recordEvent(
      {
        appName: "Visual Studio Code",
        source: "active_app",
        windowTitle: "CharaMate",
      },
      "user",
      "2026-08-04T01:00:00.000Z",
      "2026-08-04T02:00:00.000Z",
    );
    service.recordEvent(
      {
        appName: "Visual Studio Code",
        source: "active_app",
        windowTitle: "CharaMate",
      },
      "user",
      "2026-08-06T01:00:00.000Z",
      "2026-08-06T02:00:00.000Z",
    );
    service.recordEvent(
      {
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        source: "agent_run",
        status: "completed",
        summary: "Agent 完成了后台任务",
      },
      "agent",
      "2026-08-06T03:00:00.000Z",
      "2026-08-06T03:05:00.000Z",
    );
    service.recordEvent(
      { appName: "Terminal", source: "active_app" },
      "agent",
      "2026-08-04T03:10:00.000Z",
      "2026-08-04T03:20:00.000Z",
    );
    service.recordEvent(
      { appName: "Terminal", source: "active_app" },
      "agent",
      "2026-08-06T03:10:00.000Z",
      "2026-08-06T03:20:00.000Z",
    );

    service.distill();

    const snapshot = service.getSnapshot("2026-08-04");
    expect(snapshot.episodes).toHaveLength(2);
    expect(snapshot.episodes.map(({ actor }) => actor).sort()).toEqual([
      "agent",
      "user",
    ]);
    expect(snapshot.digests.some(({ kind }) => kind === "daily")).toBe(true);
    expect(snapshot.digests.some(({ kind }) => kind === "weekly")).toBe(true);
    expect(memory.list({}).candidates).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT status FROM distillation_runs ORDER BY started_at DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ status: "completed" });
    database.close();
  });

  it("keeps multiweek Activity searchable with Daily and Weekly Digests without creating Memory candidates", () => {
    const { database, memory, repository, service } = harness(
      "2026-08-24T12:00:00.000Z",
    );
    try {
      recordEditorDays(service, ["04", "11", "18"]);
      service.recordEvent(
        { appName: "Terminal", source: "active_app" },
        "agent",
        "2026-08-18T03:00:00.000Z",
        "2026-08-18T04:00:00.000Z",
      );
      service.distill();

      const result = service.search({ query: "private-project" });
      expect(result).toMatchObject({
        observedBehaviorOnly: true,
        patterns: [
          {
            actor: "user",
            activeDays: 3,
            episodeCount: 3,
            kind: "app",
            label: "Visual Studio Code",
            totalMinutes: 180,
          },
        ],
      });
      expect(JSON.stringify(result.patterns)).not.toContain("private-project");
      const digests = repository.listDigests(
        "2026-08-01T00:00:00.000Z",
        "2026-08-25T00:00:00.000Z",
      );
      expect(digests.filter(({ kind }) => kind === "daily")).toHaveLength(3);
      expect(digests.filter(({ kind }) => kind === "weekly")).toHaveLength(3);
      for (const digest of digests) {
        expect(service.getDigest(digest.id)).toEqual(digest);
        expect(digest.summary).toContain("Visual Studio Code");
        expect(digest.candidateIds).toEqual([]);
      }
      expect(memory.list({}).candidates).toEqual([]);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM memory_candidates")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps repeated cross-day distillation and a reopened service free of new candidates", async () => {
    const first = harness("2026-08-17T12:00:00.000Z");
    let digests: ReturnType<ActivityRepository["listDigests"]>;
    try {
      recordEditorDays(first.service, ["04", "11"]);
      first.service.distill();
      first.service.distill();
      first.clock.advance(7 * 86_400_000);
      recordEditorDays(first.service, ["18"]);
      first.service.distill();
      digests = first.repository.listDigests(
        "2026-08-01T00:00:00.000Z",
        "2026-08-26T00:00:00.000Z",
      );
      expect(digests.filter(({ kind }) => kind === "weekly")).toHaveLength(3);
      expect(first.memory.list({}).candidates).toEqual([]);
    } finally {
      first.database.close();
    }

    const reopened = harness("2026-08-25T12:00:00.000Z", first.root);
    try {
      await reopened.service.initialize();
      reopened.service.distill();
      reopened.service.distill();
      expect(
        reopened.repository.listDigests(
          "2026-08-01T00:00:00.000Z",
          "2026-08-26T00:00:00.000Z",
        ),
      ).toEqual(digests);
      expect(
        reopened.service.search({ query: "Visual Studio Code" }).patterns,
      ).toEqual([expect.objectContaining({ activeDays: 3, episodeCount: 3 })]);
      expect(reopened.memory.list({}).candidates).toEqual([]);
      expect(
        reopened.database
          .prepare("SELECT COUNT(*) AS count FROM memory_candidates")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      reopened.database.close();
    }
  });

  it("preserves accepted Activity Memory revisions and actual sources through later weeks and service rebuild", async () => {
    const initial = (() => {
      const first = harness();
      try {
        recordEditorDays(first.service, ["04", "06"]);
        first.service.distill();
        const oldEpisodes = ["04", "06"].map(
          (day) => first.service.getSnapshot(`2026-08-${day}`).episodes[0]!,
        );
        const legacy = first.memory.propose({
          confidence: 0.6,
          content: "过去两个日期，用户累计使用 Visual Studio Code 120 分钟。",
          importance: 0.5,
          novelty: 1,
          reason: "Activity 跨日证据归纳：Visual Studio Code",
          sourceIds: oldEpisodes.map(({ id }) => id),
          sourceLabels: oldEpisodes.map(({ summary }) => summary),
          sourceType: "activity",
          type: "activity_digest",
        });
        const accepted = first.memory.acceptCandidate(legacy.id);
        const acceptedCandidate = first.database
          .prepare("SELECT * FROM memory_candidates WHERE id = ?")
          .get(legacy.id);
        first.clock.advance(14 * 86_400_000);
        recordEditorDays(first.service, ["11", "18"]);
        first.service.distill();
        first.service.distill();
        expect(first.memory.get(accepted.memory.id)).toEqual(accepted);
        expect(first.memory.list({}).candidates).toEqual([]);
        return { root: first.root, oldEpisodes, accepted, acceptedCandidate };
      } finally {
        first.database.close();
      }
    })();

    const { oldEpisodes, accepted, acceptedCandidate } = initial;
    const reopened = harness("2026-08-25T12:00:00.000Z", initial.root);
    try {
      await reopened.service.initialize();
      expect(reopened.memory.get(accepted.memory.id)).toEqual(accepted);
      expect(
        accepted.sources.map(({ referenceId }) => referenceId).sort(),
      ).toEqual(oldEpisodes.map(({ id }) => id).sort());
      for (const episode of oldEpisodes) {
        expect(reopened.service.getEpisode(episode.id)).toEqual(episode);
      }
      expect(reopened.memory.list({}).candidates).toEqual([]);
      expect(
        reopened.database.prepare("SELECT * FROM memory_candidates").all(),
      ).toEqual([acceptedCandidate]);
    } finally {
      reopened.database.close();
    }
  });

  it("preserves stored pending and rejected Activity candidates without refresh and retains user decisions", async () => {
    const initial = (() => {
      const first = harness();
      try {
        recordEditorDays(first.service, ["04"]);
        first.service.distill();
        const digest = first.service
          .getSnapshot("2026-08-04")
          .digests.find(({ kind }) => kind === "weekly")!;
        const propose = (label: string) =>
          first.memory.propose({
            confidence: 0.6,
            content: `旧活动来源中出现 ${label}。`,
            importance: 0.5,
            novelty: 1,
            reason: `Activity 跨日证据归纳：${label}`,
            sourceIds: [digest.id],
            sourceLabels: [digest.title],
            sourceType: "activity",
            type: "activity_digest",
          });
        const pending = propose("Visual Studio Code");
        const rejected = first.memory.rejectCandidate(propose("Safari").id);
        const laterRejected = propose("Notes");
        const stored = first.database
          .prepare("SELECT * FROM memory_candidates ORDER BY id")
          .all();
        first.clock.advance(14 * 86_400_000);
        recordEditorDays(first.service, ["11", "18"]);
        first.service.distill();
        expect(
          first.database
            .prepare("SELECT * FROM memory_candidates ORDER BY id")
            .all(),
        ).toEqual(stored);
        return {
          root: first.root,
          digest,
          pending,
          rejected,
          laterRejected,
          stored,
        };
      } finally {
        first.database.close();
      }
    })();

    const { digest, pending, rejected, laterRejected, stored } = initial;
    const reopened = harness("2026-08-25T12:00:00.000Z", initial.root);
    try {
      await reopened.service.initialize();
      expect(
        reopened.database
          .prepare("SELECT * FROM memory_candidates ORDER BY id")
          .all(),
      ).toEqual(stored);
      expect(
        reopened.memory
          .list({})
          .candidates.map(({ id }) => id)
          .sort(),
      ).toEqual([pending.id, laterRejected.id].sort());
      const accepted = reopened.memory.acceptCandidate(pending.id);
      expect(accepted.revisions[0]?.content).toBe(pending.content);
      expect(accepted.sources[0]?.referenceId).toBe(digest.id);
      expect(reopened.service.getDigest(digest.id)).toEqual(digest);
      expect(reopened.memory.rejectCandidate(laterRejected.id).status).toBe(
        "rejected",
      );
      expect(
        reopened.database
          .prepare(
            "SELECT status, updated_at FROM memory_candidates WHERE id = ?",
          )
          .get(rejected.id),
      ).toEqual({ status: "rejected", updated_at: rejected.updatedAt });
      expect(reopened.memory.list({}).candidates).toEqual([]);
      expect(
        reopened.database
          .prepare("SELECT COUNT(*) AS count FROM memory_candidates")
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      reopened.database.close();
    }
  });

  it("reads historical Digest candidate links and removes only pending candidates when their Episode is deleted", async () => {
    const initial = (() => {
      const first = harness();
      try {
        recordEditorDays(first.service, ["04"]);
        first.service.distill();
        const snapshot = first.service.getSnapshot("2026-08-04");
        const episode = snapshot.episodes[0]!;
        const digest = snapshot.digests.find(({ kind }) => kind === "weekly")!;
        const proposal = {
          confidence: 0.6,
          content: "一段已保存的活动观察。",
          importance: 0.5,
          novelty: 1,
          reason: "Activity 跨日证据归纳：Visual Studio Code",
          sourceIds: [digest.id],
          sourceLabels: [digest.title],
          sourceType: "activity" as const,
          type: "activity_digest" as const,
        };
        const acceptedCandidate = first.memory.propose(proposal);
        const accepted = first.memory.acceptCandidate(acceptedCandidate.id);
        const pending = first.memory.propose({
          ...proposal,
          content: "一段待确认的活动观察。",
        });
        // Stored links from the removed producer: fixture data, not a new writer API.
        const candidateIds = [acceptedCandidate.id, pending.id];
        first.database
          .prepare(
            "UPDATE activity_digests SET candidate_ids_json = ? WHERE id = ?",
          )
          .run(JSON.stringify(candidateIds), digest.id);
        return {
          root: first.root,
          episode,
          digest,
          acceptedCandidate,
          accepted,
          pending,
          candidateIds,
        };
      } finally {
        first.database.close();
      }
    })();

    const {
      episode,
      digest,
      acceptedCandidate,
      accepted,
      pending,
      candidateIds,
    } = initial;
    const reopened = harness("2026-08-11T12:00:00.000Z", initial.root);
    try {
      await reopened.service.initialize();
      expect(reopened.service.getDigest(digest.id).candidateIds).toEqual(
        candidateIds,
      );
      expect(
        reopened.service
          .getSnapshot("2026-08-04")
          .digests.find(({ id }) => id === digest.id)?.candidateIds,
      ).toEqual(candidateIds);
      await reopened.service.deleteEpisode(episode.id);
      expect(reopened.memory.get(accepted.memory.id)).toEqual(accepted);
      expect(
        reopened.database
          .prepare("SELECT status FROM memory_candidates WHERE id = ?")
          .get(acceptedCandidate.id),
      ).toEqual({ status: "accepted" });
      expect(
        reopened.database
          .prepare("SELECT id FROM memory_candidates WHERE id = ?")
          .get(pending.id),
      ).toBeUndefined();
      expect(reopened.memory.list({}).candidates).toEqual([]);
      expect(() => reopened.service.getEpisode(episode.id)).toThrow(
        "找不到这段活动",
      );
    } finally {
      reopened.database.close();
    }
  });

  it("keeps different windows in the same application as separate Episodes", () => {
    const { database, service } = harness();
    service.recordEvent(
      {
        appName: "Visual Studio Code",
        source: "active_app",
        windowTitle: "project-a",
      },
      "user",
      "2026-08-10T01:00:00.000Z",
      "2026-08-10T01:10:00.000Z",
    );
    service.recordEvent(
      {
        appName: "Visual Studio Code",
        source: "active_app",
        windowTitle: "project-b",
      },
      "user",
      "2026-08-10T01:11:00.000Z",
      "2026-08-10T01:20:00.000Z",
    );

    service.distill();

    expect(service.getSnapshot("2026-08-10").episodes).toHaveLength(2);
    database.close();
  });

  it("folds a Managed Browser page observation into the foreground Episode", () => {
    const { database, service } = harness();
    service.recordEvent(
      { appName: "Chromium", source: "active_app" },
      "user",
      "2026-08-04T01:00:00.000Z",
      "2026-08-04T02:00:00.000Z",
    );
    service.recordEvent(
      {
        domain: "example.com",
        source: "managed_browser",
        title: "Example documentation",
        url: "https://example.com/docs",
      },
      "user",
      "2026-08-04T01:30:00.000Z",
      "2026-08-04T01:30:00.000Z",
    );

    service.distill();

    const episodes = service.getSnapshot("2026-08-04").episodes;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      domains: ["example.com"],
      eventCount: 2,
      sourceTypes: ["active_app", "managed_browser"],
    });
    expect(episodes[0]?.summary).toContain("Example documentation");
    database.close();
  });

  it("waits for an overlapping foreground event before distilling a browser observation", () => {
    const { clock, database, service } = harness();
    const foregroundId = service.startEvent(
      { appName: "Chromium", source: "active_app" },
      "user",
    );
    expect(foregroundId).toBeDefined();
    clock.advance(60_000);
    service.recordEvent(
      {
        domain: "example.com",
        source: "managed_browser",
        title: "Example documentation",
        url: "https://example.com/docs",
      },
      "user",
    );

    clock.advance(8 * 60_000 + 1);
    service.distill();
    expect(service.getSnapshot("2026-08-10").episodes).toEqual([]);

    service.finishEvent(foregroundId!);
    clock.advance(8 * 60_000 + 1);
    service.distill();

    expect(service.getSnapshot("2026-08-10").episodes).toMatchObject([
      {
        domains: ["example.com"],
        eventCount: 2,
        sourceTypes: ["active_app", "managed_browser"],
      },
    ]);
    database.close();
  });

  it("never removes undistilled evidence and makes distilled raw cleanup explicit", async () => {
    const { database, service } = harness();
    service.recordEvent(
      { appName: "Calendar", source: "active_app" },
      "user",
      "2026-08-09T09:00:00.000Z",
      "2026-08-09T09:30:00.000Z",
    );
    service.recordEvent(
      { appName: "Notes", source: "active_app" },
      "user",
      "2026-08-10T09:00:00.000Z",
      "2026-08-10T09:30:00.000Z",
    );
    const first = await service.cleanup();
    expect(first.deletedEvents).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM activity_events").get(),
    ).toEqual({ count: 2 });

    service.distill();
    const second = await service.cleanup();
    expect(second.deletedEvents).toBe(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM activity_events").get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT status FROM retention_runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ status: "completed" });
    database.close();
  });

  it("preserves real sources during initialization until retention owners are ready", async () => {
    const { assets, clock, database, repository, service } = harness();
    const eventId = service.recordEvent(
      {
        source: "active_app",
        appName: "Synthetic fixture",
        surface: visualSurfaceFixture,
      },
      "user",
    )!;
    service.setVisualContext({
      actor: "user",
      surface: visualSurfaceFixture,
      eventId,
    });
    const captured = (await service.recordVisualFrame(
      await visualFrameFixture(),
      "foreground",
    ))!;
    clock.advance(40 * 86_400_000);
    service.setSourceRetentionGuard(undefined);

    await service.initialize();
    const result = await service.cleanup();

    expect(result).toMatchObject({ deletedAssets: 0, deletedEvents: 0 });
    expect(service.getEvent(eventId)).toBeDefined();
    expect(service.getEvent(captured.event.id)).toBeDefined();
    const asset = repository.getAsset(captured.reference.artifactId)!;
    expect(existsSync(assets.resolve(asset))).toBe(true);
    expect(service.resolveEventReference(eventId).episodeId).toBeDefined();
    expect(
      await service.resolveVisualEvidence(captured.reference),
    ).toMatchObject({ status: "available" });
    database.close();
  });

  it("protects a pending source and its shared PNG across capacity and age cleanup, then releases them", async () => {
    const { assets, clock, database, repository, service } = harness();
    async function observe(epoch: string) {
      const surface = { ...visualSurfaceFixture, epoch };
      const eventId = service.recordEvent(
        { source: "active_app", appName: "Synthetic fixture", surface },
        "user",
      )!;
      service.setVisualContext({ actor: "user", surface, eventId });
      const frame = await visualFrameFixture();
      const observation = (await service.recordVisualFrame(
        {
          ...frame,
          visual: {
            ...frame.visual,
            surface,
            capturedAt: clock.now(),
            receivedAt: clock.now(),
          },
        },
        "foreground",
      ))!;
      return { ...observation, eventId };
    }
    const first = await observe("first");
    clock.advance(86_400_000);
    const second = await observe("second");
    expect(first.reference.artifactId).toBe(second.reference.artifactId);
    clock.advance(86_400_000);
    service.distill();
    // Simulate the storage accounting pressure, without allocating a 600 MiB test file.
    database
      .prepare("UPDATE activity_assets SET byte_length = ? WHERE id = ?")
      .run(600 * 1024 * 1024, first.reference.artifactId);
    const retained = new Set([first.eventId, second.event.id]);
    const guard = vi.fn(
      (ids: readonly string[]) => new Set(ids.filter((id) => retained.has(id))),
    );
    service.setSourceRetentionGuard(guard);

    const pressured = await service.cleanup(false);
    expect(pressured).toMatchObject({ deletedAssets: 0, deletedEvents: 0 });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(new Set(guard.mock.calls[0]![0])).toEqual(
      new Set([first.event.id, second.event.id]),
    );
    expect(await service.resolveVisualEvidence(second.reference)).toMatchObject(
      { status: "available" },
    );

    clock.advance(40 * 86_400_000);
    const aged = await service.cleanup(false);
    expect(aged).toMatchObject({ deletedAssets: 0, deletedEvents: 2 });
    expect(service.getEvent(first.eventId)).toBeDefined();
    expect(service.getEvent(second.event.id)).toBeDefined();
    expect(service.getEvent(first.event.id)).toBeUndefined();
    expect(service.getEvent(second.eventId)).toBeUndefined();
    const assetPath = assets.resolve(
      repository.getAsset(second.reference.artifactId)!,
    );
    expect(existsSync(assetPath)).toBe(true);

    // Canonical downstream snapshots are now durable; the integration owner releases protection.
    retained.clear();
    const released = await service.cleanup(false);
    expect(released).toMatchObject({ deletedAssets: 1, deletedEvents: 2 });
    expect(existsSync(assetPath)).toBe(false);
    expect(await service.resolveVisualEvidence(second.reference)).toMatchObject(
      { status: "unavailable", reason: "source_missing" },
    );
    database.close();
  });

  it("leaves original sources intact when the downstream retention lookup fails", async () => {
    const { database, service } = harness();
    const eventId = service.recordEvent(
      { source: "active_app", appName: "Synthetic fixture" },
      "user",
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:30:00.000Z",
    )!;
    service.distill();
    service.setSourceRetentionGuard(() => {
      throw new Error("Source owner is unavailable");
    });

    await expect(service.cleanup(false)).rejects.toThrow(
      "Source owner is unavailable",
    );
    expect(service.getEvent(eventId)).toBeDefined();
    expect(database.prepare("SELECT status FROM retention_runs").get()).toEqual(
      { status: "failed" },
    );
    database.close();
  });

  it("removes distilled files and raw rows without deleting accepted Memory evidence", async () => {
    const { clock, database, memory, repository, root, service } = harness();
    const assetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const storageKey = `${assetId}.png`;
    const assetDirectory = path.join(root, "activity-assets");
    const assetPath = path.join(assetDirectory, storageKey);
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(assetPath, "test image bytes");
    repository.insertAsset({
      byteLength: 16,
      createdAt: "2026-08-04T01:30:00.000Z",
      height: 1,
      id: assetId,
      mediaType: "image/png",
      sha256: "0".repeat(64),
      storageKey,
      width: 1,
    });
    service.recordEvent(
      { appName: "Visual Studio Code", source: "active_app" },
      "user",
      "2026-08-04T01:00:00.000Z",
      "2026-08-04T02:00:00.000Z",
    );
    service.recordEvent(
      {
        artifactId: assetId,
        height: 1,
        mediaType: "image/png",
        source: "screenshot",
        storageKey,
        width: 1,
      },
      "user",
      "2026-08-04T01:30:00.000Z",
      "2026-08-04T01:30:00.000Z",
    );
    service.recordEvent(
      { appName: "Visual Studio Code", source: "active_app" },
      "user",
      "2026-08-06T01:00:00.000Z",
      "2026-08-06T02:00:00.000Z",
    );
    service.distill();
    const sourceIds = new CryptoIdGenerator();
    const episodes = [
      ...service.getSnapshot("2026-08-04").episodes,
      ...service.getSnapshot("2026-08-06").episodes,
    ];
    const accepted = memory.create({
      confidence: 1,
      content: "过去两个不同日期，用户使用了 Visual Studio Code。",
      importance: 0.5,
      reason: "既有已接受 Activity Memory",
      sources: episodes.map((episode) => ({
        createdAt: episode.createdAt,
        id: sourceIds.generate(),
        label: episode.summary,
        referenceId: episode.id,
        type: "activity",
      })),
      type: "activity_digest",
    });
    const sourceSnapshot = accepted.sources;

    await service.cleanup();
    expect(existsSync(assetPath)).toBe(false);
    expect(repository.getAsset(assetId)).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM activity_events").get(),
    ).toEqual({ count: 0 });

    clock.advance(100 * 86_400_000);
    await service.cleanup(false);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM activity_episodes").get(),
    ).toEqual({ count: 0 });
    expect(memory.get(accepted.memory.id).sources).toEqual(sourceSnapshot);
    expect(sourceSnapshot.every(({ label }) => Boolean(label))).toBe(true);
    database.close();
  });

  it("removes a distilled screenshot event with its expired asset", async () => {
    const { database, repository, root, service } = harness();
    const assetId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const storageKey = `${assetId}.png`;
    const assetDirectory = path.join(root, "activity-assets");
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(path.join(assetDirectory, storageKey), "expired image");
    repository.insertAsset({
      byteLength: 13,
      createdAt: "2026-08-01T01:30:00.000Z",
      height: 1,
      id: assetId,
      mediaType: "image/png",
      sha256: "0".repeat(64),
      storageKey,
      width: 1,
    });
    service.recordEvent(
      { appName: "Notes", source: "active_app" },
      "user",
      "2026-08-01T01:00:00.000Z",
      "2026-08-01T02:00:00.000Z",
    );
    service.recordEvent(
      {
        artifactId: assetId,
        height: 1,
        mediaType: "image/png",
        source: "screenshot",
        storageKey,
        width: 1,
      },
      "user",
      "2026-08-01T01:30:00.000Z",
      "2026-08-01T01:30:00.000Z",
    );
    service.distill();

    const result = await service.cleanup(false);

    expect(result).toMatchObject({ deletedAssets: 1, deletedEvents: 1 });
    expect(
      database
        .prepare("SELECT source FROM activity_events ORDER BY source")
        .all(),
    ).toEqual([{ source: "active_app" }]);
    expect(repository.getAsset(assetId)).toBeUndefined();
    database.close();
  });

  it("rolls back screenshot metadata when its event cannot be persisted", () => {
    const { clock, database, repository } = harness();
    const duplicateEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    repository.insertEvent(
      {
        actor: "user",
        details: { appName: "Notes", source: "active_app" },
        endedAt: clock.now(),
        id: duplicateEventId,
        startedAt: clock.now(),
      },
      clock.now(),
    );
    const assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    expect(() =>
      repository.insertScreenshot(
        {
          byteLength: 12,
          createdAt: clock.now(),
          height: 1,
          id: assetId,
          mediaType: "image/png",
          sha256: "0".repeat(64),
          storageKey: `${assetId}.png`,
          width: 1,
        },
        {
          actor: "user",
          details: {
            artifactId: assetId,
            height: 1,
            mediaType: "image/png",
            source: "screenshot",
            storageKey: `${assetId}.png`,
            width: 1,
          },
          endedAt: clock.now(),
          id: duplicateEventId,
          startedAt: clock.now(),
        },
        clock.now(),
      ),
    ).toThrow();
    expect(repository.getAsset(assetId)).toBeUndefined();
    database.close();
  });

  it("rebuilds one daily digest when delayed evidence arrives", () => {
    const { database, service } = harness();
    service.recordEvent(
      { appName: "Calendar", source: "active_app" },
      "user",
      "2026-08-04T09:00:00.000Z",
      "2026-08-04T09:30:00.000Z",
    );
    service.distill();
    service.recordEvent(
      { appName: "Notes", source: "active_app" },
      "user",
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T10:30:00.000Z",
    );
    service.distill();

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM activity_digests WHERE kind = 'daily'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM activity_digest_evidence e
           JOIN activity_digests d ON d.id = e.digest_id
           WHERE d.kind = 'daily'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(service.getSnapshot("2026-08-04").digests[0]?.summary).toContain(
      "Notes",
    );
    database.close();
  });

  it("makes the remaining Episodes eligible for digest rebuild after deletion", async () => {
    const { database, service } = harness();
    service.recordEvent(
      { appName: "Calendar", source: "active_app" },
      "user",
      "2026-08-04T09:00:00.000Z",
      "2026-08-04T09:30:00.000Z",
    );
    service.recordEvent(
      { appName: "Notes", source: "active_app" },
      "user",
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T10:30:00.000Z",
    );
    service.distill();
    const episodes = service.getSnapshot("2026-08-04").episodes;
    expect(episodes).toHaveLength(2);

    const updated = await service.deleteEpisode(episodes[0]!.id);

    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM activity_episodes e
           LEFT JOIN activity_digests d ON d.id = e.digest_id
           WHERE e.digest_id IS NOT NULL AND d.id IS NULL`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM activity_episodes WHERE digest_id IS NULL",
        )
        .get(),
    ).toEqual({ count: 0 });
    const rebuiltDaily = updated.digests.filter(({ kind }) => kind === "daily");
    expect(rebuiltDaily).toHaveLength(1);
    expect(rebuiltDaily[0]?.episodeIds).toHaveLength(1);
    database.close();
  });

  it("rebuilds a weekly Digest without creating a Memory candidate", async () => {
    const { database, memory, service } = harness();
    for (const day of ["04", "05", "06"]) {
      service.recordEvent(
        { appName: "Visual Studio Code", source: "active_app" },
        "user",
        `2026-08-${day}T09:00:00.000Z`,
        `2026-08-${day}T10:00:00.000Z`,
      );
    }
    service.distill();
    expect(memory.list({}).candidates).toEqual([]);
    const deletedEpisode = service.getSnapshot("2026-08-04").episodes[0]!;

    await service.deleteEpisode(deletedEpisode.id);

    expect(memory.list({}).candidates).toEqual([]);
    const weekly = database
      .prepare(
        "SELECT candidate_ids_json FROM activity_digests WHERE kind = 'weekly'",
      )
      .get() as { candidate_ids_json: string };
    expect(JSON.parse(weekly.candidate_ids_json)).toEqual([]);
    database.close();
  });

  it("sweeps orphan assets while keeping stable Episode summaries", async () => {
    const { assets, database, root, service } = harness();
    const assetDirectory = path.join(root, "activity-assets");
    writeFileSync(path.join(root, "placeholder"), "ready");
    await assets.sweep(new Set());
    writeFileSync(path.join(root, "placeholder"), "ready");
    const orphan = path.join(assetDirectory, "orphan.png");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(assetDirectory, { recursive: true }),
    );
    writeFileSync(orphan, "orphan");

    await service.cleanup(false);

    expect(existsSync(orphan)).toBe(false);
    database.close();
  });
});
