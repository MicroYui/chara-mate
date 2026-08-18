import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type {
  Attachment,
  Chat,
  ChatStatus,
  Message,
} from "../../shared/contracts/chat";
import {
  AttachmentSchema,
  ChatSchema,
  MessageSchema,
} from "../../shared/schemas/chat";
import { parseSchema } from "../../shared/schemas/validation";
import { sanitizeForPersistence } from "../db/persistenceBoundary";
import {
  CHAT_CONTEXT_FORMAT_VERSION,
  type ChatContextBoundary,
  type ChatContextSnapshot,
  ChatContextSnapshotSchema,
} from "./chatContext";

interface ChatRow {
  archived_at: string | null;
  created_at: string;
  id: string;
  is_provisional: number;
  pinned_at: string | null;
  status: string;
  title: string;
  updated_at: string;
}

interface MessageRow {
  chat_id: string;
  content: string;
  created_at: string;
  id: string;
  role: string;
  run_id: string | null;
  status: string;
  updated_at: string;
}

interface AttachmentRow {
  byte_length: number | null;
  chat_id: string;
  created_at: string;
  display_name: string;
  id: string;
  kind: string;
  media_type: string | null;
  message_id: string;
  sha256: string | null;
  storage_key: string;
}

interface ChatContextSnapshotRow {
  chat_id: string;
  covered_through_created_at: string | null;
  covered_through_message_id: string | null;
  format_version: number;
  generation: number;
  last_input_tokens: number | null;
  last_model_id: string | null;
  last_request_bytes: number | null;
  summary_text: string;
  updated_at: string;
}

export interface ChatPersistenceSnapshot {
  attachments: Attachment[];
  chat: Chat;
  messages: Message[];
}

export interface ChatListFilter {
  query?: string;
  status: ChatStatus;
}

function readChat(row: ChatRow): Chat {
  return parseSchema(ChatSchema, {
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    createdAt: row.created_at,
    id: row.id,
    ...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  });
}

function readMessage(row: MessageRow): Message {
  return parseSchema(MessageSchema, {
    chatId: row.chat_id,
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    role: row.role,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    status: row.status,
    updatedAt: row.updated_at,
  });
}

function readAttachment(row: AttachmentRow): Attachment {
  return parseSchema(AttachmentSchema, {
    ...(row.byte_length === null ? {} : { byteLength: row.byte_length }),
    chatId: row.chat_id,
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    kind: row.kind,
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
    messageId: row.message_id,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    storageKey: row.storage_key,
  });
}

function readContextSnapshot(row: ChatContextSnapshotRow): ChatContextSnapshot {
  return parseSchema(ChatContextSnapshotSchema, {
    chatId: row.chat_id,
    ...(row.covered_through_created_at === null
      ? {}
      : { coveredThroughCreatedAt: row.covered_through_created_at }),
    ...(row.covered_through_message_id === null
      ? {}
      : { coveredThroughMessageId: row.covered_through_message_id }),
    formatVersion: row.format_version,
    generation: row.generation,
    ...(row.last_input_tokens === null
      ? {}
      : { lastInputTokens: row.last_input_tokens }),
    ...(row.last_model_id === null ? {} : { lastModelId: row.last_model_id }),
    ...(row.last_request_bytes === null
      ? {}
      : { lastRequestBytes: row.last_request_bytes }),
    summary: row.summary_text,
    updatedAt: row.updated_at,
  });
}

export class ChatRepository {
  constructor(private readonly database: Database.Database) {}

  insertChat(chat: Chat, options: { provisional?: boolean } = {}): Chat {
    const persisted = sanitizeForPersistence(ChatSchema, chat);
    this.database
      .prepare(
        `INSERT INTO chats (
          id, title, status, is_provisional, pinned_at, archived_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        persisted.id,
        persisted.title,
        persisted.status,
        options.provisional ? 1 : 0,
        persisted.pinnedAt ?? null,
        persisted.archivedAt ?? null,
        persisted.createdAt,
        persisted.updatedAt,
      );
    return persisted;
  }

  updateChat(chat: Chat): Chat {
    const persisted = sanitizeForPersistence(ChatSchema, chat);
    const result = this.database
      .prepare(
        `UPDATE chats
         SET title = ?, status = ?, pinned_at = ?, archived_at = ?, updated_at = ?
         WHERE id = ? AND created_at = ?`,
      )
      .run(
        persisted.title,
        persisted.status,
        persisted.pinnedAt ?? null,
        persisted.archivedAt ?? null,
        persisted.updatedAt,
        persisted.id,
        persisted.createdAt,
      );
    if (result.changes !== 1) {
      throw new Error(
        `Chat ${persisted.id} does not exist or changed identity`,
      );
    }
    return persisted;
  }

  deleteChat(chatId: string): boolean {
    return (
      this.database.prepare("DELETE FROM chats WHERE id = ?").run(chatId)
        .changes === 1
    );
  }

  deleteProvisionalChat(chatId: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM chats WHERE id = ? AND is_provisional = 1")
        .run(chatId).changes === 1
    );
  }

  deleteAllProvisionalChats(): number {
    return this.database
      .prepare("DELETE FROM chats WHERE is_provisional = 1")
      .run().changes;
  }

  establishProvisionalChat(
    chatId: string,
    updatedAt: string,
  ): Chat | undefined {
    const result = this.database
      .prepare(
        `UPDATE chats
         SET is_provisional = 0, updated_at = ?
         WHERE id = ? AND is_provisional = 1`,
      )
      .run(updatedAt, chatId);
    return result.changes === 1 ? this.getChat(chatId) : undefined;
  }

  isProvisionalChat(chatId: string): boolean {
    const row = this.database
      .prepare("SELECT is_provisional FROM chats WHERE id = ?")
      .get(chatId) as { is_provisional: number } | undefined;
    return row?.is_provisional === 1;
  }

  getChat(chatId: string): Chat | undefined {
    const row = this.database
      .prepare(
        `SELECT id, title, status, is_provisional, pinned_at, archived_at,
                created_at, updated_at
         FROM chats
         WHERE id = ?`,
      )
      .get(chatId) as ChatRow | undefined;
    return row ? readChat(row) : undefined;
  }

  listChats(filter: ChatListFilter): Chat[] {
    const query = filter.query?.trim();
    const rows = (
      query
        ? this.database
            .prepare(
              `SELECT id, title, status, is_provisional, pinned_at, archived_at,
                      created_at, updated_at
               FROM chats
               WHERE status = ? AND is_provisional = 0
                 AND instr(lower(title), lower(?)) > 0
               ORDER BY (pinned_at IS NULL), pinned_at DESC, updated_at DESC, id`,
            )
            .all(filter.status, query)
        : this.database
            .prepare(
              `SELECT id, title, status, is_provisional, pinned_at, archived_at,
                      created_at, updated_at
               FROM chats
               WHERE status = ? AND is_provisional = 0
               ORDER BY (pinned_at IS NULL), pinned_at DESC, updated_at DESC, id`,
            )
            .all(filter.status)
    ) as ChatRow[];
    return rows.map(readChat);
  }

  insertMessage(message: Message): Message {
    const persisted = sanitizeForPersistence(MessageSchema, message);
    this.database
      .prepare(
        `INSERT INTO messages (
          id, chat_id, run_id, role, status, content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        persisted.id,
        persisted.chatId,
        persisted.runId ?? null,
        persisted.role,
        persisted.status,
        persisted.content,
        persisted.createdAt,
        persisted.updatedAt,
      );
    return persisted;
  }

  updateMessage(message: Message): Message {
    const persisted = sanitizeForPersistence(MessageSchema, message);
    const currentRow = this.database
      .prepare(
        `SELECT id, chat_id, run_id, role, status, content, created_at, updated_at
         FROM messages
         WHERE id = ?`,
      )
      .get(persisted.id) as MessageRow | undefined;
    if (!currentRow) {
      throw new Error(`Message ${persisted.id} does not exist`);
    }
    const current = readMessage(currentRow);
    if (isDeepStrictEqual(current, persisted)) {
      return current;
    }
    if (
      current.chatId !== persisted.chatId ||
      current.role !== persisted.role ||
      current.runId !== persisted.runId ||
      current.createdAt !== persisted.createdAt
    ) {
      throw new Error(`Message ${persisted.id} changed immutable identity`);
    }
    if (current.status !== "streaming") {
      throw new Error(`Completed message ${persisted.id} is append-first`);
    }
    const result = this.database
      .prepare(
        `UPDATE messages
         SET status = ?, content = ?, updated_at = ?
         WHERE id = ? AND status = 'streaming'`,
      )
      .run(
        persisted.status,
        persisted.content,
        persisted.updatedAt,
        persisted.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Message ${persisted.id} changed concurrently`);
    }
    return persisted;
  }

  insertAttachment(attachment: Attachment): Attachment {
    const persisted = sanitizeForPersistence(AttachmentSchema, attachment);
    this.database
      .prepare(
        `INSERT INTO attachments (
          id, chat_id, message_id, kind, display_name, storage_key,
          media_type, byte_length, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        persisted.id,
        persisted.chatId,
        persisted.messageId,
        persisted.kind,
        persisted.displayName,
        persisted.storageKey,
        persisted.mediaType ?? null,
        persisted.byteLength ?? null,
        persisted.sha256 ?? null,
        persisted.createdAt,
      );
    return persisted;
  }

  getMessage(messageId: string): Message | undefined {
    const row = this.database
      .prepare(
        `SELECT id, chat_id, run_id, role, status, content, created_at, updated_at
         FROM messages
         WHERE id = ?`,
      )
      .get(messageId) as MessageRow | undefined;
    return row ? readMessage(row) : undefined;
  }

  listMessages(chatId: string): Message[] {
    const rows = this.database
      .prepare(
        `SELECT id, chat_id, run_id, role, status, content, created_at, updated_at
         FROM messages
         WHERE chat_id = ?
         ORDER BY created_at, id`,
      )
      .all(chatId) as MessageRow[];
    return rows.map(readMessage);
  }

  listContextMessages(chatId: string, after?: ChatContextBoundary): Message[] {
    const boundaryClause = after
      ? "AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))"
      : "";
    const rows = this.database
      .prepare(
        `SELECT m.id, m.chat_id, m.run_id, m.role, m.status, m.content,
                m.created_at, m.updated_at
         FROM messages AS m
         LEFT JOIN runs AS r
           ON r.id = m.run_id AND r.chat_id = m.chat_id
         WHERE m.chat_id = ?
           AND m.status = 'completed'
           AND length(trim(m.content)) > 0
           AND (
             m.run_id IS NULL OR
             r.status IN ('interrupted', 'completed', 'failed', 'cancelled')
           )
           ${boundaryClause}
         ORDER BY m.created_at, m.id`,
      )
      .all(
        chatId,
        ...(after ? [after.createdAt, after.createdAt, after.messageId] : []),
      ) as MessageRow[];
    return rows.map(readMessage);
  }

  getContextSnapshot(chatId: string): ChatContextSnapshot | undefined {
    const row = this.database
      .prepare(
        `SELECT chat_id, generation, format_version, summary_text,
                covered_through_message_id, covered_through_created_at,
                last_request_bytes, last_input_tokens, last_model_id, updated_at
         FROM chat_context_snapshots
         WHERE chat_id = ?`,
      )
      .get(chatId) as ChatContextSnapshotRow | undefined;
    return row ? readContextSnapshot(row) : undefined;
  }

  recordContextUsage(input: {
    readonly chatId: string;
    readonly inputTokens: number;
    readonly modelId: string;
    readonly requestBytes: number;
    readonly updatedAt: string;
  }): ChatContextSnapshot {
    this.database
      .prepare(
        `INSERT INTO chat_context_snapshots (
          chat_id, generation, format_version, summary_text,
          covered_through_message_id, covered_through_created_at,
          last_request_bytes, last_input_tokens, last_model_id, updated_at
        ) VALUES (?, 0, ?, '', NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          last_request_bytes = excluded.last_request_bytes,
          last_input_tokens = excluded.last_input_tokens,
          last_model_id = excluded.last_model_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.chatId,
        CHAT_CONTEXT_FORMAT_VERSION,
        input.requestBytes,
        input.inputTokens,
        input.modelId,
        input.updatedAt,
      );
    const saved = this.getContextSnapshot(input.chatId);
    if (!saved) throw new Error("Chat context usage was not persisted");
    return saved;
  }

  advanceContextSnapshot(input: {
    readonly boundary: ChatContextBoundary;
    readonly chatId: string;
    readonly expectedGeneration: number;
    readonly summary: string;
    readonly updatedAt: string;
  }): ChatContextSnapshot | undefined {
    return this.database.transaction(() => {
      const current = this.getContextSnapshot(input.chatId);
      if ((current?.generation ?? 0) !== input.expectedGeneration) {
        return undefined;
      }
      if (
        current?.coveredThroughCreatedAt &&
        current.coveredThroughMessageId &&
        (input.boundary.createdAt < current.coveredThroughCreatedAt ||
          (input.boundary.createdAt === current.coveredThroughCreatedAt &&
            input.boundary.messageId <= current.coveredThroughMessageId))
      ) {
        return undefined;
      }
      const next = sanitizeForPersistence(ChatContextSnapshotSchema, {
        chatId: input.chatId,
        coveredThroughCreatedAt: input.boundary.createdAt,
        coveredThroughMessageId: input.boundary.messageId,
        formatVersion: CHAT_CONTEXT_FORMAT_VERSION,
        generation: input.expectedGeneration + 1,
        ...(current?.lastInputTokens === undefined
          ? {}
          : { lastInputTokens: current.lastInputTokens }),
        ...(current?.lastModelId === undefined
          ? {}
          : { lastModelId: current.lastModelId }),
        ...(current?.lastRequestBytes === undefined
          ? {}
          : { lastRequestBytes: current.lastRequestBytes }),
        summary: input.summary,
        updatedAt: input.updatedAt,
      });
      this.database
        .prepare(
          `INSERT INTO chat_context_snapshots (
            chat_id, generation, format_version, summary_text,
            covered_through_message_id, covered_through_created_at,
            last_request_bytes, last_input_tokens, last_model_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            generation = excluded.generation,
            format_version = excluded.format_version,
            summary_text = excluded.summary_text,
            covered_through_message_id = excluded.covered_through_message_id,
            covered_through_created_at = excluded.covered_through_created_at,
            last_request_bytes = excluded.last_request_bytes,
            last_input_tokens = excluded.last_input_tokens,
            last_model_id = excluded.last_model_id,
            updated_at = excluded.updated_at`,
        )
        .run(
          next.chatId,
          next.generation,
          next.formatVersion,
          next.summary,
          next.coveredThroughMessageId,
          next.coveredThroughCreatedAt,
          next.lastRequestBytes ?? null,
          next.lastInputTokens ?? null,
          next.lastModelId ?? null,
          next.updatedAt,
        );
      return next;
    })();
  }

  listRunMessages(runId: string): Message[] {
    const rows = this.database
      .prepare(
        `SELECT id, chat_id, run_id, role, status, content, created_at, updated_at
         FROM messages
         WHERE run_id = ?
         ORDER BY created_at, id`,
      )
      .all(runId) as MessageRow[];
    return rows.map(readMessage);
  }

  getSnapshot(chatId: string): ChatPersistenceSnapshot | null {
    const chat = this.getChat(chatId);
    if (!chat) {
      return null;
    }

    const messageRows = this.database
      .prepare(
        `SELECT id, chat_id, run_id, role, status, content, created_at, updated_at
         FROM messages
         WHERE chat_id = ?
         ORDER BY created_at, id`,
      )
      .all(chatId) as MessageRow[];
    const attachmentRows = this.database
      .prepare(
        `SELECT id, chat_id, message_id, kind, display_name, storage_key,
                media_type, byte_length, sha256, created_at
         FROM attachments
         WHERE chat_id = ?
         ORDER BY created_at, id`,
      )
      .all(chatId) as AttachmentRow[];

    return {
      attachments: attachmentRows.map(readAttachment),
      chat,
      messages: messageRows.map(readMessage),
    };
  }
}
