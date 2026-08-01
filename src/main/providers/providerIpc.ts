import { ipcMain } from "electron";

import { PROVIDER_CHANNELS } from "../../shared/contracts/provider";
import {
  ProviderDeleteProfileRequestSchema,
  ProviderDeleteProfileResponseSchema,
  ProviderDiscoverModelsRequestSchema,
  ProviderDiscoverModelsResponseSchema,
  ProviderListProfilesRequestSchema,
  ProviderListProfilesResponseSchema,
  ProviderSaveProfileRequestSchema,
  ProviderSaveProfileResponseSchema,
  ProviderTestConnectionRequestSchema,
  ProviderTestConnectionResponseSchema,
} from "../../shared/schemas/provider";
import { parseSchema } from "../../shared/schemas/validation";
import { toProviderAppError } from "./providerError";
import type { ProviderService } from "./providerService";

export function registerProviderIpc(service: ProviderService): () => void {
  ipcMain.handle(PROVIDER_CHANNELS.listProfiles, (_event, value) => {
    try {
      parseSchema(ProviderListProfilesRequestSchema, value);
      return parseSchema(ProviderListProfilesResponseSchema, {
        ok: true,
        value: service.listProfiles(),
      });
    } catch (error) {
      return parseSchema(ProviderListProfilesResponseSchema, {
        error: toProviderAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PROVIDER_CHANNELS.saveProfile, async (_event, value) => {
    try {
      const request = parseSchema(ProviderSaveProfileRequestSchema, value);
      return parseSchema(ProviderSaveProfileResponseSchema, {
        ok: true,
        value: await service.saveProfile(request),
      });
    } catch (error) {
      return parseSchema(ProviderSaveProfileResponseSchema, {
        error: toProviderAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PROVIDER_CHANNELS.deleteProfile, async (_event, value) => {
    try {
      const request = parseSchema(ProviderDeleteProfileRequestSchema, value);
      return parseSchema(ProviderDeleteProfileResponseSchema, {
        ok: true,
        value: await service.deleteProfile(request),
      });
    } catch (error) {
      return parseSchema(ProviderDeleteProfileResponseSchema, {
        error: toProviderAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PROVIDER_CHANNELS.discoverModels, async (_event, value) => {
    try {
      const request = parseSchema(ProviderDiscoverModelsRequestSchema, value);
      return parseSchema(ProviderDiscoverModelsResponseSchema, {
        ok: true,
        value: await service.discoverModels(request.connection),
      });
    } catch (error) {
      return parseSchema(ProviderDiscoverModelsResponseSchema, {
        error: toProviderAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PROVIDER_CHANNELS.testConnection, async (_event, value) => {
    try {
      const request = parseSchema(ProviderTestConnectionRequestSchema, value);
      return parseSchema(ProviderTestConnectionResponseSchema, {
        ok: true,
        value: await service.testConnection(
          request.connection,
          request.capability,
        ),
      });
    } catch (error) {
      return parseSchema(ProviderTestConnectionResponseSchema, {
        error: toProviderAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(PROVIDER_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
