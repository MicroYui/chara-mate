import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import {
  MemoryVectorSearchWorker,
  type MemoryVectorSearchRequest,
} from "./memoryVectorSearchWorker";

class FixtureWorker extends EventEmitter {
  readonly searches: Record<string, unknown>[] = [];
  readonly terminate = vi.fn(() => Promise.resolve(0));
  postMessage(message: Record<string, unknown>): void {
    if (message["type"] === "initialize")
      queueMicrotask(() =>
        this.emit("message", { id: message["id"], type: "ready" }),
      );
    else this.searches.push(message);
  }
  result(index: number): void {
    const request = this.searches[index]!;
    this.emit("message", {
      id: request["id"],
      type: "result",
      matches: [{ id: "revision-one", similarity: 0.5 }],
    });
  }
}
const request: MemoryVectorSearchRequest = {
  plan: {
    purpose: "recollection",
    query: "回忆",
    questions: [{ id: "q1", text: "回忆" }],
    contextBudget: { maxTokens: 8000 },
  },
  modelKey: "numeric-fixture",
  query: new Float32Array([1, 0]),
  limit: 2,
  now: "2026-09-15T00:00:00.000Z",
};
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe("Read-only Memory vector worker port", () => {
  it("initializes once, serializes scans and keeps the caller's query buffer intact", async () => {
    const worker = new FixtureWorker();
    const factory = vi.fn(() => worker as unknown as Worker);
    const port = new MemoryVectorSearchWorker("fixture.sqlite", factory);
    const first = port.search(request);
    const second = port.search(request);
    await flush();
    expect(worker.searches).toHaveLength(1);
    expect(worker.searches[0]?.["query"]).not.toBe(request.query);
    worker.result(0);
    await expect(first).resolves.toEqual([
      { id: "revision-one", similarity: 0.5 },
    ]);
    await flush();
    expect(worker.searches).toHaveLength(2);
    worker.result(1);
    await second;
    expect(factory).toHaveBeenCalledTimes(1);
    await port.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(port.search(request)).rejects.toThrow("closed");
  });

  it("sets a cancellation flag, waits for iterator release and permits the next search", async () => {
    const worker = new FixtureWorker();
    const port = new MemoryVectorSearchWorker(
      "fixture.sqlite",
      () => worker as unknown as Worker,
    );
    const abort = new AbortController();
    const first = port.search(request, abort.signal);
    const rejected = expect(first).rejects.toThrow();
    await flush();
    abort.abort();
    expect(
      Atomics.load(
        new Int32Array(worker.searches[0]!["cancel"] as SharedArrayBuffer),
        0,
      ),
    ).toBe(1);
    worker.emit("message", {
      id: worker.searches[0]!["id"],
      type: "error",
      name: "AbortError",
      message: "Cancelled",
    });
    await rejected;
    const next = port.search(request);
    await flush();
    worker.result(1);
    await next;
    await port.close();
  });

  it("rejects a failed worker and reopens only the same worker implementation on the next request", async () => {
    const workers: FixtureWorker[] = [];
    const port = new MemoryVectorSearchWorker("fixture.sqlite", () => {
      const worker = new FixtureWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const first = port.search(request);
    const rejected = expect(first).rejects.toThrow("fixture failure");
    await flush();
    workers[0]!.emit("error", new Error("fixture failure"));
    await rejected;
    const next = port.search(request);
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]!.result(0);
    await next;
    await port.close();
  });
});
