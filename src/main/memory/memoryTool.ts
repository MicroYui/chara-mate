import { Type, type Static } from "@sinclair/typebox";

import type { MemorySourceType } from "../../shared/contracts/memory";
import type { JsonValue } from "../../shared/contracts/primitives";
import {
  MemoryClaimSlotSchema,
  MemoryTypeSchema,
} from "../../shared/schemas/memory";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { MemoryService } from "./memoryService";

export const MEMORY_FORMATION_TOOL_NAME = "memory.record";

const UnscopedMemoryTypeSchema = Type.Union([
  Type.Literal("project"),
  Type.Literal("event"),
  Type.Literal("procedure"),
  Type.Literal("commitment"),
]);

const MemoryFormationBasisSchema = Type.Union([
  Type.Literal("explicit_user_statement"),
  Type.Literal("inference"),
  Type.Literal("run_observation"),
]);

const MemoryUpdateOperationSchema = Type.Union([
  Type.Literal("replace"),
  Type.Literal("append"),
  Type.Literal("remove"),
]);

export const MemoryFormationInputSchema = Type.Union([
  Type.Object(
    {
      basis: MemoryFormationBasisSchema,
      claimSlot: MemoryClaimSlotSchema,
      content: NonBlankStringSchema,
      operation: Type.Literal("create"),
      validFrom: Type.Optional(TimestampSchema),
      validTo: Type.Optional(TimestampSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      basis: MemoryFormationBasisSchema,
      claimSlot: MemoryClaimSlotSchema,
      content: NonBlankStringSchema,
      memoryId: Type.Optional(EntityIdSchema),
      operation: MemoryUpdateOperationSchema,
      validFrom: Type.Optional(TimestampSchema),
      validTo: Type.Optional(TimestampSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      basis: MemoryFormationBasisSchema,
      content: NonBlankStringSchema,
      operation: Type.Literal("create"),
      type: UnscopedMemoryTypeSchema,
      validFrom: Type.Optional(TimestampSchema),
      validTo: Type.Optional(TimestampSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      basis: MemoryFormationBasisSchema,
      content: NonBlankStringSchema,
      memoryId: Type.Optional(EntityIdSchema),
      operation: MemoryUpdateOperationSchema,
      type: UnscopedMemoryTypeSchema,
      validFrom: Type.Optional(TimestampSchema),
      validTo: Type.Optional(TimestampSchema),
    },
    { additionalProperties: false },
  ),
]);

type MemoryFormationToolInput = Static<typeof MemoryFormationInputSchema>;

export interface MemoryFormationEvidence {
  readonly allowedMemoryIds: readonly string[];
  readonly label: string;
  readonly referenceId: string;
  readonly sourceType: Extract<MemorySourceType, "chat" | "tool" | "voice">;
}

export type MemoryFormationEvidenceResolver = (
  runId: string,
  basis: MemoryFormationToolInput["basis"],
) => MemoryFormationEvidence;

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

export function registerMemoryFormationTool(
  registry: ToolRegistry,
  memory: MemoryService,
  resolveEvidence: MemoryFormationEvidenceResolver,
): void {
  registry.register({
    descriptor: {
      description:
        "Record durable user knowledge during the current Chat or Agent Run. For supported profile/preference fields, use the closed claimSlot whose name describes the stable field, never its value: e.g. preference.hobbies remains the same slot when A changes to B. Use create only for a genuinely new field, replace for an explicit correction or complete replacement, and append/remove only for a set-valued slot. For every update, content must be the complete post-operation memory statement, not only the added or removed fragment. For other durable memories use type. Include memoryId only when that exact active ID was preloaded in this Run; the host rejects any other ID. If an update lacks a legal target, conflicts with a slot, is ambiguous with another preloaded stable field, or needs to bind old unkeyed data, it becomes a review candidate instead of a second active fact. Use explicit_user_statement only for facts the user directly stated; inference and run_observation always become candidates. Never record transient requests, assistant speculation, copied material, credentials, secrets, or unchanged memories.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: MemoryFormationInputSchema,
      itemKind: "tool_call",
      name: MEMORY_FORMATION_TOOL_NAME,
      namespace: "memory",
      source: "builtin",
      summary: "形成长期记忆",
    },
    execute: (input, context) => {
      const request: MemoryFormationToolInput = parseSchema(
        MemoryFormationInputSchema,
        input,
      );
      const evidence = resolveEvidence(context.runId, request.basis);
      const result = memory.form({
        ...request,
        allowedMemoryIds: evidence.allowedMemoryIds,
        source: {
          id: context.itemId,
          label: evidence.label,
          referenceId: evidence.referenceId,
          type: evidence.sourceType,
        },
      });
      const modelContent = result satisfies JsonValue;
      const summaries = {
        candidate_created: "已生成待确认记忆候选",
        candidate_duplicate: "相同记忆候选已存在",
        created: "已形成长期记忆",
        duplicate: "相同记忆已存在，未重复写入",
        revised: "已更新长期记忆并保留 Revision",
      } as const;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary: summaries[result.outcome],
      });
    },
    summarize: (input) =>
      input["operation"] === "create" ? "形成长期记忆" : "更新长期记忆",
  });
}
