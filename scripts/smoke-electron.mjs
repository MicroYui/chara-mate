import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const mode = process.argv[2];

if (mode !== "dev" && mode !== "packaged") {
  throw new Error("Expected smoke mode: dev or packaged");
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedPrefix = "CHARAMATE_SMOKE_RESULT ";
const fatalOutputMarkers = [
  "UnhandledPromiseRejectionWarning",
  "Uncaught Exception:",
  "CHARAMATE_PRELOAD_ERROR",
  "CHARAMATE_LOAD_ERROR",
  "CHARAMATE_CHARACTER_PRELOAD_ERROR",
  "CHARAMATE_CHARACTER_LOAD_ERROR",
  "violates the following Content Security Policy directive",
];

function forceTerminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return true;
      }
    }
  }

  return child.kill("SIGKILL");
}

const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), `chara-mate-${mode}-`),
);

let result;
try {
  let executable = path.join(projectRoot, "node_modules/.bin/electron-forge");

  if (mode === "packaged") {
    const packagedApplication = path.join(
      projectRoot,
      "out/CharaMate-darwin-arm64/CharaMate.app",
    );
    const isolatedApplication = path.join(userDataDirectory, "CharaMate.app");
    await cp(packagedApplication, isolatedApplication, {
      recursive: true,
      verbatimSymlinks: true,
    });
    executable = path.join(isolatedApplication, "Contents/MacOS/CharaMate");
  }

  const args = mode === "dev" ? ["start"] : [];
  result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CHARAMATE_SMOKE_TEST: "1",
        CHARAMATE_SMOKE_KIND: mode,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
        ELECTRON_ENABLE_LOGGING: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timeoutError;

    const timeout = setTimeout(() => {
      timeoutError = new Error(`${mode} smoke timed out.\n${output}`);
      if (!forceTerminateProcessTree(child)) {
        reject(
          new Error(
            `${mode} smoke timed out and could not be terminated.\n${output}`,
          ),
        );
      }
    }, 120_000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timeoutError) {
        reject(timeoutError);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${mode} smoke exited with code ${String(code)} and signal ${String(signal)}.\n${output}`,
          ),
        );
        return;
      }

      const resultLine = output
        .split(/\r?\n/u)
        .find((line) => line.startsWith(expectedPrefix));
      if (!resultLine) {
        reject(new Error(`${mode} smoke did not report a result.\n${output}`));
        return;
      }

      const fatalMarker = fatalOutputMarkers.find((marker) =>
        output.includes(marker),
      );
      if (fatalMarker) {
        reject(
          new Error(
            `${mode} smoke reported fatal output (${fatalMarker}).\n${output}`,
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(resultLine.slice(expectedPrefix.length)));
      } catch (error) {
        reject(error);
      }
    });
  });
} finally {
  await rm(userDataDirectory, { force: true, recursive: true });
}

if (
  typeof result !== "object" ||
  result === null ||
  result.browserRoundTrip !== true ||
  result.characterRendererReady !== true ||
  result.databaseRoundTrip !== true ||
  !Array.isArray(result.petIds) ||
  !result.petIds.includes("columbinya") ||
  !result.petIds.includes("linnea") ||
  !Array.isArray(result.providerProfileNames) ||
  !result.providerProfileNames.includes("copilot_api") ||
  !result.providerProfileNames.includes("azure") ||
  result.rendererReady !== true ||
  result.mode !== mode
) {
  throw new Error(`Invalid ${mode} smoke result: ${JSON.stringify(result)}`);
}
