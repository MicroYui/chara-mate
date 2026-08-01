import { builtinModules } from "node:module";

import { defineConfig } from "vite";

const nodeExternals = builtinModules.flatMap((moduleName) => [
  moduleName,
  `node:${moduleName}`,
]);

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    minify: false,
    outDir: ".vite/build",
    rollupOptions: {
      external: ["electron", ...nodeExternals],
      input: "src/preload/index.ts",
      output: {
        assetFileNames: "[name].[ext]",
        chunkFileNames: "[name].mjs",
        entryFileNames: "preload.mjs",
        format: "es",
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
  },
});
