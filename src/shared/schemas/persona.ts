import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import { EntityIdSchema, TimestampSchema } from "./primitives";

export const PersonaVoiceSchema = Type.Union([
  Type.Literal("alloy"),
  Type.Literal("ash"),
  Type.Literal("ballad"),
  Type.Literal("coral"),
  Type.Literal("echo"),
  Type.Literal("sage"),
  Type.Literal("shimmer"),
  Type.Literal("verse"),
]);

const shortText = Type.String({ maxLength: 120, minLength: 1 });
const paragraph = Type.String({ maxLength: 2_000, minLength: 1 });

export const PersonaRevisionInputSchema = Type.Object(
  {
    addressStyle: paragraph,
    background: paragraph,
    defaultVoice: PersonaVoiceSchema,
    disabledExpressions: Type.Array(
      Type.String({ maxLength: 80, minLength: 1 }),
      { maxItems: 24, uniqueItems: true },
    ),
    displayName: shortText,
    identity: paragraph,
    initiativeStyle: paragraph,
    knowledgeBoundary: paragraph,
    motivations: paragraph,
    speechStyle: paragraph,
    styleName: shortText,
    values: paragraph,
    voiceInstructions: Type.String({ maxLength: 4_000, minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PersonaSnapshotSchema = Type.Object(
  {
    ...PersonaRevisionInputSchema.properties,
    personaId: EntityIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    revisionCreatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const PersonaKindSchema = Type.Union([
  Type.Literal("preset"),
  Type.Literal("custom"),
]);

export const PersonaRecordSchema = Type.Object(
  {
    createdAt: TimestampSchema,
    kind: PersonaKindSchema,
    snapshot: PersonaSnapshotSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const PersonaLibrarySnapshotSchema = Type.Object(
  {
    activePersonaId: EntityIdSchema,
    personas: Type.Array(PersonaRecordSchema),
  },
  { additionalProperties: false },
);

export const PersonaEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const PersonaCopyRequestSchema = Type.Object(
  {
    displayName: shortText,
    sourcePersonaId: EntityIdSchema,
    styleName: shortText,
  },
  { additionalProperties: false },
);

export const PersonaSelectRequestSchema = Type.Object(
  { personaId: EntityIdSchema },
  { additionalProperties: false },
);

export const PersonaUpdateRequestSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    personaId: EntityIdSchema,
    value: PersonaRevisionInputSchema,
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

export const PersonaLibraryResponseSchema = operationResponse(
  PersonaLibrarySnapshotSchema,
);
