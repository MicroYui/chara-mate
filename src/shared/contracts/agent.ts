import type { Static } from "@sinclair/typebox";

import type {
  ApprovalDecisionSchema,
  ApprovalNavigationRequestSchema,
  ApprovalNavigationTargetSchema,
  CancelStartRequestSchema,
  CancelStartResultSchema,
  CancelStartResponseSchema,
  PendingApprovalRequestSchema,
  PendingApprovalResponseSchema,
  ResolveApprovalRequestSchema,
  ResolveApprovalResponseSchema,
  ResolveUserInputRequestSchema,
  ResolveUserInputResponseSchema,
  ResumeRunRequestSchema,
  RunCancelResponseSchema,
  RunMutationResponseSchema,
  StartRunRequestSchema,
  StartRunSubmissionRequestSchema,
  StartRunResponseSchema,
  SteerRunRequestSchema,
} from "../schemas/agent";
import type { RunCancelRequest } from "./run";

export const AGENT_CHANNELS = {
  cancel: "run.cancel",
  cancelStart: "run.cancelStart",
  pendingApproval: "approval.pending",
  openApproval: "approval.open",
  resolveApproval: "approval.resolve",
  resolveUserInput: "input.resolve",
  resume: "run.resume",
  start: "run.start",
  steer: "run.steer",
} as const;

export type StartRunRequest = Static<typeof StartRunRequestSchema>;
export type StartRunSubmissionRequest = Static<
  typeof StartRunSubmissionRequestSchema
>;
export type CancelStartRequest = Static<typeof CancelStartRequestSchema>;
export type CancelStartResult = Static<typeof CancelStartResultSchema>;
export type CancelStartResponse = Static<typeof CancelStartResponseSchema>;
export type StartRunResponse = Static<typeof StartRunResponseSchema>;
export type SteerRunRequest = Static<typeof SteerRunRequestSchema>;
export type ResumeRunRequest = Static<typeof ResumeRunRequestSchema>;
export type ResolveApprovalRequest = Static<
  typeof ResolveApprovalRequestSchema
>;
export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;
export type ApprovalNavigationRequest = Static<
  typeof ApprovalNavigationRequestSchema
>;
export type ApprovalNavigationTarget = Static<
  typeof ApprovalNavigationTargetSchema
>;
export type PendingApprovalRequest = Static<
  typeof PendingApprovalRequestSchema
>;
export type PendingApprovalResponse = Static<
  typeof PendingApprovalResponseSchema
>;
export type RunMutationResponse = Static<typeof RunMutationResponseSchema>;
export type RunCancelResponse = Static<typeof RunCancelResponseSchema>;
export type ResolveApprovalResponse = Static<
  typeof ResolveApprovalResponseSchema
>;
export type ResolveUserInputRequest = Static<
  typeof ResolveUserInputRequestSchema
>;
export type ResolveUserInputResponse = Static<
  typeof ResolveUserInputResponseSchema
>;

export interface AgentApi {
  cancel(request: RunCancelRequest): Promise<RunCancelResponse>;
  cancelStart(request: CancelStartRequest): Promise<CancelStartResponse>;
  getPendingApproval(
    request: PendingApprovalRequest,
  ): Promise<PendingApprovalResponse>;
  resolveApproval(
    request: ResolveApprovalRequest,
  ): Promise<ResolveApprovalResponse>;
  resolveUserInput(
    request: ResolveUserInputRequest,
  ): Promise<ResolveUserInputResponse>;
  resume(request: ResumeRunRequest): Promise<RunMutationResponse>;
  start(request: StartRunSubmissionRequest): Promise<StartRunResponse>;
  steer(request: SteerRunRequest): Promise<RunMutationResponse>;
  subscribeOpenApproval(
    listener: (target: ApprovalNavigationTarget) => void,
  ): () => void;
}
