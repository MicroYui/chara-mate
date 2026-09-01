import { Type, type TProperties, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
  TimeZoneIdSchema,
} from "./primitives";
import { RunExecutionSchema } from "./run";
import { PersonaSnapshotSchema } from "./persona";
import { ToolDescriptorSchema } from "./tool";

export const AutomationLocalTimeSchema = Type.String({
  description: "A local wall-clock time in 24-hour HH:mm form.",
  pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
});

export const AutomationCronExpressionSchema = Type.String({
  description:
    "Five POSIX scheduling fields: minute, hour, day of month, month, day of week.",
  pattern: "^[^\\s]+(?:[ \\t]+[^\\s]+){4}$",
});

export const AutomationScheduleSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("once"),
      runAt: TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("daily"),
      localTime: AutomationLocalTimeSchema,
      timeZone: TimeZoneIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("weekly"),
      localTime: AutomationLocalTimeSchema,
      timeZone: TimeZoneIdSchema,
      weekdays: Type.Array(
        Type.Integer({
          description: "ISO weekday: Monday is 1 and Sunday is 7.",
          maximum: 7,
          minimum: 1,
        }),
        {
          minItems: 1,
          uniqueItems: true,
        },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      dialect: Type.Literal("posix-5-field"),
      expression: AutomationCronExpressionSchema,
      kind: Type.Literal("cron"),
      timeZone: TimeZoneIdSchema,
    },
    { additionalProperties: false },
  ),
]);

export const AutomationToolScopeSchema = Type.Union([
  Type.Object(
    { mode: Type.Literal("all_allowed") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("selected"),
      toolNames: Type.Array(ToolDescriptorSchema.properties.name, {
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
]);

export const AutomationTaskKindSchema = Type.Union([
  Type.Literal("reminder"),
  Type.Literal("agent_task"),
]);

export const AutomationTaskSchema = Type.Union([
  Type.Object(
    {
      delivery: Type.Union([
        Type.Literal("bubble"),
        Type.Literal("bubble_and_voice"),
      ]),
      kind: Type.Literal("reminder"),
      message: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      execution: RunExecutionSchema,
      goal: NonBlankStringSchema,
      kind: Type.Literal("agent_task"),
      delivery: Type.Optional(Type.Literal("assistant_message")),
      modelId: NonBlankStringSchema,
      personaId: EntityIdSchema,
      providerProfileId: EntityIdSchema,
      targetChatId: Type.Optional(EntityIdSchema),
      toolScope: AutomationToolScopeSchema,
    },
    { additionalProperties: false },
  ),
]);

export const AutomationDefinitionSchema = Type.Object(
  {
    name: NonBlankStringSchema,
    schedule: AutomationScheduleSchema,
    task: AutomationTaskSchema,
  },
  { additionalProperties: false },
);

const automationRecordProperties = {
  createdAt: TimestampSchema,
  definition: AutomationDefinitionSchema,
  id: EntityIdSchema,
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: TimestampSchema,
};

export const AutomationSchema = Type.Union([
  Type.Object(
    {
      ...automationRecordProperties,
      nextRunAt: TimestampSchema,
      state: Type.Literal("active"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...automationRecordProperties,
      state: Type.Literal("paused"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...automationRecordProperties,
      state: Type.Literal("completed"),
    },
    { additionalProperties: false },
  ),
]);

export const AutomationRunTriggerSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("scheduled"),
      scheduledFor: TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("manual") },
    { additionalProperties: false },
  ),
]);

const automationRunRecordProperties = {
  automationId: EntityIdSchema,
  automationRevision: Type.Integer({ minimum: 1 }),
  createdAt: TimestampSchema,
  definition: AutomationDefinitionSchema,
  id: EntityIdSchema,
  persona: PersonaSnapshotSchema,
  requestedAt: TimestampSchema,
  summary: Type.Optional(Type.String()),
  trigger: AutomationRunTriggerSchema,
  updatedAt: TimestampSchema,
};

function automationRunStateSchema<TState extends TProperties>(state: TState) {
  return Type.Union([
    Type.Object(
      { ...automationRunRecordProperties, ...state },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...automationRunRecordProperties, chatId: EntityIdSchema, ...state },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...automationRunRecordProperties,
        chatId: EntityIdSchema,
        runId: EntityIdSchema,
        ...state,
      },
      { additionalProperties: false },
    ),
  ]);
}

export const AutomationRunSchema = Type.Union([
  automationRunStateSchema({ status: Type.Literal("queued") }),
  automationRunStateSchema({
    startedAt: TimestampSchema,
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("waiting_approval"),
      Type.Literal("needs_input"),
    ]),
  }),
  automationRunStateSchema({
    endedAt: TimestampSchema,
    startedAt: TimestampSchema,
    status: Type.Union([
      Type.Literal("interrupted"),
      Type.Literal("completed"),
      Type.Literal("cancelled"),
    ]),
  }),
  automationRunStateSchema({
    endedAt: TimestampSchema,
    error: AppErrorSchema,
    startedAt: TimestampSchema,
    status: Type.Literal("failed"),
  }),
]);

export const AutomationFinishedStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const automationRunFinishedEventProperties = {
  automationId: EntityIdSchema,
  automationRevision: Type.Integer({ minimum: 1 }),
  automationRunId: EntityIdSchema,
  chatId: Type.Optional(EntityIdSchema),
  definition: AutomationDefinitionSchema,
  runId: Type.Optional(EntityIdSchema),
  summary: Type.Optional(Type.String()),
  type: Type.Literal("automation.run.finished"),
};

export const AutomationEventSchema = Type.Union([
  Type.Object(
    {
      automation: AutomationSchema,
      type: Type.Literal("automation.changed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      run: AutomationRunSchema,
      type: Type.Literal("automation.run.changed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...automationRunFinishedEventProperties,
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("cancelled"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...automationRunFinishedEventProperties,
      error: AppErrorSchema,
      status: Type.Literal("failed"),
    },
    { additionalProperties: false },
  ),
]);

export const AutomationEventEnvelopeSchema = Type.Object(
  {
    event: AutomationEventSchema,
    eventId: EntityIdSchema,
    occurredAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const AutomationListItemSchema = Type.Object(
  {
    automation: AutomationSchema,
    recentRun: Type.Optional(AutomationRunSchema),
  },
  { additionalProperties: false },
);

export const AutomationListSnapshotSchema = Type.Object(
  { items: Type.Array(AutomationListItemSchema) },
  { additionalProperties: false },
);

export const AutomationDetailSchema = Type.Object(
  {
    automation: AutomationSchema,
    runs: Type.Array(AutomationRunSchema),
  },
  { additionalProperties: false },
);

export const AutomationEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const AutomationIdRequestSchema = Type.Object(
  { automationId: EntityIdSchema },
  { additionalProperties: false },
);

export const AutomationCreateRequestSchema = Type.Object(
  {
    definition: AutomationDefinitionSchema,
    requestedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const AutomationUpdateRequestSchema = Type.Object(
  {
    automationId: EntityIdSchema,
    definition: AutomationDefinitionSchema,
    expectedRevision: Type.Integer({ minimum: 1 }),
    requestedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const AutomationSetPausedRequestSchema = Type.Object(
  {
    automationId: EntityIdSchema,
    expectedRevision: Type.Integer({ minimum: 1 }),
    paused: Type.Boolean(),
    requestedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const AutomationRunNowRequestSchema = Type.Object(
  {
    automationId: EntityIdSchema,
    requestedAt: TimestampSchema,
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

export const AutomationListResponseSchema = operationResponse(
  AutomationListSnapshotSchema,
);
export const AutomationDetailResponseSchema = operationResponse(
  AutomationDetailSchema,
);
export const AutomationMutationResponseSchema =
  operationResponse(AutomationSchema);
export const AutomationRunNowResponseSchema =
  operationResponse(AutomationRunSchema);
