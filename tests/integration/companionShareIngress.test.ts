import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { CompanionBridgeRepository } from "../../src/main/companion/companionBridgeRepository";
import {
  CompanionShareIngress,
  type CompanionShareIngressDependencies,
} from "../../src/main/companion/companionShareIngress";
import { openApplicationDatabase } from "../../src/main/db/database";
import { ArtifactStore } from "../../src/main/tools/artifactStore";
import type { StartRunRequest } from "../../src/shared/contracts/agent";
import type {
  CompanionDesktopMailboxEnvelope,
  CompanionSharePayload,
} from "../../src/shared/contracts/companion";
import type { Run } from "../../src/shared/contracts/run";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import {
  personaSnapshotFixture,
  providerSnapshotFixture,
} from "../fixtures/foundationContracts";

const IDS = {
  asset: "50000000-0000-4000-8000-000000000005",
  credential: "a0000000-0000-4000-8000-00000000000a",
  desktop: "10000000-0000-4000-8000-000000000001",
  device: "20000000-0000-4000-8000-000000000002",
  envelope: "40000000-0000-4000-8000-000000000004",
  installation: "b0000000-0000-4000-8000-00000000000b",
  message: "80000000-0000-4000-8000-000000000008",
  run: "70000000-0000-4000-8000-000000000007",
  submission: "30000000-0000-4000-8000-000000000003",
} as const;

const NOW = "2026-09-01T07:00:00.000Z";
const EXPIRES_AT = "2026-09-01T08:00:00.000Z";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageEnvelope(
  target: CompanionSharePayload["target"],
  bytes: Buffer,
): CompanionDesktopMailboxEnvelope {
  return {
    createdAt: NOW,
    cursor: "cursor-mobile-share-1",
    event: {
      deviceId: IDS.device,
      share: {
        attachment: {
          byteLength: bytes.byteLength,
          contentKind: "image",
          displayName: "sunset.png",
          expiresAt: EXPIRES_AT,
          mediaType: "image/png",
          relayAssetId: IDS.asset,
          sha256: sha256(bytes),
        },
        caption: "分享结束了",
        kind: "attachment",
        submissionId: IDS.submission,
        target,
      },
      type: "companion.share.uploaded",
    },
    expiresAt: EXPIRES_AT,
    id: IDS.envelope,
    protocolVersion: 1,
    recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
  };
}

class PersistingAgentRuntime {
  boundBeforeRunPersistence = false;
  lastRequest: StartRunRequest | undefined;
  startCalls = 0;

  constructor(
    private readonly bridge: CompanionBridgeRepository,
    private readonly chats: ChatRepository,
    private readonly clock: FakeClock,
    private readonly runs: RunRepository,
    private readonly persistAttachments = true,
  ) {}

  start(
    request: StartRunRequest,
    options: { readonly onRunAllocated: (runId: string) => void },
  ): Promise<unknown> {
    this.startCalls += 1;
    this.lastRequest = request;
    options.onRunAllocated(IDS.run);
    this.boundBeforeRunPersistence =
      this.bridge.getShareImport(IDS.submission)?.runId === IDS.run &&
      this.runs.getRun(IDS.run) === undefined;

    const now = this.clock.now();
    const run = {
      chatId: request.chatId,
      createdAt: now,
      execution: request.execution,
      id: IDS.run,
      latestSequence: 1,
      persona: personaSnapshotFixture,
      provider: providerSnapshotFixture,
      source: "text",
      startedAt: now,
      status: "running",
    } satisfies Run;
    this.runs.appendEvent({
      event: { run, type: "run.started" },
      occurredAt: now,
      sequence: 1,
      streamId: run.id,
    });

    const message = this.chats.insertMessage({
      chatId: request.chatId,
      content: request.content,
      createdAt: now,
      id: IDS.message,
      role: "user",
      runId: run.id,
      status: "completed",
      updatedAt: now,
    });
    if (this.persistAttachments) {
      for (const artifact of request.attachments) {
        if (artifact.kind !== "image" && artifact.kind !== "file") continue;
        this.chats.insertAttachment({
          ...(artifact.byteLength === undefined
            ? {}
            : { byteLength: artifact.byteLength }),
          chatId: request.chatId,
          createdAt: now,
          displayName: artifact.displayName,
          id: artifact.artifactId,
          kind: artifact.kind,
          ...(artifact.mediaType === undefined
            ? {}
            : { mediaType: artifact.mediaType }),
          messageId: message.id,
          ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
          storageKey: artifact.storageKey,
        });
      }
    }

    return Promise.reject(
      new Error("simulated provider failure after input persistence"),
    );
  }
}

describe("CompanionShareIngress persistence boundary", () => {
  it("imports an Android image into the exact Chat and recovers without duplicates after a late Run failure", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "charamate-companion-share-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    databases.push(database);

    const clock = new FakeClock(NOW);
    const ids = new CryptoIdGenerator();
    const chatRepository = new ChatRepository(database);
    const runs = new RunRepository(database);
    const chats = new ChatService(chatRepository, runs, ids, clock);
    const bridge = new CompanionBridgeRepository(database);
    const artifactStore = new ArtifactStore(path.join(root, "artifacts"), ids);
    const targetChat = chats.create({ title: "Presentation 加油" });
    expect(bridge.getOrCreateDesktopInstanceId(() => IDS.desktop)).toBe(
      IDS.desktop,
    );
    bridge.pairDevice({
      credentialRef: IDS.credential,
      device: {
        displayName: "Pixel 10",
        id: IDS.device,
        installationId: IDS.installation,
        notificationPermission: "granted",
        notificationsEnabled: true,
        pairedAt: NOW,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: NOW, state: "online" },
      },
      relayOrigin: "https://relay.example.test",
      updatedAt: NOW,
    });

    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const envelope = imageEnvelope(
      { chatId: targetChat.id, kind: "existing_chat" },
      imageBytes,
    );
    let relayReads = 0;
    const agent = new PersistingAgentRuntime(
      bridge,
      chatRepository,
      clock,
      runs,
    );
    const dependencies: CompanionShareIngressDependencies = {
      agent,
      artifacts: artifactStore,
      bridge,
      chatRepository,
      chats,
      clock,
      providers: {
        getDefaultChatProfileId: () => providerSnapshotFixture.profileId,
      },
      readRelayAsset: (asset) => {
        relayReads += 1;
        expect(asset.relayAssetId).toBe(IDS.asset);
        return Promise.resolve(imageBytes);
      },
      runs,
    };
    const ingress = new CompanionShareIngress(dependencies);

    const imported = await ingress.importEnvelope(envelope);
    const retried = await ingress.importEnvelope(envelope);

    expect(retried).toEqual(imported);
    expect(imported).toEqual({
      attachmentId: IDS.submission,
      chatId: targetChat.id,
      messageId: IDS.message,
      submissionId: IDS.submission,
      type: "share.imported",
    });
    expect(agent.startCalls).toBe(1);
    expect(agent.boundBeforeRunPersistence).toBe(true);
    expect(agent.lastRequest).toMatchObject({
      attachments: [
        {
          artifactId: IDS.submission,
          displayName: "sunset.png",
          kind: "image",
          mediaType: "image/png",
          sha256: sha256(imageBytes),
        },
      ],
      chatId: targetChat.id,
      content: "分享结束了",
      execution: { mode: "chat" },
    });
    expect(relayReads).toBe(1);

    const snapshot = chatRepository.getSnapshot(targetChat.id);
    expect(snapshot?.messages).toEqual([
      expect.objectContaining({
        chatId: targetChat.id,
        content: "分享结束了",
        id: IDS.message,
        role: "user",
        runId: IDS.run,
        status: "completed",
      }),
    ]);
    expect(snapshot?.attachments).toEqual([
      expect.objectContaining({
        chatId: targetChat.id,
        id: IDS.submission,
        kind: "image",
        messageId: IDS.message,
        sha256: sha256(imageBytes),
      }),
    ]);
    expect(runs.getSnapshot(targetChat.id).runs).toHaveLength(1);
    expect(chatRepository.isProvisionalChat(targetChat.id)).toBe(false);

    const attachment = snapshot!.attachments[0]!;
    await expect(
      readFile(artifactStore.resolvePath(attachment.storageKey)),
    ).resolves.toEqual(imageBytes);
    expect(bridge.getDesktopMailboxCursor()).toBe(envelope.cursor);
    expect(bridge.getShareImport(IDS.submission)).toMatchObject({
      attachmentId: IDS.submission,
      chatId: targetChat.id,
      messageId: IDS.message,
      runId: IDS.run,
      state: "imported",
    });
  });

  it("preserves a completed User Message across restart when attachment repair temporarily fails", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "charamate-companion-share-recovery-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    databases.push(database);

    const clock = new FakeClock(NOW);
    const ids = new CryptoIdGenerator();
    const chatRepository = new ChatRepository(database);
    const runs = new RunRepository(database);
    const chats = new ChatService(chatRepository, runs, ids, clock);
    const bridge = new CompanionBridgeRepository(database);
    const artifactStore = new ArtifactStore(path.join(root, "artifacts"), ids);
    bridge.getOrCreateDesktopInstanceId(() => IDS.desktop);
    bridge.pairDevice({
      credentialRef: IDS.credential,
      device: {
        displayName: "Pixel 10",
        id: IDS.device,
        installationId: IDS.installation,
        notificationPermission: "granted",
        notificationsEnabled: true,
        pairedAt: NOW,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: NOW, state: "online" },
      },
      relayOrigin: "https://relay.example.test",
      updatedAt: NOW,
    });

    const imageBytes = Buffer.from("recoverable-image-bytes");
    const envelope = imageEnvelope({ kind: "new_chat" }, imageBytes);
    const agent = new PersistingAgentRuntime(
      bridge,
      chatRepository,
      clock,
      runs,
      false,
    );
    let relayReads = 0;
    const ingress = new CompanionShareIngress({
      agent,
      artifacts: artifactStore,
      bridge,
      chatRepository,
      chats,
      clock,
      providers: {
        getDefaultChatProfileId: () => providerSnapshotFixture.profileId,
      },
      readRelayAsset: () => {
        relayReads += 1;
        return relayReads === 2
          ? Promise.reject(new Error("relay temporarily unavailable"))
          : Promise.resolve(imageBytes);
      },
      runs,
    });

    await expect(ingress.importEnvelope(envelope)).rejects.toThrow(
      "relay temporarily unavailable",
    );

    const recoveredChatId = agent.lastRequest?.chatId;
    expect(recoveredChatId).toBeDefined();
    expect(chatRepository.isProvisionalChat(recoveredChatId!)).toBe(false);
    expect(chats.discardAllProvisional()).toBe(0);
    expect(chatRepository.getSnapshot(recoveredChatId!)?.messages).toEqual([
      expect.objectContaining({ id: IDS.message, status: "completed" }),
    ]);
    expect(chatRepository.getSnapshot(recoveredChatId!)?.attachments).toEqual(
      [],
    );

    await expect(ingress.importEnvelope(envelope)).resolves.toMatchObject({
      attachmentId: IDS.submission,
      chatId: recoveredChatId,
      messageId: IDS.message,
    });
    expect(agent.startCalls).toBe(1);
    expect(relayReads).toBe(3);
    expect(chatRepository.getSnapshot(recoveredChatId!)?.attachments).toEqual([
      expect.objectContaining({
        id: IDS.submission,
        messageId: IDS.message,
      }),
    ]);
  });
});
