import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const buildDirectory = path.join(projectRoot, ".vite");

if (path.dirname(buildDirectory) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected build path: ${buildDirectory}`);
}

await rm(buildDirectory, { force: true, recursive: true });

for (const configFile of [
  "vite.main.config.ts",
  "vite.preload.config.ts",
  "vite.character-preload.config.ts",
  "vite.renderer.config.ts",
  "vite.character.config.ts",
]) {
  await build({
    configFile: path.join(projectRoot, configFile),
    mode: "production",
  });
}
