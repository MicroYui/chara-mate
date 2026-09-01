import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatRepository } from "../../src/main/chat/chatRepository";
import { CompanionBridgeRepository } from "../../src/main/companion/companionBridgeRepository";
import { CompanionChatTargetsProjectionService } from "../../src/main/companion/companionChatTargetsProjectionService";
import type { CompanionRelayClient } from "../../src/main/companion/companionRelayClient";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { Chat } from "../../src/shared/contracts/chat";
import { FakeClock } from "../fixtures/fakeClock";

const IDS = {
  archived: "10000000-0000-4000-8000-000000000001",
  chat: "20000000-0000-4000-8000-000000000002",
  credential: "30000000-0000-4000-8000-000000000003",
  desktop: "40000000-0000-4000-8000-000000000004",
  device: "50000000-0000-4000-8000-000000000005",
  envelope: "60000000-0000-4000-8000-000000000006",
  installation: "70000000-0000-4000-8000-000000000007",
  provisional: "80000000-0000-4000-8000-000000000008",
} as const;

const NOW = "2026-09-01T09:00:00.000Z";
const EXPIRES_AT = "2026-09-02T09:00:00.000Z";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];
const services: CompanionChatTargetsProjectionService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function chat(
  id: string,
  title: string,
  status: Chat["status"] = "active",
): Chat {
  return {
    ...(status === "archived" ? { archivedAt: NOW } : {}),
    createdAt: NOW,
    id,
    status,
    title,
    updatedAt: NOW,
  };
}

describe("Companion Chat targets projection persistence boundary", () => {
  it("projects only the established active Chats returned by ChatRepository", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "charamate-companion-chat-targets-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    databases.push(database);
    const chats = new ChatRepository(database);
    chats.insertChat(chat(IDS.chat, "Presentation 加油"));
    chats.insertChat(chat(IDS.provisional, "尚未发送"), { provisional: true });
    chats.insertChat(chat(IDS.archived, "旧聊天", "archived"));

    const bridge = new CompanionBridgeRepository(database);
    bridge.getOrCreateDesktopInstanceId(() => IDS.desktop);
    bridge.pairDevice({
      credentialRef: IDS.credential,
      device: {
        displayName: "Pixel 10",
        id: IDS.device,
        installationId: IDS.installation,
        notificationPermission: "denied",
        notificationsEnabled: true,
        pairedAt: NOW,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: NOW, state: "offline" },
      },
      relayOrigin: "https://relay.example.test",
      updatedAt: NOW,
    });
    const enqueueAndroidMailbox = vi.fn<
      CompanionRelayClient["enqueueAndroidMailbox"]
    >(({ request }) =>
      Promise.resolve({
        envelope: {
          createdAt: NOW,
          cursor: "cursor-chat-targets-1",
          event: request.event,
          expiresAt: EXPIRES_AT,
          id: request.envelopeId,
          protocolVersion: 1,
          recipient: request.recipient,
        },
        protocolVersion: 1,
      }),
    );
    const service = new CompanionChatTargetsProjectionService({
      bridge,
      chats,
      clock: new FakeClock(NOW),
      idGenerator: { generate: () => IDS.envelope },
      relay: { enqueueAndroidMailbox },
      secretStore: { get: () => Promise.resolve("device-credential") },
    });
    services.push(service);

    service.start();
    await vi.waitFor(() =>
      expect(enqueueAndroidMailbox).toHaveBeenCalledOnce(),
    );

    expect(enqueueAndroidMailbox.mock.calls[0]?.[0].request).toEqual({
      envelopeId: IDS.envelope,
      event: {
        deviceId: IDS.device,
        snapshot: {
          generatedAt: NOW,
          targets: [
            {
              chatId: IDS.chat,
              title: "Presentation 加油",
              updatedAt: NOW,
            },
          ],
        },
        type: "companion.chat_targets.replaced",
      },
      protocolVersion: 1,
      recipient: { deviceId: IDS.device, kind: "android" },
    });
  });
});
