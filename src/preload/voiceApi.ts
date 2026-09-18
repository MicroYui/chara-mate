import { ipcRenderer } from "electron";

import {
  VOICE_CHANNELS,
  type VoiceApi,
  type VoiceCancelStartRequest,
  type VoiceClientCommand,
  type VoiceDriverEventRequest,
  type VoiceMutedRequest,
  type VoicePausedSubmission,
  type VoicePreviewSubmission,
  type VoiceQuickStartSubmission,
  type VoiceSessionRequest,
  type VoiceSessionSnapshot,
  type VoiceStartSubmission,
} from "../shared/contracts/voice";
import {
  VoiceCancelStartRequestSchema,
  VoiceCancelStartResponseSchema,
  VoiceClientCommandSchema,
  VoiceDriverEventRequestSchema,
  VoiceMutedRequestSchema,
  VoiceMutationResponseSchema,
  VoicePausedSubmissionSchema,
  VoicePauseResponseSchema,
  VoicePreviewSubmissionSchema,
  VoicePreviewResponseSchema,
  VoiceQuickStartSubmissionSchema,
  VoiceQuickStartResponseSchema,
  VoiceSessionRequestSchema,
  VoiceSessionSnapshotSchema,
  VoiceSnapshotResponseSchema,
  VoiceStartSubmissionSchema,
  VoiceStartResponseSchema,
} from "../shared/schemas/voice";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

export function createVoiceApi(): VoiceApi {
  return Object.freeze({
    cancelStart: async (input: VoiceCancelStartRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceCancelStartResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.cancelStart,
          parseSchemaWithoutCodeGeneration(
            VoiceCancelStartRequestSchema,
            input,
          ),
        ),
      ),
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
    preview: async (input: VoicePreviewSubmission) =>
      parseSchemaWithoutCodeGeneration(
        VoicePreviewResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.preview,
          parseSchemaWithoutCodeGeneration(VoicePreviewSubmissionSchema, input),
        ),
      ),
    quickStart: async (input: VoiceQuickStartSubmission) =>
      parseSchemaWithoutCodeGeneration(
        VoiceQuickStartResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.quickStart,
          parseSchemaWithoutCodeGeneration(
            VoiceQuickStartSubmissionSchema,
            input,
          ),
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
    setPaused: async (input: VoicePausedSubmission) =>
      parseSchemaWithoutCodeGeneration(
        VoicePauseResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.setPaused,
          parseSchemaWithoutCodeGeneration(VoicePausedSubmissionSchema, input),
        ),
      ),
    start: async (input: VoiceStartSubmission) =>
      parseSchemaWithoutCodeGeneration(
        VoiceStartResponseSchema,
        await ipcRenderer.invoke(
          VOICE_CHANNELS.start,
          parseSchemaWithoutCodeGeneration(VoiceStartSubmissionSchema, input),
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
