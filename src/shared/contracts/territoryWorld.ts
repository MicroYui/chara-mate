import type { Static } from "@sinclair/typebox";

import type {
  TerritoryAssetPackSchema,
  TerritoryAssetSchema,
  TerritoryAnchorKindSchema,
  TerritoryBoundsSchema,
  TerritoryCandidateIdRequestSchema,
  TerritoryCandidateIntentSchema,
  TerritoryCandidateMutationResponseSchema,
  TerritoryCandidateMutationResultSchema,
  TerritoryChatMomentAttachmentSchema,
  TerritoryChatMomentMemoryRevisionSchema,
  TerritoryChatMomentPersonaRefSchema,
  TerritoryChatMomentSourceSnapshotSchema,
  TerritoryCandidateScopeSchema,
  TerritoryChangeCandidateSchema,
  TerritoryCommitChangeSetRequestSchema,
  TerritoryCreateChangeCandidateRequestSchema,
  TerritoryCreateSourceCandidateRequestSchema,
  TerritoryDepthModeSchema,
  TerritoryDefinitionRefSchema,
  TerritoryDefinitionSchema,
  TerritoryEditChangeCandidateRequestSchema,
  TerritoryEnterZoneRequestSchema,
  TerritoryGetZoneViewRequestSchema,
  TerritoryGridPointSchema,
  TerritoryGridSizeSchema,
  TerritoryGroupSchema,
  TerritoryInstancePlacementSchema,
  TerritoryInstanceSchema,
  TerritoryLayerSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMovePetResponseSchema,
  TerritoryMovePetResultSchema,
  TerritoryPerformPetActionRequestSchema,
  TerritoryPetActionObservationSchema,
  TerritoryPetActionPerformedSchema,
  TerritoryPetActionSchema,
  TerritoryPetActionTargetSchema,
  TerritoryPetAffordanceSchema,
  TerritoryPetStateSchema,
  TerritoryPurgeInstanceRequestSchema,
  TerritoryRestoreRevisionRequestSchema,
  TerritoryRotationSchema,
  TerritorySourceSnapshotSchema,
  TerritoryStyleProfileRefSchema,
  TerritoryStyleProfileSchema,
  TerritoryWorldChangeSetSchema,
  TerritoryWorldMutationSchema,
  TerritoryWorldRevisionSummarySchema,
  TerritoryWorldSnapshotResponseSchema,
  TerritoryWorldSnapshotSchema,
  TerritoryWorldStateSchema,
  TerritoryWorldSummarySchema,
  TerritoryZoneConnectionSchema,
  TerritoryZoneKindSchema,
  TerritoryZoneSchema,
  TerritoryZoneViewResponseSchema,
  TerritoryZoneViewSchema,
} from "../schemas/territoryWorld";

export const TERRITORY_WORLD_CHANNELS = {
  applyCandidate: "territory.world.candidate.apply",
  cancelCandidate: "territory.world.candidate.cancel",
  commitChangeSet: "territory.world.changes.commit",
  createCandidate: "territory.world.candidate.create",
  createSourceCandidate: "territory.world.candidate.source.create",
  editCandidate: "territory.world.candidate.edit",
  enterZone: "territory.world.zone.enter",
  getSnapshot: "territory.world.snapshot.get",
  getZoneView: "territory.world.zone.get",
  movePet: "territory.world.pet.move",
  petActionPerformed: "territory.world.pet.action-performed",
  purgeInstance: "territory.world.instance.purge",
  restoreRevision: "territory.world.revision.restore",
  snapshotChanged: "territory.world.snapshot.changed",
} as const;

export type TerritoryLayer = Static<typeof TerritoryLayerSchema>;
export type TerritoryDepthMode = Static<typeof TerritoryDepthModeSchema>;
export type TerritoryRotation = Static<typeof TerritoryRotationSchema>;
export type TerritoryZoneKind = Static<typeof TerritoryZoneKindSchema>;
export type TerritoryGridPoint = Static<typeof TerritoryGridPointSchema>;
export type TerritoryGridSize = Static<typeof TerritoryGridSizeSchema>;
export type TerritoryBounds = Static<typeof TerritoryBoundsSchema>;
export type TerritoryStyleProfileRef = Static<
  typeof TerritoryStyleProfileRefSchema
>;
export type TerritoryStyleProfile = Static<typeof TerritoryStyleProfileSchema>;
export type TerritoryZone = Static<typeof TerritoryZoneSchema>;
export type TerritoryZoneConnection = Static<
  typeof TerritoryZoneConnectionSchema
>;
export type TerritoryAsset = Static<typeof TerritoryAssetSchema>;
export type TerritoryAssetPack = Static<typeof TerritoryAssetPackSchema>;
export type TerritoryAnchorKind = Static<typeof TerritoryAnchorKindSchema>;
export type TerritoryDefinition = Static<typeof TerritoryDefinitionSchema>;
export type TerritoryDefinitionRef = Static<
  typeof TerritoryDefinitionRefSchema
>;
export type TerritorySourceSnapshot = Static<
  typeof TerritorySourceSnapshotSchema
>;
export type TerritoryChatMomentAttachment = Static<
  typeof TerritoryChatMomentAttachmentSchema
>;
export type TerritoryChatMomentMemoryRevision = Static<
  typeof TerritoryChatMomentMemoryRevisionSchema
>;
export type TerritoryChatMomentPersonaRef = Static<
  typeof TerritoryChatMomentPersonaRefSchema
>;
export type TerritoryChatMomentSourceSnapshot = Static<
  typeof TerritoryChatMomentSourceSnapshotSchema
>;
export type TerritoryInstancePlacement = Static<
  typeof TerritoryInstancePlacementSchema
>;
export type TerritoryInstance = Static<typeof TerritoryInstanceSchema>;
export type TerritoryGroup = Static<typeof TerritoryGroupSchema>;
export type TerritoryPetState = Static<typeof TerritoryPetStateSchema>;
export type TerritoryPetAction = Static<typeof TerritoryPetActionSchema>;
export type TerritoryPetActionTarget = Static<
  typeof TerritoryPetActionTargetSchema
>;
export type TerritoryPetAffordance = Static<
  typeof TerritoryPetAffordanceSchema
>;
export type TerritoryPetActionObservation = Static<
  typeof TerritoryPetActionObservationSchema
>;
export type TerritoryPerformPetActionRequest = Static<
  typeof TerritoryPerformPetActionRequestSchema
>;
export type TerritoryPetActionPerformed = Static<
  typeof TerritoryPetActionPerformedSchema
>;
export type TerritoryWorldRevisionSummary = Static<
  typeof TerritoryWorldRevisionSummarySchema
>;
export type TerritoryWorldSummary = Static<typeof TerritoryWorldSummarySchema>;
export type TerritoryWorldMutation = Static<
  typeof TerritoryWorldMutationSchema
>;
export type TerritoryWorldChangeSet = Static<
  typeof TerritoryWorldChangeSetSchema
>;
export type TerritoryCandidateScope = Static<
  typeof TerritoryCandidateScopeSchema
>;
export type TerritoryCandidateIntent = Static<
  typeof TerritoryCandidateIntentSchema
>;
export type TerritoryChangeCandidate = Static<
  typeof TerritoryChangeCandidateSchema
>;
export type TerritoryWorldSnapshot = Static<
  typeof TerritoryWorldSnapshotSchema
>;
export type TerritoryWorldState = Static<typeof TerritoryWorldStateSchema>;
export type TerritoryZoneView = Static<typeof TerritoryZoneViewSchema>;
export type TerritoryGetZoneViewRequest = Static<
  typeof TerritoryGetZoneViewRequestSchema
>;
export type TerritoryCommitChangeSetRequest = Static<
  typeof TerritoryCommitChangeSetRequestSchema
>;
export type TerritoryRestoreRevisionRequest = Static<
  typeof TerritoryRestoreRevisionRequestSchema
>;
export type TerritoryMovePetRequest = Static<
  typeof TerritoryMovePetRequestSchema
>;
export type TerritoryCreateChangeCandidateRequest = Static<
  typeof TerritoryCreateChangeCandidateRequestSchema
>;
export type TerritoryCreateSourceCandidateRequest = Static<
  typeof TerritoryCreateSourceCandidateRequestSchema
>;
export type TerritoryEditChangeCandidateRequest = Static<
  typeof TerritoryEditChangeCandidateRequestSchema
>;
export type TerritoryEnterZoneRequest = Static<
  typeof TerritoryEnterZoneRequestSchema
>;
export type TerritoryCandidateIdRequest = Static<
  typeof TerritoryCandidateIdRequestSchema
>;
export type TerritoryPurgeInstanceRequest = Static<
  typeof TerritoryPurgeInstanceRequestSchema
>;
export type TerritoryWorldSnapshotResponse = Static<
  typeof TerritoryWorldSnapshotResponseSchema
>;
export type TerritoryZoneViewResponse = Static<
  typeof TerritoryZoneViewResponseSchema
>;
export type TerritoryCandidateMutationResponse = Static<
  typeof TerritoryCandidateMutationResponseSchema
>;
export type TerritoryCandidateMutationResult = Static<
  typeof TerritoryCandidateMutationResultSchema
>;
export type TerritoryMovePetResponse = Static<
  typeof TerritoryMovePetResponseSchema
>;
export type TerritoryMovePetResult = Static<
  typeof TerritoryMovePetResultSchema
>;

export interface TerritoryWorldApi {
  applyCandidate(
    request: TerritoryCandidateIdRequest,
  ): Promise<TerritoryCandidateMutationResponse>;
  cancelCandidate(
    request: TerritoryCandidateIdRequest,
  ): Promise<TerritoryCandidateMutationResponse>;
  commitChangeSet(
    request: TerritoryCommitChangeSetRequest,
  ): Promise<TerritoryWorldSnapshotResponse>;
  createCandidate(
    request: TerritoryCreateChangeCandidateRequest,
  ): Promise<TerritoryCandidateMutationResponse>;
  createSourceCandidate(
    request: TerritoryCreateSourceCandidateRequest,
  ): Promise<TerritoryCandidateMutationResponse>;
  editCandidate(
    request: TerritoryEditChangeCandidateRequest,
  ): Promise<TerritoryCandidateMutationResponse>;
  enterZone(
    request: TerritoryEnterZoneRequest,
  ): Promise<TerritoryWorldSnapshotResponse>;
  getSnapshot(): Promise<TerritoryWorldSnapshotResponse>;
  getZoneView(
    request: TerritoryGetZoneViewRequest,
  ): Promise<TerritoryZoneViewResponse>;
  movePet(request: TerritoryMovePetRequest): Promise<TerritoryMovePetResponse>;
  purgeInstance(
    request: TerritoryPurgeInstanceRequest,
  ): Promise<TerritoryWorldSnapshotResponse>;
  restoreRevision(
    request: TerritoryRestoreRevisionRequest,
  ): Promise<TerritoryWorldSnapshotResponse>;
  subscribeChanged(
    listener: (snapshot: TerritoryWorldSnapshot) => void,
  ): () => void;
  subscribePetAction(
    listener: (event: TerritoryPetActionPerformed) => void,
  ): () => void;
}
