import { Type, type Static } from "@sinclair/typebox";
import type Database from "better-sqlite3";

import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";

export const ProactiveOpportunityStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("evaluating"),
  Type.Literal("resolved"),
  Type.Literal("cancelled"),
]);

export const ProactiveOpportunityOutcomeSchema = Type.Union([
  Type.Literal("silent"),
  Type.Literal("delivered"),
  Type.Literal("failed"),
]);

export const ProactiveOpportunitySchema = Type.Object(
  {
    claimedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    evaluateAt: TimestampSchema,
    id: EntityIdSchema,
    messageId: Type.Optional(EntityIdSchema),
    outcome: Type.Optional(ProactiveOpportunityOutcomeSchema),
    reason: NonBlankStringSchema,
    resolvedAt: Type.Optional(TimestampSchema),
    runId: Type.Optional(EntityIdSchema),
    sourceMemoryId: EntityIdSchema,
    sourceRevisionId: EntityIdSchema,
    state: ProactiveOpportunityStateSchema,
    targetChatId: EntityIdSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export type ProactiveOpportunity = Static<typeof ProactiveOpportunitySchema>;
export type ProactiveOpportunityOutcome = Static<
  typeof ProactiveOpportunityOutcomeSchema
>;

interface ProactiveOpportunityRow {
  readonly claimed_at: string | null;
  readonly created_at: string;
  readonly evaluate_at: string;
  readonly id: string;
  readonly message_id: string | null;
  readonly outcome: string | null;
  readonly reason: string;
  readonly resolved_at: string | null;
  readonly run_id: string | null;
  readonly source_memory_id: string;
  readonly source_revision_id: string;
  readonly state: string;
  readonly target_chat_id: string;
  readonly updated_at: string;
}

const COLUMNS = `
  id, source_memory_id, source_revision_id, target_chat_id, evaluate_at,
  state, outcome, reason, run_id, message_id, claimed_at, resolved_at,
  created_at, updated_at
`;

function readOpportunity(row: ProactiveOpportunityRow): ProactiveOpportunity {
  return parseSchema(ProactiveOpportunitySchema, {
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    createdAt: row.created_at,
    evaluateAt: row.evaluate_at,
    id: row.id,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    reason: row.reason,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    sourceMemoryId: row.source_memory_id,
    sourceRevisionId: row.source_revision_id,
    state: row.state,
    targetChatId: row.target_chat_id,
    updatedAt: row.updated_at,
  });
}

export class ProactiveOpportunityRepository {
  constructor(private readonly database: Database.Database) {}

  get(id: string): ProactiveOpportunity | undefined {
    const row = this.database
      .prepare(`SELECT ${COLUMNS} FROM proactive_opportunities WHERE id = ?`)
      .get(id) as ProactiveOpportunityRow | undefined;
    return row ? readOpportunity(row) : undefined;
  }

  findByRunId(runId: string): ProactiveOpportunity | undefined {
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM proactive_opportunities WHERE run_id = ?`,
      )
      .get(runId) as ProactiveOpportunityRow | undefined;
    return row ? readOpportunity(row) : undefined;
  }

  findLatestForMemory(memoryId: string): ProactiveOpportunity | undefined {
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS}
         FROM proactive_opportunities
         WHERE source_memory_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(memoryId) as ProactiveOpportunityRow | undefined;
    return row ? readOpportunity(row) : undefined;
  }

  listOpen(): ProactiveOpportunity[] {
    return (
      this.database
        .prepare(
          `SELECT ${COLUMNS}
           FROM proactive_opportunities
           WHERE state IN ('pending', 'evaluating')
           ORDER BY evaluate_at, id`,
        )
        .all() as ProactiveOpportunityRow[]
    ).map(readOpportunity);
  }

  listEvaluating(): ProactiveOpportunity[] {
    return (
      this.database
        .prepare(
          `SELECT ${COLUMNS}
           FROM proactive_opportunities
           WHERE state = 'evaluating'
           ORDER BY claimed_at, id`,
        )
        .all() as ProactiveOpportunityRow[]
    ).map(readOpportunity);
  }

  earliestPendingAt(): string | undefined {
    const row = this.database
      .prepare(
        `SELECT evaluate_at
         FROM proactive_opportunities
         WHERE state = 'pending'
         ORDER BY evaluate_at, id
         LIMIT 1`,
      )
      .get() as { evaluate_at: string } | undefined;
    return row?.evaluate_at;
  }

  insert(input: {
    readonly evaluateAt: string;
    readonly id: string;
    readonly now: string;
    readonly reason: string;
    readonly sourceMemoryId: string;
    readonly sourceRevisionId: string;
    readonly targetChatId: string;
  }): ProactiveOpportunity {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO proactive_opportunities (
           id, source_memory_id, source_revision_id, target_chat_id,
           evaluate_at, state, reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceMemoryId,
        input.sourceRevisionId,
        input.targetChatId,
        input.evaluateAt,
        input.reason,
        input.now,
        input.now,
      );
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS}
         FROM proactive_opportunities
         WHERE source_revision_id = ?`,
      )
      .get(input.sourceRevisionId) as ProactiveOpportunityRow | undefined;
    if (!row) throw new Error("Proactive opportunity was not persisted");
    return readOpportunity(row);
  }

  cancelOpenForMemory(
    memoryId: string,
    now: string,
    exceptRevisionId?: string,
  ): number {
    const result = exceptRevisionId
      ? this.database
          .prepare(
            `UPDATE proactive_opportunities
             SET state = 'cancelled', outcome = NULL, resolved_at = ?, updated_at = ?
             WHERE source_memory_id = ?
               AND source_revision_id <> ?
               AND state IN ('pending', 'evaluating')`,
          )
          .run(now, now, memoryId, exceptRevisionId)
      : this.database
          .prepare(
            `UPDATE proactive_opportunities
             SET state = 'cancelled', outcome = NULL, resolved_at = ?, updated_at = ?
             WHERE source_memory_id = ?
               AND state IN ('pending', 'evaluating')`,
          )
          .run(now, now, memoryId);
    return result.changes;
  }

  cancelAllOpen(now: string): number {
    return this.database
      .prepare(
        `UPDATE proactive_opportunities
         SET state = 'cancelled', outcome = NULL, resolved_at = ?, updated_at = ?
         WHERE state IN ('pending', 'evaluating')`,
      )
      .run(now, now).changes;
  }

  resetUnstartedEvaluations(now: string): number {
    return this.database
      .prepare(
        `UPDATE proactive_opportunities
         SET state = 'pending', claimed_at = NULL, updated_at = ?
         WHERE state = 'evaluating' AND run_id IS NULL`,
      )
      .run(now).changes;
  }

  releaseForRetry(id: string, now: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE proactive_opportunities
           SET state = 'pending', outcome = NULL, run_id = NULL,
               message_id = NULL, claimed_at = NULL, resolved_at = NULL,
               updated_at = ?
           WHERE id = ? AND state = 'evaluating'`,
        )
        .run(now, id).changes === 1
    );
  }

  reopenCancelled(
    id: string,
    input: {
      readonly evaluateAt: string;
      readonly now: string;
      readonly reason: string;
      readonly targetChatId: string;
    },
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE proactive_opportunities
           SET target_chat_id = ?, evaluate_at = ?, state = 'pending',
               outcome = NULL, reason = ?, run_id = NULL, message_id = NULL,
               claimed_at = NULL, resolved_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'cancelled'`,
        )
        .run(input.targetChatId, input.evaluateAt, input.reason, input.now, id)
        .changes === 1
    );
  }

  claimNextDue(now: string): ProactiveOpportunity | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT ${COLUMNS}
           FROM proactive_opportunities
           WHERE state = 'pending' AND evaluate_at <= ?
           ORDER BY evaluate_at, id
           LIMIT 1`,
        )
        .get(now) as ProactiveOpportunityRow | undefined;
      if (!row) return undefined;
      const claimed = this.database
        .prepare(
          `UPDATE proactive_opportunities
           SET state = 'evaluating', claimed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(now, now, row.id);
      if (claimed.changes !== 1) return undefined;
      return this.get(row.id);
    })();
  }

  attachRun(id: string, runId: string, now: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE proactive_opportunities
           SET run_id = ?, updated_at = ?
           WHERE id = ? AND state = 'evaluating' AND run_id IS NULL`,
        )
        .run(runId, now, id).changes === 1
    );
  }

  resolve(
    id: string,
    outcome: ProactiveOpportunityOutcome,
    now: string,
    messageId?: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE proactive_opportunities
           SET state = 'resolved', outcome = ?, message_id = ?,
               resolved_at = ?, updated_at = ?
           WHERE id = ? AND state = 'evaluating'`,
        )
        .run(outcome, messageId ?? null, now, now, id).changes === 1
    );
  }
}
