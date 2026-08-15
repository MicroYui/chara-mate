import { spawn, type ChildProcess } from "node:child_process";

import { redactText } from "../../shared/pure/redaction";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 1_000;

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

interface NativeActiveApplication {
  readonly appId?: unknown;
  readonly appName?: unknown;
  readonly windowTitle?: unknown;
}

export function parseActiveApplicationEvent(
  line: string,
): ActiveApplication | undefined {
  let value: NativeActiveApplication;
  try {
    value = JSON.parse(line) as NativeActiveApplication;
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.appName !== "string" ||
    value.appName.trim().length === 0
  ) {
    return undefined;
  }
  const appId =
    typeof value.appId === "string" ? value.appId.trim() : undefined;
  const windowTitle =
    typeof value.windowTitle === "string"
      ? value.windowTitle.trim()
      : undefined;
  return {
    ...(appId ? { appId: redactText(appId) } : {}),
    appName: redactText(value.appName.trim()),
    ...(windowTitle ? { windowTitle: redactText(windowTitle) } : {}),
  };
}

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TERMINATION_GRACE_MS);
    timer.unref?.();
    child.once("close", finish);
    child.once("error", finish);
    if (!child.kill("SIGTERM")) finish();
  });
}

export class MacOsActiveApplicationSource implements ActiveApplicationSource {
  constructor(private readonly executablePath: string) {}

  subscribe(
    listener: (application: ActiveApplication) => void,
    onError: (error: unknown) => void,
  ): () => Promise<void> {
    if (process.platform !== "darwin") return () => Promise.resolve();

    const child = spawn(this.executablePath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let stopping = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) {
        buffer = "";
        onError(new Error("前台应用事件超过允许长度。"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const application = parseActiveApplicationEvent(line);
          if (application) listener(application);
          else onError(new Error("前台应用事件格式无效。"));
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      if (!stopping) onError(error);
    });
    child.on("close", (code, signal) => {
      if (stopping) return;
      onError(
        new Error(
          stderr.trim() ||
            `前台应用事件源意外退出（${signal ?? String(code)}）。`,
        ),
      );
    });

    return async () => {
      stopping = true;
      await terminate(child);
    };
  }
}
