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

import { afterEach, describe, expect, it } from "vitest";

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

function harness(now = "2026-08-10T12:00:00.000Z") {
  const root = mkdtempSync(path.join(os.tmpdir(), "charamate-activity-"));
  roots.push(root);
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
  const captureCalls: unknown[] = [];
  const captureBytes = Buffer.from("activity-screenshot-png");
  const service = new ActivityService(
    repository,
    memory,
    assets,
    {
      capturePrimaryDisplay: (options) => {
        captureCalls.push(options);
        return Promise.resolve({
          bytes: captureBytes,
          height: 1,
          mediaType: "image/png" as const,
          width: 1,
        });
      },
    },
    ids,
    clock,
    "Asia/Shanghai",
  );
  return {
    assets,
    captureBytes,
    captureCalls,
    clock,
    database,
    memory,
    repository,
    root,
    service,
  };
}

describe("Activity persistence and distillation", () => {
  it("captures Activity screenshots at logical resolution without re-encoding", async () => {
    const { captureBytes, captureCalls, database, root, service } = harness();

    await service.captureScreenshot("user");

    expect(captureCalls).toEqual([{ resolution: "logical" }]);
    const row = database
      .prepare(
        "SELECT storage_key FROM activity_assets ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { storage_key: string };
    expect(
      readFileSync(path.join(root, "activity-assets", row.storage_key)),
    ).toEqual(captureBytes);
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

  it("searches compact Activity observations and proposes a two-Weekly-Digest stable pattern", () => {
    const { database, memory, service } = harness("2026-08-24T12:00:00.000Z");
    for (const day of ["04", "11", "18"]) {
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
          activeDays: 3,
          episodeCount: 3,
          kind: "app",
          label: "Visual Studio Code",
          totalMinutes: 180,
        },
      ],
    });
    expect(JSON.stringify(result.patterns)).not.toContain("private-project");
    const candidate = memory.list({}).candidates[0]!;
    const weeklyIds = new Set(
      database
        .prepare("SELECT id FROM activity_digests WHERE kind = 'weekly'")
        .all()
        .map((row) => (row as { id: string }).id),
    );
    expect(candidate).toMatchObject({
      content:
        "用户在多个自然周持续使用 Visual Studio Code。这是观察到的使用习惯，不等同于用户明确表达的偏好。",
      sourceType: "activity",
      type: "activity_digest",
    });
    expect(candidate.sourceIds).toHaveLength(2);
    expect(candidate.sourceIds.every((id) => weeklyIds.has(id))).toBe(true);
    expect(candidate.sourceLabels.join(" ")).not.toContain("private-project");
    database.close();
  });

  it("refreshes one pending stable pattern to the latest two weeks without accumulating sources", () => {
    const { clock, database, memory, service } = harness(
      "2026-08-17T12:00:00.000Z",
    );
    for (const day of ["04", "11"]) {
      service.recordEvent(
        { appName: "Visual Studio Code", source: "active_app" },
        "user",
        `2026-08-${day}T01:00:00.000Z`,
        `2026-08-${day}T02:00:00.000Z`,
      );
    }
    service.distill();
    const original = memory.list({}).candidates[0]!;
    expect(original.sourceIds).toHaveLength(2);

    clock.advance(7 * 86_400_000);
    service.recordEvent(
      { appName: "Visual Studio Code", source: "active_app" },
      "user",
      "2026-08-18T01:00:00.000Z",
      "2026-08-18T02:00:00.000Z",
    );
    service.distill();

    const refreshed = memory.list({}).candidates;
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.id).not.toBe(original.id);
    expect(refreshed[0]?.sourceIds).toHaveLength(2);
    expect(refreshed[0]?.sourceIds).not.toContain(original.sourceIds[0]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM activity_digests
           WHERE candidate_ids_json LIKE ?`,
        )
        .get(`%${refreshed[0]!.id}%`),
    ).toEqual({ count: 2 });
    database.close();
  });

  it("offers one user-confirmed compact revision for an accepted legacy Activity Memory", () => {
    const { database, memory, service } = harness("2026-08-24T12:00:00.000Z");
    const legacy = memory.propose({
      confidence: 0.6,
      content: "过去 18 个不同日期，用户累计使用 Visual Studio Code 920 分钟。",
      importance: 0.5,
      novelty: 1,
      reason: "Activity 跨日证据归纳：Visual Studio Code",
      sourceIds: [
        "81000000-0000-4000-8000-000000000001",
        "81000000-0000-4000-8000-000000000002",
      ],
      sourceLabels: ["旧 Episode 1", "旧 Episode 2"],
      sourceType: "activity",
      type: "activity_digest",
    });
    const accepted = memory.acceptCandidate(legacy.id);
    for (const day of ["11", "18"]) {
      service.recordEvent(
        { appName: "Visual Studio Code", source: "active_app" },
        "user",
        `2026-08-${day}T01:00:00.000Z`,
        `2026-08-${day}T02:00:00.000Z`,
      );
    }

    service.distill();

    const replacement = memory.list({}).candidates[0]!;
    expect(replacement).toMatchObject({
      claimOperation: "replace",
      supersedesMemoryId: accepted.memory.id,
    });
    expect(replacement.sourceIds).toHaveLength(2);
    const revised = memory.acceptCandidate(replacement.id);
    expect(revised.memory.id).toBe(accepted.memory.id);
    expect(
      revised.revisions.find(
        ({ id }) => id === revised.memory.currentRevisionId,
      )?.content,
    ).toBe(
      "用户在多个自然周持续使用 Visual Studio Code。这是观察到的使用习惯，不等同于用户明确表达的偏好。",
    );

    service.distill();
    expect(memory.list({}).candidates).toEqual([]);
    database.close();
  });

  it("keeps a rejected stable Activity pattern suppressed across label casing changes", () => {
    const { clock, database, memory, service } = harness(
      "2026-08-24T12:00:00.000Z",
    );
    for (const day of ["11", "18"]) {
      service.recordEvent(
        { appName: "Visual Studio Code", source: "active_app" },
        "user",
        `2026-08-${day}T01:00:00.000Z`,
        `2026-08-${day}T02:00:00.000Z`,
      );
    }
    service.distill();
    const candidate = memory.list({}).candidates[0]!;
    memory.rejectCandidate(candidate.id);

    service.distill();
    clock.advance(7 * 86_400_000);
    service.recordEvent(
      { appName: "visual studio code", source: "active_app" },
      "user",
      "2026-08-25T01:00:00.000Z",
      "2026-08-25T02:00:00.000Z",
    );
    service.distill();

    expect(memory.list({}).candidates).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_candidates
           WHERE reason = ?`,
        )
        .get(candidate.reason),
    ).toEqual({ count: 1 });
    database.close();
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
