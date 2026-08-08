import type { Static } from "@sinclair/typebox";

import type {
  AttachmentKindSchema,
  AttachmentSchema,
  ChatCreateRequestSchema,
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
  ChatDataSnapshotSchema,
  ChatDeleteResponseSchema,
  ChatGetSnapshotResponseSchema,
  ChatIdRequestSchema,
  ChatListRequestSchema,
  ChatListResponseSchema,
  ChatMutationResponseSchema,
  ChatRenameRequestSchema,
  ChatSchema,
  ChatSetPinnedRequestSchema,
  ChatStatusSchema,
  MessageRoleSchema,
  MessageSchema,
  MessageStatusSchema,
} from "../schemas/chat";

export const CHAT_CHANNELS = {
  archive: "chat.archive",
  create: "chat.create",
  delete: "chat.delete",
  getSnapshot: "chat.getSnapshot",
  list: "chat.list",
  rename: "chat.rename",
  restore: "chat.restore",
  setPinned: "chat.setPinned",
} as const;

export const CHAT_EVENT_CHANNELS = {
  changed: "chat.changed",
} as const;

export type ChatStatus = Static<typeof ChatStatusSchema>;
export type Chat = Static<typeof ChatSchema>;
export type MessageRole = Static<typeof MessageRoleSchema>;
export type MessageStatus = Static<typeof MessageStatusSchema>;
export type Message = Static<typeof MessageSchema>;
export type AttachmentKind = Static<typeof AttachmentKindSchema>;
export type Attachment = Static<typeof AttachmentSchema>;
export type ChatDataSnapshotRequest = Static<
  typeof ChatDataSnapshotRequestSchema
>;
export type ChatDataSnapshot = Static<typeof ChatDataSnapshotSchema>;
export type ChatDataSnapshotResponse = Static<
  typeof ChatDataSnapshotResponseSchema
>;
export type ChatListRequest = Static<typeof ChatListRequestSchema>;
export type ChatCreateRequest = Static<typeof ChatCreateRequestSchema>;
export type ChatRenameRequest = Static<typeof ChatRenameRequestSchema>;
export type ChatSetPinnedRequest = Static<typeof ChatSetPinnedRequestSchema>;
export type ChatIdRequest = Static<typeof ChatIdRequestSchema>;
export type ChatListResponse = Static<typeof ChatListResponseSchema>;
export type ChatMutationResponse = Static<typeof ChatMutationResponseSchema>;
export type ChatDeleteResponse = Static<typeof ChatDeleteResponseSchema>;
export type ChatGetSnapshotResponse = Static<
  typeof ChatGetSnapshotResponseSchema
>;

export interface ChatApi {
  archive(request: ChatIdRequest): Promise<ChatMutationResponse>;
  create(request: ChatCreateRequest): Promise<ChatMutationResponse>;
  delete(request: ChatIdRequest): Promise<ChatDeleteResponse>;
  getSnapshot(
    request: ChatDataSnapshotRequest,
  ): Promise<ChatGetSnapshotResponse>;
  list(request: ChatListRequest): Promise<ChatListResponse>;
  rename(request: ChatRenameRequest): Promise<ChatMutationResponse>;
  restore(request: ChatIdRequest): Promise<ChatMutationResponse>;
  setPinned(request: ChatSetPinnedRequest): Promise<ChatMutationResponse>;
  subscribeChanged(listener: (chat: Chat) => void): () => void;
}
