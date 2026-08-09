import { ipcRenderer } from "electron";

import {
  VOICE_CHANNELS,
  type VoiceApi,
  type VoiceClientCommand,
  type VoiceDriverEventRequest,
  type VoiceMutedRequest,
  type VoicePreviewRequest,
  type VoiceQuickStartRequest,
  type VoiceSessionRequest,
  type VoiceSessionSnapshot,
  type VoiceStartRequest,
} from "../shared/contracts/voice";
import {
  VoiceClientCommandSchema,
  VoiceDriverEventRequestSchema,
  VoiceMutedRequestSchema,
  VoiceMutationResponseSchema,
  VoicePreviewRequestSchema,
  VoicePreviewResponseSchema,
  VoiceQuickStartRequestSchema,
  VoiceQuickStartResponseSchema,
  VoiceSessionRequestSchema,
  VoiceSessionSnapshotSchema,
  VoiceSnapshotResponseSchema,
  VoiceStartRequestSchema,
  VoiceStartResponseSchema,
} from "../shared/schemas/voice";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

export function createVoiceApi(): VoiceApi {
  return Object.freeze({
    end: async (input: VoiceSessionRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceMutationResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.end,
          parseSchemaWithoutCodeGeneration(VoiceSessionRequestSchema, input),
        ),
      ),
    getActive: async () =>
      parseSchemaWithoutCodeGeneration(
        VoiceSnapshotResponseSchema,
        await ipcRenderer.invoke(VOICE_CHANNELS.getActive, {}),
      ),
    preview: async (input: VoicePreviewRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoicePreviewResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.preview,
          parseSchemaWithoutCodeGeneration(VoicePreviewRequestSchema, input),
        ),
      ),
    quickStart: async (input: VoiceQuickStartRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceQuickStartResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.quickStart,
          parseSchemaWithoutCodeGeneration(VoiceQuickStartRequestSchema, input),
        ),
      ),
    report: async (input: VoiceDriverEventRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceMutationResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.event,
          parseSchemaWithoutCodeGeneration(
            VoiceDriverEventRequestSchema,
            input,
          ),
        ),
      ),
    setMuted: async (input: VoiceMutedRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceMutationResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.setMuted,
          parseSchemaWithoutCodeGeneration(VoiceMutedRequestSchema, input),
        ),
      ),
    start: async (input: VoiceStartRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceStartResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.start,
          parseSchemaWithoutCodeGeneration(VoiceStartRequestSchema, input),
        ),
      ),
    subscribeChanged: (
      listener: (snapshot: VoiceSessionSnapshot | null) => void,
    ) => {
      const wrapped = (_event: Electron.IpcRendererEvent, input: unknown) => {
        listener(
          input === null
            ? null
            : parseSchemaWithoutCodeGeneration(
                VoiceSessionSnapshotSchema,
                input,
              ),
        );
      };
      ipcRenderer.on(VOICE_CHANNELS.changed, wrapped);
      return () => ipcRenderer.off(VOICE_CHANNELS.changed, wrapped);
    },
    subscribeCommand: (listener: (command: VoiceClientCommand) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, input: unknown) => {
        listener(
          parseSchemaWithoutCodeGeneration(VoiceClientCommandSchema, input),
        );
      };
      ipcRenderer.on(VOICE_CHANNELS.command, wrapped);
      return () => ipcRenderer.off(VOICE_CHANNELS.command, wrapped);
    },
  });
}
