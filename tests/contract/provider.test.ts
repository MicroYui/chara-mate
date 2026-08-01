import { describe, expect, it } from "vitest";

import { PROVIDER_CHANNELS } from "../../src/shared/contracts/provider";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import {
  ProviderDiscoverModelsResponseSchema,
  ProviderProfileDraftSchema,
  ProviderProfileSchema,
  ProviderSaveProfileRequestSchema,
  ProviderSaveProfileResponseSchema,
  ProviderTestConnectionRequestSchema,
  ProviderTestConnectionResponseSchema,
} from "../../src/shared/schemas/provider";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
} from "../fixtures/foundationContracts";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;

const openAIProfile = {
  apiStyle: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  chatModel: "gpt-example",
  name: "OpenAI",
} as const;

const azureProfile = {
  apiStyle: "azure-openai",
  apiVersion: "2025-04-01-preview",
  baseUrl: "https://example-resource.openai.azure.com",
  chatModel: "deployment-name",
  name: "Azure OpenAI",
} as const;

describe("Phase 1 Provider boundary contracts", () => {
  it.each(parsers)(
    "accepts the two bounded external protocol profiles through %s",
    (parse) => {
      expect(parse(ProviderProfileDraftSchema, openAIProfile)).toEqual(
        openAIProfile,
      );
      expect(parse(ProviderProfileDraftSchema, azureProfile)).toEqual(
        azureProfile,
      );
      const realtimeOnlyAzureProfile = {
        apiStyle: azureProfile.apiStyle,
        baseUrl: azureProfile.baseUrl,
        chatModel: azureProfile.chatModel,
        name: azureProfile.name,
      };
      expect(
        parse(ProviderProfileDraftSchema, realtimeOnlyAzureProfile),
      ).toEqual(realtimeOnlyAzureProfile);
      expect(() =>
        parse(ProviderProfileDraftSchema, {
          ...openAIProfile,
          apiVersion: "2025-04-01-preview",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "accepts secret replacement only on the write request through %s",
    (parse) => {
      const request = {
        credential: { mode: "replace", value: "sk-boundary-secret" },
        profile: openAIProfile,
      } as const;
      expect(parse(ProviderSaveProfileRequestSchema, request)).toEqual(request);

      const publicProfile = {
        ...openAIProfile,
        createdAt: FIXTURE_TIMESTAMPS.created,
        hasApiKey: true,
        id: FIXTURE_IDS.provider,
        updatedAt: FIXTURE_TIMESTAMPS.updated,
      };
      expect(parse(ProviderProfileSchema, publicProfile)).toEqual(
        publicProfile,
      );
      expect(
        parse(ProviderSaveProfileResponseSchema, {
          ok: true,
          value: publicProfile,
        }),
      ).toEqual({ ok: true, value: publicProfile });
      expect(() =>
        parse(ProviderProfileSchema, {
          ...publicProfile,
          apiKey: "sk-must-not-return",
        }),
      ).toThrow();
      expect(() =>
        parse(ProviderProfileSchema, {
          ...publicProfile,
          apiKeyRef: FIXTURE_IDS.artifact,
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "keeps discovery fallback structured and credential-free through %s",
    (parse) => {
      expect(
        parse(ProviderDiscoverModelsResponseSchema, {
          ok: true,
          value: {
            reason: "model_list_unsupported",
            status: "manual_required",
          },
        }),
      ).toEqual({
        ok: true,
        value: {
          reason: "model_list_unsupported",
          status: "manual_required",
        },
      });
      expect(() =>
        parse(ProviderDiscoverModelsResponseSchema, {
          ok: false,
          error: {
            code: "PROVIDER.AUTHENTICATION_FAILED",
            message: "Rejected sk-leaked-key",
            retryable: false,
          },
          apiKey: "sk-leaked-key",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "keeps Chat, Realtime and Image connection tests explicit through %s",
    (parse) => {
      for (const capability of ["chat", "realtime", "image"] as const) {
        expect(
          parse(ProviderTestConnectionRequestSchema, {
            capability,
            connection: {
              apiKey: "sk-transient",
              profile: openAIProfile,
              source: "draft",
            },
          }),
        ).toMatchObject({ capability });
      }
      expect(
        parse(ProviderTestConnectionResponseSchema, {
          ok: true,
          value: { capability: "realtime", status: "connected" },
        }),
      ).toEqual({
        ok: true,
        value: { capability: "realtime", status: "connected" },
      });
      expect(
        parse(ProviderTestConnectionResponseSchema, {
          ok: true,
          value: {
            capability: "image",
            reason: "model_verification_unsupported",
            status: "manual_required",
          },
        }),
      ).toMatchObject({
        value: { capability: "image", status: "manual_required" },
      });
      expect(() =>
        parse(ProviderTestConnectionRequestSchema, {
          connection: {
            apiKey: "sk-transient",
            profile: openAIProfile,
            source: "draft",
          },
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "accepts every narrow provider IPC channel through %s",
    (parse) => {
      for (const channel of Object.values(PROVIDER_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
    },
  );
});
