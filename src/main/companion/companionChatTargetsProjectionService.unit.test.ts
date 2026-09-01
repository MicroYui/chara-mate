import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompanionAndroidMailboxEnqueueRequest,
  CompanionDeviceStatus,
} from "../../shared/contracts/companion";
import type { Chat } from "../../shared/contracts/chat";
import type { PairedCompanionDeviceRecord } from "./companionBridgeRepository";
import {
  CompanionChatTargetsProjectionService,
  type CompanionChatTargetsProjectionServiceDependencies,
} from "./companionChatTargetsProjectionService";
import {
  CompanionRelayClientError,
  type CompanionRelayClient,
} from "./companionRelayClient";

const IDS = {
  archived: "10000000-0000-4000-8000-000000000001",
  chat: "20000000-0000-4000-8000-000000000002",
  chat2: "30000000-0000-4000-8000-000000000003",
  credential: "40000000-0000-4000-8000-000000000004",
  device: "50000000-0000-4000-8000-000000000005",
  envelope: "60000000-0000-4000-8000-000000000006",
  envelope2: "70000000-0000-4000-8000-000000000007",
  installation: "80000000-0000-4000-8000-000000000008",
} as const;

const NOW = "2026-09-01T09:00:00.000Z";
const LATER = "2026-09-01T09:05:00.000Z";
const EXPIRES_AT = "2026-09-02T09:00:00.000Z";

function pairedDevice(): PairedCompanionDeviceRecord {
  return {
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
  };
}

function chat(
  id: string,
  title: string,
  updatedAt: string,
  status: Chat["status"] = "active",
): Chat {
  return {
    ...(status === "archived" ? { archivedAt: updatedAt } : {}),
    createdAt: NOW,
    id,
    status,
    title,
    updatedAt,
  };
}

function receipt(request: CompanionAndroidMailboxEnqueueRequest) {
  return {
    envelope: {
      createdAt: NOW,
      cursor: `cursor-${request.envelopeId}`,
      event: request.event,
      expiresAt: EXPIRES_AT,
      id: request.envelopeId,
      protocolVersion: 1 as const,
      recipient: request.recipient,
    },
    protocolVersion: 1 as const,
  };
}

interface Harness {
  readonly dependencies: CompanionChatTargetsProjectionServiceDependencies;
  readonly enqueueAndroidMailbox: ReturnType<
    typeof vi.fn<CompanionRelayClient["enqueueAndroidMailbox"]>
  >;
  readonly errors: unknown[];
  readonly generate: ReturnType<typeof vi.fn<() => string>>;
  readonly service: CompanionChatTargetsProjectionService;
  readonly statuses: Array<{
    readonly deviceId: string;
    readonly status: CompanionDeviceStatus;
  }>;
}

const services: CompanionChatTargetsProjectionService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});

function createHarness(chats: Chat[]): Harness {
  const paired: PairedCompanionDeviceRecord | undefined = pairedDevice();
  const statuses: Harness["statuses"] = [];
  const errors: unknown[] = [];
  const generated = [IDS.envelope, IDS.envelope2];
  const generate = vi.fn(() => generated.shift() ?? IDS.envelope2);
  const enqueueAndroidMailbox = vi.fn<
    CompanionRelayClient["enqueueAndroidMailbox"]
  >(({ request }) => Promise.resolve(receipt(request)));
  const dependencies: CompanionChatTargetsProjectionServiceDependencies = {
    bridge: { getPairedDevice: () => paired },
    chats: {
      listChats: ({ status }) =>
        chats.filter((candidate) => candidate.status === status),
    },
    clock: { now: () => NOW },
    idGenerator: { generate },
    onBackgroundError: (error) => errors.push(error),
    onStatusChange: (deviceId, status) => statuses.push({ deviceId, status }),
    relay: { enqueueAndroidMailbox },
    secretStore: { get: () => Promise.resolve("device-credential") },
  };
  const service = new CompanionChatTargetsProjectionService(dependencies);
  services.push(service);
  return {
    dependencies,
    enqueueAndroidMailbox,
    errors,
    generate,
    service,
    statuses,
  };
}

describe("CompanionChatTargetsProjectionService", () => {
  it("replaces Android Chat targets from current active non-provisional Chat rows", async () => {
    const chats = [
      chat(IDS.chat, "Presentation 加油", NOW),
      chat(IDS.archived, "旧聊天", NOW, "archived"),
      chat(IDS.chat2, "夕阳分享", LATER),
    ];
    const harness = createHarness(chats);

    harness.service.start();
    await vi.waitFor(() =>
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledOnce(),
    );

    expect(harness.enqueueAndroidMailbox.mock.calls[0]?.[0]).toMatchObject({
      credential: "device-credential",
      relayOrigin: "https://relay.example.test",
      request: {
        envelopeId: IDS.envelope,
        event: {
          deviceId: IDS.device,
          snapshot: {
            generatedAt: NOW,
            targets: [
              { chatId: IDS.chat, title: "Presentation 加油", updatedAt: NOW },
              { chatId: IDS.chat2, title: "夕阳分享", updatedAt: LATER },
            ],
          },
          type: "companion.chat_targets.replaced",
        },
        protocolVersion: 1,
        recipient: { deviceId: IDS.device, kind: "android" },
      },
    });
    expect(harness.statuses.at(-1)).toEqual({
      deviceId: IDS.device,
      status: { observedAt: NOW, state: "online" },
    });

    harness.service.wake();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledOnce();

    chats[0] = chat(IDS.chat, "Presentation 已完成", LATER);
    harness.service.wake();
    await vi.waitFor(() =>
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(2),
    );
    expect(
      harness.enqueueAndroidMailbox.mock.calls[1]?.[0].request,
    ).toMatchObject({
      envelopeId: IDS.envelope2,
      event: {
        snapshot: {
          targets: [
            {
              chatId: IDS.chat,
              title: "Presentation 已完成",
              updatedAt: LATER,
            },
            { chatId: IDS.chat2, title: "夕阳分享", updatedAt: LATER },
          ],
        },
      },
    });
  });

  it("reuses one stable replacement envelope after an unknown Relay outcome", async () => {
    const harness = createHarness([chat(IDS.chat, "Presentation 加油", NOW)]);
    harness.enqueueAndroidMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "unknown Relay outcome"),
    );

    harness.service.start();
    await vi.waitFor(() => expect(harness.errors).toHaveLength(1));
    const firstRequest =
      harness.enqueueAndroidMailbox.mock.calls[0]?.[0].request;
    expect(harness.statuses.at(-1)?.status.state).toBe("offline");

    harness.service.wake();
    await vi.waitFor(() =>
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(2),
    );
    expect(harness.enqueueAndroidMailbox.mock.calls[1]?.[0].request).toEqual(
      firstRequest,
    );
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.statuses.at(-1)?.status.state).toBe("online");
  });

  it("honors Relay retry-after and then projects a Chat change queued during the wait", async () => {
    vi.useFakeTimers();
    const chats = [chat(IDS.chat, "Presentation 加油", NOW)];
    const harness = createHarness(chats);
    harness.enqueueAndroidMailbox.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "busy", 503, 2_000),
    );

    harness.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledOnce();

    chats[0] = chat(IDS.chat, "Presentation 已完成", LATER);
    harness.service.wake();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(3),
    );
    expect(harness.enqueueAndroidMailbox.mock.calls[1]?.[0].request).toEqual(
      harness.enqueueAndroidMailbox.mock.calls[0]?.[0].request,
    );
    expect(
      harness.enqueueAndroidMailbox.mock.calls[2]?.[0].request.event,
    ).toMatchObject({
      snapshot: {
        targets: [
          {
            chatId: IDS.chat,
            title: "Presentation 已完成",
            updatedAt: LATER,
          },
        ],
      },
    });
  });

  it("latches a mismatched receipt until pairing reset", async () => {
    const harness = createHarness([chat(IDS.chat, "Presentation 加油", NOW)]);
    harness.enqueueAndroidMailbox.mockImplementationOnce(({ request }) =>
      Promise.resolve({
        ...receipt(request),
        envelope: { ...receipt(request).envelope, id: IDS.envelope2 },
      }),
    );

    harness.service.start();
    await vi.waitFor(() =>
      expect(harness.statuses.at(-1)?.status.state).toBe("protocol_error"),
    );
    harness.service.wake();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.enqueueAndroidMailbox).toHaveBeenCalledOnce();

    harness.service.reset();
    await vi.waitFor(() =>
      expect(harness.enqueueAndroidMailbox).toHaveBeenCalledTimes(2),
    );
    expect(harness.generate).toHaveBeenCalledTimes(2);
  });
});
