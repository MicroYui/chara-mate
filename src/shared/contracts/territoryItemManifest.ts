import type { Static } from "@sinclair/typebox";

import type {
  TerritoryGridCellSchema,
  TerritoryGroundPlaneSchema,
  TerritoryItemManifestV1Schema,
  TerritoryPixelPointSchema,
  TerritoryPositiveSizeSchema,
  TerritorySurfaceKindSchema,
  TerritorySurfaceSlotSchema,
} from "../schemas/territoryItemManifest";

export type TerritorySurfaceKind = Static<typeof TerritorySurfaceKindSchema>;
export type TerritoryGroundPlane = Static<typeof TerritoryGroundPlaneSchema>;
export type TerritoryPixelPoint = Static<typeof TerritoryPixelPointSchema>;
export type TerritoryGridCell = Static<typeof TerritoryGridCellSchema>;
export type TerritoryPositiveSize = Static<typeof TerritoryPositiveSizeSchema>;
export type TerritorySurfaceSlot = Static<typeof TerritorySurfaceSlotSchema>;
export type TerritoryItemManifestV1 = Static<
  typeof TerritoryItemManifestV1Schema
>;
