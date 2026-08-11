import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import type { Run, RunEventEnvelope } from "../../src/shared/contracts";
import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import {
  attachmentFixture,
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  messageFixture,
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
  status: "completed",
} satisfies Run;

const completedRunEventEnvelope = {
  event: { run: completedRun, type: "run.completed" },
  occurredAt: FIXTURE_TIMESTAMPS.updated,
  sequence: 2,
  streamId: FIXTURE_IDS.run,
} satisfies RunEventEnvelope;

test("launches through the typed preload boundary", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    const seedDatabase = openApplicationDatabase(
      path.join(userDataDirectory, "charamate.sqlite"),
    );
    const chats = new ChatRepository(seedDatabase);
    chats.insertChat(chatFixture);
    const runs = new RunRepository(seedDatabase);
    runs.appendEvent(runEventEnvelopeFixture);
    runs.appendEvent(completedRunEventEnvelope);
    chats.insertMessage(messageFixture);
    chats.insertAttachment(attachmentFixture);
    seedDatabase.close();

    application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await application.firstWindow();
    const backgroundState = await application.evaluate(
      ({ app, BrowserWindow }) => ({
        dockVisible:
          process.platform === "darwin"
            ? (app.dock?.isVisible() ?? null)
            : null,
        mode: process.env["CHARAMATE_TEST_BACKGROUND"],
        visibleWindows: BrowserWindow.getAllWindows().filter((window) =>
          window.isVisible(),
        ).length,
      }),
    );
    expect(backgroundState).toEqual({
      dockVisible: process.platform === "darwin" ? false : null,
      mode: "1",
      visibleWindows: 0,
    });
    await expect(
      page.getByRole("heading", { name: chatFixture.title }),
    ).toBeVisible();
    await expect(page.getByText(messageFixture.content)).toBeVisible();
    await expect(page.getByRole("button", { name: /已处理/u })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const bridgeShape = await page.evaluate(() => ({
      activityKeys: Object.keys(window.charaMate.activity).sort(),
      agentKeys: Object.keys(window.charaMate.agent).sort(),
      chatKeys: Object.keys(window.charaMate.chat).sort(),
      extensionKeys: Object.keys(window.charaMate.extensions).sort(),
      fileKeys: Object.keys(window.charaMate.files).sort(),
      foundationKeys: Object.keys(window.charaMate.foundation).sort(),
      memoryKeys: Object.keys(window.charaMate.memory).sort(),
      petKeys: Object.keys(window.charaMate.pet).sort(),
      providerKeys: Object.keys(window.charaMate.provider).sort(),
      rootKeys: Object.keys(window.charaMate).sort(),
      runEventKeys: Object.keys(window.charaMate.runEvents).sort(),
      settingsKeys: Object.keys(window.charaMate.settings).sort(),
      territoryKeys: Object.keys(window.charaMate.territory).sort(),
      voiceKeys: Object.keys(window.charaMate.voice).sort(),
      exposesRawIpcRenderer: "ipcRenderer" in window.charaMate,
      exposesSecretReader: "getApiKey" in window.charaMate.provider,
    }));
    expect(bridgeShape).toEqual({
      activityKeys: [
        "cleanup",
        "deleteEpisode",
        "getEpisode",
        "getSnapshot",
        "setPaused",
        "updateEpisode",
      ],
      agentKeys: [
        "cancel",
        "getPendingApproval",
        "resolveApproval",
        "resolveUserInput",
        "resume",
        "start",
        "steer",
        "subscribeOpenApproval",
      ],
      chatKeys: [
        "archive",
        "create",
        "delete",
        "getSnapshot",
        "list",
        "rename",
        "restore",
        "setPinned",
        "subscribeChanged",
      ],
      foundationKeys: ["getSnapshot", "markRendererReady"],
      extensionKeys: [
        "mcpDelete",
        "mcpList",
        "mcpRefresh",
        "mcpSave",
        "skillArchive",
        "skillGet",
        "skillList",
        "skillRefresh",
        "skillSave",
        "skillSetEnabled",
      ],
      fileKeys: ["getPathForFile"],
      memoryKeys: [
        "acceptCandidate",
        "archive",
        "create",
        "delete",
        "get",
        "list",
        "purge",
        "rejectCandidate",
        "restore",
        "revise",
        "setPinned",
      ],
      providerKeys: [
        "deleteProfile",
        "discoverModels",
        "listProfiles",
        "saveProfile",
        "testConnection",
      ],
      petKeys: [
        "getLibrary",
        "importFromFolder",
        "select",
        "setAnimationSpeed",
        "setScale",
        "subscribeChanged",
        "subscribeOpenMain",
      ],
      rootKeys: [
        "activity",
        "agent",
        "chat",
        "extensions",
        "files",
        "foundation",
        "memory",
        "pet",
        "provider",
        "runEvents",
        "settings",
        "territory",
        "voice",
      ],
      runEventKeys: ["replay", "subscribe"],
      settingsKeys: [
        "getSnapshot",
        "importBrowserCookies",
        "openManagedBrowser",
        "saveAgent",
        "saveVoice",
      ],
      territoryKeys: [
        "collectItem",
        "confirmImageCandidate",
        "editImageCandidate",
        "generateImageCandidate",
        "getSnapshot",
        "movePet",
        "placeItem",
        "retryImageCandidate",
        "selectScene",
      ],
      voiceKeys: [
        "end",
        "getActive",
        "preview",
        "quickStart",
        "report",
        "setMuted",
        "setPaused",
        "start",
        "subscribeChanged",
        "subscribeCommand",
      ],
      exposesRawIpcRenderer: false,
      exposesSecretReader: false,
    });

    await expect
      .poll(() =>
        application
          ?.windows()
          .map((window) => window.url())
          .some((url) => url.includes("character_window")),
      )
      .toBe(true);
    const characterPage = application
      .windows()
      .find((window) => window.url().includes("character_window"));
    if (!characterPage) throw new Error("Character window did not open");
    const characterChat = characterPage.getByRole("button", {
      name: "开始语音聊天",
    });
    await expect(characterChat).toBeHidden();
    await characterPage.getByRole("button", { name: /桌宠/u }).hover();
    await expect(characterChat).toBeVisible();
    await expect(characterChat).toHaveText("");
    const characterWindowState = await application.evaluate(
      ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.webContents.getURL().includes("character_window") ||
            candidate.webContents.getURL().includes("character.html"),
        );
        return window
          ? { focusable: window.isFocusable(), found: true }
          : { focusable: null, found: false };
      },
    );
    expect(characterWindowState).toEqual({
      focusable: process.platform !== "darwin",
      found: true,
    });
    await expect(
      characterPage.evaluate(() =>
        Object.keys(window.charaMateCharacter.voice).sort(),
      ),
    ).resolves.toEqual([
      "end",
      "getActive",
      "preview",
      "quickStart",
      "report",
      "setMuted",
      "setPaused",
      "start",
      "subscribeChanged",
      "subscribeCommand",
    ]);
    const voiceCallsUrl = "https://voice-csp.test/openai/v1/realtime/calls";
    await page
      .context()
      .route(voiceCallsUrl, (route) =>
        route.fulfill({ body: "voice-csp-ok", status: 200 }),
      );
    await expect(
      characterPage.evaluate(
        async (url) => (await fetch(url)).text(),
        voiceCallsUrl,
      ),
    ).resolves.toBe("voice-csp-ok");
    await characterChat.click();
    await characterPage.mouse.move(-10, -10);
    await expect(characterChat).toBeHidden();
    await expect
      .poll(() =>
        application?.evaluate(({ BrowserWindow }) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (candidate) =>
              !candidate.webContents.getURL().includes("character_window") &&
              !candidate.webContents.getURL().includes("character.html"),
          );
          return mainWindow?.isVisible() ?? false;
        }),
      )
      .toBe(false);

    const snapshot = await page.evaluate(() =>
      window.charaMate.foundation.getSnapshot(),
    );
    expect(snapshot).toMatchObject({
      appName: "CharaMate",
      databaseRoundTrip: true,
      electronVersion: "43.2.0",
      platform: "darwin",
    });

    await expect(
      page.evaluate(async (url) => (await fetch(url)).text(), voiceCallsUrl),
    ).resolves.toBe("voice-csp-ok");

    const chatData = await page.evaluate(
      (chatId) => window.charaMate.chat.getSnapshot({ chatId }),
      FIXTURE_IDS.chat,
    );
    expect(chatData).toEqual({
      ok: true,
      value: {
        approvals: [],
        attachments: [attachmentFixture],
        chat: chatFixture,
        messages: [messageFixture],
        runItems: [],
        runs: [completedRun],
      },
    });

    const replay = await page.evaluate(
      (streamId) =>
        window.charaMate.runEvents.replay({ afterSequence: 0, streamId }),
      FIXTURE_IDS.run,
    );
    expect(replay).toEqual({
      events: [runEventEnvelopeFixture, completedRunEventEnvelope],
      latestSequence: 2,
      streamId: FIXTURE_IDS.run,
    });

    const subscriptionShape = await page.evaluate(() => {
      const unsubscribe = window.charaMate.runEvents.subscribe(() => undefined);
      const shape = typeof unsubscribe;
      unsubscribe();
      return shape;
    });
    expect(subscriptionShape).toBe("function");

    await expect(
      page.evaluate(() => window.charaMate.voice.getActive()),
    ).resolves.toEqual({ ok: true, value: null });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { exact: true, name: "Voice" }).click();
    await expect(
      page.getByRole("heading", { name: "Realtime 语音" }),
    ).toBeVisible();
    const voiceSelect = page.getByLabel("音色");
    const previewButton = page.getByRole("button", { name: "试听" });
    const [voiceSelectBox, previewButtonBox] = await Promise.all([
      voiceSelect.boundingBox(),
      previewButton.boundingBox(),
    ]);
    expect(voiceSelectBox).not.toBeNull();
    expect(previewButtonBox).not.toBeNull();
    expect(
      Math.abs(
        voiceSelectBox!.y +
          voiceSelectBox!.height -
          (previewButtonBox!.y + previewButtonBox!.height),
      ),
    ).toBeLessThanOrEqual(1);
    await expect(voiceSelect).toHaveValue("verse");
    await voiceSelect.selectOption("coral");
    await page.getByLabel("输入方式").selectOption("push_to_talk");
    await page
      .getByLabel("Realtime instructions")
      .fill("  使用简洁自然的中文回答。  ");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("status")).toHaveText("Voice 设置已保存。");
    await expect(
      page.evaluate(() => window.charaMate.settings.getSnapshot()),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        voice: {
          inputMode: "push_to_talk",
          instructions: "使用简洁自然的中文回答。",
          voice: "coral",
        },
      },
    });
    await page.getByRole("button", { name: "Chats" }).click();

    const invalidRequest = await page.evaluate(async () => {
      try {
        await window.charaMate.chat.getSnapshot({ chatId: "not-an-id" });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(invalidRequest).toMatch(/chatId|pattern/u);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: chatFixture.title }),
    ).toBeVisible();
    await expect(page.getByText(messageFixture.content)).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { exact: true, name: "Voice" }).click();
    await expect(page.getByLabel("音色")).toHaveValue("coral");
    await expect(page.getByLabel("输入方式")).toHaveValue("push_to_talk");
    await expect(page.getByLabel("Realtime instructions")).toHaveValue(
      "使用简洁自然的中文回答。",
    );
    await page.getByRole("button", { name: "Chats" }).click();
    const snapshotAfterReload = await page.evaluate(
      (chatId) => window.charaMate.chat.getSnapshot({ chatId }),
      FIXTURE_IDS.chat,
    );
    expect(snapshotAfterReload).toEqual(chatData);
    const replayAfterReload = await page.evaluate(
      (streamId) =>
        window.charaMate.runEvents.replay({ afterSequence: 2, streamId }),
      FIXTURE_IDS.run,
    );
    expect(replayAfterReload).toEqual({
      events: [],
      latestSequence: 2,
      streamId: FIXTURE_IDS.run,
    });
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
