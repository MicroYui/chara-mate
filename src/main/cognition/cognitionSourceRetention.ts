import type Database from "better-sqlite3";
import type {
  CognitionSourceRetention,
  CognitionSourceRetentionCandidate,
  CognitionSourceRetentionReason,
} from "../../shared/contracts/cognition";

/** Both Activity originals and Memory canonical bodies use the same consumer
 * projection. Only the former may rely on a complete canonical copy. A pending
 * directory comparison owns its single boundary predecessor as a decision
 * read dependency until review advances, even before an Attempt is created. */
export function retainedSourceUses(
  database: Database.Database,
  candidates: readonly CognitionSourceRetentionCandidate[],
): CognitionSourceRetention[] {
  if (!candidates.length) return [];
  const rows = database
    .prepare(
      `WITH originals AS (
        SELECT json_extract(c.value,'$.candidateId') AS candidate_id,
          json_extract(r.value,'$.kind') AS kind,
          json_extract(r.value,'$.id') AS source_id,
          COALESCE(json_extract(r.value,'$.fragment'),'') AS fragment
        FROM json_each(?) c, json_each(c.value,'$.references') r
      ), used AS (
        SELECT DISTINCT o.candidate_id,e.id,e.persona_id,e.receipt_sequence
        FROM originals o JOIN cognition_evidence e
          ON e.source_kind=o.kind AND e.source_id=o.source_id
          AND e.source_fragment=o.fragment
      ), current_views AS MATERIALIZED (
        SELECT p.persona_id,(SELECT current.id FROM cognition_evidence current
          WHERE current.persona_id=p.persona_id AND current.kind='observation'
            AND json_extract(current.payload_json,'$.object.key')=json_extract(state.payload_json,'$.foregroundObject.key')
            AND COALESCE(json_extract(current.payload_json,'$.boundary'),'')!='idle'
            AND (COALESCE(json_extract(current.payload_json,'$.text'),'')!=''
              OR json_extract(current.payload_json,'$.visual') IS NOT NULL)
          ORDER BY current.observed_at DESC,current.receipt_sequence DESC LIMIT 1) AS evidence_id
        FROM (SELECT DISTINCT persona_id FROM used) p
        JOIN cognition_state state ON state.persona_id=p.persona_id
      ), latest AS (
        SELECT a.persona_id,a.status,a.payload_json
        FROM (SELECT DISTINCT persona_id FROM used) p JOIN cognition_decision_attempts a
          ON a.id = (SELECT id FROM cognition_decision_attempts
            WHERE persona_id=p.persona_id ORDER BY creation_sequence DESC LIMIT 1)
      ), catalogue_boundaries AS MATERIALIZED (
        SELECT previous.id FROM (SELECT DISTINCT persona_id FROM used) p
        JOIN cognition_state state ON state.persona_id=p.persona_id
        JOIN cognition_evidence next ON next.id=(
          SELECT id FROM cognition_evidence WHERE persona_id=p.persona_id
            AND receipt_sequence>COALESCE(json_extract(state.payload_json,'$.catalogueReviewedThroughSequence'),state.analyzed_through_sequence)
          ORDER BY receipt_sequence LIMIT 1)
        JOIN cognition_evidence previous ON previous.id=(
          SELECT id FROM cognition_evidence WHERE persona_id=p.persona_id
            AND receipt_sequence<next.receipt_sequence ORDER BY receipt_sequence DESC LIMIT 1)
        WHERE previous.actor=next.actor AND previous.kind='observation' AND next.kind='observation'
          AND previous.source_kind='activity' AND next.source_kind='activity'
          AND json_extract(previous.payload_json,'$.sourceEpoch') IS json_extract(next.payload_json,'$.sourceEpoch')
          AND json_extract(previous.payload_json,'$.object.key')=json_extract(next.payload_json,'$.object.key')
          AND json_extract(previous.payload_json,'$.visibility') IS json_extract(next.payload_json,'$.visibility')
          AND COALESCE(json_extract(previous.payload_json,'$.boundary'),'') IN ('content','interaction','idle')
          AND COALESCE(json_extract(next.payload_json,'$.boundary'),'') IN ('content','interaction','idle')
          AND json_extract(previous.payload_json,'$.effect') IS NULL
          AND json_extract(next.payload_json,'$.effect') IS NULL
          AND json_extract(previous.payload_json,'$.opportunity') IS NULL
          AND json_extract(next.payload_json,'$.opportunity') IS NULL
          AND json_extract(previous.payload_json,'$.control') IS NULL
          AND json_extract(next.payload_json,'$.control') IS NULL
          AND json_extract(previous.payload_json,'$.bodyReleasedAt') IS NULL
          AND json_extract(next.payload_json,'$.bodyReleasedAt') IS NULL
          AND json_extract(previous.payload_json,'$.text') IS NOT NULL
          AND json_extract(next.payload_json,'$.text') IS NOT NULL
      ), active_decision_evidence AS MATERIALIZED (
        SELECT a.persona_id,dependency.value AS evidence_id
        FROM (SELECT DISTINCT persona_id FROM used) p
        JOIN cognition_decision_attempts a ON a.persona_id=p.persona_id,
          json_each(a.payload_json,'$.dependencies.evidenceIds') dependency
        WHERE a.status NOT IN ('settled','failed','superseded')
      ), pending_catalogue_reads AS MATERIALIZED (
        SELECT a.persona_id,json_extract(request.value,'$.evidenceId') AS evidence_id
        FROM (SELECT DISTINCT persona_id FROM used) p
        JOIN cognition_state state ON state.persona_id=p.persona_id
        JOIN cognition_decision_attempts a ON a.persona_id=p.persona_id
          AND a.user_generation=state.user_generation,
          json_each(a.payload_json,'$.sourceCoverage.readPlan.requests') request
        WHERE json_extract(a.payload_json,'$.sourceCoverage.completionPending')=1
          AND json_extract(a.payload_json,'$.sourceCoverage.throughSequence')>
            COALESCE(json_extract(state.payload_json,'$.catalogueReviewedThroughSequence'),state.analyzed_through_sequence)
      ), selected_intents AS (
        SELECT a.persona_id,json_extract(a.payload_json,'$.actionReadSet.selectedIntent.id') AS intent_id
        FROM latest a WHERE a.status IN ('ready','dispatched','settled')
          AND json_extract(a.payload_json,'$.dependencies.personaId')=a.persona_id
          AND json_extract(a.payload_json,'$.decision.selectedChoiceId')=json_extract(a.payload_json,'$.decision.selectedBasis.choiceId')
          AND json_extract(a.payload_json,'$.decision.selectedChoiceId')=json_extract(a.payload_json,'$.actionReadSet.choiceId')
          AND EXISTS (SELECT 1 FROM json_each(a.payload_json,'$.decision.choices') choice
            WHERE json_extract(choice.value,'$.id')=json_extract(a.payload_json,'$.decision.selectedChoiceId')
              AND json_extract(choice.value,'$.intentId')=json_extract(a.payload_json,'$.actionReadSet.selectedIntent.id'))
          AND EXISTS (SELECT 1 FROM json_each(a.payload_json,'$.dependencies.intents') dependency
            WHERE json_extract(dependency.value,'$.id')=json_extract(a.payload_json,'$.actionReadSet.selectedIntent.id')
              AND json_extract(dependency.value,'$.revision')=json_extract(a.payload_json,'$.actionReadSet.selectedIntent.revision'))
      )
      SELECT u.candidate_id,'unanalysed' AS reason FROM used u
        LEFT JOIN cognition_state state ON state.persona_id=u.persona_id
        WHERE u.receipt_sequence > COALESCE(json_extract(state.payload_json,'$.catalogueReviewedThroughSequence'),state.analyzed_through_sequence,0)
      UNION
      SELECT u.candidate_id,'current_view' FROM used u
        JOIN current_views view ON view.persona_id=u.persona_id AND view.evidence_id=u.id
      UNION
      SELECT u.candidate_id,'decision' FROM used u
        JOIN catalogue_boundaries boundary ON boundary.id=u.id
      UNION
      SELECT u.candidate_id,'decision' FROM used u
        JOIN active_decision_evidence active
          ON active.persona_id=u.persona_id AND active.evidence_id=u.id
      UNION
      SELECT u.candidate_id,'decision' FROM used u
        JOIN pending_catalogue_reads pending
          ON pending.persona_id=u.persona_id AND pending.evidence_id=u.id
      UNION
      SELECT u.candidate_id,'handoff' FROM used u
        WHERE EXISTS (SELECT 1 FROM cognition_memory_handoffs h WHERE h.persona_id=u.persona_id AND (
          u.id IN (SELECT value FROM json_each(h.payload_json,'$.primaryEvidenceIds')) OR
          u.id IN (SELECT value FROM json_each(h.payload_json,'$.historyEvidenceIds')) OR
          u.id IN (SELECT item.value FROM json_each(h.payload_json,'$.contextGroups') g,
            json_each(g.value,'$.contextEvidenceIds') item)))
      UNION
      SELECT u.candidate_id,'episode' FROM used u
        WHERE EXISTS (SELECT 1 FROM cognition_episode_evidence link
          JOIN cognition_situations s ON s.id=link.situation_id,
          json_each(s.payload_json,'$.episodes') episode
          WHERE link.evidence_id=u.id AND s.persona_id=u.persona_id
            AND json_extract(episode.value,'$.id')=link.episode_id
            AND json_extract(episode.value,'$.state') != 'closed')
      UNION
      SELECT u.candidate_id,'claim' FROM used u
        WHERE EXISTS (SELECT 1 FROM cognition_claim_evidence link
          JOIN cognition_situations s ON s.id=link.situation_id
          WHERE link.evidence_id=u.id AND s.persona_id=u.persona_id
            AND link.state != 'superseded' AND link.current_basis=1)
      UNION
      SELECT u.candidate_id,'intent' FROM used u
        WHERE EXISTS (SELECT 1 FROM cognition_intents intent WHERE intent.persona_id=u.persona_id
          AND ((intent.status NOT IN ('fulfilled','abandoned')
            AND (u.id IN (SELECT value FROM json_each(intent.payload_json,'$.evidenceIds'))
              OR u.id IN (SELECT value FROM json_each(intent.payload_json,'$.effectEvidenceIds'))))
            OR (intent.status = 'fulfilled' AND (EXISTS (
              SELECT 1 FROM cognition_state state WHERE state.persona_id = intent.persona_id
                AND json_extract(state.payload_json,'$.committedIntentId') = intent.id)
              OR EXISTS (SELECT 1 FROM selected_intents selected
                WHERE selected.persona_id=intent.persona_id AND selected.intent_id=intent.id))
              AND u.id IN (
              SELECT json_extract(value,'$.evidenceId') FROM json_each(intent.payload_json,'$.completion.evidenceUses')))))
      ORDER BY candidate_id,reason`,
    )
    .all(JSON.stringify(candidates)) as {
    candidate_id: string;
    reason: CognitionSourceRetentionReason;
  }[];
  const reasons = new Map<string, CognitionSourceRetentionReason[]>();
  for (const row of rows) {
    const values = reasons.get(row.candidate_id) ?? [];
    values.push(row.reason);
    reasons.set(row.candidate_id, values);
  }
  return [...reasons].map(([candidateId, values]) => ({
    candidateId,
    reasons: values,
  }));
}
