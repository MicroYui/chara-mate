import { contextBridge, ipcRenderer } from "electron";

import {
  AGENT_CHANNELS,
  type ApprovalNavigationRequest,
  type ResolveApprovalRequest,
} from "../shared/contracts/agent";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import type { Approval } from "../shared/contracts/run";
import {
  PendingApprovalRequestSchema,
  PendingApprovalResponseSchema,
  ApprovalNavigationRequestSchema,
  ResolveApprovalRequestSchema,
  ResolveApprovalResponseSchema,
} from "../shared/schemas/agent";
import { RunEventEnvelopeSchema } from "../shared/schemas/ipc";
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
import { createVoiceApi } from "./voiceApi";

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
  focusApproval: (input: ApprovalNavigationRequest) =>
    ipcRenderer.send(
      PET_CHANNELS.focusApproval,
      parseSchemaWithoutCodeGeneration(ApprovalNavigationRequestSchema, input),
    ),
  getPendingApproval: async () =>
    parseSchemaWithoutCodeGeneration(
      PendingApprovalResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.pendingApproval,
        parseSchemaWithoutCodeGeneration(PendingApprovalRequestSchema, {}),
      ),
    ),
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
  resolveApproval: async (input: ResolveApprovalRequest) =>
    parseSchemaWithoutCodeGeneration(
      ResolveApprovalResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.resolveApproval,
        parseSchemaWithoutCodeGeneration(ResolveApprovalRequestSchema, input),
      ),
    ),
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
  subscribeApproval: (listener: (approval: Approval | null) => void) => {
    let active = true;
    const refresh = async (): Promise<void> => {
      const response = parseSchemaWithoutCodeGeneration(
        PendingApprovalResponseSchema,
        await ipcRenderer.invoke(AGENT_CHANNELS.pendingApproval, {}),
      );
      if (active && response.ok) listener(response.value);
    };
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      const envelope = parseSchemaWithoutCodeGeneration(
        RunEventEnvelopeSchema,
        input,
      );
      if (
        envelope.event.type === "approval.requested" ||
        envelope.event.type === "approval.resolved"
      ) {
        void refresh().catch(() => undefined);
      }
    };
    ipcRenderer.on(RUN_EVENT_CHANNELS.subscribe, wrappedListener);
    void refresh().catch(() => undefined);
    return () => {
      active = false;
      ipcRenderer.off(RUN_EVENT_CHANNELS.subscribe, wrappedListener);
    };
  },
  voice: createVoiceApi(),
});

contextBridge.exposeInMainWorld("charaMateCharacter", characterApi);
