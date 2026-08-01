import { Type } from "@sinclair/typebox";

import {
  ApprovalSchema,
  AppErrorSchema,
  RunItemSchema,
  RunSchema,
} from "./run";
import {
  EntityIdSchema,
  JsonValueReferenceSchema,
  SequenceSchema,
  TimestampSchema,
} from "./primitives";

export const RUN_EVENT_CHANNELS = {
  replay: "run.events.replay",
  subscribe: "run.events.subscribe",
} as const;

export const IpcChannelSchema = Type.String({
  pattern: "^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)+$",
});

export const RunEventSchema = Type.Union([
  Type.Object(
    { run: RunSchema, type: Type.Literal("run.started") },
    { additionalProperties: false },
  ),
  Type.Object(
    { item: RunItemSchema, type: Type.Literal("item.started") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      delta: JsonValueReferenceSchema,
      itemId: EntityIdSchema,
      type: Type.Literal("item.delta"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { item: RunItemSchema, type: Type.Literal("item.completed") },
    { additionalProperties: false },
  ),
  Type.Object(
    { approval: ApprovalSchema, type: Type.Literal("approval.requested") },
    { additionalProperties: false },
  ),
  Type.Object(
    { approval: ApprovalSchema, type: Type.Literal("approval.resolved") },
    { additionalProperties: false },
  ),
  Type.Object(
    { run: RunSchema, type: Type.Literal("run.needs_input") },
    { additionalProperties: false },
  ),
  Type.Object(
    { run: RunSchema, type: Type.Literal("run.interrupted") },
    { additionalProperties: false },
  ),
  Type.Object(
    { run: RunSchema, type: Type.Literal("run.completed") },
    { additionalProperties: false },
  ),
  Type.Object(
    { run: RunSchema, type: Type.Literal("run.failed") },
    { additionalProperties: false },
  ),
  Type.Object(
    { run: RunSchema, type: Type.Literal("run.cancelled") },
    { additionalProperties: false },
  ),
]);

export const RunEventEnvelopeSchema = Type.Object(
  {
    event: RunEventSchema,
    occurredAt: TimestampSchema,
    sequence: SequenceSchema,
    streamId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const RunEventReplayRequestSchema = Type.Object(
  {
    afterSequence: Type.Integer({ minimum: 0 }),
    streamId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const RunEventReplayResponseSchema = Type.Object(
  {
    events: Type.Array(RunEventEnvelopeSchema),
    latestSequence: Type.Integer({ minimum: 0 }),
    streamId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const IpcRequestSchema = Type.Object(
  {
    channel: IpcChannelSchema,
    payload: JsonValueReferenceSchema,
    requestId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const IpcResponseSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      requestId: EntityIdSchema,
      value: JsonValueReferenceSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      error: AppErrorSchema,
      ok: Type.Literal(false),
      requestId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
]);
