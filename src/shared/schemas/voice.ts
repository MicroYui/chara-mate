import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  JsonValueReferenceSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";
import { RunExecutionSchema } from "./run";
import { ProviderSnapshotSchema } from "./provider";

export const VoiceNameSchema = Type.Union([
  Type.Literal("alloy"),
  Type.Literal("ash"),
  Type.Literal("ballad"),
  Type.Literal("coral"),
  Type.Literal("echo"),
  Type.Literal("sage"),
  Type.Literal("shimmer"),
  Type.Literal("verse"),
]);

export const VoiceInputModeSchema = Type.Union([
  Type.Literal("hands_free"),
  Type.Literal("push_to_talk"),
]);

export const VoicePhaseSchema = Type.Union([
  Type.Literal("connecting"),
  Type.Literal("resuming"),
  Type.Literal("paused"),
  Type.Literal("listening"),
  Type.Literal("thinking"),
  Type.Literal("using_tool"),
  Type.Literal("waiting_approval"),
  Type.Literal("speaking"),
  Type.Literal("interrupted"),
  Type.Literal("failed"),
]);

export const VoiceSessionStatusSchema = Type.Union([
  Type.Literal("connecting"),
  Type.Literal("active"),
  Type.Literal("interrupted"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);

export const VoiceTurnStatusSchema = Type.Union([
  Type.Literal("listening"),
  Type.Literal("responding"),
  Type.Literal("completed"),
  Type.Literal("interrupted"),
  Type.Literal("failed"),
]);

export const VoiceSessionRecordSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    connectedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    endedAt: Type.Optional(TimestampSchema),
    error: Type.Optional(AppErrorSchema),
    generation: Type.Integer({ minimum: 0 }),
    id: EntityIdSchema,
    inputMode: VoiceInputModeSchema,
    instructions: NonBlankStringSchema,
    lastRunId: Type.Optional(EntityIdSchema),
    muted: Type.Boolean(),
    protocolSessionId: Type.Optional(NonBlankStringSchema),
    provider: ProviderSnapshotSchema,
    status: VoiceSessionStatusSchema,
    voice: VoiceNameSchema,
  },
  { additionalProperties: false },
);

export const VoiceTurnRecordSchema = Type.Object(
  {
    assistantItemId: Type.Optional(NonBlankStringSchema),
    assistantMessageId: Type.Optional(EntityIdSchema),
    assistantTranscript: Type.String(),
    audioEndMs: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(TimestampSchema),
    generation: Type.Integer({ minimum: 1 }),
    id: EntityIdSchema,
    instructions: NonBlankStringSchema,
    interrupted: Type.Boolean(),
    responseId: Type.Optional(NonBlankStringSchema),
    runId: Type.Optional(EntityIdSchema),
    sessionId: EntityIdSchema,
    startedAt: TimestampSchema,
    status: VoiceTurnStatusSchema,
    userItemId: Type.Optional(NonBlankStringSchema),
    userMessageId: Type.Optional(EntityIdSchema),
    userTranscript: Type.String(),
    voice: VoiceNameSchema,
  },
  { additionalProperties: false },
);

export const VoiceSessionSnapshotSchema = Type.Object(
  {
    assistantTranscript: Type.String(),
    chatId: EntityIdSchema,
    connectedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    error: Type.Optional(AppErrorSchema),
    generation: Type.Integer({ minimum: 0 }),
    inputMode: VoiceInputModeSchema,
    muted: Type.Boolean(),
    phase: VoicePhaseSchema,
    runId: Type.Optional(EntityIdSchema),
    sessionId: EntityIdSchema,
    turnId: Type.Optional(EntityIdSchema),
    userTranscript: Type.String(),
    voice: VoiceNameSchema,
  },
  { additionalProperties: false },
);

export const VoiceStartRequestSchema = Type.Object(
  {
    chatProviderProfileId: EntityIdSchema,
    chatId: EntityIdSchema,
    execution: RunExecutionSchema,
    requestedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const VoiceQuickStartRequestSchema = Type.Union([
  Type.Object(
    { requestedAt: TimestampSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      chatId: EntityIdSchema,
      execution: Type.Object(
        { mode: Type.Literal("chat") },
        { additionalProperties: false },
      ),
      requestedAt: TimestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const VoicePreviewRequestSchema = Type.Object(
  {
    instructions: NonBlankStringSchema,
    providerProfileId: EntityIdSchema,
    voice: VoiceNameSchema,
  },
  { additionalProperties: false },
);

export const VoiceSessionRequestSchema = Type.Object(
  { sessionId: EntityIdSchema },
  { additionalProperties: false },
);

export const VoiceMutedRequestSchema = Type.Object(
  {
    muted: Type.Boolean(),
    sessionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const VoicePausedRequestSchema = Type.Object(
  {
    paused: Type.Boolean(),
    requestedAt: TimestampSchema,
    sessionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const VoiceHistoryMessageSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  },
  { additionalProperties: false },
);

export const VoiceConnectionSchema = Type.Object(
  {
    callsUrl: NonBlankStringSchema,
    clientSecret: NonBlankStringSchema,
    expiresAt: TimestampSchema,
    history: Type.Array(VoiceHistoryMessageSchema),
    inputMode: VoiceInputModeSchema,
    sessionId: EntityIdSchema,
    voice: VoiceNameSchema,
  },
  { additionalProperties: false },
);

export const VoicePreviewConnectionSchema = Type.Object(
  {
    callsUrl: NonBlankStringSchema,
    clientSecret: NonBlankStringSchema,
    expiresAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const VoiceFunctionToolSchema = Type.Object(
  {
    description: NonBlankStringSchema,
    name: NonBlankStringSchema,
    parameters: JsonValueReferenceSchema,
    type: Type.Literal("function"),
  },
  { additionalProperties: false },
);

export const VoiceConnectionStageSchema = Type.Union([
  Type.Literal("credential"),
  Type.Literal("microphone"),
  Type.Literal("ice"),
  Type.Literal("sdp"),
  Type.Literal("data_channel"),
]);

const voiceUsageProperties = {
  cachedInputTokens: Type.Integer({ minimum: 0 }),
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
};

export const VoiceDriverEventSchema = Type.Union([
  Type.Object(
    {
      protocolSessionId: NonBlankStringSchema,
      type: Type.Literal("session.ready"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      requestId: EntityIdSchema,
      type: Type.Literal("session.refreshed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      durationMs: Type.Number({ minimum: 0 }),
      stage: VoiceConnectionStageSchema,
      type: Type.Literal("connection.stage"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      reason: Type.Optional(Type.String()),
      type: Type.Literal("connection.closed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      audioEndMs: Type.Optional(Type.Integer({ minimum: 0 })),
      assistantItemId: Type.Optional(NonBlankStringSchema),
      itemId: NonBlankStringSchema,
      type: Type.Literal("speech.started"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      itemId: NonBlankStringSchema,
      type: Type.Literal("speech.stopped"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      delta: Type.String(),
      itemId: NonBlankStringSchema,
      type: Type.Literal("transcript.user.delta"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      itemId: NonBlankStringSchema,
      transcript: NonBlankStringSchema,
      type: Type.Literal("transcript.user.completed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: NonBlankStringSchema,
      itemId: NonBlankStringSchema,
      message: NonBlankStringSchema,
      type: Type.Literal("transcript.user.failed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      responseId: NonBlankStringSchema,
      type: Type.Literal("response.started"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      arguments: Type.String(),
      callId: NonBlankStringSchema,
      generation: Type.Integer({ minimum: 1 }),
      itemId: NonBlankStringSchema,
      name: NonBlankStringSchema,
      responseId: NonBlankStringSchema,
      type: Type.Literal("tool.call"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      delta: Type.String(),
      generation: Type.Integer({ minimum: 1 }),
      itemId: NonBlankStringSchema,
      outputIndex: Type.Integer({ minimum: 0 }),
      responseId: NonBlankStringSchema,
      type: Type.Literal("transcript.assistant.delta"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      itemId: NonBlankStringSchema,
      outputIndex: Type.Integer({ minimum: 0 }),
      responseId: NonBlankStringSchema,
      transcript: Type.String(),
      type: Type.Literal("transcript.assistant.done"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      itemId: NonBlankStringSchema,
      responseId: NonBlankStringSchema,
      type: Type.Literal("audio.started"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      itemId: Type.Optional(NonBlankStringSchema),
      responseId: Type.Optional(NonBlankStringSchema),
      type: Type.Literal("audio.stopped"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      hasAudio: Type.Boolean(),
      responseId: NonBlankStringSchema,
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("cancelled"),
        Type.Literal("failed"),
        Type.Literal("incomplete"),
      ]),
      statusReason: Type.Optional(Type.String()),
      type: Type.Literal("response.done"),
      usage: Type.Optional(
        Type.Object(voiceUsageProperties, { additionalProperties: false }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      audioEndMs: Type.Integer({ minimum: 0 }),
      itemId: NonBlankStringSchema,
      type: Type.Literal("item.truncated"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: NonBlankStringSchema,
      message: NonBlankStringSchema,
      type: Type.Literal("server.error"),
    },
    { additionalProperties: false },
  ),
]);

export const VoiceDriverEventRequestSchema = Type.Object(
  {
    event: VoiceDriverEventSchema,
    occurredAt: TimestampSchema,
    sessionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const VoiceClientCommandSchema = Type.Union([
  Type.Object(
    {
      enabled: Type.Boolean(),
      sessionId: EntityIdSchema,
      type: Type.Literal("capture.set"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      enabled: Type.Boolean(),
      sessionId: EntityIdSchema,
      type: Type.Literal("playback.set"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      instructions: NonBlankStringSchema,
      requestId: EntityIdSchema,
      sessionId: EntityIdSchema,
      tools: Type.Array(VoiceFunctionToolSchema),
      type: Type.Literal("session.refresh"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      instructions: NonBlankStringSchema,
      requestId: EntityIdSchema,
      sessionId: EntityIdSchema,
      type: Type.Literal("response.create"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      callId: NonBlankStringSchema,
      generation: Type.Integer({ minimum: 1 }),
      instructions: NonBlankStringSchema,
      output: NonBlankStringSchema,
      requestId: EntityIdSchema,
      sessionId: EntityIdSchema,
      type: Type.Literal("tool.result"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      generation: Type.Integer({ minimum: 1 }),
      responseId: Type.Optional(NonBlankStringSchema),
      sessionId: EntityIdSchema,
      type: Type.Literal("response.cancel"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      sessionId: EntityIdSchema,
      type: Type.Literal("session.close"),
    },
    { additionalProperties: false },
  ),
]);

export const VoiceEmptyRequestSchema = Type.Object(
  {},
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

export const VoiceStartResponseSchema = operationResponse(
  VoiceConnectionSchema,
);
export const VoiceQuickStartResponseSchema = VoiceStartResponseSchema;
export const VoicePreviewResponseSchema = operationResponse(
  VoicePreviewConnectionSchema,
);
export const VoicePauseResultSchema = Type.Object(
  {
    connection: Type.Optional(VoiceConnectionSchema),
    snapshot: VoiceSessionSnapshotSchema,
  },
  { additionalProperties: false },
);
export const VoicePauseResponseSchema = operationResponse(
  VoicePauseResultSchema,
);
export const VoiceMutationResponseSchema = operationResponse(
  Type.Union([VoiceSessionSnapshotSchema, Type.Null()]),
);
export const VoiceSnapshotResponseSchema = operationResponse(
  Type.Union([VoiceSessionSnapshotSchema, Type.Null()]),
);
