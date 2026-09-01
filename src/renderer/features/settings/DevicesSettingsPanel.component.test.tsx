import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompanionApi,
  CompanionDesktopSnapshot,
  CompanionDesktopSnapshotResponse,
} from "../../../shared/contracts/companion";
import { DevicesSettingsPanel } from "./DevicesSettingsPanel";

const DEVICE_ID = "90000000-0000-4000-8000-000000000004";
const PAIRED_AT = "2026-09-01T09:00:00.000Z";
const EXPIRES_AT = "2026-09-01T09:05:00.000Z";
const QR_PAYLOAD = JSON.stringify({
  pairingId: "90000000-0000-4000-8000-000000000005",
  pairingSecret: "one-time-pairing-secret",
  protocolVersion: 1,
  relayOrigin: "https://relay.example.com",
});

const pairedSnapshot = {
  device: {
    displayName: "Yifan 的手机",
    id: DEVICE_ID,
    notificationPermission: "granted",
    notificationsEnabled: true,
    pairedAt: PAIRED_AT,
    platform: "android",
    status: {
      observedAt: PAIRED_AT,
      state: "online",
    },
  },
  state: "paired",
} satisfies CompanionDesktopSnapshot;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createApi(
  snapshot: CompanionDesktopSnapshot,
  overrides: Partial<CompanionApi> = {},
): CompanionApi {
  return {
    getSnapshot: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
    setNotificationsEnabled: vi
      .fn()
      .mockResolvedValue({ ok: true, value: snapshot }),
    startPairing: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
    subscribeChanged: vi.fn(() => () => undefined),
    unpair: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
    ...overrides,
  };
}

describe("DevicesSettingsPanel", () => {
  it("subscribes before reading and does not let an older response replace a changed event", async () => {
    const order: string[] = [];
    let changedListener:
      ((snapshot: CompanionDesktopSnapshot) => void) | undefined;
    let resolveSnapshot:
      ((response: CompanionDesktopSnapshotResponse) => void) | undefined;
    const unsubscribe = vi.fn();
    const getSnapshot = vi.fn<CompanionApi["getSnapshot"]>(() => {
      order.push("get");
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    });
    const subscribeChanged = vi.fn<CompanionApi["subscribeChanged"]>(
      (listener) => {
        order.push("subscribe");
        changedListener = listener;
        return unsubscribe;
      },
    );
    const api = createApi(
      { state: "unpaired" },
      { getSnapshot, subscribeChanged },
    );

    const { unmount } = render(<DevicesSettingsPanel api={api} />);

    expect(order).toEqual(["subscribe", "get"]);
    act(() => changedListener?.(pairedSnapshot));
    expect(await screen.findByText("Yifan 的手机")).toBeVisible();
    expect(screen.getByRole("switch", { name: /手机通知/u })).toBeDisabled();

    await act(async () => {
      resolveSnapshot?.({ ok: true, value: { state: "unpaired" } });
      await Promise.resolve();
    });
    expect(screen.getByText("Yifan 的手机")).toBeVisible();
    expect(screen.queryByText("尚未连接手机")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /手机通知/u })).toBeEnabled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("renders a real QR code without exposing its raw pairing payload", async () => {
    const pairingSnapshot = {
      expiresAt: EXPIRES_AT,
      qrPayload: QR_PAYLOAD,
      state: "pairing",
    } satisfies CompanionDesktopSnapshot;
    const startPairing = vi
      .fn<CompanionApi["startPairing"]>()
      .mockResolvedValue({ ok: true, value: pairingSnapshot });
    const api = createApi({ state: "unpaired" }, { startPairing });

    render(<DevicesSettingsPanel api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "开始配对" }));

    const qrCode = await screen.findByRole("img", {
      name: "Android 配对二维码",
    });
    expect(qrCode.tagName.toLowerCase()).toBe("svg");
    expect(qrCode.querySelector("path")).not.toBeNull();
    expect(screen.queryByText(QR_PAYLOAD)).not.toBeInTheDocument();
    expect(screen.getByText("用 Android Companion 扫描")).toBeVisible();
    expect(
      document.querySelector(`time[datetime="${EXPIRES_AT}"]`),
    ).not.toBeNull();
    expect(startPairing).toHaveBeenCalledOnce();
  });

  it("keeps the notification preference separate from Android permission", async () => {
    const deniedSnapshot = {
      ...pairedSnapshot,
      device: {
        ...pairedSnapshot.device,
        notificationPermission: "denied",
      },
    } satisfies CompanionDesktopSnapshot;
    const disabledSnapshot = {
      ...deniedSnapshot,
      device: {
        ...deniedSnapshot.device,
        notificationsEnabled: false,
      },
    } satisfies CompanionDesktopSnapshot;
    const setNotificationsEnabled = vi
      .fn<CompanionApi["setNotificationsEnabled"]>()
      .mockResolvedValue({ ok: true, value: disabledSnapshot });
    const api = createApi(deniedSnapshot, { setNotificationsEnabled });

    render(<DevicesSettingsPanel api={api} />);

    const notificationSwitch = await screen.findByRole("switch", {
      name: /手机通知/u,
    });
    expect(notificationSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("未允许")).toBeVisible();
    expect(screen.getByText(/图片和文档分享仍可使用/u)).toBeVisible();

    fireEvent.click(notificationSwitch);
    await waitFor(() =>
      expect(setNotificationsEnabled).toHaveBeenCalledWith({
        deviceId: DEVICE_ID,
        enabled: false,
      }),
    );
    expect(notificationSwitch).toHaveAttribute("aria-checked", "false");
    expect(await screen.findByText("手机通知已关闭。")).toBeVisible();
  });

  it("keeps a mutation pending and reports its result through changed events", async () => {
    let changedListener:
      ((snapshot: CompanionDesktopSnapshot) => void) | undefined;
    let resolveFirstMutation:
      ((response: CompanionDesktopSnapshotResponse) => void) | undefined;
    let resolveSecondMutation:
      ((response: CompanionDesktopSnapshotResponse) => void) | undefined;
    const changedSnapshot = {
      ...pairedSnapshot,
      device: {
        ...pairedSnapshot.device,
        notificationsEnabled: false,
        status: {
          observedAt: PAIRED_AT,
          state: "offline",
        },
      },
    } satisfies CompanionDesktopSnapshot;
    const secondChangedSnapshot = {
      ...pairedSnapshot,
      device: {
        ...pairedSnapshot.device,
        status: {
          observedAt: PAIRED_AT,
          state: "offline",
        },
      },
    } satisfies CompanionDesktopSnapshot;
    const setNotificationsEnabled = vi
      .fn<CompanionApi["setNotificationsEnabled"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstMutation = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondMutation = resolve;
          }),
      );
    const subscribeChanged = vi.fn<CompanionApi["subscribeChanged"]>(
      (listener) => {
        changedListener = listener;
        return () => undefined;
      },
    );
    const api = createApi(pairedSnapshot, {
      setNotificationsEnabled,
      subscribeChanged,
    });

    render(<DevicesSettingsPanel api={api} />);

    const notificationSwitch = await screen.findByRole("switch", {
      name: /手机通知/u,
    });
    fireEvent.click(notificationSwitch);
    await waitFor(() =>
      expect(setNotificationsEnabled).toHaveBeenNthCalledWith(1, {
        deviceId: DEVICE_ID,
        enabled: false,
      }),
    );
    expect(notificationSwitch).toBeDisabled();

    act(() => changedListener?.(changedSnapshot));
    expect(await screen.findByText("暂时离线")).toBeVisible();
    expect(notificationSwitch).toHaveAttribute("aria-checked", "false");
    expect(notificationSwitch).toBeDisabled();

    fireEvent.click(notificationSwitch);
    expect(setNotificationsEnabled).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstMutation?.({
        error: {
          code: "COMPANION.RELAY_UNAVAILABLE",
          message: "当前通知设置没有保存。",
          retryable: true,
        },
        ok: false,
      });
      await Promise.resolve();
    });

    expect(screen.getByText("当前通知设置没有保存。")).toBeVisible();
    expect(screen.getByText("暂时离线")).toBeVisible();
    expect(notificationSwitch).toBeEnabled();

    fireEvent.click(notificationSwitch);
    await waitFor(() =>
      expect(setNotificationsEnabled).toHaveBeenNthCalledWith(2, {
        deviceId: DEVICE_ID,
        enabled: true,
      }),
    );
    expect(notificationSwitch).toBeDisabled();

    act(() => changedListener?.(secondChangedSnapshot));
    expect(notificationSwitch).toHaveAttribute("aria-checked", "true");
    expect(notificationSwitch).toBeDisabled();

    await act(async () => {
      resolveSecondMutation?.({ ok: true, value: pairedSnapshot });
      await Promise.resolve();
    });

    expect(notificationSwitch).toBeEnabled();
    expect(notificationSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("暂时离线")).toBeVisible();
    expect(screen.getByText("手机通知已开启。")).toBeVisible();
  });

  it("shows protocol recovery guidance and keeps the device after a failed unpair", async () => {
    const protocolSnapshot = {
      ...pairedSnapshot,
      device: {
        ...pairedSnapshot.device,
        status: {
          message: "收到的 Mailbox cursor 没有前进。",
          observedAt: PAIRED_AT,
          state: "protocol_error",
        },
      },
    } satisfies CompanionDesktopSnapshot;
    const unpair = vi
      .fn<CompanionApi["unpair"]>()
      .mockResolvedValueOnce({
        error: {
          code: "COMPANION.RELAY_UNAVAILABLE",
          message: "暂时无法连接 Companion Relay。",
          retryable: true,
        },
        ok: false,
      })
      .mockResolvedValueOnce({ ok: true, value: { state: "unpaired" } });
    const api = createApi(protocolSnapshot, { unpair });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<DevicesSettingsPanel api={api} />);

    expect(await screen.findByText("连接协议异常")).toBeVisible();
    expect(screen.getByText(/请解除配对后重新连接/u)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /跳过|重置/u }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "解除配对" }));
    expect(confirm).toHaveBeenCalledWith(
      "解除与“Yifan 的手机”的配对？手机通知和分享会停止，之后可以重新配对。",
    );
    expect(
      await screen.findByText("暂时无法连接 Companion Relay。"),
    ).toBeVisible();
    expect(screen.getByText("Yifan 的手机")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "解除配对" }));
    expect(await screen.findByText("尚未连接手机")).toBeVisible();
    expect(screen.getByText("已解除配对。")).toBeVisible();
    expect(unpair).toHaveBeenCalledTimes(2);
  });
});
