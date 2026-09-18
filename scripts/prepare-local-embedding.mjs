import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const [
  descriptorPath = path.join(root, "resources/local-embedding.json"),
  destination = path.join(root, "resources/generated/local-embedding"),
  cache = path.join(os.homedir(), ".cache/charamate/embedding-build"),
] = process.argv.slice(2);
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Build local embedding resources on macOS arm64");
const manifest = JSON.parse(await readFile(descriptorPath, "utf8"));
// The app's TypeBox manifest schema is validated before its first use. Here
// validate all interpolated download/build inputs and verified source identity.
if (
  manifest.schemaVersion !== 1 ||
  manifest.platform !== "darwin" ||
  manifest.architecture !== "arm64" ||
  !/^b\d+$/.test(manifest.engine?.version) ||
  !/^[a-f0-9]{40}$/.test(manifest.engine?.commit) ||
  !/^[a-f0-9]{64}$/.test(manifest.engine?.archiveSha256) ||
  !/^Qwen\/Qwen3-Embedding-[A-Za-z0-9.-]+-GGUF$/.test(
    manifest.model?.repository,
  ) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(manifest.model?.file) ||
  !/^[a-f0-9]{40}$/.test(manifest.model?.revision) ||
  !/^[a-f0-9]{64}$/.test(manifest.model?.sha256) ||
  !Number.isSafeInteger(manifest.model?.sizeBytes) ||
  manifest.model.sizeBytes < 1 ||
  manifest.model.license !== "Apache-2.0"
)
  throw new Error("Invalid selected model source descriptor");
await mkdir(cache, { recursive: true });
async function hash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
try {
  const existing = JSON.parse(
    await readFile(path.join(destination, "manifest.json"), "utf8"),
  );
  if (JSON.stringify(existing) !== JSON.stringify(manifest))
    throw new Error(
      "Generated local embedding resources use a different descriptor. Remove only resources/generated/local-embedding, then prepare again.",
    );
  const inventory = JSON.parse(
    await readFile(path.join(destination, "verified-files.json"), "utf8"),
  );
  for (const item of inventory) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.file) ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("Invalid generated resource inventory");
    const file = path.join(destination, item.file);
    if (
      (await stat(file)).size !== item.sizeBytes ||
      (await hash(file)) !== item.sha256
    )
      throw new Error(`Generated resource changed: ${item.file}`);
  }
  process.stdout.write(
    `Verified local encoder at ${path.resolve(destination)}\n`,
  );
  process.exit(0);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // A partially prepared directory is not overwritten by a new download.
  try {
    await stat(destination);
    throw new Error(`Incomplete generated resource directory: ${destination}`, {
      cause: error,
    });
  } catch (directoryError) {
    if (directoryError.code !== "ENOENT") throw directoryError;
  }
}
async function artifact(url, digest, size) {
  const target = path.join(cache, digest);
  const valid = async () => {
    try {
      return (
        (size === undefined || (await stat(target)).size === size) &&
        (await hash(target)) === digest
      );
    } catch {
      return false;
    }
  };
  if (await valid()) return target;
  const temporary = `${target}.${process.pid}.part`;
  try {
    const response = await globalThis.fetch(url);
    if (!response.ok || !response.body)
      throw new Error(`Download failed: ${response.status} ${url}`);
    await pipeline(
      response.body,
      createWriteStream(temporary, { flags: "wx" }),
    );
    if (
      (size !== undefined && (await stat(temporary)).size !== size) ||
      (await hash(temporary)) !== digest
    )
      throw new Error(`Artifact does not match its pinned hash: ${url}`);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
async function sourceText(url) {
  const response = await globalThis.fetch(url);
  if (!response.ok)
    throw new Error(`Source download failed: ${response.status} ${url}`);
  return response.text();
}
// Only official GitHub releases and the official Qwen repository are used.
const archive = await artifact(
  `https://github.com/ggml-org/llama.cpp/releases/download/${manifest.engine.version}/llama-${manifest.engine.version}-bin-macos-arm64.tar.gz`,
  manifest.engine.archiveSha256,
);
const model = await artifact(
  `https://huggingface.co/${manifest.model.repository}/resolve/${manifest.model.revision}/${manifest.model.file}`,
  manifest.model.sha256,
  manifest.model.sizeBytes,
);
await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
const stage = await mkdtemp(
  path.join(path.dirname(path.resolve(destination)), ".embedding-build-"),
);
try {
  const unpack = path.join(stage, "unpack");
  const output = path.join(stage, "output");
  await mkdir(unpack);
  await mkdir(output);
  await run("/usr/bin/tar", ["-xzf", archive, "-C", unpack]);
  const binary = path.join(unpack, `llama-${manifest.engine.version}`);
  for (const file of await readdir(binary)) {
    if (file === "llama-server" || file.endsWith(".dylib"))
      await cp(path.join(binary, file), path.join(output, file), {
        verbatimSymlinks: true,
      });
  }
  await cp(
    path.join(binary, "LICENSE"),
    path.join(output, "llama-LICENSE.txt"),
  );
  await cp(model, path.join(output, manifest.model.file));
  await run("/usr/bin/xcrun", [
    "clang",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.3",
    path.join(root, "src/main/providers/native/embedding-supervisor.c"),
    "-o",
    path.join(output, "embedding-supervisor"),
  ]);
  await chmod(path.join(output, "embedding-supervisor"), 0o755);
  await writeFile(
    path.join(output, "model-README.md"),
    await sourceText(
      `https://huggingface.co/${manifest.model.repository}/raw/${manifest.model.revision}/README.md`,
    ),
  );
  // The upstream base repository carries the standard Apache 2.0 license.
  await writeFile(
    path.join(output, "model-LICENSE.txt"),
    await sourceText(`https://www.apache.org/licenses/LICENSE-2.0.txt`),
  );
  await writeFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const inventory = [];
  for (const file of (await readdir(output)).sort())
    inventory.push({
      file,
      sizeBytes: (await stat(path.join(output, file))).size,
      sha256: await hash(path.join(output, file)),
    });
  await writeFile(
    path.join(output, "verified-files.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  // Do not replace an existing selected bundle implicitly. The caller chooses
  // a fresh destination or explicitly removes its generated build output.
  try {
    await stat(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rename(output, path.resolve(destination));
  process.stdout.write(
    `Prepared one local encoder at ${path.resolve(destination)}\n`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
