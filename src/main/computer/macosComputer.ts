import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolResult } from "../../shared/contracts/tool";
import type { ArtifactStore } from "../tools/artifactStore";
import { runProcess } from "../tools/processRunner";
import type { ToolDefinition, ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";

const SNAPSHOT_SCRIPT = String.raw`
on run argv
  tell application "System Events"
    set frontProcesses to every application process whose frontmost is true
    if (count of frontProcesses) is 0 then error "No frontmost application"
    set targetProcess to item 1 of frontProcesses
    set outputLines to {"application: " & (name of targetProcess)}
    repeat with targetWindow in windows of targetProcess
      set end of outputLines to "window: " & (name of targetWindow)
      try
        set candidates to entire contents of targetWindow
        repeat with candidate in candidates
          set candidateRole to ""
          set candidateName to ""
          set candidateDescription to ""
          try
            set candidateRole to role of candidate
          end try
          try
            set candidateName to name of candidate
          end try
          try
            set candidateDescription to description of candidate
          end try
          if candidateName is not "" or candidateDescription is not "" then
            set end of outputLines to candidateRole & " | " & candidateName & " | " & candidateDescription
          end if
        end repeat
      end try
    end repeat
    set AppleScript's text item delimiters to linefeed
    return outputLines as text
  end tell
end run`;

const PRESS_ELEMENT_SCRIPT = String.raw`
on run argv
  set targetName to item 1 of argv
  set targetRole to ""
  if (count of argv) is greater than 1 then set targetRole to item 2 of argv
  tell application "System Events"
    set targetProcess to item 1 of (every application process whose frontmost is true)
    repeat with targetWindow in windows of targetProcess
      repeat with candidate in (entire contents of targetWindow)
        set candidateName to ""
        set candidateDescription to ""
        set candidateRole to ""
        try
          set candidateName to name of candidate
        end try
        try
          set candidateDescription to description of candidate
        end try
        try
          set candidateRole to role of candidate
        end try
        if (candidateName is targetName or candidateDescription is targetName) and (targetRole is "" or candidateRole is targetRole) then
          perform action "AXPress" of candidate
          return "pressed"
        end if
      end repeat
    end repeat
  end tell
  error "Accessibility element not found"
end run`;

const TYPE_TEXT_SCRIPT = String.raw`
on run argv
  tell application "System Events" to keystroke (item 1 of argv)
  return "typed"
end run`;

const PRESS_KEY_SCRIPT = String.raw`
on run argv
  tell application "System Events" to key code (item 1 of argv as integer)
  return "pressed"
end run`;

const CLICK_COORDINATES_SCRIPT = String.raw`
on run argv
  set pointX to item 1 of argv as integer
  set pointY to item 2 of argv as integer
  tell application "System Events" to click at {pointX, pointY}
  return "clicked"
end run`;

export interface CapturedScreen {
  readonly bytes: Buffer;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly width: number;
}

export interface ScreenCaptureOptions {
  readonly resolution?: "device" | "logical";
}

export interface ScreenCapture {
  capturePrimaryDisplay(
    options?: ScreenCaptureOptions,
  ): Promise<CapturedScreen>;
}

export interface ComputerAdapter {
  clickCoordinates(x: number, y: number, signal: AbortSignal): Promise<void>;
  focusApplication(name: string, signal: AbortSignal): Promise<void>;
  pressElement(
    name: string,
    role: string | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  pressKey(keyCode: number, signal: AbortSignal): Promise<void>;
  snapshot(signal: AbortSignal): Promise<string>;
  typeText(text: string, signal: AbortSignal): Promise<void>;
}

export class MacOsComputerAdapter implements ComputerAdapter {
  #queue: Promise<void> = Promise.resolve();

  clickCoordinates(x: number, y: number, signal: AbortSignal): Promise<void> {
    return this.#runScript(
      CLICK_COORDINATES_SCRIPT,
      [String(x), String(y)],
      signal,
    ).then(() => undefined);
  }

  async focusApplication(name: string, signal: AbortSignal): Promise<void> {
    await this.#exclusive(async () => {
      const launched = await runProcess(
        { args: ["-a", name], command: "/usr/bin/open" },
        signal,
        () => undefined,
      );
      if (launched.exitCode !== 0) {
        throw new Error(launched.stderr || `Unable to open ${name}`);
      }
      await this.#runScriptUnqueued(
        'on run argv\ntell application "System Events" to set frontmost of first application process whose name is item 1 of argv to true\nreturn "focused"\nend run',
        [name],
        signal,
      );
    });
  }

  pressElement(
    name: string,
    role: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runScript(
      PRESS_ELEMENT_SCRIPT,
      role ? [name, role] : [name],
      signal,
    ).then(() => undefined);
  }

  pressKey(keyCode: number, signal: AbortSignal): Promise<void> {
    return this.#runScript(PRESS_KEY_SCRIPT, [String(keyCode)], signal).then(
      () => undefined,
    );
  }

  snapshot(signal: AbortSignal): Promise<string> {
    return this.#runScript(SNAPSHOT_SCRIPT, [], signal);
  }

  typeText(text: string, signal: AbortSignal): Promise<void> {
    return this.#runScript(TYPE_TEXT_SCRIPT, [text], signal).then(
      () => undefined,
    );
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task, task);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #runScript(
    script: string,
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.#exclusive(() =>
      this.#runScriptUnqueued(script, arguments_, signal),
    );
  }

  async #runScriptUnqueued(
    script: string,
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    if (process.platform !== "darwin") {
      throw new Error("Computer Use 的 macOS Adapter 只在 macOS 可用。");
    }
    const result = await runProcess(
      {
        args: ["-e", script, "--", ...arguments_],
        command: "/usr/bin/osascript",
      },
      signal,
      () => undefined,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || "macOS Accessibility 操作没有完成。",
      );
    }
    return result.stdout.trim();
  }
}

function objectSchema(
  properties: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
): JsonValue {
  return {
    additionalProperties: false,
    properties,
    required: [...required],
    type: "object",
  };
}

function stringInput(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function numberInput(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
): number {
  const value = input[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
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

function computerDescriptor(
  value: Omit<ToolDefinition["descriptor"], "namespace" | "source">,
): ToolDefinition["descriptor"] {
  return { ...value, namespace: "computer", source: "builtin" };
}

export function registerComputerTools(
  registry: ToolRegistry,
  computer: ComputerAdapter,
  capture: ScreenCapture,
  artifacts: ArtifactStore,
): void {
  registry.register({
    descriptor: computerDescriptor({
      description:
        "Focus or launch a macOS application by name before using Accessibility actions.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: objectSchema({ name: { type: "string" } }, ["name"]),
      itemKind: "tool_call",
      name: "computer.focus_app",
      recoveryGroup: "desktop.focus",
      summary: "聚焦应用",
    }),
    execute: async (input, context) => {
      const name = stringInput(input, "name");
      await computer.focusApplication(name, context.signal);
      return result(`已聚焦 ${name}`, { application: name });
    },
    summarize: (input) =>
      `聚焦 ${typeof input["name"] === "string" ? input["name"] : "应用"}`,
  });

  registry.register({
    descriptor: computerDescriptor({
      description:
        "Read the frontmost macOS application's Accessibility tree before acting.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({}, []),
      itemKind: "tool_call",
      name: "computer.snapshot",
      recoveryGroup: "desktop.inspect",
      summary: "读取应用界面",
    }),
    execute: async (_input, context) => {
      const snapshot = await computer.snapshot(context.signal);
      const presented = await artifacts.presentText(
        context.runId,
        "computer-accessibility-snapshot.txt",
        snapshot,
      );
      return {
        ...result("已读取当前应用界面", {
          snapshot: presented.displayOutput,
        }),
        artifacts: [...presented.artifacts],
      };
    },
    summarize: () => "读取当前应用界面",
  });

  registry.register({
    descriptor: computerDescriptor({
      description:
        "Press a semantic Accessibility element by name and optional AX role. Prefer this over coordinates.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema(
        { name: { type: "string" }, role: { type: "string" } },
        ["name"],
      ),
      itemKind: "tool_call",
      name: "computer.press_element",
      recoveryGroup: "desktop.act",
      summary: "操作界面元素",
    }),
    execute: async (input, context) => {
      const name = stringInput(input, "name");
      await computer.pressElement(
        name,
        optionalString(input, "role"),
        context.signal,
      );
      return result(`已操作 ${name}`, { name });
    },
    summarize: (input) =>
      `操作 ${typeof input["name"] === "string" ? input["name"] : "界面元素"}`,
  });

  registry.register({
    descriptor: computerDescriptor({
      description: "Type text into the currently focused control.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema({ text: { type: "string" } }, ["text"]),
      itemKind: "tool_call",
      name: "computer.type_text",
      recoveryGroup: "desktop.act",
      summary: "输入文字",
    }),
    execute: async (input, context) => {
      const text = stringInput(input, "text");
      await computer.typeText(text, context.signal);
      return result("已输入文字", { characterCount: [...text].length });
    },
    summarize: () => "在当前控件输入文字",
  });

  registry.register({
    descriptor: computerDescriptor({
      description:
        "Press a macOS virtual key code in the currently focused application.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema({ keyCode: { minimum: 0, type: "integer" } }, [
        "keyCode",
      ]),
      itemKind: "tool_call",
      name: "computer.press_key",
      recoveryGroup: "desktop.act",
      summary: "按下按键",
    }),
    execute: async (input, context) => {
      const keyCode = numberInput(input, "keyCode");
      await computer.pressKey(keyCode, context.signal);
      return result("已按下按键", { keyCode });
    },
    summarize: (input) =>
      `按键 ${typeof input["keyCode"] === "number" ? String(input["keyCode"]) : ""}`,
  });

  registry.register({
    descriptor: computerDescriptor({
      description:
        "Capture the primary display only when Accessibility is insufficient or visual evidence is needed.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({}, []),
      itemKind: "tool_call",
      name: "computer.screenshot",
      recoveryGroup: "desktop.inspect",
      summary: "截取屏幕",
    }),
    execute: async (_input, context) => {
      context.signal.throwIfAborted();
      const image = await capture.capturePrimaryDisplay();
      context.signal.throwIfAborted();
      const artifact = await artifacts.storeBuffer(
        context.runId,
        "computer-screenshot.png",
        image.bytes,
        image.mediaType,
        "image",
      );
      return {
        ...result("已截取屏幕", { artifactId: artifact.artifactId }),
        artifacts: [artifact],
      };
    },
    summarize: () => "截取当前屏幕",
  });

  registry.register({
    descriptor: computerDescriptor({
      description:
        "Click screen coordinates only after an Accessibility snapshot was insufficient and a screenshot supplied the exact point.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema(
        { x: { type: "integer" }, y: { type: "integer" } },
        ["x", "y"],
      ),
      itemKind: "tool_call",
      name: "computer.click_coordinates",
      recoveryGroup: "desktop.act",
      summary: "按坐标点击",
    }),
    execute: async (input, context) => {
      const x = numberInput(input, "x");
      const y = numberInput(input, "y");
      await computer.clickCoordinates(x, y, context.signal);
      return result("已按坐标点击", { x, y });
    },
    summarize: (input) =>
      `点击 (${typeof input["x"] === "number" ? String(input["x"]) : "?"}, ${typeof input["y"] === "number" ? String(input["y"]) : "?"})`,
  });
}
