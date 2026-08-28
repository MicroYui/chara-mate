import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import { PermissionStatusSchema } from "./settings";

export const VoiceWakePhaseSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("arming"),
  Type.Literal("listening"),
  Type.Literal("detected"),
  Type.Literal("connecting"),
  Type.Literal("voice_active"),
  Type.Literal("suspended"),
  Type.Literal("error"),
]);

export const VoiceWakeReportedPhaseSchema = Type.Union([
  Type.Literal("arming"),
  Type.Literal("listening"),
  Type.Literal("detected"),
  Type.Literal("connecting"),
  Type.Literal("error"),
]);

export const VoiceWakeSnapshotSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    error: Type.Optional(Type.String()),
    microphone: PermissionStatusSchema,
    phase: VoiceWakePhaseSchema,
    phrase: Type.Literal("Hi Mika"),
  },
  { additionalProperties: false },
);

export const VoiceWakeEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const VoiceWakeSetEnabledRequestSchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

export const VoiceWakeReportRequestSchema = Type.Object(
  {
    error: Type.Optional(Type.String()),
    phase: VoiceWakeReportedPhaseSchema,
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

export const VoiceWakeSnapshotResponseSchema = operationResponse(
  VoiceWakeSnapshotSchema,
);
