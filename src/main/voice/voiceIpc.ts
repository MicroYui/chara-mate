import { ipcMain, type BrowserWindow } from "electron";

import { VOICE_CHANNELS } from "../../shared/contracts/voice";
import {
  VoiceDriverEventRequestSchema,
  VoiceEmptyRequestSchema,
  VoiceMutedRequestSchema,
  VoiceMutationResponseSchema,
  VoicePreviewRequestSchema,
  VoicePreviewResponseSchema,
  VoiceQuickStartRequestSchema,
  VoiceQuickStartResponseSchema,
  VoiceSessionRequestSchema,
  VoiceSnapshotResponseSchema,
  VoiceStartRequestSchema,
  VoiceStartResponseSchema,
} from "../../shared/schemas/voice";
import { parseSchema } from "../../shared/schemas/validation";
import { toVoiceAppError } from "./voiceError";
import type { VoiceService } from "./voiceService";

function senderMatches(
  sender: Electron.WebContents,
  window: BrowserWindow | null,
): boolean {
  return Boolean(
    window && !window.isDestroyed() && window.webContents.id === sender.id,
  );
}

export function registerVoiceIpc(
  service: VoiceService,
  getMainWindow: () => BrowserWindow | null,
  getCharacterWindow: () => BrowserWindow | null,
): () => void {
  const requireMain = (sender: Electron.WebContents): void => {
    if (!senderMatches(sender, getMainWindow())) {
      throw new Error("Main window Voice IPC sender rejected.");
    }
  };
  const requireVoiceWindow = (sender: Electron.WebContents): void => {
    if (
      !senderMatches(sender, getMainWindow()) &&
      !senderMatches(sender, getCharacterWindow())
    ) {
      throw new Error("Voice IPC sender rejected.");
    }
  };
  const requireCharacter = (sender: Electron.WebContents): void => {
    if (!senderMatches(sender, getCharacterWindow())) {
      throw new Error("Character Voice IPC sender rejected.");
    }
  };

  ipcMain.handle(VOICE_CHANNELS.getActive, (event, input) => {
    try {
      requireVoiceWindow(event.sender);
      parseSchema(VoiceEmptyRequestSchema, input);
      return parseSchema(VoiceSnapshotResponseSchema, {
        ok: true,
        value: service.getActive(),
      });
    } catch (error) {
      return parseSchema(VoiceSnapshotResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_CHANNELS.start, async (event, input) => {
    try {
      requireMain(event.sender);
      const request = parseSchema(VoiceStartRequestSchema, input);
      return parseSchema(VoiceStartResponseSchema, {
        ok: true,
        value: await service.start(request),
      });
    } catch (error) {
      return parseSchema(VoiceStartResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_CHANNELS.preview, async (event, input) => {
    try {
      requireMain(event.sender);
      const request = parseSchema(VoicePreviewRequestSchema, input);
      return parseSchema(VoicePreviewResponseSchema, {
        ok: true,
        value: await service.preview(request),
      });
    } catch (error) {
      return parseSchema(VoicePreviewResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_CHANNELS.quickStart, async (event, input) => {
    try {
      requireCharacter(event.sender);
      const request = parseSchema(VoiceQuickStartRequestSchema, input);
      return parseSchema(VoiceQuickStartResponseSchema, {
        ok: true,
        value: await service.quickStart(request),
      });
    } catch (error) {
      return parseSchema(VoiceQuickStartResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_CHANNELS.event, async (event, input) => {
    try {
      requireVoiceWindow(event.sender);
      const request = parseSchema(VoiceDriverEventRequestSchema, input);
      return parseSchema(VoiceMutationResponseSchema, {
        ok: true,
        value: await service.report(request),
      });
    } catch (error) {
      return parseSchema(VoiceMutationResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_CHANNELS.setMuted, (event, input) => {
    try {
      requireVoiceWindow(event.sender);
      const request = parseSchema(VoiceMutedRequestSchema, input);
      return parseSchema(VoiceMutationResponseSchema, {
        ok: true,
        value: service.setMuted(request.sessionId, request.muted),
      });
    } catch (error) {
      return parseSchema(VoiceMutationResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(VOICE_CHANNELS.end, (event, input) => {
    try {
      requireVoiceWindow(event.sender);
      const request = parseSchema(VoiceSessionRequestSchema, input);
      return parseSchema(VoiceMutationResponseSchema, {
        ok: true,
        value: service.end(request),
      });
    } catch (error) {
      return parseSchema(VoiceMutationResponseSchema, {
        error: toVoiceAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of [
      VOICE_CHANNELS.end,
      VOICE_CHANNELS.event,
      VOICE_CHANNELS.getActive,
      VOICE_CHANNELS.preview,
      VOICE_CHANNELS.quickStart,
      VOICE_CHANNELS.setMuted,
      VOICE_CHANNELS.start,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
