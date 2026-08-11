import type { Static } from "@sinclair/typebox";

import type {
  TerritoryActiveSceneSchema,
  TerritoryCollectItemRequestSchema,
  TerritoryCollectionTargetSchema,
  TerritoryCreateSourceCandidateRequestSchema,
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
  TerritoryItemCandidateSchema,
  TerritoryItemCandidateStatusSchema,
  TerritoryItemSchema,
  TerritoryItemSourceKindSchema,
  TerritoryItemSourceSchema,
  TerritoryItemTargetSchema,
  TerritoryItemVersionSchema,
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
  TerritorySelectItemVersionRequestSchema,
  TerritorySetItemPinnedRequestSchema,
  TerritorySourceCandidateMutationResponseSchema,
  TerritorySourceCandidateMutationResultSchema,
  TerritorySnapshotResponseSchema,
  TerritorySnapshotSchema,
  TerritorySurfaceTargetSchema,
} from "../schemas/territory";

export const TERRITORY_CHANNELS = {
  collectItem: "territory.item.collect",
  confirmImageCandidate: "territory.image.confirm",
  createSourceCandidate: "territory.candidate.create",
  editImageCandidate: "territory.image.edit",
  generateImageCandidate: "territory.image.generate",
  getSnapshot: "territory.snapshot.get",
  movePet: "territory.pet.move",
  placeItem: "territory.item.place",
  retryImageCandidate: "territory.image.retry",
  selectScene: "territory.scene.select",
  selectItemVersion: "territory.item.version.select",
  setItemPinned: "territory.item.pin.set",
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
export type TerritoryItemSourceKind = Static<
  typeof TerritoryItemSourceKindSchema
>;
export type TerritoryItemSource = Static<typeof TerritoryItemSourceSchema>;
export type TerritoryItemVersion = Static<typeof TerritoryItemVersionSchema>;
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
export type TerritoryItemCandidateStatus = Static<
  typeof TerritoryItemCandidateStatusSchema
>;
export type TerritoryItemCandidate = Static<
  typeof TerritoryItemCandidateSchema
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
export type TerritoryCreateSourceCandidateRequest = Static<
  typeof TerritoryCreateSourceCandidateRequestSchema
>;
export type TerritorySetItemPinnedRequest = Static<
  typeof TerritorySetItemPinnedRequestSchema
>;
export type TerritorySelectItemVersionRequest = Static<
  typeof TerritorySelectItemVersionRequestSchema
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
export type TerritorySourceCandidateMutationResult = Static<
  typeof TerritorySourceCandidateMutationResultSchema
>;
export type TerritorySourceCandidateMutationResponse = Static<
  typeof TerritorySourceCandidateMutationResponseSchema
>;

export interface TerritoryApi {
  collectItem(
    request: TerritoryCollectItemRequest,
  ): Promise<TerritorySnapshotResponse>;
  confirmImageCandidate(
    request: TerritoryImageCandidateIdRequest,
  ): Promise<TerritoryImageMutationResponse>;
  createSourceCandidate(
    request: TerritoryCreateSourceCandidateRequest,
  ): Promise<TerritorySourceCandidateMutationResponse>;
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
  selectItemVersion(
    request: TerritorySelectItemVersionRequest,
  ): Promise<TerritorySnapshotResponse>;
  setItemPinned(
    request: TerritorySetItemPinnedRequest,
  ): Promise<TerritorySnapshotResponse>;
}
