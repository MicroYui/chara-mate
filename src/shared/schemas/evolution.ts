import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import { MemoryClaimSlotSchema, MemoryTypeSchema } from "./memory";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./primitives";

export const EvolutionCandidateKindSchema = Type.Union([
  Type.Literal("memory"),
  Type.Literal("persona_preference"),
  Type.Literal("skill_patch"),
  Type.Literal("new_skill"),
]);

export const EvolutionCandidateStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("accepted"),
  Type.Literal("active"),
  Type.Literal("rejected"),
  Type.Literal("stale"),
  Type.Literal("archived"),
]);

export const EvolutionReviewStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("skipped"),
  Type.Literal("failed"),
]);

export const EvolutionTriggerSchema = Type.Union([
  Type.Literal("explicit_correction"),
  Type.Literal("explicit_teaching"),
  Type.Literal("verified_success"),
  Type.Literal("repeated_pattern"),
]);

export const EvolutionReplayStatusSchema = Type.Union([
  Type.Literal("not_required"),
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("passed"),
  Type.Literal("failed"),
]);

export const EvolutionReplayCaseSchema = Type.Object(
  {
    expectedOutcome: NonBlankStringSchema,
    id: EntityIdSchema,
    input: NonBlankStringSchema,
    scope: Type.Union([Type.Literal("in_scope"), Type.Literal("out_of_scope")]),
  },
  { additionalProperties: false },
);

const EvolutionMemoryProposalSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    kind: Type.Literal("memory"),
    memoryType: MemoryTypeSchema,
    reason: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

const EvolutionPersonaProposalSchema = Type.Object(
  {
    claimSlot: MemoryClaimSlotSchema,
    content: NonBlankStringSchema,
    kind: Type.Literal("persona_preference"),
    reason: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

const EvolutionSkillNameSchema = Type.String({
  maxLength: 64,
  pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
});

const EvolutionSkillPatchProposalSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    kind: Type.Literal("skill_patch"),
    name: EvolutionSkillNameSchema,
    targetContentSha256: Sha256Schema,
    targetRevision: Type.Integer({ minimum: 1 }),
    targetSkillId: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

const EvolutionNewSkillProposalSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    kind: Type.Literal("new_skill"),
    name: EvolutionSkillNameSchema,
  },
  { additionalProperties: false },
);

export const EvolutionProposalSchema = Type.Union([
  EvolutionMemoryProposalSchema,
  EvolutionPersonaProposalSchema,
  EvolutionSkillPatchProposalSchema,
  EvolutionNewSkillProposalSchema,
]);

export const EvolutionReplayResultSchema = Type.Object(
  {
    completedAt: Type.Optional(TimestampSchema),
    failureReason: Type.Optional(NonBlankStringSchema),
    status: EvolutionReplayStatusSchema,
  },
  { additionalProperties: false },
);

export const EvolutionCandidateSchema = Type.Object(
  {
    activatedAt: Type.Optional(TimestampSchema),
    activatedMemoryId: Type.Optional(EntityIdSchema),
    activatedSkillId: Type.Optional(NonBlankStringSchema),
    activatedSkillRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    archivedAt: Type.Optional(TimestampSchema),
    chatId: EntityIdSchema,
    createdAt: TimestampSchema,
    evidence: Type.Array(NonBlankStringSchema, { minItems: 1 }),
    id: EntityIdSchema,
    kind: EvolutionCandidateKindSchema,
    pinned: Type.Boolean(),
    proposal: EvolutionProposalSchema,
    rationale: NonBlankStringSchema,
    replayCases: Type.Array(EvolutionReplayCaseSchema),
    replayResult: EvolutionReplayResultSchema,
    reviewId: EntityIdSchema,
    sourceItemIds: Type.Array(EntityIdSchema, { minItems: 1 }),
    sourceRunIds: Type.Array(EntityIdSchema, { minItems: 1 }),
    status: EvolutionCandidateStatusSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const EvolutionReviewSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    completedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    error: Type.Optional(AppErrorSchema),
    id: EntityIdSchema,
    runId: EntityIdSchema,
    startedAt: Type.Optional(TimestampSchema),
    status: EvolutionReviewStatusSchema,
    triggers: Type.Array(EvolutionTriggerSchema),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const EvolutionSnapshotSchema = Type.Object(
  {
    candidates: Type.Array(EvolutionCandidateSchema),
    reviews: Type.Array(EvolutionReviewSchema),
  },
  { additionalProperties: false },
);

export const EvolutionListRequestSchema = Type.Object(
  {
    chatId: Type.Optional(EntityIdSchema),
    includeArchived: Type.Optional(Type.Boolean()),
    kind: Type.Optional(EvolutionCandidateKindSchema),
    runId: Type.Optional(EntityIdSchema),
    status: Type.Optional(EvolutionCandidateStatusSchema),
  },
  { additionalProperties: false },
);

export const EvolutionCandidateIdRequestSchema = Type.Object(
  { candidateId: EntityIdSchema },
  { additionalProperties: false },
);

export const EvolutionRunIdRequestSchema = Type.Object(
  { runId: EntityIdSchema },
  { additionalProperties: false },
);

export const EvolutionCandidateUpdateRequestSchema = Type.Object(
  {
    candidateId: EntityIdSchema,
    proposal: EvolutionProposalSchema,
    rationale: NonBlankStringSchema,
    replayCases: Type.Array(EvolutionReplayCaseSchema),
  },
  { additionalProperties: false },
);

export const EvolutionCandidatePinRequestSchema = Type.Object(
  { candidateId: EntityIdSchema, pinned: Type.Boolean() },
  { additionalProperties: false },
);

export const EvolutionChangedEventSchema = Type.Union([
  Type.Object(
    {
      candidate: EvolutionCandidateSchema,
      type: Type.Literal("candidate.changed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      review: EvolutionReviewSchema,
      type: Type.Literal("review.changed"),
    },
    { additionalProperties: false },
  ),
]);

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

export const EvolutionSnapshotResponseSchema = operationResponse(
  EvolutionSnapshotSchema,
);
export const EvolutionCandidateMutationResponseSchema = operationResponse(
  EvolutionCandidateSchema,
);
export const EvolutionReviewMutationResponseSchema = operationResponse(
  EvolutionReviewSchema,
);
