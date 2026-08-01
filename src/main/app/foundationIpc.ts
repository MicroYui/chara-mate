import type { WebContents } from "electron";
import { ipcMain } from "electron";

import {
  FOUNDATION_CHANNELS,
  FoundationSnapshotSchema,
  type FoundationSnapshot,
} from "../../shared/contracts/foundation";
import { parseSchema } from "../../shared/schemas/validation";

export function registerFoundationIpc(
  snapshot: FoundationSnapshot,
  onRendererReady: (sender: WebContents) => void,
): () => void {
  const validatedSnapshot = parseSchema(FoundationSnapshotSchema, snapshot);
  const handleSnapshot = (): FoundationSnapshot => validatedSnapshot;
  const handleRendererReady = (event: Electron.IpcMainEvent): void => {
    onRendererReady(event.sender);
  };

  ipcMain.handle(FOUNDATION_CHANNELS.getSnapshot, handleSnapshot);
  ipcMain.on(FOUNDATION_CHANNELS.rendererReady, handleRendererReady);

  return () => {
    ipcMain.removeHandler(FOUNDATION_CHANNELS.getSnapshot);
    ipcMain.off(FOUNDATION_CHANNELS.rendererReady, handleRendererReady);
  };
}
