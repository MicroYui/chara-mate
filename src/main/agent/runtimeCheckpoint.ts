import type { JsonValue } from "../../shared/contracts/primitives";
import type { PlanUpdate, UserInputQuestion } from "../../shared/contracts/run";
import { PlanUpdateSchema } from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
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

export interface PendingInputRequest {
  readonly callId: string;
  readonly itemId: string;
  readonly questions: readonly UserInputQuestion[];
}

export interface RuntimeCheckpointState {
  readonly allowedTools?: readonly ModelAllowedTool[];
  readonly boundaries: readonly LoopBoundary[];
  readonly contextLimits?: ModelContextLimits;
  readonly currentPlan?: PlanUpdate;
  readonly currentUserInput?: JsonValue;
  readonly forcedCompactionAttempted: boolean;
  readonly handoff: HandoffSummary;
  readonly input: readonly JsonValue[];
  readonly latestUserInput?: JsonValue;
  readonly lastRequestBytes?: number;
  readonly lastUsage?: ModelUsage;
  readonly pendingTool?: PendingToolCall;
  readonly pendingInput?: PendingInputRequest;
  readonly recentUsers: readonly string[];
  readonly recoveryAttemptedKeys: readonly string[];
  readonly toolNames?: readonly string[];
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
  const validNumbers = [
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
  return (
    validNumbers &&
    (value["supportsVision"] === undefined ||
      typeof value["supportsVision"] === "boolean")
  );
}

function validCurrentPlan(value: JsonValue | undefined): boolean {
  if (value === undefined) return true;
  try {
    const update = parseSchema(PlanUpdateSchema, value);
    return (
      update.plan.filter(({ status }) => status === "in_progress").length <= 1
    );
  } catch {
    return false;
  }
}

function validToolNames(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((name) => typeof name === "string" && name.length > 0) &&
      new Set(value).size === value.length)
  );
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
    !validContextLimits(value["contextLimits"]) ||
    !validCurrentPlan(value["currentPlan"]) ||
    !validToolNames(value["toolNames"])
  ) {
    throw new TypeError("Unsupported or corrupt Agent checkpoint");
  }
  return value as unknown as RuntimeCheckpointState;
}
