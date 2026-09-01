import { beforeEach, describe, expect, it, vi } from "vitest";

import { type CharacterWindowApi, PET_CHANNELS } from "../shared/contracts/pet";
import { VOICE_CHANNELS } from "../shared/contracts/voice";
import { VOICE_WAKE_CHANNELS } from "../shared/contracts/voiceWake";

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
  webUtils: {
    getPathForFile: vi.fn(() => "/tmp/sunset.jpg"),
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
        "dismissProactiveBubble",
        "dropComposerAttachments",
        "endDrag",
        "focusApproval",
        "focusConversation",
        "focusMain",
        "focusTerritoryMoment",
        "getPendingApproval",
        "getSnapshot",
        "markReady",
        "moveDrag",
        "reduceProactiveFrequency",
        "replyProactiveBubble",
        "resolveApproval",
        "showContextMenu",
        "startDrag",
        "subscribe",
        "subscribeApproval",
        "subscribeProactiveBubble",
        "subscribeTerritoryMoment",
        "voice",
        "voiceWake",
      ].sort(),
    );
    await expect(api.getSnapshot()).resolves.toEqual(characterSnapshot);
  });

  it("projects dropped files into the typed Main handoff", async () => {
    const api = await loadApi();
    const file = new File(["pixels"], "sunset.jpg", { type: "image/jpeg" });

    api.dropComposerAttachments([file]);

    expect(electron.webUtils.getPathForFile).toHaveBeenCalledWith(file);
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(
      PET_CHANNELS.dropComposerAttachments,
      {
        attachments: [
          expect.objectContaining({
            byteLength: 6,
            displayName: "sunset.jpg",
            mediaType: "image/jpeg",
            source: "image",
            storageKey: "/tmp/sunset.jpg",
          }),
        ],
      },
    );
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

  it("exposes the Character-only Voice Wake report boundary", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        expect(channel).toBe(VOICE_WAKE_CHANNELS.report);
        expect(input).toEqual({ phase: "listening" });
        return Promise.resolve({
          ok: true,
          value: {
            enabled: true,
            microphone: "granted",
            phase: "listening",
            phrase: "Hi Mika",
          },
        });
      },
    );
    const api = await loadApi();

    await expect(api.voiceWake.report({ phase: "listening" })).resolves.toEqual(
      {
        ok: true,
        value: {
          enabled: true,
          microphone: "granted",
          phase: "listening",
          phrase: "Hi Mika",
        },
      },
    );
    await expect(
      api.voiceWake.report({ phase: "voice_active" as never }),
    ).rejects.toThrow();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledOnce();
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

  it("routes proactive conversation actions through their narrow typed channels", async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (channel: string, input: unknown) => {
        if (channel === PET_CHANNELS.reduceProactiveFrequency) {
          expect(input).toEqual({
            bubbleId: "20000000-0000-4000-8000-000000000002",
          });
          return Promise.resolve({ ok: true, value: { level: "quiet" } });
        }
        expect(channel).toBe(PET_CHANNELS.replyProactiveBubble);
        expect(input).toEqual({
          bubbleId: "20000000-0000-4000-8000-000000000002",
          content: "我正在整理实验设计。",
          requestedAt: "2026-08-13T09:01:00.000Z",
        });
        return Promise.resolve({
          ok: true,
          value: { runId: "20000000-0000-4000-8000-000000000003" },
        });
      },
    );
    const api = await loadApi();
    const navigation = {
      bubbleId: "20000000-0000-4000-8000-000000000002",
      chatId: "20000000-0000-4000-8000-000000000001",
    };
    const dismissRequest = {
      bubbleId: "20000000-0000-4000-8000-000000000002",
    };

    api.focusConversation(navigation);
    api.dismissProactiveBubble(dismissRequest);
    await expect(api.reduceProactiveFrequency(dismissRequest)).resolves.toEqual(
      {
        ok: true,
        value: { level: "quiet" },
      },
    );
    await expect(
      api.replyProactiveBubble({
        ...dismissRequest,
        content: "我正在整理实验设计。",
        requestedAt: "2026-08-13T09:01:00.000Z",
      }),
    ).resolves.toEqual({
      ok: true,
      value: { runId: "20000000-0000-4000-8000-000000000003" },
    });

    expect(electron.ipcRenderer.send).toHaveBeenNthCalledWith(
      1,
      PET_CHANNELS.focusConversation,
      navigation,
    );
    expect(electron.ipcRenderer.send).toHaveBeenNthCalledWith(
      2,
      PET_CHANNELS.dismissProactiveBubble,
      dismissRequest,
    );
    expect(() =>
      api.focusConversation({ chatId: "not-an-entity-id" }),
    ).toThrow();
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(2);
  });

  it("validates proactive bubbles, accepts dismissal, and removes its wrapper", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(PET_CHANNELS.proactiveBubbleChanged);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.subscribeProactiveBubble(listener);
    if (!registeredListener) {
      throw new Error("Proactive bubble listener was not registered");
    }
    const bubble = {
      chatId: "20000000-0000-4000-8000-000000000001",
      content: "你在整理这篇文章吗？",
      createdAt: "2026-08-13T09:00:00.000Z",
      id: "20000000-0000-4000-8000-000000000002",
      kind: "continuation",
      replyState: "ready",
    };

    registeredListener({}, bubble);
    registeredListener({}, null);
    expect(listener).toHaveBeenNthCalledWith(1, bubble);
    expect(listener).toHaveBeenNthCalledWith(2, null);
    expect(() =>
      registeredListener?.({}, { content: "missing ids" }),
    ).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      PET_CHANNELS.proactiveBubbleChanged,
      registeredListener,
    );
  });

  it("validates Territory moment navigation and notice events", async () => {
    let registeredListener: IpcListener | undefined;
    electron.ipcRenderer.on.mockImplementation(
      (channel: string, listener: IpcListener) => {
        expect(channel).toBe(PET_CHANNELS.territoryMomentChanged);
        registeredListener = listener;
      },
    );
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.subscribeTerritoryMoment(listener);
    const candidateId = "30000000-0000-4000-8000-000000000001";
    const notice = {
      candidateId,
      createdAt: "2026-09-01T09:00:00.000Z",
      name: "散场后的余光",
      status: "ready",
      updatedAt: "2026-09-01T09:01:00.000Z",
    };

    registeredListener?.({}, notice);
    registeredListener?.({}, null);
    expect(listener).toHaveBeenNthCalledWith(1, notice);
    expect(listener).toHaveBeenNthCalledWith(2, null);

    api.focusTerritoryMoment({ candidateId });
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(
      PET_CHANNELS.focusTerritoryMoment,
      { candidateId },
    );
    expect(() =>
      api.focusTerritoryMoment({ candidateId: "invalid" }),
    ).toThrow();

    unsubscribe();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
      PET_CHANNELS.territoryMomentChanged,
      registeredListener,
    );
  });
});
