// This is the single model wire contract. Canonical Situation/Intent state and
// allocation, evidence, revision and transaction checks remain in the repository.
import { Type, type TSchema } from "@sinclair/typebox";
import {
  CognitionAnalysisSchema,
  CognitionStateDeltaSchema,
  CognitionEpisodeSchema,
  CognitionClaimSchema,
} from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import { restoreStructuredOutput } from "../agent/structuredOutput";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
} from "./cognitionTypes";
const closed = { additionalProperties: false };
const optionalOperation = (schema: TSchema) =>
  Type.Union([
    Type.Object({ op: Type.Literal("keep") }, closed),
    Type.Object({ op: Type.Literal("clear") }, closed),
    Type.Required(
      Type.Object({ op: Type.Literal("set"), value: schema }, closed),
    ),
  ]);
const attentionOperation = Type.Union([
  Type.Object({ op: Type.Literal("keep") }, closed),
  Type.Object({ op: Type.Literal("clear") }, closed),
  Type.Object(
    { op: Type.Literal("set"), id: Type.String({ minLength: 1 }) },
    closed,
  ),
]);
const situationValue =
  CognitionStateDeltaSchema["properties"].updateSituations.items["properties"][
    "value"
  ];
const intentValue =
  CognitionStateDeltaSchema["properties"].updateIntents.items["properties"][
    "value"
  ];
function fields(schema: TSchema, omit: string[] = []): Record<string, TSchema> {
  const result: Record<string, TSchema> = {};
  for (const [key, type] of Object.entries(
    schema["properties"] as Record<string, TSchema>,
  )) {
    if (omit.includes(key)) continue;
    result[key] = (schema["required"] as string[]).includes(key)
      ? Type.Union([type, Type.Null()])
      : optionalOperation(type);
  }
  return result;
}
const episodePatch = Type.Object(
  {
    id: CognitionEpisodeSchema["properties"]["id"],
    ...fields(CognitionEpisodeSchema, ["id"]),
  },
  closed,
);
const claimPatch = Type.Object(
  {
    id: CognitionClaimSchema["properties"]["id"],
    ...fields(CognitionClaimSchema, ["id", "historyEvidenceIds"]),
  },
  closed,
);
const situationChanges = Type.Object(
  {
    ...fields(situationValue, ["episodes", "claims"]),
    episodes: Type.Array(episodePatch),
    claims: Type.Array(claimPatch),
    episodeOrder: Type.Union([
      Type.Array(CognitionEpisodeSchema["properties"]["id"]),
      Type.Null(),
    ]),
    claimOrder: Type.Union([
      Type.Array(CognitionClaimSchema["properties"]["id"]),
      Type.Null(),
    ]),
  },
  closed,
);
const intentChanges = Type.Object(fields(intentValue), closed);
const update = (base: TSchema, changes: TSchema) => {
  const properties = base["properties"] as Record<string, TSchema>;
  return Type.Object(
    {
      id: properties["id"]!,
      expectedRevision: properties["expectedRevision"]!,
      changes,
    },
    closed,
  );
};
export const CognitionModelOutputSchema = Type.Object(
  {
    ...CognitionAnalysisSchema["properties"],
    delta: Type.Object(
      {
        ...CognitionStateDeltaSchema["properties"],
        attention: Type.Object(
          {
            currentSituationId: attentionOperation,
            committedIntentId: attentionOperation,
          },
          closed,
        ),
        updateSituations: Type.Array(
          update(
            CognitionStateDeltaSchema["properties"].updateSituations.items,
            situationChanges,
          ),
        ),
        updateIntents: Type.Array(
          update(
            CognitionStateDeltaSchema["properties"].updateIntents.items,
            intentChanges,
          ),
        ),
      },
      closed,
    ),
  },
  closed,
);
export const COGNITION_UPDATE_INSTRUCTIONS = `For updateSituations and updateIntents use changes rather than a repeated value snapshot. Required field null means keep the supplied value; a concrete value (including an empty array or empty string where allowed) sets it. Optional fields require {"op":"keep"}, {"op":"clear"}, or {"op":"set","value":...}. For episodes and claims, list only changed or new child IDs. Existing child required null values keep their supplied fields. New child IDs require every required domain field to be non-null. Intent completion is an atomic optional field: keep preserves the canonical declaration, set replaces all completion uses, and clear removes it. Unlike partial evidence arrays, completion uses never merge. Set requires sufficient supplied sources for the visible goal and success criteria. Leaving fulfilled requires clear, and a changed fulfilled assertion requires set. Optional keep on a new child means absent. Do not repeat unchanged children. episodeOrder and claimOrder are null to retain the existing supplied order followed by new upserts. To deliberately reorder a fully visible collection, provide the complete duplicate-free permutation of all supplied and newly created child IDs. These order fields cannot delete children. For partial allocations the repository preserves canonical existing slots and unseen history, and only appends newly created children in the specified visible order; it does not reorder unseen history. historyEvidenceIds remains host-owned and is not writable in child changes. Changed source arrays are complete visible arrays; do not silently omit old support. Use only supplied parent/child IDs; a supplied parent does not authorize editing a child omitted by allocation. Creates remain complete values. The host restores the full domain delta from this exact supplied view and performs the normal schema, revision, evidence and allocation checks. These wire operations do not grant new action authority.`;
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected typed object");
  return value as Obj;
}
function apply(
  schema: TSchema,
  old: Obj | undefined,
  change: Obj,
  child = false,
): Obj {
  const result: Obj = {};
  for (const key of Object.keys(
    schema["properties"] as Record<string, TSchema>,
  )) {
    if (key === "historyEvidenceIds") {
      if (old?.[key] !== undefined) result[key] = structuredClone(old[key]);
      continue;
    }
    if (child && key === "id") {
      result[key] = change[key];
      continue;
    }
    if (key === "episodes" || key === "claims") {
      const values = (old?.[key] ?? []) as Obj[];
      const merged = new Map(values.map((value) => [value["id"], value]));
      const seen = new Set();
      for (const patch of change[key] as Obj[]) {
        if (seen.has(patch["id"])) throw Error("Duplicate child ID");
        seen.add(patch["id"]);
        merged.set(
          patch["id"],
          apply(
            key === "episodes" ? CognitionEpisodeSchema : CognitionClaimSchema,
            merged.get(patch["id"]),
            patch,
            true,
          ),
        );
      }
      const order = change[key === "episodes" ? "episodeOrder" : "claimOrder"];
      if (order === null) result[key] = [...merged.values()];
      else {
        const ids = order as string[];
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== merged.size ||
          ids.some((id) => !merged.has(id))
        )
          throw Error(
            "Child order must be a complete unique permutation of supplied and new child IDs",
          );
        result[key] = ids.map((id) => merged.get(id));
      }
      continue;
    }
    const value = change[key];
    if ((schema["required"] as string[]).includes(key)) {
      if (value === null) {
        if (old?.[key] === undefined)
          throw Error("New child required field cannot keep: " + key);
        result[key] = structuredClone(old[key]);
      } else result[key] = structuredClone(value);
    } else {
      const operation = object(value);
      if (operation["op"] === "keep") {
        if (old?.[key] !== undefined) result[key] = structuredClone(old[key]);
      } else if (operation["op"] === "set")
        result[key] = structuredClone(operation["value"]);
      else if (operation["op"] !== "clear")
        throw Error("Unknown optional operation");
    }
  }
  return result;
}
function attentionToDomain(delta: Obj): void {
  const old = object(delta["attention"]),
    next: Obj = {};
  for (const key of ["currentSituationId", "committedIntentId"]) {
    const op = object(old[key]);
    if (op["op"] === "set") next[key] = op["id"];
    else if (op["op"] === "clear") next[key] = null;
    else if (op["op"] !== "keep") throw Error("Unknown attention operation");
  }
  delta["attention"] = next;
}
// Required concrete|null is an explicit model-boundary operation, not an
// arbitrary anyOf branch. Restore nested optional nulls using the original field
// schema, then validate the update and expanded domain value independently.
function restoreConcreteChanges(schema: TSchema, raw: unknown): unknown {
  const data = object(raw);
  const result = structuredClone(data);
  for (const [key, field] of Object.entries(
    schema["properties"] as Record<string, TSchema>,
  )) {
    if (!(key in result) || key === "id" || key === "historyEvidenceIds")
      continue;
    if (key === "episodes" || key === "claims") {
      if (Array.isArray(result[key]))
        result[key] = (result[key] as unknown[]).map((child) =>
          restoreConcreteChanges(
            key === "episodes" ? CognitionEpisodeSchema : CognitionClaimSchema,
            child,
          ),
        );
      continue;
    }
    if ((schema["required"] as string[]).includes(key)) {
      if (result[key] !== null)
        result[key] = restoreStructuredOutput(field, result[key]);
    } else {
      const op = result[key];
      if (
        op &&
        typeof op === "object" &&
        !Array.isArray(op) &&
        (op as Obj)["op"] === "set" &&
        "value" in op
      )
        (op as Obj)["value"] = restoreStructuredOutput(
          field,
          (op as Obj)["value"],
        );
    }
  }
  return result;
}
function restoreConcreteValues(raw: unknown): unknown {
  const result = structuredClone(object(raw));
  const delta = object(result["delta"]);
  for (const [key, schema] of [
    ["updateSituations", situationValue],
    ["updateIntents", intentValue],
  ] as const) {
    if (!Array.isArray(delta[key])) continue;
    delta[key] = (delta[key] as unknown[]).map((rawUpdate) => {
      const update = object(rawUpdate);
      return {
        ...update,
        changes: restoreConcreteChanges(schema, update["changes"]),
      };
    });
  }
  return result;
}
export function decodeCognitionModelOutput(
  wire: unknown,
  input: CognitionAnalysisInput,
): CognitionAnalysis {
  const value = structuredClone(
    parseSchema(
      CognitionModelOutputSchema,
      restoreStructuredOutput(
        CognitionModelOutputSchema,
        restoreConcreteValues(wire),
      ),
    ),
  ) as unknown as Obj;
  const delta = object(value["delta"]);
  for (const [key, items, schema] of [
    ["updateSituations", input.snapshot.situations, situationValue],
    ["updateIntents", input.snapshot.intents, intentValue],
  ] as const) {
    const seen = new Set();
    delta[key] = (delta[key] as Obj[]).map((update) => {
      if (seen.has(update["id"])) throw Error("Duplicate entity ID");
      seen.add(update["id"]);
      const old = items.find((item) => item["id"] === update["id"]);
      if (!old) throw Error("Update entity not in supplied view");
      return {
        id: update["id"],
        expectedRevision: update["expectedRevision"],
        value: apply(schema, old, object(update["changes"])),
        ...(key === "updateIntents"
          ? {
              completionOperation: object(
                object(update["changes"])["completion"],
              )["op"],
            }
          : {}),
      };
    });
  }
  attentionToDomain(delta);
  return parseSchema(CognitionAnalysisSchema, value);
}
