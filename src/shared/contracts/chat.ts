import type { Static } from "@sinclair/typebox";

import type {
  ChatSchema,
  ChatStatusSchema,
  MessageRoleSchema,
  MessageSchema,
  MessageStatusSchema,
} from "../schemas/chat";

export type ChatStatus = Static<typeof ChatStatusSchema>;
export type Chat = Static<typeof ChatSchema>;
export type MessageRole = Static<typeof MessageRoleSchema>;
export type MessageStatus = Static<typeof MessageStatusSchema>;
export type Message = Static<typeof MessageSchema>;
