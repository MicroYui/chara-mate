import type Database from "better-sqlite3";

import type {
  EvolutionCandidate,
  EvolutionListRequest,
  EvolutionReview,
  EvolutionSnapshot,
} from "../../shared/contracts/evolution";
import type { AppError } from "../../shared/contracts/run";
import {
  EvolutionCandidateSchema,
  EvolutionReviewSchema,
} from "../../shared/schemas/evolution";
import { parseSchema } from "../../shared/schemas/validation";
import {
  sanitizeForPersistence,
  serializeForPersistence,
} from "../db/persistenceBoundary";

interface EvolutionReviewRow {
  chat_id: string;
  completed_at: string | null;
  created_at: string;
  error_json: string | null;
  id: string;
  run_id: string;
  started_at: string | null;
  status: EvolutionReview["status"];
  tool_signature: string | null;
  triggers_json: string;
  updated_at: string;
}

interface EvolutionCandidateRow {
  activated_at: string | null;
  activated_memory_id: string | null;
  activated_skill_id: string | null;
  activated_skill_revision: number | null;
  archived_at: string | null;
  chat_id: string;
  created_at: string;
  evidence_json: string;
  id: string;
  kind: EvolutionCandidate["kind"];
  pinned: number;
  proposal_json: string;
  rationale: string;
  replay_cases_json: string;
  replay_completed_at: string | null;
  replay_failure_reason: string | null;
  replay_status: EvolutionCandidate["replayResult"]["status"];
  review_id: string;
  source_item_ids_json: string;
  source_run_ids_json: string;
  status: EvolutionCandidate["status"];
  updated_at: string;
}

function readJson(value: string): unknown {
  return JSON.parse(value);
}

function readReview(row: EvolutionReviewRow): EvolutionReview {
  return parseSchema(EvolutionReviewSchema, {
    chatId: row.chat_id,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    ...(row.error_json ? { error: readJson(row.error_json) } : {}),
    id: row.id,
    runId: row.run_id,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    status: row.status,
    triggers: readJson(row.triggers_json),
    updatedAt: row.updated_at,
  });
}

function readCandidate(row: EvolutionCandidateRow): EvolutionCandidate {
  return parseSchema(EvolutionCandidateSchema, {
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.activated_memory_id
      ? { activatedMemoryId: row.activated_memory_id }
      : {}),
    ...(row.activated_skill_id
      ? { activatedSkillId: row.activated_skill_id }
      : {}),
    ...(row.activated_skill_revision === null
      ? {}
      : { activatedSkillRevision: row.activated_skill_revision }),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    chatId: row.chat_id,
    createdAt: row.created_at,
    evidence: readJson(row.evidence_json),
    id: row.id,
    kind: row.kind,
    pinned: row.pinned === 1,
    proposal: readJson(row.proposal_json),
    rationale: row.rationale,
    replayCases: readJson(row.replay_cases_json),
    replayResult: {
      ...(row.replay_completed_at
        ? { completedAt: row.replay_completed_at }
        : {}),
      ...(row.replay_failure_reason
        ? { failureReason: row.replay_failure_reason }
        : {}),
      status: row.replay_status,
    },
    reviewId: row.review_id,
    sourceItemIds: readJson(row.source_item_ids_json),
    sourceRunIds: readJson(row.source_run_ids_json),
    status: row.status,
    updatedAt: row.updated_at,
  });
}

export class EvolutionRepository {
  constructor(private readonly database: Database.Database) {}

  createReview(
    review: EvolutionReview,
    toolSignature?: string,
  ): EvolutionReview {
    const persisted = sanitizeForPersistence(EvolutionReviewSchema, review);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO evolution_reviews (
           id, run_id, chat_id, status, triggers_json, tool_signature,
           error_json, created_at, started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        persisted.id,
        persisted.runId,
        persisted.chatId,
        persisted.status,
        serializeForPersistence(persisted.triggers),
        toolSignature ?? null,
        persisted.error ? serializeForPersistence(persisted.error) : null,
        persisted.createdAt,
        persisted.startedAt ?? null,
        persisted.completedAt ?? null,
        persisted.updatedAt,
      );
    return this.requireReviewByRun(persisted.runId);
  }

  getReviewByRun(runId: string): EvolutionReview | undefined {
    const row = this.database
      .prepare("SELECT * FROM evolution_reviews WHERE run_id = ?")
      .get(runId) as EvolutionReviewRow | undefined;
    return row ? readReview(row) : undefined;
  }

  requireReviewByRun(runId: string): EvolutionReview {
    const review = this.getReviewByRun(runId);
    if (!review) throw new Error(`Evolution review for Run ${runId} is absent`);
    return review;
  }

  listQueuedReviews(): EvolutionReview[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM evolution_reviews
           WHERE status = 'queued'
           ORDER BY created_at, id`,
        )
        .all() as EvolutionReviewRow[]
    ).map(readReview);
  }

  recoverRunningReviews(now: string): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE evolution_reviews
           SET status = 'queued', started_at = NULL, updated_at = ?
           WHERE status = 'running'`,
        )
        .run(now);
      this.database
        .prepare(
          `UPDATE evolution_candidates
           SET replay_status = 'pending', replay_failure_reason = NULL,
               replay_completed_at = NULL, updated_at = ?
           WHERE status = 'accepted' AND replay_status = 'running'`,
        )
        .run(now);
    })();
  }

  listPendingReplayCandidateIds(): string[] {
    return (
      this.database
        .prepare(
          `SELECT id FROM evolution_candidates
           WHERE status = 'accepted'
             AND replay_status IN ('pending', 'passed')
           ORDER BY updated_at, id`,
        )
        .all() as Array<{ id: string }>
    ).map(({ id }) => id);
  }

  listActivatedSkillIds(): string[] {
    return (
      this.database
        .prepare(
          `SELECT DISTINCT activated_skill_id AS id
           FROM evolution_candidates
           WHERE activated_skill_id IS NOT NULL
           ORDER BY activated_skill_id`,
        )
        .all() as Array<{ id: string }>
    ).map(({ id }) => id);
  }

  hasPriorToolSignature(signature: string, runId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM evolution_reviews
           WHERE tool_signature = ? AND run_id <> ?
           LIMIT 1`,
        )
        .get(signature, runId),
    );
  }

  updateReview(input: {
    readonly completedAt?: string;
    readonly error?: AppError;
    readonly runId: string;
    readonly startedAt?: string;
    readonly status: EvolutionReview["status"];
    readonly updatedAt: string;
  }): EvolutionReview {
    const current = this.requireReviewByRun(input.runId);
    this.database
      .prepare(
        `UPDATE evolution_reviews
         SET status = ?, error_json = ?, started_at = ?, completed_at = ?,
             updated_at = ?
         WHERE run_id = ?`,
      )
      .run(
        input.status,
        input.error ? serializeForPersistence(input.error) : null,
        input.startedAt ?? current.startedAt ?? null,
        input.completedAt ?? current.completedAt ?? null,
        input.updatedAt,
        input.runId,
      );
    return this.requireReviewByRun(input.runId);
  }

  resetReview(runId: string, updatedAt: string): EvolutionReview {
    this.requireReviewByRun(runId);
    this.database
      .prepare(
        `UPDATE evolution_reviews
         SET status = 'queued', error_json = NULL, started_at = NULL,
             completed_at = NULL, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(updatedAt, runId);
    return this.requireReviewByRun(runId);
  }

  insertCandidate(candidate: EvolutionCandidate): EvolutionCandidate {
    const persisted = sanitizeForPersistence(
      EvolutionCandidateSchema,
      candidate,
    );
    this.database
      .prepare(
        `INSERT INTO evolution_candidates (
           id, review_id, chat_id, kind, status, proposal_json, rationale,
           evidence_json, replay_cases_json, replay_status,
           replay_failure_reason, replay_completed_at, source_run_ids_json,
           source_item_ids_json, pinned, activated_memory_id,
           activated_skill_id, activated_skill_revision, activated_at,
           archived_at, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        persisted.id,
        persisted.reviewId,
        persisted.chatId,
        persisted.kind,
        persisted.status,
        serializeForPersistence(persisted.proposal),
        persisted.rationale,
        serializeForPersistence(persisted.evidence),
        serializeForPersistence(persisted.replayCases),
        persisted.replayResult.status,
        persisted.replayResult.failureReason ?? null,
        persisted.replayResult.completedAt ?? null,
        serializeForPersistence(persisted.sourceRunIds),
        serializeForPersistence(persisted.sourceItemIds),
        persisted.pinned ? 1 : 0,
        persisted.activatedMemoryId ?? null,
        persisted.activatedSkillId ?? null,
        persisted.activatedSkillRevision ?? null,
        persisted.activatedAt ?? null,
        persisted.archivedAt ?? null,
        persisted.createdAt,
        persisted.updatedAt,
      );
    return this.requireCandidate(persisted.id);
  }

  completeReview(
    runId: string,
    candidates: readonly EvolutionCandidate[],
    completedAt: string,
  ): {
    readonly candidates: EvolutionCandidate[];
    readonly review: EvolutionReview;
  } {
    return this.database.transaction(() => {
      const inserted = candidates.map((candidate) =>
        this.insertCandidate(candidate),
      );
      const review = this.updateReview({
        completedAt,
        runId,
        status: "completed",
        updatedAt: completedAt,
      });
      return { candidates: inserted, review };
    })();
  }

  getCandidate(candidateId: string): EvolutionCandidate | undefined {
    const row = this.database
      .prepare("SELECT * FROM evolution_candidates WHERE id = ?")
      .get(candidateId) as EvolutionCandidateRow | undefined;
    return row ? readCandidate(row) : undefined;
  }

  requireCandidate(candidateId: string): EvolutionCandidate {
    const candidate = this.getCandidate(candidateId);
    if (!candidate)
      throw new Error(`Evolution candidate ${candidateId} is absent`);
    return candidate;
  }

  updateCandidate(candidate: EvolutionCandidate): EvolutionCandidate {
    const persisted = sanitizeForPersistence(
      EvolutionCandidateSchema,
      candidate,
    );
    const result = this.database
      .prepare(
        `UPDATE evolution_candidates
         SET status = ?, proposal_json = ?, rationale = ?, evidence_json = ?,
             replay_cases_json = ?, replay_status = ?,
             replay_failure_reason = ?, replay_completed_at = ?,
             pinned = ?, activated_memory_id = ?, activated_skill_id = ?,
             activated_skill_revision = ?, activated_at = ?, archived_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        persisted.status,
        serializeForPersistence(persisted.proposal),
        persisted.rationale,
        serializeForPersistence(persisted.evidence),
        serializeForPersistence(persisted.replayCases),
        persisted.replayResult.status,
        persisted.replayResult.failureReason ?? null,
        persisted.replayResult.completedAt ?? null,
        persisted.pinned ? 1 : 0,
        persisted.activatedMemoryId ?? null,
        persisted.activatedSkillId ?? null,
        persisted.activatedSkillRevision ?? null,
        persisted.activatedAt ?? null,
        persisted.archivedAt ?? null,
        persisted.updatedAt,
        persisted.id,
      );
    if (result.changes !== 1) {
      throw new Error(
        `Evolution candidate ${persisted.id} changed concurrently`,
      );
    }
    return this.requireCandidate(persisted.id);
  }

  markActiveSkillCandidatesStale(
    skillId: string,
    exceptCandidateId: string,
    updatedAt: string,
  ): EvolutionCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM evolution_candidates
         WHERE activated_skill_id = ? AND id <> ? AND status = 'active'`,
      )
      .all(skillId, exceptCandidateId) as EvolutionCandidateRow[];
    this.database
      .prepare(
        `UPDATE evolution_candidates
         SET status = 'stale', updated_at = ?
         WHERE activated_skill_id = ? AND id <> ? AND status = 'active'`,
      )
      .run(updatedAt, skillId, exceptCandidateId);
    return rows.map(({ id }) => this.requireCandidate(id));
  }

  listByActivatedSkill(skillId: string): EvolutionCandidate[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM evolution_candidates
           WHERE activated_skill_id = ?
           ORDER BY created_at, id`,
        )
        .all(skillId) as EvolutionCandidateRow[]
    ).map(readCandidate);
  }

  list(request: EvolutionListRequest): EvolutionSnapshot {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (request.chatId) {
      conditions.push("chat_id = ?");
      values.push(request.chatId);
    }
    if (request.runId) {
      conditions.push("instr(source_run_ids_json, ?) > 0");
      values.push(JSON.stringify(request.runId));
    }
    if (request.kind) {
      conditions.push("kind = ?");
      values.push(request.kind);
    }
    if (request.status) {
      conditions.push("status = ?");
      values.push(request.status);
    } else if (!request.includeArchived) {
      conditions.push("status <> 'archived'");
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const candidates = (
      this.database
        .prepare(
          `SELECT * FROM evolution_candidates ${where}
           ORDER BY created_at DESC, id DESC`,
        )
        .all(...values) as EvolutionCandidateRow[]
    ).map(readCandidate);

    const reviewConditions: string[] = [];
    const reviewValues: unknown[] = [];
    if (request.chatId) {
      reviewConditions.push("chat_id = ?");
      reviewValues.push(request.chatId);
    }
    if (request.runId) {
      reviewConditions.push("run_id = ?");
      reviewValues.push(request.runId);
    }
    const reviewWhere =
      reviewConditions.length > 0
        ? `WHERE ${reviewConditions.join(" AND ")}`
        : "";
    const reviews = (
      this.database
        .prepare(
          `SELECT * FROM evolution_reviews ${reviewWhere}
           ORDER BY created_at DESC, id DESC`,
        )
        .all(...reviewValues) as EvolutionReviewRow[]
    ).map(readReview);
    return { candidates, reviews };
  }
}
