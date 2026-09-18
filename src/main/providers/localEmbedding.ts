import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { MemoryEmbeddingProvider } from "../memory/memoryModels";

import type { LocalEmbeddingResources } from "./localEmbeddingResources";
export type { LocalEmbeddingResources } from "./localEmbeddingResources";

interface LocalEmbeddingProcess {
  readonly child: ChildProcess;
  readonly socket: string;
  readonly directory: string;
  readonly exited: Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid local embedding response");
  return value as Record<string, unknown>;
}

/** One local semantic encoder, owned by Main. Model selection is a packaged resource decision. */
export class LocalEmbedding implements MemoryEmbeddingProvider {
  readonly modelKey: string;
  readonly dimensions: number;
  readonly #stop = new AbortController();
  #starting: Promise<LocalEmbeddingProcess> | undefined;
  #process: LocalEmbeddingProcess | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly resources: LocalEmbeddingResources) {
    if (
      [
        resources.contextTokens,
        resources.batchTokens,
        resources.dimensions,
        resources.nativeDimensions,
        resources.threads,
      ].some((value) => !Number.isSafeInteger(value) || value < 1) ||
      resources.contextTokens < 2 ||
      resources.dimensions > resources.nativeDimensions ||
      resources.batchTokens > resources.contextTokens
    ) {
      throw new RangeError("Invalid local embedding resource allocation");
    }
    this.modelKey = resources.modelKey;
    this.dimensions = resources.dimensions;
  }

  splitDocument(text: string, signal?: AbortSignal): Promise<string[]> {
    return this.enqueue(async (combined) => {
      if (!text.trim()) return [];
      const runtime = await this.ready(combined);
      const limit = this.resources.contextTokens - 1;
      const chunks: string[] = [];
      let remaining = text;
      while (remaining) {
        if ((await this.tokens(runtime, remaining, combined)).length <= limit) {
          chunks.push(remaining);
          break;
        }
        const codepoints = Array.from(remaining);
        let low = 1;
        let high = codepoints.length - 1;
        let length = 0;
        // Token length is not strictly monotonic for BPE. This finds a valid
        // prefix, not necessarily the longest; each final chunk is rechecked.
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (
            (
              await this.tokens(
                runtime,
                codepoints.slice(0, middle).join(""),
                combined,
              )
            ).length <= limit
          ) {
            length = middle;
            low = middle + 1;
          } else high = middle - 1;
        }
        if (!length)
          throw new Error(
            "A character exceeds the local embedding context allocation",
          );
        let prefix = codepoints.slice(0, length).join("");
        const boundary = [...prefix.matchAll(/[。！？.!?]\s*|\n+/gu)].at(-1);
        if (boundary?.index !== undefined) {
          const sentence = prefix.slice(0, boundary.index + boundary[0].length);
          if ((await this.tokens(runtime, sentence, combined)).length <= limit)
            prefix = sentence;
        }
        chunks.push(prefix);
        remaining = remaining.slice(prefix.length);
      }
      return chunks;
    }, signal);
  }

  embedDocuments(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    return this.enqueue(async (combined) => {
      if (!texts.length) return [];
      const runtime = await this.ready(combined);
      const vectors: Float32Array[] = [];
      // Qwen is causal with LAST pooling: sequences can span microbatches.
      // Serial requests keep the measured native memory allocation predictable.
      for (const text of texts)
        vectors.push(await this.encode(runtime, text, combined));
      return vectors;
    }, signal);
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const instruction = `Instruct: ${this.resources.queryInstruction}\nQuery: ${text}`;
    const vectors = await this.embedDocuments([instruction], signal);
    return vectors[0]!;
  }

  async shutdown(): Promise<void> {
    this.#stop.abort(new Error("Local embedding stopped"));
    let process = this.#process;
    if (!process && this.#starting) {
      try {
        process = await this.#starting;
      } catch {
        /* Startup cleans its owned process. */
      }
    }
    process?.child.kill("SIGTERM");
    await process?.exited;
    await this.#tail.catch(() => undefined);
    if (process) await rm(process.directory, { recursive: true, force: true });
    this.#process = undefined;
  }

  private enqueue<T>(
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([signal, this.#stop.signal])
      : this.#stop.signal;
    const result = this.#tail
      .catch(() => undefined)
      .then(() => {
        combined.throwIfAborted();
        return task(combined);
      });
    this.#tail = result;
    // A cancelled queued caller returns immediately, while the internal tail
    // still joins the active request before allowing the next one to start.
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(
          combined.reason instanceof Error
            ? combined.reason
            : new Error("Local embedding cancelled"),
        );
      if (combined.aborted) abort();
      else combined.addEventListener("abort", abort, { once: true });
      void result
        .then(resolve, reject)
        .finally(() => combined.removeEventListener("abort", abort));
    });
  }

  private ready(signal: AbortSignal): Promise<LocalEmbeddingProcess> {
    signal.throwIfAborted();
    if (
      this.#process &&
      this.#process.child.exitCode === null &&
      this.#process.child.signalCode === null
    )
      return Promise.resolve(this.#process);
    if (this.#starting) return this.#starting;
    this.#starting = this.start(signal).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  private async start(signal: AbortSignal): Promise<LocalEmbeddingProcess> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cm-embed-"));
    const socket = path.join(directory, "model.sock");
    const child = spawn(
      path.join(this.resources.directory, "embedding-supervisor"),
      [
        socket,
        path.join(this.resources.directory, "llama-server"),
        "-m",
        path.join(this.resources.directory, this.resources.modelFile),
        "--embedding",
        "--pooling",
        "last",
        "--embd-normalize",
        "2",
        "--n-gpu-layers",
        "all",
        "--ctx-size",
        String(this.resources.contextTokens),
        "--batch-size",
        String(this.resources.batchTokens),
        "--ubatch-size",
        String(this.resources.batchTokens),
        "--parallel",
        "1",
        "--threads",
        String(this.resources.threads),
        "--host",
        socket,
        "--no-webui",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    let startupError: Error | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        startupError = error;
        resolve();
      });
      child.once("close", () => resolve());
    });
    const runtime = { child, socket, directory, exited };
    try {
      for (;;) {
        signal.throwIfAborted();
        if (startupError) throw startupError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            "Local embedding process exited before it became ready",
          );
        try {
          const health = object(
            await this.request(runtime, "GET", "/health", undefined, signal),
          );
          if (health["status"] === "ok") break;
          throw new Error("Local embedding health response is invalid");
        } catch (error) {
          signal.throwIfAborted();
          const code =
            error && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
          // The socket is absent while loading; llama serves 503 until ready.
          if (
            code !== "ENOENT" &&
            code !== "ECONNREFUSED" &&
            !(error instanceof LocalEmbeddingHttpError && error.status === 503)
          )
            throw error;
        }
        // Readiness polling is an implementation detail, never a Run deadline.
        await delay(100, undefined, { signal: signal });
      }
      this.#process = runtime;
      void exited
        .then(async () => {
          if (this.#process === runtime) this.#process = undefined;
          await rm(directory, { recursive: true, force: true });
        })
        .catch(() => undefined);
      return runtime;
    } catch (error) {
      child.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
      throw new Error("Local semantic memory encoder is unavailable", {
        cause: error,
      });
    }
  }

  private async tokens(
    runtime: LocalEmbeddingProcess,
    text: string,
    signal = this.#stop.signal,
  ): Promise<number[]> {
    const response = object(
      await this.request(
        runtime,
        "POST",
        "/tokenize",
        { content: text, add_special: true, parse_special: false },
        signal,
      ),
    );
    const tokens = response["tokens"];
    if (
      !Array.isArray(tokens) ||
      tokens.length === 0 ||
      tokens.some((token) => !Number.isSafeInteger(token) || token < 0)
    )
      throw new Error("Local tokenizer returned invalid tokens");
    return tokens as number[];
  }

  private async encode(
    runtime: LocalEmbeddingProcess,
    text: string,
    signal: AbortSignal,
  ): Promise<Float32Array> {
    signal.throwIfAborted();
    const tokens = await this.tokens(runtime, text, signal);
    if (tokens.length >= this.resources.contextTokens)
      throw new Error(
        "Semantic query/document exceeds its tokenizer allocation; split the document or ask a more specific evidence question",
      );
    // Token IDs preserve parse_special=false and the exact count checked above.
    const response = object(
      await this.request(
        runtime,
        "POST",
        "/v1/embeddings",
        { input: [tokens], encoding_format: "float" },
        signal,
      ),
    );
    signal.throwIfAborted();
    const data = response["data"];
    const item =
      Array.isArray(data) && data.length === 1 ? object(data[0]) : undefined;
    const embedding = item?.["index"] === 0 ? item["embedding"] : undefined;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== this.resources.nativeDimensions ||
      embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    )
      throw new Error("Local encoder returned an invalid semantic vector");
    const vector = Float32Array.from(
      (embedding as number[]).slice(0, this.dimensions),
    );
    if (vector.some((value) => !Number.isFinite(value)))
      throw new Error("Local encoder vector exceeds Float32 range");
    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0),
    );
    if (!(norm > 0) || !Number.isFinite(norm))
      throw new Error("Local encoder returned an empty semantic vector");
    for (let index = 0; index < vector.length; index++)
      vector[index] = vector[index]! / norm;
    return vector;
  }

  private request(
    runtime: LocalEmbeddingProcess,
    method: string,
    endpoint: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          socketPath: runtime.socket,
          path: endpoint,
          method,
          signal,
          headers: payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.once("aborted", () =>
            reject(new Error("Local encoder response was interrupted")),
          );
          response.once("close", () => {
            if (!response.complete)
              reject(
                new Error("Local encoder response closed before completion"),
              );
          });
          response.on("end", () => {
            if (response.statusCode !== 200) {
              reject(new LocalEmbeddingHttpError(response.statusCode));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error("Invalid local encoder JSON response"),
              );
            }
          });
        },
      );
      request.once("error", reject);
      request.end(payload);
    });
  }
}

class LocalEmbeddingHttpError extends Error {
  constructor(readonly status: number | undefined) {
    super(`Local encoder HTTP ${String(status)}`);
  }
}
