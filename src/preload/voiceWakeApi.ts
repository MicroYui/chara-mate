import { ipcRenderer } from "electron";

import {
  VOICE_WAKE_CHANNELS,
  type VoiceWakeCharacterApi,
  type VoiceWakeReportRequest,
  type VoiceWakeSetEnabledRequest,
  type VoiceWakeSettingsApi,
  type VoiceWakeSnapshot,
} from "../shared/contracts/voiceWake";
import {
  VoiceWakeReportRequestSchema,
  VoiceWakeSetEnabledRequestSchema,
  VoiceWakeSnapshotResponseSchema,
  VoiceWakeSnapshotSchema,
} from "../shared/schemas/voiceWake";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

function getSnapshot() {
  return Promise.resolve(
    ipcRenderer.invoke(VOICE_WAKE_CHANNELS.getSnapshot, {}),
  ).then((value) =>
    parseSchemaWithoutCodeGeneration(VoiceWakeSnapshotResponseSchema, value),
  );
}

function subscribe(listener: (snapshot: VoiceWakeSnapshot) => void) {
  const wrapped = (_event: Electron.IpcRendererEvent, input: unknown): void => {
    listener(parseSchemaWithoutCodeGeneration(VoiceWakeSnapshotSchema, input));
  };
  ipcRenderer.on(VOICE_WAKE_CHANNELS.changed, wrapped);
  return () => ipcRenderer.off(VOICE_WAKE_CHANNELS.changed, wrapped);
}

export function createVoiceWakeSettingsApi(): VoiceWakeSettingsApi {
  return Object.freeze({
    getSnapshot,
    setEnabled: async (input: VoiceWakeSetEnabledRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceWakeSnapshotResponseSchema,
        await ipcRenderer.invoke(
          VOICE_WAKE_CHANNELS.setEnabled,
          parseSchemaWithoutCodeGeneration(
            VoiceWakeSetEnabledRequestSchema,
            input,
          ),
        ),
      ),
    subscribe,
  });
}

export function createVoiceWakeCharacterApi(): VoiceWakeCharacterApi {
  return Object.freeze({
    getSnapshot,
    report: async (input: VoiceWakeReportRequest) =>
      parseSchemaWithoutCodeGeneration(
        VoiceWakeSnapshotResponseSchema,
        await ipcRenderer.invoke(
          VOICE_WAKE_CHANNELS.report,
          parseSchemaWithoutCodeGeneration(VoiceWakeReportRequestSchema, input),
        ),
      ),
    subscribe,
  });
}
