import { Type, type TSchema } from "@sinclair/typebox";

import {
  EntityIdSchema,
  NonBlankStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./primitives";
import { AppErrorSchema } from "./error";
import { ApprovalSchema, RunItemSchema, RunSchema } from "./run";

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

export const AttachmentKindSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("directory"),
  Type.Literal("image"),
  Type.Literal("audio"),
  Type.Literal("video"),
]);

export const AttachmentSchema = Type.Object(
  {
    byteLength: Type.Optional(Type.Integer({ minimum: 0 })),
    chatId: EntityIdSchema,
    createdAt: TimestampSchema,
    displayName: NonBlankStringSchema,
    id: EntityIdSchema,
    kind: AttachmentKindSchema,
    mediaType: Type.Optional(NonBlankStringSchema),
    messageId: EntityIdSchema,
    sha256: Type.Optional(Sha256Schema),
    storageKey: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ChatDataSnapshotRequestSchema = Type.Object(
  {
    chatId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const ChatDataSnapshotSchema = Type.Object(
  {
    approvals: Type.Array(ApprovalSchema),
    attachments: Type.Array(AttachmentSchema),
    chat: ChatSchema,
    messages: Type.Array(MessageSchema),
    runItems: Type.Array(RunItemSchema),
    runs: Type.Array(RunSchema),
  },
  { additionalProperties: false },
);

export const ChatDataSnapshotResponseSchema = Type.Union([
  ChatDataSnapshotSchema,
  Type.Null(),
]);

export const ChatListRequestSchema = Type.Object(
  {
    query: Type.Optional(Type.String()),
    status: ChatStatusSchema,
  },
  { additionalProperties: false },
);

export const ChatCreateRequestSchema = Type.Object(
  {
    initialMessage: Type.Optional(NonBlankStringSchema),
    title: Type.Optional(NonBlankStringSchema),
  },
  { additionalProperties: false },
);

export const ChatRenameRequestSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    title: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ChatSetPinnedRequestSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    pinned: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ChatIdRequestSchema = Type.Object(
  { chatId: EntityIdSchema },
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

export const ChatListResponseSchema = operationResponse(Type.Array(ChatSchema));
export const ChatMutationResponseSchema = operationResponse(ChatSchema);
export const ChatDeleteResponseSchema = operationResponse(
  Type.Object({ chatId: EntityIdSchema }, { additionalProperties: false }),
);
export const ChatGetSnapshotResponseSchema = operationResponse(
  ChatDataSnapshotResponseSchema,
);
