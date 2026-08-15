import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSettings,
  BrowserComputerSettings,
  DataSettingsSnapshot,
  DataUsageCategoryId,
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

const DATA_CATEGORIES = [
  { id: "database", label: "对话与应用数据库" },
  { id: "artifacts", label: "文件与运行产物" },
  { id: "browser", label: "受管浏览器资料" },
  { id: "activity", label: "Activity 记录与截图" },
  { id: "territory", label: "领地场景与生成素材" },
  { id: "pets", label: "桌宠资源" },
  { id: "skills", label: "Skills" },
  { id: "application", label: "应用配置与缓存" },
] as const satisfies readonly {
  readonly id: DataUsageCategoryId;
  readonly label: string;
}[];

function categoryForEntry(name: string): DataUsageCategoryId {
  if (/^charamate\.sqlite(?:-(?:shm|wal))?$/u.test(name)) return "database";
  if (name === "artifacts") return "artifacts";
  if (name === "browser") return "browser";
  if (name === "activity") return "activity";
  if (name === "territory") return "territory";
  if (name === "pets") return "pets";
  if (name === "skills") return "skills";
  return "application";
}

async function byteLengthOf(target: string): Promise<number> {
  const metadata = await lstat(target).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink()) return 0;
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) return 0;
  const entries = await readdir(target).catch(() => []);
  const sizes = await Promise.all(
    entries.map((entry) => byteLengthOf(path.join(target, entry))),
  );
  return sizes.reduce((total, size) => total + size, 0);
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
    private readonly dataDirectory: string,
    private readonly openPath: (target: string) => Promise<string>,
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

  async getDataSnapshot(): Promise<DataSettingsSnapshot> {
    const byteLengths = new Map<DataUsageCategoryId, number>(
      DATA_CATEGORIES.map(({ id }) => [id, 0]),
    );
    const entries = await readdir(this.dataDirectory).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        const id = categoryForEntry(entry);
        const byteLength = await byteLengthOf(
          path.join(this.dataDirectory, entry),
        );
        byteLengths.set(id, (byteLengths.get(id) ?? 0) + byteLength);
      }),
    );
    const categories = DATA_CATEGORIES.map(({ id, label }) => ({
      byteLength: byteLengths.get(id) ?? 0,
      id,
      label,
    }));
    return {
      categories,
      dataDirectory: this.dataDirectory,
      totalByteLength: categories.reduce(
        (total, category) => total + category.byteLength,
        0,
      ),
    };
  }

  async openDataDirectory(): Promise<{ message: string }> {
    const error = await this.openPath(this.dataDirectory);
    if (error) throw new Error(error);
    return { message: "数据目录已在 Finder 中打开。" };
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
