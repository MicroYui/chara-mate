import { randomUUID } from "node:crypto";

import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  type PetConversationNavigation,
  type PetDragPoint,
  type PetTerritoryCandidateNavigation,
  type PetTerritoryMomentNotice,
  type ProactiveConversationBubble,
  type ProactiveConversationBubbleDismissRequest,
  type ProactiveConversationBubbleReplyRequest,
} from "../shared/contracts/pet";
import {
  PetCharacterSnapshotSchema,
  PetComposerAttachmentsSchema,
  PetConversationNavigationSchema,
  PetDragPointSchema,
  PetDragResultSchema,
  PetTerritoryCandidateNavigationSchema,
  PetTerritoryMomentNoticeEventSchema,
  ProactiveConversationBubbleDismissRequestSchema,
  ProactiveConversationBubbleFrequencyResponseSchema,
  ProactiveConversationBubbleReplyRequestSchema,
  ProactiveConversationBubbleReplyResponseSchema,
  ProactiveConversationBubbleSchema,
} from "../shared/schemas/pet";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";
import { createVoiceApi } from "./voiceApi";
import { createVoiceWakeCharacterApi } from "./voiceWakeApi";

const characterApi: CharacterWindowApi = Object.freeze({
  dropComposerAttachments: (files: readonly File[]) => {
    const attachments = [...files].map((file) => ({
      byteLength: file.size,
      displayName: file.name,
      id: randomUUID(),
      ...(file.type ? { mediaType: file.type } : {}),
      source: file.type.startsWith("image/")
        ? ("image" as const)
        : ("file" as const),
      storageKey: webUtils.getPathForFile(file),
    }));
    if (attachments.length === 0) return;
    ipcRenderer.send(
      PET_CHANNELS.dropComposerAttachments,
      parseSchemaWithoutCodeGeneration(PetComposerAttachmentsSchema, {
        attachments,
      }),
    );
  },
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
  focusConversation: (input: PetConversationNavigation) =>
    ipcRenderer.send(
      PET_CHANNELS.focusConversation,
      parseSchemaWithoutCodeGeneration(PetConversationNavigationSchema, input),
    ),
  focusTerritoryMoment: (input: PetTerritoryCandidateNavigation) =>
    ipcRenderer.send(
      PET_CHANNELS.focusTerritoryMoment,
      parseSchemaWithoutCodeGeneration(
        PetTerritoryCandidateNavigationSchema,
        input,
      ),
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
  dismissProactiveBubble: (input: ProactiveConversationBubbleDismissRequest) =>
    ipcRenderer.send(
      PET_CHANNELS.dismissProactiveBubble,
      parseSchemaWithoutCodeGeneration(
        ProactiveConversationBubbleDismissRequestSchema,
        input,
      ),
    ),
  reduceProactiveFrequency: async (
    input: ProactiveConversationBubbleDismissRequest,
  ) =>
    parseSchemaWithoutCodeGeneration(
      ProactiveConversationBubbleFrequencyResponseSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.reduceProactiveFrequency,
        parseSchemaWithoutCodeGeneration(
          ProactiveConversationBubbleDismissRequestSchema,
          input,
        ),
      ),
    ),
  replyProactiveBubble: async (
    input: ProactiveConversationBubbleReplyRequest,
  ) =>
    parseSchemaWithoutCodeGeneration(
      ProactiveConversationBubbleReplyResponseSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.replyProactiveBubble,
        parseSchemaWithoutCodeGeneration(
          ProactiveConversationBubbleReplyRequestSchema,
          input,
        ),
      ),
    ),
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
  subscribeProactiveBubble: (
    listener: (bubble: ProactiveConversationBubble | null) => void,
  ) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        input === null
          ? null
          : parseSchemaWithoutCodeGeneration(
              ProactiveConversationBubbleSchema,
              input,
            ),
      );
    };
    ipcRenderer.on(PET_CHANNELS.proactiveBubbleChanged, wrappedListener);
    return () =>
      ipcRenderer.off(PET_CHANNELS.proactiveBubbleChanged, wrappedListener);
  },
  subscribeTerritoryMoment: (
    listener: (notice: PetTerritoryMomentNotice | null) => void,
  ) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(
          PetTerritoryMomentNoticeEventSchema,
          input,
        ),
      );
    };
    ipcRenderer.on(PET_CHANNELS.territoryMomentChanged, wrappedListener);
    return () =>
      ipcRenderer.off(PET_CHANNELS.territoryMomentChanged, wrappedListener);
  },
  voice: createVoiceApi(),
  voiceWake: createVoiceWakeCharacterApi(),
});

contextBridge.exposeInMainWorld("charaMateCharacter", characterApi);
