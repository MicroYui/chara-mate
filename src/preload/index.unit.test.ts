import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CharaMateApi } from "../shared/contracts/foundation";
import { CHAT_CHANNELS } from "../shared/contracts/chat";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import {
  chatDataSnapshotFixture,
  FIXTURE_IDS,
  runEventEnvelopeFixture,
} from "../../tests/fixtures/foundationContracts";

type IpcListener = (event: unknown, input: unknown) => void;

const electron = vi.hoisted(() => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("electron", () => electron);

async function loadApi(): Promise<CharaMateApi> {
  await import("./index");
  const call = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  if (!call || call[0] !== "charaMate") {
    throw new Error("Preload did not expose the CharaMate API");
  }
  return call[1] as CharaMateApi;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("Phase 1 typed preload data boundary", () => {
  it("validates Chat snapshot requests and Main responses", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(CHAT_CHANNELS.getSnapshot);
        expect(input).toEqual({ chatId: FIXTURE_IDS.chat });
        return Promise.resolve({ ok: true, value: chatDataSnapshotFixture });
      },
    );
    const api = await loadApi();

    await expect(
      api.chat.getSnapshot({ chatId: FIXTURE_IDS.chat }),
    ).resolves.toEqual({ ok: true, value: chatDataSnapshotFixture });
    await expect(api.chat.getSnapshot({ chatId: "not-an-id" })).rejects.toThrow(
      /chatId|pattern/u,
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it("passes only validated event payloads and removes the wrapped listener", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(RUN_EVENT_CHANNELS.subscribe);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.runEvents.subscribe(listener);
    if (!registeredListener) {
      throw new Error("Run event listener was not registered");
    }

    registeredListener(
      { dangerousElectronEvent: true },
      runEventEnvelopeFixture,
    );
    expect(listener).toHaveBeenCalledWith(runEventEnvelopeFixture);
    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({ dangerousElectronEvent: true }),
      expect.anything(),
    );
    expect(() => registeredListener?.({}, { invalid: true })).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      RUN_EVENT_CHANNELS.subscribe,
      registeredListener,
    );
  });
});
