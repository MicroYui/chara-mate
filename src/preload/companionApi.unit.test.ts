import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMPANION_DESKTOP_CHANNELS } from "../shared/contracts/companion";
import { createCompanionApi } from "./companionApi";

type IpcListener = (event: unknown, input: unknown) => void;

const electron = vi.hoisted(() => ({
  ipcRenderer: {
    invoke: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("electron", () => electron);

const DEVICE_ID = "90000000-0000-4000-8000-000000000004";
const PAIRED_AT = "2026-09-01T09:00:00.000Z";
const EXPIRES_AT = "2026-09-01T09:05:00.000Z";

const pairedSnapshot = {
  device: {
    displayName: "Yifan's phone",
    id: DEVICE_ID,
    notificationPermission: "granted" as const,
    notificationsEnabled: true,
    pairedAt: PAIRED_AT,
    platform: "android" as const,
    status: {
      observedAt: PAIRED_AT,
      state: "online" as const,
    },
  },
  state: "paired" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Companion preload API", () => {
  it("routes pairing and device mutations through narrow typed channels", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        if (channel === COMPANION_DESKTOP_CHANNELS.startPairing) {
          return Promise.resolve({
            ok: true,
            value: {
              expiresAt: EXPIRES_AT,
              qrPayload: "opaque-pairing-qr-payload",
              state: "pairing",
            },
          });
        }
        expect(input).toEqual(
          channel === COMPANION_DESKTOP_CHANNELS.getSnapshot
            ? {}
            : channel === COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled
              ? { deviceId: DEVICE_ID, enabled: false }
              : { deviceId: DEVICE_ID },
        );
        return Promise.resolve({ ok: true, value: pairedSnapshot });
      },
    );
    const api = createCompanionApi();

    await expect(api.getSnapshot()).resolves.toEqual({
      ok: true,
      value: pairedSnapshot,
    });
    await expect(api.startPairing()).resolves.toEqual({
      ok: true,
      value: {
        expiresAt: EXPIRES_AT,
        qrPayload: "opaque-pairing-qr-payload",
        state: "pairing",
      },
    });
    await expect(
      api.setNotificationsEnabled({ deviceId: DEVICE_ID, enabled: false }),
    ).resolves.toEqual({ ok: true, value: pairedSnapshot });
    await expect(api.unpair({ deviceId: DEVICE_ID })).resolves.toEqual({
      ok: true,
      value: pairedSnapshot,
    });

    expect(Object.isFrozen(api)).toBe(true);
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [COMPANION_DESKTOP_CHANNELS.getSnapshot, {}],
      [COMPANION_DESKTOP_CHANNELS.startPairing, {}],
      [
        COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled,
        { deviceId: DEVICE_ID, enabled: false },
      ],
      [COMPANION_DESKTOP_CHANNELS.unpair, { deviceId: DEVICE_ID }],
    ]);
  });

  it("rejects invalid requests and Main responses before they cross the boundary", async () => {
    const api = createCompanionApi();

    await expect(
      api.setNotificationsEnabled({
        deviceId: "not-an-id",
        enabled: true,
      }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();

    electron.ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      value: {
        ...pairedSnapshot,
        device: {
          ...pairedSnapshot.device,
          installationId: "90000000-0000-4000-8000-000000000007",
        },
      },
    });
    await expect(api.getSnapshot()).rejects.toThrow();
  });

  it("validates changed events and removes the exact wrapped listener", () => {
    const api = createCompanionApi();
    const listener = vi.fn();
    const dispose = api.subscribeChanged(listener);
    const registration = electron.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === COMPANION_DESKTOP_CHANNELS.changed,
    ) as [string, IpcListener] | undefined;

    expect(registration).toBeDefined();
    registration?.[1]({}, pairedSnapshot);
    expect(listener).toHaveBeenCalledWith(pairedSnapshot);

    expect(() =>
      registration?.[1](
        {},
        {
          ...pairedSnapshot,
          cursor: "must-stay-in-main",
        },
      ),
    ).toThrow();

    dispose();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      COMPANION_DESKTOP_CHANNELS.changed,
      registration?.[1],
    );
  });
});
