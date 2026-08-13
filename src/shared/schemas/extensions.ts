import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./primitives";

export const McpSecretInputSchema = Type.Object(
  {
    name: NonBlankStringSchema,
    value: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const McpTransportDraftSchema = Type.Union([
  Type.Object(
    {
      args: Type.Array(Type.String()),
      command: NonBlankStringSchema,
      cwd: Type.Optional(NonBlankStringSchema),
      environment: Type.Array(McpSecretInputSchema),
      type: Type.Literal("stdio"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      headers: Type.Array(McpSecretInputSchema),
      type: Type.Literal("streamable_http"),
      url: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
]);

const McpSecretSnapshotSchema = Type.Object(
  { hasValue: Type.Boolean(), name: NonBlankStringSchema },
  { additionalProperties: false },
);

export const McpTransportSnapshotSchema = Type.Union([
  Type.Object(
    {
      args: Type.Array(Type.String()),
      command: NonBlankStringSchema,
      cwd: Type.Optional(NonBlankStringSchema),
      environment: Type.Array(McpSecretSnapshotSchema),
      type: Type.Literal("stdio"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      headers: Type.Array(McpSecretSnapshotSchema),
      type: Type.Literal("streamable_http"),
      url: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
]);

export const McpConnectionStatusSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("disconnected"),
  Type.Literal("connected"),
  Type.Literal("error"),
]);

export const McpServerSchema = Type.Object(
  {
    createdAt: TimestampSchema,
    enabled: Type.Boolean(),
    error: Type.Optional(AppErrorSchema),
    id: EntityIdSchema,
    lastConnectedAt: Type.Optional(TimestampSchema),
    name: NonBlankStringSchema,
    status: McpConnectionStatusSchema,
    toolNames: Type.Array(Type.String()),
    transport: McpTransportSnapshotSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const McpServerDraftSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    id: Type.Optional(EntityIdSchema),
    name: NonBlankStringSchema,
    transport: McpTransportDraftSchema,
  },
  { additionalProperties: false },
);

export const McpListRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export const McpSaveRequestSchema = Type.Object(
  { server: McpServerDraftSchema },
  { additionalProperties: false },
);
export const McpIdRequestSchema = Type.Object(
  { serverId: EntityIdSchema },
  { additionalProperties: false },
);

export const SkillSourceSchema = Type.Union([
  Type.Literal("workspace"),
  Type.Literal("user"),
]);

export const SkillLifecycleSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("stale"),
  Type.Literal("archived"),
]);

export const SkillDescriptorSchema = Type.Object(
  {
    archived: Type.Boolean(),
    contentSha256: Sha256Schema,
    description: NonBlankStringSchema,
    enabled: Type.Boolean(),
    id: NonBlankStringSchema,
    lastSuccessAt: Type.Optional(TimestampSchema),
    lastUsedAt: Type.Optional(TimestampSchema),
    lifecycle: SkillLifecycleSchema,
    name: NonBlankStringSchema,
    patchCount: Type.Integer({ minimum: 0 }),
    pinned: Type.Boolean(),
    readOnly: Type.Boolean(),
    revision: Type.Integer({ minimum: 1 }),
    source: SkillSourceSchema,
    successCount: Type.Integer({ minimum: 0 }),
    useCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SkillContentSchema = Type.Object(
  {
    content: Type.String(),
    skill: SkillDescriptorSchema,
  },
  { additionalProperties: false },
);

export const SkillListRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export const SkillIdRequestSchema = Type.Object(
  { skillId: NonBlankStringSchema },
  { additionalProperties: false },
);
export const SkillSaveRequestSchema = Type.Object(
  { content: NonBlankStringSchema, name: NonBlankStringSchema },
  { additionalProperties: false },
);
export const SkillSetEnabledRequestSchema = Type.Object(
  { enabled: Type.Boolean(), skillId: NonBlankStringSchema },
  { additionalProperties: false },
);
export const SkillSetPinnedRequestSchema = Type.Object(
  { pinned: Type.Boolean(), skillId: NonBlankStringSchema },
  { additionalProperties: false },
);
export const SkillRevisionRequestSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    skillId: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const SkillVersionSnapshotSchema = Type.Object(
  {
    content: Type.Optional(Type.String()),
    contentSha256: Sha256Schema,
    createdAt: TimestampSchema,
    lifecycle: SkillLifecycleSchema,
    revision: Type.Integer({ minimum: 1 }),
    sourceCandidateId: Type.Optional(EntityIdSchema),
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

export const McpListResponseSchema = operationResponse(
  Type.Array(McpServerSchema),
);
export const McpMutationResponseSchema = operationResponse(McpServerSchema);
export const McpDeleteResponseSchema = operationResponse(
  Type.Object({ serverId: EntityIdSchema }, { additionalProperties: false }),
);
export const SkillListResponseSchema = operationResponse(
  Type.Array(SkillDescriptorSchema),
);
export const SkillMutationResponseSchema = operationResponse(
  SkillDescriptorSchema,
);
export const SkillDeleteResponseSchema = operationResponse(
  Type.Object(
    { skillId: NonBlankStringSchema },
    { additionalProperties: false },
  ),
);
export const SkillGetResponseSchema = operationResponse(SkillContentSchema);
export const SkillHistoryResponseSchema = operationResponse(
  Type.Array(SkillVersionSnapshotSchema),
);
