import { contextBridge, ipcRenderer } from "electron";

import {
  type DesktopApi,
  FOUNDATION_CHANNELS,
} from "../shared/contracts/foundation";
import { FoundationSnapshotSchema } from "../shared/schemas/foundation";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

const desktopApi: DesktopApi = Object.freeze({
  foundation: Object.freeze({
    getSnapshot: async () =>
      parseSchemaWithoutCodeGeneration(
        FoundationSnapshotSchema,
        await ipcRenderer.invoke(FOUNDATION_CHANNELS.getSnapshot, {}),
      ),
    markRendererReady: () => {
      ipcRenderer.send(FOUNDATION_CHANNELS.rendererReady, {});
    },
  }),
});

contextBridge.exposeInMainWorld("charaMate", desktopApi);
