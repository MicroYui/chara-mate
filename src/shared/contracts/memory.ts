import type { Static } from "@sinclair/typebox";

import type {
  MemoryCandidateIdRequestSchema,
  MemoryCandidateMutationResponseSchema,
  MemoryCandidateSchema,
  MemoryCandidateStatusSchema,
  MemoryClaimOperationSchema,
  MemoryClaimSlotSchema,
  MemoryCreateRequestSchema,
  MemoryDetailResponseSchema,
  MemoryDetailSchema,
  MemoryHitSchema,
  MemoryIdRequestSchema,
  MemoryListRequestSchema,
  MemoryListResponseSchema,
  MemoryMutationResponseSchema,
  MemoryProposalInputSchema,
  MemoryPurgeResponseSchema,
  MemoryRecordSchema,
  MemoryResolveClaimRequestSchema,
  MemoryRevisionSchema,
  MemoryReviseRequestSchema,
  MemorySetPinnedRequestSchema,
  MemorySnapshotSchema,
  MemorySourceSchema,
  MemorySourceTypeSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
  MemoryUsageConsumerSchema,
  MemoryUsageSchema,
} from "../schemas/memory";

export const MEMORY_CHANNELS = {
  acceptCandidate: "memory.candidate.accept",
  archive: "memory.archive",
  create: "memory.create",
  delete: "memory.delete",
  get: "memory.get",
  list: "memory.list",
  purge: "memory.purge",
  rejectCandidate: "memory.candidate.reject",
  resolveClaim: "memory.claim.resolve",
  restore: "memory.restore",
  revise: "memory.revise",
  setPinned: "memory.setPinned",
} as const;

export type MemoryType = Static<typeof MemoryTypeSchema>;
export type MemoryStatus = Static<typeof MemoryStatusSchema>;
export type MemorySourceType = Static<typeof MemorySourceTypeSchema>;
export type MemorySource = Static<typeof MemorySourceSchema>;
export type MemoryUsageConsumer = Static<typeof MemoryUsageConsumerSchema>;
export type MemoryUsage = Static<typeof MemoryUsageSchema>;
export type MemoryRecord = Static<typeof MemoryRecordSchema>;
export type MemoryRevision = Static<typeof MemoryRevisionSchema>;
export type MemoryHit = Static<typeof MemoryHitSchema>;
export type MemoryDetail = Static<typeof MemoryDetailSchema>;
export type MemoryCandidateStatus = Static<typeof MemoryCandidateStatusSchema>;
export type MemoryClaimOperation = Static<typeof MemoryClaimOperationSchema>;
export type MemoryClaimSlot = Static<typeof MemoryClaimSlotSchema>;
export type MemoryCandidate = Static<typeof MemoryCandidateSchema>;
export type MemorySnapshot = Static<typeof MemorySnapshotSchema>;
export type MemoryListRequest = Static<typeof MemoryListRequestSchema>;
export type MemoryIdRequest = Static<typeof MemoryIdRequestSchema>;
export type MemoryCreateRequest = Static<typeof MemoryCreateRequestSchema>;
export type MemoryResolveClaimRequest = Static<
  typeof MemoryResolveClaimRequestSchema
>;
export type MemoryReviseRequest = Static<typeof MemoryReviseRequestSchema>;
export type MemorySetPinnedRequest = Static<
  typeof MemorySetPinnedRequestSchema
>;
export type MemoryProposalInput = Static<typeof MemoryProposalInputSchema>;
export type MemoryCandidateIdRequest = Static<
  typeof MemoryCandidateIdRequestSchema
>;
export type MemoryListResponse = Static<typeof MemoryListResponseSchema>;
export type MemoryDetailResponse = Static<typeof MemoryDetailResponseSchema>;
export type MemoryMutationResponse = Static<
  typeof MemoryMutationResponseSchema
>;
export type MemoryCandidateMutationResponse = Static<
  typeof MemoryCandidateMutationResponseSchema
>;
export type MemoryPurgeResponse = Static<typeof MemoryPurgeResponseSchema>;

export interface MemoryApi {
  acceptCandidate(
    request: MemoryCandidateIdRequest,
  ): Promise<MemoryMutationResponse>;
  archive(request: MemoryIdRequest): Promise<MemoryMutationResponse>;
  create(request: MemoryCreateRequest): Promise<MemoryMutationResponse>;
  delete(request: MemoryIdRequest): Promise<MemoryMutationResponse>;
  get(request: MemoryIdRequest): Promise<MemoryDetailResponse>;
  list(request: MemoryListRequest): Promise<MemoryListResponse>;
  purge(request: MemoryIdRequest): Promise<MemoryPurgeResponse>;
  rejectCandidate(
    request: MemoryCandidateIdRequest,
  ): Promise<MemoryCandidateMutationResponse>;
  resolveClaim(
    request: MemoryResolveClaimRequest,
  ): Promise<MemoryMutationResponse>;
  restore(request: MemoryIdRequest): Promise<MemoryMutationResponse>;
  revise(request: MemoryReviseRequest): Promise<MemoryMutationResponse>;
  setPinned(request: MemorySetPinnedRequest): Promise<MemoryMutationResponse>;
}
