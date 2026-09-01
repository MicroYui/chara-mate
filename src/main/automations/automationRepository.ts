import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type {
  Automation,
  AutomationDefinition,
  AutomationDetail,
  AutomationListSnapshot,
  AutomationRun,
  AutomationRunTrigger,
} from "../../shared/contracts/automation";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { AppError } from "../../shared/contracts/run";
import {
  AutomationDefinitionSchema,
  AutomationRunSchema,
  AutomationRunTriggerSchema,
  AutomationSchema,
} from "../../shared/schemas/automation";
import { AppErrorSchema } from "../../shared/schemas/error";
import { PersonaSnapshotSchema } from "../../shared/schemas/persona";
import { parseSchema } from "../../shared/schemas/validation";
import {
  sanitizeForPersistence,
  serializeForPersistence,
} from "../db/persistenceBoundary";
import { AutomationError } from "./automationError";

interface AutomationRow {
  readonly created_at: string;
  readonly definition_json: string;
  readonly id: string;
  readonly next_run_at: string | null;
  readonly revision: number;
  readonly state: Automation["state"];
  readonly updated_at: string;
}

interface AutomationRunRow {
  readonly automation_id: string;
  readonly automation_revision: number;
  readonly chat_id: string | null;
  readonly created_at: string;
  readonly definition_json: string;
  readonly ended_at: string | null;
  readonly error_json: string | null;
  readonly id: string;
  readonly persona_json: string;
  readonly requested_at: string;
  readonly run_id: string | null;
  readonly started_at: string | null;
  readonly status: AutomationRun["status"];
  readonly summary: string | null;
  readonly trigger_json: string;
  readonly updated_at: string;
}

export interface ScheduledClaimInput {
  readonly automationId: string;
  readonly claimedAt: Timestamp;
  readonly expectedNextRunAt: Timestamp;
  readonly expectedRevision: number;
  readonly nextRunAt?: Timestamp;
  readonly persona: PersonaSnapshot;
  readonly runId: string;
}

export interface ScheduledClaimResult {
  readonly automation: Automation;
  readonly run: AutomationRun;
}

const AUTOMATION_SELECT = `
  SELECT id, revision, definition_json, state, next_run_at,
         created_at, updated_at
  FROM automations
`;

const AUTOMATION_RUN_SELECT = `
  SELECT id, automation_id, automation_revision, definition_json,
         persona_json, trigger_json, status, chat_id, run_id, summary, error_json,
         requested_at, started_at, ended_at, created_at, updated_at
  FROM automation_runs
`;

function readDefinition(serialized: string): AutomationDefinition {
  return parseSchema(AutomationDefinitionSchema, JSON.parse(serialized));
}

function readAutomation(row: AutomationRow): Automation {
  return parseSchema(AutomationSchema, {
    createdAt: row.created_at,
    definition: readDefinition(row.definition_json),
    id: row.id,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    revision: row.revision,
    state: row.state,
    updatedAt: row.updated_at,
  });
}

function readAutomationRun(row: AutomationRunRow): AutomationRun {
  return parseSchema(AutomationRunSchema, {
    automationId: row.automation_id,
    automationRevision: row.automation_revision,
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    createdAt: row.created_at,
    definition: readDefinition(row.definition_json),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.error_json
      ? { error: parseSchema(AppErrorSchema, JSON.parse(row.error_json)) }
      : {}),
    id: row.id,
    persona: parseSchema(PersonaSnapshotSchema, JSON.parse(row.persona_json)),
    requestedAt: row.requested_at,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    status: row.status,
    ...(row.summary === null ? {} : { summary: row.summary }),
    trigger: parseSchema(
      AutomationRunTriggerSchema,
      JSON.parse(row.trigger_json),
    ),
    updatedAt: row.updated_at,
  });
}

function assertAutomationIdentity(current: Automation, next: Automation): void {
  if (
    current.id !== next.id ||
    current.createdAt !== next.createdAt ||
    next.revision < current.revision
  ) {
    throw new AutomationError(
      "AUTOMATION.INVALID_STATE",
      "定时任务的持久身份不能被改写。",
      false,
    );
  }
}

function assertRunIdentity(current: AutomationRun, next: AutomationRun): void {
  if (
    current.id !== next.id ||
    current.automationId !== next.automationId ||
    current.automationRevision !== next.automationRevision ||
    current.createdAt !== next.createdAt ||
    current.requestedAt !== next.requestedAt ||
    !isDeepStrictEqual(current.definition, next.definition) ||
    !isDeepStrictEqual(current.persona, next.persona) ||
    !isDeepStrictEqual(current.trigger, next.trigger)
  ) {
    throw new AutomationError(
      "AUTOMATION.INVALID_STATE",
      "定时任务运行的历史快照不能被改写。",
      false,
    );
  }
}

function storedRunValues(run: AutomationRun): readonly unknown[] {
  const value = sanitizeForPersistence(AutomationRunSchema, run);
  const chatId = "chatId" in value ? value.chatId : undefined;
  const runId = "runId" in value ? value.runId : undefined;
  const startedAt = "startedAt" in value ? value.startedAt : undefined;
  const endedAt = "endedAt" in value ? value.endedAt : undefined;
  return [
    value.id,
    value.automationId,
    value.automationRevision,
    serializeForPersistence(value.definition),
    serializeForPersistence(value.persona),
    serializeForPersistence(value.trigger),
    value.status,
    chatId ?? null,
    runId ?? null,
    value.summary ?? null,
    value.status === "failed" ? serializeForPersistence(value.error) : null,
    value.requestedAt,
    startedAt ?? null,
    endedAt ?? null,
    value.createdAt,
    value.updatedAt,
  ];
}

export class AutomationRepository {
  constructor(private readonly database: Database.Database) {}

  insertAutomation(input: Automation): Automation {
    const automation = sanitizeForPersistence(AutomationSchema, input);
    this.database
      .prepare(
        `INSERT INTO automations (
           id, revision, definition_json, state, next_run_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        automation.id,
        automation.revision,
        serializeForPersistence(automation.definition),
        automation.state,
        automation.state === "active" ? automation.nextRunAt : null,
        automation.createdAt,
        automation.updatedAt,
      );
    return this.getAutomation(automation.id)!;
  }

  getAutomation(automationId: string): Automation | undefined {
    const row = this.database
      .prepare(`${AUTOMATION_SELECT} WHERE id = ?`)
      .get(automationId) as AutomationRow | undefined;
    return row ? readAutomation(row) : undefined;
  }

  requireAutomation(automationId: string): Automation {
    const automation = this.getAutomation(automationId);
    if (!automation) {
      throw new AutomationError(
        "AUTOMATION.NOT_FOUND",
        "没有找到这个定时任务。",
        false,
      );
    }
    return automation;
  }

  replaceAutomation(input: Automation, expectedRevision: number): Automation {
    const automation = sanitizeForPersistence(AutomationSchema, input);
    const current = this.requireAutomation(automation.id);
    if (current.revision !== expectedRevision) {
      throw new AutomationError(
        "AUTOMATION.REVISION_CONFLICT",
        "定时任务已经被更新，请刷新后重试。",
        false,
      );
    }
    assertAutomationIdentity(current, automation);
    const result = this.database
      .prepare(
        `UPDATE automations
         SET revision = ?, definition_json = ?, state = ?, next_run_at = ?,
             updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        automation.revision,
        serializeForPersistence(automation.definition),
        automation.state,
        automation.state === "active" ? automation.nextRunAt : null,
        automation.updatedAt,
        automation.id,
        expectedRevision,
      );
    if (result.changes !== 1) {
      throw new AutomationError(
        "AUTOMATION.REVISION_CONFLICT",
        "定时任务已经被更新，请刷新后重试。",
        false,
      );
    }
    return this.requireAutomation(automation.id);
  }

  list(): AutomationListSnapshot {
    const rows = this.database
      .prepare(
        `${AUTOMATION_SELECT}
         ORDER BY created_at, id`,
      )
      .all() as AutomationRow[];
    return {
      items: rows.map((row) => {
        const automation = readAutomation(row);
        const recentRun = this.database
          .prepare(
            `${AUTOMATION_RUN_SELECT}
             WHERE automation_id = ?
             ORDER BY requested_at DESC, id DESC
             LIMIT 1`,
          )
          .get(automation.id) as AutomationRunRow | undefined;
        return {
          automation,
          ...(recentRun ? { recentRun: readAutomationRun(recentRun) } : {}),
        };
      }),
    };
  }

  getDetail(automationId: string): AutomationDetail {
    const automation = this.requireAutomation(automationId);
    return {
      automation,
      runs: this.listRuns(automationId),
    };
  }

  listRuns(automationId: string): AutomationRun[] {
    return (
      this.database
        .prepare(
          `${AUTOMATION_RUN_SELECT}
           WHERE automation_id = ?
           ORDER BY requested_at DESC, id DESC`,
        )
        .all(automationId) as AutomationRunRow[]
    ).map(readAutomationRun);
  }

  getRun(automationRunId: string): AutomationRun | undefined {
    const row = this.database
      .prepare(`${AUTOMATION_RUN_SELECT} WHERE id = ?`)
      .get(automationRunId) as AutomationRunRow | undefined;
    return row ? readAutomationRun(row) : undefined;
  }

  getRunByRuntimeRunId(runId: string): AutomationRun | undefined {
    const row = this.database
      .prepare(`${AUTOMATION_RUN_SELECT} WHERE run_id = ?`)
      .get(runId) as AutomationRunRow | undefined;
    return row ? readAutomationRun(row) : undefined;
  }

  listRunsByStatus(
    statuses: readonly AutomationRun["status"][],
  ): AutomationRun[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return (
      this.database
        .prepare(
          `${AUTOMATION_RUN_SELECT}
           WHERE status IN (${placeholders})
           ORDER BY requested_at, id`,
        )
        .all(...statuses) as AutomationRunRow[]
    ).map(readAutomationRun);
  }

  insertManualRun(input: {
    readonly automation: Automation;
    readonly createdAt: Timestamp;
    readonly persona: PersonaSnapshot;
    readonly requestedAt: Timestamp;
    readonly runId: string;
  }): AutomationRun {
    const run: AutomationRun = {
      automationId: input.automation.id,
      automationRevision: input.automation.revision,
      createdAt: input.createdAt,
      definition: input.automation.definition,
      id: input.runId,
      persona: input.persona,
      requestedAt: input.requestedAt,
      status: "queued",
      trigger: { kind: "manual" },
      updatedAt: input.createdAt,
    };
    this.#insertRun(run);
    return this.getRun(run.id)!;
  }

  listDue(now: Timestamp): Automation[] {
    return (
      this.database
        .prepare(
          `${AUTOMATION_SELECT}
           WHERE state = 'active' AND next_run_at <= ?
           ORDER BY next_run_at, id`,
        )
        .all(now) as AutomationRow[]
    ).map(readAutomation);
  }

  earliestNextRunAt(): Timestamp | undefined {
    const row = this.database
      .prepare(
        `SELECT next_run_at
         FROM automations
         WHERE state = 'active'
         ORDER BY next_run_at, id
         LIMIT 1`,
      )
      .get() as { readonly next_run_at: string } | undefined;
    return row?.next_run_at;
  }

  claimScheduled(input: ScheduledClaimInput): ScheduledClaimResult | undefined {
    return this.database.transaction(() => {
      const current = this.getAutomation(input.automationId);
      if (
        !current ||
        current.state !== "active" ||
        current.revision !== input.expectedRevision ||
        current.nextRunAt !== input.expectedNextRunAt
      ) {
        return undefined;
      }

      const trigger: AutomationRunTrigger = {
        kind: "scheduled",
        scheduledFor: current.nextRunAt,
      };
      const run: AutomationRun = {
        automationId: current.id,
        automationRevision: current.revision,
        createdAt: input.claimedAt,
        definition: current.definition,
        id: input.runId,
        persona: input.persona,
        requestedAt: input.claimedAt,
        status: "queued",
        trigger,
        updatedAt: input.claimedAt,
      };
      this.#insertRun(run);
      this.database
        .prepare(
          `UPDATE automations
           SET state = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'active'
             AND next_run_at = ?`,
        )
        .run(
          input.nextRunAt ? "active" : "completed",
          input.nextRunAt ?? null,
          input.claimedAt,
          current.id,
          current.revision,
          current.nextRunAt,
        );
      return {
        automation: this.requireAutomation(current.id),
        run: this.getRun(run.id)!,
      };
    })();
  }

  replaceRun(input: AutomationRun): AutomationRun {
    const run = sanitizeForPersistence(AutomationRunSchema, input);
    const current = this.getRun(run.id);
    if (!current) {
      throw new AutomationError(
        "AUTOMATION.INVALID_STATE",
        "没有找到这次定时任务运行。",
        false,
      );
    }
    assertRunIdentity(current, run);
    const values = storedRunValues(run);
    const result = this.database
      .prepare(
        `UPDATE automation_runs
         SET status = ?, chat_id = ?, run_id = ?, summary = ?,
             error_json = ?, started_at = ?, ended_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        values[6],
        values[7],
        values[8],
        values[9],
        values[10],
        values[12],
        values[13],
        values[15],
        values[0],
      );
    if (result.changes !== 1) {
      throw new AutomationError(
        "AUTOMATION.INVALID_STATE",
        "定时任务运行状态更新失败。",
        true,
      );
    }
    return this.getRun(run.id)!;
  }

  #insertRun(input: AutomationRun): void {
    this.database
      .prepare(
        `INSERT INTO automation_runs (
           id, automation_id, automation_revision, definition_json, persona_json,
           trigger_json, status, chat_id, run_id, summary, error_json,
           requested_at, started_at, ended_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...storedRunValues(input));
  }
}

export function automationDispatchError(error: unknown): AppError {
  if (error instanceof AutomationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  ) {
    try {
      return parseSchema(AppErrorSchema, error);
    } catch {
      // Fall through to the stable automation boundary below.
    }
  }
  return {
    code: "AUTOMATION.DISPATCH_FAILED",
    message: error instanceof Error ? error.message : "定时任务启动失败。",
    retryable: true,
  };
}
