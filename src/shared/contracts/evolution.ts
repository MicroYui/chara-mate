import type { Static } from "@sinclair/typebox";

import type {
  EvolutionCandidateIdRequestSchema,
  EvolutionCandidateKindSchema,
  EvolutionCandidateMutationResponseSchema,
  EvolutionCandidatePinRequestSchema,
  EvolutionCandidateSchema,
  EvolutionCandidateStatusSchema,
  EvolutionCandidateUpdateRequestSchema,
  EvolutionChangedEventSchema,
  EvolutionListRequestSchema,
  EvolutionProposalSchema,
  EvolutionReplayCaseSchema,
  EvolutionReplayResultSchema,
  EvolutionReplayStatusSchema,
  EvolutionReviewMutationResponseSchema,
  EvolutionReviewSchema,
  EvolutionReviewStatusSchema,
  EvolutionRunIdRequestSchema,
  EvolutionSnapshotResponseSchema,
  EvolutionSnapshotSchema,
  EvolutionTriggerSchema,
} from "../schemas/evolution";

export const EVOLUTION_CHANNELS = {
  acceptCandidate: "evolution.candidate.accept",
  archiveCandidate: "evolution.candidate.archive",
  changed: "evolution.changed",
  dismissReview: "evolution.review.dismiss",
  list: "evolution.list",
  rejectCandidate: "evolution.candidate.reject",
  restoreCandidate: "evolution.candidate.restore",
  retryReplay: "evolution.candidate.retryReplay",
  retryReview: "evolution.review.retry",
  setCandidatePinned: "evolution.candidate.setPinned",
  updateCandidate: "evolution.candidate.update",
} as const;

export type EvolutionCandidateKind = Static<
  typeof EvolutionCandidateKindSchema
>;
export type EvolutionCandidateStatus = Static<
  typeof EvolutionCandidateStatusSchema
>;
export type EvolutionReviewStatus = Static<typeof EvolutionReviewStatusSchema>;
export type EvolutionTrigger = Static<typeof EvolutionTriggerSchema>;
export type EvolutionReplayStatus = Static<typeof EvolutionReplayStatusSchema>;
export type EvolutionReplayCase = Static<typeof EvolutionReplayCaseSchema>;
export type EvolutionProposal = Static<typeof EvolutionProposalSchema>;
export type EvolutionReplayResult = Static<typeof EvolutionReplayResultSchema>;
export type EvolutionCandidate = Static<typeof EvolutionCandidateSchema>;
export type EvolutionReview = Static<typeof EvolutionReviewSchema>;
export type EvolutionSnapshot = Static<typeof EvolutionSnapshotSchema>;
export type EvolutionListRequest = Static<typeof EvolutionListRequestSchema>;
export type EvolutionCandidateIdRequest = Static<
  typeof EvolutionCandidateIdRequestSchema
>;
export type EvolutionRunIdRequest = Static<typeof EvolutionRunIdRequestSchema>;
export type EvolutionCandidateUpdateRequest = Static<
  typeof EvolutionCandidateUpdateRequestSchema
>;
export type EvolutionCandidatePinRequest = Static<
  typeof EvolutionCandidatePinRequestSchema
>;
export type EvolutionChangedEvent = Static<typeof EvolutionChangedEventSchema>;
export type EvolutionSnapshotResponse = Static<
  typeof EvolutionSnapshotResponseSchema
>;
export type EvolutionCandidateMutationResponse = Static<
  typeof EvolutionCandidateMutationResponseSchema
>;
export type EvolutionReviewMutationResponse = Static<
  typeof EvolutionReviewMutationResponseSchema
>;

export interface EvolutionApi {
  acceptCandidate(
    request: EvolutionCandidateIdRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
  archiveCandidate(
    request: EvolutionCandidateIdRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
  dismissReview(
    request: EvolutionRunIdRequest,
  ): Promise<EvolutionReviewMutationResponse>;
  list(request: EvolutionListRequest): Promise<EvolutionSnapshotResponse>;
  rejectCandidate(
    request: EvolutionCandidateIdRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
  restoreCandidate(
    request: EvolutionCandidateIdRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
  retryReplay(
    request: EvolutionCandidateIdRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
  retryReview(
    request: EvolutionRunIdRequest,
  ): Promise<EvolutionReviewMutationResponse>;
  setCandidatePinned(
    request: EvolutionCandidatePinRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
  subscribe(listener: (event: EvolutionChangedEvent) => void): () => void;
  updateCandidate(
    request: EvolutionCandidateUpdateRequest,
  ): Promise<EvolutionCandidateMutationResponse>;
}
