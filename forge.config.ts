import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "CharaMate",
    appBundleId: "com.charamate.desktop",
    ignore: (filePath) => {
      if (!filePath) {
        return false;
      }

      const allowedRuntimePaths = [
        "/.vite",
        "/node_modules/better-sqlite3",
        "/node_modules/node-addon-api",
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
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
