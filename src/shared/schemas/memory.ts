import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

export const MemoryTypeSchema = Type.Union([
  Type.Literal("profile"),
  Type.Literal("preference"),
  Type.Literal("project"),
  Type.Literal("event"),
  Type.Literal("procedure"),
  Type.Literal("commitment"),
  Type.Literal("activity_digest"),
  Type.Literal("agent_learning"),
]);

export const MemoryStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("superseded"),
  Type.Literal("archived"),
]);

export const MemoryClaimSlotSchema = Type.Union([
  Type.Literal("profile.name"),
  Type.Literal("profile.pronouns"),
  Type.Literal("profile.home_location"),
  Type.Literal("profile.timezone"),
  Type.Literal("profile.occupation"),
  Type.Literal("profile.languages"),
  Type.Literal("profile.birth_date"),
  Type.Literal("preference.hobbies"),
  Type.Literal("preference.likes"),
  Type.Literal("preference.dislikes"),
  Type.Literal("preference.response_style"),
  Type.Literal("preference.communication_style"),
  Type.Literal("preference.food"),
  Type.Literal("preference.music"),
  Type.Literal("preference.media"),
  Type.Literal("preference.travel"),
  Type.Literal("preference.schedule"),
  Type.Literal("preference.tools"),
]);

export const MemoryClaimOperationSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("replace"),
  Type.Literal("append"),
  Type.Literal("remove"),
]);

export const MemorySourceTypeSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("voice"),
  Type.Literal("activity"),
  Type.Literal("tool"),
  Type.Literal("user_edit"),
  Type.Literal("distillation"),
]);

export const MemorySourceSchema = Type.Object(
  {
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    label: Type.Optional(NonBlankStringSchema),
    referenceId: EntityIdSchema,
    type: MemorySourceTypeSchema,
  },
  { additionalProperties: false },
);

export const MemoryUsageConsumerSchema = Type.Union([
  Type.Literal("context"),
  Type.Literal("tool"),
]);

export const MemoryUsageSchema = Type.Object(
  {
    consumer: MemoryUsageConsumerSchema,
    id: EntityIdSchema,
    memoryId: EntityIdSchema,
    revisionId: EntityIdSchema,
    usedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const MemoryRecordSchema = Type.Object(
  {
    claimSlot: Type.Optional(MemoryClaimSlotSchema),
    confidence: Type.Number({ maximum: 1, minimum: 0 }),
    createdAt: TimestampSchema,
    currentRevisionId: EntityIdSchema,
    deletedAt: Type.Optional(TimestampSchema),
    id: EntityIdSchema,
    importance: Type.Number({ maximum: 1, minimum: 0 }),
    lastAccessedAt: Type.Optional(TimestampSchema),
    pinnedAt: Type.Optional(TimestampSchema),
    status: MemoryStatusSchema,
    supersededById: Type.Optional(EntityIdSchema),
    type: MemoryTypeSchema,
    updatedAt: TimestampSchema,
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

export const MemoryRevisionSchema = Type.Object(
  {
    content: NonBlankStringSchema,
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    memoryId: EntityIdSchema,
    reason: NonBlankStringSchema,
    sourceIds: Type.Array(EntityIdSchema),
    sourceType: MemorySourceTypeSchema,
  },
  { additionalProperties: false },
);

export const MemoryHitSchema = Type.Object(
  {
    memory: MemoryRecordSchema,
    rank: Type.Integer({ minimum: 1 }),
    revision: MemoryRevisionSchema,
    sources: Type.Array(MemorySourceSchema),
  },
  { additionalProperties: false },
);

export const MemoryDetailSchema = Type.Object(
  {
    memory: MemoryRecordSchema,
    revisions: Type.Array(MemoryRevisionSchema),
    sources: Type.Array(MemorySourceSchema),
    usages: Type.Array(MemoryUsageSchema),
  },
  { additionalProperties: false },
);

export const MemoryCandidateStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("rejected"),
]);

export const MemoryCandidateSchema = Type.Object(
  {
    claimOperation: Type.Optional(MemoryClaimOperationSchema),
    claimSlot: Type.Optional(MemoryClaimSlotSchema),
    confidence: Type.Number({ maximum: 1, minimum: 0 }),
    content: NonBlankStringSchema,
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    importance: Type.Number({ maximum: 1, minimum: 0 }),
    novelty: Type.Number({ maximum: 1, minimum: 0 }),
    reason: NonBlankStringSchema,
    sourceIds: Type.Array(EntityIdSchema, { minItems: 1 }),
    sourceLabels: Type.Array(NonBlankStringSchema, { minItems: 1 }),
    sourceType: MemorySourceTypeSchema,
    status: MemoryCandidateStatusSchema,
    supersedesMemoryId: Type.Optional(EntityIdSchema),
    type: MemoryTypeSchema,
    updatedAt: TimestampSchema,
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

export const MemoryListRequestSchema = Type.Object(
  {
    asOf: Type.Optional(TimestampSchema),
    claimSlot: Type.Optional(MemoryClaimSlotSchema),
    includeDeleted: Type.Optional(Type.Boolean()),
    includeInactive: Type.Optional(Type.Boolean()),
    query: Type.Optional(Type.String()),
    sourceType: Type.Optional(MemorySourceTypeSchema),
    status: Type.Optional(MemoryStatusSchema),
    type: Type.Optional(MemoryTypeSchema),
  },
  { additionalProperties: false },
);

export const MemoryIdRequestSchema = Type.Object(
  { memoryId: EntityIdSchema },
  { additionalProperties: false },
);

export const MemoryCreateRequestSchema = Type.Object(
  {
    claimSlot: Type.Optional(MemoryClaimSlotSchema),
    confidence: Type.Number({ maximum: 1, minimum: 0 }),
    content: NonBlankStringSchema,
    importance: Type.Number({ maximum: 1, minimum: 0 }),
    reason: NonBlankStringSchema,
    sources: Type.Array(MemorySourceSchema),
    supersedesMemoryId: Type.Optional(EntityIdSchema),
    type: MemoryTypeSchema,
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

export const MemoryResolveClaimRequestSchema = Type.Object(
  {
    claimSlot: MemoryClaimSlotSchema,
    content: NonBlankStringSchema,
    memoryId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const MemoryReviseRequestSchema = Type.Object(
  {
    confidence: Type.Optional(Type.Number({ maximum: 1, minimum: 0 })),
    content: NonBlankStringSchema,
    importance: Type.Optional(Type.Number({ maximum: 1, minimum: 0 })),
    memoryId: EntityIdSchema,
    reason: NonBlankStringSchema,
    sources: Type.Array(MemorySourceSchema),
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

export const MemorySetPinnedRequestSchema = Type.Object(
  { memoryId: EntityIdSchema, pinned: Type.Boolean() },
  { additionalProperties: false },
);

export const MemoryCandidateIdRequestSchema = Type.Object(
  { candidateId: EntityIdSchema },
  { additionalProperties: false },
);

export const MemoryProposalInputSchema = Type.Object(
  {
    confidence: Type.Number({ maximum: 1, minimum: 0 }),
    content: NonBlankStringSchema,
    importance: Type.Number({ maximum: 1, minimum: 0 }),
    novelty: Type.Number({ maximum: 1, minimum: 0 }),
    reason: NonBlankStringSchema,
    sourceIds: Type.Array(EntityIdSchema, { minItems: 1 }),
    sourceLabels: Type.Array(NonBlankStringSchema, { minItems: 1 }),
    sourceType: MemorySourceTypeSchema,
    supersedesMemoryId: Type.Optional(EntityIdSchema),
    type: MemoryTypeSchema,
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

export const MemorySnapshotSchema = Type.Object(
  {
    candidates: Type.Array(MemoryCandidateSchema),
    memories: Type.Array(MemoryHitSchema),
    profile: Type.Array(MemoryHitSchema),
  },
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

export const MemoryListResponseSchema = operationResponse(MemorySnapshotSchema);
export const MemoryDetailResponseSchema = operationResponse(MemoryDetailSchema);
export const MemoryMutationResponseSchema =
  operationResponse(MemoryDetailSchema);
export const MemoryCandidateMutationResponseSchema = operationResponse(
  MemoryCandidateSchema,
);
export const MemoryPurgeResponseSchema = operationResponse(
  Type.Object({ memoryId: EntityIdSchema }, { additionalProperties: false }),
);
