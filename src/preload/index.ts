import { contextBridge, ipcRenderer } from "electron";

import {
  CHAT_DATA_CHANNELS,
  type ChatDataApi,
  type ChatDataSnapshotRequest,
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
  type ProviderApi,
  type ProviderDeleteProfileRequest,
  type ProviderDiscoverModelsRequest,
  PROVIDER_CHANNELS,
  type ProviderSaveProfileRequest,
  type ProviderTestConnectionRequest,
} from "../shared/contracts/provider";
import {
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
} from "../shared/schemas/chat";
import { FoundationSnapshotSchema } from "../shared/schemas/foundation";
import {
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../shared/schemas/ipc";
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
import { parseSchemaWithoutCodeGeneration } from "../shared/schemas/valueValidation";

const chatDataApi: ChatDataApi = Object.freeze({
  getSnapshot: async (input: ChatDataSnapshotRequest) => {
    const request = parseSchemaWithoutCodeGeneration(
      ChatDataSnapshotRequestSchema,
      input,
    );
    return parseSchemaWithoutCodeGeneration(
      ChatDataSnapshotResponseSchema,
      await ipcRenderer.invoke(CHAT_DATA_CHANNELS.getSnapshot, request),
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

const desktopApi: CharaMateApi = Object.freeze({
  chatData: chatDataApi,
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
  provider: providerApi,
  runEvents: runEventsApi,
});

contextBridge.exposeInMainWorld("charaMate", desktopApi);
