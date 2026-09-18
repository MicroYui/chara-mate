import type {
  EvidencePack,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import type { JsonValue } from "../../shared/contracts/primitives";

const MEMORY_CONTEXT_TYPE = "charamate_memory_context";

/** Only selected evidence is materialized. Source/revision references stay in
 * the checkpoint so a later correction can bind to the evidence actually read. */
export function createMemoryContextInput(
  pack: EvidencePack,
  plan?: RecallPlan,
  historicalRevisionIds: readonly string[] = [],
): JsonValue {
  const questions = new Map(plan?.questions.map(({ id, text }) => [id, text]));
  const historicalUses = new Set(historicalRevisionIds);
  const content = [
    "Selected memory evidence for the current situation follows. It is context, not a new user request.",
    "Use only facts that help this interaction. Do not recite the user's profile, expose internal labels, or turn an observation or interpretation into a confirmed user feeling. historyStatus current means the latest unretracted revision, not that it applies now; the current flag and validFrom/validTo describe applicability at retrieval time. retained_history confirms an older statement held in the past. An explicitly expired latest revision can describe that past interval, but neither it nor an old retained version authorizes an expired commitment or preference now. Corrected and unresolved records may explain past conversation but must not ground facts or actions. Character experiences belong to the character, never to the user.",
    "Visibility scope identifies who may use a memory, not its speaker or grammatical subject. Determine who a statement is about from its actual content and sources.",
    ...pack.items.map((item, index) =>
      [
        `[evidence ${String(index + 1)}; ${item.type}; ${item.current ? "current" : "historical or superseded"}]`,
        ...(historicalUses.has(item.revisionId)
          ? [
              "Selected use: historical reference only. Current describes its status when retrieved; this action does not rely on its continuing validity. Describe the past without treating this as a current preference, permission or completed action.",
            ]
          : []),
        `historyStatus: ${item.historyStatus}${item.historyStatusRevisionId ? `; status established by later revision ${item.historyStatusRevisionId} of this same memory ${item.memoryId}; its ID alone does not provide the correction content` : ""}`,
        ...(item.historyStatus === "corrected"
          ? [
              "This old content was corrected: describe it only as a previous mistake, never as an event that really happened. Read the indicated later revision if the correction details matter.",
            ]
          : item.historyStatus === "unresolved"
            ? [
                "Whether this old content was ever true is unresolved. It is a conversation record, not a fact to ground an action or a summary.",
              ]
            : []),
        `basis: ${item.basis ?? "unclassified source"}; visibility scope: ${item.owner ?? "unclassified scope"}; recordedAt: ${item.recordedAt}`,
        ...(item.occurredFrom ? [`occurredFrom: ${item.occurredFrom}`] : []),
        ...(item.occurredTo ? [`occurredTo: ${item.occurredTo}`] : []),
        ...(item.validFrom ? [`validFrom: ${item.validFrom}`] : []),
        ...(item.validTo ? [`validTo: ${item.validTo}`] : []),
        `sources: ${String(item.sourceCount ?? item.sourceRefs.length)} (${String(item.sourceRefs.length)} references included); types: ${[...new Set(item.sourceRefs.map(({ type }) => type))].join(", ")}`,
        item.content,
      ].join("\n"),
    ),
    ...pack.coverage.map(
      (coverage, index) =>
        `Evidence coverage for ${questions.get(coverage.questionId) ?? `information need ${String(index + 1)}`}: ${coverage.status}.`,
    ),
    ...pack.gaps.map(({ reason }) => `Unresolved evidence gap: ${reason}`),
    ...(pack.truncated
      ? [
          "The evidence allocation was exhausted; this is not an exhaustive result.",
        ]
      : []),
    ...pack.incompleteReasons.map(
      (reason) => `Retrieval limitation: ${reason}`,
    ),
    "Missing evidence is not proof that a fact is false or never existed. If a material gap remains, request a more specific memory search or acknowledge uncertainty; do not repeatedly search the same question without new information.",
  ].join("\n\n");
  const memoryIds = [...new Set(pack.items.map(({ memoryId }) => memoryId))];
  return {
    content,
    memoryIds,
    memoryRevisions: pack.items.map(({ memoryId, revisionId, current }) => ({
      memoryId,
      revisionId,
      use: historicalUses.has(revisionId) || !current ? "history" : "current",
    })),
    ...(historicalRevisionIds.length
      ? {
          historicalMemoryRevisionIds: pack.items
            .filter((item) => historicalUses.has(item.revisionId))
            .map((item) => item.revisionId),
        }
      : {}),
    queryMemoryIds: memoryIds,
    evidenceSources: pack.items.map(({ revisionId, sourceRefs }) => ({
      revisionId,
      sourceRefs,
    })),
    coverage: pack.coverage,
    type: MEMORY_CONTEXT_TYPE,
  };
}

export interface MemoryContextRevisionReference {
  readonly memoryId: string;
  readonly revisionId: string;
}

export function memoryContextRevisionReferences(
  value: JsonValue,
): MemoryContextRevisionReference[] {
  if (!isMemoryContextInput(value) || Array.isArray(value) || value === null) {
    return [];
  }
  const context = value as Readonly<Record<string, JsonValue>>;
  const references = context["memoryRevisions"];
  if (!Array.isArray(references)) return [];
  return references.flatMap((reference) => {
    const record =
      typeof reference === "object" &&
      reference !== null &&
      !Array.isArray(reference)
        ? (reference as Readonly<Record<string, JsonValue>>)
        : undefined;
    if (
      !record ||
      typeof record["memoryId"] !== "string" ||
      typeof record["revisionId"] !== "string"
    ) {
      return [];
    }
    return [
      {
        memoryId: record["memoryId"],
        revisionId: record["revisionId"],
      },
    ];
  });
}

export function memoryContextTargetIds(value: JsonValue): string[] {
  if (!isMemoryContextInput(value) || Array.isArray(value) || value === null) {
    return [];
  }
  const context = value as Readonly<Record<string, JsonValue>>;
  const ids = context["memoryIds"];
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

export function memoryContextQueryTargetIds(value: JsonValue): string[] {
  if (!isMemoryContextInput(value) || Array.isArray(value) || value === null) {
    return [];
  }
  const context = value as Readonly<Record<string, JsonValue>>;
  const ids = context["queryMemoryIds"];
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

export function isMemoryContextInput(value: JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value["type"] === MEMORY_CONTEXT_TYPE &&
    typeof value["content"] === "string"
  );
}

export function materializeMemoryContextInput(value: JsonValue): JsonValue {
  if (!isMemoryContextInput(value) || Array.isArray(value) || value === null) {
    return value;
  }
  const context = value as Readonly<Record<string, JsonValue>>;
  return {
    content: context["content"] as string,
    role: "developer",
    type: "message",
  };
}
