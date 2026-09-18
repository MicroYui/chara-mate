import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CognitionConflictError,
  isIntentCompletionEvidence,
} from "./cognitionProjection";
import { readEvidenceMetadata } from "./cognitionSnapshotReader";
import type {
  CognitionActionFreshness,
  CognitionActionReadSet,
  CognitionAttentionState,
  CognitionClaim,
  CognitionDecision,
  CognitionDecisionAttempt,
  CognitionEvidence,
} from "./cognitionTypes";

function claimMaterial(claim: CognitionClaim): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: claim.text,
        basis: claim.basis,
        state: claim.state,
        evidenceIds: [...claim.evidenceIds].sort(),
        contradictingEvidenceIds: [...claim.contradictingEvidenceIds].sort(),
        alternative: claim.alternative ?? null,
      }),
    )
    .digest("hex");
}

function readClaim(
  database: Database.Database,
  personaId: string,
  situationId: string,
  claimId: string,
): CognitionClaim | undefined {
  const row = database
    .prepare(
      `SELECT c.value AS value FROM cognition_situations s,json_each(s.payload_json,'$.claims') c
    WHERE s.persona_id = ? AND s.id = ? AND json_extract(c.value,'$.id') = ? LIMIT 1`,
    )
    .get(personaId, situationId, claimId) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as CognitionClaim) : undefined;
}

function lifecycle(
  database: Database.Database,
  personaId: string,
  id: string,
): CognitionActionReadSet["situationLifecycles"][number] | undefined {
  const row = database
    .prepare(
      "SELECT status,superseded_by FROM cognition_situations WHERE persona_id = ? AND id = ?",
    )
    .get(personaId, id) as
    | {
        status: CognitionActionReadSet["situationLifecycles"][number]["status"];
        superseded_by: string | null;
      }
    | undefined;
  return row
    ? {
        id,
        status: row.status,
        ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
      }
    : undefined;
}

/** Compile only after final partial/full state writes, inside the same transaction. */
export function compileActionReadSet(
  database: Database.Database,
  attempt: CognitionDecisionAttempt,
  decision: CognitionDecision,
  opportunities: Iterable<CognitionEvidence>,
): CognitionActionReadSet {
  const choice = decision.choices.find(
    ({ id }) => id === decision.selectedChoiceId,
  )!;
  const selectedIntent = choice.intentId
    ? (database
        .prepare(
          "SELECT id,revision,situation_id FROM cognition_intents WHERE persona_id = ? AND id = ?",
        )
        .get(attempt.personaId, choice.intentId) as
        | { id: string; revision: number; situation_id: string | null }
        | undefined)
    : undefined;
  if (choice.intentId && !selectedIntent)
    throw new CognitionConflictError(
      "Selected intent disappeared before binding",
    );
  const situationIds = new Set([
    ...(choice.situationId ? [choice.situationId] : []),
    ...(selectedIntent?.situation_id ? [selectedIntent.situation_id] : []),
    ...decision.selectedBasis.currentClaimRefs.map(
      ({ situationId }) => situationId,
    ),
  ]);
  if (selectedIntent && choice.kind !== "remain_quiet") {
    const uses = new Set(
      decision.selectedBasis.evidenceUses.map(({ evidenceId }) => evidenceId),
    );
    for (const row of database
      .prepare(
        `SELECT json_extract(use.value,'$.evidenceId') AS id FROM cognition_intents i,
        json_each(i.payload_json,'$.completion.evidenceUses') use
        WHERE i.id = ? AND i.persona_id = ? AND i.status = 'fulfilled'`,
      )
      .iterate(selectedIntent.id, attempt.personaId) as Iterable<{
      id: string;
    }>) {
      if (!choice.evidenceIds.includes(row.id) || !uses.has(row.id))
        throw new CognitionConflictError(
          "Selected fulfilled intent requires its completion sources in selectedBasis",
        );
    }
  }
  return {
    choiceId: choice.id,
    ...(selectedIntent
      ? {
          selectedIntent: {
            id: selectedIntent.id,
            revision: selectedIntent.revision,
          },
        }
      : {}),
    situationLifecycles: [...situationIds].map((id) => {
      const value = lifecycle(database, attempt.personaId, id);
      if (!value)
        throw new CognitionConflictError(
          "Selected situation disappeared before binding",
        );
      return value;
    }),
    claims: decision.selectedBasis.currentClaimRefs.map(
      ({ situationId, claimId }) => {
        const claim = readClaim(
          database,
          attempt.personaId,
          situationId,
          claimId,
        );
        if (!claim)
          throw new CognitionConflictError(
            "Selected claim disappeared before binding",
          );
        return { situationId, claimId, materialVersion: claimMaterial(claim) };
      },
    ),
    currentObjects: decision.selectedBasis.evidenceUses.flatMap(
      ({ evidenceId, use }) =>
        use !== "current_object" && use !== "current_foreground"
          ? []
          : [
              {
                evidenceId,
                requireForeground: use === "current_foreground",
                ...(use === "current_foreground"
                  ? { focusRevision: attempt.dependencies.focusRevision }
                  : {}),
              },
            ],
    ),
    recollections: decision.selectedBasis.evidenceUses.flatMap(
      ({ evidenceId, use }) => {
        const item = readEvidenceMetadata(database, evidenceId);
        return item?.kind === "recollection"
          ? [{ evidenceId, requireCurrent: use === "current_recollection" }]
          : [];
      },
    ),
    opportunityEvidenceIds: [
      ...new Set([...opportunities].map(({ id }) => id)),
    ],
  };
}

/** Narrow execution checks. Analysis entity CAS remains owned by commitAnalysis. */
export function actionFreshness(
  database: Database.Database,
  attempt: CognitionDecisionAttempt,
  state: CognitionAttentionState,
  opportunityIsCurrent: (item: CognitionEvidence) => boolean,
): CognitionActionFreshness {
  const fail = (
    reason: Exclude<CognitionActionFreshness, { current: true }>["reason"],
    referenceId?: string,
  ): CognitionActionFreshness => ({
    current: false,
    reason,
    ...(referenceId ? { referenceId } : {}),
  });
  const binding = attempt.actionReadSet;
  const choice = attempt.decision?.choices.find(
    ({ id }) => id === attempt.decision?.selectedChoiceId,
  );
  if (
    !binding ||
    !choice ||
    binding.choiceId !== choice.id ||
    attempt.decision?.selectedBasis.choiceId !== choice.id
  )
    return fail("missing_basis");
  if (
    attempt.dependencies.personaId !== state.personaId ||
    attempt.dependencies.userGeneration !== state.userGeneration
  )
    return fail("control_changed");
  if (
    database
      .prepare(
        `SELECT id FROM cognition_evidence WHERE persona_id = ? AND receipt_sequence > ?
    AND actor = 'user' AND kind IN ('utterance','control') AND source_kind != 'memory' LIMIT 1`,
      )
      .get(attempt.personaId, attempt.dependencies.receivedThroughSequence)
  )
    return fail("control_changed");
  if (binding.selectedIntent) {
    const row = database
      .prepare(
        "SELECT revision FROM cognition_intents WHERE id = ? AND persona_id = ?",
      )
      .get(binding.selectedIntent.id, attempt.personaId) as
      { revision: number } | undefined;
    if (row?.revision !== binding.selectedIntent.revision)
      return fail("intent_changed", binding.selectedIntent.id);
    if (choice.kind !== "remain_quiet")
      for (const ref of database
        .prepare(
          `SELECT json_extract(use.value,'$.evidenceId') AS id,
          json_extract(use.value,'$.basis') AS basis FROM cognition_intents i,
          json_each(i.payload_json,'$.completion.evidenceUses') use
          WHERE i.id = ? AND i.persona_id = ? AND i.status = 'fulfilled'`,
        )
        .iterate(binding.selectedIntent.id, attempt.personaId) as Iterable<{
        id: string;
        basis: string;
      }>) {
        const item = readEvidenceMetadata(database, ref.id);
        if (!item || item.personaId !== attempt.personaId)
          return fail("source_missing", ref.id);
        if (!isIntentCompletionEvidence(ref.basis, item))
          return fail("missing_basis", ref.id);
      }
  }
  for (const expected of binding.situationLifecycles) {
    const current = lifecycle(database, attempt.personaId, expected.id);
    if (
      !current ||
      current.status !== expected.status ||
      current.supersededBy !== expected.supersededBy
    )
      return fail("situation_changed", expected.id);
  }
  for (const expected of binding.claims) {
    const current = readClaim(
      database,
      attempt.personaId,
      expected.situationId,
      expected.claimId,
    );
    if (!current || claimMaterial(current) !== expected.materialVersion)
      return fail("claim_changed", expected.claimId);
  }
  for (const object of binding.currentObjects) {
    const prior = readEvidenceMetadata(database, object.evidenceId);
    if (!prior || prior.personaId !== attempt.personaId)
      return fail("source_missing", object.evidenceId);
    if (prior.kind !== "observation" || !prior.object)
      return fail("missing_basis", object.evidenceId);
    if (
      object.requireForeground &&
      (object.focusRevision !== state.focusRevision ||
        state.foregroundObject?.key !== prior.object.key)
    )
      return fail("focus_changed", object.evidenceId);
    const changed = database
      .prepare(
        `SELECT newer.id FROM cognition_evidence newer JOIN cognition_evidence prior
      ON json_extract(prior.payload_json,'$.object.key') = json_extract(newer.payload_json,'$.object.key')
      WHERE prior.id = ? AND newer.persona_id = ? AND prior.persona_id = newer.persona_id
        AND newer.id != prior.id AND newer.receipt_sequence > ? AND newer.kind = 'observation'
        AND COALESCE(json_extract(newer.payload_json,'$.boundary'),'') NOT IN ('interaction','idle')
        AND CASE WHEN json_extract(prior.payload_json,'$.sourceEpoch') IS NOT NULL
          AND json_extract(prior.payload_json,'$.sourceEpoch') = json_extract(newer.payload_json,'$.sourceEpoch')
          AND prior.source_kind = newer.source_kind AND json_extract(prior.payload_json,'$.sourceSequence') IS NOT NULL
          AND json_extract(newer.payload_json,'$.sourceSequence') IS NOT NULL
          THEN json_extract(newer.payload_json,'$.sourceSequence') > json_extract(prior.payload_json,'$.sourceSequence')
          ELSE newer.observed_at >= prior.observed_at END LIMIT 1`,
      )
      .get(prior.id, attempt.personaId, attempt.throughSequence);
    if (changed) return fail("object_changed", prior.id);
  }
  for (const reference of binding.recollections) {
    const item = readEvidenceMetadata(database, reference.evidenceId);
    if (!item || item.personaId !== attempt.personaId)
      return fail("source_missing", reference.evidenceId);
    if (
      item.kind !== "recollection" ||
      !item.recollection ||
      item.source.kind !== "memory" ||
      !item.source.revision ||
      (reference.requireCurrent && !item.recollection.current)
    )
      return fail("missing_basis", reference.evidenceId);
  }
  for (const id of binding.opportunityEvidenceIds) {
    const item = readEvidenceMetadata(database, id);
    if (!item || item.personaId !== attempt.personaId)
      return fail("source_missing", id);
    if (!opportunityIsCurrent(item)) return fail("cue_changed", id);
    // Host-only provenance can block an action; it cannot invent a cited cue or route.
    if (
      choice.kind !== "remain_quiet" &&
      (!choice.evidenceIds.includes(id) ||
        choice.chatId !== item.opportunity?.targetChatId)
    )
      return fail("cue_changed", id);
  }
  return { current: true };
}
