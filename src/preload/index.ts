import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  AGENT_CHANNELS,
  type AgentApi,
  type ApprovalNavigationTarget,
  type PendingApprovalRequest,
  type ResolveApprovalRequest,
  type ResolveUserInputRequest,
  type ResumeRunRequest,
  type StartRunRequest,
  type SteerRunRequest,
} from "../shared/contracts/agent";
import {
  CHAT_CHANNELS,
  CHAT_EVENT_CHANNELS,
  type Chat,
  type ChatApi,
  type ChatCreateRequest,
  type ChatDataSnapshotRequest,
  type ChatIdRequest,
  type ChatListRequest,
  type ChatRenameRequest,
  type ChatSetPinnedRequest,
} from "../shared/contracts/chat";
import {
  type CharaMateApi,
  FOUNDATION_CHANNELS,
} from "../shared/contracts/foundation";
import {
  MEMORY_CHANNELS,
  type MemoryApi,
  type MemoryCandidateIdRequest,
  type MemoryCreateRequest,
  type MemoryIdRequest,
  type MemoryListRequest,
  type MemoryReviseRequest,
  type MemorySetPinnedRequest,
} from "../shared/contracts/memory";
import {
  ACTIVITY_CHANNELS,
  type ActivityApi,
  type ActivityCleanupRequest,
  type ActivityEpisodeIdRequest,
  type ActivitySetPausedRequest,
  type ActivitySnapshotRequest,
  type ActivityUpdateEpisodeRequest,
} from "../shared/contracts/activity";
import {
  EXTENSION_CHANNELS,
  type ExtensionsApi,
  type McpIdRequest,
  type McpListRequest,
  type McpSaveRequest,
  type SkillIdRequest,
  type SkillListRequest,
  type SkillSaveRequest,
  type SkillSetEnabledRequest,
} from "../shared/contracts/extensions";
import {
  RUN_EVENT_CHANNELS,
  type RunEventEnvelope,
  type RunEventReplayRequest,
  type RunEventsApi,
} from "../shared/contracts/ipc";
import type { RunCancelRequest } from "../shared/contracts/run";
import {
  type AgentSettingsSaveRequest,
  SETTINGS_CHANNELS,
  type SettingsApi,
} from "../shared/contracts/settings";
import {
  PET_CHANNELS,
  type PetAnimationSpeedRequest,
  type PetLibrarySnapshot,
  type PetMainTarget,
  type PetManagementApi,
  type PetScaleRequest,
  type PetSelectRequest,
} from "../shared/contracts/pet";
import {
  type ProviderApi,
  type ProviderDeleteProfileRequest,
  type ProviderDiscoverModelsRequest,
  PROVIDER_CHANNELS,
  type ProviderSaveProfileRequest,
  type ProviderTestConnectionRequest,
} from "../shared/contracts/provider";
import {
  type TerritoryApi,
  type TerritoryCollectItemRequest,
  type TerritoryEditImageRequest,
  type TerritoryGenerateImageRequest,
  type TerritoryImageCandidateIdRequest,
  TERRITORY_CHANNELS,
  type TerritoryMovePetRequest,
  type TerritoryPlaceItemRequest,
  type TerritorySelectSceneRequest,
} from "../shared/contracts/territory";
import {
  ChatCreateRequestSchema,
  ChatDataSnapshotRequestSchema,
  ChatDeleteResponseSchema,
  ChatGetSnapshotResponseSchema,
  ChatIdRequestSchema,
  ChatListRequestSchema,
  ChatListResponseSchema,
  ChatMutationResponseSchema,
  ChatRenameRequestSchema,
  ChatSchema,
  ChatSetPinnedRequestSchema,
} from "../shared/schemas/chat";
import {
  ResolveApprovalRequestSchema,
  ResolveApprovalResponseSchema,
  ResolveUserInputRequestSchema,
  ResolveUserInputResponseSchema,
  ResumeRunRequestSchema,
  RunCancelResponseSchema,
  RunMutationResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  SteerRunRequestSchema,
  PendingApprovalRequestSchema,
  PendingApprovalResponseSchema,
  ApprovalNavigationTargetSchema,
} from "../shared/schemas/agent";
import { FoundationSnapshotSchema } from "../shared/schemas/foundation";
import {
  MemoryCandidateIdRequestSchema,
  MemoryCandidateMutationResponseSchema,
  MemoryCreateRequestSchema,
  MemoryDetailResponseSchema,
  MemoryIdRequestSchema,
  MemoryListRequestSchema,
  MemoryListResponseSchema,
  MemoryMutationResponseSchema,
  MemoryPurgeResponseSchema,
  MemoryReviseRequestSchema,
  MemorySetPinnedRequestSchema,
} from "../shared/schemas/memory";
import {
  ActivityCleanupRequestSchema,
  ActivityCleanupResponseSchema,
  ActivityEpisodeIdRequestSchema,
  ActivityEpisodeResponseSchema,
  ActivitySetPausedRequestSchema,
  ActivitySnapshotRequestSchema,
  ActivitySnapshotResponseSchema,
  ActivityUpdateEpisodeRequestSchema,
} from "../shared/schemas/activity";
import {
  McpDeleteResponseSchema,
  McpIdRequestSchema,
  McpListRequestSchema,
  McpListResponseSchema,
  McpMutationResponseSchema,
  McpSaveRequestSchema,
  SkillGetResponseSchema,
  SkillIdRequestSchema,
  SkillListRequestSchema,
  SkillListResponseSchema,
  SkillMutationResponseSchema,
  SkillSaveRequestSchema,
  SkillSetEnabledRequestSchema,
} from "../shared/schemas/extensions";
import {
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../shared/schemas/ipc";
import { RunCancelRequestSchema } from "../shared/schemas/run";
import {
  AgentSettingsSaveRequestSchema,
  AgentSettingsSaveResponseSchema,
  BrowserActionResponseSchema,
  SettingsSnapshotResponseSchema,
} from "../shared/schemas/settings";
import {
  PetAnimationSpeedRequestSchema,
  PetImportResponseSchema,
  PetLibraryResponseSchema,
  PetLibrarySnapshotSchema,
  PetMainNavigationSchema,
  PetScaleRequestSchema,
  PetSelectRequestSchema,
} from "../shared/schemas/pet";
import {
  ProviderDeleteProfileRequestSchema,
  ProviderDeleteProfileResponseSchema,
  ProviderDiscoverModelsRequestSchema,
  ProviderDiscoverModelsResponseSchema,
  ProviderListProfilesResponseSchema,
  ProviderSaveProfileRequestSchema,
  ProviderSaveProfileResponseSchema,
  ProviderTestConnectionRequestSchema,
  ProviderTestConnectionResponseSchema,
} from "../shared/schemas/provider";
import {
  TerritoryCollectItemRequestSchema,
  TerritoryEditImageRequestSchema,
  TerritoryGenerateImageRequestSchema,
  TerritoryImageCandidateIdRequestSchema,
  TerritoryImageMutationResponseSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMoveResponseSchema,
  TerritoryPlaceItemRequestSchema,
  TerritorySelectSceneRequestSchema,
  TerritorySnapshotResponseSchema,
} from "../shared/schemas/territory";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

const chatApi: ChatApi = Object.freeze({
  archive: async (input: ChatIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatMutationResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.archive, request),
    );
  },
  create: async (input: ChatCreateRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatCreateRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatMutationResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.create, request),
    );
  },
  delete: async (input: ChatIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatDeleteResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.delete, request),
    );
  },
  getSnapshot: async (input: ChatDataSnapshotRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatDataSnapshotRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatGetSnapshotResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.getSnapshot, request),
    );
  },
  list: async (input: ChatListRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatListRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatListResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.list, request),
    );
  },
  rename: async (input: ChatRenameRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatRenameRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatMutationResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.rename, request),
    );
  },
  restore: async (input: ChatIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatMutationResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.restore, request),
    );
  },
  setPinned: async (input: ChatSetPinnedRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatSetPinnedRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatMutationResponseSchema,
      await ipcRenderer.invoke(CHAT_CHANNELS.setPinned, request),
    );
  },
  subscribeChanged: (listener: (chat: Chat) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, input: unknown) => {
      listener(parseSchemaWithoutCodeGeneration(ChatSchema, input));
    };
    ipcRenderer.on(CHAT_EVENT_CHANNELS.changed, wrapped);
    return () => ipcRenderer.off(CHAT_EVENT_CHANNELS.changed, wrapped);
  },
});

const agentApi: AgentApi = Object.freeze({
  cancel: async (input: RunCancelRequest) =>
    parseSchemaWithoutCodeGeneration(
      RunCancelResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.cancel,
        parseSchemaWithoutCodeGeneration(RunCancelRequestSchema, input),
      ),
    ),
  getPendingApproval: async (input: PendingApprovalRequest) =>
    parseSchemaWithoutCodeGeneration(
      PendingApprovalResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.pendingApproval,
        parseSchemaWithoutCodeGeneration(PendingApprovalRequestSchema, input),
      ),
    ),
  resolveApproval: async (input: ResolveApprovalRequest) =>
    parseSchemaWithoutCodeGeneration(
      ResolveApprovalResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.resolveApproval,
        parseSchemaWithoutCodeGeneration(ResolveApprovalRequestSchema, input),
      ),
    ),
  resolveUserInput: async (input: ResolveUserInputRequest) =>
    parseSchemaWithoutCodeGeneration(
      ResolveUserInputResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.resolveUserInput,
        parseSchemaWithoutCodeGeneration(ResolveUserInputRequestSchema, input),
      ),
    ),
  resume: async (input: ResumeRunRequest) =>
    parseSchemaWithoutCodeGeneration(
      RunMutationResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.resume,
        parseSchemaWithoutCodeGeneration(ResumeRunRequestSchema, input),
      ),
    ),
  start: async (input: StartRunRequest) =>
    parseSchemaWithoutCodeGeneration(
      StartRunResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.start,
        parseSchemaWithoutCodeGeneration(StartRunRequestSchema, input),
      ),
    ),
  steer: async (input: SteerRunRequest) =>
    parseSchemaWithoutCodeGeneration(
      RunMutationResponseSchema,
      await ipcRenderer.invoke(
        AGENT_CHANNELS.steer,
        parseSchemaWithoutCodeGeneration(SteerRunRequestSchema, input),
      ),
    ),
  subscribeOpenApproval: (
    listener: (target: ApprovalNavigationTarget) => void,
  ) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(ApprovalNavigationTargetSchema, input),
      );
    };
    ipcRenderer.on(AGENT_CHANNELS.openApproval, wrappedListener);
    return () => ipcRenderer.off(AGENT_CHANNELS.openApproval, wrappedListener);
  },
});

const extensionsApi: ExtensionsApi = Object.freeze({
  mcpDelete: async (input: McpIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      McpDeleteResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.mcpDelete,
        parseSchemaWithoutCodeGeneration(McpIdRequestSchema, input),
      ),
    ),
  mcpList: async (input: McpListRequest) =>
    parseSchemaWithoutCodeGeneration(
      McpListResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.mcpList,
        parseSchemaWithoutCodeGeneration(McpListRequestSchema, input),
      ),
    ),
  mcpRefresh: async (input: McpIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      McpMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.mcpRefresh,
        parseSchemaWithoutCodeGeneration(McpIdRequestSchema, input),
      ),
    ),
  mcpSave: async (input: McpSaveRequest) =>
    parseSchemaWithoutCodeGeneration(
      McpMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.mcpSave,
        parseSchemaWithoutCodeGeneration(McpSaveRequestSchema, input),
      ),
    ),
  skillArchive: async (input: SkillIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillArchive,
        parseSchemaWithoutCodeGeneration(SkillIdRequestSchema, input),
      ),
    ),
  skillGet: async (input: SkillIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillGetResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillGet,
        parseSchemaWithoutCodeGeneration(SkillIdRequestSchema, input),
      ),
    ),
  skillList: async (input: SkillListRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillListResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillList,
        parseSchemaWithoutCodeGeneration(SkillListRequestSchema, input),
      ),
    ),
  skillRefresh: async (input: SkillListRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillListResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillRefresh,
        parseSchemaWithoutCodeGeneration(SkillListRequestSchema, input),
      ),
    ),
  skillSave: async (input: SkillSaveRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillSave,
        parseSchemaWithoutCodeGeneration(SkillSaveRequestSchema, input),
      ),
    ),
  skillSetEnabled: async (input: SkillSetEnabledRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillSetEnabled,
        parseSchemaWithoutCodeGeneration(SkillSetEnabledRequestSchema, input),
      ),
    ),
});

const runEventsApi: RunEventsApi = Object.freeze({
  replay: async (input: RunEventReplayRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      RunEventReplayRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      RunEventReplayResponseSchema,
      await ipcRenderer.invoke(RUN_EVENT_CHANNELS.replay, request),
    );
  },
  subscribe: (listener: (event: RunEventEnvelope) => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(parseSchemaWithoutCodeGeneration(RunEventEnvelopeSchema, input));
    };
    ipcRenderer.on(RUN_EVENT_CHANNELS.subscribe, wrappedListener);
    return () => {
      ipcRenderer.off(RUN_EVENT_CHANNELS.subscribe, wrappedListener);
    };
  },
});

const settingsApi: SettingsApi = Object.freeze({
  getSnapshot: async () =>
    parseSchemaWithoutCodeGeneration(
      SettingsSnapshotResponseSchema,
      await ipcRenderer.invoke(SETTINGS_CHANNELS.getSnapshot, {}),
    ),
  importBrowserCookies: async () =>
    parseSchemaWithoutCodeGeneration(
      BrowserActionResponseSchema,
      await ipcRenderer.invoke(SETTINGS_CHANNELS.importBrowserCookies, {}),
    ),
  openManagedBrowser: async () =>
    parseSchemaWithoutCodeGeneration(
      BrowserActionResponseSchema,
      await ipcRenderer.invoke(SETTINGS_CHANNELS.openManagedBrowser, {}),
    ),
  saveAgent: async (input: AgentSettingsSaveRequest) =>
    parseSchemaWithoutCodeGeneration(
      AgentSettingsSaveResponseSchema,
      await ipcRenderer.invoke(
        SETTINGS_CHANNELS.saveAgent,
        parseSchemaWithoutCodeGeneration(AgentSettingsSaveRequestSchema, input),
      ),
    ),
});

const providerApi: ProviderApi = Object.freeze({
  deleteProfile: async (request: ProviderDeleteProfileRequest) =>
    parseSchemaWithoutCodeGeneration(
      ProviderDeleteProfileResponseSchema,
      await ipcRenderer.invoke(
        PROVIDER_CHANNELS.deleteProfile,
        parseSchemaWithoutCodeGeneration(
          ProviderDeleteProfileRequestSchema,
          request,
        ),
      ),
    ),
  discoverModels: async (request: ProviderDiscoverModelsRequest) =>
    parseSchemaWithoutCodeGeneration(
      ProviderDiscoverModelsResponseSchema,
      await ipcRenderer.invoke(
        PROVIDER_CHANNELS.discoverModels,
        parseSchemaWithoutCodeGeneration(
          ProviderDiscoverModelsRequestSchema,
          request,
        ),
      ),
    ),
  listProfiles: async () =>
    parseSchemaWithoutCodeGeneration(
      ProviderListProfilesResponseSchema,
      await ipcRenderer.invoke(PROVIDER_CHANNELS.listProfiles, {}),
    ),
  saveProfile: async (request: ProviderSaveProfileRequest) =>
    parseSchemaWithoutCodeGeneration(
      ProviderSaveProfileResponseSchema,
      await ipcRenderer.invoke(
        PROVIDER_CHANNELS.saveProfile,
        parseSchemaWithoutCodeGeneration(
          ProviderSaveProfileRequestSchema,
          request,
        ),
      ),
    ),
  testConnection: async (request: ProviderTestConnectionRequest) =>
    parseSchemaWithoutCodeGeneration(
      ProviderTestConnectionResponseSchema,
      await ipcRenderer.invoke(
        PROVIDER_CHANNELS.testConnection,
        parseSchemaWithoutCodeGeneration(
          ProviderTestConnectionRequestSchema,
          request,
        ),
      ),
    ),
});

const petApi: PetManagementApi = Object.freeze({
  getLibrary: async () =>
    parseSchemaWithoutCodeGeneration(
      PetLibraryResponseSchema,
      await ipcRenderer.invoke(PET_CHANNELS.getLibrary, {}),
    ),
  importFromFolder: async () =>
    parseSchemaWithoutCodeGeneration(
      PetImportResponseSchema,
      await ipcRenderer.invoke(PET_CHANNELS.importFromFolder, {}),
    ),
  select: async (input: PetSelectRequest) =>
    parseSchemaWithoutCodeGeneration(
      PetLibraryResponseSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.select,
        parseSchemaWithoutCodeGeneration(PetSelectRequestSchema, input),
      ),
    ),
  setAnimationSpeed: async (input: PetAnimationSpeedRequest) =>
    parseSchemaWithoutCodeGeneration(
      PetLibraryResponseSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.setAnimationSpeed,
        parseSchemaWithoutCodeGeneration(PetAnimationSpeedRequestSchema, input),
      ),
    ),
  setScale: async (input: PetScaleRequest) =>
    parseSchemaWithoutCodeGeneration(
      PetLibraryResponseSchema,
      await ipcRenderer.invoke(
        PET_CHANNELS.setScale,
        parseSchemaWithoutCodeGeneration(PetScaleRequestSchema, input),
      ),
    ),
  subscribeChanged: (listener: (snapshot: PetLibrarySnapshot) => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(PetLibrarySnapshotSchema, input),
      );
    };
    ipcRenderer.on(PET_CHANNELS.libraryChanged, wrappedListener);
    return () => ipcRenderer.off(PET_CHANNELS.libraryChanged, wrappedListener);
  },
  subscribeOpenMain: (listener: (target: PetMainTarget) => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(PetMainNavigationSchema, input).target,
      );
    };
    ipcRenderer.on(PET_CHANNELS.openMain, wrappedListener);
    return () => ipcRenderer.off(PET_CHANNELS.openMain, wrappedListener);
  },
});

const territoryApi: TerritoryApi = Object.freeze({
  collectItem: async (input: TerritoryCollectItemRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritorySnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.collectItem,
        parseSchemaWithoutCodeGeneration(
          TerritoryCollectItemRequestSchema,
          input,
        ),
      ),
    ),
  confirmImageCandidate: async (input: TerritoryImageCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryImageMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.confirmImageCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryImageCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  editImageCandidate: async (input: TerritoryEditImageRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryImageMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.editImageCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryEditImageRequestSchema,
          input,
        ),
      ),
    ),
  generateImageCandidate: async (input: TerritoryGenerateImageRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryImageMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.generateImageCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryGenerateImageRequestSchema,
          input,
        ),
      ),
    ),
  getSnapshot: async () =>
    parseSchemaWithoutCodeGeneration(
      TerritorySnapshotResponseSchema,
      await ipcRenderer.invoke(TERRITORY_CHANNELS.getSnapshot, {}),
    ),
  movePet: async (input: TerritoryMovePetRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryMoveResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.movePet,
        parseSchemaWithoutCodeGeneration(TerritoryMovePetRequestSchema, input),
      ),
    ),
  placeItem: async (input: TerritoryPlaceItemRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritorySnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.placeItem,
        parseSchemaWithoutCodeGeneration(
          TerritoryPlaceItemRequestSchema,
          input,
        ),
      ),
    ),
  retryImageCandidate: async (input: TerritoryImageCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryImageMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.retryImageCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryImageCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  selectScene: async (input: TerritorySelectSceneRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritorySnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_CHANNELS.selectScene,
        parseSchemaWithoutCodeGeneration(
          TerritorySelectSceneRequestSchema,
          input,
        ),
      ),
    ),
});

const memoryApi: MemoryApi = Object.freeze({
  acceptCandidate: async (input: MemoryCandidateIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryCandidateIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.acceptCandidate, request),
    );
  },
  archive: async (input: MemoryIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.archive, request),
    );
  },
  create: async (input: MemoryCreateRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryCreateRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.create, request),
    );
  },
  delete: async (input: MemoryIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.delete, request),
    );
  },
  get: async (input: MemoryIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryDetailResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.get, request),
    );
  },
  list: async (input: MemoryListRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryListRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryListResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.list, request),
    );
  },
  purge: async (input: MemoryIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryPurgeResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.purge, request),
    );
  },
  rejectCandidate: async (input: MemoryCandidateIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryCandidateIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryCandidateMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.rejectCandidate, request),
    );
  },
  restore: async (input: MemoryIdRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryIdRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.restore, request),
    );
  },
  revise: async (input: MemoryReviseRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryReviseRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.revise, request),
    );
  },
  setPinned: async (input: MemorySetPinnedRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemorySetPinnedRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.setPinned, request),
    );
  },
});

const activityApi: ActivityApi = Object.freeze({
  cleanup: async (input: ActivityCleanupRequest) =>
    parseSchemaWithoutCodeGeneration(
      ActivityCleanupResponseSchema,
      await ipcRenderer.invoke(
        ACTIVITY_CHANNELS.cleanup,
        parseSchemaWithoutCodeGeneration(ActivityCleanupRequestSchema, input),
      ),
    ),
  deleteEpisode: async (input: ActivityEpisodeIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      ActivitySnapshotResponseSchema,
      await ipcRenderer.invoke(
        ACTIVITY_CHANNELS.deleteEpisode,
        parseSchemaWithoutCodeGeneration(ActivityEpisodeIdRequestSchema, input),
      ),
    ),
  getEpisode: async (input: ActivityEpisodeIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      ActivityEpisodeResponseSchema,
      await ipcRenderer.invoke(
        ACTIVITY_CHANNELS.getEpisode,
        parseSchemaWithoutCodeGeneration(ActivityEpisodeIdRequestSchema, input),
      ),
    ),
  getSnapshot: async (input: ActivitySnapshotRequest) =>
    parseSchemaWithoutCodeGeneration(
      ActivitySnapshotResponseSchema,
      await ipcRenderer.invoke(
        ACTIVITY_CHANNELS.getSnapshot,
        parseSchemaWithoutCodeGeneration(ActivitySnapshotRequestSchema, input),
      ),
    ),
  setPaused: async (input: ActivitySetPausedRequest) =>
    parseSchemaWithoutCodeGeneration(
      ActivitySnapshotResponseSchema,
      await ipcRenderer.invoke(
        ACTIVITY_CHANNELS.setPaused,
        parseSchemaWithoutCodeGeneration(ActivitySetPausedRequestSchema, input),
      ),
    ),
  updateEpisode: async (input: ActivityUpdateEpisodeRequest) =>
    parseSchemaWithoutCodeGeneration(
      ActivityEpisodeResponseSchema,
      await ipcRenderer.invoke(
        ACTIVITY_CHANNELS.updateEpisode,
        parseSchemaWithoutCodeGeneration(
          ActivityUpdateEpisodeRequestSchema,
          input,
        ),
      ),
    ),
});

const desktopApi: CharaMateApi = Object.freeze({
  activity: activityApi,
  agent: agentApi,
  chat: chatApi,
  extensions: extensionsApi,
  files: Object.freeze({
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  }),
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
  memory: memoryApi,
  pet: petApi,
  provider: providerApi,
  runEvents: runEventsApi,
  settings: settingsApi,
  territory: territoryApi,
});

contextBridge.exposeInMainWorld("charaMate", desktopApi);
