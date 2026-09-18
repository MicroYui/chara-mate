import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

import type { ActivityPerception } from "../../shared/contracts/activity";
import { normalizeActivityPerception } from "../activity/activeApplicationSource";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { BrowserComputerSettings } from "../../shared/contracts/settings";
import type { ToolResult } from "../../shared/contracts/tool";
import { redactText } from "../../shared/pure/redaction";
import type { ArtifactStore } from "../tools/artifactStore";
import type { ToolDefinition, ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";

interface BrowserLocatorInput {
  readonly name?: string;
  readonly role?: string;
  readonly selector?: string;
}

export interface ManagedBrowserActivityState extends ActivityPerception {
  readonly actor?: "agent" | "system" | "user";
  readonly action?: string;
  readonly title?: string;
  readonly url: string;
}

interface ManagedPageActivityOptions {
  readonly binding: string;
  readonly batchMs: number;
  readonly maxTextLength: number;
  readonly maxVisitedNodes: number;
}

// Serialized by Playwright: keep the function self-contained, with no module
// closures. Observe visible text nodes, never input values or clipboard data.
export function installManagedPageActivity(
  options: ManagedPageActivityOptions,
): void {
  if (window.top !== window) return;
  const host = window as unknown as Record<string, unknown>;
  const prior = host["__charaMateActivity"] as { stop(): void } | undefined;
  prior?.stop();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSignature = "";
  let clicks = 0,
    keystrokes = 0,
    scrolls = 0;
  let automated = false;
  let pendingActor: "agent" | "system" | "user" = "system";
  const visibleText = (): string => {
    if (!document.body) return "";
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const parts: string[] = [];
    let size = 0,
      visited = 0;
    while (
      visited++ < options.maxVisitedNodes &&
      size < options.maxTextLength
    ) {
      const node = walker.nextNode();
      if (!node) break;
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          "script,style,noscript,template,input,textarea,[hidden],[aria-hidden='true'],[inert]",
        )
      )
        continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = parent.getBoundingClientRect();
      if (
        box.width <= 0 ||
        box.height <= 0 ||
        box.bottom <= 0 ||
        box.right <= 0 ||
        box.top >= innerHeight ||
        box.left >= innerWidth
      )
        continue;
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (!text) continue;
      parts.push(text.slice(0, options.maxTextLength - size));
      size += text.length;
    }
    return parts.join(" · ").slice(0, options.maxTextLength);
  };
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (stopped || document.visibilityState === "hidden") {
      clicks = keystrokes = scrolls = 0;
      return;
    }
    const content = visibleText();
    const signature = JSON.stringify([location.href, document.title, content]);
    const hasInteraction = clicks + keystrokes + scrolls > 0;
    if (signature === lastSignature && !hasInteraction) return;
    const contentChanged = signature !== lastSignature;
    lastSignature = signature;
    const publish = host[options.binding];
    if (typeof publish === "function") {
      const send = publish as (payload: unknown) => unknown;
      const result: unknown = send({
        actor: automated ? "agent" : pendingActor,
        boundary: contentChanged ? "content" : "interaction",
        ...(content
          ? { content: { source: "dom", scope: "viewport", text: content } }
          : {}),
        contentStatus: content ? "available" : "unavailable",
        ...(hasInteraction
          ? { interaction: { clicks, keystrokes, scrolls } }
          : {}),
      });
      if (result instanceof Promise) void result.catch(() => undefined);
    }
    clicks = keystrokes = scrolls = 0;
    pendingActor = automated ? "agent" : "system";
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(flush, options.batchMs);
  };
  const interact = (event: Event) => {
    if (stopped) return;
    if (event.type === "pointerdown") clicks += 1;
    if (event.type === "keydown") keystrokes += 1;
    if (event.type === "wheel") scrolls += 1;
    pendingActor = automated ? "agent" : "user";
    schedule();
  };
  const mutations = new MutationObserver(() => {
    if (automated) pendingActor = "agent";
    schedule();
  });
  mutations.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "class", "style"],
  });
  const eventTypes = ["pointerdown", "keydown", "wheel", "scroll", "focusin"];
  for (const type of eventTypes)
    document.addEventListener(type, interact, { capture: true, passive: true });
  const stop = () => {
    stopped = true;
    mutations.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const type of eventTypes)
      document.removeEventListener(type, interact, true);
    window.removeEventListener("pagehide", stop);
    document.removeEventListener("visibilitychange", schedule);
  };
  host["__charaMateActivity"] = {
    flush,
    setAutomated(value: boolean) {
      flush();
      automated = value;
      pendingActor = value ? "agent" : "system";
    },
    stop,
  };
  window.addEventListener("pagehide", stop, { once: true });
  document.addEventListener("visibilitychange", schedule);
  schedule();
}

const PAGE_ACTIVITY_OPTIONS: ManagedPageActivityOptions = {
  binding: "__charaMatePublishActivity",
  batchMs: 1000,
  maxTextLength: 4096,
  maxVisitedNodes: 5000,
};

export function bundledChromiumExecutablePath(resourcesPath: string): string {
  const developmentPath = chromium.executablePath();
  let revisionDirectory = path.dirname(developmentPath);
  while (
    path.dirname(revisionDirectory) !== revisionDirectory &&
    !path.basename(revisionDirectory).startsWith("chromium-")
  ) {
    revisionDirectory = path.dirname(revisionDirectory);
  }
  if (!path.basename(revisionDirectory).startsWith("chromium-")) {
    throw new Error("无法解析锁定 Chromium 的 revision 目录。");
  }
  return path.join(
    resourcesPath,
    path.basename(revisionDirectory),
    path.relative(revisionDirectory, developmentPath),
  );
}

type BrowserCookie = Parameters<BrowserContext["addCookies"]>[0][number];

function cookieRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cookieString(
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const field = value[name];
  return typeof field === "string" ? field : undefined;
}

function importCookie(value: unknown): BrowserCookie {
  const record = cookieRecord(value);
  const name = record ? cookieString(record, "name") : undefined;
  const cookieValue = record ? cookieString(record, "value") : undefined;
  if (!record || !name || cookieValue === undefined) {
    throw new TypeError("Cookie 必须包含 name 和 value。");
  }
  const url = cookieString(record, "url");
  const domain = cookieString(record, "domain");
  const cookiePath = cookieString(record, "path") ?? "/";
  if (!url && !domain) {
    throw new TypeError("Cookie 必须包含 url 或 domain。");
  }
  const rawSameSite = cookieString(record, "sameSite")?.toLowerCase();
  const sameSite =
    rawSameSite === "strict"
      ? "Strict"
      : rawSameSite === "lax"
        ? "Lax"
        : rawSameSite === "none" || rawSameSite === "no_restriction"
          ? "None"
          : undefined;
  const rawExpires = record["expires"] ?? record["expirationDate"];
  return {
    ...(domain ? { domain } : {}),
    ...(typeof rawExpires === "number" ? { expires: rawExpires } : {}),
    ...(typeof record["httpOnly"] === "boolean"
      ? { httpOnly: record["httpOnly"] }
      : {}),
    name,
    ...(domain ? { path: cookiePath } : {}),
    ...(sameSite ? { sameSite } : {}),
    ...(typeof record["secure"] === "boolean"
      ? { secure: record["secure"] }
      : {}),
    ...(url ? { url } : {}),
    value: cookieValue,
  };
}

export class ManagedBrowser {
  #context: BrowserContext | undefined;
  #activityObserver:
    ((state: ManagedBrowserActivityState) => Promise<void>) | undefined;

  constructor(
    readonly profileDirectory: string,
    private readonly downloadsDirectory: string,
    private readonly executablePath = process.env[
      "CHARAMATE_CHROMIUM_EXECUTABLE_PATH"
    ],
  ) {}

  #queue: Promise<void> = Promise.resolve();

  setActivityObserver(
    observer:
      ((state: ManagedBrowserActivityState) => Promise<void>) | undefined,
  ): void {
    this.#activityObserver = observer;
    for (const page of this.#context?.pages() ?? []) {
      if (observer)
        void page
          .evaluate(installManagedPageActivity, PAGE_ACTIVITY_OPTIONS)
          .catch(() => undefined);
      else void this.#controlPageActivity(page, "stop");
    }
  }

  async status(): Promise<BrowserComputerSettings["browser"]> {
    if (this.#context) return "open";
    try {
      await access(this.#resolvedExecutablePath());
      return "ready";
    } catch {
      return "not_installed";
    }
  }

  async open(): Promise<void> {
    await this.#exclusive(async () => {
      const page = await this.page();
      await page.bringToFront();
    });
  }

  async importCookies(sourcePath: string): Promise<number> {
    return this.#exclusive(async () => {
      const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
      const values = Array.isArray(parsed)
        ? parsed
        : cookieRecord(parsed)?.["cookies"];
      if (!Array.isArray(values)) {
        throw new TypeError("Cookie JSON 必须是数组或包含 cookies 数组。");
      }
      const cookies = values.map(importCookie);
      const context = await this.#getContext();
      await context.addCookies(cookies);
      return cookies.length;
    });
  }

  async close(): Promise<void> {
    const context = this.#context;
    this.#context = undefined;
    await context?.close();
  }

  async page(): Promise<Page> {
    const context = await this.#getContext();
    return context.pages()[0] ?? context.newPage();
  }

  run<T>(signal: AbortSignal, action: (page: Page) => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      signal.throwIfAborted();
      const page = await this.page();
      const abort = () => {
        const context = this.#context;
        this.#context = undefined;
        void context?.close().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        await this.#controlPageActivity(page, "automated", true);
        return await action(page);
      } finally {
        await this.#controlPageActivity(page, "flush");
        await this.#publishActivity(page, { actor: "agent" });
        await this.#controlPageActivity(page, "automated", false);
        signal.removeEventListener("abort", abort);
      }
    };
    return this.#exclusive(execute);
  }

  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action, action);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #getContext(): Promise<BrowserContext> {
    if (this.#context) return this.#context;
    const executablePath = this.#resolvedExecutablePath();
    try {
      await access(executablePath);
    } catch {
      throw new Error(
        "受管 Chromium 尚未安装。请安装与 CharaMate 锁定版本匹配的 Chromium。",
      );
    }
    await mkdir(this.downloadsDirectory, { recursive: true });
    this.#context = await chromium.launchPersistentContext(
      this.profileDirectory,
      {
        acceptDownloads: true,
        downloadsPath: this.downloadsDirectory,
        executablePath,
        headless: false,
      },
    );
    const context = this.#context;
    await context.exposeBinding(
      PAGE_ACTIVITY_OPTIONS.binding,
      async ({ page, frame }, value: unknown) => {
        if (this.#context !== context || frame !== page.mainFrame()) return;
        const rawActor =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)["actor"]
            : undefined;
        const actor =
          rawActor === "agent" || rawActor === "user" ? rawActor : "system";
        await this.#publishActivity(page, {
          ...normalizeActivityPerception(value),
          actor,
        });
      },
    );
    await context.addInitScript(
      installManagedPageActivity,
      PAGE_ACTIVITY_OPTIONS,
    );
    const bindPage = (page: Page) => {
      if (this.#activityObserver)
        void page
          .evaluate(installManagedPageActivity, PAGE_ACTIVITY_OPTIONS)
          .catch(() => undefined);
    };
    for (const page of context.pages()) bindPage(page);
    context.on("page", bindPage);
    context.once("close", () => {
      context.off("page", bindPage);
      if (this.#context === context) this.#context = undefined;
    });
    return this.#context;
  }

  async #controlPageActivity(
    page: Page,
    operation: "automated" | "flush" | "stop",
    value = false,
  ): Promise<void> {
    try {
      await page.evaluate(
        ({ operation, value }) => {
          const state = (window as unknown as Record<string, unknown>)[
            "__charaMateActivity"
          ] as
            | {
                flush(): void;
                stop(): void;
                setAutomated(value: boolean): void;
              }
            | undefined;
          if (operation === "automated") state?.setAutomated(value);
          else state?.[operation]();
        },
        { operation, value },
      );
    } catch {
      /* Navigation and cancellation dispose the observed document. */
    }
  }

  async #publishActivity(
    page: Page,
    perception: ActivityPerception & {
      actor?: "agent" | "system" | "user";
    } = {},
  ): Promise<void> {
    const observer = this.#activityObserver;
    if (!observer || page.isClosed()) return;
    try {
      const title = await page.title();
      const url = page.url();
      if (!url || url === "about:blank") return;
      await observer({
        ...perception,
        ...(title ? { title: redactText(title) } : {}),
        url,
      });
    } catch {
      // Navigation or cancellation may close the page before metadata settles.
    }
  }

  #resolvedExecutablePath(): string {
    return this.executablePath ?? chromium.executablePath();
  }
}

function optionalString(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
}

function requiredString(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
): string {
  const value = optionalString(input, name);
  if (!value?.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function summaryInput(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
  fallback = "",
): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}

function locator(page: Page, input: BrowserLocatorInput): Locator {
  if (input.role) {
    return page.getByRole(input.role as Parameters<Page["getByRole"]>[0], {
      ...(input.name ? { name: input.name } : {}),
    });
  }
  if (input.selector) return page.locator(input.selector);
  if (input.name) return page.getByText(input.name, { exact: true });
  throw new TypeError("Browser action requires role/name or selector");
}

function locatorInput(
  input: Readonly<Record<string, JsonValue>>,
): BrowserLocatorInput {
  const role = optionalString(input, "role");
  const name = optionalString(input, "name");
  const selector = optionalString(input, "selector");
  return {
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
    ...(selector ? { selector } : {}),
  };
}

function objectSchema(
  properties: Record<string, JsonValue>,
  required: string[],
): JsonValue {
  return { additionalProperties: false, properties, required, type: "object" };
}

function result(summary: string, modelContent: JsonValue): ToolResult {
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary,
  };
}

function browserDescriptor(
  value: Omit<ToolDefinition["descriptor"], "namespace" | "source">,
): ToolDefinition["descriptor"] {
  return { ...value, namespace: "browser", source: "builtin" };
}

const locatorProperties = {
  name: {
    description: "Accessible name or exact visible text",
    type: "string",
  },
  role: { description: "ARIA role from the latest snapshot", type: "string" },
  selector: {
    description: "CSS selector only when semantic location is unavailable",
    type: "string",
  },
} satisfies Record<string, JsonValue>;

export function registerBrowserTools(
  registry: ToolRegistry,
  browser: ManagedBrowser,
  artifacts: ArtifactStore,
  resolvePath: (target: string) => string = (target) => path.resolve(target),
): void {
  registry.register({
    descriptor: browserDescriptor({
      description:
        "Navigate the managed browser to a public URL or search-results URL for a read-only web lookup.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({ url: { type: "string" } }, ["url"]),
      itemKind: "tool_call",
      name: "browser.navigate",
      recoveryGroup: "web.open",
      summary: "打开网页",
    }),
    execute: async (input, context) =>
      browser.run(context.signal, async (page) => {
        await page.goto(requiredString(input, "url"), {
          waitUntil: "domcontentloaded",
        });
        const state = { title: await page.title(), url: page.url() };
        return result(`已打开 ${state.title || state.url}`, state);
      }),
    summarize: (input) => `打开网页 ${summaryInput(input, "url")}`,
  });

  registry.register({
    descriptor: browserDescriptor({
      description:
        "Read the current non-empty page through its accessibility tree. Navigate first when no page is open.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({}, []),
      itemKind: "tool_call",
      name: "browser.snapshot",
      recoveryGroup: "web.inspect",
      summary: "读取网页",
    }),
    execute: async (_input, context) => {
      return browser.run(context.signal, async (page) => {
        const url = page.url();
        if (!url || url === "about:blank") {
          throw new Error("当前没有可读取的网页，请先打开目标网址。");
        }
        const snapshot = redactText(await page.locator("body").ariaSnapshot());
        if (!snapshot.trim()) {
          throw new Error("当前网页没有可读取的内容，请重新打开目标网址。");
        }
        const presented = await artifacts.presentText(
          context.runId,
          "browser-accessibility-snapshot.txt",
          snapshot,
        );
        const modelContent = {
          snapshot: presented.displayOutput,
          title: await page.title(),
          url,
        } satisfies JsonValue;
        return {
          ...result("已读取当前网页", modelContent),
          artifacts: [...presented.artifacts],
        };
      });
    },
    summarize: () => "读取当前网页",
  });

  registry.register({
    descriptor: browserDescriptor({
      description:
        "Click an element, preferring its ARIA role and accessible name.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema(locatorProperties, []),
      itemKind: "tool_call",
      name: "browser.click",
      recoveryGroup: "web.act",
      summary: "点击网页元素",
    }),
    execute: async (input, context) =>
      browser.run(context.signal, async (page) => {
        await locator(page, locatorInput(input)).click();
        const state = { title: await page.title(), url: page.url() };
        return result("已点击网页元素", state);
      }),
    summarize: (input) =>
      `点击 ${summaryInput(input, "name", summaryInput(input, "selector", "网页元素"))}`,
  });

  registry.register({
    descriptor: browserDescriptor({
      description: "Fill an editable element using an accessible locator.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: objectSchema(
        { ...locatorProperties, text: { type: "string" } },
        ["text"],
      ),
      itemKind: "tool_call",
      name: "browser.fill",
      recoveryGroup: "web.act",
      summary: "填写网页内容",
    }),
    execute: async (input, context) =>
      browser.run(context.signal, async (page) => {
        await locator(page, locatorInput(input)).fill(
          requiredString(input, "text"),
        );
        return result("已填写网页内容", { url: page.url() });
      }),
    summarize: (input) =>
      `填写 ${summaryInput(input, "name", summaryInput(input, "selector", "网页字段"))}`,
  });

  registry.register({
    descriptor: browserDescriptor({
      description:
        "Upload an explicitly selected local file through a file input.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema(
        { ...locatorProperties, path: { type: "string" } },
        ["path"],
      ),
      itemKind: "tool_call",
      name: "browser.upload",
      summary: "上传文件",
    }),
    execute: async (input, context) =>
      browser.run(context.signal, async (page) => {
        const sourcePath = resolvePath(requiredString(input, "path"));
        await locator(page, locatorInput(input)).setInputFiles(sourcePath);
        return result("已选择上传文件", {
          path: sourcePath,
          url: page.url(),
        });
      }),
    summarize: (input) => `上传 ${summaryInput(input, "path", "文件")}`,
  });

  registry.register({
    descriptor: browserDescriptor({
      description:
        "Capture a screenshot only when visual evidence or coordinate fallback is needed.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({}, []),
      itemKind: "tool_call",
      name: "browser.screenshot",
      recoveryGroup: "web.inspect",
      summary: "截取网页画面",
    }),
    execute: async (_input, context) => {
      return browser.run(context.signal, async (page) => {
        const screenshot = await page.screenshot({ type: "png" });
        const artifact = await artifacts.storeBuffer(
          context.runId,
          "browser-screenshot.png",
          screenshot,
          "image/png",
          "image",
        );
        return {
          ...result("已截取网页画面", {
            artifactId: artifact.artifactId,
            url: page.url(),
          }),
          artifacts: [artifact],
        };
      });
    },
    summarize: () => "截取当前网页",
  });

  registry.register({
    descriptor: browserDescriptor({
      description:
        "Download a file by clicking a semantically located element and preserve it as a Chat artifact.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema(locatorProperties, []),
      itemKind: "tool_call",
      name: "browser.download",
      summary: "下载文件",
    }),
    execute: async (input, context) =>
      browser.run(context.signal, async (page) => {
        const downloadPromise = page.waitForEvent("download");
        await locator(page, locatorInput(input)).click();
        const download = await downloadPromise;
        const destination = await download.path();
        const failure = await download.failure();
        if (failure || !destination) {
          throw new Error(failure ?? "浏览器没有提供下载文件路径。");
        }
        const displayName = download.suggestedFilename();
        const artifact = await artifacts.storeFile(
          context.runId,
          displayName,
          destination,
        );
        return {
          ...result(`已下载 ${displayName}`, {
            artifactId: artifact.artifactId,
            displayName,
            url: page.url(),
          }),
          artifacts: [artifact],
        };
      }),
    summarize: (input) =>
      `下载 ${summaryInput(input, "name", summaryInput(input, "selector", "网页文件"))}`,
  });
}
