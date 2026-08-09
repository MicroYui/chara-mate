import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSettings,
  BrowserComputerSettings,
  SettingsSnapshot,
  VoiceSettings,
  VoiceSettingsConfig,
} from "../../shared/contracts/settings";
import type { Clock } from "../../shared/pure/clock";
import type { ManagedBrowser } from "../browser/managedBrowser";
import type { SettingsRepository } from "./settingsRepository";

export interface ComputerPermissionReader {
  read(): BrowserComputerSettings["accessibility"];
  readScreenRecording(): BrowserComputerSettings["screenRecording"];
  readMicrophone(): VoiceSettings["microphone"];
}

export class SettingsService {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly browser: ManagedBrowser,
    private readonly permissions: ComputerPermissionReader,
    private readonly clock: Clock,
    private readonly onWorkingDirectoryChanged: (
      directory: string,
    ) => Promise<void>,
  ) {}

  getAgent(): AgentSettings {
    return this.repository.getAgent();
  }

  resolveWorkingPath(value: string): string {
    return path.resolve(this.getAgent().workingDirectory, value);
  }

  async getSnapshot(): Promise<SettingsSnapshot> {
    return {
      agent: this.getAgent(),
      browserComputer: {
        accessibility: this.permissions.read(),
        browser: await this.browser.status(),
        profileDirectory: this.browser.profileDirectory,
        screenRecording: this.permissions.readScreenRecording(),
      },
      voice: this.getVoice(),
    };
  }

  async saveAgent(settings: AgentSettings): Promise<AgentSettings> {
    const workingDirectory = path.resolve(settings.workingDirectory);
    const metadata = await stat(workingDirectory).catch(() => undefined);
    if (!metadata?.isDirectory()) {
      throw new Error("工作目录不存在或不是目录。");
    }
    const previous = this.getAgent();
    const saved = this.repository.saveAgent(
      { ...settings, workingDirectory },
      this.clock.now(),
    );
    if (previous.workingDirectory !== saved.workingDirectory) {
      await this.onWorkingDirectoryChanged(saved.workingDirectory);
    }
    return saved;
  }

  getVoice(): VoiceSettings {
    return {
      ...this.repository.getVoice(),
      microphone: this.permissions.readMicrophone(),
    };
  }

  saveVoice(settings: VoiceSettingsConfig): VoiceSettings {
    this.repository.saveVoice(settings, this.clock.now());
    return this.getVoice();
  }

  async openManagedBrowser(): Promise<{ message: string }> {
    await this.browser.open();
    return { message: "受管浏览器已打开。" };
  }

  async importBrowserCookies(
    sourcePath: string,
  ): Promise<{ importedCookies: number; message: string }> {
    const importedCookies = await this.browser.importCookies(sourcePath);
    return {
      importedCookies,
      message: `已向受管 Profile 导入 ${String(importedCookies)} 条 Cookie。`,
    };
  }
}
