import type { JsonValue } from "../../shared/contracts/primitives";
import type { ModelContextLimits, ModelUsage } from "./modelProvider";

const COMPACTION_RATIO = 0.9;

export interface ContextCheckpoint {
  readonly items: readonly JsonValue[];
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
    const handoffText = [
      "Context handoff:",
      `currentProgress: ${JSON.stringify(handoff.currentProgress)}`,
      `decisions: ${JSON.stringify(handoff.decisions)}`,
      `constraints: ${JSON.stringify(handoff.constraints)}`,
      `nextSteps: ${JSON.stringify(handoff.nextSteps)}`,
    ].join("\n");
    return [
      ...(latestUser
        ? [
            {
              content: latestUser,
              role: "user",
              type: "message",
            } satisfies JsonValue,
          ]
        : []),
      {
        content: handoffText,
        role: "developer",
        type: "message",
      },
    ];
  }
}
