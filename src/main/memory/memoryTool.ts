import { Type, type Static } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import { MemoryTypeSchema } from "../../shared/schemas/memory";
import {
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { MemoryService } from "./memoryService";

const MemorySearchInputSchema = Type.Object(
  {
    asOf: Type.Optional(TimestampSchema),
    query: NonBlankStringSchema,
    type: Type.Optional(MemoryTypeSchema),
  },
  { additionalProperties: false },
);

type MemorySearchInput = Static<typeof MemorySearchInputSchema>;

export function registerMemoryTool(
  registry: ToolRegistry,
  memory: MemoryService,
): void {
  registry.register({
    descriptor: {
      description:
        "Search the user's active long-term memory records and their evidence when the user explicitly asks to inspect or search beyond the memories already supplied for the current request. Use asOf only for an explicitly historical question.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: MemorySearchInputSchema,
      itemKind: "tool_call",
      name: "memory.search",
      namespace: "memory",
      source: "builtin",
      summary: "搜索长期记忆",
    },
    execute: (input) => {
      const request: MemorySearchInput = parseSchema(
        MemorySearchInputSchema,
        input,
      );
      const hits = memory.search(request, "tool", 8);
      const modelContent = {
        hits: hits.map((hit) => ({
          content: hit.revision.content,
          memoryCreatedAt: hit.memory.createdAt,
          memoryId: hit.memory.id,
          memoryUpdatedAt: hit.memory.updatedAt,
          rank: hit.rank,
          revisionCreatedAt: hit.revision.createdAt,
          revisionId: hit.revision.id,
          status: hit.memory.status,
          sources: hit.sources.map((source) => ({
            createdAt: source.createdAt,
            ...(source.label ? { label: source.label } : {}),
            referenceId: source.referenceId,
            type: source.type,
          })),
          type: hit.memory.type,
          ...(hit.memory.validFrom ? { validFrom: hit.memory.validFrom } : {}),
          ...(hit.memory.validTo ? { validTo: hit.memory.validTo } : {}),
        })),
        query: request.query,
      } satisfies JsonValue;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary:
          hits.length > 0
            ? `找到 ${String(hits.length)} 条记忆`
            : "没有找到相关记忆",
      });
    },
    summarize: (input) => {
      const query = input["query"];
      return `搜索长期记忆${typeof query === "string" ? `：${query}` : ""}`;
    },
  });
}
