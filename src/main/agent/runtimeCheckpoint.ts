import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  ModelAllowedTool,
  ModelContextLimits,
  ModelUsage,
} from "./modelProvider";
import type { HandoffSummary } from "./contextCompiler";
import type { LoopBoundary } from "./loopGuard";

export interface PendingToolCall {
  readonly approvalId?: string;
  readonly approvalItemId?: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly callId: string;
  readonly name: string;
  readonly rawItem: JsonValue;
  readonly toolItemId?: string;
}

export interface RuntimeCheckpointState {
  readonly allowedTools?: readonly ModelAllowedTool[];
  readonly boundaries: readonly LoopBoundary[];
  readonly contextLimits?: ModelContextLimits;
  readonly forcedCompactionAttempted: boolean;
  readonly handoff: HandoffSummary;
  readonly input: readonly JsonValue[];
  readonly lastRequestBytes?: number;
  readonly lastUsage?: ModelUsage;
  readonly pendingTool?: PendingToolCall;
  readonly recentUsers: readonly string[];
  readonly recoveryAttemptedKeys: readonly string[];
  readonly version: 1;
}

export function checkpointJson(state: RuntimeCheckpointState): JsonValue {
  return JSON.parse(JSON.stringify(state)) as JsonValue;
}

function validContextLimits(value: JsonValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return [
    "effectiveInputTokens",
    "maxContextTokens",
    "maxOutputTokens",
    "maxPromptTokens",
  ].every((name) => {
    const limit = value[name];
    return (
      limit === undefined ||
      (typeof limit === "number" && Number.isInteger(limit) && limit > 0)
    );
  });
}

export function decodeRuntimeCheckpoint(
  value: JsonValue,
): RuntimeCheckpointState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value["version"] !== 1 ||
    !Array.isArray(value["input"]) ||
    !Array.isArray(value["recentUsers"]) ||
    !Array.isArray(value["boundaries"]) ||
    !validContextLimits(value["contextLimits"])
  ) {
    throw new TypeError("Unsupported or corrupt Agent checkpoint");
  }
  return value as unknown as RuntimeCheckpointState;
}
