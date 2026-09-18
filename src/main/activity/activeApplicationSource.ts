import { createRequire } from "node:module";
import type { Timestamp } from "../../shared/contracts/primitives";
import { isUtcTimestamp } from "../../shared/schemas/primitives";

import type {
  ActivityPerception,
  ActivityApplicationLifecycle,
  ActivityInteraction,
} from "../../shared/contracts/activity";

import { redactText } from "../../shared/pure/redaction";

import {
  normalizeVisualFrame,
  normalizeVisualChange,
  type ActivityVisualChange,
  normalizeVisualSurface,
} from "./activityVisualSource";
import type { ActivityVisualFrame } from "./activityVisualEvidence";

const MAX_NATIVE_FIELD_BYTES = 16 * 1024;

export interface ActiveApplication extends ActivityPerception {
  readonly observedAt?: Timestamp;
  readonly actor?: "agent" | "user" | "unknown";
  readonly lifecycle?: ActivityApplicationLifecycle;
  readonly appId?: string;
  readonly appName: string;
  readonly windowTitle?: string;
}

export interface ActiveApplicationSource {
  subscribeVisualChanges(
    listener: (change: ActivityVisualChange) => void,
  ): () => void;
  setPaused(paused: boolean): void;
  pullVisual(signal?: AbortSignal): Promise<ActivityVisualFrame | undefined>;
  subscribe(
    listener: (application: ActiveApplication) => void,
    onError: (error: unknown) => void,
  ): () => Promise<void>;
}

type AccessibilityStatus = "available" | "permission_required" | "unavailable";

interface NativeActiveApplicationEvent {
  readonly observedAt?: unknown;
  readonly actor?: unknown;
  readonly accessibilityStatus?: unknown;
  readonly boundary?: unknown;
  readonly content?: unknown;
  readonly contentStatus?: unknown;
  readonly interaction?: unknown;
  readonly lifecycle?: unknown;
  readonly appId?: unknown;
  readonly appName?: unknown;
  readonly windowTitle?: unknown;
}

export interface NativeActiveApplicationObserver {
  subscribeVisualChanges(listener: (change: unknown) => void): () => void;
  pullVisual(): Promise<unknown>;
  redactVisual(bytes: Buffer, regionsJson: string): Promise<Buffer>;
  setPaused(paused: boolean): void;
  stopVisual(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void | Promise<void>;
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

function observedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? redactText(text) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeActivityPerception(
  input: unknown,
): ActivityPerception {
  const value = record(input);
  if (!value) return {};
  const status = value["contentStatus"];
  const declaredContentStatus =
    status === "available" || status === "unavailable" || status === "protected"
      ? status
      : undefined;
  const raw = record(value["content"]);
  const text =
    declaredContentStatus !== "protected" &&
    declaredContentStatus !== "unavailable"
      ? observedText(raw?.["text"])
      : undefined;
  const content =
    text &&
    (raw?.["source"] === "accessibility" || raw?.["source"] === "dom") &&
    (raw["scope"] === "focused_element" || raw["scope"] === "viewport")
      ? ({
          source: raw["source"],
          scope: raw["scope"],
          text,
          ...(raw["truncated"] === true ? { truncated: true as const } : {}),
        } as const)
      : undefined;
  const contentStatus =
    declaredContentStatus === "available" && !content
      ? "unavailable"
      : declaredContentStatus;
  const counts = record(value["interaction"]);
  const validCount = (count: unknown): count is number =>
    Number.isSafeInteger(count) && Number(count) >= 0;
  const interaction =
    counts &&
    validCount(counts["clicks"]) &&
    validCount(counts["keystrokes"]) &&
    validCount(counts["scrolls"])
      ? {
          clicks: counts["clicks"],
          keystrokes: counts["keystrokes"],
          scrolls: counts["scrolls"],
        }
      : undefined;
  const boundary = value["boundary"];
  return {
    ...(boundary === "application" ||
    boundary === "window" ||
    boundary === "content" ||
    boundary === "interaction" ||
    boundary === "idle"
      ? { boundary }
      : {}),
    ...(content ? { content } : {}),
    ...(contentStatus ? { contentStatus } : {}),
    ...(interaction
      ? {
          interaction,
          ...(value["inputOrigin"] === "hid_reported" ||
          value["inputOrigin"] === "synthetic_reported" ||
          value["inputOrigin"] === "unknown"
            ? { inputOrigin: value["inputOrigin"] }
            : {}),
        }
      : {}),
    ...(value["surface"]
      ? { surface: normalizeVisualSurface(value["surface"]) }
      : {}),
    ...(value["visualStatus"] === "available" ||
    value["visualStatus"] === "unavailable" ||
    value["visualStatus"] === "protected"
      ? { visualStatus: value["visualStatus"] }
      : {}),
  };
}

export function mergeActivityInteractions(
  left: ActivityInteraction | undefined,
  right: ActivityInteraction | undefined,
): ActivityInteraction | undefined {
  if (!left) return right;
  if (!right) return left;
  const add = (a: number, b: number) =>
    Math.min(Number.MAX_SAFE_INTEGER, a + b);
  return {
    clicks: add(left.clicks, right.clicks),
    keystrokes: add(left.keystrokes, right.keystrokes),
    scrolls: add(left.scrolls, right.scrolls),
  };
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
  const lifecycle = value.lifecycle;
  return {
    accessibilityStatus,
    application: {
      ...normalizeActivityPerception(value),
      ...(typeof value.observedAt === "string" &&
      isUtcTimestamp(value.observedAt)
        ? { observedAt: value.observedAt }
        : {}),
      actor:
        value.actor === "agent" || value.actor === "user"
          ? value.actor
          : "unknown",
      ...(lifecycle === "launched" ||
      lifecycle === "activated" ||
      lifecycle === "terminated"
        ? { lifecycle }
        : {}),
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
  if (
    typeof loaded.subscribe !== "function" ||
    typeof loaded.subscribeVisualChanges !== "function" ||
    typeof loaded.pullVisual !== "function" ||
    typeof loaded.redactVisual !== "function" ||
    typeof loaded.setPaused !== "function" ||
    typeof loaded.stopVisual !== "function"
  ) {
    throw new TypeError(
      "前台应用原生观察器缺少必要的采集或生命周期导出，请重新构建原生模块。",
    );
  }
  return loaded as NativeActiveApplicationObserver;
}

function accessibilityError(status: AccessibilityStatus): Error | undefined {
  if (status === "permission_required") {
    return new Error(
      "桌面内容与全局按键观察不完整：请在系统设置中为 CharaMate 开启辅助功能权限。",
    );
  }
  if (status === "unavailable") {
    return new Error("当前应用的辅助功能内容不可读。");
  }
  return undefined;
}

export class MacOsActiveApplicationSource implements ActiveApplicationSource {
  #observer: NativeActiveApplicationObserver | undefined;
  #visualGeneration = 0;
  #visualPaused = false;
  #visualListeners = new Set<(change: ActivityVisualChange) => void>();
  #visualTasks = new Set<Promise<unknown>>();
  #pull: Promise<ActivityVisualFrame | undefined> | undefined;
  readonly #loadAddon: (addonPath: string) => NativeActiveApplicationObserver;
  readonly #platform: NodeJS.Platform;

  constructor(
    private readonly addonPath: string,
    options: MacOsActiveApplicationSourceOptions = {},
  ) {
    this.#loadAddon = options.loadAddon ?? defaultAddonLoader;
    this.#platform = options.platform ?? process.platform;
  }

  subscribeVisualChanges(
    listener: (change: ActivityVisualChange) => void,
  ): () => void {
    this.#visualListeners.add(listener);
    return () => {
      this.#visualListeners.delete(listener);
    };
  }

  setPaused(paused: boolean): void {
    if (paused !== this.#visualPaused) this.#visualGeneration += 1;
    this.#visualPaused = paused;
    this.#observer?.setPaused(paused);
  }

  async pullVisual(
    signal?: AbortSignal,
  ): Promise<ActivityVisualFrame | undefined> {
    signal?.throwIfAborted();
    if (this.#pull) {
      const frame = await this.#pull;
      signal?.throwIfAborted();
      return frame;
    }
    const observer = this.#observer;
    const generation = this.#visualGeneration;
    if (!observer || this.#visualPaused) return undefined;
    const task = observer.pullVisual().then(async (raw) => {
      if (generation !== this.#visualGeneration) return undefined;
      const frame = await normalizeVisualFrame(raw, (bytes, regions) =>
        observer.redactVisual(bytes, JSON.stringify(regions)),
      );
      return generation === this.#visualGeneration ? frame : undefined;
    });
    this.#pull = task;
    this.#visualTasks.add(task);
    try {
      const frame = await task;
      signal?.throwIfAborted();
      return frame;
    } finally {
      this.#visualTasks.delete(task);
      if (this.#pull === task) this.#pull = undefined;
    }
  }

  subscribe(
    listener: (application: ActiveApplication) => void,
    onError: (error: unknown) => void,
  ): () => Promise<void> {
    if (this.#platform !== "darwin") return () => Promise.resolve();

    let stopped = false;
    const reportedStatuses = new Set<AccessibilityStatus>();
    let stop: (() => void | Promise<void>) | undefined;
    let stopVisualChanges: (() => void) | undefined;
    try {
      const observer = this.#loadAddon(this.addonPath);
      this.#observer = observer;
      // Apply initial pause before subscribe can synchronously begin a native capture.
      observer.setPaused(this.#visualPaused);
      stopVisualChanges = observer.subscribeVisualChanges((raw) => {
        if (stopped || this.#visualPaused) return;
        try {
          const change = normalizeVisualChange(raw);
          for (const listener of this.#visualListeners) listener(change);
        } catch (error) {
          onError(error);
        }
      });
      stop = observer.subscribe((input) => {
        if (stopped || this.#visualPaused) return;
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
      stopped = true;
      const observer = this.#observer;
      this.#observer = undefined;
      stopVisualChanges?.();
      const cleanup = (async () => {
        await stop?.();
        await observer?.stopVisual();
      })();
      void cleanup.catch(onError);
      onError(error);
      return () => cleanup;
    }

    let stopping: Promise<void> | undefined;
    return () => {
      if (stopping) return stopping;
      stopped = true;
      const observer = this.#observer;
      this.#observer = undefined;
      this.#visualGeneration += 1;
      stopVisualChanges?.();
      const nativeStop = stop?.();
      stopping = (async () => {
        await nativeStop;
        await observer?.stopVisual();
        await Promise.allSettled([...this.#visualTasks]);
      })();
      return stopping;
    };
  }
}
