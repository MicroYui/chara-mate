import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
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
  "macos-active-application-observer.mm",
);
const output = path.join(
  nativeHelpersDirectory,
  "active-application-observer.node",
);
const legacyOutput = path.join(
  nativeHelpersDirectory,
  "active-application-observer",
);

function runFile(command, arguments_) {
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function electronVersion() {
  const packageJson = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "node_modules", "electron", "package.json"),
      "utf8",
    ),
  );
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("Unable to resolve the installed Electron version.");
  }
  return packageJson.version;
}

function headerCandidates(version) {
  const configured = process.env["npm_config_nodedir"]?.trim();
  return [
    ...(configured
      ? [configured, path.join(configured, "include", "node")]
      : []),
    path.join(os.homedir(), ".electron-gyp", version, "include", "node"),
  ];
}

async function resolveElectronHeaders(version) {
  for (const candidate of headerCandidates(version)) {
    if (await exists(path.join(candidate, "node_api.h"))) return candidate;
  }

  const nodeGyp = path.join(
    repositoryRoot,
    "node_modules",
    "@electron",
    "node-gyp",
    "bin",
    "node-gyp.js",
  );
  if (!(await exists(nodeGyp))) {
    throw new Error(
      `Electron ${version} headers are missing and @electron/node-gyp is unavailable.`,
    );
  }
  await runFile(process.execPath, [
    nodeGyp,
    "install",
    `--target=${version}`,
    "--dist-url=https://www.electronjs.org/headers",
    `--devdir=${path.join(os.homedir(), ".electron-gyp")}`,
    "--ensure",
  ]);
  for (const candidate of headerCandidates(version)) {
    if (await exists(path.join(candidate, "node_api.h"))) return candidate;
  }
  throw new Error(`Unable to install Electron ${version} headers.`);
}

async function compileFor(architecture, target, headers) {
  await runFile("/usr/bin/xcrun", [
    "clang++",
    "-fobjc-arc",
    "-std=c++17",
    "-mmacosx-version-min=13.0",
    "-O2",
    "-Wall",
    "-Wextra",
    "-arch",
    architecture,
    "-I",
    headers,
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    source,
    path.join(path.dirname(source), "macos-visual-source.mm"),
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "Vision",
    "-framework",
    "CoreMedia",
    "-framework",
    "CoreImage",
    "-framework",
    "ImageIO",
    "-o",
    target,
  ]);
}

async function main() {
  const platform = process.argv[2] ?? process.platform;
  const architecture = process.argv[3] ?? process.arch;
  if (platform !== "darwin") return;

  const version = await electronVersion();
  const headers = await resolveElectronHeaders(version);
  await mkdir(nativeHelpersDirectory, { recursive: true });
  await rm(legacyOutput, { force: true });
  if (architecture === "universal") {
    const arm64Output = `${output}.arm64`;
    const x64Output = `${output}.x64`;
    try {
      await Promise.all([
        compileFor("arm64", arm64Output, headers),
        compileFor("x64", x64Output, headers),
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
    await compileFor(architecture, output, headers);
  } else {
    throw new Error(
      `Unsupported macOS architecture for Activity observer: ${architecture}`,
    );
  }
}

await main();
