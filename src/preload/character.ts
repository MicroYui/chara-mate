import { contextBridge, ipcRenderer } from "electron";

import {
  type CharacterWindowApi,
  PET_CHANNELS,
  type PetCharacterSnapshot,
  type PetDragPoint,
} from "../shared/contracts/pet";
import {
  PetCharacterSnapshotSchema,
  PetDragPointSchema,
  PetDragResultSchema,
} from "../shared/schemas/pet";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

const characterApi: CharacterWindowApi = Object.freeze({
  endDrag: async (input: PetDragPoint) =>
    parseSchemaWithoutCodeGeneration(
      PetDragResultSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.dragEnd,
        parseSchemaWithoutCodeGeneration(PetDragPointSchema, input),
      ),
    ),
  focusMain: () => ipcRenderer.send(PET_CHANNELS.focusMain, {}),
  getSnapshot: async () =>
    parseSchemaWithoutCodeGeneration(
      PetCharacterSnapshotSchema,
      await ipcRenderer.invoke(PET_CHANNELS.characterGetSnapshot, {}),
    ),
  markReady: () => ipcRenderer.send(PET_CHANNELS.characterReady, {}),
  moveDrag: (input: PetDragPoint) => {
    ipcRenderer.send(
      PET_CHANNELS.dragMove,
      parseSchemaWithoutCodeGeneration(PetDragPointSchema, input),
    );
  },
  showContextMenu: () => ipcRenderer.send(PET_CHANNELS.showContextMenu, {}),
  startDrag: async (input: PetDragPoint) =>
    parseSchemaWithoutCodeGeneration(
      PetDragResultSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.dragStart,
        parseSchemaWithoutCodeGeneration(PetDragPointSchema, input),
      ),
    ),
  subscribe: (listener: (snapshot: PetCharacterSnapshot) => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(PetCharacterSnapshotSchema, input),
      );
    };
    ipcRenderer.on(PET_CHANNELS.characterChanged, wrappedListener);
    return () =>
      ipcRenderer.off(PET_CHANNELS.characterChanged, wrappedListener);
  },
});

contextBridge.exposeInMainWorld("charaMateCharacter", characterApi);
