import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type {
  Approval,
  ArtifactReference,
  Run,
  RunItem,
} from "../../shared/contracts/run";
import type {
  RunEventEnvelope,
  RunEventReplayRequest,
  RunEventReplayResponse,
} from "../../shared/contracts/ipc";
import { isTerminalRunStatus } from "../../shared/pure/cancellation";
import { replayInSequence } from "../../shared/pure/replay";
import {
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../../shared/schemas/ipc";
import {
  ApprovalSchema,
  ArtifactReferenceSchema,
  RunItemSchema,
  RunSchema,
} from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import {
  sanitizeForPersistence,
  serializeForPersistence,
} from "../db/persistenceBoundary";

interface RunRow {
  chat_id: string;
  created_at: string;
  ended_at: string | null;
  error_json: string | null;
  execution_json: string;
  id: string;
  latest_sequence: number;
  provider_json: string;
  started_at: string | null;
  status: string;
}

interface RunItemRow {
  display_output: string | null;
  duration_ms: number | null;
  ended_at: string | null;
  error_json: string | null;
  id: string;
  input_json: string | null;
  kind: string;
  run_id: string;
  sequence: number;
  started_at: string | null;
  status: string;
}

interface ArtifactRow {
  artifact_id: string;
  byte_length: number | null;
  display_name: string;
  kind: string;
  media_type: string | null;
  position: number;
  run_item_id: string;
  sha256: string | null;
  storage_key: string;
}

interface ApprovalRow {
  decided_at: string | null;
  decision_reason: string | null;
  expires_at: string;
  id: string;
  item_id: string;
  parameter_summary: string;
  requested_at: string;
  run_id: string;
  status: string;
  tool_name: string;
}

interface RunEventRow {
  envelope_json: string;
}

export interface RunPersistenceSnapshot {
  approvals: Approval[];
  runItems: RunItem[];
  runs: Run[];
}

export interface AppendRunEventResult {
  envelope: RunEventEnvelope;
  inserted: boolean;
}

const TERMINAL_RUN_ITEM_STATUSES = new Set<RunItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function readJson(serialized: string): unknown {
  return JSON.parse(serialized);
}

function readRun(row: RunRow): Run {
  return parseSchema(RunSchema, {
    chatId: row.chat_id,
    createdAt: row.created_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.error_json === null ? {} : { error: readJson(row.error_json) }),
    execution: readJson(row.execution_json),
    id: row.id,
    latestSequence: row.latest_sequence,
    provider: readJson(row.provider_json),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    status: row.status,
  });
}

function readArtifact(row: ArtifactRow): ArtifactReference {
  return parseSchema(ArtifactReferenceSchema, {
    artifactId: row.artifact_id,
    ...(row.byte_length === null ? {} : { byteLength: row.byte_length }),
    displayName: row.display_name,
    kind: row.kind,
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    storageKey: row.storage_key,
  });
}

function readRunItem(row: RunItemRow, artifacts: ArtifactReference[]): RunItem {
  return parseSchema(RunItemSchema, {
    artifacts,
    ...(row.display_output === null
      ? {}
      : { displayOutput: row.display_output }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.error_json === null ? {} : { error: readJson(row.error_json) }),
    id: row.id,
    ...(row.input_json === null ? {} : { input: readJson(row.input_json) }),
    kind: row.kind,
    runId: row.run_id,
    sequence: row.sequence,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    status: row.status,
  });
}

function readApproval(row: ApprovalRow): Approval {
  return parseSchema(ApprovalSchema, {
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.decision_reason === null
      ? {}
      : { decisionReason: row.decision_reason }),
    expiresAt: row.expires_at,
    id: row.id,
    itemId: row.item_id,
    parameterSummary: row.parameter_summary,
    requestedAt: row.requested_at,
    runId: row.run_id,
    status: row.status,
    toolName: row.tool_name,
  });
}

function readRunEvent(row: RunEventRow): RunEventEnvelope {
  return parseSchema(RunEventEnvelopeSchema, readJson(row.envelope_json));
}

function assertRunIdentity(current: Run, next: Run, streamId: string): void {
  if (
    next.id !== streamId ||
    current.id !== next.id ||
    current.chatId !== next.chatId ||
    current.createdAt !== next.createdAt ||
    current.startedAt !== next.startedAt ||
    !isDeepStrictEqual(current.execution, next.execution) ||
    !isDeepStrictEqual(current.provider, next.provider)
  ) {
    throw new Error(`Run ${streamId} changed immutable identity`);
  }
}

function assertItemIdentity(current: RunItem, next: RunItem): void {
  if (
    current.id !== next.id ||
    current.runId !== next.runId ||
    current.sequence !== next.sequence ||
    current.kind !== next.kind
  ) {
    throw new Error(`Run item ${next.id} changed immutable identity`);
  }
}

function assertApprovalIdentity(current: Approval, next: Approval): void {
  if (
    current.id !== next.id ||
    current.runId !== next.runId ||
    current.itemId !== next.itemId ||
    current.toolName !== next.toolName ||
    current.parameterSummary !== next.parameterSummary ||
    current.requestedAt !== next.requestedAt ||
    current.expiresAt !== next.expiresAt
  ) {
    throw new Error(`Approval ${next.id} changed immutable identity`);
  }
}

export class RunRepository {
  constructor(private readonly database: Database.Database) {}

  appendEvent(input: RunEventEnvelope): AppendRunEventResult {
    const envelope = sanitizeForPersistence(RunEventEnvelopeSchema, input);
    const append = this.database.transaction((): AppendRunEventResult => {
      const duplicateRow = this.database
        .prepare(
          `SELECT envelope_json
           FROM run_events
           WHERE run_id = ? AND sequence = ?`,
        )
        .get(envelope.streamId, envelope.sequence) as RunEventRow | undefined;
      if (duplicateRow) {
        const existing = readRunEvent(duplicateRow);
        if (!isDeepStrictEqual(existing, envelope)) {
          throw new Error(
            `Run ${envelope.streamId} sequence ${envelope.sequence} already contains a different event`,
          );
        }
        return { envelope: existing, inserted: false };
      }

      const runRow = this.selectRunRow(envelope.streamId);
      if (envelope.event.type === "run.started") {
        if (runRow || envelope.sequence !== 1) {
          throw new Error(
            `Run ${envelope.streamId} must start once at sequence 1`,
          );
        }
        if (
          envelope.event.run.id !== envelope.streamId ||
          envelope.event.run.latestSequence !== envelope.sequence ||
          envelope.event.run.status !== "running" ||
          envelope.event.run.startedAt === undefined
        ) {
          throw new Error(
            `Invalid run.started projection for ${envelope.streamId}`,
          );
        }
        this.insertRun(envelope.event.run);
      } else {
        if (!runRow) {
          throw new Error(`Run ${envelope.streamId} does not exist`);
        }
        const currentRun = readRun(runRow);
        if (isTerminalRunStatus(currentRun.status)) {
          throw new Error(`Run ${envelope.streamId} is already terminal`);
        }
        if (envelope.sequence !== runRow.latest_sequence + 1) {
          throw new Error(
            `Expected run ${envelope.streamId} sequence ${runRow.latest_sequence + 1}, received ${envelope.sequence}`,
          );
        }
        this.applyProjection(currentRun, envelope);
      }

      this.database
        .prepare(
          `INSERT INTO run_events (
            run_id, sequence, event_type, occurred_at, envelope_json
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.streamId,
          envelope.sequence,
          envelope.event.type,
          envelope.occurredAt,
          serializeForPersistence(envelope),
        );
      return { envelope, inserted: true };
    });

    return append();
  }

  replay(input: RunEventReplayRequest): RunEventReplayResponse {
    const request = parseSchema(RunEventReplayRequestSchema, input);
    const runRow = this.selectRunRow(request.streamId);
    if (!runRow) {
      throw new Error(`Run ${request.streamId} does not exist`);
    }
    if (request.afterSequence > runRow.latest_sequence) {
      throw new Error(
        `Run ${request.streamId} latest sequence is ${runRow.latest_sequence}, received afterSequence ${request.afterSequence}`,
      );
    }

    const rows = this.database
      .prepare(
        `SELECT envelope_json
         FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(request.streamId, request.afterSequence) as RunEventRow[];
    const events = rows.map(readRunEvent);
    replayInSequence(
      request.streamId,
      request.afterSequence,
      events,
      () => undefined,
    );

    return parseSchema(RunEventReplayResponseSchema, {
      events,
      latestSequence: runRow.latest_sequence,
      streamId: request.streamId,
    });
  }

  getSnapshot(chatId: string): RunPersistenceSnapshot {
    const runRows = this.database
      .prepare(
        `SELECT id, chat_id, execution_json, provider_json, status,
                latest_sequence, created_at, started_at, ended_at, error_json
         FROM runs
         WHERE chat_id = ?
         ORDER BY created_at, id`,
      )
      .all(chatId) as RunRow[];
    const runItemRows = this.database
      .prepare(
        `SELECT item.id, item.run_id, item.sequence, item.kind, item.status,
                item.input_json, item.display_output,
                item.started_at, item.ended_at, item.duration_ms, item.error_json
         FROM run_items AS item
         INNER JOIN runs AS run ON run.id = item.run_id
         WHERE run.chat_id = ?
         ORDER BY item.run_id, item.sequence`,
      )
      .all(chatId) as RunItemRow[];
    const artifactRows = this.database
      .prepare(
        `SELECT artifact.artifact_id, artifact.run_item_id, artifact.position,
                artifact.kind,
                artifact.display_name, artifact.storage_key,
                artifact.media_type, artifact.byte_length, artifact.sha256
         FROM tool_artifacts AS artifact
         INNER JOIN runs AS run ON run.id = artifact.run_id
         WHERE run.chat_id = ?
         ORDER BY artifact.run_item_id, artifact.position`,
      )
      .all(chatId) as ArtifactRow[];
    const artifactsByItem = new Map<string, ArtifactReference[]>();
    for (const row of artifactRows) {
      const artifacts = artifactsByItem.get(row.run_item_id) ?? [];
      artifacts.push(readArtifact(row));
      artifactsByItem.set(row.run_item_id, artifacts);
    }
    const approvalRows = this.database
      .prepare(
        `SELECT approval.id, approval.run_id, approval.item_id,
                approval.tool_name, approval.parameter_summary,
                approval.status, approval.requested_at, approval.expires_at,
                approval.decided_at, approval.decision_reason
         FROM approvals AS approval
         INNER JOIN runs AS run ON run.id = approval.run_id
         WHERE run.chat_id = ?
         ORDER BY approval.run_id, approval.requested_at, approval.id`,
      )
      .all(chatId) as ApprovalRow[];

    return {
      approvals: approvalRows.map(readApproval),
      runItems: runItemRows.map((row) =>
        readRunItem(row, artifactsByItem.get(row.id) ?? []),
      ),
      runs: runRows.map(readRun),
    };
  }

  private applyProjection(currentRun: Run, envelope: RunEventEnvelope): void {
    const { event } = envelope;
    switch (event.type) {
      case "item.started": {
        if (
          event.item.runId !== envelope.streamId ||
          event.item.sequence !== envelope.sequence ||
          event.item.status !== "running"
        ) {
          throw new Error(
            `Invalid item.started event for ${envelope.streamId}`,
          );
        }
        this.insertRunItem(event.item);
        this.updateRunSequence(envelope.streamId, envelope.sequence, "running");
        return;
      }
      case "item.delta": {
        const item = this.selectRunItem(event.itemId);
        if (
          !item ||
          item.run_id !== envelope.streamId ||
          item.status !== "running"
        ) {
          throw new Error(
            `Run item ${event.itemId} does not belong to ${envelope.streamId}`,
          );
        }
        this.updateRunSequence(envelope.streamId, envelope.sequence);
        return;
      }
      case "item.completed": {
        const currentItemRow = this.selectRunItem(event.item.id);
        if (!currentItemRow) {
          throw new Error(`Run item ${event.item.id} does not exist`);
        }
        const currentItem = this.readRunItem(currentItemRow);
        assertItemIdentity(currentItem, event.item);
        if (event.item.runId !== envelope.streamId) {
          throw new Error(
            `Run item ${event.item.id} does not belong to ${envelope.streamId}`,
          );
        }
        if (
          currentItem.status !== "running" ||
          !TERMINAL_RUN_ITEM_STATUSES.has(event.item.status)
        ) {
          throw new Error(`Invalid completed state for item ${event.item.id}`);
        }
        this.updateRunItem(event.item);
        this.updateRunSequence(envelope.streamId, envelope.sequence);
        return;
      }
      case "approval.requested": {
        if (
          event.approval.runId !== envelope.streamId ||
          event.approval.status !== "pending"
        ) {
          throw new Error(
            `Invalid approval.requested event for ${envelope.streamId}`,
          );
        }
        const item = this.selectRunItem(event.approval.itemId);
        if (!item || item.run_id !== envelope.streamId) {
          throw new Error(
            `Approval item ${event.approval.itemId} does not belong to ${envelope.streamId}`,
          );
        }
        this.insertApproval(event.approval);
        this.updateRunSequence(
          envelope.streamId,
          envelope.sequence,
          "waiting_approval",
        );
        return;
      }
      case "approval.resolved": {
        if (
          event.approval.runId !== envelope.streamId ||
          event.approval.status === "pending"
        ) {
          throw new Error(
            `Invalid approval.resolved event for ${envelope.streamId}`,
          );
        }
        const approvalRow = this.selectApproval(event.approval.id);
        if (!approvalRow) {
          throw new Error(`Approval ${event.approval.id} does not exist`);
        }
        assertApprovalIdentity(readApproval(approvalRow), event.approval);
        this.updateApproval(event.approval);
        this.updateRunSequence(
          envelope.streamId,
          envelope.sequence,
          currentRun.status === "waiting_approval" ? "running" : undefined,
        );
        return;
      }
      case "run.needs_input":
        this.applyRunStateEvent(currentRun, event.run, envelope, "needs_input");
        return;
      case "run.interrupted":
        this.applyRunStateEvent(currentRun, event.run, envelope, "interrupted");
        return;
      case "run.completed":
        this.applyRunStateEvent(currentRun, event.run, envelope, "completed");
        return;
      case "run.failed":
        this.applyRunStateEvent(currentRun, event.run, envelope, "failed");
        return;
      case "run.cancelled":
        this.applyRunStateEvent(currentRun, event.run, envelope, "cancelled");
        return;
      case "run.started":
        throw new Error(`Run ${envelope.streamId} has already started`);
    }
  }

  private applyRunStateEvent(
    current: Run,
    next: Run,
    envelope: RunEventEnvelope,
    expectedStatus: Run["status"],
  ): void {
    assertRunIdentity(current, next, envelope.streamId);
    if (
      next.status !== expectedStatus ||
      next.latestSequence !== envelope.sequence
    ) {
      throw new Error(
        `Invalid ${envelope.event.type} projection for ${envelope.streamId}`,
      );
    }
    this.updateRun(next);
  }

  private insertRun(run: Run): void {
    this.database
      .prepare(
        `INSERT INTO runs (
          id, chat_id, execution_json, provider_json, status, latest_sequence,
          created_at, started_at, ended_at, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.chatId,
        serializeForPersistence(run.execution),
        serializeForPersistence(run.provider),
        run.status,
        run.latestSequence,
        run.createdAt,
        run.startedAt ?? null,
        run.endedAt ?? null,
        run.error === undefined ? null : serializeForPersistence(run.error),
      );
  }

  private updateRun(run: Run): void {
    const result = this.database
      .prepare(
        `UPDATE runs
         SET status = ?, latest_sequence = ?, started_at = ?, ended_at = ?,
             error_json = ?
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.latestSequence,
        run.startedAt ?? null,
        run.endedAt ?? null,
        run.error === undefined ? null : serializeForPersistence(run.error),
        run.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Run ${run.id} does not exist`);
    }
  }

  private updateRunSequence(
    runId: string,
    sequence: number,
    status?: Run["status"],
  ): void {
    const result =
      status === undefined
        ? this.database
            .prepare("UPDATE runs SET latest_sequence = ? WHERE id = ?")
            .run(sequence, runId)
        : this.database
            .prepare(
              "UPDATE runs SET latest_sequence = ?, status = ? WHERE id = ?",
            )
            .run(sequence, status, runId);
    if (result.changes !== 1) {
      throw new Error(`Run ${runId} does not exist`);
    }
  }

  private insertRunItem(item: RunItem): void {
    this.database
      .prepare(
        `INSERT INTO run_items (
          id, run_id, sequence, kind, status, input_json, display_output,
          started_at, ended_at, duration_ms, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.runId,
        item.sequence,
        item.kind,
        item.status,
        item.input === undefined ? null : serializeForPersistence(item.input),
        item.displayOutput ?? null,
        item.startedAt ?? null,
        item.endedAt ?? null,
        item.durationMs ?? null,
        item.error === undefined ? null : serializeForPersistence(item.error),
      );
    this.appendArtifacts(item);
  }

  private updateRunItem(item: RunItem): void {
    const result = this.database
      .prepare(
        `UPDATE run_items
         SET status = ?, input_json = ?, display_output = ?, started_at = ?,
             ended_at = ?, duration_ms = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        item.status,
        item.input === undefined ? null : serializeForPersistence(item.input),
        item.displayOutput ?? null,
        item.startedAt ?? null,
        item.endedAt ?? null,
        item.durationMs ?? null,
        item.error === undefined ? null : serializeForPersistence(item.error),
        item.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Run item ${item.id} does not exist`);
    }
    this.appendArtifacts(item);
  }

  private insertApproval(approval: Approval): void {
    this.database
      .prepare(
        `INSERT INTO approvals (
          id, run_id, item_id, tool_name, parameter_summary, status,
          requested_at, expires_at, decided_at, decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.runId,
        approval.itemId,
        approval.toolName,
        approval.parameterSummary,
        approval.status,
        approval.requestedAt,
        approval.expiresAt,
        approval.decidedAt ?? null,
        approval.decisionReason ?? null,
      );
  }

  private updateApproval(approval: Approval): void {
    const result = this.database
      .prepare(
        `UPDATE approvals
         SET status = ?, decided_at = ?, decision_reason = ?
         WHERE id = ?`,
      )
      .run(
        approval.status,
        approval.decidedAt ?? null,
        approval.decisionReason ?? null,
        approval.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Approval ${approval.id} does not exist`);
    }
  }

  private selectRunRow(runId: string): RunRow | undefined {
    return this.database
      .prepare(
        `SELECT id, chat_id, execution_json, provider_json, status,
                latest_sequence, created_at, started_at, ended_at, error_json
         FROM runs
         WHERE id = ?`,
      )
      .get(runId) as RunRow | undefined;
  }

  private selectRunItem(itemId: string): RunItemRow | undefined {
    return this.database
      .prepare(
        `SELECT id, run_id, sequence, kind, status, input_json, display_output,
                started_at, ended_at, duration_ms, error_json
         FROM run_items
         WHERE id = ?`,
      )
      .get(itemId) as RunItemRow | undefined;
  }

  private readRunItem(row: RunItemRow): RunItem {
    return readRunItem(row, this.selectArtifacts(row.id));
  }

  private selectArtifacts(itemId: string): ArtifactReference[] {
    const rows = this.database
      .prepare(
        `SELECT artifact_id, run_item_id, position, kind, display_name, storage_key,
                media_type, byte_length, sha256
         FROM tool_artifacts
         WHERE run_item_id = ?
         ORDER BY position`,
      )
      .all(itemId) as ArtifactRow[];
    return rows.map(readArtifact);
  }

  private appendArtifacts(item: RunItem): void {
    const existing = this.selectArtifacts(item.id);
    const nextIds = new Set(
      item.artifacts.map((artifact) => artifact.artifactId),
    );
    for (const [position, artifact] of existing.entries()) {
      const next = item.artifacts[position];
      if (!next || !isDeepStrictEqual(next, artifact)) {
        throw new Error(
          `Run item ${item.id} cannot remove, reorder or replace artifact ${artifact.artifactId}`,
        );
      }
    }
    if (nextIds.size !== item.artifacts.length) {
      throw new Error(`Run item ${item.id} contains duplicate artifact IDs`);
    }

    const insert = this.database.prepare(
      `INSERT INTO tool_artifacts (
        artifact_id, run_item_id, run_id, position, kind, display_name,
        storage_key, media_type, byte_length, sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [position, artifact] of item.artifacts.entries()) {
      if (position < existing.length) {
        continue;
      }
      insert.run(
        artifact.artifactId,
        item.id,
        item.runId,
        position,
        artifact.kind,
        artifact.displayName,
        artifact.storageKey,
        artifact.mediaType ?? null,
        artifact.byteLength ?? null,
        artifact.sha256 ?? null,
      );
    }
  }

  private selectApproval(approvalId: string): ApprovalRow | undefined {
    return this.database
      .prepare(
        `SELECT id, run_id, item_id, tool_name, parameter_summary, status,
                requested_at, expires_at, decided_at, decision_reason
         FROM approvals
         WHERE id = ?`,
      )
      .get(approvalId) as ApprovalRow | undefined;
  }
}
