import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const nativeHelpersDirectory = path.join(
  repositoryRoot,
  "resources",
  "generated",
  "native-helpers",
);
const source = path.join(
  repositoryRoot,
  "src",
  "main",
  "activity",
  "native",
  "macos-active-application-observer.m",
);
const output = path.join(nativeHelpersDirectory, "active-application-observer");

function runFile(command, arguments_) {
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function compileFor(architecture, target) {
  await runFile("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-arch",
    architecture,
    source,
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-o",
    target,
  ]);
}

async function main() {
  const platform = process.argv[2] ?? process.platform;
  const architecture = process.argv[3] ?? process.arch;
  if (platform !== "darwin") return;

  await mkdir(nativeHelpersDirectory, { recursive: true });
  if (architecture === "universal") {
    const arm64Output = `${output}.arm64`;
    const x64Output = `${output}.x64`;
    try {
      await Promise.all([
        compileFor("arm64", arm64Output),
        compileFor("x64", x64Output),
      ]);
      await runFile("/usr/bin/lipo", [
        "-create",
        arm64Output,
        x64Output,
        "-output",
        output,
      ]);
    } finally {
      await Promise.all([
        rm(arm64Output, { force: true }),
        rm(x64Output, { force: true }),
      ]);
    }
  } else if (architecture === "arm64" || architecture === "x64") {
    await compileFor(architecture, output);
  } else {
    throw new Error(
      `Unsupported macOS architecture for Activity helper: ${architecture}`,
    );
  }
  await chmod(output, 0o755);
}

await main();
