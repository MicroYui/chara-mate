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
      page.getByRole("heading", { name: chatFixture.title }),
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

    const bridgeShape = await page.evaluate(() => ({
      activityKeys: Object.keys(window.charaMate.activity).sort(),
      agentKeys: Object.keys(window.charaMate.agent).sort(),
      automationKeys: Object.keys(window.charaMate.automations).sort(),
      chatKeys: Object.keys(window.charaMate.chat).sort(),
      evolutionKeys: Object.keys(window.charaMate.evolution).sort(),
      extensionKeys: Object.keys(window.charaMate.extensions).sort(),
      fileKeys: Object.keys(window.charaMate.files).sort(),
      foundationKeys: Object.keys(window.charaMate.foundation).sort(),
      journeyKeys: Object.keys(window.charaMate.journey).sort(),
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
      evolutionKeys: [
        "acceptCandidate",
        "archiveCandidate",
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
        "setTerritoryActive",
        "subscribeChanged",
        "subscribeOpenConversation",
        "subscribeOpenMain",
      ],
      rootKeys: [
        "activity",
        "agent",
        "automations",
        "chat",
        "evolution",
        "extensions",
        "files",
        "foundation",
        "journey",
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
        Object.keys(window.charaMateCharacter).sort(),
      ),
    ).resolves.toEqual([
      "dismissProactiveBubble",
      "endDrag",
      "focusApproval",
      "focusConversation",
      "focusMain",
      "getPendingApproval",
      "getSnapshot",
      "markReady",
      "moveDrag",
      "replyProactiveBubble",
      "resolveApproval",
      "showContextMenu",
      "startDrag",
      "subscribe",
      "subscribeApproval",
      "subscribeProactiveBubble",
      "voice",
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
