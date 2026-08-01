import { builtinModules } from "node:module";

import { defineConfig } from "vite";

const nodeExternals = builtinModules.flatMap((moduleName) => [
  moduleName,
  `node:${moduleName}`,
]);

export default defineConfig((environment) => ({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    lib: {
      entry: "src/main/index.ts",
      fileName: () => "main.mjs",
      formats: ["es"],
    },
    minify: false,
    outDir: ".vite/build",
    rollupOptions: {
      external: ["electron", "better-sqlite3", "ws", ...nodeExternals],
    },
    sourcemap: true,
  },
  define:
    "forgeConfig" in environment
      ? {}
      : {
          MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
          MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
        },
}));
