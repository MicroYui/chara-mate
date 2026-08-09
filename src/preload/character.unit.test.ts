import { beforeEach, describe, expect, it, vi } from "vitest";

import { type CharacterWindowApi, PET_CHANNELS } from "../shared/contracts/pet";
import { VOICE_CHANNELS } from "../shared/contracts/voice";

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

const characterSnapshot = {
  activePet: {
    description: "A tiny fantasy adventurer.",
    displayName: "Linnea",
    id: "linnea",
    spriteHeight: 1872,
    spriteUrl: "chara-mate-pet://asset/linnea/spritesheet.webp" as const,
    spriteVersionNumber: 1 as const,
    spriteWidth: 1536,
  },
  animation: "idle" as const,
  animationSpeed: 0.75,
  facing: "right" as const,
  scale: 1,
};

async function loadApi(): Promise<CharacterWindowApi> {
  await import("./character");
  const call = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  if (!call || call[0] !== "charaMateCharacter") {
    throw new Error("Character preload did not expose its narrow API");
  }
  return call[1] as CharacterWindowApi;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("Character Window typed preload boundary", () => {
  it("exposes only the Character contract and validates its snapshot", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(PET_CHANNELS.characterGetSnapshot);
        expect(input).toEqual({});
        return Promise.resolve(characterSnapshot);
      },
    );
    const api = await loadApi();

    expect(Object.keys(api).sort()).toEqual(
      [
        "endDrag",
        "focusMain",
        "focusApproval",
        "getPendingApproval",
        "getSnapshot",
        "markReady",
        "moveDrag",
        "resolveApproval",
        "showContextMenu",
        "startDrag",
        "subscribe",
        "subscribeApproval",
        "voice",
      ].sort(),
    );
    await expect(api.getSnapshot()).resolves.toEqual(characterSnapshot);
  });

  it("validates drag input and Main responses before returning them", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(PET_CHANNELS.dragStart);
        expect(input).toEqual({ screenX: 120, screenY: 240 });
        return Promise.resolve({ moved: false });
      },
    );
    const api = await loadApi();

    await expect(
      api.startDrag({ screenX: 120, screenY: 240 }),
    ).resolves.toEqual({ moved: false });
    await expect(
      api.startDrag({ screenX: Number.NaN, screenY: 240 }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it("exposes the Character-only Voice quick-start boundary", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(VOICE_CHANNELS.quickStart);
        expect(input).toEqual({ requestedAt: "2026-08-09T06:00:00.000Z" });
        return Promise.resolve({
          ok: true,
          value: {
            callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
            clientSecret: "ephemeral",
            expiresAt: "2026-08-09T06:01:00.000Z",
            history: [],
            inputMode: "hands_free",
            sessionId: "10000000-0000-4000-8000-000000000001",
            voice: "verse",
          },
        });
      },
    );
    const api = await loadApi();

    await expect(
      api.voice.quickStart({ requestedAt: "2026-08-09T06:00:00.000Z" }),
    ).resolves.toMatchObject({ ok: true, value: { voice: "verse" } });
  });

  it("passes only validated Character events and removes its wrapper", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(PET_CHANNELS.characterChanged);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    if (!registeredListener) {
      throw new Error("Character snapshot listener was not registered");
    }

    registeredListener({ rawElectronEvent: true }, characterSnapshot);
    expect(listener).toHaveBeenCalledWith(characterSnapshot);
    expect(() => registeredListener?.({}, { animation: "unknown" })).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      PET_CHANNELS.characterChanged,
      registeredListener,
    );
  });
});
