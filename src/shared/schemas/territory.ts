import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import { NonBlankStringSchema, TimestampSchema } from "./primitives";

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

export const TerritoryCatalogItemIdSchema = Type.Union([
  Type.Literal("cabin-hearth"),
  Type.Literal("cabin-desk"),
  Type.Literal("fern-pot"),
  Type.Literal("moss-rug"),
  Type.Literal("seaside-bed"),
  Type.Literal("shell-table"),
  Type.Literal("potted-palm"),
  Type.Literal("wave-rug"),
  Type.Literal("rooftop-bench"),
  Type.Literal("sunset-planter"),
  Type.Literal("brass-telescope"),
  Type.Literal("roof-lantern"),
  Type.Literal("star-workbench"),
  Type.Literal("astral-bookshelf"),
  Type.Literal("moon-crystal"),
  Type.Literal("constellation-rug"),
]);

export const TerritoryItemVisualSchema = TerritoryCatalogItemIdSchema;

export const TerritoryFacingSchema = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
]);

export const TerritoryRotationSchema = Type.Union([
  Type.Literal(0),
  Type.Literal(90),
  Type.Literal(180),
  Type.Literal(270),
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

export const TerritoryItemSchema = Type.Object(
  {
    blocksMovement: Type.Boolean(),
    catalogId: TerritoryCatalogItemIdSchema,
    description: NonBlankStringSchema,
    flipped: Type.Boolean(),
    flippable: Type.Boolean(),
    height: Type.Integer({ minimum: 1 }),
    id: TerritoryItemIdSchema,
    layer: Type.Integer({ minimum: 0 }),
    location: Type.Union([Type.Literal("scene"), Type.Literal("collection")]),
    name: NonBlankStringSchema,
    pinned: Type.Boolean(),
    placedAt: Type.Union([TimestampSchema, Type.Null()]),
    rotatable: Type.Boolean(),
    rotation: TerritoryRotationSchema,
    sceneId: Type.Union([TerritorySceneIdSchema, Type.Null()]),
    updatedAt: TimestampSchema,
    visual: TerritoryItemVisualSchema,
    width: Type.Integer({ minimum: 1 }),
    x: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    y: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
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

export const TerritorySnapshotSchema = Type.Object(
  {
    activeScene: Type.Union([TerritoryActiveSceneSchema, Type.Null()]),
    availableScenes: Type.Array(TerritorySceneSummarySchema, {
      maxItems: 4,
      minItems: 4,
    }),
    collection: Type.Array(TerritoryItemSchema),
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
    sceneId: TerritorySceneIdSchema,
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
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
