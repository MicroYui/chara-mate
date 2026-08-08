import { createHash } from "node:crypto";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolEffect, ToolResult } from "../../shared/contracts/tool";

export interface LoopBoundary {
  readonly retryable: boolean;
  readonly signature: string;
  readonly toolName: string;
}

export interface DetectedToolCycle {
  readonly boundaries: readonly LoopBoundary[];
  readonly key: string;
  readonly period: number;
}

const REPEAT_COUNT = 5;
const MAX_PERIOD = 5;

const SEMANTIC_NOISE_KEYS = new Set([
  "attempt",
  "request_id",
  "retry_count",
  "timestamp",
  "trace_id",
]);

function stableSemanticValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SEMANTIC_NOISE_KEYS.has(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableSemanticValue(entry)]),
  );
}

export function semanticToolSignature(
  toolName: string,
  effect: ToolEffect,
  input: Readonly<Record<string, JsonValue>>,
  result: ToolResult,
): string {
  const semantic = JSON.stringify({
    effect,
    error: result.error?.code ?? null,
    input: stableSemanticValue(input),
    outcome: result.status,
    toolName,
  });
  return `${toolName}:${createHash("sha256").update(semantic).digest("hex")}`;
}

export function detectToolCycle(
  boundaries: readonly LoopBoundary[],
): DetectedToolCycle | undefined {
  for (let period = 1; period <= MAX_PERIOD; period += 1) {
    const windowLength = period * REPEAT_COUNT;
    if (boundaries.length < windowLength) continue;
    const window = boundaries.slice(-windowLength);
    const pattern = window.slice(0, period).map(({ signature }) => signature);
    const repeated = window.every(
      ({ signature }, index) => signature === pattern[index % period],
    );
    if (!repeated) continue;
    return {
      boundaries: window,
      key: pattern.join(" -> "),
      period,
    };
  }
  return undefined;
}
