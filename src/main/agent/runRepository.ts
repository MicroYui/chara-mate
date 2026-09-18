import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../../shared/contracts/primitives";

import type { MemoryEvidenceReference } from "../../shared/contracts/memoryRecall";
import { MemoryEvidenceReferenceSchema } from "../../shared/schemas/memoryRecall";

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
  persona_json: string;
  provider_json: string;
  source: Run["source"];
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
  output_json: string | null;
  run_id: string;
  sequence: number;
  started_at: string | null;
  status: string;
}

export interface RunItemSourceReference extends Pick<
  RunItem,
  "id" | "runId" | "sequence" | "kind" | "status" | "startedAt" | "endedAt"
> {
  messageId?: string;
  toolName?: string;
  hasToolOutput: boolean;
}

const runItemSourceProjection = `id, run_id AS runId, sequence, kind, status,
  started_at AS startedAt, ended_at AS endedAt,
  CASE WHEN json_type(output_json,'$.messageId') IS NULL OR json_type(output_json,'$.messageId') = 'null'
    THEN CASE WHEN json_type(input_json,'$.messageId') = 'text' THEN json_extract(input_json,'$.messageId') END
    ELSE CASE WHEN json_type(output_json,'$.messageId') = 'text' THEN json_extract(output_json,'$.messageId') END END AS messageId,
  CASE WHEN json_type(input_json,'$.toolName') IS NULL OR json_type(input_json,'$.toolName') = 'null'
    THEN CASE WHEN json_type(input_json,'$.name') = 'text' THEN json_extract(input_json,'$.name') END
    ELSE CASE WHEN json_type(input_json,'$.toolName') = 'text' THEN json_extract(input_json,'$.toolName') END END AS toolName,
  (json_type(output_json,'$.status') = 'text' AND json_type(output_json,'$.summary') = 'text') AS hasToolOutput`;

function readRunItemSource(
  row: Record<string, unknown>,
): RunItemSourceReference {
  return {
    id: row["id"] as string,
    runId: row["runId"] as string,
    sequence: row["sequence"] as number,
    kind: row["kind"] as RunItem["kind"],
    status: row["status"] as RunItem["status"],
    ...(row["startedAt"] != null
      ? { startedAt: row["startedAt"] as string }
      : {}),
    ...(row["endedAt"] != null ? { endedAt: row["endedAt"] as string } : {}),
    ...(row["messageId"] != null
      ? { messageId: row["messageId"] as string }
      : {}),
    ...(row["toolName"] != null ? { toolName: row["toolName"] as string } : {}),
    hasToolOutput: Boolean(row["hasToolOutput"]),
  };
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

const IMMUTABLE_TERMINAL_RUN_STATUSES = new Set<Run["status"]>([
  "completed",
  "failed",
  "cancelled",
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
    persona: readJson(row.persona_json),
    provider: readJson(row.provider_json),
    source: row.source,
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
    ...(row.output_json === null ? {} : { output: readJson(row.output_json) }),
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

function textDelta(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const text = (value as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : undefined;
}

function assertRunIdentity(current: Run, next: Run, streamId: string): void {
  if (
    next.id !== streamId ||
    current.id !== next.id ||
    current.chatId !== next.chatId ||
    current.createdAt !== next.createdAt ||
    current.startedAt !== next.startedAt ||
    !isDeepStrictEqual(current.execution, next.execution) ||
    !isDeepStrictEqual(current.persona, next.persona) ||
    !isDeepStrictEqual(current.provider, next.provider) ||
    current.source !== next.source
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

/** Only an input.resolved boundary may commit its checkpoint and intake receipt. */
export interface InputResolutionProjection {
  commit(item: RunItem, run: Run): void;
  /** Runs after SQLite commit, before synchronous event observers. */
  afterCommit(): void;
}

export class RunRepository {
  constructor(private readonly database: Database.Database) {}

  appendEvent(
    input: RunEventEnvelope,
    bindAllocation?: (runId: string) => void,
    projectAssistantMessage?: (item: RunItem) => void,
    inputResolution?: InputResolutionProjection,
  ): AppendRunEventResult {
    const envelope = sanitizeForPersistence(RunEventEnvelopeSchema, input);
    if (bindAllocation && envelope.event.type !== "run.started") {
      throw new Error("An allocation may only be bound to run.started");
    }
    if (
      projectAssistantMessage &&
      (envelope.event.type !== "item.completed" ||
        envelope.event.item.kind !== "assistant_message")
    ) {
      throw new Error(
        "A Chat completion may only be projected by an assistant_message Item",
      );
    }
    if (inputResolution && envelope.event.type !== "input.resolved") {
      throw new Error(
        "An input checkpoint may only be projected by input.resolved",
      );
    }
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
        bindAllocation?.(envelope.streamId);
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
        if (IMMUTABLE_TERMINAL_RUN_STATUSES.has(currentRun.status)) {
          throw new Error(`Run ${envelope.streamId} is already terminal`);
        }
        if (envelope.sequence !== runRow.latest_sequence + 1) {
          throw new Error(
            `Expected run ${envelope.streamId} sequence ${runRow.latest_sequence + 1}, received ${envelope.sequence}`,
          );
        }
        if (envelope.event.type === "input.resolved") {
          inputResolution?.commit(envelope.event.item, envelope.event.run);
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
      bindAllocation?.(envelope.streamId);
      if (envelope.event.type === "item.completed") {
        projectAssistantMessage?.(envelope.event.item);
      }
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
        `SELECT id, chat_id, execution_json, persona_json, provider_json, source, status,
                latest_sequence, created_at, started_at, ended_at, error_json
         FROM runs
         WHERE chat_id = ?
         ORDER BY created_at, id`,
      )
      .all(chatId) as RunRow[];
    const runItemRows = this.database
      .prepare(
        `SELECT item.id, item.run_id, item.sequence, item.kind, item.status,
                item.input_json, item.output_json, item.display_output,
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

  getActiveRun(chatId: string): Run | undefined {
    const row = this.database
      .prepare(
        `SELECT id, chat_id, execution_json, persona_json, provider_json, source, status,
                latest_sequence, created_at, started_at, ended_at, error_json
         FROM runs
         WHERE chat_id = ?
           AND status IN ('queued', 'running', 'waiting_approval', 'needs_input')
         ORDER BY created_at, id
         LIMIT 1`,
      )
      .get(chatId) as RunRow | undefined;
    return row ? readRun(row) : undefined;
  }

  getRun(runId: string): Run | undefined {
    const row = this.selectRunRow(runId);
    return row ? readRun(row) : undefined;
  }

  getRunItem(itemId: string): RunItem | undefined {
    const row = this.selectRunItem(itemId);
    return row ? this.readRunItem(row) : undefined;
  }

  isFirstCompletedModelResponse(runId: string, itemId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT id FROM run_items
         WHERE run_id=? AND kind='assistant_message' AND status='completed'
           AND json_type(output_json,'$.responseId')='text'
           AND length(json_extract(output_json,'$.responseId'))>0
         ORDER BY sequence LIMIT 1`,
      )
      .get(runId) as { id: string } | undefined;
    return row?.id === itemId;
  }

  /** References actually supplied to the request that produced this exact Tool.
   * A valid empty array differs from missing host provenance. */
  toolSuppliedMemoryReferences(
    runId: string,
    itemId: string,
  ): MemoryEvidenceReference[] | undefined {
    const tool = this.getRunItem(itemId);
    const run = this.getRun(runId);
    if (!run || tool?.runId !== runId || tool.kind !== "tool_call")
      return undefined;
    const input = tool.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return undefined;
    let references: unknown;
    if (run.source === "voice") references = input["suppliedMemoryReferences"];
    else {
      const row = this.database
        .prepare(
          `SELECT status, output_json FROM run_items
        WHERE run_id=? AND sequence<? AND kind='assistant_message'
        ORDER BY sequence DESC LIMIT 1`,
        )
        .get(runId, tool.sequence) as
        { status: string; output_json: string | null } | undefined;
      if (row?.status !== "completed" || !row.output_json) return undefined;
      const output = JSON.parse(row.output_json) as Record<string, unknown>;
      if (
        !Array.isArray(output["functionCallIds"]) ||
        !output["functionCallIds"].includes(input["callId"])
      )
        return undefined;
      references = output["memoryReferences"];
    }
    if (!Array.isArray(references)) return undefined;
    return references.map((reference: unknown) =>
      parseSchema(MemoryEvidenceReferenceSchema, reference),
    );
  }

  /** Event order, rather than caller timestamps, identifies the latest user turn. */
  latestUserMessageId(
    runId: string,
    beforeSequence?: number,
  ): string | undefined {
    const row = this.database
      .prepare(
        `SELECT COALESCE(json_extract(output_json,'$.messageId'),
      json_extract(input_json,'$.messageId')) AS messageId FROM run_items
      WHERE run_id=@runId AND kind='user_message' AND status='completed'
        AND (@before IS NULL OR sequence<@before)
      ORDER BY sequence DESC LIMIT 1`,
      )
      .get({ runId, before: beforeSequence ?? null }) as
      { messageId: unknown } | undefined;
    return typeof row?.messageId === "string" ? row.messageId : undefined;
  }

  getRunSourceReference(
    runId: string,
  ): Pick<Run, "id" | "chatId" | "source" | "createdAt"> | undefined {
    return this.database
      .prepare(
        `SELECT id, chat_id AS chatId, source, created_at AS createdAt FROM runs WHERE id = ?`,
      )
      .get(runId) as
      Pick<Run, "id" | "chatId" | "source" | "createdAt"> | undefined;
  }

  getRunItemSourceReference(
    itemId: string,
  ): RunItemSourceReference | undefined {
    const row = this.database
      .prepare(`SELECT ${runItemSourceProjection} FROM run_items WHERE id = ?`)
      .get(itemId) as Record<string, unknown> | undefined;
    return row ? readRunItemSource(row) : undefined;
  }

  /** Indexed message-to-Item identity lookup; never materializes Item bodies. */
  getMessageItemSourceReferences(
    runId: string,
    messageId: string,
  ): RunItemSourceReference[] {
    const rows = this.database
      .prepare(
        `SELECT ${runItemSourceProjection} FROM run_items
      WHERE run_id=? AND COALESCE(json_extract(output_json,'$.messageId'),
        json_extract(input_json,'$.messageId'))=? ORDER BY sequence`,
      )
      .all(runId, messageId) as Record<string, unknown>[];
    return rows
      .map(readRunItemSource)
      .filter((item) => item.messageId === messageId);
  }

  /** Read only the original message projection, using the existing message identity index.
   * Missing metadata belongs to older/Voice messages and must not imply a phase.
   */
  getAssistantMessages(
    runId: string,
    messageId: string,
  ): readonly JsonValue[] | undefined {
    const rows = this.database
      .prepare(
        `
      SELECT json_extract(output_json, '$.assistantMessages') AS messages
      FROM run_items
      WHERE run_id=? AND COALESCE(json_extract(output_json,'$.messageId'),
        json_extract(input_json,'$.messageId'))=?
        AND kind='assistant_message' AND status='completed'
        AND json_type(output_json,'$.assistantMessages')='array'
      ORDER BY sequence
    `,
      )
      .all(runId, messageId) as { messages: string }[];
    if (!rows.length) return undefined;
    return rows.flatMap((row) => JSON.parse(row.messages) as JsonValue[]);
  }

  /** Host-stamped references from completed model requests, not a guessed
   * latest search or the set of currently stored Memory records. */
  suppliedMemoryReferences(
    runId: string,
    beforeSequence?: number,
  ): MemoryEvidenceReference[] {
    const rows = this.database
      .prepare(
        `WITH voice_boundary AS (
          SELECT item.id FROM run_items item JOIN runs run ON run.id=item.run_id
          WHERE item.run_id=@runId AND run.source='voice' AND item.sequence=@boundary
            AND item.kind='tool_call' AND json_type(item.input_json,'$.suppliedMemoryReferences')='array'
        ), supplied AS (
          SELECT ref.value AS reference,item.sequence AS sequence,ref.key AS ordinal
          FROM run_items item,json_each(item.output_json,'$.memoryReferences') ref
          WHERE item.run_id=@runId AND item.kind='assistant_message' AND item.status='completed'
            AND (@boundary IS NULL OR item.sequence<@boundary)
            AND NOT EXISTS (SELECT 1 FROM voice_boundary)
          UNION ALL
          SELECT ref.value,item.sequence,ref.key
          FROM run_items item JOIN runs run ON run.id=item.run_id,
            json_each(item.input_json,'$.suppliedMemoryReferences') ref
          WHERE item.run_id=@runId AND run.source='voice' AND item.kind='tool_call'
            AND ((EXISTS (SELECT 1 FROM voice_boundary) AND item.id IN (SELECT id FROM voice_boundary))
              OR (NOT EXISTS (SELECT 1 FROM voice_boundary) AND (@boundary IS NULL OR item.sequence<=@boundary)))
        ) SELECT reference FROM supplied GROUP BY reference ORDER BY MIN(sequence),MIN(ordinal)`,
      )
      .all({ runId, boundary: beforeSequence ?? null }) as {
      reference: string;
    }[];
    return [
      ...new Map(
        rows.map(({ reference }) => {
          const ref = parseSchema(
            MemoryEvidenceReferenceSchema,
            JSON.parse(reference) as unknown,
          );
          return [`${ref.memoryId}:${ref.revisionId}:${ref.use}`, ref] as const;
        }),
      ).values(),
    ];
  }

  *memoryFormationItemReferences(
    runId: string,
  ): Iterable<RunItemSourceReference> {
    const query = this.database
      .prepare(`SELECT ${runItemSourceProjection} FROM run_items
      WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 1`);
    let sequence = -1;
    for (;;) {
      const row = query.get(runId, sequence) as
        Record<string, unknown> | undefined;
      if (!row) return;
      const value = readRunItemSource(row);
      sequence = value.sequence;
      yield value;
    }
  }

  getApproval(approvalId: string): Approval | undefined {
    const row = this.selectApproval(approvalId);
    return row ? readApproval(row) : undefined;
  }

  getLatestPendingApproval(): Approval | undefined {
    const row = this.database
      .prepare(
        `SELECT id, run_id, item_id, tool_name, parameter_summary, status,
                requested_at, expires_at, decided_at, decision_reason
         FROM approvals
         WHERE status = 'pending'
         ORDER BY requested_at DESC, id DESC
         LIMIT 1`,
      )
      .get() as ApprovalRow | undefined;
    return row ? readApproval(row) : undefined;
  }

  listRunsByStatus(statuses: readonly Run["status"][]): Run[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT id, chat_id, execution_json, persona_json, provider_json, source, status,
                latest_sequence, created_at, started_at, ended_at, error_json
         FROM runs
         WHERE status IN (${placeholders})
         ORDER BY created_at, id`,
      )
      .all(...statuses) as RunRow[];
    return rows.map(readRun);
  }

  listRunItems(runId: string): RunItem[] {
    const rows = this.database
      .prepare(
        `SELECT id, run_id, sequence, kind, status, input_json, output_json,
                display_output, started_at, ended_at, duration_ms, error_json
         FROM run_items
         WHERE run_id = ?
         ORDER BY sequence, id`,
      )
      .all(runId) as RunItemRow[];
    return rows.map((row) => this.readRunItem(row));
  }

  *steeringMessagesAfter(runId: string, sequence: number): Iterable<string> {
    const rows = this.database
      .prepare(
        `
      SELECT json_extract(input_json, '$.content') AS content
      FROM run_items
      WHERE run_id = ? AND sequence > ? AND kind = 'user_message'
        AND status = 'completed' AND json_extract(input_json, '$.steering') = 1
        AND json_type(input_json, '$.content') = 'text'
      ORDER BY sequence
    `,
      )
      .iterate(runId, sequence);
    for (const row of rows) yield (row as { content: string }).content;
  }

  private applyProjection(currentRun: Run, envelope: RunEventEnvelope): void {
    const { event } = envelope;
    switch (event.type) {
      case "run.resumed": {
        if (
          currentRun.status !== "interrupted" &&
          currentRun.status !== "needs_input"
        ) {
          throw new Error(`Run ${envelope.streamId} is not resumable`);
        }
        assertRunIdentity(currentRun, event.run, envelope.streamId);
        if (
          event.run.status !== "running" ||
          event.run.latestSequence !== envelope.sequence ||
          event.run.endedAt !== undefined ||
          event.run.error !== undefined
        ) {
          throw new Error(
            `Invalid run.resumed projection for ${envelope.streamId}`,
          );
        }
        this.updateRun(event.run);
        return;
      }
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
        this.updateRunSequence(
          envelope.streamId,
          envelope.sequence,
          event.item.kind === "user_message" &&
            (currentRun.status === "needs_input" ||
              currentRun.status === "waiting_approval")
            ? undefined
            : "running",
        );
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
        const text = textDelta(event.delta);
        if (text) this.appendRunItemDisplayOutput(event.itemId, text);
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
          (currentItem.status !== "running" &&
            currentItem.status !== "waiting_approval" &&
            currentItem.status !== "waiting_input") ||
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
        this.updateRunItem({
          ...this.readRunItem(item),
          status: "waiting_approval",
        });
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
      case "input.requested": {
        const currentItemRow = this.selectRunItem(event.item.id);
        if (!currentItemRow) {
          throw new Error(`Run item ${event.item.id} does not exist`);
        }
        const currentItem = this.readRunItem(currentItemRow);
        assertItemIdentity(currentItem, event.item);
        assertRunIdentity(currentRun, event.run, envelope.streamId);
        if (
          currentRun.status !== "running" ||
          currentItem.status !== "running" ||
          event.item.runId !== envelope.streamId ||
          event.item.kind !== "input_request" ||
          event.item.status !== "waiting_input" ||
          event.run.status !== "needs_input" ||
          event.run.latestSequence !== envelope.sequence ||
          event.run.endedAt !== undefined ||
          event.run.error !== undefined
        ) {
          throw new Error(
            `Invalid input.requested event for ${envelope.streamId}`,
          );
        }
        this.updateRunItem(event.item);
        this.updateRun(event.run);
        return;
      }
      case "input.resolved": {
        const currentItemRow = this.selectRunItem(event.item.id);
        if (!currentItemRow) {
          throw new Error(`Run item ${event.item.id} does not exist`);
        }
        const currentItem = this.readRunItem(currentItemRow);
        assertItemIdentity(currentItem, event.item);
        assertRunIdentity(currentRun, event.run, envelope.streamId);
        if (
          currentRun.status !== "needs_input" ||
          currentItem.status !== "waiting_input" ||
          event.item.runId !== envelope.streamId ||
          event.item.kind !== "input_request" ||
          event.item.status !== "completed" ||
          event.run.status !== "running" ||
          event.run.latestSequence !== envelope.sequence ||
          event.run.endedAt !== undefined ||
          event.run.error !== undefined
        ) {
          throw new Error(
            `Invalid input.resolved event for ${envelope.streamId}`,
          );
        }
        this.updateRunItem(event.item);
        this.updateRun(event.run);
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
          id, chat_id, execution_json, persona_json, provider_json, source, status, latest_sequence,
          created_at, started_at, ended_at, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.chatId,
        serializeForPersistence(run.execution),
        serializeForPersistence(run.persona),
        serializeForPersistence(run.provider),
        run.source,
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
          id, run_id, sequence, kind, status, input_json, output_json, display_output,
          started_at, ended_at, duration_ms, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.runId,
        item.sequence,
        item.kind,
        item.status,
        item.input === undefined ? null : serializeForPersistence(item.input),
        item.output === undefined ? null : serializeForPersistence(item.output),
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
         SET status = ?, input_json = ?, output_json = ?, display_output = ?, started_at = ?,
             ended_at = ?, duration_ms = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        item.status,
        item.input === undefined ? null : serializeForPersistence(item.input),
        item.output === undefined ? null : serializeForPersistence(item.output),
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

  private appendRunItemDisplayOutput(itemId: string, text: string): void {
    const result = this.database
      .prepare(
        `UPDATE run_items
         SET display_output = COALESCE(display_output, '') || ?
         WHERE id = ?`,
      )
      .run(text, itemId);
    if (result.changes !== 1) {
      throw new Error(`Run item ${itemId} does not exist`);
    }
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
        `SELECT id, chat_id, execution_json, persona_json, provider_json, source, status,
                latest_sequence, created_at, started_at, ended_at, error_json
         FROM runs
         WHERE id = ?`,
      )
      .get(runId) as RunRow | undefined;
  }

  private selectRunItem(itemId: string): RunItemRow | undefined {
    return this.database
      .prepare(
        `SELECT id, run_id, sequence, kind, status, input_json, output_json, display_output,
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
