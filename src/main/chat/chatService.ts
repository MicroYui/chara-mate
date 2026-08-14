import type {
  Chat,
  ChatCreateRequest,
  ChatDataSnapshotRequest,
  ChatDataSnapshotResponse,
  ChatIdRequest,
  ChatListRequest,
  ChatRenameRequest,
  ChatSetPinnedRequest,
} from "../../shared/contracts/chat";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import {
  ChatCreateRequestSchema,
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
  ChatIdRequestSchema,
  ChatListRequestSchema,
  ChatRenameRequestSchema,
  ChatSetPinnedRequestSchema,
} from "../../shared/schemas/chat";
import { parseSchema } from "../../shared/schemas/validation";
import type { RunRepository } from "../agent/runRepository";
import { ChatError } from "./chatError";
import type { ChatRepository } from "./chatRepository";
import { fallbackChatTitle } from "./chatTitle";

export class ChatService {
  readonly #turnTails = new Map<string, Promise<void>>();

  constructor(
    private readonly chats: ChatRepository,
    private readonly runs: RunRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly publishChanged: (chat: Chat) => void = () => undefined,
  ) {}

  archive(input: ChatIdRequest): Chat {
    const request = parseSchema(ChatIdRequestSchema, input);
    const current = this.#requireChat(request.chatId);
    if (current.status === "archived") {
      return current;
    }
    const now = this.clock.now();
    return this.#updateChat({
      ...current,
      archivedAt: now,
      status: "archived",
      updatedAt: now,
    });
  }

  create(input: ChatCreateRequest): Chat {
    return this.#create(input, false);
  }

  createProvisional(input: ChatCreateRequest): Chat {
    return this.#create(input, true);
  }

  discardAllProvisional(): number {
    try {
      return this.chats.deleteAllProvisionalChats();
    } catch {
      throw new ChatError(
        "CHAT.STORAGE_FAILED",
        "无法清理未开始的会话。",
        true,
      );
    }
  }

  discardProvisional(chatId: string): boolean {
    try {
      return this.chats.deleteProvisionalChat(chatId);
    } catch {
      throw new ChatError(
        "CHAT.STORAGE_FAILED",
        "无法清理未开始的会话。",
        true,
      );
    }
  }

  establishProvisional(chatId: string): Chat {
    const current = this.#requireChat(chatId);
    if (!this.chats.isProvisionalChat(chatId)) return current;
    try {
      const established = this.chats.establishProvisionalChat(
        chatId,
        this.clock.now(),
      );
      if (!established) {
        throw new Error("Provisional Chat changed before establishment");
      }
      this.#publishChanged(established);
      return established;
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法开始这段对话。", true);
    }
  }

  #create(input: ChatCreateRequest, provisional: boolean): Chat {
    const request = parseSchema(ChatCreateRequestSchema, input);
    const now = this.clock.now();
    try {
      const chat = this.chats.insertChat(
        {
          createdAt: now,
          id: this.idGenerator.generate(),
          status: "active",
          title:
            request.title?.trim() || fallbackChatTitle(request.initialMessage),
          updatedAt: now,
        },
        { provisional },
      );
      if (!provisional) this.#publishChanged(chat);
      return chat;
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法创建会话。", true);
    }
  }

  adoptFirstMessageTitle(
    chatId: string,
    expectedPlaceholder: string,
    firstMessage: string,
  ): Chat {
    const current = this.#requireChat(chatId);
    if (
      current.title !== expectedPlaceholder ||
      this.chats.listMessages(chatId).some(({ role }) => role === "user")
    ) {
      return current;
    }
    const title = fallbackChatTitle(firstMessage);
    if (title === current.title) return current;
    return this.#updateChat({
      ...current,
      title,
      updatedAt: this.clock.now(),
    });
  }

  delete(input: ChatIdRequest): { chatId: string } {
    const request = parseSchema(ChatIdRequestSchema, input);
    this.#requireChat(request.chatId);
    try {
      if (!this.chats.deleteChat(request.chatId)) {
        throw new Error("Chat disappeared before delete");
      }
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法删除会话。", true);
    }
    return { chatId: request.chatId };
  }

  getSnapshot(input: ChatDataSnapshotRequest): ChatDataSnapshotResponse {
    const request = parseSchema(ChatDataSnapshotRequestSchema, input);
    let chatSnapshot;
    try {
      chatSnapshot = this.chats.getSnapshot(request.chatId);
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法读取会话。", true);
    }
    if (!chatSnapshot) {
      return null;
    }

    let runSnapshot;
    try {
      runSnapshot = this.runs.getSnapshot(request.chatId);
    } catch {
      throw new ChatError(
        "CHAT.STORAGE_FAILED",
        "无法读取会话运行记录。",
        true,
      );
    }

    return parseSchema(ChatDataSnapshotResponseSchema, {
      ...chatSnapshot,
      ...runSnapshot,
    });
  }

  list(input: ChatListRequest): Chat[] {
    const request = parseSchema(ChatListRequestSchema, input);
    try {
      return this.chats.listChats({
        ...(request.query?.trim() ? { query: request.query.trim() } : {}),
        status: request.status,
      });
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法读取会话列表。", true);
    }
  }

  rename(input: ChatRenameRequest): Chat {
    const request = parseSchema(ChatRenameRequestSchema, input);
    const current = this.#requireChat(request.chatId);
    const title = request.title.trim();
    if (current.title === title) {
      return current;
    }
    return this.#updateChat({
      ...current,
      title,
      updatedAt: this.clock.now(),
    });
  }

  replaceGeneratedTitle(
    chatId: string,
    expectedTitle: string,
    generatedTitle: string,
  ): Chat | undefined {
    const current = this.#requireChat(chatId);
    const title = generatedTitle.trim();
    if (current.title !== expectedTitle || !title) return undefined;
    if (current.title === title) return current;
    return this.#updateChat({
      ...current,
      title,
      updatedAt: this.clock.now(),
    });
  }

  restore(input: ChatIdRequest): Chat {
    const request = parseSchema(ChatIdRequestSchema, input);
    const current = this.#requireChat(request.chatId);
    if (current.status === "active") {
      return current;
    }
    const restored = { ...current };
    delete restored.archivedAt;
    return this.#updateChat({
      ...restored,
      status: "active",
      updatedAt: this.clock.now(),
    });
  }

  async runSerializedTurn<TResult>(
    chatId: string,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const request = parseSchema(ChatIdRequestSchema, { chatId });
    const predecessor = this.#turnTails.get(request.chatId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentTail = (predecessor ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => gate);
    this.#turnTails.set(request.chatId, currentTail);

    await predecessor?.catch(() => undefined);
    try {
      const chat = this.#requireChat(request.chatId);
      if (chat.status === "archived") {
        throw new ChatError(
          "CHAT.ARCHIVED",
          "请先恢复已归档会话，再开始新一轮。",
          false,
        );
      }
      if (this.runs.getActiveRun(request.chatId)) {
        throw new ChatError(
          "CHAT.TURN_ACTIVE",
          "该会话已有正在进行的 Turn。",
          false,
        );
      }
      return await operation();
    } finally {
      release();
      if (this.#turnTails.get(request.chatId) === currentTail) {
        this.#turnTails.delete(request.chatId);
      }
    }
  }

  setPinned(input: ChatSetPinnedRequest): Chat {
    const request = parseSchema(ChatSetPinnedRequestSchema, input);
    const current = this.#requireChat(request.chatId);
    if (request.pinned === (current.pinnedAt !== undefined)) {
      return current;
    }
    const now = this.clock.now();
    if (request.pinned) {
      return this.#updateChat({
        ...current,
        pinnedAt: now,
        updatedAt: now,
      });
    }
    const unpinned = { ...current };
    delete unpinned.pinnedAt;
    return this.#updateChat({ ...unpinned, updatedAt: now });
  }

  #requireChat(chatId: string): Chat {
    let chat;
    try {
      chat = this.chats.getChat(chatId);
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法读取会话。", true);
    }
    if (!chat) {
      throw new ChatError("CHAT.NOT_FOUND", "会话不存在。", false);
    }
    return chat;
  }

  #updateChat(chat: Chat): Chat {
    try {
      const updated = this.chats.updateChat(chat);
      this.#publishChanged(updated);
      return updated;
    } catch {
      throw new ChatError("CHAT.STORAGE_FAILED", "无法保存会话。", true);
    }
  }

  #publishChanged(chat: Chat): void {
    try {
      this.publishChanged(chat);
    } catch {
      // A Renderer notification must never roll back a durable Chat mutation.
    }
  }
}
