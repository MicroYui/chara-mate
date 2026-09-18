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
  Type.Literal("unknown"),
]);

export const ActivityBoundarySchema = Type.Union([
  Type.Literal("application"),
  Type.Literal("window"),
  Type.Literal("content"),
  Type.Literal("interaction"),
  Type.Literal("idle"),
]);
export const ActivityContentStatusSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("unavailable"),
  Type.Literal("protected"),
]);
export const ActivityContentSchema = Type.Object(
  {
    source: Type.Union([Type.Literal("accessibility"), Type.Literal("dom")]),
    scope: Type.Union([
      Type.Literal("focused_element"),
      Type.Literal("viewport"),
    ]),
    text: NonBlankStringSchema,
    truncated: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export const ActivityInteractionSchema = Type.Object(
  {
    clicks: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    keystrokes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    scrolls: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export const ActivityInputOriginSchema = Type.Union([
  Type.Literal("hid_reported"),
  Type.Literal("synthetic_reported"),
  Type.Literal("unknown"),
]);
export const ActivityApplicationLifecycleSchema = Type.Union([
  Type.Literal("launched"),
  Type.Literal("activated"),
  Type.Literal("terminated"),
]);
export const ActivitySurfaceSchema = Type.Object(
  {
    id: NonBlankStringSchema,
    epoch: NonBlankStringSchema,
    displayId: NonBlankStringSchema,
    windowId: NonBlankStringSchema,
    processId: Type.Integer({ minimum: 1 }),
    appName: NonBlankStringSchema,
    appId: Type.Optional(NonBlankStringSchema),
    windowTitle: Type.Optional(NonBlankStringSchema),
    bounds: Type.Object(
      {
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number({ exclusiveMinimum: 0 }),
        height: Type.Number({ exclusiveMinimum: 0 }),
      },
      { additionalProperties: false },
    ),
    scaleFactor: Type.Number({ exclusiveMinimum: 0 }),
    clipped: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const ActivityVisualStatusSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("unavailable"),
  Type.Literal("protected"),
]);
export const ActivityOcrLineSchema = Type.Object(
  {
    text: NonBlankStringSchema,
    bounds: Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
        height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export const ActivityVisualTriggerSchema = Type.Union([
  Type.Literal("foreground"),
  Type.Literal("content"),
  Type.Literal("interaction"),
  Type.Literal("frame"),
]);
export const ActivityVisualSchema = Type.Object(
  {
    surface: ActivitySurfaceSchema,
    capturedAt: TimestampSchema,
    receivedAt: TimestampSchema,
    contentRevision: NonBlankStringSchema,
    sequence: Type.Integer({ minimum: 0 }),
    coalescedFrames: Type.Integer({ minimum: 0 }),
    trigger: ActivityVisualTriggerSchema,
    triggerEventId: Type.Optional(EntityIdSchema),
    ocr: Type.Object(
      {
        engine: Type.Literal("apple_vision"),
        revision: Type.Integer({ minimum: 1 }),
        languages: Type.Array(NonBlankStringSchema),
        status: Type.Union([Type.Literal("complete"), Type.Literal("empty")]),
        lines: Type.Array(ActivityOcrLineSchema),
      },
      { additionalProperties: false },
    ),
    redactedRegions: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const ActivityVisualReferenceSchema = Type.Object(
  {
    eventId: EntityIdSchema,
    artifactId: EntityIdSchema,
    contentRevision: NonBlankStringSchema,
    surface: ActivitySurfaceSchema,
    capturedAt: TimestampSchema,
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    trigger: ActivityVisualTriggerSchema,
  },
  { additionalProperties: false },
);

export const ActivityVisualPositionSchema = Type.Object(
  { startedAt: TimestampSchema, eventId: EntityIdSchema },
  { additionalProperties: false },
);
export const ActivityVisualLookupRequestSchema = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Literal text to find in the application, window title or captured OCR. Use distinctive words; omit to list retained observations in the requested range.",
      }),
    ),
    periodStart: Type.Optional(TimestampSchema),
    periodEnd: Type.Optional(TimestampSchema),
    surface: Type.Optional(
      Type.Pick(ActivitySurfaceSchema, ["id", "epoch"], {
        additionalProperties: false,
      }),
    ),
    before: Type.Optional(ActivityVisualPositionSchema),
  },
  { additionalProperties: false },
);
export const ActivityImageTargetSchema = Type.Union([
  Type.Object(
    { reference: ActivityVisualReferenceSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { search: ActivityVisualLookupRequestSchema },
    { additionalProperties: false },
  ),
  Type.Object({ current: Type.Literal(true) }, { additionalProperties: false }),
]);

const perceptionFields = {
  boundary: Type.Optional(ActivityBoundarySchema),
  content: Type.Optional(ActivityContentSchema),
  contentStatus: Type.Optional(ActivityContentStatusSchema),
  interaction: Type.Optional(ActivityInteractionSchema),
  inputOrigin: Type.Optional(ActivityInputOriginSchema),
  surface: Type.Optional(ActivitySurfaceSchema),
  visualStatus: Type.Optional(ActivityVisualStatusSchema),
};

export const ActivityEventDetailsSchema = Type.Union([
  Type.Object(
    {
      ...perceptionFields,
      lifecycle: Type.Optional(ActivityApplicationLifecycleSchema),
      appId: Type.Optional(NonBlankStringSchema),
      appName: NonBlankStringSchema,
      source: Type.Literal("active_app"),
      windowTitle: Type.Optional(NonBlankStringSchema),
    },
    {
      additionalProperties: false,
      dependencies: { inputOrigin: ["interaction"] },
    },
  ),
  Type.Object(
    {
      ...perceptionFields,
      action: Type.Optional(NonBlankStringSchema),
      domain: NonBlankStringSchema,
      source: Type.Literal("managed_browser"),
      title: Type.Optional(NonBlankStringSchema),
      url: NonBlankStringSchema,
    },
    {
      additionalProperties: false,
      dependencies: { inputOrigin: ["interaction"] },
    },
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
      visual: Type.Optional(ActivityVisualSchema),
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

export const ActivityEventReferenceRequestSchema = Type.Object(
  { eventId: EntityIdSchema },
  { additionalProperties: false },
);
export const ActivityEventReferenceSchema = Type.Object(
  {
    date: CalendarDateSchema,
    episodeId: Type.Optional(EntityIdSchema),
    event: ActivityEventSchema,
  },
  { additionalProperties: false },
);
export const ActivityEventReferenceResponseSchema = operationResponse(
  ActivityEventReferenceSchema,
);
