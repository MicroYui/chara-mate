import { redactText } from "../../shared/pure/redaction";
import { runProcess } from "../tools/processRunner";

const ACTIVE_APPLICATION_SCRIPT = String.raw`
on run
  tell application "System Events"
    set frontProcesses to every application process whose frontmost is true
    if (count of frontProcesses) is 0 then return ""
    set targetProcess to item 1 of frontProcesses
    set applicationName to name of targetProcess
    set applicationId to ""
    set windowName to ""
    try
      set applicationId to bundle identifier of targetProcess
    end try
    try
      set windowName to name of front window of targetProcess
    end try
    return applicationName & linefeed & applicationId & linefeed & windowName
  end tell
end run`;

export interface ActiveApplication {
  readonly appId?: string;
  readonly appName: string;
  readonly windowTitle?: string;
}

export interface ActiveApplicationProbe {
  read(signal: AbortSignal): Promise<ActiveApplication | undefined>;
}

export class MacOsActiveApplicationProbe implements ActiveApplicationProbe {
  async read(signal: AbortSignal): Promise<ActiveApplication | undefined> {
    if (process.platform !== "darwin") return undefined;
    const result = await runProcess(
      {
        args: ["-e", ACTIVE_APPLICATION_SCRIPT],
        command: "/usr/bin/osascript",
      },
      signal,
      () => undefined,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "无法读取当前前台应用。");
    }
    const [rawName, rawId, ...rawTitle] = result.stdout.trimEnd().split("\n");
    const appName = rawName?.trim();
    if (!appName) return undefined;
    const appId = rawId?.trim();
    const windowTitle = rawTitle.join("\n").trim();
    return {
      ...(appId ? { appId: redactText(appId) } : {}),
      appName: redactText(appName),
      ...(windowTitle ? { windowTitle: redactText(windowTitle) } : {}),
    };
  }
}
