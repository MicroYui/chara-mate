import { ipcMain } from "electron";

import { CHAT_DATA_CHANNELS } from "../../shared/contracts/chat";
import { RUN_EVENT_CHANNELS } from "../../shared/contracts/ipc";
import {
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
} from "../../shared/schemas/chat";
import {
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../../shared/schemas/ipc";
import { parseSchema } from "../../shared/schemas/validation";
import type { RunEventService } from "../agent/runEventService";
import type { ChatDataService } from "../chat/chatDataService";

export function registerChatDataIpc(
  chatData: ChatDataService,
  runEvents: RunEventService,
): () => void {
  const handleSnapshot = (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown,
  ): unknown => {
    const request = parseSchema(ChatDataSnapshotRequestSchema, input);
    return parseSchema(
      ChatDataSnapshotResponseSchema,
      chatData.getSnapshot(request),
    );
  };
  const handleReplay = (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown,
  ): unknown => {
    const request = parseSchema(RunEventReplayRequestSchema, input);
    return parseSchema(RunEventReplayResponseSchema, runEvents.replay(request));
  };

  ipcMain.handle(CHAT_DATA_CHANNELS.getSnapshot, handleSnapshot);
  ipcMain.handle(RUN_EVENT_CHANNELS.replay, handleReplay);

  return () => {
    ipcMain.removeHandler(CHAT_DATA_CHANNELS.getSnapshot);
    ipcMain.removeHandler(RUN_EVENT_CHANNELS.replay);
  };
}
