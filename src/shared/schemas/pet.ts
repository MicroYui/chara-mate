import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

export const PetIdSchema = Type.String({
  maxLength: 64,
  pattern: "^[a-z0-9](?:[a-z0-9._-]{0,63})$",
});

export const PetSpriteVersionSchema = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
]);

export const PetFacingSchema = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
]);

export const PetAnimationSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running-right"),
  Type.Literal("running-left"),
  Type.Literal("waving"),
  Type.Literal("jumping"),
  Type.Literal("failed"),
  Type.Literal("waiting"),
  Type.Literal("running"),
  Type.Literal("review"),
  Type.Literal("look"),
]);

const petManifestProperties = {
  description: NonBlankStringSchema,
  displayName: NonBlankStringSchema,
  id: PetIdSchema,
  spritesheetPath: Type.String({
    minLength: 1,
    pattern: "^[^\\0]+\\.(?:png|webp)$",
  }),
};

export const CodexPetManifestSchema = Type.Object(
  {
    ...petManifestProperties,
    spriteVersionNumber: Type.Optional(PetSpriteVersionSchema),
  },
  { additionalProperties: false },
);

export const PetManifestSchema = Type.Object(
  {
    ...petManifestProperties,
    spriteVersionNumber: PetSpriteVersionSchema,
  },
  { additionalProperties: false },
);

export const PetDescriptorSchema = Type.Object(
  {
    description: NonBlankStringSchema,
    displayName: NonBlankStringSchema,
    id: PetIdSchema,
    spriteHeight: Type.Integer({ minimum: 1 }),
    spriteUrl: Type.String({ pattern: "^chara-mate-pet://" }),
    spriteVersionNumber: PetSpriteVersionSchema,
    spriteWidth: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const PetLibrarySnapshotSchema = Type.Object(
  {
    activePetId: Type.Union([PetIdSchema, Type.Null()]),
    animationSpeed: Type.Number({ maximum: 1.5, minimum: 0.1 }),
    pets: Type.Array(PetDescriptorSchema),
    scale: Type.Number({ maximum: 1.5, minimum: 0.3 }),
  },
  { additionalProperties: false },
);

export const PetCharacterSnapshotSchema = Type.Object(
  {
    activePet: Type.Union([PetDescriptorSchema, Type.Null()]),
    animation: PetAnimationSchema,
    animationSpeed: Type.Number({ maximum: 1.5, minimum: 0.1 }),
    facing: PetFacingSchema,
    scale: Type.Number({ maximum: 1.5, minimum: 0.3 }),
  },
  { additionalProperties: false },
);

export const PetEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const PetMainTargetSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("character"),
]);

export const PetMainNavigationSchema = Type.Object(
  { target: PetMainTargetSchema },
  { additionalProperties: false },
);

export const PetConversationNavigationSchema = Type.Object(
  {
    bubbleId: Type.Optional(EntityIdSchema),
    chatId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const ProactiveConversationBubbleReplyStateSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("responding"),
  Type.Literal("failed"),
]);

export const ProactiveConversationBubbleKindSchema = Type.Union([
  Type.Literal("invitation"),
  Type.Literal("continuation"),
]);

export const ProactiveConversationBubbleSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    content: NonBlankStringSchema,
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    journeyId: Type.Optional(EntityIdSchema),
    kind: ProactiveConversationBubbleKindSchema,
    replyState: ProactiveConversationBubbleReplyStateSchema,
  },
  { additionalProperties: false },
);

export const ProactiveConversationBubbleEventSchema = Type.Union([
  ProactiveConversationBubbleSchema,
  Type.Null(),
]);

export const ProactiveConversationBubbleDismissRequestSchema = Type.Object(
  { bubbleId: EntityIdSchema },
  { additionalProperties: false },
);

export const ProactiveConversationBubbleReplyRequestSchema = Type.Object(
  {
    bubbleId: EntityIdSchema,
    content: NonBlankStringSchema,
    requestedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const PetSelectRequestSchema = Type.Object(
  { petId: PetIdSchema },
  { additionalProperties: false },
);

export const PetScaleRequestSchema = Type.Object(
  { scale: Type.Number({ maximum: 1.5, minimum: 0.3 }) },
  { additionalProperties: false },
);

export const PetAnimationSpeedRequestSchema = Type.Object(
  { animationSpeed: Type.Number({ maximum: 1.5, minimum: 0.1 }) },
  { additionalProperties: false },
);

export const PetDragPointSchema = Type.Object(
  {
    screenX: Type.Number({ maximum: 1_000_000, minimum: -1_000_000 }),
    screenY: Type.Number({ maximum: 1_000_000, minimum: -1_000_000 }),
  },
  { additionalProperties: false },
);

export const PetDragResultSchema = Type.Object(
  { moved: Type.Boolean() },
  { additionalProperties: false },
);

export const PetStoredStateSchema = Type.Object(
  {
    activePetId: Type.Union([PetIdSchema, Type.Null()]),
    animationSpeed: Type.Number({ maximum: 1.5, minimum: 0.1 }),
    displayId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    facing: PetFacingSchema,
    height: Type.Integer({ minimum: 1 }),
    offsetX: Type.Integer(),
    offsetY: Type.Integer(),
    scale: Type.Number({ maximum: 1.5, minimum: 0.3 }),
    updatedAt: TimestampSchema,
    width: Type.Integer({ minimum: 1 }),
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

export const PetLibraryResponseSchema = operationResponse(
  PetLibrarySnapshotSchema,
);
export const PetImportResponseSchema = operationResponse(
  Type.Union([PetDescriptorSchema, Type.Null()]),
);
export const ProactiveConversationBubbleReplyResponseSchema = operationResponse(
  Type.Object({ runId: EntityIdSchema }, { additionalProperties: false }),
);
