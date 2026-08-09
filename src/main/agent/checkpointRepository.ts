import type Database from "better-sqlite3";

import type { JsonValue, Timestamp } from "../../shared/contracts/primitives";
import { JsonValueSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import { serializeForPersistence } from "../db/persistenceBoundary";

export type CheckpointPhase =
  "model" | "tool" | "approval" | "input" | "interrupted";

export interface AgentCheckpoint {
  readonly context: JsonValue;
  readonly generation: number;
  readonly lastCompletedSequence: number;
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly updatedAt: Timestamp;
}

interface CheckpointRow {
  context_json: string;
  generation: number;
  last_completed_sequence: number;
  phase: CheckpointPhase;
  run_id: string;
  updated_at: Timestamp;
}

function readCheckpoint(row: CheckpointRow): AgentCheckpoint {
  return {
    context: parseSchema(JsonValueSchema, JSON.parse(row.context_json)),
    generation: row.generation,
    lastCompletedSequence: row.last_completed_sequence,
    phase: row.phase,
    runId: row.run_id,
    updatedAt: row.updated_at,
  };
}

export class CheckpointRepository {
  constructor(private readonly database: Database.Database) {}

  get(runId: string): AgentCheckpoint | undefined {
    const row = this.database
      .prepare(
        `SELECT run_id, generation, phase, context_json,
                last_completed_sequence, updated_at
         FROM checkpoints
         WHERE run_id = ?`,
      )
      .get(runId) as CheckpointRow | undefined;
    return row ? readCheckpoint(row) : undefined;
  }

  save(checkpoint: AgentCheckpoint): AgentCheckpoint {
    if (!Number.isInteger(checkpoint.generation) || checkpoint.generation < 1) {
      throw new TypeError("Checkpoint generation must be a positive integer");
    }
    if (
      !Number.isInteger(checkpoint.lastCompletedSequence) ||
      checkpoint.lastCompletedSequence < 0
    ) {
      throw new TypeError("Checkpoint sequence must be a non-negative integer");
    }
    const context = parseSchema(JsonValueSchema, checkpoint.context);
    this.database
      .prepare(
        `INSERT INTO checkpoints (
           run_id, generation, phase, context_json,
           last_completed_sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           generation = excluded.generation,
           phase = excluded.phase,
           context_json = excluded.context_json,
           last_completed_sequence = excluded.last_completed_sequence,
           updated_at = excluded.updated_at`,
      )
      .run(
        checkpoint.runId,
        checkpoint.generation,
        checkpoint.phase,
        serializeForPersistence(context),
        checkpoint.lastCompletedSequence,
        checkpoint.updatedAt,
      );
    return { ...checkpoint, context };
  }

  delete(runId: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM checkpoints WHERE run_id = ?")
        .run(runId).changes === 1
    );
  }
}
