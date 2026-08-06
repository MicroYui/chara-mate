import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: path.join(projectRoot, "node_modules/.vite/character_window"),
  root: path.join(projectRoot, "src/renderer/character"),
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: path.join(projectRoot, ".vite/renderer/character_window"),
    sourcemap: true,
  },
  plugins: [react()],
});
