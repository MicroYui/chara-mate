import type Database from "better-sqlite3";

import type {
  MemoryHistoryStatus,
  MemoryPriorDisposition,
} from "../../shared/contracts/memory";
import { MemoryPriorDispositionSchema } from "../../shared/schemas/memory";
import { parseSchema } from "../../shared/schemas/validation";
import { MemoryError } from "./memoryError";

/** Revision order belongs to the persisted predecessor chain, not timestamps or
 * rowids. Older unlinked revisions remain addressable but have no inferred past
 * truth. This status describes revision position/truth, independent of temporal
 * applicability. Recall separately checks validFrom/validTo at its read clock. */
/** The requested identities are a statement-local relation, not a persistent
 * cache. Walk each requested Memory once and project both status fields from
 * the same chosen disposition. Current-only reads need no predecessor walk. */
export function memoryRevisionHistoryCte(targetSql: string): string {
  return `WITH RECURSIVE
    revision_history_targets AS MATERIALIZED (${targetSql}),
    revision_history_roots AS MATERIALIZED (
      SELECT hm.id AS memory_id,hm.current_revision_id,hm.status
      FROM memories hm WHERE hm.id IN (SELECT memory_id FROM revision_history_targets)
    ),
    revision_history_walk AS MATERIALIZED (
      SELECT hr.id,hr.memory_id,hr.predecessor_revision_id,hr.prior_dispositions_json,0 AS depth
      FROM revision_history_roots root JOIN memory_revisions hr ON hr.id=root.current_revision_id
      WHERE EXISTS (SELECT 1 FROM revision_history_targets target WHERE target.memory_id=root.memory_id
        AND (target.id<>root.current_revision_id OR root.status<>'active'))
      UNION ALL
      SELECT hp.id,hp.memory_id,hp.predecessor_revision_id,hp.prior_dispositions_json,h.depth+1
      FROM revision_history_walk h JOIN memory_revisions hp ON hp.id=h.predecessor_revision_id
    ),
    revision_history_dispositions AS MATERIALIZED (
      SELECT h.memory_id,CAST(json_extract(hd.value,'$.revisionId') AS TEXT) AS target_id,
        json_extract(hd.value,'$.disposition') AS disposition,h.id AS status_revision_id,h.depth
      FROM revision_history_walk h,json_each(h.prior_dispositions_json) hd
    ),
    revision_history_choices AS MATERIALIZED (
      SELECT target.id,hd.disposition,hd.status_revision_id,
        ROW_NUMBER() OVER (PARTITION BY target.id
          ORDER BY (hd.disposition='corrected') DESC,hd.depth) AS choice
      FROM revision_history_dispositions hd
      JOIN revision_history_targets target ON target.id=hd.target_id
        AND target.memory_id=hd.memory_id
      LEFT JOIN revision_history_walk target_position ON target_position.id=target.id
      WHERE target_position.depth IS NULL OR hd.depth<=target_position.depth
    ),
    revision_history AS MATERIALIZED (
      SELECT target.id,
        CASE WHEN target.id=root.current_revision_id AND root.status='active' THEN 'current'
          ELSE COALESCE(disposition.disposition,'unresolved') END AS history_status,
        CASE WHEN target.id=root.current_revision_id AND root.status='active' THEN NULL
          ELSE disposition.status_revision_id END AS history_status_revision_id
      FROM revision_history_targets target JOIN revision_history_roots root ON root.memory_id=target.memory_id
      LEFT JOIN revision_history_choices disposition ON disposition.id=target.id AND disposition.choice=1
    )`;
}

/** Nested dependency qualification uses the same relation for one exact parent;
 * its caller needs only the status, without materializing source text. */
export function memoryRevisionHistorySql(
  revisionAlias = "r",
  memoryAlias = "m",
): { status: string } {
  return {
    status: `(${memoryRevisionHistoryCte(`SELECT ${revisionAlias}.id AS id,${memoryAlias}.id AS memory_id`)}
      SELECT history_status FROM revision_history)`,
  };
}

export function memoryRevisionHistoryColumns(alias = "rh"): string {
  return `${alias}.history_status AS history_status,${alias}.history_status_revision_id AS history_status_revision_id`;
}

export interface MemoryRevisionHistoryRow {
  history_status: MemoryHistoryStatus;
  history_status_revision_id: string | null;
}

export function revisionHistoryValue(row: MemoryRevisionHistoryRow): {
  historyStatus: MemoryHistoryStatus;
  historyStatusRevisionId?: string;
} {
  return {
    historyStatus: row.history_status,
    ...(row.history_status_revision_id
      ? { historyStatusRevisionId: row.history_status_revision_id }
      : {}),
  };
}

/** Called inside the existing Revision transaction, immediately before append. */
export function validatePriorDispositions(
  database: Database.Database,
  input: {
    memoryId: string;
    predecessorRevisionId: string;
    priorDispositions: readonly MemoryPriorDisposition[];
  },
): MemoryPriorDisposition[] {
  const current = database
    .prepare("SELECT current_revision_id FROM memories WHERE id=?")
    .get(input.memoryId) as { current_revision_id: string } | undefined;
  if (current?.current_revision_id !== input.predecessorRevisionId)
    throw new MemoryError(
      "MEMORY.CONFLICT",
      "记忆已在修订期间改变，需要重新比较当前版本。",
      false,
    );
  const values = input.priorDispositions.map((value) =>
    parseSchema(MemoryPriorDispositionSchema, value),
  );
  const targets = new Set(values.map(({ revisionId }) => revisionId));
  if (
    targets.size !== values.length ||
    !targets.has(input.predecessorRevisionId)
  )
    throw new TypeError(
      "Revision dispositions must uniquely include the actual predecessor",
    );
  const valid = database
    .prepare(
      `SELECT id FROM memory_revisions WHERE memory_id=?
       AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(input.memoryId, JSON.stringify([...targets])) as { id: string }[];
  if (valid.length !== targets.size)
    throw new TypeError(
      "Revision disposition targets must already exist in this same Memory",
    );
  return values;
}
