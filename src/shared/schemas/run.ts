import { Type } from "@sinclair/typebox";

import {
  EntityIdSchema,
  JsonValueReferenceSchema,
  NonBlankStringSchema,
  SequenceSchema,
  Sha256Schema,
  TimestampSchema,
} from "./primitives";
import { AppErrorSchema } from "./error";
import { ProviderSnapshotSchema } from "./provider";

export { AppErrorSchema } from "./error";

export const ArtifactKindSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("directory"),
  Type.Literal("image"),
  Type.Literal("audio"),
  Type.Literal("video"),
  Type.Literal("log"),
  Type.Literal("data"),
]);

export const ArtifactReferenceSchema = Type.Object(
  {
    artifactId: EntityIdSchema,
    byteLength: Type.Optional(Type.Integer({ minimum: 0 })),
    displayName: NonBlankStringSchema,
    kind: ArtifactKindSchema,
    mediaType: Type.Optional(NonBlankStringSchema),
    sha256: Type.Optional(Sha256Schema),
    storageKey: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ApprovalModeSchema = Type.Union([
  Type.Literal("request_approval"),
  Type.Literal("auto_approve"),
  Type.Literal("full_access"),
]);

export const RunExecutionSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("chat"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      approvalMode: ApprovalModeSchema,
      mode: Type.Literal("agent"),
    },
    { additionalProperties: false },
  ),
]);

export const RunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("needs_input"),
  Type.Literal("interrupted"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const TerminalRunStatusSchema = Type.Union([
  Type.Literal("needs_input"),
  Type.Literal("interrupted"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const RunSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    createdAt: TimestampSchema,
    endedAt: Type.Optional(TimestampSchema),
    error: Type.Optional(AppErrorSchema),
    execution: RunExecutionSchema,
    id: EntityIdSchema,
    latestSequence: Type.Integer({ minimum: 0 }),
    provider: ProviderSnapshotSchema,
    startedAt: Type.Optional(TimestampSchema),
    status: RunStatusSchema,
  },
  { additionalProperties: false },
);

export const RunItemKindSchema = Type.Union([
  Type.Literal("user_message"),
  Type.Literal("assistant_message"),
  Type.Literal("plan"),
  Type.Literal("tool_call"),
  Type.Literal("command"),
  Type.Literal("file_change"),
  Type.Literal("approval"),
  Type.Literal("context_compaction"),
  Type.Literal("error"),
]);

export const RunItemStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);

export const RunItemSchema = Type.Object(
  {
    artifacts: Type.Array(ArtifactReferenceSchema),
    displayOutput: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(TimestampSchema),
    error: Type.Optional(AppErrorSchema),
    id: EntityIdSchema,
    input: Type.Optional(JsonValueReferenceSchema),
    kind: RunItemKindSchema,
    runId: EntityIdSchema,
    sequence: SequenceSchema,
    startedAt: Type.Optional(TimestampSchema),
    status: RunItemStatusSchema,
  },
  { additionalProperties: false },
);

export const ApprovalStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("expired"),
  Type.Literal("cancelled"),
]);

export const ApprovalSchema = Type.Object(
  {
    decidedAt: Type.Optional(TimestampSchema),
    decisionReason: Type.Optional(Type.String()),
    expiresAt: TimestampSchema,
    id: EntityIdSchema,
    itemId: EntityIdSchema,
    parameterSummary: NonBlankStringSchema,
    requestedAt: TimestampSchema,
    runId: EntityIdSchema,
    status: ApprovalStatusSchema,
    toolName: Type.String({ pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$" }),
  },
  { additionalProperties: false },
);

export const RunCancelRequestSchema = Type.Object(
  {
    requestedAt: TimestampSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const RunCancelResultSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("accepted"),
      runId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("already_terminal"),
      runId: EntityIdSchema,
      status: TerminalRunStatusSchema,
    },
    { additionalProperties: false },
  ),
]);
