import type { Static } from "@sinclair/typebox";

import type {
  ActivityActorSchema,
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
  setPaused: "activity.setPaused",
  updateEpisode: "activity.episode.update",
} as const;

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

export interface ActivityApi {
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
