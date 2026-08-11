import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CharaMateApi } from "../shared/contracts/foundation";
import { AUTOMATION_CHANNELS } from "../shared/contracts/automation";
import { CHAT_CHANNELS, CHAT_EVENT_CHANNELS } from "../shared/contracts/chat";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import { PET_CHANNELS } from "../shared/contracts/pet";
import { TERRITORY_CHANNELS } from "../shared/contracts/territory";
import { VOICE_CHANNELS } from "../shared/contracts/voice";
import {
  chatDataSnapshotFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  runEventEnvelopeFixture,
} from "../../tests/fixtures/foundationContracts";
import { activeTerritorySnapshot } from "../../tests/fixtures/territory";
import {
  automationDefinitionFixture,
  automationFinishedEventFixture,
  automationFixture,
} from "../../tests/fixtures/automations";

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
          hasAudio: false,
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

  it("validates Voice pause and resume requests and snapshots", async () => {
    const sessionId = "20000000-0000-4000-8000-000000000001";
    const snapshot = {
      assistantTranscript: "",
      chatId: FIXTURE_IDS.chat,
      connectedAt: "2026-08-08T12:00:01.000Z",
      createdAt: "2026-08-08T12:00:00.000Z",
      generation: 0,
      inputMode: "hands_free" as const,
      muted: false,
      phase: "paused" as const,
      sessionId,
      userTranscript: "",
      voice: "verse" as const,
    };
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(VOICE_CHANNELS.setPaused);
        expect(input).toEqual({
          paused: true,
          requestedAt: "2026-08-08T12:00:02.000Z",
          sessionId,
        });
        return Promise.resolve({
          ok: true,
          value: { snapshot },
        });
      },
    );
    const api = await loadApi();

    await expect(
      api.voice.setPaused({
        paused: true,
        requestedAt: "2026-08-08T12:00:02.000Z",
        sessionId,
      }),
    ).resolves.toEqual({ ok: true, value: { snapshot } });
    await expect(
      api.voice.setPaused({
        paused: false,
        requestedAt: "not-a-timestamp",
        sessionId,
      }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
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

  it("validates Automation mutations and event subscriptions on both sides", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(AUTOMATION_CHANNELS.create);
        expect(input).toEqual({
          definition: automationDefinitionFixture,
          requestedAt: FIXTURE_TIMESTAMPS.updated,
        });
        return Promise.resolve({ ok: true, value: automationFixture });
      },
    );
    let eventListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(AUTOMATION_CHANNELS.subscribe);
        eventListener = listener;
      },
    );
    const api = await loadApi();

    await expect(
      api.automations.create({
        definition: automationDefinitionFixture,
        requestedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    ).resolves.toEqual({ ok: true, value: automationFixture });
    await expect(
      api.automations.create({
        definition: automationDefinitionFixture,
        requestedAt: "not-a-timestamp",
      }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();

    const listener = vi.fn();
    const unsubscribe = api.automations.subscribe(listener);
    eventListener?.({}, automationFinishedEventFixture);
    expect(listener).toHaveBeenCalledWith(automationFinishedEventFixture);
    expect(() => eventListener?.({}, { type: "raw-electron-event" })).toThrow();
    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      AUTOMATION_CHANNELS.subscribe,
      eventListener,
    );
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

  it("keeps Territory source, pin and version mutations on narrow typed channels", async () => {
    const candidateId = "6b90bf76-893b-47dc-b9ea-913d0c25c5e6";
    electron.ipcRenderer.invoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === TERRITORY_CHANNELS.createSourceCandidate
          ? {
              ok: true,
              value: { candidateId, snapshot: activeTerritorySnapshot },
            }
          : { ok: true, value: activeTerritorySnapshot },
      ),
    );
    const api = await loadApi();

    await expect(
      api.territory.createSourceCandidate({
        source: {
          kind: "memory",
          memoryId: "17bd6914-d46b-44ee-9776-c0aa07ae91cd",
        },
      }),
    ).resolves.toMatchObject({ ok: true, value: { candidateId } });
    await expect(
      api.territory.setItemPinned({
        itemId: `memory.${candidateId}`,
        pinned: true,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      api.territory.selectItemVersion({
        itemId: `memory.${candidateId}`,
        revision: 2,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [
        TERRITORY_CHANNELS.createSourceCandidate,
        {
          source: {
            kind: "memory",
            memoryId: "17bd6914-d46b-44ee-9776-c0aa07ae91cd",
          },
        },
      ],
      [
        TERRITORY_CHANNELS.setItemPinned,
        { itemId: `memory.${candidateId}`, pinned: true },
      ],
      [
        TERRITORY_CHANNELS.selectItemVersion,
        { itemId: `memory.${candidateId}`, revision: 2 },
      ],
    ]);
    await expect(
      api.territory.createSourceCandidate({
        source: { kind: "memory", memoryId: "invalid" },
      }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(3);
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
