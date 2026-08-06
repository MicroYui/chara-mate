import { Type } from "@sinclair/typebox";

import { NonBlankStringSchema } from "./primitives";
import { TerritoryRotationSchema } from "./territoryPrimitives";

const structuredIdSchema = Type.String({
  maxLength: 96,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
});

const slotIdSchema = Type.String({
  maxLength: 48,
  pattern: "^[a-z][a-z0-9-]*$",
});

export const TerritorySurfaceKindSchema = Type.Literal("tabletop");

export const TerritoryGroundPlaneSchema = Type.Union([
  Type.Literal("underlay"),
  Type.Literal("object"),
]);

export const TerritoryPixelPointSchema = Type.Object(
  {
    x: Type.Integer(),
    y: Type.Integer(),
  },
  { additionalProperties: false },
);

export const TerritoryGridCellSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerritoryPositiveSizeSchema = Type.Object(
  {
    height: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritorySurfaceSlotSchema = Type.Object(
  {
    anchorPx: TerritoryPixelPointSchema,
    id: slotIdSchema,
    kind: TerritorySurfaceKindSchema,
    maxItemSizePx: TerritoryPositiveSizeSchema,
  },
  { additionalProperties: false },
);

const territoryVisualSourceSchema = Type.Union([
  Type.Object(
    {
      key: structuredIdSchema,
      kind: Type.Literal("builtin"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      assetId: structuredIdSchema,
      kind: Type.Literal("asset"),
    },
    { additionalProperties: false },
  ),
]);

const territoryGroundPlacementSchema = Type.Object(
  {
    collisionCells: Type.Array(TerritoryGridCellSchema, {
      uniqueItems: true,
    }),
    depthAnchorPx: TerritoryPixelPointSchema,
    gridSize: TerritoryPositiveSizeSchema,
    mode: Type.Literal("ground"),
    occupancyCells: Type.Array(TerritoryGridCellSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    plane: TerritoryGroundPlaneSchema,
  },
  { additionalProperties: false },
);

const territorySurfacePlacementSchema = Type.Object(
  {
    allowedSurfaceKinds: Type.Array(TerritorySurfaceKindSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    attachmentAnchorPx: TerritoryPixelPointSchema,
    mode: Type.Literal("surface"),
  },
  { additionalProperties: false },
);

export const TerritoryItemManifestV1Schema = Type.Object(
  {
    definitionId: structuredIdSchema,
    description: NonBlankStringSchema,
    name: NonBlankStringSchema,
    placement: Type.Union([
      territoryGroundPlacementSchema,
      territorySurfacePlacementSchema,
    ]),
    revision: Type.Integer({ minimum: 1 }),
    schemaVersion: Type.Literal(1),
    surfaceSlots: Type.Array(TerritorySurfaceSlotSchema, {
      uniqueItems: true,
    }),
    transforms: Type.Object(
      {
        flippable: Type.Boolean(),
        rotations: Type.Array(TerritoryRotationSchema, {
          maxItems: 4,
          minItems: 1,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    visual: Type.Object(
      {
        sizePx: TerritoryPositiveSizeSchema,
        source: territoryVisualSourceSchema,
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
  },
);
