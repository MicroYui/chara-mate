import type { ModelContextLimits } from "../agent/modelProvider";

// User requirement, 2026-09-15. This is not a Provider pricing threshold.
export const MAX_MODEL_INPUT_TOKENS = 258_000;
// A local safety margin for estimates, not an exact tokenizer guarantee.
export const INPUT_BUDGET_ESTIMATE_RATIO = 0.9;

export interface InputBudgetEstimate {
  readonly estimatedTokens: number;
  /** Completed count of this exact token-bearing wire, never a usage projection. */
  readonly exactInputTokens?: number;
  readonly unknownKinds: readonly string[];
  readonly wireBytes: number;
}

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function modelInputBudget(
  limits: ModelContextLimits,
  requestedOutputTokens?: number,
): number {
  const candidates = [
    MAX_MODEL_INPUT_TOKENS,
    limits.effectiveInputTokens,
    limits.maxPromptTokens,
  ].filter(positive);
  if (positive(limits.maxContextTokens)) {
    const output = requestedOutputTokens ?? limits.maxOutputTokens ?? 0;
    candidates.push(Math.max(0, limits.maxContextTokens - Math.max(0, output)));
  }
  return Math.floor(Math.min(...candidates));
}

// Official images-vision guide, checked 2026-09-15: accepted patch-based images
// have at most 30,000 patches; these exact model IDs use a 1.2 multiplier.
// One extra token covers the documented rounding difference. This budgets an
// accepted image; it does not promise that an oversized image will be accepted.
const PATCH_IMAGE_MODELS = new Set([
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
]);
const ACCEPTED_PATCH_IMAGE_TOKENS = 30_000 * 1.2 + 1;

/** Measures the whole submitted payload conservatively, not exact model tokens. */
export function estimateInputBudget(
  payload: unknown,
  modelId?: string,
): InputBudgetEstimate {
  const unknown = new Set<string>();
  let imageTokens = 0;
  let objects = 0;
  const project = (value: unknown, inSchema = false): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => project(entry, inSchema));
    }
    if (typeof value !== "object" || value === null) return value;
    objects += 1;
    const item = value as Readonly<Record<string, unknown>>;
    const type = item["type"];
    if (!inSchema && type === "input_image") {
      if (modelId && PATCH_IMAGE_MODELS.has(modelId)) {
        imageTokens += ACCEPTED_PATCH_IMAGE_TOKENS;
      } else {
        unknown.add("image_model");
      }
      // Base64 and remote URLs do not describe visual token consumption.
      return { type, detail: item["detail"] };
    }
    if (
      !inSchema &&
      (type === "input_file" ||
        type === "input_audio" ||
        type === "input_video" ||
        type === "item_reference" ||
        type === "compaction")
    ) {
      unknown.add(String(type));
    }
    for (const key of [
      "encrypted_content",
      "reasoning_opaque",
      "previous_response_id",
      "conversation",
    ]) {
      if (!inSchema && item[key] !== undefined && item[key] !== null) {
        unknown.add(key);
      }
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [
        key,
        // Schemas describe data; names such as conversation or input_image
        // inside them are ordinary prompt text, not hidden or visual content.
        project(
          entry,
          inSchema ||
            key === "parameters" ||
            key === "schema" ||
            key === "inputSchema",
        ),
      ]),
    );
  };
  const projected = project(payload);
  const wireBytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  const textBytes = Buffer.byteLength(JSON.stringify(projected) ?? "", "utf8");
  return {
    // UTF-8 bytes deliberately avoid English/CJK/compression ratio inference.
    // Framing reserve is a CharaMate heuristic, not a documented token formula.
    estimatedTokens: textBytes + imageTokens + 256 + objects * 16,
    unknownKinds: [...unknown],
    wireBytes,
  };
}

export function fitsInputBudget(
  estimate: InputBudgetEstimate,
  budget: number,
): boolean {
  if (estimate.exactInputTokens !== undefined) {
    return (
      Number.isSafeInteger(estimate.exactInputTokens) &&
      estimate.exactInputTokens >= 0 &&
      estimate.exactInputTokens <= budget
    );
  }
  return (
    estimate.unknownKinds.length === 0 &&
    estimate.estimatedTokens < Math.floor(budget * INPUT_BUDGET_ESTIMATE_RATIO)
  );
}
