import type { JsonValue } from "../../shared/contracts/primitives";
import { isDeepStrictEqual } from "node:util";
import { IMAGE_REFERENCE_TYPE } from "./imageInput";
import type { PlanUpdate } from "../../shared/contracts/run";
import { isChatContextSummaryInput } from "../chat/chatContext";
import type {
  InputMeasurementOptions,
  ModelContextLimits,
  ModelUsage,
} from "./modelProvider";
import {
  retainedCognitionContextInputs,
  materializeCognitionContextInput,
  shareSelectedObservationBodies,
} from "./cognitionContext";
import {
  estimateInputBudget,
  fitsInputBudget,
  type InputBudgetEstimate,
  modelInputBudget,
} from "../providers/inputBudget";

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

export function resolvedInputBudget(limits: ModelContextLimits): number {
  return modelInputBudget(limits);
}

export function contextRequestBytes(items: readonly JsonValue[]): number {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}

export function estimatedInputTokens(
  estimate: InputBudgetEstimate,
  measurement?: { readonly inputTokens: number; readonly requestBytes: number },
): number {
  if (estimate.exactInputTokens !== undefined) return estimate.exactInputTokens;
  return Math.max(
    estimate.estimatedTokens,
    measurement && measurement.requestBytes > 0
      ? (estimate.wireBytes / measurement.requestBytes) *
          measurement.inputTokens
      : 0,
  );
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

export function retainedToolContextInputs(
  items: readonly JsonValue[],
): JsonValue[] {
  const retained = new Set<number>();
  const imageSources: JsonValue[] = [];
  let latestBoundaryRetained = false;
  let latestOtherBoundaryRetained = false;
  let latestFailureRetained = false;
  for (let outputIndex = items.length - 1; outputIndex >= 0; outputIndex -= 1) {
    const output = record(items[outputIndex]!);
    if (output?.["type"] !== "function_call_output") continue;
    const callId = output["call_id"];
    if (typeof callId !== "string") continue;
    for (let callIndex = outputIndex - 1; callIndex >= 0; callIndex -= 1) {
      const call = record(items[callIndex]!);
      if (call?.["type"] !== "function_call" || call["call_id"] !== callId)
        continue;
      if (hostStateCall(call)) break;
      if (!latestFailureRetained && typeof output["output"] === "string") {
        try {
          const result = record(JSON.parse(output["output"]) as JsonValue);
          if (
            result?.["status"] === "error" ||
            result?.["status"] === "rejected" ||
            result?.["status"] === "cancelled"
          ) {
            retained.add(callIndex);
            retained.add(outputIndex);
            latestFailureRetained = true;
          }
        } catch {
          // Unparseable text cannot establish a completed failure receipt.
        }
      }
      const imageInspection =
        call["name"] === "image.inspect" ||
        (call["name"] === "inspect" && call["namespace"] === "image");
      if (
        !latestBoundaryRetained ||
        (!imageInspection && !latestOtherBoundaryRetained)
      ) {
        retained.add(callIndex);
        retained.add(outputIndex);
        latestBoundaryRetained = true;
      }
      if (!imageInspection) latestOtherBoundaryRetained = true;
      if (imageInspection) {
        const raw = output["output"];
        let source: JsonValue | undefined;
        if (typeof raw === "string") {
          try {
            const result = record(JSON.parse(raw) as JsonValue);
            const content = result
              ? record(result["modelContent"] ?? null)
              : null;
            if (
              result?.["status"] === "success" &&
              content?.["loaded"] === true
            )
              source = content["source"];
          } catch {
            // A malformed receipt cannot establish an inspected image.
          }
        }
        if (
          source !== undefined &&
          !imageSources.some((value) => isDeepStrictEqual(value, source))
        ) {
          for (
            let imageIndex = items.length - 1;
            imageIndex > outputIndex;
            imageIndex -= 1
          ) {
            const message = record(items[imageIndex]!);
            const content = message?.["content"];
            if (
              message?.["type"] === "message" &&
              Array.isArray(content) &&
              content.some((part) => {
                const reference = record(part);
                return (
                  reference?.["type"] === IMAGE_REFERENCE_TYPE &&
                  isDeepStrictEqual(reference["source"], source)
                );
              })
            ) {
              retained.add(callIndex);
              retained.add(outputIndex);
              retained.add(imageIndex);
              imageSources.push(source);
              break;
            }
          }
        }
      }
      break;
    }
  }
  // Keep successful reads across intervening Tools, in their original order.
  // Only this checkpoint's actual references qualify; caches/history do not.
  return [...retained]
    .sort((left, right) => left - right)
    .map((index) => items[index]!);
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

export type ContextInputMeasurement = (
  input: readonly JsonValue[],
  options?: InputMeasurementOptions,
) => Promise<InputBudgetEstimate>;

export async function shouldCompactContextInput(
  input: readonly JsonValue[],
  budget: number,
  measure: ContextInputMeasurement,
  previousUsage?: {
    readonly inputTokens: number;
    readonly requestBytes: number;
  },
): Promise<boolean> {
  let measurement = await measure(input);
  const fits = (value: InputBudgetEstimate) =>
    fitsInputBudget(
      {
        ...value,
        estimatedTokens: estimatedInputTokens(value, previousUsage),
      },
      budget,
    );
  if (fits(measurement)) return false;
  if (measurement.exactInputTokens === undefined) {
    measurement = await measure(input, { requireExact: true });
  }
  return !fits(measurement);
}

function measureContextInput(
  input: readonly JsonValue[],
): Promise<InputBudgetEstimate> {
  return Promise.resolve(
    estimateInputBudget(
      shareSelectedObservationBodies(input).map(
        materializeCognitionContextInput,
      ),
    ),
  );
}

export class ContextCompiler {
  async shouldCompact(
    checkpoint: ContextCheckpoint,
    limits: ModelContextLimits,
    measure: ContextInputMeasurement = measureContextInput,
  ): Promise<boolean> {
    const budget = resolvedInputBudget(limits);
    const usage = checkpoint.lastUsage;
    const previousBytes = checkpoint.lastRequestBytes;
    return shouldCompactContextInput(
      checkpoint.items,
      budget,
      measure,
      usage?.inputTokens !== undefined && previousBytes && previousBytes > 0
        ? { inputTokens: usage.inputTokens, requestBytes: previousBytes }
        : undefined,
    );
  }

  async compile(
    checkpoint: ContextCheckpoint,
    limits: ModelContextLimits,
    handoff: HandoffSummary,
    force = false,
    measure: ContextInputMeasurement = measureContextInput,
  ): Promise<CompiledContext> {
    const compacted =
      force || (await this.shouldCompact(checkpoint, limits, measure));
    const input = compacted
      ? this.#compact(checkpoint, handoff)
      : [...checkpoint.items];
    return {
      compacted: compacted && !isDeepStrictEqual(input, checkpoint.items),
      input,
      requestBytes: (await measure(input)).wireBytes,
    };
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
    const chatContext = checkpoint.items.find(isChatContextSummaryInput);
    const memoryContexts = retainedCognitionContextInputs(checkpoint.items);
    return [
      {
        content: handoffText,
        role: "developer",
        type: "message",
      },
      ...(chatContext ? [chatContext] : []),
      ...memoryContexts,
      ...retainedToolContextInputs(checkpoint.items),
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
