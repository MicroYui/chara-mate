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
      // Forge Vite Plugin 7.11.2 merges the user lib config unchanged (checked 2026-09-15).
      entry: {
        main: "src/main/index.ts",
        "memory-vector-search": "src/main/memory/memoryVectorSearch.worker.ts",
      },
      fileName: (_format, entryName) => `${entryName}.mjs`,
      formats: ["es"],
    },
    minify: false,
    outDir: ".vite/build",
    rollupOptions: {
      external: [
        "electron",
        "better-sqlite3",
        "playwright-core",
        "ws",
        ...nodeExternals,
      ],
    },
    sourcemap: true,
  },
  define:
    "forgeConfig" in environment
      ? {}
      : {
          MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
          MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
          CHARACTER_WINDOW_VITE_DEV_SERVER_URL: "undefined",
          CHARACTER_WINDOW_VITE_NAME: JSON.stringify("character_window"),
        },
}));
