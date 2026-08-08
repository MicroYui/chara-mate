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

interface ChatRow {
  archived_at: string | null;
  created_at: string;
  id: string;
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

export class ChatRepository {
  constructor(private readonly database: Database.Database) {}

  insertChat(chat: Chat): Chat {
    const persisted = sanitizeForPersistence(ChatSchema, chat);
    this.database
      .prepare(
        `INSERT INTO chats (
          id, title, status, pinned_at, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        persisted.id,
        persisted.title,
        persisted.status,
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

  getChat(chatId: string): Chat | undefined {
    const row = this.database
      .prepare(
        `SELECT id, title, status, pinned_at, archived_at, created_at, updated_at
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
              `SELECT id, title, status, pinned_at, archived_at, created_at, updated_at
               FROM chats
               WHERE status = ? AND instr(lower(title), lower(?)) > 0
               ORDER BY (pinned_at IS NULL), pinned_at DESC, updated_at DESC, id`,
            )
            .all(filter.status, query)
        : this.database
            .prepare(
              `SELECT id, title, status, pinned_at, archived_at, created_at, updated_at
               FROM chats
               WHERE status = ?
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
