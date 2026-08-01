import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import {
  attachmentFixture,
  chatFixture,
  FIXTURE_IDS,
  messageFixture,
  runEventEnvelopeFixture,
  runFixture,
} from "../fixtures/foundationContracts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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
    new RunRepository(seedDatabase).appendEvent(runEventEnvelopeFixture);
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
    await expect(
      page.getByRole("heading", { name: "工程基线已就绪" }),
    ).toBeVisible();

    const bridgeShape = await page.evaluate(() => ({
      chatDataKeys: Object.keys(window.charaMate.chatData).sort(),
      foundationKeys: Object.keys(window.charaMate.foundation).sort(),
      providerKeys: Object.keys(window.charaMate.provider).sort(),
      rootKeys: Object.keys(window.charaMate).sort(),
      runEventKeys: Object.keys(window.charaMate.runEvents).sort(),
      exposesRawIpcRenderer: "ipcRenderer" in window.charaMate,
      exposesSecretReader: "getApiKey" in window.charaMate.provider,
    }));
    expect(bridgeShape).toEqual({
      chatDataKeys: ["getSnapshot"],
      foundationKeys: ["getSnapshot", "markRendererReady"],
      providerKeys: [
        "deleteProfile",
        "discoverModels",
        "listProfiles",
        "saveProfile",
        "testConnection",
      ],
      rootKeys: ["chatData", "foundation", "provider", "runEvents"],
      runEventKeys: ["replay", "subscribe"],
      exposesRawIpcRenderer: false,
      exposesSecretReader: false,
    });

    const snapshot = await page.evaluate(() =>
      window.charaMate.foundation.getSnapshot(),
    );
    expect(snapshot).toMatchObject({
      appName: "CharaMate",
      databaseRoundTrip: true,
      electronVersion: "43.2.0",
      platform: "darwin",
    });

    const chatData = await page.evaluate(
      (chatId) => window.charaMate.chatData.getSnapshot({ chatId }),
      FIXTURE_IDS.chat,
    );
    expect(chatData).toEqual({
      approvals: [],
      attachments: [attachmentFixture],
      chat: chatFixture,
      messages: [messageFixture],
      runItems: [],
      runs: [runFixture],
    });

    const replay = await page.evaluate(
      (streamId) =>
        window.charaMate.runEvents.replay({ afterSequence: 0, streamId }),
      FIXTURE_IDS.run,
    );
    expect(replay).toEqual({
      events: [runEventEnvelopeFixture],
      latestSequence: 1,
      streamId: FIXTURE_IDS.run,
    });

    const subscriptionShape = await page.evaluate(() => {
      const unsubscribe = window.charaMate.runEvents.subscribe(() => undefined);
      const shape = typeof unsubscribe;
      unsubscribe();
      return shape;
    });
    expect(subscriptionShape).toBe("function");

    const invalidRequest = await page.evaluate(async () => {
      try {
        await window.charaMate.chatData.getSnapshot({ chatId: "not-an-id" });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(invalidRequest).toMatch(/chatId|pattern/u);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "工程基线已就绪" }),
    ).toBeVisible();
    const snapshotAfterReload = await page.evaluate(
      (chatId) => window.charaMate.chatData.getSnapshot({ chatId }),
      FIXTURE_IDS.chat,
    );
    expect(snapshotAfterReload).toEqual(chatData);
    const replayAfterReload = await page.evaluate(
      (streamId) =>
        window.charaMate.runEvents.replay({ afterSequence: 1, streamId }),
      FIXTURE_IDS.run,
    );
    expect(replayAfterReload).toEqual({
      events: [],
      latestSequence: 1,
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
