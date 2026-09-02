#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mainRoot = path.resolve(import.meta.dirname, "..");
const relayRoot = path.resolve(
  process.env.CHARAMATE_RELAY_REPO ??
    path.join(mainRoot, "../chara-mate-relay"),
);
const androidRoot = path.resolve(
  process.env.CHARAMATE_ANDROID_REPO ??
    path.join(mainRoot, "../chara-mate-android"),
);
const composeFile = path.join(relayRoot, "compose.local.yaml");
const stateDirectory = path.join(relayRoot, ".local-stack");
const certificateDirectory = path.join(stateDirectory, "certs");
const certificateAuthorityPath = path.join(certificateDirectory, "ca.crt");
const emulatorStatePath = path.join(stateDirectory, "emulator.json");
const emulatorLogPath = path.join(stateDirectory, "emulator.log");
const avdName = process.env.CHARAMATE_ANDROID_AVD ?? "charamate_api36";
const relayHttpOrigin = "http://127.0.0.1:8787";
const relayHttpsOrigin = "https://127.0.0.1:8443";
const bootTimeoutMs = Number(
  process.env.CHARAMATE_ANDROID_BOOT_TIMEOUT_MS ?? "180000",
);
const relayImage = "chara-mate-relay:local";

function fail(message) {
  throw new Error(message);
}

function command(
  executable,
  args,
  { allowFailure = false, capture = false, cwd = mainRoot, env } = {},
) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? result.stderr.trim() : "";
    fail(
      `${executable} ${args.join(" ")} failed with exit ${String(result.status)}${detail ? `: ${detail}` : ""}`,
    );
  }
  return {
    status: result.status ?? 1,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) fail(`${label} not found: ${file}`);
}

function readProperties(file) {
  if (!fs.existsSync(file)) return new Map();
  const properties = new Map();
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  return properties;
}

function sdkTools() {
  const localProperties = readProperties(
    path.join(androidRoot, "local.properties"),
  );
  const sdkRoot = path.resolve(
    process.env.ANDROID_SDK_ROOT ??
      process.env.ANDROID_HOME ??
      localProperties.get("sdk.dir") ??
      "/opt/homebrew/share/android-commandlinetools",
  );
  const adb = path.join(sdkRoot, "platform-tools", "adb");
  const emulator = path.join(sdkRoot, "emulator", "emulator");
  requireFile(adb, "adb");
  requireFile(emulator, "Android emulator");
  return { adb, emulator };
}

function javaEnvironment() {
  if (process.env.JAVA_HOME) return {};
  const homebrewJdk =
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
  return fs.existsSync(homebrewJdk) ? { JAVA_HOME: homebrewJdk } : {};
}

function compose(args, options = {}) {
  return command("docker", ["compose", "--file", composeFile, ...args], {
    cwd: relayRoot,
    ...options,
  });
}

function buildRelayImage() {
  console.log(`Building ${relayImage} from the official npm registry...`);
  compose(["build", "relay"]);
}

function ensureRelayImage() {
  const image = command("docker", ["image", "inspect", relayImage], {
    allowFailure: true,
    capture: true,
  });
  if (image.status !== 0) buildRelayImage();
}

function ensureCertificates() {
  const serverCertificatePath = path.join(certificateDirectory, "server.crt");
  const serverKeyPath = path.join(certificateDirectory, "server.key");
  if (
    fs.existsSync(certificateAuthorityPath) &&
    fs.existsSync(serverCertificatePath) &&
    fs.existsSync(serverKeyPath)
  ) {
    return;
  }

  fs.mkdirSync(certificateDirectory, { recursive: true });
  const caKeyPath = path.join(certificateDirectory, "ca.key");
  const signingRequestPath = path.join(certificateDirectory, "server.csr");
  const extensionPath = path.join(certificateDirectory, "server.ext");
  fs.writeFileSync(
    extensionPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=@alt_names",
      "[alt_names]",
      "DNS.1=localhost",
      "IP.1=127.0.0.1",
      "",
    ].join("\n"),
  );

  console.log("Generating local-only Relay TLS certificates...");
  command("openssl", ["genrsa", "-out", caKeyPath, "2048"]);
  command("openssl", [
    "req",
    "-x509",
    "-new",
    "-sha256",
    "-key",
    caKeyPath,
    "-days",
    "3650",
    "-subj",
    "/CN=CharaMate Local Relay CA",
    "-out",
    certificateAuthorityPath,
  ]);
  command("openssl", ["genrsa", "-out", serverKeyPath, "2048"]);
  command("openssl", [
    "req",
    "-new",
    "-key",
    serverKeyPath,
    "-subj",
    "/CN=localhost",
    "-out",
    signingRequestPath,
  ]);
  command("openssl", [
    "x509",
    "-req",
    "-in",
    signingRequestPath,
    "-CA",
    certificateAuthorityPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    serverCertificatePath,
    "-days",
    "825",
    "-sha256",
    "-extfile",
    extensionPath,
  ]);
  fs.chmodSync(caKeyPath, 0o600);
  fs.chmodSync(serverKeyPath, 0o600);
  for (const generatedTemporaryPath of [
    extensionPath,
    signingRequestPath,
    path.join(certificateDirectory, "ca.srl"),
  ]) {
    fs.rmSync(generatedTemporaryPath, { force: true });
  }
}

function connectedEmulators(adb) {
  return command(adb, ["devices"], { capture: true })
    .stdout.split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0])
    .filter((serial) => serial?.startsWith("emulator-"));
}

function emulatorAvdName(adb, serial) {
  const result = command(adb, ["-s", serial, "emu", "avd", "name"], {
    allowFailure: true,
    capture: true,
  });
  return result.stdout.split(/\r?\n/u)[0]?.trim();
}

function findMatchingEmulator(adb) {
  return connectedEmulators(adb).find(
    (serial) => emulatorAvdName(adb, serial) === avdName,
  );
}

async function waitUntil(description, test) {
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`${description} did not complete within ${String(bootTimeoutMs)} ms.`);
}

async function ensureEmulator() {
  const { adb, emulator } = sdkTools();
  let serial = findMatchingEmulator(adb);
  let startedByScript = false;

  if (!serial) {
    const availableAvds = command(emulator, ["-list-avds"], {
      capture: true,
    }).stdout.split(/\r?\n/u);
    if (!availableAvds.includes(avdName)) {
      fail(`Android AVD ${avdName} does not exist.`);
    }
    fs.mkdirSync(stateDirectory, { recursive: true });
    const logDescriptor = fs.openSync(emulatorLogPath, "a");
    const processHandle = spawn(emulator, ["-avd", avdName, "-no-boot-anim"], {
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    processHandle.unref();
    fs.closeSync(logDescriptor);
    startedByScript = true;
    console.log(`Starting host Android AVD ${avdName}...`);
    await waitUntil("Android emulator discovery", () => {
      serial = findMatchingEmulator(adb);
      return Boolean(serial);
    });
  }

  if (!serial) fail("Android emulator serial could not be resolved.");
  await waitUntil("Android boot", () => {
    const result = command(
      adb,
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      { allowFailure: true, capture: true },
    );
    return result.status === 0 && result.stdout === "1";
  });

  if (startedByScript) {
    fs.writeFileSync(
      emulatorStatePath,
      `${JSON.stringify({ avdName, serial, startedByScript }, null, 2)}\n`,
    );
  }
  return { adb, serial };
}

function buildAndInstallAndroid(adb, serial) {
  const debugOrigin = readProperties(
    path.join(androidRoot, "local.properties"),
  ).get("companion.debugRelayOrigin");
  if (debugOrigin !== relayHttpOrigin) {
    fail(
      `Android local.properties must contain companion.debugRelayOrigin=${relayHttpOrigin}.`,
    );
  }
  console.log("Building and installing the Android Companion...");
  command(path.join(androidRoot, "gradlew"), ["assembleDebug"], {
    cwd: androidRoot,
    env: javaEnvironment(),
  });
  const apkPath = path.join(
    androidRoot,
    "app/build/outputs/apk/debug/app-debug.apk",
  );
  requireFile(apkPath, "Android debug APK");
  command(adb, ["-s", serial, "reverse", "tcp:8787", "tcp:8787"]);
  command(adb, ["-s", serial, "install", "-r", "-t", apkPath]);
  command(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    "com.charamate.companion/.MainActivity",
  ]);
}

function checkRelayHealth() {
  command("curl", ["--fail", "--silent", `${relayHttpOrigin}/healthz`]);
  command("curl", [
    "--fail",
    "--silent",
    "--cacert",
    certificateAuthorityPath,
    `${relayHttpsOrigin}/healthz`,
  ]);
}

async function up() {
  requireFile(composeFile, "Relay Compose file");
  requireFile(path.join(androidRoot, "gradlew"), "Android Gradle wrapper");
  command("docker", ["info"], { capture: true });
  ensureCertificates();
  ensureRelayImage();
  console.log("Starting Docker Relay and local HTTPS proxy...");
  compose(["up", "--detach", "--wait"]);
  checkRelayHealth();
  const { adb, serial } = await ensureEmulator();
  buildAndInstallAndroid(adb, serial);
  console.log("\nCharaMate local companion stack is ready.");
  console.log(`Android: ${serial} (${avdName})`);
  console.log(`Relay HTTP for adb reverse: ${relayHttpOrigin}`);
  console.log(`Relay HTTPS for Desktop: ${relayHttpsOrigin}`);
  console.log(`Desktop CA: ${certificateAuthorityPath}`);
}

function desktop() {
  checkRelayHealth();
  command("npm", ["start"], {
    cwd: mainRoot,
    env: {
      CHARAMATE_COMPANION_RELAY_ORIGIN: relayHttpsOrigin,
      NODE_EXTRA_CA_CERTS: certificateAuthorityPath,
    },
  });
}

function down(stopEmulator) {
  compose(["down"], { allowFailure: true });
  if (!stopEmulator || !fs.existsSync(emulatorStatePath)) return;
  const { adb } = sdkTools();
  const state = JSON.parse(fs.readFileSync(emulatorStatePath, "utf8"));
  if (
    state.startedByScript === true &&
    typeof state.serial === "string" &&
    emulatorAvdName(adb, state.serial) === state.avdName
  ) {
    command(adb, ["-s", state.serial, "emu", "kill"], {
      allowFailure: true,
    });
  }
  fs.rmSync(emulatorStatePath, { force: true });
}

function status() {
  compose(["ps"], { allowFailure: true });
  const health = command(
    "curl",
    ["--fail", "--silent", `${relayHttpOrigin}/healthz`],
    { allowFailure: true, capture: true },
  );
  console.log(
    health.status === 0
      ? `Relay health: ${health.stdout}`
      : "Relay health: unavailable",
  );
  const { adb } = sdkTools();
  const devices = connectedEmulators(adb);
  console.log(
    devices.length > 0
      ? `Android emulators: ${devices.join(", ")}`
      : "Android emulators: none",
  );
}

async function main() {
  const action = process.argv[2] ?? "up";
  switch (action) {
    case "up":
      await up();
      break;
    case "build":
      command("docker", ["info"], { capture: true });
      buildRelayImage();
      break;
    case "demo":
      await up();
      desktop();
      break;
    case "status":
      status();
      break;
    case "logs":
      compose(["logs", "--follow", "relay", "tls-proxy"]);
      break;
    case "down":
      down(false);
      break;
    case "down-all":
      down(true);
      break;
    default:
      fail(`Unknown action: ${action}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
