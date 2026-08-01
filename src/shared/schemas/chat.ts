import { Type } from "@sinclair/typebox";

import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

export const ChatStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("archived"),
]);

export const ChatSchema = Type.Object(
  {
    archivedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    pinnedAt: Type.Optional(TimestampSchema),
    status: ChatStatusSchema,
    title: NonBlankStringSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const MessageRoleSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
]);

export const MessageStatusSchema = Type.Union([
  Type.Literal("streaming"),
  Type.Literal("completed"),
  Type.Literal("interrupted"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const MessageSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    content: Type.String(),
    createdAt: TimestampSchema,
    id: EntityIdSchema,
    role: MessageRoleSchema,
    runId: Type.Optional(EntityIdSchema),
    status: MessageStatusSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
