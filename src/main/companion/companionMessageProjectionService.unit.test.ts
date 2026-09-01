import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompanionAndroidMailboxEnqueueReceipt,
  CompanionAndroidMailboxEnqueueRequest,
  CompanionDeviceStatus,
} from "../../shared/contracts/companion";
import type { Message } from "../../shared/contracts/chat";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Run } from "../../shared/contracts/run";
import {
  personaSnapshotFixture,
  providerSnapshotFixture,
} from "../../../tests/fixtures/foundationContracts";
import { RunRepository } from "../agent/runRepository";
import { ChatRepository } from "../chat/chatRepository";
import { CURRENT_SCHEMA_SQL, METADATA_SCHEMA_SQL } from "../db/schema/current";
import { ProviderError } from "../providers/providerError";
import type { ProviderSecretStore } from "../providers/secretStore";
import {
  CompanionBridgeRepository,
  type PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";
import {
  CompanionMessageProjectionService,
  type CompanionMessageProjectionServiceDependencies,
} from "./companionMessageProjectionService";
import {
  CompanionRelayClientError,
  type CompanionRelayClient,
} from "./companionRelayClient";

const IDS = {
  assistant: "30000000-0000-4000-8000-000000000003",
  assistantLatest: "31000000-0000-4000-8000-000000000003",
  chat: "10000000-0000-4000-8000-000000000001",
  credential: "50000000-0000-4000-8000-000000000005",
  device: "40000000-0000-4000-8000-000000000004",
  installation: "41000000-0000-4000-8000-000000000004",
  invalidReceiptEnvelope: "d0000000-0000-4000-8000-00000000000d",
  notificationEnvelope: "60000000-0000-4000-8000-000000000006",
  replacementEnvelope: "c0000000-0000-4000-8000-00000000000c",
  otherCredential: "51000000-0000-4000-8000-000000000005",
  otherDevice: "42000000-0000-4000-8000-000000000004",
  otherInstallation: "43000000-0000-4000-8000-000000000004",
  run: "20000000-0000-4000-8000-000000000002",
  shareEnvelope: "70000000-0000-4000-8000-000000000007",
  submission: "80000000-0000-4000-8000-000000000008",
  user: "32000000-0000-4000-8000-000000000003",
} as const;

const CREATED = "2026-09-01T08:00:00.000Z";
const OLDER = "2026-09-01T08:01:00.000Z";
const NOW = "2026-09-01T08:02:00.000Z";
const ENDED = "2026-09-01T08:03:00.000Z";
const EXPIRES = "2026-09-02T08:00:00.000Z";

interface Harness {
  readonly bridge: CompanionBridgeRepository;
  readonly chats: ChatRepository;
  readonly database: Database.Database;
  readonly enqueueAndroidMailbox: ReturnType<
    typeof vi.fn<CompanionRelayClient["enqueueAndroidMailbox"]>
  >;
  readonly errors: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  readonly generate: ReturnType<typeof vi.fn<() => string>>;
  readonly getCredential: ReturnType<typeof vi.fn<ProviderSecretStore["get"]>>;
  readonly runs: RunRepository;
  readonly statuses: Array<{
    readonly deviceId: string;
    readonly status: CompanionDeviceStatus;
  }>;
}

const databases: Database.Database[] = [];
const services: CompanionMessageProjectionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

function pairedDevice(
  overrides: Partial<PairedCompanionDeviceRecord> = {},
): PairedCompanionDeviceRecord {
  return {
    credentialRef: IDS.credential,
    device: {
      displayName: "Pixel",
      id: IDS.device,
      installationId: IDS.installation,
      notificationPermission: "granted",
      notificationsEnabled: true,
      pairedAt: CREATED,
      platform: "android",
      protocolVersion: 1,
      status: { observedAt: NOW, state: "online" },
    },
    relayOrigin: "https://relay.example.test",
    updatedAt: NOW,
    ...overrides,
  };
}

function notificationReceipt(
  request: CompanionAndroidMailboxEnqueueRequest,
): CompanionAndroidMailboxEnqueueReceipt {
  return {
    envelope: {
      createdAt: NOW,
      cursor: "opaque-android-cursor",
      event: request.event,
      expiresAt: EXPIRES,
      id: request.envelopeId,
      protocolVersion: 1,
      recipient: request.recipient,
    },
    protocolVersion: 1,
  };
}

function createHarness(): Harness {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec(METADATA_SCHEMA_SQL);
  database.exec(CURRENT_SCHEMA_SQL);
  const bridge = new CompanionBridgeRepository(database);
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  chats.insertChat({
    createdAt: CREATED,
    id: IDS.chat,
    status: "active",
    title: "Companion projection",
    updatedAt: CREATED,
  });
  bridge.pairDevice(pairedDevice());
  const enqueueAndroidMailbox =
    vi.fn<CompanionRelayClient["enqueueAndroidMailbox"]>();
  enqueueAndroidMailbox.mockImplementation(({ request }) =>
    Promise.resolve(notificationReceipt(request)),
  );
  const getCredential = vi.fn<ProviderSecretStore["get"]>();
  getCredential.mockResolvedValue("device-credential");
  return {
    bridge,
    chats,
    database,
    enqueueAndroidMailbox,
    errors: vi.fn(),
    generate: vi.fn(() => IDS.notificationEnvelope),
    getCredential,
    runs,
    statuses: [],
  };
}

function createService(harness: Harness): CompanionMessageProjectionService {
  const dependencies: CompanionMessageProjectionServiceDependencies = {
    bridge: harness.bridge,
    chats: harness.chats,
    clock: { now: () => NOW },
    idGenerator: { generate: harness.generate },
    onBackgroundError: harness.errors,
    onStatusChange: (deviceId, status) => {
      harness.statuses.push({ deviceId, status });
      harness.bridge.updateDeviceStatus(deviceId, status);
    },
    relay: { enqueueAndroidMailbox: harness.enqueueAndroidMailbox },
    runs: harness.runs,
    secretStore: { get: harness.getCredential },
  };
  const service = new CompanionMessageProjectionService(dependencies);
  services.push(service);
  return service;
}

function persistCompletedRun(harness: Harness): Run {
  const running = {
    chatId: IDS.chat,
    createdAt: CREATED,
    execution: { approvalMode: "request_approval", mode: "agent" },
    id: IDS.run,
    latestSequence: 1,
    persona: personaSnapshotFixture,
    provider: providerSnapshotFixture,
    source: "text",
    startedAt: CREATED,
    status: "running",
  } satisfies Run;
  harness.runs.appendEvent({
    event: { run: running, type: "run.started" },
    occurredAt: CREATED,
    sequence: 1,
    streamId: IDS.run,
  });
  const completed = {
    ...running,
    endedAt: ENDED,
    latestSequence: 2,
    status: "completed",
  } satisfies Run;
  harness.runs.appendEvent({
    event: { run: completed, type: "run.completed" },
    occurredAt: ENDED,
    sequence: 2,
    streamId: IDS.run,
  });
  return completed;
}

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    chatId: IDS.chat,
    content: "看样子至少你现在还有心情拍夕阳，应该不算太糟？",
    createdAt: NOW,
    id: IDS.assistant,
    role: "assistant",
    runId: IDS.run,
    status: "completed",
    updatedAt: NOW,
    ...overrides,
  };
}

function completedEnvelope(run: Run): RunEventEnvelope {
  return {
    event: { run, type: "run.completed" },
    occurredAt: ENDED,
    sequence: 2,
    streamId: run.id,
  };
}

function claimShare(harness: Harness): void {
  harness.bridge.claimShare({
    claimedAt: CREATED,
    cursor: "opaque-desktop-cursor",
    deviceId: IDS.device,
    envelopeId: IDS.shareEnvelope,
    expiresAt: EXPIRES,
    payloadSha256: "a".repeat(64),
    sourceKind: "text",
    submissionId: IDS.submission,
  });
  harness.bridge.bindOrRebindShareRun({
    runId: IDS.run,
    submissionId: IDS.submission,
    updatedAt: NOW,
  });
}

async function expectProjectionState(
  harness: Harness,
  state: "acknowledged" | "failed" | "submitted",
  messageId: string = IDS.assistant,
): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.bridge.getMessageProjection(messageId)?.state).toBe(state);
  });
}

describe("CompanionMessageProjectionService", () => {
  it("reserves one Android surface and acknowledges the exact persisted reply", async () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    const message = harness.chats.insertMessage(assistantMessage());
    const service = createService(harness);

    expect(service.selectImportantMoment(message.id, true)).toMatchObject({
      acceptedBySelectedSurface: true,
      kind: "reserved",
      shouldProjectDesktop: false,
      state: "selected",
      surface: "android_notification",
    });
    await expectProjectionState(harness, "acknowledged");

    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
    const { signal, ...submission } =
      harness.enqueueAndroidMailbox.mock.calls[0]![0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(submission).toEqual({
      credential: "device-credential",
      relayOrigin: "https://relay.example.test",
      request: {
        envelopeId: IDS.notificationEnvelope,
        event: {
          deviceId: IDS.device,
          notification: {
            body: message.content,
            chatId: IDS.chat,
            messageCreatedAt: NOW,
            messageId: IDS.assistant,
            role: "assistant",
            status: "completed",
            title: "Mika",
          },
          type: "companion.notification.created",
        },
        protocolVersion: 1,
        recipient: { deviceId: IDS.device, kind: "android" },
      },
    });
    expect(service.selectImportantMoment(message.id, true)).toMatchObject({
      acceptedBySelectedSurface: true,
      kind: "existing",
      state: "acknowledged",
    });
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
  });

  it("returns projected Desktop state without asking the caller to show twice", () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    harness.chats.insertMessage(assistantMessage());
    const service = createService(harness);

    expect(service.selectImportantMoment(IDS.assistant, false)).toMatchObject({
      acceptedBySelectedSurface: false,
      kind: "reserved",
      shouldProjectDesktop: true,
      state: "selected",
      surface: "desktop_bubble",
    });
    service.markDesktopProjected(IDS.assistant);
    expect(service.selectImportantMoment(IDS.assistant, true)).toMatchObject({
      acceptedBySelectedSurface: true,
      kind: "existing",
      shouldProjectDesktop: false,
      state: "projected",
      surface: "desktop_bubble",
    });
    expect(harness.enqueueAndroidMailbox).not.toHaveBeenCalled();
  });

  it("uses the latest completed Assistant Message for live Android share completion", async () => {
    const harness = createHarness();
    const run = persistCompletedRun(harness);
    claimShare(harness);
    harness.chats.insertMessage(
      assistantMessage({
        content: "较早的工具前回复",
        createdAt: OLDER,
        id: IDS.assistantLatest,
        updatedAt: OLDER,
      }),
    );
    const latest = harness.chats.insertMessage(assistantMessage());
    const service = createService(harness);

    const first = service.observeRun(completedEnvelope(run));
    expect(first).toMatchObject({
      kind: "reserved",
      projection: { messageId: latest.id },
      surface: "android_notification",
    });
    await expectProjectionState(harness, "acknowledged");
    expect(
      harness.enqueueAndroidMailbox.mock.calls[0]?.[0].request.event,
    ).toMatchObject({
      notification: { body: latest.content, messageId: latest.id },
    });

    expect(service.observeRun(completedEnvelope(run))).toMatchObject({
      kind: "existing",
      projection: { envelopeId: first?.projection.envelopeId },
      state: "acknowledged",
    });
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
  });

  it("recovers a completed claimed share and retries an unknown submitted result with the same request", async () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    claimShare(harness);
    harness.chats.insertMessage(assistantMessage());
    harness.enqueueAndroidMailbox.mockRejectedValueOnce(
      new Error("connection ended after submission"),
    );
    const firstService = createService(harness);

    firstService.start();
    await expectProjectionState(harness, "submitted");
    await vi.waitFor(() =>
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1),
    );
    expect(harness.statuses).toEqual([
      {
        deviceId: IDS.device,
        status: { observedAt: NOW, state: "offline" },
      },
    ]);
    const firstRequest =
      harness.enqueueAndroidMailbox.mock.calls[0]?.[0].request;
    await firstService.shutdown();

    const secondService = createService(harness);
    secondService.start();
    await expectProjectionState(harness, "acknowledged");
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(2);
    expect(harness.enqueueAndroidMailbox.mock.calls[1]?.[0].request).toEqual(
      firstRequest,
    );
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.statuses).toEqual([
      {
        deviceId: IDS.device,
        status: { observedAt: NOW, state: "offline" },
      },
      {
        deviceId: IDS.device,
        status: { observedAt: NOW, state: "online" },
      },
    ]);
  });

  it("honors a valid Retry-After before retrying the same submitted envelope", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    persistCompletedRun(harness);
    harness.chats.insertMessage(assistantMessage());
    harness.enqueueAndroidMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "Relay is busy", 503, 25),
    );
    const service = createService(harness);

    service.selectImportantMoment(IDS.assistant, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
    expect(harness.bridge.getMessageProjection(IDS.assistant)?.state).toBe(
      "submitted",
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(2);
    expect(harness.bridge.getMessageProjection(IDS.assistant)?.state).toBe(
      "acknowledged",
    );
    expect(harness.enqueueAndroidMailbox.mock.calls[1]?.[0].request).toEqual(
      harness.enqueueAndroidMailbox.mock.calls[0]?.[0].request,
    );
  });

  it("keeps a disabled-device selection pending and wakes it when selected again", async () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    harness.chats.insertMessage(assistantMessage());
    const service = createService(harness);
    await service.pause();

    service.selectImportantMoment(IDS.assistant, true);
    harness.bridge.setNotificationsEnabled(IDS.device, false, NOW);
    service.resume();
    await vi.waitFor(() =>
      expect(harness.bridge.getMessageProjection(IDS.assistant)?.state).toBe(
        "selected",
      ),
    );
    expect(harness.enqueueAndroidMailbox).not.toHaveBeenCalled();

    harness.bridge.setNotificationsEnabled(IDS.device, true, NOW);
    expect(service.selectImportantMoment(IDS.assistant, true)).toMatchObject({
      kind: "existing",
      state: "selected",
      surface: "android_notification",
    });
    await expectProjectionState(harness, "acknowledged");
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
  });

  it("fails a frozen old-device projection after unpair without rerouting it", async () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    harness.chats.insertMessage(assistantMessage());
    const service = createService(harness);
    await service.pause();
    const selected = service.selectImportantMoment(IDS.assistant, true);

    harness.bridge.unpairDevice(IDS.device);
    harness.bridge.pairDevice(
      pairedDevice({
        credentialRef: IDS.otherCredential,
        device: {
          ...pairedDevice().device,
          id: IDS.otherDevice,
          installationId: IDS.otherInstallation,
        },
      }),
    );
    service.resume();
    await expectProjectionState(harness, "failed");

    expect(harness.enqueueAndroidMailbox).not.toHaveBeenCalled();
    expect(harness.bridge.getMessageProjection(IDS.assistant)).toMatchObject({
      deviceId: IDS.device,
      envelopeId: selected.projection.envelopeId,
      state: "failed",
      surface: "android_notification",
    });
  });

  it("latches a missing device credential until re-pair and preserves the remaining queue", async () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    harness.chats.insertMessage(assistantMessage());
    harness.chats.insertMessage(
      assistantMessage({
        content: "第二条等待投影的回复",
        createdAt: ENDED,
        id: IDS.assistantLatest,
        updatedAt: ENDED,
      }),
    );
    harness.generate
      .mockReturnValueOnce(IDS.notificationEnvelope)
      .mockReturnValueOnce(IDS.replacementEnvelope);
    harness.getCredential.mockRejectedValueOnce(
      new ProviderError(
        "PROVIDER.CREDENTIAL_REQUIRED",
        "missing credential",
        false,
      ),
    );
    const service = createService(harness);
    await service.pause();

    service.selectImportantMoment(IDS.assistant, true);
    service.selectImportantMoment(IDS.assistantLatest, true);
    service.resume();
    await expectProjectionState(harness, "failed");

    expect(harness.getCredential).toHaveBeenCalledTimes(1);
    expect(harness.enqueueAndroidMailbox).not.toHaveBeenCalled();
    expect(
      harness.bridge.getMessageProjection(IDS.assistantLatest),
    ).toMatchObject({ state: "selected" });
    expect(harness.statuses).toEqual([
      {
        deviceId: IDS.device,
        status: {
          message: "手机 Companion 的连接凭据不可用，请重新配对。",
          observedAt: NOW,
          state: "protocol_error",
        },
      },
    ]);
    expect(harness.bridge.getPairedDevice()?.device.status).toEqual(
      harness.statuses[0]?.status,
    );

    service.wake();
    service.start();
    await Promise.resolve();
    expect(harness.getCredential).toHaveBeenCalledTimes(1);
    expect(
      harness.bridge.getMessageProjection(IDS.assistantLatest)?.state,
    ).toBe("selected");

    harness.bridge.unpairDevice(IDS.device);
    harness.bridge.pairDevice(pairedDevice());
    service.reset();
    await expectProjectionState(harness, "acknowledged", IDS.assistantLatest);

    expect(harness.getCredential).toHaveBeenCalledTimes(2);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
    expect(
      harness.enqueueAndroidMailbox.mock.calls[0]?.[0].request.event,
    ).toMatchObject({
      notification: { messageId: IDS.assistantLatest },
    });
    expect(harness.bridge.getMessageProjection(IDS.assistant)?.state).toBe(
      "failed",
    );
  });

  it("leaves non-credential secret-store failures pending for a natural retry", async () => {
    const harness = createHarness();
    persistCompletedRun(harness);
    harness.chats.insertMessage(assistantMessage());
    harness.getCredential.mockRejectedValueOnce(
      new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "secret store unavailable",
        false,
      ),
    );
    const service = createService(harness);

    service.selectImportantMoment(IDS.assistant, true);
    await vi.waitFor(() =>
      expect(harness.getCredential).toHaveBeenCalledOnce(),
    );

    expect(harness.bridge.getMessageProjection(IDS.assistant)?.state).toBe(
      "selected",
    );
    expect(harness.statuses).toEqual([]);
    expect(harness.enqueueAndroidMailbox).not.toHaveBeenCalled();

    service.wake();
    await expectProjectionState(harness, "acknowledged");
    expect(harness.getCredential).toHaveBeenCalledTimes(2);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      configureFailure: (harness: Harness) =>
        harness.enqueueAndroidMailbox.mockRejectedValueOnce(
          new CompanionRelayClientError(
            "protocol",
            "receipt does not match request",
          ),
        ),
      expectedMessage: "receipt does not match request",
      kind: "Relay protocol error",
    },
    {
      configureFailure: (harness: Harness) =>
        harness.enqueueAndroidMailbox.mockImplementationOnce(({ request }) =>
          Promise.resolve({
            ...notificationReceipt(request),
            envelope: {
              ...notificationReceipt(request).envelope,
              id: IDS.invalidReceiptEnvelope,
            },
          }),
        ),
      expectedMessage:
        "Companion Relay returned a receipt for another Android mailbox event.",
      kind: "local receipt identity error",
    },
  ])(
    "latches a $kind until reset before continuing the queue",
    async ({ configureFailure, expectedMessage }) => {
      const harness = createHarness();
      persistCompletedRun(harness);
      harness.chats.insertMessage(assistantMessage());
      harness.chats.insertMessage(
        assistantMessage({
          content: "第二条等待投影的回复",
          createdAt: ENDED,
          id: IDS.assistantLatest,
          updatedAt: ENDED,
        }),
      );
      harness.generate
        .mockReturnValueOnce(IDS.notificationEnvelope)
        .mockReturnValueOnce(IDS.replacementEnvelope);
      configureFailure(harness);
      const service = createService(harness);
      await service.pause();

      service.selectImportantMoment(IDS.assistant, true);
      service.selectImportantMoment(IDS.assistantLatest, true);
      service.resume();
      await expectProjectionState(harness, "failed");
      await vi.waitFor(() =>
        expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1),
      );

      expect(
        harness.bridge.getMessageProjection(IDS.assistantLatest),
      ).toMatchObject({ state: "selected" });
      expect(harness.statuses).toEqual([
        {
          deviceId: IDS.device,
          status: {
            message: expectedMessage,
            observedAt: NOW,
            state: "protocol_error",
          },
        },
      ]);
      expect(service.selectImportantMoment(IDS.assistant, true)).toMatchObject({
        acceptedBySelectedSurface: false,
        kind: "existing",
        state: "failed",
        surface: "android_notification",
      });

      service.wake();
      service.start();
      await Promise.resolve();
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
      expect(
        harness.bridge.getMessageProjection(IDS.assistantLatest)?.state,
      ).toBe("selected");

      harness.bridge.unpairDevice(IDS.device);
      harness.bridge.pairDevice(pairedDevice());
      service.reset();
      await expectProjectionState(harness, "acknowledged", IDS.assistantLatest);
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(2);
      expect(
        harness.enqueueAndroidMailbox.mock.calls[1]?.[0].request.event,
      ).toMatchObject({
        notification: { messageId: IDS.assistantLatest },
      });
      expect(harness.statuses.at(-1)).toEqual({
        deviceId: IDS.device,
        status: { observedAt: NOW, state: "online" },
      });
      expect(harness.bridge.getMessageProjection(IDS.assistant)?.state).toBe(
        "failed",
      );
    },
  );
});
