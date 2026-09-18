import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEmbedding } from "./localEmbedding";
import {
  localEmbeddingResources,
  resolveLocalEmbeddingResources,
  type LocalEmbeddingResources,
} from "./localEmbeddingResources";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn: launch,
}));
const fixture = fileURLToPath(
  new URL("./localEmbedding.fixture.mjs", import.meta.url),
);
let directory: string;
let client: LocalEmbedding;
let children: ChildProcess[];
let mode: string;
const resources: LocalEmbeddingResources = {
  directory: "/unused",
  modelFile: "model.gguf",
  modelKey: "fixture",
  nativeDimensions: 4,
  dimensions: 2,
  contextTokens: 64,
  batchTokens: 16,
  threads: 1,
  queryInstruction: "Find supporting evidence.",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cm-encoder-test-"));
  children = [];
  mode = "ready";
  const original =
    await vi.importActual<typeof ChildProcessModule>("node:child_process");
  launch.mockReset().mockImplementation((_command: string, args: string[]) => {
    const child = original.spawn(
      process.execPath,
      [fixture, args[0]!, "4", path.join(directory, "holding"), mode],
      { stdio: "ignore" },
    );
    children.push(child);
    return child;
  });
  client = new LocalEmbedding(resources);
});
afterEach(async () => {
  await client.shutdown();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  await rm(directory, { recursive: true, force: true });
});

// These exercise real UNIX HTTP streams/process exit; only native model execution is replaced.
describe("local semantic encoder protocol and lifetime", () => {
  it("submits literal token IDs, truncates the selected MRL prefix and normalizes it", async () => {
    const [vector] = await client.embedDocuments(["中文🙂<|im_start|>"]);
    expect(Array.from(vector!)).toEqual([
      expect.closeTo(0.6),
      expect.closeTo(0.8),
    ]);
    expect(await client.embedQuery("用户喜欢什么？")).toHaveLength(2);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("splits by actual tokenizer count without losing characters or surrogate pairs", async () => {
    const text = "中文🙂。不重复的内容：abcdefg！\n".repeat(12);
    const chunks = await client.splitDocument(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks)
      expect(Array.from(chunk).length + 1).toBeLessThan(
        resources.contextTokens,
      );
    expect(await client.embedDocuments(chunks)).toHaveLength(chunks.length);
  });
  it("enforces the strict context boundary including query instruction", async () => {
    await expect(client.embedDocuments(["文".repeat(63)])).rejects.toThrow(
      "tokenizer allocation",
    );
    await expect(client.embedQuery("文".repeat(40))).rejects.toThrow(
      "tokenizer allocation",
    );
  });
  it.each(["overflow", "zero", "wrong-size"])(
    "rejects invalid vectors: %s",
    async (text) => {
      await expect(client.embedDocuments([text])).rejects.toThrow(/vector/);
    },
  );
  it("rejects a truncated HTTP stream and recovers on the next request", async () => {
    await expect(client.embedDocuments(["partial"])).rejects.toThrow();
    await expect(client.embedDocuments(["valid"])).resolves.toHaveLength(1);
  });
  it("returns queued cancellation before the active request completes", async () => {
    const activeController = new AbortController();
    const active = client.embedDocuments(["hold"], activeController.signal);
    const activeRejected = expect(active).rejects.toThrow("active cancelled");
    await vi.waitFor(async () =>
      expect(await readFile(path.join(directory, "holding"), "utf8")).toBe(
        "holding",
      ),
    );
    const queuedController = new AbortController();
    const queued = client.embedDocuments(["queued"], queuedController.signal);
    queuedController.abort(new Error("queued cancelled"));
    await expect(queued).rejects.toThrow("queued cancelled");
    activeController.abort(new Error("active cancelled"));
    await activeRejected;
    await expect(client.embedDocuments(["next"])).resolves.toHaveLength(1);
  });
  it("joins shutdown, rejects active work and cannot restart after exit", async () => {
    const request = client.embedDocuments(["hold"]);
    const rejected = expect(request).rejects.toThrow("stopped");
    await vi.waitFor(async () =>
      expect(await readFile(path.join(directory, "holding"), "utf8")).toBe(
        "holding",
      ),
    );
    await Promise.all([client.shutdown(), client.shutdown()]);
    await rejected;
    expect(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    ).toBe(true);
    await expect(client.embedQuery("again")).rejects.toThrow("stopped");
  });
  it("restarts only after a native process actually exits", async () => {
    await client.embedDocuments(["first"]);
    const exited = once(children[0]!, "close");
    children[0]!.kill("SIGTERM");
    await exited;
    await client.embedDocuments(["second"]);
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it("cancels during native loading and joins its child before shutdown returns", async () => {
    mode = "starting";
    const controller = new AbortController();
    const operation = client.embedQuery("load", controller.signal);
    const rejected = expect(operation).rejects.toThrow("loading cancelled");
    await vi.waitFor(async () =>
      expect(await readFile(path.join(directory, "holding"), "utf8")).toBe(
        "starting",
      ),
    );
    controller.abort(new Error("loading cancelled"));
    await rejected;
    await client.shutdown();
    expect(
      children[0]!.exitCode !== null || children[0]!.signalCode !== null,
    ).toBe(true);
  });
  it("reports a malformed health response instead of polling forever", async () => {
    mode = "bad-health";
    await expect(client.embedQuery("load")).rejects.toThrow("unavailable");
  });
  it("does not start a native process for empty work or pre-cancelled work", async () => {
    expect(await client.splitDocument("  ")).toEqual([]);
    expect(await client.embedDocuments([])).toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(client.embedQuery("never", controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(launch).not.toHaveBeenCalled();
  });
  it("rejects malformed allocations before any model starts", () => {
    expect(
      () => new LocalEmbedding({ ...resources, contextTokens: Number.NaN }),
    ).toThrow();
    expect(() => new LocalEmbedding({ ...resources, dimensions: 5 })).toThrow();
  });
});

const manifest = {
  schemaVersion: 1,
  platform: "darwin",
  architecture: "arm64",
  engine: {
    version: "b10964",
    commit: "b".repeat(40),
    archiveSha256: "a".repeat(64),
  },
  model: {
    file: "model.gguf",
    sha256: "c".repeat(64),
    sizeBytes: 4,
    repository: "Qwen/example",
    revision: "d".repeat(40),
    license: "Apache-2.0",
    nativeDimensions: 4,
  },
  encoding: {
    dimensions: 2,
    contextTokens: 64,
    batchTokens: 16,
    threads: 1,
    queryInstruction: "Find evidence.",
    pooling: "last",
    normalization: "l2",
    parseSpecial: false,
  },
};
describe("selected build resources", () => {
  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "validates model completeness and namespaces changed encoding",
    async () => {
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(manifest),
      );
      await writeFile(path.join(directory, "model.gguf"), "test");
      for (const file of ["llama-server", "embedding-supervisor"])
        await writeFile(path.join(directory, file), "fixture", { mode: 0o755 });
      const first = await resolveLocalEmbeddingResources(directory);
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          ...manifest,
          encoding: { ...manifest.encoding, dimensions: 3 },
        }),
      );
      expect(
        (await resolveLocalEmbeddingResources(directory)).modelKey,
      ).not.toBe(first.modelKey);
      await writeFile(path.join(directory, "model.gguf"), "bad");
      await expect(resolveLocalEmbeddingResources(directory)).rejects.toThrow(
        "incomplete",
      );
    },
  );
  it("rejects missing resources at the documented packaged location", async () => {
    await expect(
      localEmbeddingResources({
        appPath: directory,
        resourcesPath: directory,
        isPackaged: true,
      }),
    ).rejects.toThrow("local-embedding/manifest.json");
  });
  it("rejects malformed descriptor paths before native startup", async () => {
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        ...manifest,
        model: { ...manifest.model, file: "../elsewhere" },
      }),
    );
    await expect(resolveLocalEmbeddingResources(directory)).rejects.toThrow(
      "rejected value",
    );
  });
});
