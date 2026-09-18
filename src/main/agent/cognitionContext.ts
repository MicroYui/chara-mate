import { isDeepStrictEqual } from "node:util";
import { CognitionEvidenceSchema } from "../../shared/schemas/cognition";
import { TerritoryPetActionObservationSchema } from "../../shared/schemas/territoryWorld";
import { ToolResultSchema } from "../../shared/schemas/tool";
import { parseSchema } from "../../shared/schemas/validation";
import type { CognitionPreparedContext } from "../../shared/contracts/cognition";
import type { JsonValue } from "../../shared/contracts/primitives";
import { createMemoryContextInput } from "./memoryContext";
import {
  estimateInputBudget,
  INPUT_BUDGET_ESTIMATE_RATIO,
  modelInputBudget,
  type InputBudgetEstimate,
} from "../providers/inputBudget";
import type { ModelContextLimits } from "./modelProvider";

// Local raw-value read allowance selected in COGNITION-DYNAMIC-ACTION-BUDGET.
// This is independent of the Provider's complete-request token limit.
export const LOCAL_COGNITION_READ_BUDGET_BYTES = 16 * 1024 * 1024;

const CONTEXT_TYPE = "charamate_cognition_context";

/** Optional material shares the remaining space of the actual complete request. */
export function cognitionContextTokenHeadroom(
  shell: InputBudgetEstimate,
  limits: ModelContextLimits,
): number {
  const total = modelInputBudget(limits);
  return Math.max(
    0,
    (shell.exactInputTokens === undefined
      ? Math.floor(total * INPUT_BUDGET_ESTIMATE_RATIO)
      : total) - (shell.exactInputTokens ?? shell.estimatedTokens),
  );
}

export function createCognitionContextInput(
  context: CognitionPreparedContext,
): JsonValue {
  const evidence = context.evidencePack
    ? createMemoryContextInput(
        context.evidencePack,
        context.recallPlan,
        context.historicalMemoryRevisionIds,
      )
    : undefined;
  const evidenceText =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? evidence["content"]
      : undefined;
  return {
    type: CONTEXT_TYPE,
    content: [
      context.text,
      ...(typeof evidenceText === "string" ? [evidenceText] : []),
    ].join("\n\n"),
    situationIds: context.situationIds,
    intentIds: context.intentIds,
    evidenceIds: context.evidenceIds,
    ...(context.decisionAttemptId
      ? { decisionAttemptId: context.decisionAttemptId }
      : {}),
    ...(evidence ? { memoryEvidence: evidence } : {}),
  };
}

export function isCognitionContextInput(value: JsonValue): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value["type"] === CONTEXT_TYPE &&
    typeof value["content"] === "string"
  );
}

/** Ordinary state can be refreshed; a selected action's basis must survive it. */
export function isOrdinaryCognitionContextInput(value: JsonValue): boolean {
  return (
    isCognitionContextInput(value) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value["decisionAttemptId"] !== "string"
  );
}

export function retainedCognitionContextInputs(
  input: readonly JsonValue[],
): JsonValue[] {
  const latestOrdinary = input.findLastIndex(isOrdinaryCognitionContextInput);
  return input.filter(
    (value, index) =>
      isCognitionContextInput(value) &&
      (!isOrdinaryCognitionContextInput(value) || index === latestOrdinary),
  );
}

export function materializeCognitionContextInput(value: JsonValue): JsonValue {
  if (
    !isCognitionContextInput(value) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return value;
  return {
    type: "message",
    role: "developer",
    content: value["content"] as string,
  };
}

/** Same conservative estimate as the Provider, over the actual developer message.
 * Checkpoint provenance and its duplicate Memory metadata are not model input. */
export function estimatedCognitionContextTokens(
  context: CognitionPreparedContext,
): number {
  return estimateInputBudget(
    materializeCognitionContextInput(createCognitionContextInput(context)),
  ).estimatedTokens;
}

function object(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

/** Expand the existing Tool projection solely to check its complete domain shape.
 * No geometry is recomputed and no missing field is invented. */
function completeObservation(value: JsonValue | undefined) {
  const body = object(value);
  if (!body || !Array.isArray(body["nodeGroups"])) return undefined;
  const groups = body["nodeGroups"];
  const nodes: JsonValue[] = [];
  for (const groupValue of groups) {
    const group = object(groupValue);
    const shared = object(group?.["shared"]);
    if (!shared || !Array.isArray(group?.["nodes"])) return undefined;
    for (const nodeValue of group["nodes"]) {
      const node = object(nodeValue);
      if (
        !node ||
        !object(shared["placement"]) ||
        !object(node["placement"]) ||
        !object(shared["layout"]) ||
        !object(node["layout"])
      )
        return undefined;
      nodes.push({
        ...shared,
        ...node,
        placement: {
          ...object(shared["placement"]),
          ...object(node["placement"]),
        },
        layout: { ...object(shared["layout"]), ...object(node["layout"]) },
      });
    }
  }
  const context = { ...body };
  delete context["nodeGroups"];
  try {
    const observation = parseSchema(TerritoryPetActionObservationSchema, {
      ...context,
      nodes,
    });
    return { body, groups, zoneId: observation.zone.id };
  } catch {
    return undefined;
  }
}

const OBSERVATION_SHARING_DESCRIPTION =
  "Within the selected historical evidence above, a nodeGroup {sameAsObservation:{callId,nodeGroupIndex}} means the entire group is exactly equal, field for field and in node order, to modelContent.nodeGroups[nodeGroupIndex] (zero-based) in that successful territory.observe Tool result in this request. Expand it by copying that whole group. Only its identical body is shared; all original evidence identity, use, time, revision, targets and differing groups remain historical. This is not a claim that the old target or old revision is still current.";

/** Lossless, request-local sharing. Checkpoints and Trace keep their original
 * complete values; references never outlive the actual Tool output here. */
export function shareSelectedObservationBodies(
  input: readonly JsonValue[],
): JsonValue[] {
  const reads = new Map<
    string,
    { callId: string; index: number; groups: Map<string, number> }
  >();
  for (let index = 0; index < input.length; index += 1) {
    const output = object(input[index]);
    if (
      output?.["type"] !== "function_call_output" ||
      typeof output["call_id"] !== "string" ||
      typeof output["output"] !== "string"
    )
      continue;
    const callId = output["call_id"];
    const call = input.slice(0, index).findLast((value) => {
      const item = object(value);
      return item?.["type"] === "function_call" && item["call_id"] === callId;
    });
    const request = object(call);
    if (
      !request ||
      !(
        request["name"] === "territory.observe" ||
        (request["name"] === "observe" && request["namespace"] === "territory")
      )
    )
      continue;
    try {
      if (
        typeof request["arguments"] !== "string" ||
        !isDeepStrictEqual(JSON.parse(request["arguments"]), {})
      )
        continue;
      const result = parseSchema(
        ToolResultSchema,
        JSON.parse(output["output"]),
      );
      if (result.status !== "success") continue;
      const observation = completeObservation(result.modelContent);
      if (!observation) continue;
      reads.set(observation.zoneId, {
        callId,
        index,
        groups: new Map(
          observation.groups.map((group, groupIndex) => [
            JSON.stringify(group),
            groupIndex,
          ]),
        ),
      });
    } catch {
      // Failed, incomplete or malformed reads cannot establish equal scope.
    }
  }
  if (reads.size === 0) return [...input];
  return input.map((value, contextIndex) => {
    const context = object(value);
    if (
      !isCognitionContextInput(value) ||
      typeof context?.["decisionAttemptId"] !== "string" ||
      typeof context["content"] !== "string"
    )
      return value;
    // This line is host-authored by readSelectedActionMaterial. Preserve both
    // its introductory contract and any appended Memory evidence verbatim.
    const lines = context["content"].split("\n");
    if (
      !lines[0]?.startsWith("Selected decision material follows.") ||
      !lines[1]
    )
      return value;
    try {
      const material = object(JSON.parse(lines[1]) as JsonValue);
      if (!material || !Array.isArray(material["evidence"])) return value;
      let shared = false;
      const evidence = material["evidence"].map((entryValue) => {
        const entry = object(entryValue);
        if (
          !entry ||
          (entry["use"] !== "current" && entry["use"] !== "history")
        )
          return entryValue;
        try {
          const source = parseSchema(
            CognitionEvidenceSchema,
            entry["evidence"],
          );
          const effect = source.effect;
          if (
            source.actor !== "agent" ||
            source.kind !== "effect" ||
            source.bodyReleasedAt ||
            !source.text ||
            !effect ||
            effect.outcome !== "performed" ||
            effect.worldChange !== "unchanged" ||
            !effect.itemId ||
            !effect.callId ||
            source.source.kind !== "run" ||
            source.source.id !== effect.runId ||
            source.source.fragment !== effect.itemId ||
            source.source.revision !== "completed" ||
            !effect.sourceRefs.some((ref) =>
              isDeepStrictEqual(ref, source.source),
            ) ||
            !Array.isArray(context["evidenceIds"]) ||
            !context["evidenceIds"].includes(source.id)
          )
            return entryValue;
          const receipt = object(JSON.parse(source.text) as JsonValue);
          if (
            receipt?.["tool"] !== "territory.observe" ||
            receipt["status"] !== "success"
          )
            return entryValue;
          const old = completeObservation(receipt["result"]);
          const current = old && reads.get(old.zoneId);
          if (!old || !current || current.index <= contextIndex)
            return entryValue;
          let changed = false;
          const groups = old.groups.map((group) => {
            const nodeGroupIndex = current.groups.get(JSON.stringify(group));
            if (nodeGroupIndex === undefined) return group;
            changed = true;
            return {
              sameAsObservation: { callId: current.callId, nodeGroupIndex },
            };
          });
          if (!changed) return entryValue;
          shared = true;
          return {
            ...entry,
            evidence: {
              ...source,
              text: JSON.stringify({
                ...receipt,
                result: { ...old.body, nodeGroups: groups },
              }),
            },
          };
        } catch {
          return entryValue;
        }
      });
      if (!shared) return value;
      lines[1] = JSON.stringify({ ...material, evidence });
      return {
        ...context,
        content: lines.join("\n") + "\n\n" + OBSERVATION_SHARING_DESCRIPTION,
      };
    } catch {
      return value;
    }
  });
}
