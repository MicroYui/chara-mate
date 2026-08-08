import type { JsonValue } from "../../shared/contracts/primitives";
import type { ModelAllowedTool, ModelUsage } from "./modelProvider";
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
    !Array.isArray(value["boundaries"])
  ) {
    throw new TypeError("Unsupported or corrupt Agent checkpoint");
  }
  return value as unknown as RuntimeCheckpointState;
}
