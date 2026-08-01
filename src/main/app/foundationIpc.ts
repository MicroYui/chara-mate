import type { WebContents } from "electron";
import { ipcMain } from "electron";

import {
  FOUNDATION_CHANNELS,
  type FoundationSnapshot,
} from "../../shared/contracts/foundation";
import {
  FoundationRequestSchema,
  FoundationSnapshotSchema,
} from "../../shared/schemas/foundation";
import { parseSchema } from "../../shared/schemas/validation";

export function registerFoundationIpc(
  snapshot: FoundationSnapshot,
  onRendererReady: (sender: WebContents) => void,
): () => void {
  const validatedSnapshot = parseSchema(FoundationSnapshotSchema, snapshot);
  const handleSnapshot = (
    _event: Electron.IpcMainInvokeEvent,
    request: unknown,
  ): FoundationSnapshot => {
    parseSchema(FoundationRequestSchema, request);
    return validatedSnapshot;
  };
  const handleRendererReady = (
    event: Electron.IpcMainEvent,
    request: unknown,
  ): void => {
    parseSchema(FoundationRequestSchema, request);
    onRendererReady(event.sender);
  };

  ipcMain.handle(FOUNDATION_CHANNELS.getSnapshot, handleSnapshot);
  ipcMain.on(FOUNDATION_CHANNELS.rendererReady, handleRendererReady);

  return () => {
    ipcMain.removeHandler(FOUNDATION_CHANNELS.getSnapshot);
    ipcMain.off(FOUNDATION_CHANNELS.rendererReady, handleRendererReady);
  };
}
