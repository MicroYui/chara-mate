import { Type } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  JsonValueReferenceSchema,
  NonBlankStringSchema,
  Sha256Schema,
} from "./primitives";
import { ArtifactReferenceSchema, RunItemKindSchema } from "./run";

export const ToolSourceSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("mcp"),
]);

export const ToolEffectSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("critical"),
]);

export const ToolIdempotencySchema = Type.Union([
  Type.Literal("idempotent"),
  Type.Literal("non_idempotent"),
]);

export const ToolDescriptorSchema = Type.Object(
  {
    description: NonBlankStringSchema,
    effect: ToolEffectSchema,
    idempotency: ToolIdempotencySchema,
    inputSchema: JsonValueReferenceSchema,
    itemKind: RunItemKindSchema,
    name: Type.String({ pattern: "^[a-z][a-z0-9._-]*[a-z0-9]$" }),
    namespace: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    recoveryGroup: Type.Optional(NonBlankStringSchema),
    source: ToolSourceSchema,
    summary: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ToolResultStatusSchema = Type.Union([
  Type.Literal("success"),
  Type.Literal("error"),
  Type.Literal("rejected"),
  Type.Literal("cancelled"),
  Type.Literal("needs_input"),
]);

export const ToolResultSchema = Type.Object(
  {
    artifacts: Type.Array(ArtifactReferenceSchema),
    error: Type.Optional(AppErrorSchema),
    evidenceHash: Type.Optional(Sha256Schema),
    modelContent: JsonValueReferenceSchema,
    retryable: Type.Boolean(),
    status: ToolResultStatusSchema,
    summary: NonBlankStringSchema,
  },
  { additionalProperties: false },
);
