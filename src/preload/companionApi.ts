import { ipcRenderer } from "electron";

import {
  type CompanionApi,
  COMPANION_DESKTOP_CHANNELS,
  type CompanionDesktopSetNotificationsEnabledRequest,
  type CompanionDesktopSnapshot,
  type CompanionDesktopUnpairRequest,
} from "../shared/contracts/companion";
import {
  CompanionDesktopEmptyRequestSchema,
  CompanionDesktopSetNotificationsEnabledRequestSchema,
  CompanionDesktopSnapshotResponseSchema,
  CompanionDesktopSnapshotSchema,
  CompanionDesktopUnpairRequestSchema,
} from "../shared/schemas/companion";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

export function createCompanionApi(): CompanionApi {
  return Object.freeze({
    getSnapshot: async () =>
      parseSchemaWithoutCodeGeneration(
        CompanionDesktopSnapshotResponseSchema,
        await ipcRenderer.invoke(
          COMPANION_DESKTOP_CHANNELS.getSnapshot,
          parseSchemaWithoutCodeGeneration(
            CompanionDesktopEmptyRequestSchema,
            {},
          ),
        ),
      ),
    setNotificationsEnabled: async (
      input: CompanionDesktopSetNotificationsEnabledRequest,
    ) =>
      parseSchemaWithoutCodeGeneration(
        CompanionDesktopSnapshotResponseSchema,
        await ipcRenderer.invoke(
          COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled,
          parseSchemaWithoutCodeGeneration(
            CompanionDesktopSetNotificationsEnabledRequestSchema,
            input,
          ),
        ),
      ),
    startPairing: async () =>
      parseSchemaWithoutCodeGeneration(
        CompanionDesktopSnapshotResponseSchema,
        await ipcRenderer.invoke(
          COMPANION_DESKTOP_CHANNELS.startPairing,
          parseSchemaWithoutCodeGeneration(
            CompanionDesktopEmptyRequestSchema,
            {},
          ),
        ),
      ),
    subscribeChanged: (
      listener: (snapshot: CompanionDesktopSnapshot) => void,
    ) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        input: unknown,
      ): void => {
        listener(
          parseSchemaWithoutCodeGeneration(
            CompanionDesktopSnapshotSchema,
            input,
          ),
        );
      };
      ipcRenderer.on(COMPANION_DESKTOP_CHANNELS.changed, wrapped);
      return () => ipcRenderer.off(COMPANION_DESKTOP_CHANNELS.changed, wrapped);
    },
    unpair: async (input: CompanionDesktopUnpairRequest) =>
      parseSchemaWithoutCodeGeneration(
        CompanionDesktopSnapshotResponseSchema,
        await ipcRenderer.invoke(
          COMPANION_DESKTOP_CHANNELS.unpair,
          parseSchemaWithoutCodeGeneration(
            CompanionDesktopUnpairRequestSchema,
            input,
          ),
        ),
      ),
  });
}
