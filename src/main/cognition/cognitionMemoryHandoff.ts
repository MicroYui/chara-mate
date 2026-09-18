import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CognitionEvidence,
  CognitionMemoryHandoff,
} from "../../shared/contracts/cognition";
import { CognitionMemoryHandoffSchema } from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import { readEvidenceMetadata } from "./cognitionSnapshotReader";

export type CognitionMemoryHandoffInput = Omit<
  CognitionMemoryHandoff,
  "id" | "contextGroups"
>;
const unique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

function primaryRows(
  database: Database.Database,
  personaId: string,
  ids: readonly string[],
) {
  const rows = database
    .prepare(
      `SELECT id,receipt_sequence FROM cognition_evidence
    WHERE persona_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY receipt_sequence`,
    )
    .all(personaId, JSON.stringify(unique(ids))) as {
    id: string;
    receipt_sequence: number;
  }[];
  if (rows.length !== new Set(ids).size)
    throw new Error(
      "Memory handoff source is missing or belongs to another Persona",
    );
  return rows;
}

/** Freeze indexed Episode membership, without loading any source or Situation body. */
function freezeContextGroups(
  database: Database.Database,
  personaId: string,
  primaryEvidenceIds: readonly string[],
): CognitionMemoryHandoff["contextGroups"] {
  const anchors = primaryRows(database, personaId, primaryEvidenceIds);
  const cutoff = anchors.at(-1)!.receipt_sequence;
  const episodes = database
    .prepare(
      `SELECT link.situation_id,link.episode_id,
    json_group_array(link.evidence_id) AS anchors
    FROM cognition_episode_evidence link
    JOIN cognition_situations s ON s.id = link.situation_id
    WHERE s.persona_id = ? AND link.evidence_id IN (SELECT value FROM json_each(?))
    GROUP BY link.situation_id,link.episode_id`,
    )
    .all(personaId, JSON.stringify(primaryEvidenceIds)) as {
    situation_id: string;
    episode_id: string;
    anchors: string;
  }[];
  const contexts =
    database.prepare(`SELECT e.id FROM cognition_episode_evidence link
    JOIN cognition_evidence e ON e.id = link.evidence_id
    WHERE link.situation_id = ? AND link.episode_id = ? AND e.persona_id = ?
      AND e.receipt_sequence <= ? ORDER BY e.id`);
  const groups = new Map<
    string,
    CognitionMemoryHandoff["contextGroups"][number]
  >();
  for (const episode of episodes) {
    const ids = (
      contexts.all(
        episode.situation_id,
        episode.episode_id,
        personaId,
        cutoff,
      ) as { id: string }[]
    ).map((row) => row.id);
    const key = JSON.stringify(ids);
    const current = groups.get(key);
    const anchorIds = parseSchema(
      CognitionMemoryHandoffSchema.properties.primaryEvidenceIds,
      JSON.parse(episode.anchors),
    );
    groups.set(key, {
      anchorEvidenceIds: unique([
        ...(current?.anchorEvidenceIds ?? []),
        ...anchorIds,
      ]),
      contextEvidenceIds: ids,
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
}

export function enqueueMemoryHandoff(
  database: Database.Database,
  input: CognitionMemoryHandoffInput,
): boolean {
  if (!database.inTransaction)
    throw new Error(
      "Memory handoff must share the Cognition state transaction",
    );
  if (!input.primaryEvidenceIds.length) return false;
  const primaryEvidenceIds = unique(input.primaryEvidenceIds);
  const historyEvidenceIds = unique(input.historyEvidenceIds);
  primaryRows(database, input.personaId, historyEvidenceIds);
  const contextGroups = freezeContextGroups(
    database,
    input.personaId,
    primaryEvidenceIds,
  );
  const value = parseSchema(CognitionMemoryHandoffSchema, {
    ...input,
    id: randomUUID(),
    primaryEvidenceIds,
    historyEvidenceIds,
    contextGroups,
  });
  // Ordinary exact pending deduplication, not a state/version or evidence chain.
  const sourceKey = createHash("sha256")
    .update(
      JSON.stringify({ primaryEvidenceIds, historyEvidenceIds, contextGroups }),
    )
    .digest("hex");
  return (
    database
      .prepare(
        `INSERT OR IGNORE INTO cognition_memory_handoffs
    (id,persona_id,situation_id,source_key,payload_json,created_at) VALUES(?,?,?,?,?,?)`,
      )
      .run(
        value.id,
        value.personaId,
        value.situationId,
        sourceKey,
        JSON.stringify(value),
        value.committedAt,
      ).changes > 0
  );
}

/** No live SQLite cursor remains across a yield, so Main can enqueue and acknowledge. */
export function* pendingMemoryHandoffs(
  database: Database.Database,
): Iterable<CognitionMemoryHandoff> {
  let createdAt = "",
    id = "";
  const query =
    database.prepare(`SELECT id,created_at,payload_json FROM cognition_memory_handoffs
    WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at,id LIMIT 1`);
  for (;;) {
    const row = query.get(createdAt, createdAt, id) as
      { id: string; created_at: string; payload_json: string } | undefined;
    if (!row) return;
    createdAt = row.created_at;
    id = row.id;
    yield parseSchema(
      CognitionMemoryHandoffSchema,
      JSON.parse(row.payload_json),
    );
  }
}

function* evidenceByIds(
  database: Database.Database,
  personaId: string,
  ids: readonly string[],
  cutoff?: number,
): Iterable<CognitionEvidence> {
  // Receipt numbers are immutable; retain no active cursor while a consumer writes.
  const rows = primaryRows(database, personaId, ids);
  for (const row of rows) {
    if (cutoff !== undefined && row.receipt_sequence > cutoff) continue;
    const evidence = readEvidenceMetadata(database, row.id);
    if (!evidence || evidence.personaId !== personaId)
      throw new Error("Memory handoff source no longer exists");
    yield evidence;
  }
}

export function memoryHandoffEvidence(
  database: Database.Database,
  handoff: CognitionMemoryHandoff,
  evidenceIds: readonly string[],
): Iterable<CognitionEvidence> {
  const permitted = new Set([
    ...handoff.primaryEvidenceIds,
    ...handoff.historyEvidenceIds,
    ...handoff.contextGroups.flatMap((group) => group.contextEvidenceIds),
  ]);
  if (evidenceIds.some((id) => !permitted.has(id)))
    throw new Error("Evidence is outside the frozen Memory handoff");
  return evidenceByIds(database, handoff.personaId, evidenceIds);
}

export function memoryHandoffContext(
  database: Database.Database,
  handoff: CognitionMemoryHandoff,
  acceptedPrimaryEvidenceIds: readonly string[],
): Iterable<CognitionEvidence> {
  if (!acceptedPrimaryEvidenceIds.length) return [];
  const accepted = new Set(acceptedPrimaryEvidenceIds);
  if ([...accepted].some((id) => !handoff.primaryEvidenceIds.includes(id)))
    throw new Error(
      "Accepted primary source is outside the frozen Memory handoff",
    );
  const cutoff = primaryRows(database, handoff.personaId, [...accepted]).at(
    -1,
  )!.receipt_sequence;
  const contextIds = unique(
    handoff.contextGroups.flatMap((group) =>
      group.anchorEvidenceIds.some((id) => accepted.has(id))
        ? group.contextEvidenceIds
        : [],
    ),
  ).filter((id) => !accepted.has(id));
  return evidenceByIds(database, handoff.personaId, contextIds, cutoff);
}

export function acknowledgeMemoryHandoff(
  database: Database.Database,
  id: string,
): boolean {
  if (!database.inTransaction)
    throw new Error(
      "Memory intake and acknowledgement require the same transaction",
    );
  return (
    database
      .prepare("DELETE FROM cognition_memory_handoffs WHERE id = ?")
      .run(id).changes > 0
  );
}
