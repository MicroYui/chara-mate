import type { JsonValue } from "../../shared/contracts/primitives";
import type { PlanUpdate } from "../../shared/contracts/run";
import type { ModelContextLimits, ModelUsage } from "./modelProvider";
import { isMemoryContextInput } from "./memoryContext";

const COMPACTION_RATIO = 0.9;
const CURRENT_PLAN_INPUT_PREFIX =
  "Current execution plan (authoritative latest complete snapshot):";

export interface ContextCheckpoint {
  readonly currentPlan?: PlanUpdate;
  readonly currentUserInput?: JsonValue;
  readonly items: readonly JsonValue[];
  readonly latestUserInput?: JsonValue;
  readonly lastRequestBytes?: number;
  readonly lastUsage?: ModelUsage;
  readonly recentUsers: readonly string[];
}

export interface HandoffSummary {
  readonly constraints: readonly string[];
  readonly currentProgress: readonly string[];
  readonly decisions: readonly string[];
  readonly nextSteps: readonly string[];
}

export interface CompiledContext {
  readonly compacted: boolean;
  readonly input: readonly JsonValue[];
  readonly requestBytes: number;
}

function resolvedInputBudget(limits: ModelContextLimits): number | undefined {
  if (limits.effectiveInputTokens !== undefined) {
    return limits.effectiveInputTokens;
  }
  const byContext =
    limits.maxContextTokens === undefined ||
    limits.maxOutputTokens === undefined
      ? undefined
      : limits.maxContextTokens - limits.maxOutputTokens;
  const candidates = [limits.maxPromptTokens, byContext].filter(
    (value): value is number => value !== undefined && value > 0,
  );
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function requestBytes(items: readonly JsonValue[]): number {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}

function record(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function hostStateCall(value: Readonly<Record<string, JsonValue>>): boolean {
  const name = value["name"];
  const namespace = value["namespace"];
  return (
    (name === "update" && namespace === "plan") ||
    name === "plan.update" ||
    (name === "request_user_input" &&
      (namespace === undefined || namespace === "interaction")) ||
    name === "interaction.request_user_input"
  );
}

function latestToolBoundary(items: readonly JsonValue[]): JsonValue[] {
  for (let outputIndex = items.length - 1; outputIndex >= 0; outputIndex -= 1) {
    const output = record(items[outputIndex]!);
    if (output?.["type"] !== "function_call_output") continue;
    const callId = output["call_id"];
    if (typeof callId !== "string") continue;
    for (let callIndex = outputIndex - 1; callIndex >= 0; callIndex -= 1) {
      const call = record(items[callIndex]!);
      if (call?.["type"] !== "function_call" || call["call_id"] !== callId) {
        continue;
      }
      if (hostStateCall(call)) break;
      return [items[callIndex]!, items[outputIndex]!];
    }
  }
  return [];
}

function currentPlanInput(plan: PlanUpdate): JsonValue {
  return {
    content: [CURRENT_PLAN_INPUT_PREFIX, JSON.stringify(plan)].join("\n"),
    role: "developer",
    type: "message",
  };
}

export function isCurrentPlanContextInput(value: JsonValue): boolean {
  const item = record(value);
  return (
    item?.["type"] === "message" &&
    item["role"] === "developer" &&
    typeof item["content"] === "string" &&
    item["content"].startsWith(CURRENT_PLAN_INPUT_PREFIX)
  );
}

export class ContextCompiler {
  shouldCompact(
    checkpoint: ContextCheckpoint,
    limits: ModelContextLimits,
  ): boolean {
    const budget = resolvedInputBudget(limits);
    const usage = checkpoint.lastUsage;
    const previousBytes = checkpoint.lastRequestBytes;
    if (!budget || !usage || !previousBytes || previousBytes <= 0) return false;
    const activeBytes = requestBytes(checkpoint.items);
    const estimatedTokens = (activeBytes / previousBytes) * usage.inputTokens;
    return estimatedTokens >= budget * COMPACTION_RATIO;
  }

  compile(
    checkpoint: ContextCheckpoint,
    limits: ModelContextLimits,
    handoff: HandoffSummary,
    force = false,
  ): CompiledContext {
    const compacted = force || this.shouldCompact(checkpoint, limits);
    const input = compacted
      ? this.#compact(checkpoint, handoff)
      : [...checkpoint.items];
    return { compacted, input, requestBytes: requestBytes(input) };
  }

  #compact(
    checkpoint: ContextCheckpoint,
    handoff: HandoffSummary,
  ): JsonValue[] {
    const latestUser = checkpoint.recentUsers.at(-1);
    const currentUserInput = checkpoint.currentUserInput;
    const latestUserInput = checkpoint.latestUserInput;
    const preservedInputs = [
      ...(currentUserInput ? [currentUserInput] : []),
      ...(latestUserInput &&
      JSON.stringify(latestUserInput) !== JSON.stringify(currentUserInput)
        ? [latestUserInput]
        : []),
    ];
    const handoffText = [
      "Context handoff:",
      `currentProgress: ${JSON.stringify(handoff.currentProgress)}`,
      `decisions: ${JSON.stringify(handoff.decisions)}`,
      `constraints: ${JSON.stringify(handoff.constraints)}`,
      `nextSteps: ${JSON.stringify(handoff.nextSteps)}`,
    ].join("\n");
    const memoryContext = checkpoint.items.findLast(isMemoryContextInput);
    return [
      {
        content: handoffText,
        role: "developer",
        type: "message",
      },
      ...(memoryContext ? [memoryContext] : []),
      ...latestToolBoundary(checkpoint.items),
      ...(checkpoint.currentPlan
        ? [currentPlanInput(checkpoint.currentPlan)]
        : []),
      ...(preservedInputs.length > 0
        ? preservedInputs
        : latestUser
          ? [
              {
                content: latestUser,
                role: "user",
                type: "message",
              } satisfies JsonValue,
            ]
          : []),
    ];
  }
}
