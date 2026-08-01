import type { Static } from "@sinclair/typebox";

import type {
  AttachmentKindSchema,
  AttachmentSchema,
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
  ChatDataSnapshotSchema,
  ChatSchema,
  ChatStatusSchema,
  MessageRoleSchema,
  MessageSchema,
  MessageStatusSchema,
} from "../schemas/chat";

export const CHAT_DATA_CHANNELS = {
  getSnapshot: "chat.data.getSnapshot",
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

export interface ChatDataApi {
  getSnapshot(
    request: ChatDataSnapshotRequest,
  ): Promise<ChatDataSnapshotResponse>;
}
