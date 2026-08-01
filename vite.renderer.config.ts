import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "src/renderer"),
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: path.join(projectRoot, ".vite/renderer/main_window"),
    sourcemap: true,
  },
  plugins: [react()],
});
