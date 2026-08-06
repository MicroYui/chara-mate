import { contextBridge, ipcRenderer } from "electron";

import {
  CHAT_CHANNELS,
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
  RUN_EVENT_CHANNELS,
  type RunEventEnvelope,
  type RunEventReplayRequest,
  type RunEventsApi,
} from "../shared/contracts/ipc";
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
  ChatSetPinnedRequestSchema,
} from "../shared/schemas/chat";
import { FoundationSnapshotSchema } from "../shared/schemas/foundation";
import {
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../shared/schemas/ipc";
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

const desktopApi: CharaMateApi = Object.freeze({
  chat: chatApi,
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
  pet: petApi,
  provider: providerApi,
  runEvents: runEventsApi,
  territory: territoryApi,
});

contextBridge.exposeInMainWorld("charaMate", desktopApi);
