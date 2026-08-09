import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";
import {
  TerritoryItemManifestV1Schema,
  TerritoryPixelPointSchema,
  TerritoryPositiveSizeSchema,
} from "./territoryItemManifest";
import { TerritoryRotationSchema } from "./territoryPrimitives";

export { TerritoryRotationSchema } from "./territoryPrimitives";

export const TerritorySceneIdSchema = Type.Union([
  Type.Literal("forest-cabin"),
  Type.Literal("seaside-room"),
  Type.Literal("city-rooftop"),
  Type.Literal("star-workshop"),
]);

export const TerritoryItemIdSchema = Type.String({
  maxLength: 96,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
});

export const TerritoryFacingSchema = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
]);

export const TerritoryPointSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerritoryPaletteSchema = Type.Object(
  {
    accent: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    ambient: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    floor: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    floorAlt: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    shadow: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    sky: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
    wall: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  },
  { additionalProperties: false },
);

export const TerritorySceneSummarySchema = Type.Object(
  {
    description: NonBlankStringSchema,
    id: TerritorySceneIdSchema,
    name: NonBlankStringSchema,
    palette: TerritoryPaletteSchema,
    poem: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

const gridRowSchema = Type.String({ pattern: "^[01]{16}$" });

export const TerritorySceneDefinitionSchema = Type.Object(
  {
    description: NonBlankStringSchema,
    entry: TerritoryPointSchema,
    height: Type.Literal(10),
    id: TerritorySceneIdSchema,
    name: NonBlankStringSchema,
    palette: TerritoryPaletteSchema,
    placeableRows: Type.Array(gridRowSchema, {
      maxItems: 10,
      minItems: 10,
    }),
    poem: NonBlankStringSchema,
    walkableRows: Type.Array(gridRowSchema, {
      maxItems: 10,
      minItems: 10,
    }),
    width: Type.Literal(16),
  },
  { additionalProperties: false },
);

export const TerritoryCollectionTargetSchema = Type.Object(
  { kind: Type.Literal("collection") },
  { additionalProperties: false },
);

export const TerritoryGroundTargetSchema = Type.Object(
  {
    kind: Type.Literal("ground"),
    sceneId: TerritorySceneIdSchema,
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerritorySurfaceTargetSchema = Type.Object(
  {
    kind: Type.Literal("surface"),
    sceneId: TerritorySceneIdSchema,
    slotId: Type.String({
      maxLength: 48,
      pattern: "^[a-z][a-z0-9-]*$",
    }),
    supportItemId: TerritoryItemIdSchema,
  },
  { additionalProperties: false },
);

export const TerritorySceneTargetSchema = Type.Union([
  TerritoryGroundTargetSchema,
  TerritorySurfaceTargetSchema,
]);

export const TerritoryItemTargetSchema = Type.Union([
  TerritoryCollectionTargetSchema,
  TerritoryGroundTargetSchema,
  TerritorySurfaceTargetSchema,
]);

export const TerritoryItemSchema = Type.Object(
  {
    flipped: Type.Boolean(),
    id: TerritoryItemIdSchema,
    manifest: TerritoryItemManifestV1Schema,
    pinned: Type.Boolean(),
    placedAt: Type.Union([TimestampSchema, Type.Null()]),
    rotation: TerritoryRotationSchema,
    target: TerritoryItemTargetSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const TerritoryPetStateSchema = Type.Object(
  {
    facing: TerritoryFacingSchema,
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerritoryActiveSceneSchema = Type.Object(
  {
    definition: TerritorySceneDefinitionSchema,
    pet: TerritoryPetStateSchema,
    placements: Type.Array(TerritoryItemSchema),
  },
  { additionalProperties: false },
);

export const TerritoryImageCandidateOperationSchema = Type.Union([
  Type.Literal("generate"),
  Type.Literal("edit"),
]);

export const TerritoryImageCandidateStatusSchema = Type.Union([
  Type.Literal("generating"),
  Type.Literal("ready"),
  Type.Literal("failed"),
  Type.Literal("accepted"),
]);

export const TerritoryGeneratedItemStructureSchema = Type.Object(
  {
    attachmentAnchorPx: Type.Optional(TerritoryPixelPointSchema),
    depthAnchorPx: Type.Optional(TerritoryPixelPointSchema),
    flippable: Type.Optional(Type.Boolean()),
    footprintTiles: Type.Optional(TerritoryPositiveSizeSchema),
    placement: Type.Optional(
      Type.Union([
        Type.Literal("ground_object"),
        Type.Literal("ground_underlay"),
        Type.Literal("surface"),
      ]),
    ),
    rotations: Type.Optional(
      Type.Array(TerritoryRotationSchema, {
        maxItems: 4,
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    surfaceSlots: Type.Optional(
      Type.Array(
        Type.Object(
          {
            anchorPx: TerritoryPixelPointSchema,
            id: Type.String({
              maxLength: 48,
              pattern: "^[a-z][a-z0-9-]*$",
            }),
            maxItemSizePx: TerritoryPositiveSizeSchema,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    visualSizePx: Type.Optional(TerritoryPositiveSizeSchema),
  },
  { additionalProperties: false },
);

export const TerritoryImageCandidateContentSchema = Type.Object(
  {
    description: NonBlankStringSchema,
    editInstruction: Type.Union([NonBlankStringSchema, Type.Null()]),
    name: NonBlankStringSchema,
    structure: Type.Union([TerritoryGeneratedItemStructureSchema, Type.Null()]),
    visualPrompt: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const TerritoryImageCandidateSchema = Type.Object(
  {
    acceptedItemId: Type.Union([TerritoryItemIdSchema, Type.Null()]),
    createdAt: TimestampSchema,
    ...TerritoryImageCandidateContentSchema.properties,
    error: Type.Union([AppErrorSchema, Type.Null()]),
    id: EntityIdSchema,
    operation: TerritoryImageCandidateOperationSchema,
    providerProfileId: EntityIdSchema,
    sceneId: TerritorySceneIdSchema,
    sourceCandidateId: Type.Union([EntityIdSchema, Type.Null()]),
    status: TerritoryImageCandidateStatusSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const TerritorySnapshotSchema = Type.Object(
  {
    activeScene: Type.Union([TerritoryActiveSceneSchema, Type.Null()]),
    availableScenes: Type.Array(TerritorySceneSummarySchema, {
      maxItems: 4,
      minItems: 4,
    }),
    collection: Type.Array(TerritoryItemSchema),
    imageCandidates: Type.Array(TerritoryImageCandidateSchema),
  },
  { additionalProperties: false },
);

export const TerritoryEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const TerritorySelectSceneRequestSchema = Type.Object(
  { sceneId: TerritorySceneIdSchema },
  { additionalProperties: false },
);

export const TerritoryMovePetRequestSchema = Type.Object(
  {
    from: TerritoryPointSchema,
    sceneId: TerritorySceneIdSchema,
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerritoryPlaceItemRequestSchema = Type.Object(
  {
    flipped: Type.Boolean(),
    itemId: TerritoryItemIdSchema,
    rotation: TerritoryRotationSchema,
    target: TerritorySceneTargetSchema,
  },
  { additionalProperties: false },
);

export const TerritoryCollectItemRequestSchema = Type.Object(
  {
    itemId: TerritoryItemIdSchema,
    sceneId: TerritorySceneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryGenerateImageRequestSchema = Type.Object(
  {
    description: NonBlankStringSchema,
    name: NonBlankStringSchema,
    providerProfileId: EntityIdSchema,
    sceneId: TerritorySceneIdSchema,
    structure: Type.Optional(TerritoryGeneratedItemStructureSchema),
    visualPrompt: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const TerritoryEditImageRequestSchema = Type.Object(
  {
    candidateId: EntityIdSchema,
    instruction: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const TerritoryImageCandidateIdRequestSchema = Type.Object(
  { candidateId: EntityIdSchema },
  { additionalProperties: false },
);

export const TerritoryInstallGeneratedItemInputSchema = Type.Object(
  {
    itemId: TerritoryItemIdSchema,
    manifest: TerritoryItemManifestV1Schema,
    sourceImagePath: Type.String({ maxLength: 4096, minLength: 1 }),
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

export const TerritorySnapshotResponseSchema = operationResponse(
  TerritorySnapshotSchema,
);

export const TerritoryImageMutationResultSchema = Type.Object(
  {
    candidateId: EntityIdSchema,
    snapshot: TerritorySnapshotSchema,
  },
  { additionalProperties: false },
);

export const TerritoryImageMutationResponseSchema = operationResponse(
  TerritoryImageMutationResultSchema,
);

export const TerritoryMoveResultSchema = Type.Object(
  {
    path: Type.Array(TerritoryPointSchema, { minItems: 1 }),
    snapshot: TerritorySnapshotSchema,
  },
  { additionalProperties: false },
);

export const TerritoryMoveResponseSchema = operationResponse(
  TerritoryMoveResultSchema,
);
