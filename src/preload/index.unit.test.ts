import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CharaMateApi } from "../shared/contracts/foundation";
import { CHAT_CHANNELS, CHAT_EVENT_CHANNELS } from "../shared/contracts/chat";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import { PET_CHANNELS } from "../shared/contracts/pet";
import { TERRITORY_CHANNELS } from "../shared/contracts/territory";
import { VOICE_CHANNELS } from "../shared/contracts/voice";
import {
  chatDataSnapshotFixture,
  FIXTURE_IDS,
  runEventEnvelopeFixture,
} from "../../tests/fixtures/foundationContracts";
import { activeTerritorySnapshot } from "../../tests/fixtures/territory";

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

const petLibrarySnapshot = {
  activePetId: "columbinya",
  animationSpeed: 0.75,
  pets: [
    {
      description: "A sleepy cat companion.",
      displayName: "Columbinya",
      id: "columbinya",
      spriteHeight: 2288,
      spriteUrl: "chara-mate-pet://asset/columbinya/spritesheet.webp" as const,
      spriteVersionNumber: 2 as const,
      spriteWidth: 1536,
    },
  ],
  scale: 1,
};

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
  it("validates Voice driver events and command subscriptions on both sides", async () => {
    const sessionId = "20000000-0000-4000-8000-000000000001";
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(VOICE_CHANNELS.event);
        expect(input).toMatchObject({
          event: { generation: 1, type: "response.done" },
          sessionId,
        });
        return Promise.resolve({ ok: true, value: null });
      },
    );
    let commandListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(VOICE_CHANNELS.command);
        commandListener = listener;
      },
    );
    const api = await loadApi();
    await expect(
      api.voice.report({
        event: {
          generation: 1,
          responseId: "response-1",
          status: "completed",
          type: "response.done",
        },
        occurredAt: "2026-08-08T12:00:00.000Z",
        sessionId,
      }),
    ).resolves.toEqual({ ok: true, value: null });

    const listener = vi.fn();
    const unsubscribe = api.voice.subscribeCommand(listener);
    commandListener?.(
      {},
      {
        generation: 1,
        instructions: "自然回答。",
        requestId: FIXTURE_IDS.request,
        sessionId,
        type: "response.create",
      },
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1, type: "response.create" }),
    );
    expect(() =>
      commandListener?.(
        {},
        {
          instructions: "缺少 generation。",
          requestId: FIXTURE_IDS.request,
          sessionId,
          type: "response.create",
        },
      ),
    ).toThrow();
    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      VOICE_CHANNELS.command,
      commandListener,
    );
  });

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

  it("validates Chat change events and detaches the wrapped listener", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(CHAT_EVENT_CHANNELS.changed);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.chat.subscribeChanged(listener);
    if (!registeredListener) {
      throw new Error("Chat change listener was not registered");
    }

    registeredListener(
      { rawElectronEvent: true },
      chatDataSnapshotFixture.chat,
    );
    expect(listener).toHaveBeenCalledWith(chatDataSnapshotFixture.chat);
    expect(() => registeredListener?.({}, { title: "invalid" })).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      CHAT_EVENT_CHANNELS.changed,
      registeredListener,
    );
  });

  it("validates Character library commands on both sides of IPC", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(PET_CHANNELS.select);
        expect(input).toEqual({ petId: "columbinya" });
        return Promise.resolve({ ok: true, value: petLibrarySnapshot });
      },
    );
    const api = await loadApi();

    await expect(api.pet.select({ petId: "columbinya" })).resolves.toEqual({
      ok: true,
      value: petLibrarySnapshot,
    });
    await expect(api.pet.select({ petId: "../outside" })).rejects.toThrow(
      /petId|pattern/u,
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it("validates the 30% Character size boundary", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(PET_CHANNELS.setScale);
        expect(input).toEqual({ scale: 0.3 });
        return Promise.resolve({
          ok: true,
          value: { ...petLibrarySnapshot, scale: 0.3 },
        });
      },
    );
    const api = await loadApi();

    await expect(api.pet.setScale({ scale: 0.3 })).resolves.toMatchObject({
      ok: true,
      value: { scale: 0.3 },
    });
    await expect(api.pet.setScale({ scale: 0.29 })).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it("validates Territory commands and snapshots on both sides of IPC", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(TERRITORY_CHANNELS.placeItem);
        expect(input).toEqual({
          flipped: true,
          itemId: "forest-cabin.desk",
          rotation: 90,
          target: {
            kind: "ground",
            sceneId: "forest-cabin",
            x: 6,
            y: 5,
          },
        });
        return Promise.resolve({ ok: true, value: activeTerritorySnapshot });
      },
    );
    const api = await loadApi();

    await expect(
      api.territory.placeItem({
        flipped: true,
        itemId: "forest-cabin.desk",
        rotation: 90,
        target: {
          kind: "ground",
          sceneId: "forest-cabin",
          x: 6,
          y: 5,
        },
      }),
    ).resolves.toEqual({ ok: true, value: activeTerritorySnapshot });
    await expect(
      api.territory.placeItem({
        flipped: false,
        itemId: "../escape",
        rotation: 0,
        target: {
          kind: "ground",
          sceneId: "forest-cabin",
          x: 0,
          y: 0,
        },
      }),
    ).rejects.toThrow(/itemId|pattern/u);
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it("validates continuous Character animation speed requests", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(PET_CHANNELS.setAnimationSpeed);
        expect(input).toEqual({ animationSpeed: 0.1 });
        return Promise.resolve({
          ok: true,
          value: { ...petLibrarySnapshot, animationSpeed: 0.1 },
        });
      },
    );
    const api = await loadApi();

    await expect(
      api.pet.setAnimationSpeed({ animationSpeed: 0.1 }),
    ).resolves.toMatchObject({ ok: true, value: { animationSpeed: 0.1 } });
    await expect(
      api.pet.setAnimationSpeed({ animationSpeed: 0.09 }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it("validates Character library events and detaches the wrapped listener", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(PET_CHANNELS.libraryChanged);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.pet.subscribeChanged(listener);
    if (!registeredListener) {
      throw new Error("Pet library listener was not registered");
    }

    registeredListener({ rawElectronEvent: true }, petLibrarySnapshot);
    expect(listener).toHaveBeenCalledWith(petLibrarySnapshot);
    expect(() => registeredListener?.({}, { pets: "invalid" })).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      PET_CHANNELS.libraryChanged,
      registeredListener,
    );
  });

  it("validates Main navigation events and exposes only the target", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(PET_CHANNELS.openMain);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.pet.subscribeOpenMain(listener);
    if (!registeredListener) {
      throw new Error("Main navigation listener was not registered");
    }

    registeredListener({ rawElectronEvent: true }, { target: "character" });
    expect(listener).toHaveBeenCalledWith("character");
    expect(() => registeredListener?.({}, { target: "unsupported" })).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      PET_CHANNELS.openMain,
      registeredListener,
    );
  });
});
