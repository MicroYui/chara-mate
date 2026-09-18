import type { Static } from "@sinclair/typebox";

import type {
  ApprovalModeSchema,
  ApprovalSchema,
  ApprovalStatusSchema,
  AppErrorSchema,
  ArtifactKindSchema,
  ArtifactReferenceSchema,
  PlanStepSchema,
  PlanStepStatusSchema,
  PlanUpdateSchema,
  RunCancelRequestSchema,
  RunCancelResultSchema,
  RunExecutionSchema,
  RunItemKindSchema,
  RunItemSchema,
  RunItemStatusSchema,
  RunSchema,
  RunStatusSchema,
  RequestUserInputArgumentsSchema,
  TerminalRunStatusSchema,
  UserInputAnswerSchema,
  UserInputOptionSchema,
  UserInputQuestionSchema,
  UserInputResolutionSchema,
  InputRequestResolutionSchema,
} from "../schemas/run";

export type AppError = Static<typeof AppErrorSchema>;
export type ArtifactKind = Static<typeof ArtifactKindSchema>;
export type ArtifactReference = Static<typeof ArtifactReferenceSchema>;
export type ApprovalMode = Static<typeof ApprovalModeSchema>;
export type PlanStepStatus = Static<typeof PlanStepStatusSchema>;
export type PlanStep = Static<typeof PlanStepSchema>;
export type PlanUpdate = Static<typeof PlanUpdateSchema>;
export type UserInputOption = Static<typeof UserInputOptionSchema>;
export type UserInputQuestion = Static<typeof UserInputQuestionSchema>;
export type RequestUserInputArguments = Static<
  typeof RequestUserInputArgumentsSchema
>;
export type UserInputAnswer = Static<typeof UserInputAnswerSchema>;
export type UserInputResolution = Static<typeof UserInputResolutionSchema>;
export type InputRequestResolution = Static<
  typeof InputRequestResolutionSchema
>;
export type RunExecution = Static<typeof RunExecutionSchema>;
export type RunStatus = Static<typeof RunStatusSchema>;
export type TerminalRunStatus = Static<typeof TerminalRunStatusSchema>;
export type Run = Static<typeof RunSchema>;
export type RunItemKind = Static<typeof RunItemKindSchema>;
export type RunItemStatus = Static<typeof RunItemStatusSchema>;
export type RunItem = Static<typeof RunItemSchema>;
export type ApprovalStatus = Static<typeof ApprovalStatusSchema>;
export type Approval = Static<typeof ApprovalSchema>;
export type RunCancelRequest = Static<typeof RunCancelRequestSchema>;
export type RunCancelResult = Static<typeof RunCancelResultSchema>;
