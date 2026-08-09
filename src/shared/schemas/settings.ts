import { Type, type TSchema } from "@sinclair/typebox";

import { ApprovalModeSchema } from "./run";
import { AppErrorSchema } from "./error";
import { EntityIdSchema, NonBlankStringSchema } from "./primitives";
import { VoiceInputModeSchema, VoiceNameSchema } from "./voice";

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
    instructions: NonBlankStringSchema,
    providerProfileId: EntityIdSchema,
    voice: VoiceNameSchema,
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
    voice: VoiceSettingsSchema,
  },
  { additionalProperties: false },
);

export const SettingsEmptyRequestSchema = Type.Object(
  {},
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
export const VoiceSettingsSaveResponseSchema =
  operationResponse(VoiceSettingsSchema);
export const BrowserActionResponseSchema = operationResponse(
  BrowserActionResultSchema,
);
