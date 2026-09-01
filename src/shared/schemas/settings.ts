import { Type, type TSchema } from "@sinclair/typebox";

import { ApprovalModeSchema } from "./run";
import { AppErrorSchema } from "./error";
import { EntityIdSchema, NonBlankStringSchema } from "./primitives";
import { VoiceInputModeSchema } from "./voice";

export const AgentSettingsSchema = Type.Object(
  {
    defaultApprovalMode: ApprovalModeSchema,
    defaultMode: Type.Union([Type.Literal("chat"), Type.Literal("agent")]),
    workingDirectory: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const PermissionStatusSchema = Type.Union([
  Type.Literal("granted"),
  Type.Literal("denied"),
  Type.Literal("not_determined"),
  Type.Literal("restricted"),
  Type.Literal("unavailable"),
]);

export const VoiceSettingsConfigSchema = Type.Object(
  {
    inputMode: VoiceInputModeSchema,
    providerProfileId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const VoiceSettingsSchema = Type.Object(
  {
    ...VoiceSettingsConfigSchema.properties,
    microphone: PermissionStatusSchema,
  },
  { additionalProperties: false },
);

export const CompanionInitiativeLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("quiet"),
  Type.Literal("balanced"),
  Type.Literal("lively"),
]);

export const QuietHoursSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    endMinute: Type.Integer({ maximum: 1_439, minimum: 0 }),
    startMinute: Type.Integer({ maximum: 1_439, minimum: 0 }),
  },
  { additionalProperties: false },
);

export const CompanionInitiativeSettingsSchema = Type.Object(
  {
    level: CompanionInitiativeLevelSchema,
    quietHours: QuietHoursSchema,
  },
  { additionalProperties: false },
);

export const BrowserComputerSettingsSchema = Type.Object(
  {
    accessibility: PermissionStatusSchema,
    browser: Type.Union([
      Type.Literal("ready"),
      Type.Literal("open"),
      Type.Literal("not_installed"),
    ]),
    profileDirectory: NonBlankStringSchema,
    screenRecording: PermissionStatusSchema,
  },
  { additionalProperties: false },
);

export const SettingsSnapshotSchema = Type.Object(
  {
    agent: AgentSettingsSchema,
    browserComputer: BrowserComputerSettingsSchema,
    companionInitiative: CompanionInitiativeSettingsSchema,
    voice: VoiceSettingsSchema,
  },
  { additionalProperties: false },
);

export const SettingsEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const DataUsageCategoryIdSchema = Type.Union([
  Type.Literal("database"),
  Type.Literal("artifacts"),
  Type.Literal("browser"),
  Type.Literal("activity"),
  Type.Literal("territory"),
  Type.Literal("pets"),
  Type.Literal("skills"),
  Type.Literal("application"),
]);

export const DataUsageCategorySchema = Type.Object(
  {
    byteLength: Type.Integer({ minimum: 0 }),
    id: DataUsageCategoryIdSchema,
    label: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const DataSettingsSnapshotSchema = Type.Object(
  {
    categories: Type.Array(DataUsageCategorySchema),
    dataDirectory: NonBlankStringSchema,
    totalByteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DataActionResultSchema = Type.Object(
  { message: NonBlankStringSchema },
  { additionalProperties: false },
);

export const AgentSettingsSaveRequestSchema = Type.Object(
  { agent: AgentSettingsSchema },
  { additionalProperties: false },
);

export const VoiceSettingsSaveRequestSchema = Type.Object(
  { voice: VoiceSettingsConfigSchema },
  { additionalProperties: false },
);

export const CompanionInitiativeSettingsSaveRequestSchema = Type.Object(
  { companionInitiative: CompanionInitiativeSettingsSchema },
  { additionalProperties: false },
);

export const BrowserActionResultSchema = Type.Object(
  {
    importedCookies: Type.Optional(Type.Integer({ minimum: 0 })),
    message: NonBlankStringSchema,
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

export const SettingsSnapshotResponseSchema = operationResponse(
  SettingsSnapshotSchema,
);
export const AgentSettingsSaveResponseSchema =
  operationResponse(AgentSettingsSchema);
export const CompanionInitiativeSettingsSaveResponseSchema = operationResponse(
  CompanionInitiativeSettingsSchema,
);
export const VoiceSettingsSaveResponseSchema =
  operationResponse(VoiceSettingsSchema);
export const BrowserActionResponseSchema = operationResponse(
  BrowserActionResultSchema,
);
export const DataSettingsSnapshotResponseSchema = operationResponse(
  DataSettingsSnapshotSchema,
);
export const DataActionResponseSchema = operationResponse(
  DataActionResultSchema,
);
