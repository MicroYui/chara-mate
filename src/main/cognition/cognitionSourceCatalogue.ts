import type Database from "better-sqlite3";
import type {
  CognitionAttentionState,
  CognitionSourceCoverage,
  CognitionSourceReadPlan,
  CognitionSnapshot,
} from "../../shared/contracts/cognition";
import { CognitionConflictError } from "./cognitionProjection";

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
type Entry = CognitionSourceCoverage["entries"][number];

/** Structural segmentation, not psychological classification. The SQL input
 * prefix is bounded before window functions and never transfers bodies to JS. */
const rowsSql = `WITH input AS MATERIALIZED (
  SELECT id,receipt_sequence,actor,kind,source_kind,observed_at,payload_json,
    json_extract(payload_json,'$.sourceEpoch') AS epoch,
    json_extract(payload_json,'$.object.key') AS object_key,
    json_extract(payload_json,'$.visibility') AS visibility,
    CASE WHEN kind='observation' AND source_kind='activity'
      AND json_extract(payload_json,'$.object.key') IS NOT NULL
      AND json_extract(payload_json,'$.effect') IS NULL
      AND json_extract(payload_json,'$.opportunity') IS NULL
      AND json_extract(payload_json,'$.control') IS NULL
      AND COALESCE(json_extract(payload_json,'$.boundary'),'') IN ('content','interaction','idle')
      THEN json_array(actor,source_kind,json_extract(payload_json,'$.sourceEpoch'),
        json_extract(payload_json,'$.object.key'),json_extract(payload_json,'$.visibility')) ELSE json_array(id) END AS segment_key
  FROM cognition_evidence WHERE persona_id=? AND receipt_sequence>?
    AND receipt_sequence<=? ORDER BY receipt_sequence LIMIT ?
), boundaries AS (
  SELECT *, CASE WHEN segment_key=lag(segment_key) OVER (ORDER BY receipt_sequence)
    THEN 0 ELSE 1 END AS boundary FROM input
), grouped AS (
  SELECT *,sum(boundary) OVER (ORDER BY receipt_sequence) AS segment FROM boundaries
)
SELECT min(receipt_sequence) AS first_sequence,max(receipt_sequence) AS last_sequence,
  actor,kind,source_kind,epoch,object_key,visibility,
  min(observed_at) AS first_at,max(observed_at) AS last_at,count(*) AS event_count,
  sum(length(CAST(COALESCE(json_extract(payload_json,'$.text'),'') AS BLOB))) AS text_bytes,
  sum(json_extract(payload_json,'$.visual') IS NOT NULL) AS visual_count,
  sum(COALESCE(json_extract(payload_json,'$.interaction.clicks'),0)) AS clicks,
  sum(COALESCE(json_extract(payload_json,'$.interaction.keystrokes'),0)) AS keystrokes,
  sum(COALESCE(json_extract(payload_json,'$.interaction.scrolls'),0)) AS scrolls,
  max(json_extract(payload_json,'$.interaction') IS NOT NULL) AS has_interaction,
  max(kind IN ('utterance','effect','control')
    OR json_extract(payload_json,'$.opportunity') IS NOT NULL
    OR json_extract(payload_json,'$.effect') IS NOT NULL
    OR json_extract(payload_json,'$.control') IS NOT NULL) AS requires_body
FROM grouped GROUP BY segment ORDER BY first_sequence`;

export function readSourceCatalogue(
  database: Database.Database,
  attention: CognitionAttentionState,
  maxBytes: number,
): CognitionSourceCoverage {
  const from =
    attention.catalogueReviewedThroughSequence ??
    attention.analyzedThroughSequence;
  const totalEvents = (
    database
      .prepare(
        `SELECT count(*) AS count FROM cognition_evidence
    WHERE persona_id=? AND receipt_sequence>? AND receipt_sequence<=?`,
      )
      .get(attention.personaId, from, attention.lastReceiptSequence) as {
      count: number;
    }
  ).count;
  const coverage: CognitionSourceCoverage = {
    fromSequence: from,
    throughSequence: from,
    receivedThroughSequence: attention.lastReceiptSequence,
    eventCount: 0,
    entries: [],
    supplied: [],
    unopenedCount: 0,
    omittedEventCount: totalEvents,
    completionPending: false,
  };
  // The scan allowance is a candidate cost bound: at most one receipt per 32
  // allocated bytes, regardless of how much a long body's prefix compresses.
  const scanLimit = Math.max(1, Math.floor(maxBytes / 32));
  const rows = database
    .prepare(rowsSql)
    .iterate(
      attention.personaId,
      from,
      attention.lastReceiptSequence,
      scanLimit,
    ) as Iterable<{
    first_sequence: number;
    last_sequence: number;
    actor: Entry["actor"];
    kind: Entry["kind"];
    source_kind: Entry["sourceKind"];
    epoch: string | null;
    object_key: string | null;
    visibility: string | null;
    first_at: string;
    last_at: string;
    event_count: number;
    text_bytes: number;
    visual_count: number;
    clicks: number;
    keystrokes: number;
    scrolls: number;
    has_interaction: number;
    requires_body: number;
  }>;
  const identity = database.prepare(`SELECT id,
    substr(json_extract(payload_json,'$.object.title'),1,256) AS title
    FROM cognition_evidence WHERE persona_id=? AND receipt_sequence=?`);
  for (const row of rows) {
    const first = identity.get(attention.personaId, row.first_sequence) as {
      id: string;
      title: string | null;
    };
    const latest = identity.get(attention.personaId, row.last_sequence) as {
      id: string;
      title: string | null;
    };
    const entry: Entry = {
      id: `catalogue:${row.first_sequence}:${row.last_sequence}`,
      fromSequence: row.first_sequence,
      throughSequence: row.last_sequence,
      firstEvidenceId: first.id,
      latestEvidenceId: latest.id,
      actor: row.actor,
      kind: row.kind,
      sourceKind: row.source_kind,
      ...(row.epoch ? { sourceEpoch: row.epoch } : {}),
      ...(row.object_key ? { objectKey: row.object_key } : {}),
      ...(latest.title ? { title: latest.title } : {}),
      ...(row.visibility ? { visibility: row.visibility } : {}),
      firstAt: row.first_at,
      lastAt: row.last_at,
      eventCount: row.event_count,
      requiresBody: row.requires_body === 1,
      textBytes: row.text_bytes,
      visualCount: row.visual_count,
      ...(row.has_interaction
        ? {
            interaction: {
              clicks: row.clicks,
              keystrokes: row.keystrokes,
              scrolls: row.scrolls,
            },
          }
        : {}),
      changes: [],
      omittedChangeCount: 0,
    };
    const previousThrough = coverage.throughSequence;
    coverage.entries.push(entry);
    coverage.throughSequence = row.last_sequence;
    coverage.eventCount += row.event_count;
    coverage.unopenedCount = coverage.eventCount;
    coverage.omittedEventCount = totalEvents - coverage.eventCount;
    if (bytes(coverage) > maxBytes) {
      coverage.entries.pop();
      coverage.throughSequence = previousThrough;
      coverage.eventCount -= row.event_count;
      coverage.unopenedCount = coverage.eventCount;
      coverage.omittedEventCount = totalEvents - coverage.eventCount;
      if (!coverage.entries.length)
        throw new CognitionConflictError(
          "Catalogue allocation cannot hold the next source identity",
        );
      break;
    }
  }
  // Reserve all admitted identities first. The one immediately preceding
  // receipt can seed a matching segment across pages; it is not another new
  // event or a search through earlier objects. Unavailable/released text is
  // not an observed deletion. Known changes compete for the remaining bytes.
  const changeGroups: {
    entry: Entry;
    changes: { previous_id: string; id: string }[];
  }[] = [];
  for (const entry of coverage.entries) {
    if (
      entry.sourceKind !== "activity" ||
      entry.kind !== "observation" ||
      entry.requiresBody ||
      !entry.objectKey
    )
      continue;
    const changes = database
      .prepare(
        `WITH predecessor AS MATERIALIZED (
      SELECT id,receipt_sequence,actor,kind,source_kind,payload_json
      FROM cognition_evidence WHERE persona_id=? AND receipt_sequence<?
      ORDER BY receipt_sequence DESC LIMIT 1
    ), originals AS (
      SELECT id,receipt_sequence,payload_json
      FROM cognition_evidence WHERE persona_id=? AND receipt_sequence BETWEEN ? AND ?
      UNION ALL
      SELECT id,receipt_sequence,payload_json FROM predecessor
      WHERE actor=? AND kind='observation' AND source_kind='activity'
        AND json_extract(payload_json,'$.sourceEpoch') IS ?
        AND json_extract(payload_json,'$.object.key')=?
        AND json_extract(payload_json,'$.visibility') IS ?
        AND COALESCE(json_extract(payload_json,'$.boundary'),'') IN ('content','interaction','idle')
        AND json_extract(payload_json,'$.effect') IS NULL
        AND json_extract(payload_json,'$.opportunity') IS NULL
        AND json_extract(payload_json,'$.control') IS NULL
    ), readable AS (
      SELECT id,receipt_sequence,CASE WHEN json_extract(payload_json,'$.bodyReleasedAt') IS NULL
        THEN json_extract(payload_json,'$.text') END AS text FROM originals
    ), versions AS (
      SELECT id,receipt_sequence,text,
        lag(id) OVER (ORDER BY receipt_sequence) AS previous_id,
        lag(text) OVER (ORDER BY receipt_sequence) AS previous FROM readable
    ) SELECT previous_id,id FROM versions WHERE length(previous)>0 AND text IS NOT NULL
      AND substr(text,1,length(previous)) != previous ORDER BY receipt_sequence`,
      )
      .all(
        attention.personaId,
        entry.fromSequence,
        attention.personaId,
        entry.fromSequence,
        entry.throughSequence,
        entry.actor,
        entry.sourceEpoch ?? null,
        entry.objectKey,
        entry.visibility ?? null,
      ) as {
      previous_id: string;
      id: string;
    }[];
    entry.omittedChangeCount = changes.length;
    changeGroups.push({ entry, changes });
  }
  while (bytes(coverage) > maxBytes && coverage.entries.length) {
    const removed = coverage.entries.pop()!;
    coverage.eventCount -= removed.eventCount;
    coverage.unopenedCount = coverage.eventCount;
    coverage.omittedEventCount = totalEvents - coverage.eventCount;
    coverage.throughSequence = coverage.entries.at(-1)?.throughSequence ?? from;
  }
  if (totalEvents && !coverage.entries.length)
    throw new CognitionConflictError(
      "Catalogue allocation cannot hold the next source identity and coverage",
    );
  const admittedChanges = changeGroups.filter(({ entry }) =>
    coverage.entries.includes(entry),
  );
  let remainingChanges = admittedChanges.reduce(
    (total, group) => total + group.changes.length,
    0,
  );
  // Share remaining literal space across distinct replacement boundaries, so
  // the first long source cannot consume every later disappearance clue.
  for (const { entry, changes } of admittedChanges) {
    for (const change of changes) {
      const allowance = Math.floor(
        (maxBytes - bytes(coverage)) / remainingChanges,
      );
      remainingChanges -= 1;
      if (
        allowance <=
        bytes({
          evidenceId: change.previous_id,
          replacedByEvidenceId: change.id,
          excerpt: "",
          startCharacter: 0,
          excerpted: true,
        })
      )
        break;
      const excerpt = changedOriginalExcerpt(
        database,
        change.previous_id,
        change.id,
        allowance,
      );
      if (!excerpt) break;
      entry.changes.push(excerpt);
      entry.omittedChangeCount -= 1;
      if (bytes(coverage) > maxBytes) {
        entry.changes.pop();
        entry.omittedChangeCount += 1;
        break;
      }
    }
  }
  return coverage;
}

function changedOriginalExcerpt(
  database: Database.Database,
  oldId: string,
  newId: string,
  maxBytes: number,
): Entry["changes"][number] | undefined {
  const pair = database
    .prepare(
      `SELECT length(json_extract(old.payload_json,'$.text')) AS old_length,
    length(COALESCE(json_extract(new.payload_json,'$.text'),'')) AS new_length
    FROM cognition_evidence old,cognition_evidence new WHERE old.id=? AND new.id=?`,
    )
    .get(oldId, newId) as { old_length: number; new_length: number };
  // Binary search uses SQLite substring equality. Full bodies never cross the
  // boundary, including when the only change is at the end of a long document.
  const equalPrefix =
    database.prepare(`SELECT substr(json_extract(old.payload_json,'$.text'),1,?)=
    substr(COALESCE(json_extract(new.payload_json,'$.text'),''),1,?) AS equal
    FROM cognition_evidence old,cognition_evidence new WHERE old.id=? AND new.id=?`);
  let lo = 0;
  let hi = Math.min(pair.old_length, pair.new_length);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((equalPrefix.get(mid, mid, oldId, newId) as { equal: number }).equal)
      lo = mid;
    else hi = mid - 1;
  }
  const base = {
    evidenceId: oldId,
    replacedByEvidenceId: newId,
    excerpt: "",
    startCharacter: Math.max(0, lo - 48),
    excerpted: true,
  };
  const available = maxBytes - bytes(base);
  if (available <= 0) return undefined;
  const query = database.prepare(
    "SELECT substr(json_extract(payload_json,'$.text'),?,?) AS text FROM cognition_evidence WHERE id=?",
  );
  let chars = Math.floor(available / 4);
  // JSON escaping may cost more than four bytes; reduce the literal excerpt,
  // not its provenance, until its complete encoded representation fits.
  while (chars > 0) {
    const startCharacter = Math.max(
      0,
      lo - Math.min(48, Math.floor(chars / 3)),
    );
    const excerpt = (
      query.get(startCharacter + 1, chars, oldId) as { text: string }
    ).text;
    const result = {
      ...base,
      startCharacter,
      excerpt,
      excerpted:
        startCharacter > 0 ||
        startCharacter + Array.from(excerpt).length < pair.old_length,
    };
    if (bytes(result) <= maxBytes) return result;
    chars = Math.floor(chars / 2);
  }
  return undefined;
}

export function validateSourceReadPlan(
  coverage: CognitionSourceCoverage | undefined,
  plan: CognitionSourceReadPlan,
): void {
  if (!coverage)
    throw new CognitionConflictError(
      "Source reading requires a supplied catalogue",
    );
  const seen = new Set<string>();
  for (const request of plan.requests) {
    const entry = coverage.entries.find(({ id }) => id === request.catalogueId);
    if (
      !entry ||
      ![
        entry.firstEvidenceId,
        entry.latestEvidenceId,
        ...entry.changes.flatMap((change) => [
          change.evidenceId,
          change.replacedByEvidenceId,
        ]),
      ].includes(request.evidenceId)
    )
      throw new CognitionConflictError(
        "Source request must name an original actually listed in the supplied catalogue",
      );
    const startCharacter = request.startCharacter ?? 0;
    if (
      startCharacter !== 0 &&
      !entry.changes.some(
        (change) =>
          change.evidenceId === request.evidenceId &&
          change.startCharacter === startCharacter,
      )
    )
      throw new CognitionConflictError(
        "Source position must be zero or an actually displayed change position for this original",
      );
    if (seen.has(request.evidenceId))
      throw new CognitionConflictError("Source request repeats an original");
    seen.add(request.evidenceId);
  }
}

export function recordSourceSupply(
  coverage: CognitionSourceCoverage,
  snapshot: CognitionSnapshot,
  excerptedIds: readonly string[],
  ranges?: ReadonlyMap<
    string,
    NonNullable<CognitionSourceCoverage["supplied"][number]["textRange"]>
  >,
): void {
  const previous = new Map(
    coverage.supplied
      .filter((item) => item.textRange)
      .map((item) => [item.evidenceId, item.textRange!]),
  );
  const suppliedRanges = ranges ?? previous;
  const excerpts = new Set(excerptedIds);
  coverage.supplied = snapshot.evidence.map(({ id, receiptSequence }) => ({
    evidenceId: id,
    receiptSequence,
    ...(suppliedRanges.has(id) ? { textRange: suppliedRanges.get(id)! } : {}),
    status: excerpts.has(id) ? "excerpted" : "complete",
  }));
  const suppliedInRange = coverage.supplied.filter(
    ({ receiptSequence }) =>
      receiptSequence > coverage.fromSequence &&
      receiptSequence <= coverage.throughSequence,
  ).length;
  coverage.unopenedCount = Math.max(0, coverage.eventCount - suppliedInRange);
}
