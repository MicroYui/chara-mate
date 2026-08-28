import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MenuItemConstructorOptions } from "electron";

import type { PetCharacterSnapshot } from "../../shared/contracts/pet";
import type { VoiceSessionSnapshot } from "../../shared/contracts/voice";
import type { VoiceWakeSnapshot } from "../../shared/contracts/voiceWake";
import { TrayController, trayIconPath } from "./trayController";

const electron = vi.hoisted(() => {
  const image = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  };
  const trays: Array<{
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
  }> = [];
  const Tray = vi.fn(function () {
    const tray = {
      destroy: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
    };
    trays.push(tray);
    return tray;
  });
  return {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({
      template,
    })),
    createFromPath: vi.fn(() => image),
    image,
    Tray,
    trays,
  };
});

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  nativeImage: { createFromPath: electron.createFromPath },
  Tray: electron.Tray,
}));

const petSnapshot: PetCharacterSnapshot = {
  activePet: {
    description: "A calm companion",
    displayName: "Columbinya",
    id: "columbinya",
    spriteHeight: 256,
    spriteUrl: "chara-mate-pet://library/columbinya/spritesheet.webp",
    spriteVersionNumber: 2,
    spriteWidth: 256,
  },
  animation: "idle",
  animationSpeed: 0.75,
  facing: "right",
  scale: 1,
};

const voiceSnapshot: VoiceSessionSnapshot = {
  assistantTranscript: "",
  chatId: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-08-14T08:00:00.000Z",
  generation: 1,
  inputMode: "hands_free",
  muted: false,
  phase: "listening",
  sessionId: "22222222-2222-4222-8222-222222222222",
  userTranscript: "",
  voice: "coral",
};

const wakeSnapshot: VoiceWakeSnapshot = {
  enabled: false,
  microphone: "granted",
  phase: "disabled",
  phrase: "Hi Mika",
};

function latestMenuItem(label: string): MenuItemConstructorOptions {
  const call = electron.buildFromTemplate.mock.lastCall;
  const template = call?.[0];
  const item = template?.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  return item;
}

function clickCheckbox(item: MenuItemConstructorOptions, checked: boolean) {
  const click = item.click as
    ((item: { checked: boolean }) => void) | undefined;
  click?.({ checked });
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.trays.length = 0;
});

describe("trayIconPath", () => {
  it("resolves the checked-in icon in development and packaged resources", () => {
    expect(
      trayIconPath({
        appPath: "/workspace/chara-mate",
        isPackaged: false,
        resourcesPath: "/Applications/CharaMate.app/Contents/Resources",
      }),
    ).toBe("/workspace/chara-mate/resources/tray/charamate-statusTemplate.png");
    expect(
      trayIconPath({
        appPath: "/Applications/CharaMate.app/Contents/Resources/app.asar",
        isPackaged: true,
        resourcesPath: "/Applications/CharaMate.app/Contents/Resources",
      }),
    ).toBe(
      "/Applications/CharaMate.app/Contents/Resources/tray/charamate-statusTemplate.png",
    );
  });
});

describe("TrayController", () => {
  it("projects one natural status menu and reuses existing domain controls", async () => {
    let petVisible = true;
    let activeVoice: VoiceSessionSnapshot | null = null;
    let petListener: (() => void) | undefined;
    let pauseListener: (() => void) | undefined;
    let wakeListener: (() => void) | undefined;
    const disposePet = vi.fn();
    const disposePause = vi.fn();
    const disposeWake = vi.fn();
    const setUserVisible = vi.fn((visible: boolean) => {
      petVisible = visible;
    });
    const setPaused = vi.fn();
    const setMuted = vi.fn(() => voiceSnapshot);
    const setWakeEnabled = vi.fn();
    const openMainWindow = vi.fn();
    const quit = vi.fn();
    const warn = vi.fn();
    const dependencies = {
      activity: {
        isPaused: vi.fn(() => false),
        onPauseChanged: vi.fn((listener: () => void) => {
          pauseListener = listener;
          return disposePause;
        }),
        setPaused,
      },
      character: {
        isUserVisible: vi.fn(() => petVisible),
        setUserVisible,
      },
      logger: { warn },
      openMainWindow,
      pet: {
        getCharacterSnapshot: vi.fn(() => Promise.resolve(petSnapshot)),
        subscribe: vi.fn((listener: () => void) => {
          petListener = listener;
          return disposePet;
        }),
      },
      quit,
      voice: {
        getActive: vi.fn(() => activeVoice),
        setMuted,
      },
      wake: {
        getSnapshot: vi.fn(() => wakeSnapshot),
        setEnabled: setWakeEnabled,
        subscribe: vi.fn((listener: () => void) => {
          wakeListener = listener;
          return disposeWake;
        }),
      },
    } as unknown as ConstructorParameters<typeof TrayController>[0];
    const controller = new TrayController(
      dependencies,
      {
        appPath: "/workspace/chara-mate",
        isPackaged: false,
        resourcesPath: "/resources",
      },
      "darwin",
    );

    await controller.create();

    expect(electron.createFromPath).toHaveBeenCalledWith(
      "/workspace/chara-mate/resources/tray/charamate-statusTemplate.png",
    );
    expect(electron.image.setTemplateImage).toHaveBeenCalledWith(true);
    expect(electron.trays[0]?.setToolTip).toHaveBeenLastCalledWith(
      "Mika 正在陪你 · 1 个桌宠",
    );
    expect(latestMenuItem("当前没有语音对话").enabled).toBe(false);
    expect(latestMenuItem("语音唤醒未开启").enabled).toBe(false);
    clickCheckbox(latestMenuItem("语音唤醒（Hi Mika）"), true);
    expect(setWakeEnabled).toHaveBeenCalledWith(true);

    clickCheckbox(latestMenuItem("显示桌宠"), false);
    expect(setUserVisible).toHaveBeenCalledWith(false);
    await vi.waitFor(() =>
      expect(electron.trays[0]?.setToolTip).toHaveBeenLastCalledWith(
        "Mika 已暂时隐藏 · 1 个桌宠",
      ),
    );

    clickCheckbox(latestMenuItem("暂停活动感知"), true);
    expect(setPaused).toHaveBeenCalledWith(true);

    latestMenuItem("打开 CharaMate").click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {},
    );
    expect(openMainWindow).toHaveBeenCalledOnce();

    activeVoice = voiceSnapshot;
    await controller.refresh();
    expect(latestMenuItem("语音中 · 正在听你说").enabled).toBe(false);
    clickCheckbox(latestMenuItem("麦克风静音"), true);
    expect(setMuted).toHaveBeenCalledWith(voiceSnapshot.sessionId, true);

    const refreshCount = electron.buildFromTemplate.mock.calls.length;
    petListener?.();
    pauseListener?.();
    wakeListener?.();
    await vi.waitFor(() =>
      expect(electron.buildFromTemplate.mock.calls.length).toBeGreaterThan(
        refreshCount,
      ),
    );

    controller.destroy();
    expect(disposePet).toHaveBeenCalledOnce();
    expect(disposePause).toHaveBeenCalledOnce();
    expect(disposeWake).toHaveBeenCalledOnce();
    expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce();
    expect(controller.isCreated()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
