import path from "node:path";

import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";

import type { VoiceSessionSnapshot } from "../../shared/contracts/voice";
import type { VoiceWakeSnapshot } from "../../shared/contracts/voiceWake";
import type { ActivityService } from "../activity/activityService";
import type { AppLogger } from "../observability/logger";
import type { CharacterWindowController } from "../pet/characterWindowController";
import type { PetService } from "../pet/petService";
import type { PersonaService } from "../persona/personaService";
import type { VoiceService } from "../voice/voiceService";
import type { VoiceWakeService } from "../voice/voiceWakeService";

const TRAY_ICON_FILENAME = "charamate-statusTemplate.png";

export interface TrayRuntimePaths {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}

interface TrayControllerDependencies {
  readonly activity: Pick<
    ActivityService,
    "isPaused" | "onPauseChanged" | "setPaused"
  >;
  readonly character: Pick<
    CharacterWindowController,
    "isUserVisible" | "setUserVisible"
  >;
  readonly logger: Pick<AppLogger, "warn">;
  readonly openMainWindow: () => void;
  readonly pet: Pick<PetService, "getCharacterSnapshot" | "subscribe">;
  readonly persona: Pick<PersonaService, "getActiveSnapshot">;
  readonly quit: () => void;
  readonly voice: Pick<VoiceService, "getActive" | "setMuted">;
  readonly wake: Pick<
    VoiceWakeService,
    "getSnapshot" | "setEnabled" | "subscribe"
  >;
}

export function trayIconPath({
  appPath,
  isPackaged,
  resourcesPath,
}: TrayRuntimePaths): string {
  return isPackaged
    ? path.join(resourcesPath, "tray", TRAY_ICON_FILENAME)
    : path.join(appPath, "resources", "tray", TRAY_ICON_FILENAME);
}

function voiceStatusLabel(snapshot: VoiceSessionSnapshot | null): string {
  if (!snapshot) return "当前没有语音对话";
  const name = snapshot.persona.displayName;
  const labels: Record<VoiceSessionSnapshot["phase"], string> = {
    connecting: "语音正在连接",
    failed: "语音连接已结束",
    interrupted: "语音连接已结束",
    listening: "语音中 · 正在听你说",
    paused: "语音已暂停",
    resuming: "语音正在恢复",
    speaking: `语音中 · ${name} 正在说话`,
    thinking: `语音中 · ${name} 正在回应`,
    using_tool: "语音中 · 正在帮你处理",
    waiting_approval: "语音中 · 等待你的确认",
  };
  return labels[snapshot.phase];
}

function voiceCanMute(snapshot: VoiceSessionSnapshot | null): boolean {
  return Boolean(
    snapshot && snapshot.phase !== "failed" && snapshot.phase !== "interrupted",
  );
}

function wakeStatusLabel(snapshot: VoiceWakeSnapshot): string {
  const labels: Record<VoiceWakeSnapshot["phase"], string> = {
    arming: "语音唤醒 · 正在准备",
    connecting: "语音唤醒 · 正在进入对话",
    detected: "已听到“Hi Mika”",
    disabled: "语音唤醒未开启",
    error: "语音唤醒暂时不可用",
    listening: "语音唤醒 · 等待“Hi Mika”",
    suspended: "语音唤醒已随系统暂停",
    voice_active: "语音唤醒 · 对话中暂停监听",
  };
  return labels[snapshot.phase];
}

export class TrayController {
  #disposers: Array<() => void> = [];
  #refreshGeneration = 0;
  #tray: Tray | undefined;

  constructor(
    private readonly dependencies: TrayControllerDependencies,
    private readonly runtimePaths: TrayRuntimePaths,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async create(): Promise<void> {
    if (this.#tray) return;
    const image = nativeImage.createFromPath(trayIconPath(this.runtimePaths));
    if (image.isEmpty()) {
      throw new Error("CharaMate tray icon could not be loaded.");
    }
    if (this.platform === "darwin") image.setTemplateImage(true);

    const tray = new Tray(image);
    this.#tray = tray;
    tray.on("click", () => void this.refresh());
    this.#disposers = [
      this.dependencies.pet.subscribe(() => void this.refresh()),
      this.dependencies.activity.onPauseChanged(() => void this.refresh()),
      this.dependencies.wake.subscribe(() => void this.refresh()),
    ];
    await this.refresh();
  }

  destroy(): void {
    this.#refreshGeneration += 1;
    for (const dispose of this.#disposers.splice(0)) dispose();
    const tray = this.#tray;
    this.#tray = undefined;
    if (tray && !tray.isDestroyed()) tray.destroy();
  }

  isCreated(): boolean {
    return Boolean(this.#tray && !this.#tray.isDestroyed());
  }

  async refresh(): Promise<void> {
    const tray = this.#tray;
    if (!tray || tray.isDestroyed()) return;
    const generation = ++this.#refreshGeneration;
    try {
      const petSnapshot = await this.dependencies.pet.getCharacterSnapshot();
      if (
        generation !== this.#refreshGeneration ||
        tray !== this.#tray ||
        tray.isDestroyed()
      ) {
        return;
      }
      const hasPet = petSnapshot.activePet !== null;
      const petVisible = hasPet && this.dependencies.character.isUserVisible();
      const voiceSnapshot = this.dependencies.voice.getActive();
      const wakeSnapshot = this.dependencies.wake.getSnapshot();
      const personaName =
        this.dependencies.persona.getActiveSnapshot().displayName;
      const statusLabel = !hasPet
        ? "还没有启用桌宠 · 0 个"
        : petVisible
          ? `${personaName} 正在陪你 · 1 个桌宠`
          : `${personaName} 已暂时隐藏 · 1 个桌宠`;
      const template: MenuItemConstructorOptions[] = [
        { enabled: false, label: statusLabel },
        { enabled: false, label: voiceStatusLabel(voiceSnapshot) },
        { enabled: false, label: wakeStatusLabel(wakeSnapshot) },
        { type: "separator" },
        {
          checked: petVisible,
          click: (item) => {
            this.runMenuAction("TRAY_PET_VISIBILITY_ERROR", () =>
              this.dependencies.character.setUserVisible(item.checked),
            );
          },
          enabled: hasPet,
          label: "显示桌宠",
          type: "checkbox",
        },
        {
          click: () => this.dependencies.openMainWindow(),
          label: "打开 CharaMate",
        },
        {
          checked: wakeSnapshot.enabled,
          click: (item) => {
            this.runMenuAction("TRAY_VOICE_WAKE_ERROR", () =>
              this.dependencies.wake.setEnabled(item.checked),
            );
          },
          label: "语音唤醒（Hi Mika）",
          type: "checkbox",
        },
        {
          checked: voiceSnapshot?.muted ?? false,
          click: (item) => {
            if (!voiceSnapshot) return;
            this.runMenuAction("TRAY_VOICE_MUTE_ERROR", () =>
              this.dependencies.voice.setMuted(
                voiceSnapshot.sessionId,
                item.checked,
              ),
            );
          },
          enabled: voiceCanMute(voiceSnapshot),
          label: "麦克风静音",
          type: "checkbox",
        },
        {
          checked: this.dependencies.activity.isPaused(),
          click: (item) => {
            this.runMenuAction("TRAY_ACTIVITY_PAUSE_ERROR", () =>
              this.dependencies.activity.setPaused(item.checked),
            );
          },
          label: "暂停活动感知",
          type: "checkbox",
        },
        { type: "separator" },
        { click: () => this.dependencies.quit(), label: "退出 CharaMate" },
      ];
      tray.setContextMenu(Menu.buildFromTemplate(template));
      tray.setToolTip(statusLabel);
    } catch (error) {
      this.dependencies.logger.warn("TRAY_REFRESH_ERROR", { error });
    }
  }

  private runMenuAction(message: string, action: () => unknown): void {
    try {
      const result = action();
      if (result instanceof Promise) {
        void result
          .catch((error: unknown) => {
            this.dependencies.logger.warn(message, { error });
          })
          .finally(() => void this.refresh());
        return;
      }
    } catch (error) {
      this.dependencies.logger.warn(message, { error });
    }
    void this.refresh();
  }
}
