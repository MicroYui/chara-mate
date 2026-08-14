import path from "node:path";

import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";

import type { VoiceSessionSnapshot } from "../../shared/contracts/voice";
import type { ActivityService } from "../activity/activityService";
import type { AppLogger } from "../observability/logger";
import type { CharacterWindowController } from "../pet/characterWindowController";
import type { PetService } from "../pet/petService";
import type { VoiceService } from "../voice/voiceService";

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
  readonly quit: () => void;
  readonly voice: Pick<VoiceService, "getActive" | "setMuted">;
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
  const labels: Record<VoiceSessionSnapshot["phase"], string> = {
    connecting: "语音正在连接",
    failed: "语音连接已结束",
    interrupted: "语音连接已结束",
    listening: "语音中 · 正在听你说",
    paused: "语音已暂停",
    resuming: "语音正在恢复",
    speaking: "语音中 · Mika 正在说话",
    thinking: "语音中 · Mika 正在回应",
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
      const statusLabel = !hasPet
        ? "还没有启用桌宠 · 0 个"
        : petVisible
          ? "Mika 正在陪你 · 1 个桌宠"
          : "Mika 已暂时隐藏 · 1 个桌宠";
      const template: MenuItemConstructorOptions[] = [
        { enabled: false, label: statusLabel },
        { enabled: false, label: voiceStatusLabel(voiceSnapshot) },
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
      action();
    } catch (error) {
      this.dependencies.logger.warn(message, { error });
    }
    void this.refresh();
  }
}
