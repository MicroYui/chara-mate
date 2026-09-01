import { clipboard, contextBridge, ipcRenderer, webUtils } from "electron";

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
  AUTOMATION_CHANNELS,
  type AutomationApi,
  type AutomationCreateRequest,
  type AutomationEventEnvelope,
  type AutomationIdRequest,
  type AutomationRunNowRequest,
  type AutomationSetPausedRequest,
  type AutomationUpdateRequest,
} from "../shared/contracts/automation";
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
  JOURNEY_CHANNELS,
  type JourneyApi,
  type JourneySnapshot,
} from "../shared/contracts/journey";
import {
  MEMORY_CHANNELS,
  type MemoryApi,
  type MemoryCandidateIdRequest,
  type MemoryCreateRequest,
  type MemoryIdRequest,
  type MemoryListRequest,
  type MemoryResolveClaimRequest,
  type MemoryReviseRequest,
  type MemorySetPinnedRequest,
} from "../shared/contracts/memory";
import {
  PERSONA_CHANNELS,
  type PersonaApi,
  type PersonaCopyRequest,
  type PersonaLibrarySnapshot,
  type PersonaSelectRequest,
  type PersonaUpdateRequest,
} from "../shared/contracts/persona";
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
  type SkillRevisionRequest,
  type SkillSetEnabledRequest,
  type SkillSetPinnedRequest,
} from "../shared/contracts/extensions";
import {
  EVOLUTION_CHANNELS,
  type EvolutionApi,
  type EvolutionCandidateIdRequest,
  type EvolutionCandidatePinRequest,
  type EvolutionCandidateUpdateRequest,
  type EvolutionChangedEvent,
  type EvolutionListRequest,
  type EvolutionRunIdRequest,
} from "../shared/contracts/evolution";
import {
  RUN_EVENT_CHANNELS,
  type RunEventEnvelope,
  type RunEventReplayRequest,
  type RunEventsApi,
} from "../shared/contracts/ipc";
import type { RunCancelRequest } from "../shared/contracts/run";
import {
  type AgentSettingsSaveRequest,
  type CompanionInitiativeSettingsSaveRequest,
  SETTINGS_CHANNELS,
  type SettingsApi,
  type VoiceSettingsSaveRequest,
} from "../shared/contracts/settings";
import {
  PET_CHANNELS,
  type PetAnimationSpeedRequest,
  type PetConversationNavigation,
  type PetLibrarySnapshot,
  type PetMainTarget,
  type PetManagementApi,
  type PetScaleRequest,
  type PetSelectRequest,
  type PetTerritoryPresenceRequest,
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
  TERRITORY_WORLD_CHANNELS,
  type TerritoryCandidateIdRequest as TerritoryWorldCandidateIdRequest,
  type TerritoryCommitChangeSetRequest as TerritoryWorldCommitChangeSetRequest,
  type TerritoryCreateChangeCandidateRequest as TerritoryWorldCreateChangeCandidateRequest,
  type TerritoryCreateSourceCandidateRequest as TerritoryWorldCreateSourceCandidateRequest,
  type TerritoryEditChangeCandidateRequest as TerritoryWorldEditChangeCandidateRequest,
  type TerritoryEnterZoneRequest as TerritoryWorldEnterZoneRequest,
  type TerritoryGetZoneViewRequest as TerritoryWorldGetZoneViewRequest,
  type TerritoryMovePetRequest as TerritoryWorldMovePetRequest,
  type TerritoryPetActionPerformed as TerritoryWorldPetActionPerformed,
  type TerritoryPurgeInstanceRequest as TerritoryWorldPurgeInstanceRequest,
  type TerritoryRestoreRevisionRequest as TerritoryWorldRestoreRevisionRequest,
  type TerritoryWorldApi,
  type TerritoryWorldSnapshot,
} from "../shared/contracts/territoryWorld";
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
import {
  AutomationCreateRequestSchema,
  AutomationDetailResponseSchema,
  AutomationEventEnvelopeSchema,
  AutomationIdRequestSchema,
  AutomationListResponseSchema,
  AutomationMutationResponseSchema,
  AutomationRunNowRequestSchema,
  AutomationRunNowResponseSchema,
  AutomationSetPausedRequestSchema,
  AutomationUpdateRequestSchema,
} from "../shared/schemas/automation";
import { FoundationSnapshotSchema } from "../shared/schemas/foundation";
import {
  JourneySnapshotResponseSchema,
  JourneySnapshotSchema,
} from "../shared/schemas/journey";
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
  MemoryResolveClaimRequestSchema,
  MemoryReviseRequestSchema,
  MemorySetPinnedRequestSchema,
} from "../shared/schemas/memory";
import {
  PersonaCopyRequestSchema,
  PersonaLibraryResponseSchema,
  PersonaLibrarySnapshotSchema,
  PersonaSelectRequestSchema,
  PersonaUpdateRequestSchema,
} from "../shared/schemas/persona";
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
  SkillDeleteResponseSchema,
  SkillGetResponseSchema,
  SkillHistoryResponseSchema,
  SkillIdRequestSchema,
  SkillListRequestSchema,
  SkillListResponseSchema,
  SkillMutationResponseSchema,
  SkillSaveRequestSchema,
  SkillRevisionRequestSchema,
  SkillSetEnabledRequestSchema,
  SkillSetPinnedRequestSchema,
} from "../shared/schemas/extensions";
import {
  EvolutionCandidateIdRequestSchema,
  EvolutionCandidateMutationResponseSchema,
  EvolutionCandidatePinRequestSchema,
  EvolutionCandidateUpdateRequestSchema,
  EvolutionChangedEventSchema,
  EvolutionListRequestSchema,
  EvolutionReviewMutationResponseSchema,
  EvolutionRunIdRequestSchema,
  EvolutionSnapshotResponseSchema,
} from "../shared/schemas/evolution";
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
  DataActionResponseSchema,
  DataSettingsSnapshotResponseSchema,
  CompanionInitiativeSettingsSaveRequestSchema,
  CompanionInitiativeSettingsSaveResponseSchema,
  SettingsSnapshotResponseSchema,
  VoiceSettingsSaveRequestSchema,
  VoiceSettingsSaveResponseSchema,
} from "../shared/schemas/settings";
import {
  PetAnimationSpeedRequestSchema,
  PetConversationNavigationSchema,
  PetImportResponseSchema,
  PetLibraryResponseSchema,
  PetLibrarySnapshotSchema,
  PetMainNavigationSchema,
  PetScaleRequestSchema,
  PetSelectRequestSchema,
  PetTerritoryPresenceRequestSchema,
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
  TerritoryCandidateIdRequestSchema as TerritoryWorldCandidateIdRequestSchema,
  TerritoryCandidateMutationResponseSchema as TerritoryWorldCandidateMutationResponseSchema,
  TerritoryCommitChangeSetRequestSchema as TerritoryWorldCommitChangeSetRequestSchema,
  TerritoryCreateChangeCandidateRequestSchema as TerritoryWorldCreateChangeCandidateRequestSchema,
  TerritoryCreateSourceCandidateRequestSchema as TerritoryWorldCreateSourceCandidateRequestSchema,
  TerritoryEditChangeCandidateRequestSchema as TerritoryWorldEditChangeCandidateRequestSchema,
  TerritoryEnterZoneRequestSchema as TerritoryWorldEnterZoneRequestSchema,
  TerritoryGetZoneViewRequestSchema as TerritoryWorldGetZoneViewRequestSchema,
  TerritoryMovePetRequestSchema as TerritoryWorldMovePetRequestSchema,
  TerritoryMovePetResponseSchema as TerritoryWorldMovePetResponseSchema,
  TerritoryPetActionPerformedSchema as TerritoryWorldPetActionPerformedSchema,
  TerritoryPurgeInstanceRequestSchema as TerritoryWorldPurgeInstanceRequestSchema,
  TerritoryRestoreRevisionRequestSchema as TerritoryWorldRestoreRevisionRequestSchema,
  TerritoryWorldSnapshotResponseSchema,
  TerritoryWorldSnapshotSchema,
  TerritoryZoneViewResponseSchema as TerritoryWorldZoneViewResponseSchema,
} from "../shared/schemas/territoryWorld";
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";
import { createVoiceApi } from "./voiceApi";
import { createVoiceWakeSettingsApi } from "./voiceWakeApi";

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

const journeyApi: JourneyApi = Object.freeze({
  getSnapshot: async () =>
    parseSchemaWithoutCodeGeneration(
      JourneySnapshotResponseSchema,
      await ipcRenderer.invoke(JOURNEY_CHANNELS.getSnapshot, {}),
    ),
  subscribeChanged: (listener: (snapshot: JourneySnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, input: unknown) => {
      listener(parseSchemaWithoutCodeGeneration(JourneySnapshotSchema, input));
    };
    ipcRenderer.on(JOURNEY_CHANNELS.changed, wrapped);
    return () => ipcRenderer.off(JOURNEY_CHANNELS.changed, wrapped);
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

const automationApi: AutomationApi = Object.freeze({
  create: async (input: AutomationCreateRequest) =>
    parseSchemaWithoutCodeGeneration(
      AutomationMutationResponseSchema,
      await ipcRenderer.invoke(
        AUTOMATION_CHANNELS.create,
        parseSchemaWithoutCodeGeneration(AutomationCreateRequestSchema, input),
      ),
    ),
  get: async (input: AutomationIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      AutomationDetailResponseSchema,
      await ipcRenderer.invoke(
        AUTOMATION_CHANNELS.get,
        parseSchemaWithoutCodeGeneration(AutomationIdRequestSchema, input),
      ),
    ),
  list: async () =>
    parseSchemaWithoutCodeGeneration(
      AutomationListResponseSchema,
      await ipcRenderer.invoke(AUTOMATION_CHANNELS.list, {}),
    ),
  runNow: async (input: AutomationRunNowRequest) =>
    parseSchemaWithoutCodeGeneration(
      AutomationRunNowResponseSchema,
      await ipcRenderer.invoke(
        AUTOMATION_CHANNELS.runNow,
        parseSchemaWithoutCodeGeneration(AutomationRunNowRequestSchema, input),
      ),
    ),
  setPaused: async (input: AutomationSetPausedRequest) =>
    parseSchemaWithoutCodeGeneration(
      AutomationMutationResponseSchema,
      await ipcRenderer.invoke(
        AUTOMATION_CHANNELS.setPaused,
        parseSchemaWithoutCodeGeneration(
          AutomationSetPausedRequestSchema,
          input,
        ),
      ),
    ),
  subscribe: (listener: (event: AutomationEventEnvelope) => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(AutomationEventEnvelopeSchema, input),
      );
    };
    ipcRenderer.on(AUTOMATION_CHANNELS.subscribe, wrappedListener);
    return () =>
      ipcRenderer.off(AUTOMATION_CHANNELS.subscribe, wrappedListener);
  },
  update: async (input: AutomationUpdateRequest) =>
    parseSchemaWithoutCodeGeneration(
      AutomationMutationResponseSchema,
      await ipcRenderer.invoke(
        AUTOMATION_CHANNELS.update,
        parseSchemaWithoutCodeGeneration(AutomationUpdateRequestSchema, input),
      ),
    ),
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
  skillDelete: async (input: SkillIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillDeleteResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillDelete,
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
  skillHistory: async (input: SkillIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillHistoryResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillHistory,
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
  skillRestore: async (input: SkillRevisionRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillRestore,
        parseSchemaWithoutCodeGeneration(SkillRevisionRequestSchema, input),
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
  skillSetPinned: async (input: SkillSetPinnedRequest) =>
    parseSchemaWithoutCodeGeneration(
      SkillMutationResponseSchema,
      await ipcRenderer.invoke(
        EXTENSION_CHANNELS.skillSetPinned,
        parseSchemaWithoutCodeGeneration(SkillSetPinnedRequestSchema, input),
      ),
    ),
});

const evolutionApi: EvolutionApi = Object.freeze({
  acceptCandidate: async (input: EvolutionCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.acceptCandidate,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  archiveCandidate: async (input: EvolutionCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.archiveCandidate,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  dismissReview: async (input: EvolutionRunIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionReviewMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.dismissReview,
        parseSchemaWithoutCodeGeneration(EvolutionRunIdRequestSchema, input),
      ),
    ),
  list: async (input: EvolutionListRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionSnapshotResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.list,
        parseSchemaWithoutCodeGeneration(EvolutionListRequestSchema, input),
      ),
    ),
  rejectCandidate: async (input: EvolutionCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.rejectCandidate,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  restoreCandidate: async (input: EvolutionCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.restoreCandidate,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  retryReplay: async (input: EvolutionCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.retryReplay,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  retryReview: async (input: EvolutionRunIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionReviewMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.retryReview,
        parseSchemaWithoutCodeGeneration(EvolutionRunIdRequestSchema, input),
      ),
    ),
  setCandidatePinned: async (input: EvolutionCandidatePinRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.setCandidatePinned,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidatePinRequestSchema,
          input,
        ),
      ),
    ),
  subscribe: (listener: (event: EvolutionChangedEvent) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(EvolutionChangedEventSchema, input),
      );
    };
    ipcRenderer.on(EVOLUTION_CHANNELS.changed, wrapped);
    return () => ipcRenderer.off(EVOLUTION_CHANNELS.changed, wrapped);
  },
  updateCandidate: async (input: EvolutionCandidateUpdateRequest) =>
    parseSchemaWithoutCodeGeneration(
      EvolutionCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        EVOLUTION_CHANNELS.updateCandidate,
        parseSchemaWithoutCodeGeneration(
          EvolutionCandidateUpdateRequestSchema,
          input,
        ),
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
  getDataSnapshot: async () =>
    parseSchemaWithoutCodeGeneration(
      DataSettingsSnapshotResponseSchema,
      await ipcRenderer.invoke(SETTINGS_CHANNELS.getDataSnapshot, {}),
    ),
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
  openDataDirectory: async () =>
    parseSchemaWithoutCodeGeneration(
      DataActionResponseSchema,
      await ipcRenderer.invoke(SETTINGS_CHANNELS.openDataDirectory, {}),
    ),
  saveAgent: async (input: AgentSettingsSaveRequest) =>
    parseSchemaWithoutCodeGeneration(
      AgentSettingsSaveResponseSchema,
      await ipcRenderer.invoke(
        SETTINGS_CHANNELS.saveAgent,
        parseSchemaWithoutCodeGeneration(AgentSettingsSaveRequestSchema, input),
      ),
    ),
  saveCompanionInitiative: async (
    input: CompanionInitiativeSettingsSaveRequest,
  ) =>
    parseSchemaWithoutCodeGeneration(
      CompanionInitiativeSettingsSaveResponseSchema,
      await ipcRenderer.invoke(
        SETTINGS_CHANNELS.saveCompanionInitiative,
        parseSchemaWithoutCodeGeneration(
          CompanionInitiativeSettingsSaveRequestSchema,
          input,
        ),
      ),
    ),
  saveVoice: async (input: VoiceSettingsSaveRequest) =>
    parseSchemaWithoutCodeGeneration(
      VoiceSettingsSaveResponseSchema,
      await ipcRenderer.invoke(
        SETTINGS_CHANNELS.saveVoice,
        parseSchemaWithoutCodeGeneration(VoiceSettingsSaveRequestSchema, input),
      ),
    ),
});

const voiceApi = createVoiceApi();
const voiceWakeApi = createVoiceWakeSettingsApi();

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
  setTerritoryActive: (input: PetTerritoryPresenceRequest) => {
    ipcRenderer.send(
      PET_CHANNELS.setTerritoryActive,
      parseSchemaWithoutCodeGeneration(
        PetTerritoryPresenceRequestSchema,
        input,
      ),
    );
  },
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
  subscribeOpenConversation: (
    listener: (target: PetConversationNavigation) => void,
  ) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      listener(
        parseSchemaWithoutCodeGeneration(
          PetConversationNavigationSchema,
          input,
        ),
      );
    };
    ipcRenderer.on(PET_CHANNELS.openConversation, wrappedListener);
    return () =>
      ipcRenderer.off(PET_CHANNELS.openConversation, wrappedListener);
  },
});

const territoryWorldApi: TerritoryWorldApi = Object.freeze({
  applyCandidate: async (input: TerritoryWorldCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.applyCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  cancelCandidate: async (input: TerritoryWorldCandidateIdRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.cancelCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldCandidateIdRequestSchema,
          input,
        ),
      ),
    ),
  commitChangeSet: async (input: TerritoryWorldCommitChangeSetRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldSnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.commitChangeSet,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldCommitChangeSetRequestSchema,
          input,
        ),
      ),
    ),
  createCandidate: async (input: TerritoryWorldCreateChangeCandidateRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.createCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldCreateChangeCandidateRequestSchema,
          input,
        ),
      ),
    ),
  createSourceCandidate: async (
    input: TerritoryWorldCreateSourceCandidateRequest,
  ) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.createSourceCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldCreateSourceCandidateRequestSchema,
          input,
        ),
      ),
    ),
  editCandidate: async (input: TerritoryWorldEditChangeCandidateRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldCandidateMutationResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.editCandidate,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldEditChangeCandidateRequestSchema,
          input,
        ),
      ),
    ),
  enterZone: async (input: TerritoryWorldEnterZoneRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldSnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.enterZone,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldEnterZoneRequestSchema,
          input,
        ),
      ),
    ),
  getSnapshot: async () =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldSnapshotResponseSchema,
      await ipcRenderer.invoke(TERRITORY_WORLD_CHANNELS.getSnapshot, {}),
    ),
  getZoneView: async (input: TerritoryWorldGetZoneViewRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldZoneViewResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.getZoneView,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldGetZoneViewRequestSchema,
          input,
        ),
      ),
    ),
  movePet: async (input: TerritoryWorldMovePetRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldMovePetResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.movePet,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldMovePetRequestSchema,
          input,
        ),
      ),
    ),
  purgeInstance: async (input: TerritoryWorldPurgeInstanceRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldSnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.purgeInstance,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldPurgeInstanceRequestSchema,
          input,
        ),
      ),
    ),
  restoreRevision: async (input: TerritoryWorldRestoreRevisionRequest) =>
    parseSchemaWithoutCodeGeneration(
      TerritoryWorldSnapshotResponseSchema,
      await ipcRenderer.invoke(
        TERRITORY_WORLD_CHANNELS.restoreRevision,
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldRestoreRevisionRequestSchema,
          input,
        ),
      ),
    ),
  subscribeChanged: (listener: (snapshot: TerritoryWorldSnapshot) => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: unknown,
    ) => {
      listener(
        parseSchemaWithoutCodeGeneration(TerritoryWorldSnapshotSchema, payload),
      );
    };
    ipcRenderer.on(TERRITORY_WORLD_CHANNELS.snapshotChanged, wrappedListener);
    return () => {
      ipcRenderer.off(
        TERRITORY_WORLD_CHANNELS.snapshotChanged,
        wrappedListener,
      );
    };
  },
  subscribePetAction: (
    listener: (event: TerritoryWorldPetActionPerformed) => void,
  ) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: unknown,
    ) => {
      listener(
        parseSchemaWithoutCodeGeneration(
          TerritoryWorldPetActionPerformedSchema,
          payload,
        ),
      );
    };
    ipcRenderer.on(
      TERRITORY_WORLD_CHANNELS.petActionPerformed,
      wrappedListener,
    );
    return () => {
      ipcRenderer.off(
        TERRITORY_WORLD_CHANNELS.petActionPerformed,
        wrappedListener,
      );
    };
  },
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
  resolveClaim: async (input: MemoryResolveClaimRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      MemoryResolveClaimRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      MemoryMutationResponseSchema,
      await ipcRenderer.invoke(MEMORY_CHANNELS.resolveClaim, request),
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

const personaApi: PersonaApi = Object.freeze({
  copy: async (input: PersonaCopyRequest) =>
    parseSchemaWithoutCodeGeneration(
      PersonaLibraryResponseSchema,
      await ipcRenderer.invoke(
        PERSONA_CHANNELS.copy,
        parseSchemaWithoutCodeGeneration(PersonaCopyRequestSchema, input),
      ),
    ),
  getLibrary: async () =>
    parseSchemaWithoutCodeGeneration(
      PersonaLibraryResponseSchema,
      await ipcRenderer.invoke(PERSONA_CHANNELS.getLibrary, {}),
    ),
  select: async (input: PersonaSelectRequest) =>
    parseSchemaWithoutCodeGeneration(
      PersonaLibraryResponseSchema,
      await ipcRenderer.invoke(
        PERSONA_CHANNELS.select,
        parseSchemaWithoutCodeGeneration(PersonaSelectRequestSchema, input),
      ),
    ),
  subscribeChanged(listener: (snapshot: PersonaLibrarySnapshot) => void) {
    const wrappedListener = (_event: unknown, snapshot: unknown) => {
      listener(
        parseSchemaWithoutCodeGeneration(
          PersonaLibrarySnapshotSchema,
          snapshot,
        ),
      );
    };
    ipcRenderer.on(PERSONA_CHANNELS.changed, wrappedListener);
    return () => ipcRenderer.off(PERSONA_CHANNELS.changed, wrappedListener);
  },
  update: async (input: PersonaUpdateRequest) =>
    parseSchemaWithoutCodeGeneration(
      PersonaLibraryResponseSchema,
      await ipcRenderer.invoke(
        PERSONA_CHANNELS.update,
        parseSchemaWithoutCodeGeneration(PersonaUpdateRequestSchema, input),
      ),
    ),
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
  automations: automationApi,
  chat: chatApi,
  clipboard: Object.freeze({
    writeText: (value: string) => {
      if (typeof value !== "string") {
        throw new TypeError("Clipboard content must be a string");
      }
      clipboard.writeText(value);
      return Promise.resolve();
    },
  }),
  evolution: evolutionApi,
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
  journey: journeyApi,
  memory: memoryApi,
  persona: personaApi,
  pet: petApi,
  provider: providerApi,
  runEvents: runEventsApi,
  settings: settingsApi,
  territory: territoryWorldApi,
  voice: voiceApi,
  voiceWake: voiceWakeApi,
});

contextBridge.exposeInMainWorld("charaMate", desktopApi);
