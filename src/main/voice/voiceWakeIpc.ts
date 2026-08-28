import { ipcMain, type BrowserWindow } from "electron";

import { VOICE_WAKE_CHANNELS } from "../../shared/contracts/voiceWake";
import {
  VoiceWakeEmptyRequestSchema,
  VoiceWakeReportRequestSchema,
  VoiceWakeSetEnabledRequestSchema,
  VoiceWakeSnapshotResponseSchema,
} from "../../shared/schemas/voiceWake";
import { parseSchema } from "../../shared/schemas/validation";
import type { VoiceWakeService } from "./voiceWakeService";

function senderMatches(
  sender: Electron.WebContents,
  window: BrowserWindow | null,
): boolean {
  return Boolean(
    window && !window.isDestroyed() && window.webContents.id === sender.id,
  );
}

function operationError(error: unknown) {
  return {
    code: "VOICE_WAKE.OPERATION_FAILED",
    message: error instanceof Error ? error.message : "语音唤醒操作没有完成。",
    retryable: false,
  };
}

export function registerVoiceWakeIpc(
  service: VoiceWakeService,
  getMainWindow: () => BrowserWindow | null,
  isCharacterWindowSender: (sender: Electron.WebContents) => boolean,
): () => void {
  const requireApplicationWindow = (sender: Electron.WebContents): void => {
    if (
      !senderMatches(sender, getMainWindow()) &&
      !isCharacterWindowSender(sender)
    ) {
      throw new Error("Voice Wake IPC sender rejected.");
    }
  };
  const requireMain = (sender: Electron.WebContents): void => {
    if (!senderMatches(sender, getMainWindow())) {
      throw new Error("Main window Voice Wake IPC sender rejected.");
    }
  };
  const requireCharacter = (sender: Electron.WebContents): void => {
    if (!isCharacterWindowSender(sender)) {
      throw new Error("Character Voice Wake IPC sender rejected.");
    }
  };

  ipcMain.handle(VOICE_WAKE_CHANNELS.getSnapshot, (event, input) => {
    try {
      requireApplicationWindow(event.sender);
      parseSchema(VoiceWakeEmptyRequestSchema, input);
      return parseSchema(VoiceWakeSnapshotResponseSchema, {
        ok: true,
        value: service.getSnapshot(),
      });
    } catch (error) {
      return parseSchema(VoiceWakeSnapshotResponseSchema, {
        error: operationError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_WAKE_CHANNELS.setEnabled, async (event, input) => {
    try {
      requireMain(event.sender);
      const request = parseSchema(VoiceWakeSetEnabledRequestSchema, input);
      return parseSchema(VoiceWakeSnapshotResponseSchema, {
        ok: true,
        value: await service.setEnabled(request.enabled),
      });
    } catch (error) {
      return parseSchema(VoiceWakeSnapshotResponseSchema, {
        error: operationError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_WAKE_CHANNELS.report, (event, input) => {
    try {
      requireCharacter(event.sender);
      const request = parseSchema(VoiceWakeReportRequestSchema, input);
      return parseSchema(VoiceWakeSnapshotResponseSchema, {
        ok: true,
        value: service.report(request),
      });
    } catch (error) {
      return parseSchema(VoiceWakeSnapshotResponseSchema, {
        error: operationError(error),
        ok: false,
      });
    }
  });

  return () => {
    ipcMain.removeHandler(VOICE_WAKE_CHANNELS.getSnapshot);
    ipcMain.removeHandler(VOICE_WAKE_CHANNELS.report);
    ipcMain.removeHandler(VOICE_WAKE_CHANNELS.setEnabled);
  };
}
