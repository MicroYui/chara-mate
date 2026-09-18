import type { JsonValue } from "../../shared/contracts/primitives";
import type { MemoryEvidenceReference } from "../../shared/contracts/memoryRecall";
import {
  EvidencePackSchema,
  MemoryEvidenceReferenceSchema,
} from "../../shared/schemas/memoryRecall";
import { parseSchema } from "../../shared/schemas/validation";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Inspect only typed context objects and outputs of actual memory.search calls
 * in the model input being sent. User text and unrelated tool payloads are never
 * scanned for IDs. The resulting host metadata survives checkpoint deletion. */
export function suppliedMemoryReferences(
  input: readonly JsonValue[],
): MemoryEvidenceReference[] {
  const refs: MemoryEvidenceReference[] = [];
  const calls = new Map<string, Record<string, unknown>>();
  for (const value of input) {
    const item = record(value);
    if (!item) continue;
    if (
      item["type"] === "function_call" &&
      typeof item["call_id"] === "string" &&
      (item["name"] === "memory.search" ||
        (item["namespace"] === "memory" && item["name"] === "search"))
    )
      calls.set(item["call_id"], item);
    const memory =
      item["type"] === "charamate_memory_context"
        ? item
        : item["type"] === "charamate_cognition_context"
          ? record(item["memoryEvidence"])
          : undefined;
    if (memory && Array.isArray(memory["memoryRevisions"]))
      for (const candidate of memory["memoryRevisions"]) {
        const ref = record(candidate);
        if (ref && (ref["use"] === "current" || ref["use"] === "history"))
          refs.push(parseSchema(MemoryEvidenceReferenceSchema, ref));
      }
  }
  for (const value of input) {
    const item = record(value);
    if (
      item?.["type"] !== "function_call_output" ||
      typeof item["call_id"] !== "string" ||
      typeof item["output"] !== "string"
    )
      continue;
    const call = calls.get(item["call_id"]);
    if (!call) continue;
    const result = record(JSON.parse(item["output"]) as unknown);
    if (result?.["status"] !== "success") continue;
    const pack = parseSchema(EvidencePackSchema, result["modelContent"]);
    const args =
      typeof call["arguments"] === "string"
        ? record(JSON.parse(call["arguments"]) as unknown)
        : undefined;
    const historical = new Set(
      Array.isArray(args?.["references"])
        ? args["references"].flatMap((value) => {
            const ref = record(value);
            return ref?.["use"] === "history" ? [ref["revisionId"]] : [];
          })
        : [],
    );
    refs.push(
      ...pack.items.map((item) => ({
        memoryId: item.memoryId,
        revisionId: item.revisionId,
        use:
          !item.current || historical.has(item.revisionId)
            ? ("history" as const)
            : ("current" as const),
      })),
    );
  }
  return [
    ...new Map(
      refs.map((ref) => [`${ref.memoryId}:${ref.revisionId}:${ref.use}`, ref]),
    ).values(),
  ];
}
