import { Type, type Static } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";

export const CHAT_CONTEXT_FORMAT_VERSION = 1;
export const CHAT_CONTEXT_SUMMARY_PREFIX =
  "Conversation working-memory summary (authoritative for covered messages):";

export const ChatContextSnapshotSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    coveredThroughCreatedAt: Type.Optional(TimestampSchema),
    coveredThroughMessageId: Type.Optional(EntityIdSchema),
    formatVersion: Type.Literal(CHAT_CONTEXT_FORMAT_VERSION),
    generation: Type.Integer({ minimum: 0 }),
    lastInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    lastModelId: Type.Optional(NonBlankStringSchema),
    lastRequestBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    summary: Type.String(),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export type ChatContextSnapshot = Static<typeof ChatContextSnapshotSchema>;

export interface ChatContextBoundary {
  readonly createdAt: string;
  readonly messageId: string;
}

export function isChatContextSummaryInput(value: JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value["type"] === "message" &&
    value["role"] === "developer" &&
    typeof value["content"] === "string" &&
    value["content"].startsWith(CHAT_CONTEXT_SUMMARY_PREFIX)
  );
}
