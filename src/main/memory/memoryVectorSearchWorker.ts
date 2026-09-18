import type { Worker } from "node:worker_threads";

import { Type } from "@sinclair/typebox";

import type { RecallPlan } from "../../shared/contracts/memoryRecall";
import { RecallPlanSchema } from "../../shared/schemas/memoryRecall";
import {
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { MemoryVectorMatch } from "./memoryVectorSearch";

export interface MemoryVectorSearchRequest {
  readonly plan: RecallPlan;
  readonly modelKey: string;
  readonly query: Float32Array;
  readonly limit: number;
  readonly now: string;
}

export interface MemoryVectorSearchPort {
  search(
    request: MemoryVectorSearchRequest,
    signal?: AbortSignal,
  ): Promise<MemoryVectorMatch[]>;
}

export const MemoryVectorSearchMetadataSchema = Type.Object(
  {
    plan: RecallPlanSchema,
    modelKey: NonBlankStringSchema,
    limit: Type.Integer({ minimum: 1 }),
    now: TimestampSchema,
  },
  { additionalProperties: false },
);

const WorkerReplySchema = Type.Union([
  Type.Object(
    { id: Type.Integer({ minimum: 1 }), type: Type.Literal("ready") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.Integer({ minimum: 1 }),
      type: Type.Literal("result"),
      matches: Type.Array(
        Type.Object(
          {
            id: NonBlankStringSchema,
            similarity: Type.Number({ minimum: -1, maximum: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.Integer({ minimum: 1 }),
      type: Type.Literal("error"),
      name: NonBlankStringSchema,
      message: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
]);

type WorkerReply = ReturnType<typeof parseReply>;
const parseReply = (value: unknown) => parseSchema(WorkerReplySchema, value);

/** One read-only SQLite worker owns all exact vector scans. It is initialized
 * after Main migrates the database; there is no Main-thread scan fallback. */
export class MemoryVectorSearchWorker implements MemoryVectorSearchPort {
  #worker: Worker | undefined;
  #ready: Promise<void> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #nextId = 0;
  #closed = false;
  #activeCancel: Int32Array | undefined;
  readonly #pending = new Map<
    number,
    { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly databasePath: string,
    private readonly createWorker: () => Worker,
  ) {}

  search(
    request: MemoryVectorSearchRequest,
    signal?: AbortSignal,
  ): Promise<MemoryVectorMatch[]> {
    if (this.#closed)
      return Promise.reject(new Error("Memory vector search is closed"));
    const operation = this.#tail
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted();
        if (this.#closed) throw new Error("Memory vector search is closed");
        await this.#ensureReady();
        signal?.throwIfAborted();
        const { query, ...metadata } = request;
        parseSchema(MemoryVectorSearchMetadataSchema, metadata);
        const cancel = new Int32Array(
          new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        );
        this.#activeCancel = cancel;
        const abort = () => Atomics.store(cancel, 0, 1);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (this.#closed) abort();
          const queryCopy = new Float32Array(query);
          const reply = await this.#send(
            {
              type: "search",
              metadata,
              query: queryCopy,
              cancel: cancel.buffer,
            },
            [queryCopy.buffer],
          );
          signal?.throwIfAborted();
          if (reply.type !== "result")
            throw new TypeError(
              "Memory vector worker returned an unexpected response",
            );
          return reply.matches;
        } finally {
          signal?.removeEventListener("abort", abort);
          this.#activeCancel = undefined;
        }
      });
    this.#tail = operation;
    return operation;
  }

  #ensureReady(): Promise<void> {
    if (this.#ready) return this.#ready;
    const worker = this.createWorker();
    this.#worker = worker;
    const fail = (error: Error) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      this.#ready = undefined;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      void worker.terminate();
    };
    worker.on("message", (message: unknown) => {
      try {
        const reply = parseReply(message);
        const pending = this.#pending.get(reply.id);
        if (!pending)
          throw new TypeError(
            "Memory vector worker returned an unknown request",
          );
        this.#pending.delete(reply.id);
        if (reply.type === "error") {
          const error = new Error(reply.message);
          error.name = reply.name;
          pending.reject(error);
        } else pending.resolve(reply);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("Memory vector worker exited")));
    const ready = this.#send({
      type: "initialize",
      databasePath: this.databasePath,
    })
      .then((reply) => {
        if (reply.type !== "ready")
          throw new TypeError("Memory vector worker did not initialize");
      })
      .catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    this.#ready = ready;
    return ready;
  }

  #send(
    payload: object,
    transferList: ArrayBuffer[] = [],
  ): Promise<WorkerReply> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        if (!this.#worker)
          throw new Error("Memory vector worker is unavailable");
        this.#worker.postMessage({ ...payload, id }, transferList);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#activeCancel) Atomics.store(this.#activeCancel, 0, 1);
    await this.#tail.catch(() => undefined);
    const worker = this.#worker;
    this.#worker = undefined;
    this.#ready = undefined;
    if (worker) await worker.terminate();
  }
}
