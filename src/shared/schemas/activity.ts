import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  CalendarDateSchema,
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

export const ActivitySourceSchema = Type.Union([
  Type.Literal("active_app"),
  Type.Literal("managed_browser"),
  Type.Literal("screenshot"),
  Type.Literal("idle"),
  Type.Literal("agent_run"),
]);

export const ActivityActorSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("agent"),
  Type.Literal("system"),
]);

export const ActivityEventDetailsSchema = Type.Union([
  Type.Object(
    {
      appId: Type.Optional(NonBlankStringSchema),
      appName: NonBlankStringSchema,
      source: Type.Literal("active_app"),
      windowTitle: Type.Optional(NonBlankStringSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Optional(NonBlankStringSchema),
      domain: NonBlankStringSchema,
      source: Type.Literal("managed_browser"),
      title: Type.Optional(NonBlankStringSchema),
      url: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      artifactId: EntityIdSchema,
      height: Type.Integer({ minimum: 1 }),
      mediaType: NonBlankStringSchema,
      ocrText: Type.Optional(Type.String()),
      source: Type.Literal("screenshot"),
      storageKey: NonBlankStringSchema,
      summary: Type.Optional(NonBlankStringSchema),
      width: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("idle"),
      state: Type.Union([Type.Literal("started"), Type.Literal("ended")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: EntityIdSchema,
      source: Type.Literal("agent_run"),
      status: Type.Union([
        Type.Literal("started"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
      ]),
      summary: Type.Optional(NonBlankStringSchema),
    },
    { additionalProperties: false },
  ),
]);

export const ActivityEventSchema = Type.Object(
  {
    actor: ActivityActorSchema,
    details: ActivityEventDetailsSchema,
    endedAt: Type.Optional(TimestampSchema),
    id: EntityIdSchema,
    startedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const ActivityEpisodeSchema = Type.Object(
  {
    actor: ActivityActorSchema,
    appNames: Type.Array(NonBlankStringSchema),
    createdAt: TimestampSchema,
    digestId: Type.Optional(EntityIdSchema),
    domains: Type.Array(NonBlankStringSchema),
    endedAt: TimestampSchema,
    eventCount: Type.Integer({ minimum: 1 }),
    id: EntityIdSchema,
    rawClearedAt: Type.Optional(TimestampSchema),
    screenshotStorageKeys: Type.Array(NonBlankStringSchema),
    sourceTypes: Type.Array(ActivitySourceSchema, { minItems: 1 }),
    startedAt: TimestampSchema,
    summary: NonBlankStringSchema,
    title: NonBlankStringSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const ActivityDigestSchema = Type.Object(
  {
    candidateIds: Type.Array(EntityIdSchema),
    createdAt: TimestampSchema,
    evidenceDays: Type.Integer({ minimum: 1 }),
    episodeIds: Type.Array(EntityIdSchema, { minItems: 1 }),
    id: EntityIdSchema,
    kind: Type.Union([Type.Literal("daily"), Type.Literal("weekly")]),
    periodEnd: TimestampSchema,
    periodStart: TimestampSchema,
    summary: NonBlankStringSchema,
    title: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ActivitySnapshotSchema = Type.Object(
  {
    date: CalendarDateSchema,
    digests: Type.Array(ActivityDigestSchema),
    episodes: Type.Array(ActivityEpisodeSchema),
    lastCleanupAt: Type.Optional(TimestampSchema),
    paused: Type.Boolean(),
    rawBytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ActivitySnapshotRequestSchema = Type.Object(
  { date: CalendarDateSchema },
  { additionalProperties: false },
);

export const ActivitySetPausedRequestSchema = Type.Object(
  { paused: Type.Boolean() },
  { additionalProperties: false },
);

export const ActivityEpisodeIdRequestSchema = Type.Object(
  { episodeId: EntityIdSchema },
  { additionalProperties: false },
);

export const ActivityUpdateEpisodeRequestSchema = Type.Object(
  {
    episodeId: EntityIdSchema,
    summary: NonBlankStringSchema,
    title: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ActivityCleanupRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const ActivityCleanupResultSchema = Type.Object(
  {
    deletedAssets: Type.Integer({ minimum: 0 }),
    deletedEvents: Type.Integer({ minimum: 0 }),
    finishedAt: TimestampSchema,
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

export const ActivitySnapshotResponseSchema = operationResponse(
  ActivitySnapshotSchema,
);
export const ActivityEpisodeResponseSchema = operationResponse(
  ActivityEpisodeSchema,
);
export const ActivityCleanupResponseSchema = operationResponse(
  ActivityCleanupResultSchema,
);
