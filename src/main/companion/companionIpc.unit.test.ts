import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  COMPANION_DESKTOP_CHANNELS,
  type CompanionDesktopSnapshot,
} from "../../shared/contracts/companion";
import {
  companionDeviceFixture,
  companionPairingTicketFixture,
  COMPANION_FIXTURE_IDS,
} from "../../../tests/fixtures/companionContracts";
import { ProviderError } from "../providers/providerError";
import { CompanionBridgePersistenceError } from "./companionBridgeRepository";
import { type CompanionIpcService, registerCompanionIpc } from "./companionIpc";
import { CompanionRelayClientError } from "./companionRelayClient";

type IpcHandler = (event: unknown, input: unknown) => unknown;

const electron = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});

vi.mock("electron", () => ({ ipcMain: electron.ipcMain }));

const pairedSnapshot = {
  device: {
    displayName: companionDeviceFixture.displayName,
    id: companionDeviceFixture.id,
    notificationPermission: companionDeviceFixture.notificationPermission,
    notificationsEnabled: companionDeviceFixture.notificationsEnabled,
    pairedAt: companionDeviceFixture.pairedAt,
    platform: companionDeviceFixture.platform,
    status: companionDeviceFixture.status,
  },
  state: "paired",
} satisfies CompanionDesktopSnapshot;

const pairingSnapshot = {
  expiresAt: companionPairingTicketFixture.expiresAt,
  qrPayload: "opaque-pairing-qr-payload",
  state: "pairing",
} satisfies CompanionDesktopSnapshot;

interface ServiceHarness {
  readonly service: CompanionIpcService;
  readonly setNotificationsEnabled: Mock<
    NonNullable<CompanionIpcService["setNotificationsEnabled"]>
  >;
  readonly unpair: Mock<NonNullable<CompanionIpcService["unpair"]>>;
}

function createService(): ServiceHarness {
  const setNotificationsEnabled = vi.fn(() => pairedSnapshot);
  const unpair = vi.fn(() => ({ state: "unpaired" }) as const);
  return {
    service: {
      getSnapshot: vi.fn(() => ({ state: "unpaired" }) as const),
      setNotificationsEnabled,
      startPairing: vi.fn(() => pairingSnapshot),
      unpair,
    },
    setNotificationsEnabled,
    unpair,
  };
}

async function invoke(channel: string, input: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  return await handler({}, input);
}

beforeEach(() => {
  electron.handlers.clear();
  vi.clearAllMocks();
});

describe("Companion Main IPC contract", () => {
  it("validates requests and response snapshots for every operation", async () => {
    const { service, setNotificationsEnabled, unpair } = createService();
    registerCompanionIpc(service);

    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.getSnapshot, {}),
    ).resolves.toEqual({ ok: true, value: { state: "unpaired" } });
    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.startPairing, {}),
    ).resolves.toEqual({ ok: true, value: pairingSnapshot });
    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled, {
        deviceId: COMPANION_FIXTURE_IDS.device,
        enabled: false,
      }),
    ).resolves.toEqual({ ok: true, value: pairedSnapshot });
    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.unpair, {
        deviceId: COMPANION_FIXTURE_IDS.device,
      }),
    ).resolves.toEqual({ ok: true, value: { state: "unpaired" } });

    expect(setNotificationsEnabled).toHaveBeenCalledWith({
      deviceId: COMPANION_FIXTURE_IDS.device,
      enabled: false,
    });
    expect(unpair).toHaveBeenCalledWith({
      deviceId: COMPANION_FIXTURE_IDS.device,
    });
  });

  it("does not pass malformed Renderer input to the service", async () => {
    const { service, setNotificationsEnabled } = createService();
    registerCompanionIpc(service);

    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled, {
        deviceId: COMPANION_FIXTURE_IDS.device,
        enabled: "yes",
      }),
    ).resolves.toEqual({
      error: {
        code: "COMPANION.OPERATION_FAILED",
        message: "手机 Companion 操作没有完成，请重试。",
        retryable: false,
      },
      ok: false,
    });
    expect(setNotificationsEnabled).not.toHaveBeenCalled();
  });

  it("maps secret-store, repository, and Relay failures to explicit AppErrors", async () => {
    const { service } = createService();
    service.setNotificationsEnabled = vi.fn(() => {
      throw new ProviderError(
        "PROVIDER.SECRET_STORAGE_UNAVAILABLE",
        "系统密钥存储暂不可用。",
        true,
      );
    });
    service.unpair = vi.fn(() => {
      throw new CompanionBridgePersistenceError(
        "COMPANION.NOT_PAIRED",
        "not paired",
      );
    });
    service.startPairing = vi.fn(() => {
      throw new CompanionRelayClientError("network", "Relay unavailable");
    });
    registerCompanionIpc(service);

    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled, {
        deviceId: COMPANION_FIXTURE_IDS.device,
        enabled: false,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "COMPANION.SECRET_STORAGE_UNAVAILABLE",
        retryable: true,
      },
      ok: false,
    });
    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.unpair, {
        deviceId: COMPANION_FIXTURE_IDS.device,
      }),
    ).resolves.toEqual({
      error: {
        code: "COMPANION.NOT_PAIRED",
        message: "not paired",
        retryable: false,
      },
      ok: false,
    });
    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.startPairing, {}),
    ).resolves.toEqual({
      error: {
        code: "COMPANION.RELAY_UNAVAILABLE",
        message: "Relay unavailable",
        retryable: true,
      },
      ok: false,
    });
  });

  it("projects invalid service output as an error and unregisters every channel", async () => {
    const { service } = createService();
    service.getSnapshot = vi.fn(
      () => ({ state: "unknown" }) as unknown as CompanionDesktopSnapshot,
    );
    const unregister = registerCompanionIpc(service);

    await expect(
      invoke(COMPANION_DESKTOP_CHANNELS.getSnapshot, {}),
    ).resolves.toMatchObject({
      error: { code: "COMPANION.OPERATION_FAILED" },
      ok: false,
    });

    unregister();
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(
      Object.keys(COMPANION_DESKTOP_CHANNELS).length,
    );
    for (const channel of Object.values(COMPANION_DESKTOP_CHANNELS)) {
      expect(electron.handlers.has(channel)).toBe(false);
    }
  });
});
