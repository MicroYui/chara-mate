import { ipcMain } from "electron";

import { CHAT_CHANNELS } from "../../shared/contracts/chat";
import { RUN_EVENT_CHANNELS } from "../../shared/contracts/ipc";
import {
  ChatCreateRequestSchema,
  ChatDataSnapshotRequestSchema,
  ChatDeleteResponseSchema,
  ChatGetSnapshotResponseSchema,
  ChatIdRequestSchema,
  ChatListRequestSchema,
  ChatListResponseSchema,
  ChatMutationResponseSchema,
  ChatRenameRequestSchema,
  ChatSetPinnedRequestSchema,
} from "../../shared/schemas/chat";
import {
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../../shared/schemas/ipc";
import { parseSchema } from "../../shared/schemas/validation";
import type { RunEventService } from "../agent/runEventService";
import { toChatAppError } from "../chat/chatError";
import type { ChatService } from "../chat/chatService";

export function registerChatIpc(
  chatService: ChatService,
  runEvents: RunEventService,
): () => void {
  const handleReplay = (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown,
  ): unknown => {
    const request = parseSchema(RunEventReplayRequestSchema, input);
    return parseSchema(RunEventReplayResponseSchema, runEvents.replay(request));
  };

  ipcMain.handle(CHAT_CHANNELS.list, (_event, input) => {
    try {
      const request = parseSchema(ChatListRequestSchema, input);
      return parseSchema(ChatListResponseSchema, {
        ok: true,
        value: chatService.list(request),
      });
    } catch (error) {
      return parseSchema(ChatListResponseSchema, {
        error: toChatAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(CHAT_CHANNELS.getSnapshot, (_event, input) => {
    try {
      const request = parseSchema(ChatDataSnapshotRequestSchema, input);
      return parseSchema(ChatGetSnapshotResponseSchema, {
        ok: true,
        value: chatService.getSnapshot(request),
      });
    } catch (error) {
      return parseSchema(ChatGetSnapshotResponseSchema, {
        error: toChatAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(CHAT_CHANNELS.create, (_event, input) => {
    try {
      const request = parseSchema(ChatCreateRequestSchema, input);
      return parseSchema(ChatMutationResponseSchema, {
        ok: true,
        value: chatService.create(request),
      });
    } catch (error) {
      return parseSchema(ChatMutationResponseSchema, {
        error: toChatAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(CHAT_CHANNELS.rename, (_event, input) => {
    try {
      const request = parseSchema(ChatRenameRequestSchema, input);
      return parseSchema(ChatMutationResponseSchema, {
        ok: true,
        value: chatService.rename(request),
      });
    } catch (error) {
      return parseSchema(ChatMutationResponseSchema, {
        error: toChatAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(CHAT_CHANNELS.setPinned, (_event, input) => {
    try {
      const request = parseSchema(ChatSetPinnedRequestSchema, input);
      return parseSchema(ChatMutationResponseSchema, {
        ok: true,
        value: chatService.setPinned(request),
      });
    } catch (error) {
      return parseSchema(ChatMutationResponseSchema, {
        error: toChatAppError(error),
        ok: false,
      });
    }
  });
  for (const [channel, action] of [
    [
      CHAT_CHANNELS.archive,
      (request: { chatId: string }) => chatService.archive(request),
    ],
    [
      CHAT_CHANNELS.restore,
      (request: { chatId: string }) => chatService.restore(request),
    ],
  ] as const) {
    ipcMain.handle(channel, (_event, input) => {
      try {
        const request = parseSchema(ChatIdRequestSchema, input);
        return parseSchema(ChatMutationResponseSchema, {
          ok: true,
          value: action(request),
        });
      } catch (error) {
        return parseSchema(ChatMutationResponseSchema, {
          error: toChatAppError(error),
          ok: false,
        });
      }
    });
  }
  ipcMain.handle(CHAT_CHANNELS.delete, (_event, input) => {
    try {
      const request = parseSchema(ChatIdRequestSchema, input);
      return parseSchema(ChatDeleteResponseSchema, {
        ok: true,
        value: chatService.delete(request),
      });
    } catch (error) {
      return parseSchema(ChatDeleteResponseSchema, {
        error: toChatAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(RUN_EVENT_CHANNELS.replay, handleReplay);

  return () => {
    for (const channel of Object.values(CHAT_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeHandler(RUN_EVENT_CHANNELS.replay);
  };
}
