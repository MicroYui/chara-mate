import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { execFile, type ExecFileException } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

type DmgDetachCallback = (error: ExecFileException | null) => void;

interface AppDmgHdiutil {
  detach(mountPath: string, callback: DmgDetachCallback): void;
}

function installDmgDetachFallback(): void {
  if (process.platform !== "darwin") return;

  const require = createRequire(import.meta.url);
  const hdiutil = require("appdmg/lib/hdiutil.js") as AppDmgHdiutil;
  hdiutil.detach = (mountPath, callback) => {
    execFile("hdiutil", ["detach", mountPath], (error) => {
      if (!error || error.code !== 16 || !mountPath.startsWith("/Volumes/")) {
        callback(error);
        return;
      }

      // appdmg@0.6.6 only retries code 16. Endpoint DLP scanners can dissent
      // forever after every file handle has closed, so force only the temporary
      // volume created by this DMG maker and leave the scanner itself untouched.
      execFile("hdiutil", ["detach", "-force", mountPath], (forceError) => {
        callback(forceError);
      });
    });
  };
}

installDmgDetachFallback();

function chromiumRevisionDirectory(): string | undefined {
  let current = path.dirname(chromium.executablePath());
  while (path.dirname(current) !== current) {
    if (path.basename(current).startsWith("chromium-")) return current;
    current = path.dirname(current);
  }
  return undefined;
}

const chromiumDirectory = chromiumRevisionDirectory();
const defaultPetsDirectory = path.resolve("resources/default-pets");
const nativeHelpersDirectory = path.resolve(
  "resources/generated/native-helpers",
);
const nativeHelperBuildScript = path.resolve("scripts/build-native-helper.mjs");
const trayDirectory = path.resolve("resources/tray");
const appIconPath = path.resolve("resources/CharaMate.icns");
const signingIdentity = process.env["CHARAMATE_MACOS_SIGN_IDENTITY"]?.trim();
const notarizationKeychainProfile =
  process.env["CHARAMATE_NOTARIZE_KEYCHAIN_PROFILE"]?.trim();
const notarizationKeychain = process.env["CHARAMATE_NOTARIZE_KEYCHAIN"]?.trim();

if (notarizationKeychainProfile && !signingIdentity) {
  throw new Error(
    "CHARAMATE_NOTARIZE_KEYCHAIN_PROFILE requires CHARAMATE_MACOS_SIGN_IDENTITY.",
  );
}

function runFile(
  command: string,
  arguments_: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...arguments_], (error) => {
      if (error) reject(new Error(error.message, { cause: error }));
      else resolve();
    });
  });
}

const config: ForgeConfig = {
  hooks: {
    generateAssets: async (_forgeConfig, platform, architecture) => {
      await runFile(process.execPath, [
        nativeHelperBuildScript,
        platform,
        String(architecture),
      ]);
    },
  },
  packagerConfig: {
    asar: true,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "CharaMate 使用麦克风进行本地 Hi Mika 唤醒和实时语音对话。",
    },
    icon: appIconPath,
    executableName: "CharaMate",
    extraResource: [
      defaultPetsDirectory,
      trayDirectory,
      ...(process.platform === "darwin" ? [nativeHelpersDirectory] : []),
      ...(chromiumDirectory && existsSync(chromiumDirectory)
        ? [chromiumDirectory]
        : []),
    ],
    appBundleId: "com.charamate.desktop",
    ...(signingIdentity ? { osxSign: { identity: signingIdentity } } : {}),
    ...(notarizationKeychainProfile
      ? {
          osxNotarize: {
            keychainProfile: notarizationKeychainProfile,
            ...(notarizationKeychain ? { keychain: notarizationKeychain } : {}),
          },
        }
      : {}),
    ignore: (filePath) => {
      if (!filePath) {
        return false;
      }

      const allowedRuntimePaths = [
        "/.vite",
        "/node_modules/better-sqlite3",
        "/node_modules/node-addon-api",
        "/node_modules/playwright-core",
        "/node_modules/ws",
      ];
      const isAllowedRuntimePath = allowedRuntimePaths.some(
        (allowedPath) =>
          filePath === allowedPath || filePath.startsWith(`${allowedPath}/`),
      );

      return filePath !== "/node_modules" && !isAllowedRuntimePath;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({
      format: "ULFO",
      icon: appIconPath,
      name: "CharaMate",
      overwrite: true,
      title: "CharaMate",
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      concurrent: true,
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/character.ts",
          config: "vite.character-preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
        {
          name: "character_window",
          config: "vite.character.config.ts",
        },
      ],
    }),
  ],
};

export default config;
