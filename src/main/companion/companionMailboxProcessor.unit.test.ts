import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompanionDesktopMailboxEnvelope,
  CompanionDesktopMailboxPage,
  CompanionDeviceStatus,
  CompanionShareImportedAckResult,
} from "../../shared/contracts/companion";
import {
  CompanionBridgePersistenceError,
  type CompanionShareImportRecord,
  type PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";
import { ProviderError } from "../providers/providerError";
import {
  CompanionMailboxProcessor,
  type CompanionMailboxProcessorDependencies,
} from "./companionMailboxProcessor";
import {
  CompanionRelayClientError,
  type CompanionRelayClient,
} from "./companionRelayClient";
import { CompanionShareIngressError } from "./companionShareIngress";

const IDS = {
  attachment: "90000000-0000-4000-8000-000000000009",
  chat: "70000000-0000-4000-8000-000000000007",
  credential: "30000000-0000-4000-8000-000000000003",
  desktop: "10000000-0000-4000-8000-000000000001",
  device: "20000000-0000-4000-8000-000000000002",
  envelope1: "40000000-0000-4000-8000-000000000004",
  envelope2: "50000000-0000-4000-8000-000000000005",
  installation: "a0000000-0000-4000-8000-00000000000a",
  message: "80000000-0000-4000-8000-000000000008",
  otherDevice: "c0000000-0000-4000-8000-00000000000c",
  submission1: "60000000-0000-4000-8000-000000000006",
  submission2: "b0000000-0000-4000-8000-00000000000b",
} as const;

const NOW = "2026-09-01T08:00:00.000Z";
const EXPIRES_AT = "2026-09-01T09:00:00.000Z";

function pairedDevice(): PairedCompanionDeviceRecord {
  return {
    credentialRef: IDS.credential,
    device: {
      displayName: "Android",
      id: IDS.device,
      installationId: IDS.installation,
      notificationPermission: "granted",
      notificationsEnabled: true,
      pairedAt: NOW,
      platform: "android",
      protocolVersion: 1,
      status: { observedAt: NOW, state: "offline" },
    },
    relayOrigin: "https://relay.example.com",
    updatedAt: NOW,
  };
}

function envelope(
  sequence: 1 | 2,
  options: {
    readonly cursor?: string;
    readonly desktopInstanceId?: string;
    readonly deviceId?: string;
  } = {},
): CompanionDesktopMailboxEnvelope {
  return {
    createdAt: NOW,
    cursor: options.cursor ?? `cursor-${String(sequence)}`,
    event: {
      deviceId: options.deviceId ?? IDS.device,
      share: {
        kind: "text",
        mediaType: "text/plain",
        submissionId: sequence === 1 ? IDS.submission1 : IDS.submission2,
        target: { kind: "new_chat" },
        text: `share ${String(sequence)}`,
      },
      type: "companion.share.uploaded",
    },
    expiresAt: EXPIRES_AT,
    id: sequence === 1 ? IDS.envelope1 : IDS.envelope2,
    protocolVersion: 1,
    recipient: {
      desktopInstanceId: options.desktopInstanceId ?? IDS.desktop,
      kind: "desktop",
    },
  };
}

function page(
  envelopes: CompanionDesktopMailboxEnvelope[],
  options: {
    readonly desktopInstanceId?: string;
    readonly hasMore?: boolean;
  } = {},
): CompanionDesktopMailboxPage {
  return {
    envelopes,
    hasMore: options.hasMore ?? false,
    protocolVersion: 1,
    recipient: {
      desktopInstanceId: options.desktopInstanceId ?? IDS.desktop,
      kind: "desktop",
    },
  };
}

function importedRecord(
  value: CompanionDesktopMailboxEnvelope,
): CompanionShareImportRecord {
  return {
    chatId: IDS.chat,
    claimedAt: NOW,
    cursor: value.cursor,
    deviceId: value.event.deviceId,
    envelopeId: value.id,
    expiresAt: value.expiresAt,
    importedAt: NOW,
    messageId: IDS.message,
    payloadSha256: "0".repeat(64),
    sourceKind: "text",
    state: "imported",
    submissionId: value.event.share.submissionId,
    updatedAt: NOW,
  };
}

function result(
  value: CompanionDesktopMailboxEnvelope,
): CompanionShareImportedAckResult {
  return {
    chatId: IDS.chat,
    messageId: IDS.message,
    submissionId: value.event.share.submissionId,
    type: "share.imported",
  };
}

function pendingUntilAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createHarness(
  options: {
    readonly advanceCursorOnImport?: boolean;
    readonly cursor?: string;
    readonly pending?: CompanionShareImportRecord[];
  } = {},
) {
  let cursor = options.cursor;
  let paired: PairedCompanionDeviceRecord | undefined = pairedDevice();
  let pending = [...(options.pending ?? [])];
  const statuses: Array<{
    readonly deviceId: string;
    readonly status: CompanionDeviceStatus;
  }> = [];
  const order: string[] = [];

  const fetchDesktopMailbox =
    vi.fn<CompanionRelayClient["fetchDesktopMailbox"]>();
  fetchDesktopMailbox.mockImplementation(({ signal }) =>
    pendingUntilAbort(signal),
  );
  const acknowledgeDesktopMailbox = vi.fn<
    CompanionRelayClient["acknowledgeDesktopMailbox"]
  >(({ ack }) => {
    order.push(`ack:${ack.result.submissionId}`);
    return Promise.resolve();
  });
  const relay: CompanionRelayClient = {
    acknowledgeDesktopMailbox,
    createPairingTicket: vi.fn(() => Promise.reject(new Error("unused"))),
    fetchDesktopMailbox,
    readAsset: vi.fn(() => Promise.resolve(Buffer.alloc(0))),
    setNotificationsEnabled: vi.fn(() => Promise.resolve()),
    unpairDevice: vi.fn(() => Promise.resolve()),
    waitForPairingGrant: vi.fn(() => Promise.resolve(undefined)),
  };
  const importEnvelope = vi.fn((value: CompanionDesktopMailboxEnvelope) => {
    order.push(`import:${value.event.share.submissionId}`);
    if (options.advanceCursorOnImport !== false) cursor = value.cursor;
    pending.push(importedRecord(value));
    return Promise.resolve(result(value));
  });
  const markShareAcked = vi.fn(
    (submissionId: string, acknowledgedAt: string) => {
      order.push(`mark:${submissionId}`);
      const record = pending.find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!record) throw new Error("missing pending acknowledgement");
      pending = pending.filter(
        (candidate) => candidate.submissionId !== submissionId,
      );
      return { ...record, relayAckedAt: acknowledgedAt };
    },
  );
  const listPendingShareAcks = vi.fn((deviceId: string) =>
    pending.filter((record) => record.deviceId === deviceId),
  );
  const dependencies: CompanionMailboxProcessorDependencies = {
    bridge: {
      getDesktopMailboxCursor: vi.fn(() => cursor),
      getOrCreateDesktopInstanceId: vi.fn(() => IDS.desktop),
      getPairedDevice: vi.fn(() => paired),
      listPendingShareAcks,
      markShareAcked,
    },
    clock: { now: vi.fn(() => NOW) },
    ingress: { importEnvelope },
    onStatusChange: (deviceId, status) => statuses.push({ deviceId, status }),
    relay,
    secretStore: { get: vi.fn(() => Promise.resolve("device-credential")) },
  };
  return {
    acknowledgeDesktopMailbox,
    dependencies,
    fetchDesktopMailbox,
    importEnvelope,
    listPendingShareAcks,
    markShareAcked,
    order,
    processor: new CompanionMailboxProcessor(dependencies),
    setPairedDevice(value: PairedCompanionDeviceRecord | undefined) {
      paired = value;
    },
    statuses,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CompanionMailboxProcessor", () => {
  it("replays durable acknowledgements before fetching from the persisted cursor", async () => {
    const pending = importedRecord(envelope(1));
    const harness = createHarness({ cursor: "cursor-1", pending: [pending] });

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1),
    );
    expect(harness.dependencies.secretStore.get).toHaveBeenCalledWith(
      IDS.credential,
    );
    expect(harness.listPendingShareAcks).toHaveBeenCalledWith(IDS.device);
    const ackInput = harness.acknowledgeDesktopMailbox.mock.calls[0]?.[0];
    expect(ackInput?.signal).toBeInstanceOf(AbortSignal);
    expect(ackInput).toEqual({
      ack: {
        acknowledgedAt: NOW,
        cursor: "cursor-1",
        envelopeId: IDS.envelope1,
        protocolVersion: 1,
        recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
        result: result(envelope(1)),
      },
      credential: "device-credential",
      relayOrigin: "https://relay.example.com",
      signal: ackInput?.signal,
    });
    expect(harness.order).toEqual([
      `ack:${IDS.submission1}`,
      `mark:${IDS.submission1}`,
    ]);
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          afterCursor: "cursor-1",
          protocolVersion: 1,
          recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
        },
      }),
    );

    await harness.processor.shutdown();
  });

  it("ignores durable acknowledgements owned by an old Android pairing", async () => {
    const oldPending = {
      ...importedRecord(envelope(1)),
      deviceId: IDS.otherDevice,
    };
    const harness = createHarness({
      cursor: "cursor-1",
      pending: [oldPending],
    });

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1),
    );
    expect(harness.listPendingShareAcks).toHaveBeenCalledWith(IDS.device);
    expect(harness.acknowledgeDesktopMailbox).not.toHaveBeenCalled();

    await harness.processor.shutdown();
  });

  it("imports, acknowledges and commits each envelope before moving to the next", async () => {
    const first = envelope(1);
    const second = envelope(2);
    const harness = createHarness();
    harness.fetchDesktopMailbox.mockResolvedValueOnce(page([first, second]));

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2),
    );
    expect(harness.order).toEqual([
      `import:${IDS.submission1}`,
      `ack:${IDS.submission1}`,
      `mark:${IDS.submission1}`,
      `import:${IDS.submission2}`,
      `ack:${IDS.submission2}`,
      `mark:${IDS.submission2}`,
    ]);
    expect(harness.fetchDesktopMailbox.mock.calls[1]?.[0].request).toEqual({
      afterCursor: "cursor-2",
      protocolVersion: 1,
      recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
    });

    await harness.processor.shutdown();
  });

  it("stops after an ack failure and replays only that ack when woken", async () => {
    const first = envelope(1);
    const second = envelope(2);
    const harness = createHarness();
    harness.fetchDesktopMailbox.mockResolvedValueOnce(page([first, second]));
    harness.acknowledgeDesktopMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "relay unavailable"),
    );

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("offline"),
    );
    expect(harness.importEnvelope).toHaveBeenCalledTimes(1);
    expect(harness.markShareAcked).not.toHaveBeenCalled();

    harness.processor.wake();
    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2),
    );
    expect(harness.importEnvelope).toHaveBeenCalledTimes(1);
    expect(harness.acknowledgeDesktopMailbox).toHaveBeenCalledTimes(2);
    expect(harness.markShareAcked).toHaveBeenCalledWith(IDS.submission1, NOW);

    await harness.processor.shutdown();
  });

  it.each([
    new CompanionShareIngressError("COMPANION.SHARE_EXPIRED", "share expired"),
    new CompanionBridgePersistenceError(
      "COMPANION.MAILBOX_CURSOR_CONFLICT",
      "cursor conflict",
    ),
  ])("classifies $name as protocol_error", async (error) => {
    const harness = createHarness();
    harness.fetchDesktopMailbox.mockResolvedValueOnce(page([envelope(1)]));
    harness.importEnvelope.mockRejectedValueOnce(error);

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("protocol_error"),
    );
    expect(harness.acknowledgeDesktopMailbox).not.toHaveBeenCalled();

    await harness.processor.shutdown();
  });

  it("blocks with a re-pair instruction when the device credential is missing", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.secretStore.get).mockRejectedValueOnce(
      new ProviderError("PROVIDER.CREDENTIAL_REQUIRED", "missing", false),
    );

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status).toEqual({
        message: "手机 Companion 的连接凭据不可用，请重新配对。",
        observedAt: NOW,
        state: "protocol_error",
      }),
    );
    harness.processor.start();
    harness.processor.wake();
    await Promise.resolve();
    expect(harness.dependencies.secretStore.get).toHaveBeenCalledTimes(1);
    expect(harness.fetchDesktopMailbox).not.toHaveBeenCalled();

    await harness.processor.shutdown();
  });

  it("keeps a transient secret-store failure offline and retryable on wake", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.secretStore.get).mockRejectedValueOnce(
      new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "temporarily unavailable",
        true,
      ),
    );

    harness.processor.start();
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("offline"),
    );

    harness.processor.wake();
    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1),
    );
    expect(harness.dependencies.secretStore.get).toHaveBeenCalledTimes(2);

    await harness.processor.shutdown();
  });

  it.each([
    {
      name: "hasMore without an envelope",
      page: page([], { hasMore: true }),
    },
    {
      name: "a page for another Desktop",
      page: page([], {
        desktopInstanceId: "c0000000-0000-4000-8000-00000000000c",
      }),
    },
    {
      name: "an envelope from another Android",
      page: page([
        envelope(1, {
          deviceId: "d0000000-0000-4000-8000-00000000000d",
        }),
      ]),
    },
    {
      cursor: "cursor-1",
      name: "an envelope that repeats the current cursor",
      page: page([envelope(1)]),
    },
  ])(
    "stops with protocol_error for $name",
    async ({ cursor, page: response }) => {
      const harness = createHarness({ ...(cursor ? { cursor } : {}) });
      harness.fetchDesktopMailbox.mockResolvedValueOnce(response);

      harness.processor.start();

      await vi.waitFor(() =>
        expect(harness.statuses.at(-1)?.status.state).toBe("protocol_error"),
      );
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1);
      expect(harness.importEnvelope).not.toHaveBeenCalled();

      await harness.processor.shutdown();
    },
  );

  it("keeps a poisoned mailbox blocked until a successful pairing resets it", async () => {
    const harness = createHarness();
    harness.fetchDesktopMailbox.mockResolvedValueOnce(
      page([], { hasMore: true }),
    );

    harness.processor.start();
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("protocol_error"),
    );

    harness.processor.start();
    harness.processor.wake();
    harness.processor.restart();
    await Promise.resolve();
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1);

    harness.processor.reset();
    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2),
    );

    await harness.processor.shutdown();
  });

  it("retains a mismatch sanity check for repository acknowledgement results", async () => {
    const harness = createHarness();
    harness.listPendingShareAcks.mockReturnValueOnce([
      {
        ...importedRecord(envelope(1)),
        deviceId: IDS.otherDevice,
      },
    ]);

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("protocol_error"),
    );
    expect(harness.acknowledgeDesktopMailbox).not.toHaveBeenCalled();
    expect(harness.fetchDesktopMailbox).not.toHaveBeenCalled();

    await harness.processor.shutdown();
  });

  it("does not acknowledge an import that failed to advance the durable cursor", async () => {
    const harness = createHarness({ advanceCursorOnImport: false });
    harness.fetchDesktopMailbox.mockResolvedValueOnce(page([envelope(1)]));

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("protocol_error"),
    );
    expect(harness.importEnvelope).toHaveBeenCalledTimes(1);
    expect(harness.acknowledgeDesktopMailbox).not.toHaveBeenCalled();
    expect(harness.markShareAcked).not.toHaveBeenCalled();

    await harness.processor.shutdown();
  });

  it("waits for Relay retry-after before continuing the same mailbox", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cursor: "cursor-1" });
    harness.fetchDesktopMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "busy", 503, 2_000),
    );

    harness.processor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1);
    expect(harness.statuses.at(-1)?.status.state).toBe("offline");
    harness.processor.wake();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.secretStore.get).toHaveBeenCalledTimes(1);
    expect(harness.fetchDesktopMailbox.mock.calls[1]?.[0].request).toEqual({
      afterCursor: "cursor-1",
      protocolVersion: 1,
      recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
    });

    await harness.processor.shutdown();
  });

  it("replays an imported share acknowledgement after a directed immediate retry", async () => {
    const first = envelope(1);
    const second = envelope(2);
    const harness = createHarness();
    harness.fetchDesktopMailbox.mockResolvedValueOnce(page([first, second]));
    harness.acknowledgeDesktopMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "busy", 503, 0),
    );

    harness.processor.start();

    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2),
    );
    expect(harness.importEnvelope).toHaveBeenCalledTimes(1);
    expect(harness.acknowledgeDesktopMailbox).toHaveBeenCalledTimes(2);
    expect(harness.markShareAcked).toHaveBeenCalledOnce();
    expect(
      harness.statuses.some(({ status }) => status.state === "offline"),
    ).toBe(true);

    await harness.processor.shutdown();
  });

  it("cancels a Relay-directed retry wait when stopped", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.fetchDesktopMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "busy", 429, 2_000),
    );

    harness.processor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.statuses.at(-1)?.status.state).toBe("offline");

    await harness.processor.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1);

    await harness.processor.shutdown();
  });

  it("keeps one long poll and replaces it on restart", async () => {
    const harness = createHarness();

    harness.processor.start();
    harness.processor.start();
    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1),
    );
    const firstSignal = harness.fetchDesktopMailbox.mock.calls[0]?.[0].signal;

    harness.processor.restart();

    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2),
    );
    expect(firstSignal?.aborted).toBe(true);
    expect(harness.fetchDesktopMailbox.mock.calls[1]?.[0].signal).not.toBe(
      firstSignal,
    );

    await harness.processor.stop();
    await vi.waitFor(() =>
      expect(
        harness.fetchDesktopMailbox.mock.calls[1]?.[0].signal?.aborted,
      ).toBe(true),
    );
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2);
    await harness.processor.shutdown();
  });

  it("keeps the mailbox paused across incidental starts until unpair recovery resumes it", async () => {
    const harness = createHarness();

    harness.processor.start();
    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1),
    );
    const firstSignal = harness.fetchDesktopMailbox.mock.calls[0]?.[0].signal;

    const paused = harness.processor.pause();
    harness.processor.start();
    harness.processor.wake();
    harness.processor.restart();
    await paused;
    await Promise.resolve();

    expect(firstSignal?.aborted).toBe(true);
    expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(1);

    harness.processor.resume();
    await vi.waitFor(() =>
      expect(harness.fetchDesktopMailbox).toHaveBeenCalledTimes(2),
    );

    await harness.processor.shutdown();
  });

  it("does not start a mailbox session without a paired device", async () => {
    const harness = createHarness();
    harness.setPairedDevice(undefined);

    harness.processor.start();
    await harness.processor.shutdown();

    expect(harness.dependencies.secretStore.get).not.toHaveBeenCalled();
    expect(harness.fetchDesktopMailbox).not.toHaveBeenCalled();
  });
});
