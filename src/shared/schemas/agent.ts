import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";
import {
  ApprovalSchema,
  ArtifactReferenceSchema,
  RunCancelResultSchema,
  RunExecutionSchema,
  RunSchema,
  UserInputResolutionSchema,
} from "./run";

export const StartRunRequestSchema = Type.Object(
  {
    attachments: Type.Array(ArtifactReferenceSchema),
    chatId: EntityIdSchema,
    content: NonBlankStringSchema,
    execution: RunExecutionSchema,
    providerProfileId: EntityIdSchema,
    requestedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const SteerRunRequestSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    requestedAt: TimestampSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const ResumeRunRequestSchema = Type.Object(
  {
    requestedAt: TimestampSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const ApprovalDecisionSchema = Type.Union([
  Type.Literal("approved"),
  Type.Literal("rejected"),
]);

export const ResolveApprovalRequestSchema = Type.Object(
  {
    approvalId: EntityIdSchema,
    decidedAt: TimestampSchema,
    decision: ApprovalDecisionSchema,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ResolveUserInputRequestSchema = Type.Object(
  {
    itemId: EntityIdSchema,
    resolution: UserInputResolutionSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const PendingApprovalRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const ApprovalNavigationRequestSchema = Type.Object(
  { approvalId: EntityIdSchema },
  { additionalProperties: false },
);

export const ApprovalNavigationTargetSchema = Type.Object(
  {
    approvalId: EntityIdSchema,
    chatId: EntityIdSchema,
    itemId: EntityIdSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const RunMutationResultSchema = Type.Object(
  { runId: EntityIdSchema },
  { additionalProperties: false },
);

function operationResponse<TValue extends TSchema>(value: TValue) {
  return Type.Union([
    Type.Object(
      { ok: Type.Literal(true), value },
      { additionalProperties: false },
    ),
    Type.Object(
      { error: AppErrorSchema, ok: Type.Literal(false) },
      { additionalProperties: false },
    ),
  ]);
}

export const StartRunResponseSchema = operationResponse(RunSchema);
export const RunMutationResponseSchema = operationResponse(
  RunMutationResultSchema,
);
export const RunCancelResponseSchema = operationResponse(RunCancelResultSchema);
export const ResolveApprovalResponseSchema = operationResponse(ApprovalSchema);
export const ResolveUserInputResponseSchema = operationResponse(RunSchema);
export const PendingApprovalResponseSchema = operationResponse(
  Type.Union([ApprovalSchema, Type.Null()]),
);
