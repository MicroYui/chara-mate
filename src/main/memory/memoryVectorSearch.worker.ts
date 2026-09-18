import { parentPort } from "node:worker_threads";

import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";

import { NonBlankStringSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import { MemoryRepository } from "./memoryRepository";
import { searchMemoryVectors } from "./memoryVectorSearch";
import { MemoryVectorSearchMetadataSchema } from "./memoryVectorSearchWorker";

const InitializeSchema = Type.Object(
  {
    type: Type.Literal("initialize"),
    id: Type.Integer({ minimum: 1 }),
    databasePath: NonBlankStringSchema,
  },
  { additionalProperties: false },
);
const SearchSchema = Type.Object(
  {
    type: Type.Literal("search"),
    id: Type.Integer({ minimum: 1 }),
    metadata: MemoryVectorSearchMetadataSchema,
  },
  { additionalProperties: false },
);
let database: Database.Database | undefined;
let repository: MemoryRepository | undefined;
if (!parentPort) throw new Error("Memory vector scan requires a Worker");
const port = parentPort;
port.on("message", (input: unknown) => {
  let id = 0;
  try {
    if (typeof input !== "object" || !input)
      throw new TypeError("Invalid Memory vector request");
    const message = input as Record<string, unknown>;
    if (typeof message["id"] === "number") id = message["id"];
    if (message["type"] === "initialize") {
      const request = parseSchema(InitializeSchema, input);
      if (database) throw new Error("Memory vector database is already open");
      // Main owns migration and writes. A streamed SELECT sees one WAL snapshot;
      // new committed chunks are visible on the next search without reopening.
      database = new Database(request.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      repository = new MemoryRepository(database);
      port.postMessage({ id, type: "ready" });
      return;
    }
    const { query, cancel, ...rest } = message;
    const request = parseSchema(SearchSchema, rest);
    if (!repository)
      throw new Error("Memory vector database has not initialized");
    if (
      !(query instanceof Float32Array) ||
      !(cancel instanceof SharedArrayBuffer) ||
      cancel.byteLength !== Int32Array.BYTES_PER_ELEMENT
    )
      throw new TypeError("Invalid Memory vector or cancellation buffer");
    const flag = new Int32Array(cancel);
    const checkCancellation = () => {
      if (Atomics.load(flag, 0) !== 0)
        throw new DOMException("Memory vector search cancelled", "AbortError");
    };
    checkCancellation();
    const { plan, modelKey, limit, now } = request.metadata;
    const matches = searchMemoryVectors(
      query,
      repository.recall.vectors(plan, modelKey, now),
      limit,
      checkCancellation,
    );
    checkCancellation();
    port.postMessage({ id, type: "result", matches });
  } catch (error) {
    port.postMessage({
      id,
      type: "error",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
port.on("close", () => database?.close());
