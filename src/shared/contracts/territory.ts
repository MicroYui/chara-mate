import type { Static } from "@sinclair/typebox";

import type {
  TerritoryActiveSceneSchema,
  TerritoryCollectItemRequestSchema,
  TerritoryCollectionTargetSchema,
  TerritoryFacingSchema,
  TerritoryGeneratedItemStructureSchema,
  TerritoryEditImageRequestSchema,
  TerritoryGenerateImageRequestSchema,
  TerritoryGroundTargetSchema,
  TerritoryImageCandidateIdRequestSchema,
  TerritoryImageCandidateOperationSchema,
  TerritoryImageCandidateSchema,
  TerritoryImageCandidateStatusSchema,
  TerritoryImageMutationResponseSchema,
  TerritoryImageMutationResultSchema,
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
  confirmImageCandidate: "territory.image.confirm",
  editImageCandidate: "territory.image.edit",
  generateImageCandidate: "territory.image.generate",
  getSnapshot: "territory.snapshot.get",
  movePet: "territory.pet.move",
  placeItem: "territory.item.place",
  retryImageCandidate: "territory.image.retry",
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
export type TerritoryImageCandidateOperation = Static<
  typeof TerritoryImageCandidateOperationSchema
>;
export type TerritoryImageCandidateStatus = Static<
  typeof TerritoryImageCandidateStatusSchema
>;
export type TerritoryGeneratedItemStructure = Static<
  typeof TerritoryGeneratedItemStructureSchema
>;
export type TerritoryImageCandidate = Static<
  typeof TerritoryImageCandidateSchema
>;
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
export type TerritoryGenerateImageRequest = Static<
  typeof TerritoryGenerateImageRequestSchema
>;
export type TerritoryEditImageRequest = Static<
  typeof TerritoryEditImageRequestSchema
>;
export type TerritoryImageCandidateIdRequest = Static<
  typeof TerritoryImageCandidateIdRequestSchema
>;
export type TerritoryInstallGeneratedItemInput = Static<
  typeof TerritoryInstallGeneratedItemInputSchema
>;
export type TerritorySnapshotResponse = Static<
  typeof TerritorySnapshotResponseSchema
>;
export type TerritoryMoveResult = Static<typeof TerritoryMoveResultSchema>;
export type TerritoryMoveResponse = Static<typeof TerritoryMoveResponseSchema>;
export type TerritoryImageMutationResult = Static<
  typeof TerritoryImageMutationResultSchema
>;
export type TerritoryImageMutationResponse = Static<
  typeof TerritoryImageMutationResponseSchema
>;

export interface TerritoryApi {
  collectItem(
    request: TerritoryCollectItemRequest,
  ): Promise<TerritorySnapshotResponse>;
  confirmImageCandidate(
    request: TerritoryImageCandidateIdRequest,
  ): Promise<TerritoryImageMutationResponse>;
  editImageCandidate(
    request: TerritoryEditImageRequest,
  ): Promise<TerritoryImageMutationResponse>;
  generateImageCandidate(
    request: TerritoryGenerateImageRequest,
  ): Promise<TerritoryImageMutationResponse>;
  getSnapshot(): Promise<TerritorySnapshotResponse>;
  movePet(request: TerritoryMovePetRequest): Promise<TerritoryMoveResponse>;
  placeItem(
    request: TerritoryPlaceItemRequest,
  ): Promise<TerritorySnapshotResponse>;
  retryImageCandidate(
    request: TerritoryImageCandidateIdRequest,
  ): Promise<TerritoryImageMutationResponse>;
  selectScene(
    request: TerritorySelectSceneRequest,
  ): Promise<TerritorySnapshotResponse>;
}
