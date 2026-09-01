import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { CompanionBridgeRepository } from "../../src/main/companion/companionBridgeRepository";
import { CompanionBridgeService } from "../../src/main/companion/companionBridgeService";
import { CompanionMessageProjectionService } from "../../src/main/companion/companionMessageProjectionService";
import {
  CompanionRelayClientError,
  type CompanionRelayClient,
} from "../../src/main/companion/companionRelayClient";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { ProviderSecretStore } from "../../src/main/providers/secretStore";
import type {
  Chat,
  CompanionDesktopSnapshot,
  Message,
  Run,
  RunEventEnvelope,
} from "../../src/shared/contracts";
import { FakeClock } from "../fixtures/fakeClock";
import {
  personaSnapshotFixture,
  providerSnapshotFixture,
} from "../fixtures/foundationContracts";

const IDS = {
  assistantMessage: "a0000000-0000-4000-8000-00000000000a",
  chat: "70000000-0000-4000-8000-000000000007",
  credential: "40000000-0000-4000-8000-000000000004",
  desktop: "10000000-0000-4000-8000-000000000001",
  device: "20000000-0000-4000-8000-000000000002",
  installation: "30000000-0000-4000-8000-000000000003",
  notificationEnvelope: "b0000000-0000-4000-8000-00000000000b",
  protocolAssistantMessage: "d0000000-0000-4000-8000-00000000000d",
  replacementEnvelope: "c0000000-0000-4000-8000-00000000000c",
  run: "80000000-0000-4000-8000-000000000008",
  shareEnvelope: "50000000-0000-4000-8000-000000000005",
  submission: "60000000-0000-4000-8000-000000000006",
  userMessage: "90000000-0000-4000-8000-000000000009",
} as const;

const STARTED_AT = "2026-09-01T09:00:00.000Z";
const ASSISTANT_CREATED_AT = "2026-09-01T09:01:00.000Z";
const COMPLETED_AT = "2026-09-01T09:02:00.000Z";
const EXPIRES_AT = "2026-09-02T09:00:00.000Z";
const CREDENTIAL = "opaque-device-mailbox-credential";
const RESPONSE = "看样子至少你现在还有心情拍夕阳，应该不算太糟？";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];
const bridgeServices: CompanionBridgeService[] = [];
const services: CompanionMessageProjectionService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const service of bridgeServices.splice(0)) service.dispose();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function createStatusBridge(
  repository: CompanionBridgeRepository,
  clock: FakeClock,
) {
  const snapshots: CompanionDesktopSnapshot[] = [];
  const service = new CompanionBridgeService({
    clock,
    publisher: { publish: (snapshot) => snapshots.push(snapshot) },
    relay: {} as CompanionRelayClient,
    repository,
    secrets: {} as ProviderSecretStore,
  });
  bridgeServices.push(service);
  return { service, snapshots };
}

describe("Companion Message projection persistence", () => {
  it("reuses one completed share response and its envelope after an unknown Relay outcome", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "charamate-companion-projection-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    databases.push(database);

    const clock = new FakeClock(COMPLETED_AT);
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    const bridge = new CompanionBridgeRepository(database);
    const statusBridge = createStatusBridge(bridge, clock);
    const chat = {
      createdAt: STARTED_AT,
      id: IDS.chat,
      status: "active",
      title: "Presentation 加油",
      updatedAt: STARTED_AT,
    } satisfies Chat;
    chats.insertChat(chat);
    bridge.getOrCreateDesktopInstanceId(() => IDS.desktop);
    bridge.pairDevice({
      credentialRef: IDS.credential,
      device: {
        displayName: "Pixel 10",
        id: IDS.device,
        installationId: IDS.installation,
        notificationPermission: "granted",
        notificationsEnabled: true,
        pairedAt: STARTED_AT,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: COMPLETED_AT, state: "online" },
      },
      relayOrigin: "https://relay.example.test",
      updatedAt: COMPLETED_AT,
    });

    bridge.claimShare({
      claimedAt: STARTED_AT,
      cursor: "cursor-mobile-share-1",
      deviceId: IDS.device,
      envelopeId: IDS.shareEnvelope,
      expiresAt: EXPIRES_AT,
      payloadSha256: "a".repeat(64),
      sourceKind: "text",
      submissionId: IDS.submission,
    });
    bridge.bindOrRebindShareRun({
      runId: IDS.run,
      submissionId: IDS.submission,
      updatedAt: STARTED_AT,
    });

    const startedRun = {
      chatId: chat.id,
      createdAt: STARTED_AT,
      execution: { mode: "chat" },
      id: IDS.run,
      latestSequence: 1,
      persona: personaSnapshotFixture,
      provider: providerSnapshotFixture,
      source: "text",
      startedAt: STARTED_AT,
      status: "running",
    } satisfies Run;
    runs.appendEvent({
      event: { run: startedRun, type: "run.started" },
      occurredAt: STARTED_AT,
      sequence: 1,
      streamId: startedRun.id,
    });
    const userMessage = {
      chatId: chat.id,
      content: "分享结束了",
      createdAt: STARTED_AT,
      id: IDS.userMessage,
      role: "user",
      runId: startedRun.id,
      status: "completed",
      updatedAt: STARTED_AT,
    } satisfies Message;
    chats.insertMessage(userMessage);
    bridge.completeShareImport({
      chatId: chat.id,
      importedAt: STARTED_AT,
      messageId: userMessage.id,
      submissionId: IDS.submission,
    });
    const assistantMessage = {
      chatId: chat.id,
      content: RESPONSE,
      createdAt: ASSISTANT_CREATED_AT,
      id: IDS.assistantMessage,
      role: "assistant",
      runId: startedRun.id,
      status: "completed",
      updatedAt: ASSISTANT_CREATED_AT,
    } satisfies Message;
    chats.insertMessage(assistantMessage);
    const completedRun = {
      ...startedRun,
      endedAt: COMPLETED_AT,
      latestSequence: 2,
      status: "completed",
    } satisfies Run;
    const completedEnvelope = {
      event: { run: completedRun, type: "run.completed" },
      occurredAt: COMPLETED_AT,
      sequence: 2,
      streamId: completedRun.id,
    } satisfies RunEventEnvelope;
    runs.appendEvent(completedEnvelope);

    const getSecret = vi.fn(() => Promise.resolve(CREDENTIAL));
    const firstEnqueue = vi
      .fn<CompanionRelayClient["enqueueAndroidMailbox"]>()
      .mockRejectedValue(
        new CompanionRelayClientError(
          "network",
          "Relay result is unknown after connection loss.",
        ),
      );
    const firstGenerate = vi.fn(() => IDS.notificationEnvelope);
    const firstService = new CompanionMessageProjectionService({
      bridge,
      chats,
      clock,
      idGenerator: { generate: firstGenerate },
      onStatusChange: (deviceId, status) =>
        statusBridge.service.updateDeviceStatus(deviceId, status),
      relay: { enqueueAndroidMailbox: firstEnqueue },
      runs,
      secretStore: { get: getSecret },
    });
    services.push(firstService);

    firstService.start();
    await vi.waitFor(() => expect(firstEnqueue).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(bridge.getMessageProjection(assistantMessage.id)?.state).toBe(
        "submitted",
      ),
    );

    const firstRequest = firstEnqueue.mock.calls[0]?.[0].request;
    expect(firstRequest).toEqual({
      envelopeId: IDS.notificationEnvelope,
      event: {
        deviceId: IDS.device,
        notification: {
          body: assistantMessage.content,
          chatId: assistantMessage.chatId,
          messageCreatedAt: assistantMessage.createdAt,
          messageId: assistantMessage.id,
          role: "assistant",
          status: "completed",
          title: personaSnapshotFixture.displayName,
        },
        type: "companion.notification.created",
      },
      protocolVersion: 1,
      recipient: { deviceId: IDS.device, kind: "android" },
    });
    expect(firstGenerate).toHaveBeenCalledOnce();
    expect(firstEnqueue.mock.calls[0]?.[0]).toMatchObject({
      credential: CREDENTIAL,
      relayOrigin: "https://relay.example.test",
    });
    expect(bridge.getMessageProjection(assistantMessage.id)).toMatchObject({
      deviceId: IDS.device,
      envelopeId: IDS.notificationEnvelope,
      messageId: assistantMessage.id,
      state: "submitted",
      surface: "android_notification",
    });
    expect(bridge.getPairedDevice()?.device.status.state).toBe("offline");
    await firstService.shutdown();

    clock.advance(60_000);
    const secondGenerate = vi.fn(() => IDS.replacementEnvelope);
    const secondEnqueue = vi.fn<CompanionRelayClient["enqueueAndroidMailbox"]>(
      ({ request }) =>
        Promise.resolve({
          envelope: {
            createdAt: clock.now(),
            cursor: "cursor-android-notification-1",
            event: request.event,
            expiresAt: EXPIRES_AT,
            id: request.envelopeId,
            protocolVersion: 1,
            recipient: request.recipient,
          },
          protocolVersion: 1,
        }),
    );
    const restartedService = new CompanionMessageProjectionService({
      bridge,
      chats,
      clock,
      idGenerator: { generate: secondGenerate },
      onStatusChange: (deviceId, status) =>
        statusBridge.service.updateDeviceStatus(deviceId, status),
      relay: { enqueueAndroidMailbox: secondEnqueue },
      runs,
      secretStore: { get: getSecret },
    });
    services.push(restartedService);

    restartedService.start();
    await vi.waitFor(() =>
      expect(bridge.getMessageProjection(assistantMessage.id)?.state).toBe(
        "acknowledged",
      ),
    );

    expect(secondEnqueue).toHaveBeenCalledOnce();
    expect(secondEnqueue.mock.calls[0]?.[0].request).toEqual(firstRequest);
    expect(secondGenerate).not.toHaveBeenCalled();
    expect(bridge.getMessageProjection(assistantMessage.id)).toMatchObject({
      deviceId: IDS.device,
      envelopeId: IDS.notificationEnvelope,
      messageId: assistantMessage.id,
      state: "acknowledged",
      surface: "android_notification",
    });
    expect(bridge.getPairedDevice()?.device.status.state).toBe("online");
    expect(
      statusBridge.snapshots.map((snapshot) =>
        snapshot.state === "paired" ? snapshot.device.status.state : undefined,
      ),
    ).toEqual(["offline", "online"]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM companion_message_projections WHERE message_id = ?",
        )
        .get(assistantMessage.id),
    ).toEqual({ count: 1 });

    expect(restartedService.observeRun(completedEnvelope)).toMatchObject({
      kind: "existing",
      state: "acknowledged",
      surface: "android_notification",
    });
    restartedService.wake();
    await restartedService.shutdown();
    expect(secondEnqueue).toHaveBeenCalledOnce();
  });

  it("persists a projection protocol error and keeps it visible when the other worker reports online", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "charamate-companion-protocol-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    databases.push(database);

    const clock = new FakeClock(COMPLETED_AT);
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    const bridge = new CompanionBridgeRepository(database);
    const statusBridge = createStatusBridge(bridge, clock);
    chats.insertChat({
      createdAt: STARTED_AT,
      id: IDS.chat,
      status: "active",
      title: "Presentation 加油",
      updatedAt: STARTED_AT,
    });
    bridge.pairDevice({
      credentialRef: IDS.credential,
      device: {
        displayName: "Pixel 10",
        id: IDS.device,
        installationId: IDS.installation,
        notificationPermission: "granted",
        notificationsEnabled: true,
        pairedAt: STARTED_AT,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: COMPLETED_AT, state: "online" },
      },
      relayOrigin: "https://relay.example.test",
      updatedAt: COMPLETED_AT,
    });
    const startedRun = {
      chatId: IDS.chat,
      createdAt: STARTED_AT,
      execution: { mode: "chat" },
      id: IDS.run,
      latestSequence: 1,
      persona: personaSnapshotFixture,
      provider: providerSnapshotFixture,
      source: "text",
      startedAt: STARTED_AT,
      status: "running",
    } satisfies Run;
    runs.appendEvent({
      event: { run: startedRun, type: "run.started" },
      occurredAt: STARTED_AT,
      sequence: 1,
      streamId: startedRun.id,
    });
    const completedRun = {
      ...startedRun,
      endedAt: COMPLETED_AT,
      latestSequence: 2,
      status: "completed",
    } satisfies Run;
    runs.appendEvent({
      event: { run: completedRun, type: "run.completed" },
      occurredAt: COMPLETED_AT,
      sequence: 2,
      streamId: completedRun.id,
    });
    chats.insertMessage({
      chatId: IDS.chat,
      content: RESPONSE,
      createdAt: ASSISTANT_CREATED_AT,
      id: IDS.protocolAssistantMessage,
      role: "assistant",
      runId: IDS.run,
      status: "completed",
      updatedAt: ASSISTANT_CREATED_AT,
    });

    const enqueue = vi.fn<CompanionRelayClient["enqueueAndroidMailbox"]>(
      ({ request }) =>
        Promise.resolve({
          envelope: {
            createdAt: clock.now(),
            cursor: "cursor-wrong-receipt",
            event: request.event,
            expiresAt: EXPIRES_AT,
            id: IDS.replacementEnvelope,
            protocolVersion: 1,
            recipient: request.recipient,
          },
          protocolVersion: 1,
        }),
    );
    const service = new CompanionMessageProjectionService({
      bridge,
      chats,
      clock,
      idGenerator: { generate: () => IDS.notificationEnvelope },
      onStatusChange: (deviceId, status) =>
        statusBridge.service.updateDeviceStatus(deviceId, status),
      relay: { enqueueAndroidMailbox: enqueue },
      runs,
      secretStore: { get: () => Promise.resolve(CREDENTIAL) },
    });
    services.push(service);

    expect(
      service.selectImportantMoment(IDS.protocolAssistantMessage, true),
    ).toMatchObject({
      acceptedBySelectedSurface: true,
      state: "selected",
      surface: "android_notification",
    });
    await vi.waitFor(() =>
      expect(
        bridge.getMessageProjection(IDS.protocolAssistantMessage)?.state,
      ).toBe("failed"),
    );
    expect(bridge.getPairedDevice()?.device.status).toMatchObject({
      state: "protocol_error",
    });
    expect(statusBridge.snapshots.at(-1)).toMatchObject({
      device: { status: { state: "protocol_error" } },
      state: "paired",
    });

    clock.advance(60_000);
    expect(
      statusBridge.service.updateDeviceStatus(IDS.device, {
        observedAt: clock.now(),
        state: "online",
      }),
    ).toMatchObject({
      device: { status: { state: "protocol_error" } },
      state: "paired",
    });
    expect(bridge.getPairedDevice()?.device.status.state).toBe(
      "protocol_error",
    );
  });
});
