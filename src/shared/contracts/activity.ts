import type { Static } from "@sinclair/typebox";

import type {
  ActivityEventReferenceRequestSchema,
  ActivityEventReferenceSchema,
  ActivityEventReferenceResponseSchema,
  ActivityActorSchema,
  ActivityBoundarySchema,
  ActivityContentSchema,
  ActivityContentStatusSchema,
  ActivityInteractionSchema,
  ActivityInputOriginSchema,
  ActivityApplicationLifecycleSchema,
  ActivitySurfaceSchema,
  ActivityVisualStatusSchema,
  ActivityOcrLineSchema,
  ActivityVisualSchema,
  ActivityVisualReferenceSchema,
  ActivityVisualPositionSchema,
  ActivityVisualLookupRequestSchema,
  ActivityImageTargetSchema,
  ActivityCleanupRequestSchema,
  ActivityCleanupResponseSchema,
  ActivityCleanupResultSchema,
  ActivityDigestSchema,
  ActivityEpisodeIdRequestSchema,
  ActivityEpisodeResponseSchema,
  ActivityEpisodeSchema,
  ActivityEventDetailsSchema,
  ActivityEventSchema,
  ActivitySetPausedRequestSchema,
  ActivitySnapshotRequestSchema,
  ActivitySnapshotResponseSchema,
  ActivitySnapshotSchema,
  ActivitySourceSchema,
  ActivityUpdateEpisodeRequestSchema,
} from "../schemas/activity";

export const ACTIVITY_CHANNELS = {
  cleanup: "activity.cleanup",
  deleteEpisode: "activity.episode.delete",
  getEpisode: "activity.episode.get",
  getSnapshot: "activity.getSnapshot",
  resolveEventReference: "activity.event.resolve",
  setPaused: "activity.setPaused",
  updateEpisode: "activity.episode.update",
} as const;

export type ActivityBoundary = Static<typeof ActivityBoundarySchema>;
export type ActivityContent = Static<typeof ActivityContentSchema>;
export type ActivityContentStatus = Static<typeof ActivityContentStatusSchema>;
export type ActivityInteraction = Static<typeof ActivityInteractionSchema>;
export type ActivityInputOrigin = Static<typeof ActivityInputOriginSchema>;
export type ActivityApplicationLifecycle = Static<
  typeof ActivityApplicationLifecycleSchema
>;
export type ActivitySurface = Static<typeof ActivitySurfaceSchema>;
export type ActivityVisualStatus = Static<typeof ActivityVisualStatusSchema>;
export type ActivityOcrLine = Static<typeof ActivityOcrLineSchema>;
export type ActivityVisual = Static<typeof ActivityVisualSchema>;
export type ActivityVisualReference = Static<
  typeof ActivityVisualReferenceSchema
>;
export type ActivityVisualPosition = Static<
  typeof ActivityVisualPositionSchema
>;
export type ActivityVisualLookupRequest = Static<
  typeof ActivityVisualLookupRequestSchema
>;
export type ActivityImageTarget = Static<typeof ActivityImageTargetSchema>;
export interface ActivityVisualMatch {
  readonly reference: ActivityVisualReference;
  readonly actor: ActivityActor;
  readonly position: ActivityVisualPosition;
}
export interface ActivityVisualLookupResult {
  /** Effective range is returned verbatim for an explicit continuation. */
  readonly request: ActivityVisualLookupRequest;
  readonly observations: readonly ActivityVisualMatch[];
  readonly loaded: false;
  readonly retainedOnly: true;
  readonly order: "newest_first";
  /** Complete for this retained-data query, never for all past activity. */
  readonly complete: boolean;
  readonly readBytes: number;
  readonly continuation?: ActivityVisualLookupRequest;
  readonly omittedReason?: "read_budget" | "context_budget";
}
export interface ActivityPerception {
  readonly boundary?: ActivityBoundary;
  readonly content?: ActivityContent;
  readonly contentStatus?: ActivityContentStatus;
  readonly interaction?: ActivityInteraction;
  readonly inputOrigin?: ActivityInputOrigin;
  readonly surface?: ActivitySurface;
  readonly visualStatus?: ActivityVisualStatus;
}

export type ActivitySource = Static<typeof ActivitySourceSchema>;
export type ActivityActor = Static<typeof ActivityActorSchema>;
export type ActivityEventDetails = Static<typeof ActivityEventDetailsSchema>;
export type ActivityEvent = Static<typeof ActivityEventSchema>;
export type ActivityEpisode = Static<typeof ActivityEpisodeSchema>;
export type ActivityDigest = Static<typeof ActivityDigestSchema>;
export type ActivitySnapshot = Static<typeof ActivitySnapshotSchema>;
export type ActivitySnapshotRequest = Static<
  typeof ActivitySnapshotRequestSchema
>;
export type ActivitySetPausedRequest = Static<
  typeof ActivitySetPausedRequestSchema
>;
export type ActivityEpisodeIdRequest = Static<
  typeof ActivityEpisodeIdRequestSchema
>;
export type ActivityUpdateEpisodeRequest = Static<
  typeof ActivityUpdateEpisodeRequestSchema
>;
export type ActivityCleanupRequest = Static<
  typeof ActivityCleanupRequestSchema
>;
export type ActivityCleanupResult = Static<typeof ActivityCleanupResultSchema>;
export type ActivitySnapshotResponse = Static<
  typeof ActivitySnapshotResponseSchema
>;
export type ActivityEpisodeResponse = Static<
  typeof ActivityEpisodeResponseSchema
>;
export type ActivityCleanupResponse = Static<
  typeof ActivityCleanupResponseSchema
>;

export type ActivityEventReference = Static<
  typeof ActivityEventReferenceSchema
>;
export type ActivityEventReferenceRequest = Static<
  typeof ActivityEventReferenceRequestSchema
>;
export type ActivityEventReferenceResponse = Static<
  typeof ActivityEventReferenceResponseSchema
>;

export interface ActivityApi {
  resolveEventReference(
    request: ActivityEventReferenceRequest,
  ): Promise<ActivityEventReferenceResponse>;
  cleanup(request: ActivityCleanupRequest): Promise<ActivityCleanupResponse>;
  deleteEpisode(
    request: ActivityEpisodeIdRequest,
  ): Promise<ActivitySnapshotResponse>;
  getEpisode(
    request: ActivityEpisodeIdRequest,
  ): Promise<ActivityEpisodeResponse>;
  getSnapshot(
    request: ActivitySnapshotRequest,
  ): Promise<ActivitySnapshotResponse>;
  setPaused(
    request: ActivitySetPausedRequest,
  ): Promise<ActivitySnapshotResponse>;
  updateEpisode(
    request: ActivityUpdateEpisodeRequest,
  ): Promise<ActivityEpisodeResponse>;
}
