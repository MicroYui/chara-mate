import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ActivityRepository } from "../../src/main/activity/activityRepository";
import { distillEpisodes } from "../../src/main/activity/activityDistillation";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import { EvolutionRepository } from "../../src/main/evolution/evolutionRepository";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import type { ActivityEvent } from "../../src/shared/contracts/activity";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { Run } from "../../src/shared/contracts/run";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import {
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  runEventEnvelopeFixture,
  runFixture,
} from "../fixtures/foundationContracts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const completedRun = {
  ...runFixture,
  endedAt: FIXTURE_TIMESTAMPS.updated,
  latestSequence: 2,
  source: "voice",
  status: "completed",
} satisfies Run;

const completedRunEnvelope = {
  event: { run: completedRun, type: "run.completed" },
  occurredAt: FIXTURE_TIMESTAMPS.updated,
  sequence: 2,
  streamId: FIXTURE_IDS.run,
} satisfies RunEventEnvelope;

function localDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

test("uses Memory and Activity through the typed desktop boundary", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-memory-activity-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    const date = localDate();
    const now = `${date}T12:00:00.000Z`;
    const database = openApplicationDatabase(
      path.join(userDataDirectory, "charamate.sqlite"),
    );
    const ids = new CryptoIdGenerator();
    const clock = new FakeClock(now);
    const memories = new MemoryRepository(database);
    const memory = new MemoryService(
      memories,
      new LexicalRetrievalPipeline(database, memories, clock),
      ids,
      clock,
    );
    const activity = new ActivityRepository(database);
    activity.initialize(now);
    const screenshotId = randomUUID();
    const screenshotStorageKey = `${screenshotId}.png`;
    const screenshotBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2m6kAAAAASUVORK5CYII=",
      "base64",
    );
    await mkdir(path.join(userDataDirectory, "activity", "assets"), {
      recursive: true,
    });
    await writeFile(
      path.join(userDataDirectory, "activity", "assets", screenshotStorageKey),
      screenshotBytes,
    );
    activity.insertAsset({
      byteLength: screenshotBytes.byteLength,
      createdAt: now,
      height: 1,
      id: screenshotId,
      mediaType: "image/png",
      sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
      storageKey: screenshotStorageKey,
      width: 1,
    });
    const event: ActivityEvent = {
      actor: "user",
      details: {
        appName: "Visual Studio Code",
        source: "active_app",
        windowTitle: "CharaMate Phase 3",
      },
      endedAt: `${date}T10:30:00.000Z`,
      id: randomUUID(),
      startedAt: `${date}T09:30:00.000Z`,
    };
    const screenshot: ActivityEvent = {
      actor: "user",
      details: {
        artifactId: screenshotId,
        height: 1,
        mediaType: "image/png",
        source: "screenshot",
        storageKey: screenshotStorageKey,
        width: 1,
      },
      endedAt: `${date}T10:00:00.000Z`,
      id: randomUUID(),
      startedAt: `${date}T10:00:00.000Z`,
    };
    activity.insertEvent(event, now);
    activity.insertEvent(screenshot, now);
    const [distilled] = distillEpisodes([event, screenshot], ids, now);
    if (!distilled) throw new Error("Missing Activity E2E Episode");
    activity.insertEpisodes([distilled]);
    memory.create({
      confidence: 1,
      content: "用户偏爱安静且有插座的咖啡馆。",
      importance: 0.8,
      reason: "Electron E2E fixture",
      sources: [
        {
          createdAt: distilled.episode.startedAt,
          id: randomUUID(),
          label: "Visual Studio Code Episode",
          referenceId: distilled.episode.id,
          type: "activity",
        },
      ],
      type: "preference",
    });
    database.close();

    application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await application.firstWindow();

    await page.getByRole("button", { name: "Memory" }).click();
    await expect(
      page.getByRole("button", { name: /用户偏爱安静且有插座/u }),
    ).toBeVisible();
    await page.getByRole("button", { name: /用户偏爱安静且有插座/u }).click();
    await expect(
      page.getByRole("heading", {
        name: "用户偏爱安静且有插座的咖啡馆。",
      }),
    ).toBeVisible();

    await page
      .getByRole("button", {
        name: /Activity Visual Studio Code Episode/u,
      })
      .click();
    await expect(page.getByLabel("摘要")).toHaveValue(
      "Visual Studio Code：CharaMate Phase 3",
    );
    const episodeResponse = await page.evaluate(
      (episodeId) => window.charaMate.activity.getEpisode({ episodeId }),
      distilled.episode.id,
    );
    expect(episodeResponse).toMatchObject({
      ok: true,
      value: {
        screenshotStorageKeys: [screenshotStorageKey],
      },
    });
    const snapshotResponse = await page.evaluate(
      (snapshotDate) =>
        window.charaMate.activity.getSnapshot({ date: snapshotDate }),
      date,
    );
    expect(snapshotResponse).toMatchObject({
      ok: true,
      value: { episodes: [{ id: distilled.episode.id }] },
    });
    const screenshotImage = page
      .getByRole("main")
      .getByRole("complementary")
      .getByRole("img", { name: "Visual Studio Code 截图" });
    await expect(screenshotImage).toBeVisible();
    await expect
      .poll(() =>
        screenshotImage.evaluate(
          (image: HTMLImageElement) => image.naturalWidth,
        ),
      )
      .toBe(1);
    await expect(page.getByLabel("标题")).toHaveValue("Visual Studio Code");
    await page.getByLabel("搜索 Activity").fill("不存在的活动");
    await expect(page.getByText("没有符合搜索条件的活动。")).toBeVisible();

    await page.getByRole("button", { name: "Memory" }).click();
    await page.getByRole("button", { name: /用户偏爱安静且有插座/u }).click();
    await page.getByRole("button", { name: "放入领地" }).click();
    await expect(page.getByTestId("territory-world-canvas")).toBeVisible();
    await expect(page.getByText(/喜欢的事/u).first()).toBeVisible();
    const territoryResponse = await page.evaluate(() =>
      window.charaMate.territory.getSnapshot(),
    );
    expect(territoryResponse).toMatchObject({
      ok: true,
      value: {
        candidates: [
          {
            sources: [
              {
                kind: "memory",
                label: "用户偏爱安静且有插座的咖啡馆。",
              },
            ],
            status: "failed",
          },
        ],
      },
    });

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByLabel("设置分类");
    await settings.getByRole("button", { name: "Activity" }).click();
    await expect(page.getByRole("heading", { name: "行为记录" })).toBeVisible();
    await page.getByRole("button", { name: "暂停采集" }).click();
    await expect(page.getByRole("status")).toContainText("Activity 已暂停");
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});

test("keeps failed Voice reviews compact and dismissible in Memory", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-memory-review-layout-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    const database = openApplicationDatabase(
      path.join(userDataDirectory, "charamate.sqlite"),
    );
    const chats = new ChatRepository(database);
    chats.insertChat(chatFixture);
    const runs = new RunRepository(database);
    runs.appendEvent({
      ...runEventEnvelopeFixture,
      event: {
        run: { ...runEventEnvelopeFixture.event.run, source: "voice" },
        type: "run.started",
      },
    });
    runs.appendEvent(completedRunEnvelope);
    const evolution = new EvolutionRepository(database);
    evolution.createReview({
      chatId: FIXTURE_IDS.chat,
      completedAt: FIXTURE_TIMESTAMPS.updated,
      createdAt: FIXTURE_TIMESTAMPS.created,
      error: {
        code: "PROVIDER.REQUEST_FAILED",
        message: "Provider 请求失败，请检查配置后重试。",
        retryable: true,
      },
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: FIXTURE_IDS.run,
      status: "failed",
      triggers: ["explicit_teaching"],
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    });
    database.close();

    application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await application.firstWindow();

    await page.getByRole("button", { name: "Memory" }).click();
    const candidates = page.getByRole("region", { name: "成长候选" });
    await expect(
      candidates.getByText("成长复盘未完成", { exact: true }),
    ).toBeVisible();
    await expect(candidates).toContainText("不影响现有 Memory。");

    const search = page.getByLabel("搜索记忆");
    const workspace = page.getByRole("region", { name: "Memory 工作区" });
    const [searchBox, workspaceBox, viewport] = await Promise.all([
      search.boundingBox(),
      workspace.boundingBox(),
      page.evaluate(() => ({ height: innerHeight, width: innerWidth })),
    ]);
    expect(searchBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(searchBox!.y).toBeLessThan(viewport.height * 0.25);
    expect(workspaceBox!.y).toBeGreaterThan(searchBox!.y);
    expect(workspaceBox!.height).toBeGreaterThan(viewport.height * 0.5);
    expect(workspaceBox!.y + workspaceBox!.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );

    await candidates.getByRole("button", { name: "关闭" }).click();
    await expect(candidates).toBeHidden();
    const reviewResponse = await page.evaluate((runId) => {
      return window.charaMate.evolution.list({ runId });
    }, FIXTURE_IDS.run);
    expect(reviewResponse).toMatchObject({
      ok: true,
      value: { reviews: [{ runId: FIXTURE_IDS.run, status: "skipped" }] },
    });
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
