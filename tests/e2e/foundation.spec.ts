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
    for (let index = 0; index < 30; index += 1) {
      chats.insertChat({
        ...chatFixture,
        createdAt: "2026-07-01T08:00:00.000Z",
        id: `70000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        title: `Overflow fixture ${String(index + 1)}`,
        updatedAt: "2026-07-01T08:00:00.000Z",
      });
    }
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
      page
        .getByRole("region", { name: "会话列表" })
        .getByRole("button", { name: chatFixture.title }),
    ).toBeVisible();
    const chatNavigation = page.getByRole("region", { name: "会话列表" });
    const settingsButton = page.getByRole("button", { name: "Settings" });
    await expect(settingsButton).toBeInViewport();
    const [sidebarBox, settingsBox, chatNavigationBox] = await Promise.all([
      page.locator("aside").first().boundingBox(),
      settingsButton.boundingBox(),
      chatNavigation.boundingBox(),
    ]);
    expect(sidebarBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(chatNavigationBox).not.toBeNull();
    expect(settingsBox!.y + settingsBox!.height).toBeLessThanOrEqual(
      sidebarBox!.y + sidebarBox!.height,
    );
    expect(
      chatNavigationBox!.y + chatNavigationBox!.height,
    ).toBeLessThanOrEqual(settingsBox!.y);
    await expect
      .poll(() =>
        chatNavigation.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await expect(page.getByText(messageFixture.content)).toBeVisible();
    await expect(page.getByRole("button", { name: /已处理/u })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑消息" }).click();
    const composer = page.getByRole("textbox", { name: "消息" });
    await expect(composer).toHaveValue(messageFixture.content);
    await expect(composer).toBeFocused();
    await composer.fill("");

    const bridgeShape = await page.evaluate(() => ({
      activityKeys: Object.keys(window.charaMate.activity).sort(),
      agentKeys: Object.keys(window.charaMate.agent).sort(),
      automationKeys: Object.keys(window.charaMate.automations).sort(),
      chatKeys: Object.keys(window.charaMate.chat).sort(),
      clipboardKeys: Object.keys(window.charaMate.clipboard).sort(),
      companionKeys: Object.keys(window.charaMate.companion).sort(),
      evolutionKeys: Object.keys(window.charaMate.evolution).sort(),
      extensionKeys: Object.keys(window.charaMate.extensions).sort(),
      fileKeys: Object.keys(window.charaMate.files).sort(),
      foundationKeys: Object.keys(window.charaMate.foundation).sort(),
      journeyKeys: Object.keys(window.charaMate.journey).sort(),
      memoryKeys: Object.keys(window.charaMate.memory).sort(),
      personaKeys: Object.keys(window.charaMate.persona).sort(),
      petKeys: Object.keys(window.charaMate.pet).sort(),
      providerKeys: Object.keys(window.charaMate.provider).sort(),
      rootKeys: Object.keys(window.charaMate).sort(),
      runEventKeys: Object.keys(window.charaMate.runEvents).sort(),
      settingsKeys: Object.keys(window.charaMate.settings).sort(),
      territoryKeys: Object.keys(window.charaMate.territory).sort(),
      voiceKeys: Object.keys(window.charaMate.voice).sort(),
      voiceWakeKeys: Object.keys(window.charaMate.voiceWake).sort(),
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
      automationKeys: [
        "create",
        "get",
        "list",
        "runNow",
        "setPaused",
        "subscribe",
        "update",
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
      clipboardKeys: ["writeText"],
      companionKeys: [
        "getSnapshot",
        "setNotificationsEnabled",
        "startPairing",
        "subscribeChanged",
        "unpair",
      ],
      evolutionKeys: [
        "acceptCandidate",
        "archiveCandidate",
        "dismissReview",
        "list",
        "rejectCandidate",
        "restoreCandidate",
        "retryReplay",
        "retryReview",
        "setCandidatePinned",
        "subscribe",
        "updateCandidate",
      ],
      foundationKeys: ["getSnapshot", "markRendererReady"],
      extensionKeys: [
        "mcpDelete",
        "mcpList",
        "mcpRefresh",
        "mcpSave",
        "skillArchive",
        "skillDelete",
        "skillGet",
        "skillHistory",
        "skillList",
        "skillRefresh",
        "skillRestore",
        "skillSave",
        "skillSetEnabled",
        "skillSetPinned",
      ],
      fileKeys: ["getPathForFile"],
      journeyKeys: ["getSnapshot", "subscribeChanged"],
      memoryKeys: [
        "acceptCandidate",
        "archive",
        "create",
        "delete",
        "get",
        "list",
        "purge",
        "rejectCandidate",
        "resolveClaim",
        "restore",
        "revise",
        "setPinned",
      ],
      personaKeys: [
        "copy",
        "getLibrary",
        "select",
        "subscribeChanged",
        "update",
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
        "setTerritoryActive",
        "subscribeChanged",
        "subscribeOpenComposerAttachments",
        "subscribeOpenConversation",
        "subscribeOpenMain",
        "subscribeOpenTerritoryCandidate",
      ],
      rootKeys: [
        "activity",
        "agent",
        "automations",
        "chat",
        "clipboard",
        "companion",
        "evolution",
        "extensions",
        "files",
        "foundation",
        "journey",
        "memory",
        "persona",
        "pet",
        "provider",
        "runEvents",
        "settings",
        "territory",
        "voice",
        "voiceWake",
      ],
      runEventKeys: ["replay", "subscribe"],
      settingsKeys: [
        "getDataSnapshot",
        "getSnapshot",
        "importBrowserCookies",
        "openDataDirectory",
        "openManagedBrowser",
        "saveAgent",
        "saveCompanionInitiative",
        "saveVoice",
      ],
      territoryKeys: [
        "applyCandidate",
        "cancelCandidate",
        "commitChangeSet",
        "createCandidate",
        "createSourceCandidate",
        "editCandidate",
        "enterZone",
        "getSnapshot",
        "getZoneView",
        "movePet",
        "purgeInstance",
        "restoreRevision",
        "subscribeChanged",
        "subscribePetAction",
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
      voiceWakeKeys: ["getSnapshot", "setEnabled", "subscribe"],
      exposesRawIpcRenderer: false,
      exposesSecretReader: false,
    });

    await expect(
      page.evaluate(() => window.charaMate.companion.getSnapshot()),
    ).resolves.toEqual({ ok: true, value: { state: "unpaired" } });
    await expect(
      page.evaluate(() => window.charaMate.companion.startPairing()),
    ).resolves.toMatchObject({
      error: { code: "COMPANION.PROTOCOL_ERROR", retryable: false },
      ok: false,
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
        Object.keys(window.charaMateCharacter).sort(),
      ),
    ).resolves.toEqual([
      "dismissProactiveBubble",
      "dropComposerAttachments",
      "endDrag",
      "focusApproval",
      "focusConversation",
      "focusMain",
      "focusTerritoryMoment",
      "getPendingApproval",
      "getSnapshot",
      "markReady",
      "moveDrag",
      "reduceProactiveFrequency",
      "replyProactiveBubble",
      "resolveApproval",
      "showContextMenu",
      "startDrag",
      "subscribe",
      "subscribeApproval",
      "subscribeProactiveBubble",
      "subscribeTerritoryMoment",
      "voice",
      "voiceWake",
    ]);
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
    await expect(
      characterPage.evaluate(() =>
        Object.keys(window.charaMateCharacter.voiceWake).sort(),
      ),
    ).resolves.toEqual(["getSnapshot", "report", "subscribe"]);
    await expect(
      page.evaluate(() => window.charaMate.voiceWake.getSnapshot()),
    ).resolves.toMatchObject({
      ok: true,
      value: { enabled: false, phase: "disabled", phrase: "Hi Mika" },
    });
    await expect(
      characterPage.evaluate(async () => {
        const script = document.querySelector<HTMLScriptElement>(
          'script[type="module"][src]',
        );
        if (!script) throw new Error("Character entry script is missing.");
        const source = await fetch(script.src).then((response) =>
          response.text(),
        );
        const workerFilename = source.match(
          /wakeWordWorker-[A-Za-z0-9_-]+\.js/u,
        )?.[0];
        if (!workerFilename) throw new Error("Voice Wake Worker is missing.");
        const worker = new Worker(new URL(workerFilename, script.src));
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(
              () =>
                reject(
                  new Error("Voice Wake Worker initialization timed out."),
                ),
              20_000,
            );
            worker.addEventListener("error", (event) => {
              window.clearTimeout(timeout);
              reject(new Error(event.message));
            });
            worker.addEventListener("message", (event) => {
              const message = event.data as { message?: string; type?: string };
              if (message.type === "error") {
                window.clearTimeout(timeout);
                reject(new Error(message.message));
              }
              if (message.type === "ready") {
                window.clearTimeout(timeout);
                resolve();
              }
            });
            worker.postMessage({
              baseUrl: new URL("../wake-word/", script.src).href,
              keywords: "▁HI ▁MI K A :2.5 #0.05 @Hi_Mika",
              type: "initialize",
            });
          });
          worker.postMessage({ type: "shutdown" });
          return true;
        } finally {
          worker.terminate();
        }
      }),
    ).resolves.toBe(true);
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

    const skillContent = `---
name: e2e-delete-skill
description: Verify editing, saving, and permanent deletion through Settings.
---

# Workflow

1. Edit and delete this active test Skill.
`;
    await expect(
      page.evaluate(
        (content) =>
          window.charaMate.extensions.skillSave({
            content,
            name: "e2e-delete-skill",
          }),
        skillContent,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: "user:e2e-delete-skill", revision: 1 },
    });
    for (let revision = 2; revision <= 8; revision += 1) {
      await expect(
        page.evaluate(
          ({ content, currentRevision }) =>
            window.charaMate.extensions.skillSave({
              content: `${content}\n<!-- revision ${String(currentRevision)} -->\n`,
              name: "e2e-delete-skill",
            }),
          { content: skillContent, currentRevision: revision },
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { id: "user:e2e-delete-skill", revision },
      });
    }
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { exact: true, name: "Skills" }).click();
    const skillNameInput = page.getByLabel("名称");
    const skillEditor = page.getByLabel("SKILL.md");
    await expect(skillNameInput).toBeEnabled();
    await expect(skillEditor).toBeEnabled();
    const activeSkillList = page.getByLabel("当前 Skills");
    const activeSkillItem = activeSkillList
      .getByRole("button")
      .filter({ hasText: "e2e-delete-skill" });
    await expect(activeSkillItem).toBeVisible();
    await expect(activeSkillItem).toContainText(
      "Verify editing, saving, and permanent deletion through Settings.",
    );
    await expect(page.getByText(/用户 · r8/u)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "版本与恢复" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("region", { name: "成长候选" })).toHaveCount(0);
    await skillNameInput.focus();
    const skillEditorLayout = await skillNameInput.evaluate((element) => {
      const label = element.closest("label");
      const form = label?.parentElement;
      const editor = form?.querySelector("textarea");
      const panel = element.closest("section");
      const settingsContent = panel?.parentElement;
      const settingsPage = settingsContent?.parentElement;
      if (
        !label ||
        !form ||
        !editor ||
        !panel ||
        !settingsContent ||
        !settingsPage
      )
        return null;
      const originalEditorValue = editor.value;
      const originalEditorHeight = editor.style.height;
      editor.style.height = "40px";
      editor.value = "长行内容不应消失在编辑器右侧".repeat(80);
      const editorStyle = window.getComputedStyle(editor);
      const wrappedLongLineScrollHeight = editor.scrollHeight;
      const wrappedLongLineScrollWidth = editor.scrollWidth;
      editor.value = originalEditorValue;
      editor.style.height = originalEditorHeight;
      const inputStyle = window.getComputedStyle(element);
      return {
        editorClientWidth: editor.clientWidth,
        editorOverflowX: editorStyle.overflowX,
        editorRight: editor.getBoundingClientRect().right,
        editorScrollWidth: editor.scrollWidth,
        editorWhiteSpace: editorStyle.whiteSpace,
        formClientWidth: form.clientWidth,
        formScrollWidth: form.scrollWidth,
        inputBoxShadow: inputStyle.boxShadow,
        labelOutlineStyle: window.getComputedStyle(label).outlineStyle,
        panelRight: panel.getBoundingClientRect().right,
        settingsClientWidth: settingsPage.clientWidth,
        settingsScrollLeft: settingsPage.scrollLeft,
        settingsScrollWidth: settingsPage.scrollWidth,
        wrappedLongLineScrollHeight,
        wrappedLongLineScrollWidth,
      };
    });
    expect(skillEditorLayout).not.toBeNull();
    expect(skillEditorLayout!.labelOutlineStyle).toBe("none");
    expect(skillEditorLayout!.editorRight).toBeLessThanOrEqual(
      skillEditorLayout!.panelRight + 1,
    );
    expect(skillEditorLayout!.editorScrollWidth).toBeLessThanOrEqual(
      skillEditorLayout!.editorClientWidth + 1,
    );
    expect(skillEditorLayout!.editorOverflowX).toBe("auto");
    expect(skillEditorLayout!.editorWhiteSpace).toBe("pre-wrap");
    expect(skillEditorLayout!.formScrollWidth).toBeLessThanOrEqual(
      skillEditorLayout!.formClientWidth + 1,
    );
    expect(skillEditorLayout!.inputBoxShadow).not.toContain("105, 89, 217");
    expect(skillEditorLayout!.settingsScrollLeft).toBe(0);
    expect(skillEditorLayout!.settingsScrollWidth).toBeLessThanOrEqual(
      skillEditorLayout!.settingsClientWidth + 1,
    );
    expect(skillEditorLayout!.wrappedLongLineScrollHeight).toBeGreaterThan(60);
    expect(skillEditorLayout!.wrappedLongLineScrollWidth).toBeLessThanOrEqual(
      skillEditorLayout!.editorClientWidth + 1,
    );
    const skillBehavior = page.getByRole("group", { name: "Skill 行为" });
    await expect(skillBehavior).toBeVisible();
    await expect(
      skillBehavior.getByRole("checkbox", { name: /启用 Skill/u }),
    ).toBeChecked();
    await skillEditor.fill(
      skillContent.replace(
        "Edit and delete this active test Skill.",
        "Save this edit, then delete the active test Skill.",
      ),
    );
    await page.getByRole("button", { name: "保存更改" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存。");
    await expect(page.getByRole("button", { name: "已保存" })).toBeDisabled();
    await page.getByRole("button", { name: "归档 Skill" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Skill 已归档；它已移出当前列表。",
    );
    await expect(page.getByLabel("名称")).toBeDisabled();
    await expect(page.getByRole("button", { name: "已归档" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("region", { name: "版本与恢复" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "恢复 Skill" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Skill 已恢复并重新启用。",
    );
    await expect(page.getByLabel("名称")).toBeEnabled();
    const dialogPromise = page.waitForEvent("dialog");
    const deleteClick = page.getByRole("button", { name: "永久删除" }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain(
      "永久删除“e2e-delete-skill”及其整个目录",
    );
    await dialog.accept();
    await deleteClick;
    await expect(page.getByRole("status")).toHaveText("Skill 已永久删除。");
    await expect(
      page.evaluate(() => window.charaMate.extensions.skillList({})),
    ).resolves.toEqual({ ok: true, value: [] });
    await page.getByRole("button", { name: "Chats" }).click();

    await expect(
      page.evaluate(() => window.charaMate.voice.getActive()),
    ).resolves.toEqual({ ok: true, value: null });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { exact: true, name: "Devices" }).click();
    await expect(
      page.getByRole("heading", { name: "Android Companion" }),
    ).toBeVisible();
    await expect(page.getByText("尚未连接手机")).toBeVisible();
    await page.getByRole("button", { name: "开始配对" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Companion Relay pairing origin is not configured.",
    );
    await page.getByRole("button", { exact: true, name: "Voice" }).click();
    await expect(
      page.getByRole("heading", { name: "Realtime 语音" }),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", { name: /Hi Mika/u }),
    ).toHaveAttribute("aria-checked", "false");
    const previewButton = page.getByRole("button", { name: "试听" });
    await expect(page.getByText("Mika · 元气开朗 · verse")).toBeVisible();
    await expect(previewButton).toBeEnabled();
    await page.getByLabel("输入方式").selectOption("push_to_talk");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("status")).toHaveText("Voice 设置已保存。");
    const savedVoice = await page.evaluate(async () => {
      const response = await window.charaMate.settings.getSnapshot();
      if (!response.ok) return response;
      return {
        keys: Object.keys(response.value.voice).sort(),
        value: response.value.voice,
      };
    });
    expect(savedVoice).toMatchObject({
      keys: ["inputMode", "microphone", "providerProfileId"],
      value: { inputMode: "push_to_talk" },
    });
    await page.getByRole("button", { exact: true, name: "Appearance" }).click();
    await page
      .getByRole("group", { name: "明暗主题" })
      .getByRole("radio", { name: /^深色/u })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('input[name="background-scheme"]')).toHaveCount(
      4,
    );
    await page.getByRole("radio", { name: /自定义/u }).click();
    await page.getByLabel("画布颜色").fill("#102938");
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-scheme",
      "custom",
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--custom-canvas")
            .trim(),
        ),
      )
      .toBe("#102938");
    await page.getByRole("button", { exact: true, name: "Data" }).click();
    await expect(page.getByRole("heading", { name: "本地数据" })).toBeVisible();
    await expect(page.getByText("对话与应用数据库")).toBeVisible();
    const dataSnapshot = await page.evaluate(() =>
      window.charaMate.settings.getDataSnapshot(),
    );
    expect(dataSnapshot).toMatchObject({
      ok: true,
      value: { dataDirectory: userDataDirectory },
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
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-scheme",
      "custom",
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--custom-canvas")
            .trim(),
        ),
      )
      .toBe("#102938");
    await expect(
      page
        .getByRole("region", { name: "会话列表" })
        .getByRole("button", { name: chatFixture.title }),
    ).toBeVisible();
    await expect(page.getByText(messageFixture.content)).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { exact: true, name: "Voice" }).click();
    await expect(page.getByText("Mika · 元气开朗 · verse")).toBeVisible();
    await expect(page.getByLabel("输入方式")).toHaveValue("push_to_talk");
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
