import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

export const JourneyStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("completed"),
]);

export const TogetherSessionStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("ended"),
]);

export const JourneyFollowUpStatusSchema = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("sent"),
  Type.Literal("cancelled"),
]);

export const JourneyFollowUpSchema = Type.Object(
  {
    automationId: EntityIdSchema,
    message: NonBlankStringSchema,
    runAt: TimestampSchema,
    status: JourneyFollowUpStatusSchema,
  },
  { additionalProperties: false },
);

export const JourneySchema = Type.Object(
  {
    completedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    currentPosition: Type.Optional(NonBlankStringSchema),
    followUp: Type.Optional(JourneyFollowUpSchema),
    homeChatId: EntityIdSchema,
    id: EntityIdSchema,
    nextStep: Type.Optional(NonBlankStringSchema),
    pausedAt: Type.Optional(TimestampSchema),
    purpose: NonBlankStringSchema,
    status: JourneyStatusSchema,
    title: NonBlankStringSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const TogetherSessionSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    createdAt: TimestampSchema,
    endedAt: Type.Optional(TimestampSchema),
    id: EntityIdSchema,
    journeyId: Type.Optional(EntityIdSchema),
    pausedAt: Type.Optional(TimestampSchema),
    recap: Type.Optional(NonBlankStringSchema),
    resumeNote: Type.Optional(NonBlankStringSchema),
    status: TogetherSessionStatusSchema,
    title: NonBlankStringSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const JourneyMomentKindSchema = Type.Union([
  Type.Literal("milestone"),
  Type.Literal("memory"),
  Type.Literal("closure"),
  Type.Literal("reopened"),
]);

export const JourneyMomentSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    journeyId: EntityIdSchema,
    kind: JourneyMomentKindSchema,
    memoryId: Type.Optional(EntityIdSchema),
    occurredAt: TimestampSchema,
    sessionId: Type.Optional(EntityIdSchema),
  },
  { additionalProperties: false },
);

export const JourneySnapshotSchema = Type.Object(
  {
    activeSession: Type.Optional(TogetherSessionSchema),
    journeys: Type.Array(JourneySchema),
    sessions: Type.Array(TogetherSessionSchema),
  },
  { additionalProperties: false },
);

export const JourneyDetailSchema = Type.Object(
  {
    journey: JourneySchema,
    moments: Type.Array(JourneyMomentSchema),
    sessions: Type.Array(TogetherSessionSchema),
  },
  { additionalProperties: false },
);

export const JourneySnapshotRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const JourneyIdRequestSchema = Type.Object(
  { journeyId: EntityIdSchema },
  { additionalProperties: false },
);

export const JourneySetStatusRequestSchema = Type.Object(
  {
    closure: Type.Optional(NonBlankStringSchema),
    journeyId: EntityIdSchema,
    status: JourneyStatusSchema,
  },
  { additionalProperties: false },
);

export const TogetherSessionSetStatusRequestSchema = Type.Object(
  {
    recap: Type.Optional(NonBlankStringSchema),
    resumeNote: Type.Optional(NonBlankStringSchema),
    sessionId: EntityIdSchema,
    status: TogetherSessionStatusSchema,
  },
  { additionalProperties: false },
);

function operationResponse<TValue extends TSchema>(value: TValue) {
  return Type.Union([
    Type.Object(
      { ok: Type.Literal(true), value },
      { additionalProperties: false },
    ),
    Type.Object(
      { error: AppErrorSchema, ok: Type.Literal(false) },
      { additionalProperties: false },
    ),
  ]);
}

export const JourneySnapshotResponseSchema = operationResponse(
  JourneySnapshotSchema,
);
export const JourneyDetailResponseSchema =
  operationResponse(JourneyDetailSchema);
export const JourneyMutationResponseSchema = operationResponse(
  JourneySnapshotSchema,
);
