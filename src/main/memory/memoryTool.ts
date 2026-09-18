import { Type } from "@sinclair/typebox";

import type {
  EvidencePack,
  MemoryFormationIntake,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolResult } from "../../shared/contracts/tool";
import {
  RecallQuestionSchema,
  RecallTimeScopeSchema,
  RecallPlanSchema,
} from "../../shared/schemas/memoryRecall";
import { EntityIdSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import {
  fitsInputBudget,
  INPUT_BUDGET_ESTIMATE_RATIO,
} from "../providers/inputBudget";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { MemoryEpisodeFormationResult } from "./memoryFormationService";
import {
  memoryRecallQuestions,
  unsearchedMemoryPack,
} from "./memoryRecallPipeline";
import type { MemoryService } from "./memoryService";

export const MEMORY_FORMATION_TOOL_NAME = "memory.record";
export const MEMORY_SEARCH_TOOL_NAME = "memory.search";

const MemorySearchInputSchema = Type.Object(
  {
    query: RecallPlanSchema.properties.query,
    questions: Type.Optional(Type.Array(RecallQuestionSchema)),
    references: RecallPlanSchema.properties.references,
    entityNames: RecallPlanSchema.properties.entityNames,
    entityIds: RecallPlanSchema.properties.entityIds,
    timeScope: Type.Optional(RecallTimeScopeSchema),
    owner: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("character")]),
    ),
    excludeRevisionIds: Type.Optional(Type.Array(EntityIdSchema)),
  },
  {
    additionalProperties: false,
    anyOf: [
      { properties: { query: { type: "string", pattern: "\\S" } } },
      {
        required: ["references", "questions"],
        properties: {
          references: { type: "array", minItems: 1 },
          questions: { type: "array", minItems: 1 },
        },
      },
    ],
  },
);

export type MemoryRecallContextResolver = (
  runId: string,
) => Pick<RecallPlan, "personaId" | "situationId">;
export type MemoryFormationEpisodeResolver = (
  runId: string,
  itemId: string,
) =>
  | MemoryFormationIntake
  | undefined
  | Promise<MemoryFormationIntake | undefined>;

function memorySearchResult(evidence: EvidencePack): ToolResult {
  const modelContent = evidence satisfies JsonValue;
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary: evidence.items.length
      ? `找到 ${String(evidence.items.length)} 条相关记忆`
      : "本次未供给记忆证据，请查看覆盖范围与原因",
  };
}

export function registerMemoryTool(
  registry: ToolRegistry,
  memory: MemoryService,
  resolveContext: MemoryRecallContextResolver,
): void {
  registry.register({
    descriptor: {
      description:
        "Recall relevant companion memories with source evidence. To read supplied Memory/Revision IDs, use references and questions; an empty query reads only those exact records. A nonempty query additionally searches related memories. Unknown or changed current references remain unavailable, never silently replaced. Search entityIds identify people/things, never Memory/Revision/source/Chat IDs. Entity IDs, resolved entityNames and occurrence bounds filter every related-search question; supply them only for a known scope required by all questions. Keep mere mentions, associations and uncertain relative times in query/questions; do not guess source time zones. Search timeScope independently constrains event occurrence, validity and recorded knowledge; occurredTo=now excludes future plans even when already known. These filters do not constrain exact references. For comparisons or multiple hops, provide separate questions. Use includeSuperseded when asking how something changed, and knownAt only for what was known at a past time. Missing evidence is not proof an event never occurred. Assess coverage and incompleteReasons; use another purposeful search if an important question is still unresolved. Inferences are interpretations, not confirmed user facts. Actual Chat replies and Run delivery require their owner receipts, not assumptions from missing memories. Internal revision/source IDs support follow-up and must not be recited to the user. The host allocates evidence context; never request all profile facts by default.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: MemorySearchInputSchema,
      itemKind: "tool_call",
      name: MEMORY_SEARCH_TOOL_NAME,
      namespace: "memory",
      source: "builtin",
      summary: "回忆相关经历与事实",
    },
    execute: async (input, context) => {
      const request = parseSchema(MemorySearchInputSchema, input);
      const measureResult = context.measureResult;
      if (!measureResult)
        throw new Error(
          "Memory search requires the current Tool result measurement owner",
        );
      context.signal.throwIfAborted();
      const questions = memoryRecallQuestions(request);
      const unsearched = memorySearchResult(unsearchedMemoryPack(questions));
      const initial = await measureResult(unsearched);
      context.signal.throwIfAborted();
      if (!fitsInputBudget(initial.measurement, initial.inputBudgetTokens))
        throw new RangeError("当前工作集无法容纳记忆检索结果及其缺口说明");
      // This is only the Selector's current reference, not an items-only final
      // gate. The consumer measures every complete, normalized ToolResult.
      const remaining =
        initial.measurement.exactInputTokens !== undefined
          ? initial.inputBudgetTokens - initial.measurement.exactInputTokens
          : Math.floor(
              initial.inputBudgetTokens * INPUT_BUDGET_ESTIMATE_RATIO,
            ) - initial.measurement.estimatedTokens;
      if (remaining <= 0) return unsearched;
      const evidence = await memory.recall(
        {
          ...request,
          purpose: "recollection",
          questions,
          ...resolveContext(context.runId),
          contextBudget: { maxTokens: remaining },
        },
        context.signal,
        "tool",
        {
          // Preserve the former ordinary Tool's candidate workload; changing
          // the final delivery allowance does not select a new candidate pool.
          candidateBudgetTokens: 32_000,
          fits: async (pack) => {
            context.signal.throwIfAborted();
            const observed = await measureResult(memorySearchResult(pack));
            context.signal.throwIfAborted();
            return fitsInputBudget(
              observed.measurement,
              observed.inputBudgetTokens,
            );
          },
        },
      );
      context.signal.throwIfAborted();
      return memorySearchResult(evidence);
    },
    summarize: (input) =>
      `回忆相关经历${typeof input["query"] === "string" && input["query"].trim() ? `：${input["query"]}` : ""}`,
  });
}

const MemoryRecordInputSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export function registerMemoryFormationTool(
  registry: ToolRegistry,
  memory: MemoryService,
  resolveEpisode: MemoryFormationEpisodeResolver,
  onFormed?: (result: MemoryEpisodeFormationResult & { runId: string }) => void,
): void {
  registry.register({
    descriptor: {
      description:
        "Form or update durable memories from the current conversation's actual source episode. Call when the user supplies meaningful events, facts, preferences or commitments, changes a previous fact, or asks you to remember. The host retrieves source text, resolves evidence-backed revisions and retains context. This tool takes no model-authored memory text or invented source IDs. Assistant repetition does not confirm a fact. Use the returned result before claiming something was remembered. Saved changes confirm source-backed revisions are persisted; semantic indexing proceeds in the background. replayed means this source episode was already processed. unavailableChanges are previous revisions later changed, archived or deleted; they were not restored and must not be claimed as saved current facts. retrievalIncompleteReasons means comparison with earlier memories was incomplete, not that saved evidence was lost; never claim every old conflict was resolved in that state. No durable new information can correctly produce zero changes.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: MemoryRecordInputSchema,
      itemKind: "tool_call",
      name: MEMORY_FORMATION_TOOL_NAME,
      namespace: "memory",
      source: "builtin",
      summary: "记住这段经历",
    },
    execute: async (input, context) => {
      parseSchema(MemoryRecordInputSchema, input);
      const episode = await resolveEpisode(context.runId, context.itemId);
      const work = episode ? memory.enqueueEpisode(episode) : undefined;
      // Replayed Tool results never enter execute. A real new call may retry
      // only its actual source work; completed receipts and running work retain
      // their existing idempotency and the committed source cursor.
      if (work) memory.retryFailedFormationWork(work.workId);
      const result = work
        ? await memory.formEpisode(work.workId, context.signal)
        : { changes: [] };
      onFormed?.({ ...result, runId: context.runId });
      const unavailableChanges = result.unavailableChanges ?? [];
      const modelContent = {
        changes: result.changes,
        replayed: result.replayed ?? false,
        unavailableChanges,
        ...("processorVersion" in result && result.processorVersion
          ? { processorVersion: result.processorVersion }
          : {}),
        ...("processorTransitions" in result && result.processorTransitions
          ? { processorTransitions: result.processorTransitions }
          : {}),
        ...("retrievalIncompleteReasons" in result
          ? {
              retrievalIncompleteReasons:
                result.retrievalIncompleteReasons ?? [],
            }
          : {}),
        storage: result.changes.length
          ? "source_and_revision_committed"
          : unavailableChanges.length
            ? "prior_result_changed"
            : "no_new_revision",
        indexing: "asynchronous",
      } satisfies JsonValue;
      return {
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success",
        summary: result.changes.length
          ? unavailableChanges.length
            ? "记忆已有有效修订，部分此前结果已被修改或移除"
            : result.replayed
              ? "这段内容已经有对应的记忆"
              : "已根据原始证据更新记忆"
          : unavailableChanges.length
            ? "此前形成的记忆已被修改、归档或删除，未重新写入"
            : "这段内容没有新增的长期记忆",
      };
    },
    summarize: () => "记住这段经历",
  });
}
