import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

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
const trayDirectory = path.resolve("resources/tray");

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "CharaMate",
    extraResource: [
      defaultPetsDirectory,
      trayDirectory,
      ...(chromiumDirectory && existsSync(chromiumDirectory)
        ? [chromiumDirectory]
        : []),
    ],
    appBundleId: "com.charamate.desktop",
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
  makers: [],
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
