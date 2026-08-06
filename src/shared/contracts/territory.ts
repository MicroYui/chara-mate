import type { Static } from "@sinclair/typebox";

import type {
  TerritoryActiveSceneSchema,
  TerritoryCollectItemRequestSchema,
  TerritoryCollectionTargetSchema,
  TerritoryFacingSchema,
  TerritoryGroundTargetSchema,
  TerritoryInstallGeneratedItemInputSchema,
  TerritoryItemSchema,
  TerritoryItemTargetSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMoveResponseSchema,
  TerritoryMoveResultSchema,
  TerritoryPaletteSchema,
  TerritoryPlaceItemRequestSchema,
  TerritoryPointSchema,
  TerritoryRotationSchema,
  TerritorySceneDefinitionSchema,
  TerritorySceneIdSchema,
  TerritorySceneSummarySchema,
  TerritorySceneTargetSchema,
  TerritorySelectSceneRequestSchema,
  TerritorySnapshotResponseSchema,
  TerritorySnapshotSchema,
  TerritorySurfaceTargetSchema,
} from "../schemas/territory";

export const TERRITORY_CHANNELS = {
  collectItem: "territory.item.collect",
  getSnapshot: "territory.snapshot.get",
  movePet: "territory.pet.move",
  placeItem: "territory.item.place",
  selectScene: "territory.scene.select",
} as const;

export type TerritorySceneId = Static<typeof TerritorySceneIdSchema>;
export type TerritoryFacing = Static<typeof TerritoryFacingSchema>;
export type TerritoryRotation = Static<typeof TerritoryRotationSchema>;
export type TerritoryPoint = Static<typeof TerritoryPointSchema>;
export type TerritoryPalette = Static<typeof TerritoryPaletteSchema>;
export type TerritorySceneSummary = Static<typeof TerritorySceneSummarySchema>;
export type TerritorySceneDefinition = Static<
  typeof TerritorySceneDefinitionSchema
>;
export type TerritoryCollectionTarget = Static<
  typeof TerritoryCollectionTargetSchema
>;
export type TerritoryGroundTarget = Static<typeof TerritoryGroundTargetSchema>;
export type TerritorySurfaceTarget = Static<
  typeof TerritorySurfaceTargetSchema
>;
export type TerritorySceneTarget = Static<typeof TerritorySceneTargetSchema>;
export type TerritoryItemTarget = Static<typeof TerritoryItemTargetSchema>;
export type TerritoryItem = Static<typeof TerritoryItemSchema>;
export type TerritoryActiveScene = Static<typeof TerritoryActiveSceneSchema>;
export type TerritorySnapshot = Static<typeof TerritorySnapshotSchema>;
export type TerritorySelectSceneRequest = Static<
  typeof TerritorySelectSceneRequestSchema
>;
export type TerritoryMovePetRequest = Static<
  typeof TerritoryMovePetRequestSchema
>;
export type TerritoryPlaceItemRequest = Static<
  typeof TerritoryPlaceItemRequestSchema
>;
export type TerritoryCollectItemRequest = Static<
  typeof TerritoryCollectItemRequestSchema
>;
export type TerritoryInstallGeneratedItemInput = Static<
  typeof TerritoryInstallGeneratedItemInputSchema
>;
export type TerritorySnapshotResponse = Static<
  typeof TerritorySnapshotResponseSchema
>;
export type TerritoryMoveResult = Static<typeof TerritoryMoveResultSchema>;
export type TerritoryMoveResponse = Static<typeof TerritoryMoveResponseSchema>;

export interface TerritoryApi {
  collectItem(
    request: TerritoryCollectItemRequest,
  ): Promise<TerritorySnapshotResponse>;
  getSnapshot(): Promise<TerritorySnapshotResponse>;
  movePet(request: TerritoryMovePetRequest): Promise<TerritoryMoveResponse>;
  placeItem(
    request: TerritoryPlaceItemRequest,
  ): Promise<TerritorySnapshotResponse>;
  selectScene(
    request: TerritorySelectSceneRequest,
  ): Promise<TerritorySnapshotResponse>;
}
