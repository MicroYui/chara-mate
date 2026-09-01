import { Type, type Static } from "@sinclair/typebox";

import type {
  MemorySourceType,
  MemoryType,
} from "../../shared/contracts/memory";
import type { JsonValue } from "../../shared/contracts/primitives";
import {
  MemoryClaimSlotSchema,
  MemoryTypeSchema,
} from "../../shared/schemas/memory";
import {
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import { summarizeMemoryEvidence } from "./memoryEvidenceProjection";
import type { MemoryService } from "./memoryService";

export const MEMORY_FORMATION_TOOL_NAME = "memory.record";
export const MEMORY_SEARCH_TOOL_NAME = "memory.search";

const UnscopedMemoryTypeSchema = Type.Union([
  Type.Literal("project"),
  Type.Literal("procedure"),
]);

const TimedMemoryTypeSchema = Type.Union([
  Type.Literal("event"),
  Type.Literal("commitment"),
]);

const FormationTimeZoneSchema = Type.String({
  description: "An IANA time-zone identifier such as Asia/Shanghai.",
  pattern: "^[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*$",
});

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

const stableFormationSchemas = [
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
      operation: MemoryUpdateOperationSchema,
      validFrom: Type.Optional(TimestampSchema),
      validTo: Type.Optional(TimestampSchema),
    },
    { additionalProperties: false },
  ),
];

const unscopedFormationSchemas = [
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
      operation: MemoryUpdateOperationSchema,
      type: UnscopedMemoryTypeSchema,
      validFrom: Type.Optional(TimestampSchema),
      validTo: Type.Optional(TimestampSchema),
    },
    { additionalProperties: false },
  ),
];

const timedCreateProperties = {
  basis: MemoryFormationBasisSchema,
  content: NonBlankStringSchema,
  importantMoment: Type.Boolean(),
  operation: Type.Literal("create"),
  type: TimedMemoryTypeSchema,
  validFrom: Type.Optional(TimestampSchema),
  validTo: Type.Optional(TimestampSchema),
};

const timedUpdateProperties = {
  basis: MemoryFormationBasisSchema,
  content: NonBlankStringSchema,
  importantMoment: Type.Boolean(),
  operation: MemoryUpdateOperationSchema,
  targetHint: NonBlankStringSchema,
  type: TimedMemoryTypeSchema,
  validFrom: Type.Optional(TimestampSchema),
  validTo: Type.Optional(TimestampSchema),
};

const timedFormationSchemas = [
  Type.Object(timedCreateProperties, { additionalProperties: false }),
  Type.Object(
    {
      ...timedCreateProperties,
      occursAt: TimestampSchema,
      timeZone: FormationTimeZoneSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(timedUpdateProperties, { additionalProperties: false }),
  Type.Object(
    {
      ...timedUpdateProperties,
      occursAt: TimestampSchema,
      timeZone: FormationTimeZoneSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...timedUpdateProperties,
      occursAt: Type.Null(),
      timeZone: Type.Null(),
    },
    { additionalProperties: false },
  ),
];

export const MemoryFormationInputSchema = Type.Union([
  ...stableFormationSchemas,
  ...unscopedFormationSchemas,
  ...timedFormationSchemas,
]);

type MemoryFormationToolInput = Static<typeof MemoryFormationInputSchema>;

export interface MemoryFormationEvidence {
  readonly allowedMemoryIds: readonly string[];
  readonly ambiguityMemoryIds?: readonly string[];
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
    claimSlot: Type.Optional(MemoryClaimSlotSchema),
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
        "Search the user's active long-term memory records through the single R0 retrieval path. Use at most once when the user asks about remembered personal facts, preferences, history, or what is remembered and the supplied profile/query evidence is genuinely insufficient. Rewrite the query into a concise evidence-oriented phrase; add type when useful and use asOf only for an explicitly historical question. claimSlot filters only already-bound records, so omit it when inspecting reported legacy unkeyed profile/preference records and use it only for a specific bound field. Results contain compact evidence summaries rather than internal IDs or full provenance. Do not call when supplied evidence is already sufficient, never invent or expose internal identifiers, and never treat an empty result as proof that a fact never existed.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: MemorySearchInputSchema,
      itemKind: "tool_call",
      name: MEMORY_SEARCH_TOOL_NAME,
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
          ...(hit.memory.claimSlot ? { claimSlot: hit.memory.claimSlot } : {}),
          evidence: summarizeMemoryEvidence(hit.sources),
          memoryCreatedAt: hit.memory.createdAt,
          memoryUpdatedAt: hit.memory.updatedAt,
          rank: hit.rank,
          revisionCreatedAt: hit.revision.createdAt,
          importantMoment: hit.revision.importantMoment ?? false,
          type: hit.memory.type,
          ...("occursAt" in hit.revision && "timeZone" in hit.revision
            ? {
                occursAt: hit.revision.occursAt,
                timeZone: hit.revision.timeZone,
              }
            : {}),
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
  onFormed?: (input: {
    readonly content: string;
    readonly importantMoment: boolean;
    readonly memoryId: string;
    readonly occursAt?: string;
    readonly revisionId: string;
    readonly runId: string;
    readonly timeZone?: string;
    readonly type: MemoryType;
  }) => void,
): void {
  registry.register({
    descriptor: {
      description:
        "Record durable user knowledge during the current Chat or Agent Run. For supported profile/preference fields, use the closed claimSlot whose name describes the stable field, never its value: e.g. preference.hobbies remains the same slot when A changes to B. Use create only for a genuinely new field, replace for an explicit correction or complete replacement, and append/remove only for a set-valued slot. For every update, content must be the complete post-operation memory statement, not only the added or removed fragment. For event/commitment updates, targetHint must repeat the exact current memory statement supplied in context; the host normalizes it and resolves a unique match only inside its private current-Run allowlist. Never submit, invent, or mention Memory, Revision, or source IDs. For event/commitment, provide occursAt and IANA timeZone together when the user gives a future time; omit both to preserve an existing time during update, and set both to null only when the user explicitly cancels or removes the time. Set importantMoment true only when the user explicitly says this event or commitment matters to them and has not opted out of proactive contact for this specific matter. Set it false when the user explicitly asks not to be proactively contacted about that event; keep the event content accurate and omit occursAt/timeZone to preserve its time. Other memory types cannot carry event time or importantMoment=true. An update without a uniquely resolved target becomes a review candidate. If an update conflicts with a slot, is ambiguous with another preloaded stable field, or needs to bind old unkeyed data, it becomes a review candidate instead of a second active fact. Use explicit_user_statement only for facts the user directly stated; inference and run_observation always become candidates. Never record transient requests, assistant speculation, copied material, credentials, secrets, or unchanged memories.",
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
        ...(evidence.ambiguityMemoryIds
          ? { ambiguityMemoryIds: evidence.ambiguityMemoryIds }
          : {}),
        source: {
          id: context.itemId,
          label: evidence.label,
          referenceId: evidence.referenceId,
          type: evidence.sourceType,
        },
      });
      if ("memoryId" in result) {
        const detail = memory.get(result.memoryId);
        const revision = detail.revisions.find(
          ({ id }) => id === result.revisionId,
        );
        if (!revision) {
          throw new TypeError("Formed memory revision is unavailable");
        }
        onFormed?.({
          content: revision.content,
          importantMoment: revision.importantMoment ?? false,
          memoryId: result.memoryId,
          ...("occursAt" in revision && "timeZone" in revision
            ? {
                occursAt: revision.occursAt,
                timeZone: revision.timeZone,
              }
            : {}),
          revisionId: revision.id,
          runId: context.runId,
          type: detail.memory.type,
        });
      }
      const modelContent = { outcome: result.outcome } satisfies JsonValue;
      const summaries = {
        candidate_created: "已生成待确认记忆候选",
        candidate_duplicate: "相同记忆候选已存在",
        created: "已形成长期记忆",
        duplicate: "相同记忆已存在，未重复写入",
        revised: "已更新长期记忆",
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
