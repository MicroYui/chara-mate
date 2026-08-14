import type { Static } from "@sinclair/typebox";

import type {
  JourneyDetailResponseSchema,
  JourneyDetailSchema,
  JourneyFollowUpSchema,
  JourneyFollowUpStatusSchema,
  JourneyIdRequestSchema,
  JourneyMomentKindSchema,
  JourneyMomentSchema,
  JourneyMutationResponseSchema,
  JourneySchema,
  JourneySetStatusRequestSchema,
  JourneySnapshotResponseSchema,
  JourneySnapshotSchema,
  JourneyStatusSchema,
  TogetherSessionSchema,
  TogetherSessionSetStatusRequestSchema,
  TogetherSessionStatusSchema,
} from "../schemas/journey";

export const JOURNEY_CHANNELS = {
  changed: "journey.changed",
  getSnapshot: "journey.getSnapshot",
} as const;

export type JourneyStatus = Static<typeof JourneyStatusSchema>;
export type TogetherSessionStatus = Static<typeof TogetherSessionStatusSchema>;
export type JourneyFollowUpStatus = Static<typeof JourneyFollowUpStatusSchema>;
export type JourneyFollowUp = Static<typeof JourneyFollowUpSchema>;
export type Journey = Static<typeof JourneySchema>;
export type TogetherSession = Static<typeof TogetherSessionSchema>;
export type JourneyMomentKind = Static<typeof JourneyMomentKindSchema>;
export type JourneyMoment = Static<typeof JourneyMomentSchema>;
export type JourneySnapshot = Static<typeof JourneySnapshotSchema>;
export type JourneyDetail = Static<typeof JourneyDetailSchema>;
export type JourneyIdRequest = Static<typeof JourneyIdRequestSchema>;
export type JourneySetStatusRequest = Static<
  typeof JourneySetStatusRequestSchema
>;
export type TogetherSessionSetStatusRequest = Static<
  typeof TogetherSessionSetStatusRequestSchema
>;
export type JourneySnapshotResponse = Static<
  typeof JourneySnapshotResponseSchema
>;
export type JourneyDetailResponse = Static<typeof JourneyDetailResponseSchema>;
export type JourneyMutationResponse = Static<
  typeof JourneyMutationResponseSchema
>;

export interface JourneyApi {
  getSnapshot(): Promise<JourneySnapshotResponse>;
  subscribeChanged(listener: (snapshot: JourneySnapshot) => void): () => void;
}
