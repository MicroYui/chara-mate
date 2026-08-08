import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProcessRequest {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

export function runProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const usesProcessGroup = process.platform !== "win32";
    const child = spawn(request.command, [...request.args], {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      detached: usesProcessGroup,
      env: request.env ? { ...process.env, ...request.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const kill = (killSignal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (usesProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, killSignal);
        } else {
          child.kill(killSignal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };

    const abort = () => {
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => kill("SIGKILL"), 1_000);
      forceKillTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onDelta(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      onDelta(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Operation was aborted", "AbortError"),
        );
        return;
      }
      resolve({ exitCode, signal: closeSignal, stderr, stdout });
    });
    if (request.input !== undefined) child.stdin.end(request.input);
    else child.stdin.end();
  });
}
