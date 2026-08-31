import { createRequire } from "node:module";

import { redactText } from "../../shared/pure/redaction";

const MAX_NATIVE_FIELD_BYTES = 16 * 1024;

export interface ActiveApplication {
  readonly appId?: string;
  readonly appName: string;
  readonly windowTitle?: string;
}

export interface ActiveApplicationSource {
  subscribe(
    listener: (application: ActiveApplication) => void,
    onError: (error: unknown) => void,
  ): () => Promise<void>;
}

type AccessibilityStatus = "available" | "permission_required" | "unavailable";

interface NativeActiveApplicationEvent {
  readonly accessibilityStatus?: unknown;
  readonly appId?: unknown;
  readonly appName?: unknown;
  readonly windowTitle?: unknown;
}

export interface NativeActiveApplicationObserver {
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface MacOsActiveApplicationSourceOptions {
  readonly loadAddon?: (addonPath: string) => NativeActiveApplicationObserver;
  readonly platform?: NodeJS.Platform;
}

interface NormalizedNativeEvent {
  readonly accessibilityStatus: AccessibilityStatus;
  readonly application: ActiveApplication;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > MAX_NATIVE_FIELD_BYTES
  ) {
    return undefined;
  }
  return redactText(normalized);
}

export function normalizeActiveApplicationEvent(
  input: unknown,
): NormalizedNativeEvent | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as NativeActiveApplicationEvent;
  const appName = boundedText(value.appName);
  const accessibilityStatus = value.accessibilityStatus;
  if (
    !appName ||
    (accessibilityStatus !== "available" &&
      accessibilityStatus !== "permission_required" &&
      accessibilityStatus !== "unavailable")
  ) {
    return undefined;
  }
  const appId = boundedText(value.appId);
  const windowTitle = boundedText(value.windowTitle);
  return {
    accessibilityStatus,
    application: {
      ...(appId ? { appId } : {}),
      appName,
      ...(windowTitle ? { windowTitle } : {}),
    },
  };
}

function defaultAddonLoader(
  addonPath: string,
): NativeActiveApplicationObserver {
  const require = createRequire(import.meta.url);
  const loaded = require(addonPath) as Partial<NativeActiveApplicationObserver>;
  if (typeof loaded.subscribe !== "function") {
    throw new TypeError("前台应用原生观察器缺少 subscribe 导出。");
  }
  return loaded as NativeActiveApplicationObserver;
}

function accessibilityError(status: AccessibilityStatus): Error | undefined {
  if (status === "permission_required") {
    return new Error(
      "前台窗口标题不可用：请在系统设置中为 CharaMate 开启辅助功能权限。",
    );
  }
  if (status === "unavailable") {
    return new Error("前台窗口标题观察器不可用。");
  }
  return undefined;
}

export class MacOsActiveApplicationSource implements ActiveApplicationSource {
  readonly #loadAddon: (addonPath: string) => NativeActiveApplicationObserver;
  readonly #platform: NodeJS.Platform;

  constructor(
    private readonly addonPath: string,
    options: MacOsActiveApplicationSourceOptions = {},
  ) {
    this.#loadAddon = options.loadAddon ?? defaultAddonLoader;
    this.#platform = options.platform ?? process.platform;
  }

  subscribe(
    listener: (application: ActiveApplication) => void,
    onError: (error: unknown) => void,
  ): () => Promise<void> {
    if (this.#platform !== "darwin") return () => Promise.resolve();

    const reportedStatuses = new Set<AccessibilityStatus>();
    let stop: (() => void) | undefined;
    try {
      const observer = this.#loadAddon(this.addonPath);
      stop = observer.subscribe((input) => {
        try {
          const event = normalizeActiveApplicationEvent(input);
          if (!event) {
            onError(new Error("前台应用事件格式无效。"));
            return;
          }
          if (!reportedStatuses.has(event.accessibilityStatus)) {
            reportedStatuses.add(event.accessibilityStatus);
            const error = accessibilityError(event.accessibilityStatus);
            if (error) onError(error);
          }
          listener(event.application);
        } catch (error) {
          onError(error);
        }
      });
      if (typeof stop !== "function") {
        throw new TypeError("前台应用原生观察器没有返回停止函数。");
      }
    } catch (error) {
      onError(error);
      return () => Promise.resolve();
    }

    let stopped = false;
    return () => {
      if (stopped) return Promise.resolve();
      stopped = true;
      stop?.();
      return Promise.resolve();
    };
  }
}
