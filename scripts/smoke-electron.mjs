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
const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), `chara-mate-${mode}-`),
);

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
const expectedPrefix = "CHARAMATE_SMOKE_RESULT ";

let result;
try {
  result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
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

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${mode} smoke timed out.\n${output}`));
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
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
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

      resolve(JSON.parse(resultLine.slice(expectedPrefix.length)));
    });
  });
} finally {
  await rm(userDataDirectory, { force: true, recursive: true });
}

if (
  typeof result !== "object" ||
  result === null ||
  result.databaseRoundTrip !== true ||
  result.rendererReady !== true ||
  result.mode !== mode
) {
  throw new Error(`Invalid ${mode} smoke result: ${JSON.stringify(result)}`);
}
