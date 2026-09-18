import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeClock } from "../../../tests/fixtures/fakeClock";
import type { ActivityEvent } from "../../shared/contracts/activity";
import { openApplicationDatabase } from "../db/database";
import { MemoryRepository } from "../memory/memoryRepository";
import { MemoryService } from "../memory/memoryService";
import { ActivityAssetStore } from "./activityAssetStore";
import {
  ActivityRepository,
  type ActivityAssetRecord,
} from "./activityRepository";
import { ActivityService } from "./activityService";
import { visualPngFixture } from "./activityVisual.fixture";

const DAY = 86_400_000;
const NOW = "2026-08-10T12:00:00.000Z";
const roots: string[] = [];
type Harness = {
  root: string;
  database: ReturnType<typeof openApplicationDatabase>;
  clock: FakeClock;
  repository: ActivityRepository;
  assets: ActivityAssetStore;
  service: ActivityService;
};
const opened: Harness[] = [];
let serial = 0;
const ids = {
  generate: () =>
    `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
};
const daysAgo = (days: number) =>
  new Date(Date.parse(NOW) - days * DAY).toISOString();

function harness(existingRoot?: string): Harness {
  const root =
    existingRoot ?? mkdtempSync(path.join(os.tmpdir(), "activity-retention-"));
  if (!existingRoot) roots.push(root);
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const clock = new FakeClock(NOW);
  const repository = new ActivityRepository(database);
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
    "Asia/Shanghai",
  );
  service.setSourceRetentionGuard(() => new Set());
  const value = { root, database, clock, repository, assets, service };
  opened.push(value);
  return value;
}

afterEach(async () => {
  for (const h of opened.splice(0)) {
    await h.service.stopMaintenance().catch(() => undefined);
    if (h.database.open) h.database.close();
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function asset(h: Harness, age: number, logicalBytes?: number) {
  const record = await h.assets.save(
    ids.generate(),
    { bytes: visualPngFixture, mediaType: "image/png", width: 1, height: 1 },
    daysAgo(age),
  );
  // Capacity tests simulate byte accounting; they do not allocate 600 MiB files.
  h.repository.insertAsset(
    logicalBytes ? { ...record, byteLength: logicalBytes } : record,
  );
  return record;
}

function event(
  h: Harness,
  age: number,
  image?: ActivityAssetRecord,
  distilled = true,
) {
  const at = daysAgo(age);
  const value: ActivityEvent = {
    id: ids.generate(),
    actor: "unknown",
    startedAt: at,
    endedAt: at,
    details: image
      ? {
          source: "screenshot",
          artifactId: image.id,
          storageKey: image.storageKey,
          width: 1,
          height: 1,
          mediaType: "image/png",
        }
      : { source: "active_app", appName: "Synthetic fixture" },
  };
  h.repository.insertEvent(value, NOW);
  if (distilled)
    h.database
      .prepare("UPDATE activity_events SET distilled_at=? WHERE id=?")
      .run(NOW, value.id);
  return value;
}

function progress(h: Harness) {
  return h.database
    .prepare("SELECT * FROM retention_runs ORDER BY rowid DESC LIMIT 1")
    .get() as
    | {
        status: string;
        deleted_events: number;
        deleted_assets: number;
        error_json: string | null;
      }
    | undefined;
}

async function firstCommit(h: Harness, settled: () => boolean) {
  while (!progress(h)?.deleted_events && !settled()) await setImmediate();
  expect(settled()).toBe(false);
  expect(progress(h)?.deleted_events).toBeGreaterThan(0);
}

function rows(h: Harness) {
  return h.database.prepare("SELECT * FROM activity_events ORDER BY id").all();
}

describe("Activity source retirement", () => {
  it.each(["young", "protected"] as const)(
    "retires an old screenshot while a %s shared reference keeps its PNG",
    async (reason) => {
      const h = harness();
      const image = await asset(h, 10);
      const old = event(h, 10, image);
      const keep = event(h, reason === "young" ? 1 : 10, image);
      const raw = event(h, 10);
      const protectedIds = new Set(reason === "protected" ? [keep.id] : []);
      h.service.setSourceRetentionGuard(
        (references) =>
          new Set(references.filter((id) => protectedIds.has(id))),
      );

      await h.service.cleanup(false);
      expect(h.repository.getEvent(old.id)).toBeUndefined();
      expect(h.repository.getEvent(keep.id)).toBeDefined();
      expect(h.repository.getEvent(raw.id)).toBeDefined();
      expect(readFileSync(h.assets.resolve(image))).toEqual(visualPngFixture);

      protectedIds.clear();
      h.clock.advance(8 * DAY);
      await h.service.cleanup(false);
      expect(h.repository.getAsset(image.id)).toBeUndefined();
      expect(existsSync(h.assets.resolve(image))).toBe(false);
      expect(h.repository.getEvent(raw.id)).toBeDefined();
    },
  );

  it("does not invoke source guards for fresh or undistilled rows", async () => {
    const h = harness();
    h.database.transaction(() => {
      for (let index = 0; index < 1001; index++)
        event(h, index % 2 ? 0 : 40, undefined, index % 2 === 1);
    })();
    const before = rows(h);
    const guard = vi.fn<(values: readonly string[]) => Set<string>>(
      () => new Set(),
    );
    h.service.setSourceRetentionGuard(guard);
    await h.service.cleanup(false);
    expect(guard).not.toHaveBeenCalled();
    expect(rows(h)).toEqual(before);
  });

  it("rechecks a newly retained source after a committed page", async () => {
    const h = harness();
    const references = h.database.transaction(() =>
      Array.from({ length: 1001 }, () => event(h, 40)),
    )();
    const keep = references.at(-1)!;
    const protectedIds = new Set<string>();
    h.service.setSourceRetentionGuard(
      (values) => new Set(values.filter((id) => protectedIds.has(id))),
    );
    let settled = false;
    const task = h.service.cleanup(false).finally(() => {
      settled = true;
    });
    await firstCommit(h, () => settled);
    protectedIds.add(keep.id);
    await task;
    expect(rows(h)).toHaveLength(1);
    expect(h.repository.getEvent(keep.id)).toBeDefined();
  });

  it("can stop between pages even when no source is eligible", async () => {
    const h = harness();
    h.database.transaction(() => {
      for (let index = 0; index < 1001; index++) event(h, 0);
    })();
    const before = rows(h);
    const controller = new AbortController();
    const task = h.service.cleanup(false, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await setImmediate();
    controller.abort();
    expect(await task).toBe(controller.signal.reason);
    expect(progress(h)).toMatchObject({ status: "failed", deleted_events: 0 });
    expect(rows(h)).toEqual(before);
  });

  it("protects remaining pages when the retention owner disappears", async () => {
    const h = harness();
    h.database.transaction(() => {
      for (let i = 0; i < 1001; i++) event(h, 40);
    })();
    let settled = false;
    const task = h.service.cleanup(false).finally(() => {
      settled = true;
    });
    await firstCommit(h, () => settled);
    h.service.setSourceRetentionGuard(undefined);
    await task;
    expect(rows(h)).toHaveLength(1);
  });

  it.each(["protected", "undistilled"] as const)(
    "keeps capacity references when preflight finds a %s source",
    async (reason) => {
      const h = harness();
      const image = await asset(h, 1, 600 * 1024 * 1024);
      event(h, 1, image);
      const keep = event(h, 1, image, reason !== "undistilled");
      h.service.setSourceRetentionGuard(
        (values) =>
          new Set(
            values.filter((id) => reason === "protected" && id === keep.id),
          ),
      );
      const before = rows(h);
      await h.service.cleanup(false);
      expect(rows(h)).toEqual(before);
      expect(existsSync(h.assets.resolve(image))).toBe(true);
    },
  );

  it.each(["protection", "reference"] as const)(
    "retains the shared PNG when capacity retirement encounters a new %s",
    async (change) => {
      const h = harness();
      const image = await asset(h, 1, 600 * 1024 * 1024);
      const references = h.database.transaction(() =>
        Array.from({ length: 1001 }, () => event(h, 1, image)),
      )();
      const protectedIds = new Set<string>();
      h.service.setSourceRetentionGuard(
        (values) => new Set(values.filter((id) => protectedIds.has(id))),
      );
      let settled = false;
      const task = h.service.cleanup(false).finally(() => {
        settled = true;
      });
      await firstCommit(h, () => settled);
      const keep =
        change === "reference" ? event(h, 0, image, false) : references.at(-1)!;
      protectedIds.add(keep.id);
      const result = await task;
      expect(result).toMatchObject({
        deletedEvents: change === "reference" ? 1001 : 1000,
        deletedAssets: 0,
      });
      expect(h.repository.getEvent(keep.id)).toBeDefined();
      expect(h.repository.rawBytes()).toBe(600 * 1024 * 1024);
      expect(existsSync(h.assets.resolve(image))).toBe(true);
    },
  );

  it("stops the asset page once one release satisfies capacity", async () => {
    const h = harness();
    const first = await asset(h, 2, 300 * 1024 * 1024);
    const second = await asset(h, 1, 300 * 1024 * 1024);
    const expired = event(h, 1, first);
    const keep = event(h, 1, second);
    const guard = vi.fn<(values: readonly string[]) => Set<string>>(
      () => new Set(),
    );
    h.service.setSourceRetentionGuard(guard);
    await h.service.cleanup(false);
    expect(guard.mock.calls.flatMap((call) => call[0] ?? [])).not.toContain(
      keep.id,
    );
    expect(h.repository.getEvent(expired.id)).toBeUndefined();
    expect(h.repository.getEvent(keep.id)).toBeDefined();
    expect(existsSync(h.assets.resolve(first))).toBe(false);
    expect(readFileSync(h.assets.resolve(second))).toEqual(visualPngFixture);
  });

  it("records committed progress and resumes after stopping and reopening SQLite", async () => {
    let h = harness();
    h.database.transaction(() => {
      for (let i = 0; i < 1001; i++) event(h, 40);
    })();
    const controller = new AbortController();
    let settled = false;
    const task = h.service
      .cleanup(false, controller.signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await firstCommit(h, () => settled);
    controller.abort();
    expect(await task).toBe(controller.signal.reason);
    expect(progress(h)).toMatchObject({
      status: "failed",
      deleted_events: 1000,
    });
    const remaining = rows(h);
    h.database.close();
    h = harness(h.root);
    expect(rows(h)).toEqual(remaining);
    await h.service.cleanup(false);
    expect(rows(h)).toEqual([]);
  });

  it("stops the actual maintenance owner but still reports a concurrent file error", async () => {
    const h = harness();
    h.database.transaction(() => {
      for (let i = 0; i < 1001; i++) event(h, 40);
    })();
    const directory = path.join(h.root, "assets");
    mkdirSync(directory);
    const errors: unknown[] = [];
    const timer = vi.spyOn(globalThis, "setInterval");
    h.service.startMaintenance((error) => errors.push(error));
    const callback = timer.mock.calls[0]?.[0];
    if (typeof callback !== "function")
      throw new Error("Maintenance was not scheduled");
    callback();
    while (!progress(h)?.deleted_events) await setImmediate();
    renameSync(directory, `${directory}.saved`);
    writeFileSync(directory, "Synthetic file instead of asset directory");
    const failure = await h.service.stopMaintenance().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain("ENOTDIR");
    expect(errors).toEqual([failure]);
    expect(progress(h)?.error_json).toContain("ENOTDIR");
    rmSync(directory);
    renameSync(`${directory}.saved`, directory);
    await h.service.cleanup(false);
    expect(rows(h)).toEqual([]);
  });
});
