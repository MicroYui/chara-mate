import type Database from "better-sqlite3";
import type {
  EvidencePack,
  MemoryEvidenceReferenceRequest,
  MemoryRecall,
} from "../../shared/contracts/memoryRecall";
import { CognitionEvidenceSchema } from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import { estimateInputBudget } from "../providers/inputBudget";
import type {
  CognitionClaim,
  CognitionDecisionAttempt,
  CognitionIntent,
  CognitionPreparedContext,
} from "./cognitionTypes";

/** Insufficient material ends this attempt, not a new semantic event or automatic retry. */
export class CognitionMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CognitionMaterialError";
  }
}

/** A local read-resource failure is different from a model context-token failure. */
export class CognitionMaterialResourceError extends CognitionMaterialError {
  constructor(message: string) {
    super(message);
    this.name = "CognitionMaterialResourceError";
  }
}

// The same selected payload query supplies both metadata cost and actual bodies.
// No whole Situation, unrelated evidence or historical claim lineage crosses into JS.
// Distinct situations are expanded once per SQL statement. Keep matching after
// json_each so repeated selections cannot restart the same claims-array scan.
// Only matched claim projections enter the statement-local materialized table;
// no unselected claim body or complete Situation is returned to JavaScript.
const SELECTED_MATERIAL_SQL = `WITH requested_claims AS MATERIALIZED (
  SELECT CAST(j.key AS INTEGER) AS ordinal,
    json_extract(j.value,'$.situationId') AS situation_id,
    json_extract(j.value,'$.claimId') AS claim_id
  FROM json_each(@claims) j
), matched_claims AS MATERIALIZED (
  SELECT r.ordinal,json_extract(c.value,'$.id') AS id,
    json_remove(c.value,'$.historyEvidenceIds') AS payload_json
  FROM (SELECT DISTINCT situation_id FROM requested_claims) selected
  CROSS JOIN cognition_situations s
  CROSS JOIN json_each(s.payload_json,'$.claims') c
  CROSS JOIN requested_claims r
  WHERE s.persona_id=@personaId AND s.id=selected.situation_id
    AND r.situation_id=s.id AND r.claim_id=json_extract(c.value,'$.id')
), selected_material AS (
  SELECT 'intent' AS section, CAST(j.key AS INTEGER) AS ordinal, i.id,
    NULL AS evidence_kind, i.payload_json
  FROM json_each(@intent) j LEFT JOIN cognition_intents i
    ON i.persona_id=@personaId AND i.id=json_extract(j.value,'$.id')
      AND i.revision=json_extract(j.value,'$.revision')
  UNION ALL
  SELECT 'claim',r.ordinal,c.id,NULL,c.payload_json
  FROM requested_claims r LEFT JOIN matched_claims c ON c.ordinal=r.ordinal
  UNION ALL
  SELECT 'evidence',CAST(j.key AS INTEGER),e.id,e.kind,
    CASE WHEN e.kind='recollection' THEN NULL ELSE e.payload_json END
  FROM json_each(@evidenceUses) j LEFT JOIN cognition_evidence e
    ON e.persona_id=@personaId AND e.id=json_extract(j.value,'$.evidenceId')
)`;

export interface SelectedActionMaterial {
  readonly context: CognitionPreparedContext;
  /** Raw payload strings returned by the body query, not tokens or JS heap bytes. */
  readonly readCost: {
    readonly rawValueBytes: number;
    readonly rowCount: number;
  };
}

/** Caller owns the synchronous transaction across this read and Memory resolution. */
export function readSelectedActionMaterial(
  database: Database.Database,
  attempt: CognitionDecisionAttempt,
  maxReadBytes: number,
): SelectedActionMaterial {
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0)
    throw new RangeError(
      "Selected action requires a positive read-byte allocation",
    );
  const binding = attempt.actionReadSet;
  const decision = attempt.decision;
  const choice = decision?.choices.find(
    ({ id }) => id === decision.selectedChoiceId,
  );
  if (!binding || !decision || !choice || binding.choiceId !== choice.id)
    throw new CognitionMaterialError("Selected action basis is missing");
  const params = {
    personaId: attempt.personaId,
    intent: JSON.stringify(
      binding.selectedIntent ? [binding.selectedIntent] : [],
    ),
    claims: JSON.stringify(binding.claims),
    evidenceUses: JSON.stringify(decision.selectedBasis.evidenceUses),
  };
  const metadata = database
    .prepare(
      `${SELECTED_MATERIAL_SQL}
    SELECT section,ordinal,id,evidence_kind,
      CASE WHEN section='evidence' THEN json_extract(payload_json,'$.bodyReleasedAt') END AS body_released_at,
      COALESCE(length(CAST(payload_json AS BLOB)),0) AS bytes
    FROM selected_material ORDER BY section,ordinal`,
    )
    .all(params) as {
    section: "intent" | "claim" | "evidence";
    ordinal: number;
    id: string | null;
    evidence_kind: string | null;
    body_released_at: string | null;
    bytes: number;
  }[];
  const expected =
    Number(Boolean(binding.selectedIntent)) +
    binding.claims.length +
    decision.selectedBasis.evidenceUses.length;
  if (metadata.length !== expected || metadata.some((row) => row.id === null))
    throw new CognitionMaterialError(
      "Required selected intent, claim or evidence is unavailable",
    );
  if (metadata.some((row) => row.body_released_at !== null))
    throw new CognitionMaterialError(
      "Required selected evidence body was released and cannot be expanded",
    );
  const readings = metadata.filter(
    (row) => row.evidence_kind !== "recollection",
  );
  const readCost = {
    rawValueBytes: readings.reduce((sum, row) => sum + row.bytes, 0),
    rowCount: readings.length,
  };
  if (readCost.rawValueBytes > maxReadBytes)
    throw new CognitionMaterialResourceError(
      `Selected action requires ${readCost.rawValueBytes} raw read bytes across ${readCost.rowCount} rows; read allocation ${maxReadBytes}. Complete required material was not loaded.`,
    );
  const rows = database
    .prepare(
      `${SELECTED_MATERIAL_SQL}
    SELECT payload_json FROM selected_material
    WHERE evidence_kind IS NULL OR evidence_kind!='recollection'
    ORDER BY section,ordinal`,
    )
    .all(params) as { payload_json: string }[];
  if (rows.length !== readings.length)
    throw new CognitionMaterialError(
      "Selected action changed during its material read",
    );
  const values = new Map(
    readings.map((reading, index) => [
      `${reading.section}:${reading.ordinal}`,
      JSON.parse(rows[index]!.payload_json) as unknown,
    ]),
  );
  const intent = binding.selectedIntent
    ? (values.get("intent:0") as CognitionIntent)
    : undefined;
  const claims = binding.claims.map(({ situationId }, index) => ({
    situationId,
    claim: values.get(`claim:${index}`) as CognitionClaim,
  }));
  const selectedEvidence = decision.selectedBasis.evidenceUses.flatMap(
    ({ use }, index) => {
      const value = values.get(`evidence:${index}`);
      return value === undefined
        ? []
        : [
            {
              use,
              evidence: parseSchema(CognitionEvidenceSchema, value),
            },
          ];
    },
  );
  const context: CognitionPreparedContext = {
    text: [
      "Selected decision material follows. Source actor, basis, use and time are explicit; historical evidence does not assert current state. Intent completion user_report is an attributed user report, not independent verification; performed_effect is limited to the actual receipt scope, not an automatic world change; completed_reply records that the visible saved reply itself satisfied a finite conversational goal, not external actions, surface delivery or user reading. Excerpts prove only their visible content. Missing completion basis is not proof of verified execution. This is context for the selected instruction, not another user request.",
      JSON.stringify({
        situations: binding.situationLifecycles.map(({ id, status }) => ({
          id,
          status,
        })),
        ...(intent ? { intent } : {}),
        claims,
        evidence: selectedEvidence,
      }),
    ].join("\n"),
    situationIds: binding.situationLifecycles.map(({ id }) => id),
    intentIds: intent ? [intent.id] : [],
    evidenceIds: selectedEvidence.map(({ evidence }) => evidence.id),
    decisionAttemptId: attempt.id,
    ...(attempt.recallPlan ? { recallPlan: attempt.recallPlan } : {}),
  };
  return { context, readCost };
}

/** Synchronous exact-revision qualification/read, never a second recall or replacement search. */
export function attachSelectedRecollections(
  context: CognitionPreparedContext,
  attempt: CognitionDecisionAttempt,
  memory: MemoryRecall,
  request: MemoryEvidenceReferenceRequest,
  maxReadBytes: number,
): CognitionPreparedContext {
  if (request.personaId !== attempt.personaId)
    throw new CognitionMaterialError(
      "Selected memory request belongs to another persona",
    );
  const references = request.references;
  if (references.length && maxReadBytes <= 0)
    throw new CognitionMaterialResourceError(
      "Required selected memory has no remaining read allocation",
    );
  const resolved = references.length
    ? memory.resolveEvidence({ ...request, resourceBudget: { maxReadBytes } })
    : undefined;
  if (resolved?.status === "unavailable")
    throw new CognitionMaterialError(
      "Selected memory revision is no longer eligible",
    );
  if (resolved?.status === "resource_limit")
    throw new CognitionMaterialResourceError(
      `Required selected memory needs ${resolved.readCost.rawValueBytes} raw read bytes across ${resolved.readCost.rowCount} rows; remaining read allocation ${maxReadBytes}`,
    );
  const items = resolved?.items ?? [];
  if (
    references.some(
      (ref) =>
        !items.some(
          (item) =>
            item.memoryId === ref.memoryId &&
            item.revisionId === ref.revisionId &&
            (ref.use !== "current" || item.current),
        ),
    )
  )
    throw new CognitionMaterialError(
      "Required selected memory is missing or no longer current",
    );
  if (
    items.some(
      (item) =>
        !references.some(
          (ref) =>
            ref.memoryId === item.memoryId &&
            ref.revisionId === item.revisionId,
        ),
    )
  )
    throw new CognitionMaterialError(
      "Memory resolution included unselected material",
    );
  const selected = new Set(items.map(({ revisionId }) => revisionId));
  const summary = attempt.recallSummary;
  const gaps = [...(summary?.gaps ?? [])];
  const coverage: EvidencePack["coverage"] = (summary?.coverage ?? []).map(
    (value) => {
      const revisionIds = value.revisionIds.filter((id) => selected.has(id));
      if (
        revisionIds.length === value.revisionIds.length &&
        !(
          revisionIds.length === 0 &&
          (value.status === "supported" || value.status === "conflicting")
        )
      )
        return { ...value, revisionIds };
      gaps.push({
        questionId: value.questionId,
        reason:
          "Some retrieved support was not selected for this action; the original retrieval coverage is not fully available here.",
      });
      return {
        ...value,
        revisionIds,
        status: revisionIds.length ? "partial" : "missing",
      };
    },
  );
  // A plan without a retained coverage row is explicitly unresolved, never silently answered.
  for (const question of attempt.recallPlan?.questions ?? []) {
    if (!coverage.some((row) => row.questionId === question.id)) {
      coverage.push({
        questionId: question.id,
        status: "missing",
        revisionIds: [],
      });
      gaps.push({
        questionId: question.id,
        reason: "No retained coverage for this information need.",
      });
    }
  }
  const selectedItems = items.map((item) => ({
    ...item,
    questionIds: coverage
      .filter((row) => row.revisionIds.includes(item.revisionId))
      .map((row) => row.questionId),
  }));
  const evidencePack: EvidencePack | undefined =
    summary || attempt.recallPlan || items.length
      ? {
          items: selectedItems,
          coverage,
          gaps,
          estimatedTokens: selectedItems.length
            ? estimateInputBudget(selectedItems).estimatedTokens
            : 0,
          truncated: summary?.truncated ?? false,
          incompleteReasons: summary?.incompleteReasons ?? [],
        }
      : undefined;
  const historicalMemoryRevisionIds = [
    ...new Set(
      references
        .filter(
          (ref) =>
            ref.use === "history" &&
            !references.some(
              (other) =>
                other.memoryId === ref.memoryId &&
                other.revisionId === ref.revisionId &&
                other.use === "current",
            ),
        )
        .map((ref) => ref.revisionId),
    ),
  ];
  const result = {
    ...context,
    ...(evidencePack ? { evidencePack } : {}),
    ...(historicalMemoryRevisionIds.length
      ? { historicalMemoryRevisionIds }
      : {}),
  };
  // The Runtime measures the complete model wire after all mandatory material is attached.
  return result;
}
