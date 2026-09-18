import type Database from "better-sqlite3";
import type { CognitionPassiveSpan } from "./cognitionTypes";

/** Only empty-content observations can be consumed without semantic interpretation. */
export const PASSIVE_RECEIPT_SQL = `kind = 'observation'
  AND json_extract(payload_json, '$.boundary') IN ('interaction','idle')
  AND json_extract(payload_json, '$.bodyReleasedAt') IS NULL
  AND COALESCE(json_extract(payload_json, '$.text'), '') = ''
  AND json_extract(payload_json, '$.visual') IS NULL
  AND json_extract(payload_json, '$.effect') IS NULL
  AND json_extract(payload_json, '$.opportunity') IS NULL
  AND json_extract(payload_json, '$.control') IS NULL`;

interface Anchor {
  id: string;
  receipt_sequence: number;
  actor: CognitionPassiveSpan["actor"];
  boundary: CognitionPassiveSpan["boundary"];
  source_kind: string;
  epoch: string;
  object_key: string;
  observed_at: string;
}
const anchorColumns = `id,receipt_sequence,actor,source_kind,observed_at,
  COALESCE(json_extract(payload_json,'$.sourceEpoch'),'') epoch,
  COALESCE(json_extract(payload_json,'$.object.key'),'') object_key,
  json_extract(payload_json,'$.boundary') boundary`;
const matching = `${PASSIVE_RECEIPT_SQL} AND actor = ? AND source_kind = ?
  AND COALESCE(json_extract(payload_json,'$.sourceEpoch'),'') = ?
  AND COALESCE(json_extract(payload_json,'$.object.key'),'') = ?
  AND json_extract(payload_json,'$.boundary') = ?`;
const group = (first: Anchor) => [
  first.actor,
  first.source_kind,
  first.epoch,
  first.object_key,
  first.boundary,
];

/** One actual contiguous source run; no elapsed-time grouping or numeric drop threshold. */
export function readPassiveSpan(
  database: Database.Database,
  personaId: string,
  fromSequence: number,
  upperSequence: number,
): CognitionPassiveSpan | undefined {
  const first = database
    .prepare(
      `SELECT ${anchorColumns} FROM cognition_evidence
    WHERE persona_id = ? AND receipt_sequence = ? AND ${PASSIVE_RECEIPT_SQL}`,
    )
    .get(personaId, fromSequence) as Anchor | undefined;
  if (!first) return undefined;
  const boundary = database
    .prepare(
      `SELECT receipt_sequence FROM cognition_evidence
    WHERE persona_id = ? AND receipt_sequence > ? AND receipt_sequence <= ? AND NOT (${matching})
    ORDER BY receipt_sequence LIMIT 1`,
    )
    .get(personaId, fromSequence, upperSequence, ...group(first)) as
    { receipt_sequence: number } | undefined;
  const last = database
    .prepare(
      `SELECT id, receipt_sequence FROM cognition_evidence
    WHERE persona_id = ? AND receipt_sequence >= ? AND receipt_sequence <= ? ORDER BY receipt_sequence DESC LIMIT 1`,
    )
    .get(
      personaId,
      fromSequence,
      boundary ? boundary.receipt_sequence - 1 : upperSequence,
    ) as { id: string; receipt_sequence: number };
  const counts = database
    .prepare(
      `SELECT count(*) eventCount, MAX(observed_at) lastAt,
    SUM(COALESCE(json_extract(payload_json,'$.interaction.clicks'),0)) clicks,
    SUM(COALESCE(json_extract(payload_json,'$.interaction.keystrokes'),0)) keystrokes,
    SUM(COALESCE(json_extract(payload_json,'$.interaction.scrolls'),0)) scrolls
    FROM cognition_evidence WHERE persona_id = ? AND receipt_sequence >= ? AND receipt_sequence <= ?`,
    )
    .get(personaId, fromSequence, last.receipt_sequence) as {
    eventCount: number;
    lastAt: string;
    clicks: number;
    keystrokes: number;
    scrolls: number;
  };
  return {
    fromSequence,
    throughSequence: last.receipt_sequence,
    firstEvidenceId: first.id,
    lastEvidenceId: last.id,
    actor: first.actor,
    boundary: first.boundary,
    ...(first.object_key ? { objectKey: first.object_key } : {}),
    sourceKind: first.source_kind,
    ...(first.epoch ? { sourceEpoch: first.epoch } : {}),
    firstAt: first.observed_at,
    lastAt: counts.lastAt,
    eventCount: counts.eventCount,
    interaction: {
      clicks: counts.clicks,
      keystrokes: counts.keystrokes,
      scrolls: counts.scrolls,
    },
  };
}

/** Recover the latest already-consumed rhythm from actual journal rows, without a second store. */
export function readLatestPassiveSpan(
  database: Database.Database,
  personaId: string,
  throughSequence: number,
): CognitionPassiveSpan | undefined {
  const last = database
    .prepare(
      `SELECT ${anchorColumns}, (${PASSIVE_RECEIPT_SQL}) passive
    FROM cognition_evidence WHERE persona_id = ? AND receipt_sequence <= ? ORDER BY receipt_sequence DESC LIMIT 1`,
    )
    .get(personaId, throughSequence) as
    (Anchor & { passive: number }) | undefined;
  if (!last?.passive) return undefined;
  const prior = database
    .prepare(
      `SELECT receipt_sequence FROM cognition_evidence WHERE persona_id = ?
    AND receipt_sequence < ? AND NOT (${matching}) ORDER BY receipt_sequence DESC LIMIT 1`,
    )
    .get(personaId, last.receipt_sequence, ...group(last)) as
    { receipt_sequence: number } | undefined;
  const first = database
    .prepare(
      `SELECT receipt_sequence FROM cognition_evidence WHERE persona_id = ?
    AND receipt_sequence > ? AND receipt_sequence <= ? ORDER BY receipt_sequence LIMIT 1`,
    )
    .get(personaId, prior?.receipt_sequence ?? 0, last.receipt_sequence) as {
    receipt_sequence: number;
  };
  return readPassiveSpan(
    database,
    personaId,
    first.receipt_sequence,
    last.receipt_sequence,
  );
}
