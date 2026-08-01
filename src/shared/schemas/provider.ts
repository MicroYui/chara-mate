import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

export const ProviderApiStyleSchema = Type.Union([
  Type.Literal("openai-compatible"),
  Type.Literal("azure-openai"),
]);

export const ProviderSnapshotSchema = Type.Object(
  {
    apiStyle: ProviderApiStyleSchema,
    modelId: NonBlankStringSchema,
    profileId: EntityIdSchema,
    profileName: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

const providerDraftProperties = {
  baseUrl: NonBlankStringSchema,
  chatModel: Type.Optional(NonBlankStringSchema),
  id: Type.Optional(EntityIdSchema),
  imageEditEndpoint: Type.Optional(NonBlankStringSchema),
  imageModel: Type.Optional(NonBlankStringSchema),
  name: NonBlankStringSchema,
  realtimeEndpoint: Type.Optional(NonBlankStringSchema),
  realtimeModel: Type.Optional(NonBlankStringSchema),
};

export const OpenAICompatibleProviderDraftSchema = Type.Object(
  {
    ...providerDraftProperties,
    apiStyle: Type.Literal("openai-compatible"),
  },
  { additionalProperties: false },
);

export const AzureOpenAIProviderDraftSchema = Type.Object(
  {
    ...providerDraftProperties,
    apiStyle: Type.Literal("azure-openai"),
    apiVersion: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ProviderProfileDraftSchema = Type.Union([
  OpenAICompatibleProviderDraftSchema,
  AzureOpenAIProviderDraftSchema,
]);

const providerProfileProperties = {
  baseUrl: NonBlankStringSchema,
  chatModel: Type.Optional(NonBlankStringSchema),
  createdAt: TimestampSchema,
  hasApiKey: Type.Boolean(),
  id: EntityIdSchema,
  imageEditEndpoint: Type.Optional(NonBlankStringSchema),
  imageModel: Type.Optional(NonBlankStringSchema),
  name: NonBlankStringSchema,
  realtimeEndpoint: Type.Optional(NonBlankStringSchema),
  realtimeModel: Type.Optional(NonBlankStringSchema),
  updatedAt: TimestampSchema,
};

export const OpenAICompatibleProviderProfileSchema = Type.Object(
  {
    ...providerProfileProperties,
    apiStyle: Type.Literal("openai-compatible"),
  },
  { additionalProperties: false },
);

export const AzureOpenAIProviderProfileSchema = Type.Object(
  {
    ...providerProfileProperties,
    apiStyle: Type.Literal("azure-openai"),
    apiVersion: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ProviderProfileSchema = Type.Union([
  OpenAICompatibleProviderProfileSchema,
  AzureOpenAIProviderProfileSchema,
]);

export const ProviderCredentialUpdateSchema = Type.Union([
  Type.Object({ mode: Type.Literal("keep") }, { additionalProperties: false }),
  Type.Object(
    { mode: Type.Literal("replace"), value: NonBlankStringSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { mode: Type.Literal("remove") },
    { additionalProperties: false },
  ),
]);

export const ProviderListProfilesRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const ProviderSaveProfileRequestSchema = Type.Object(
  {
    credential: ProviderCredentialUpdateSchema,
    profile: ProviderProfileDraftSchema,
  },
  { additionalProperties: false },
);

export const ProviderDeleteProfileRequestSchema = Type.Object(
  { profileId: EntityIdSchema },
  { additionalProperties: false },
);

export const ProviderConnectionSchema = Type.Union([
  Type.Object(
    { profileId: EntityIdSchema, source: Type.Literal("saved_profile") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      apiKey: NonBlankStringSchema,
      profile: ProviderProfileDraftSchema,
      source: Type.Literal("draft"),
    },
    { additionalProperties: false },
  ),
]);

export const ProviderDiscoverModelsRequestSchema = Type.Object(
  { connection: ProviderConnectionSchema },
  { additionalProperties: false },
);

export const ProviderTestConnectionRequestSchema = Type.Object(
  { connection: ProviderConnectionSchema },
  { additionalProperties: false },
);

export const ProviderModelDescriptorSchema = Type.Object(
  {
    createdAtUnixSeconds: Type.Integer({ minimum: 0 }),
    id: NonBlankStringSchema,
    ownedBy: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ProviderModelDiscoverySchema = Type.Union([
  Type.Object(
    {
      models: Type.Array(ProviderModelDescriptorSchema),
      status: Type.Literal("available"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      reason: Type.Literal("model_list_unsupported"),
      status: Type.Literal("manual_required"),
    },
    { additionalProperties: false },
  ),
]);

export const ProviderConnectionTestSchema = Type.Union([
  Type.Object(
    {
      modelCount: Type.Integer({ minimum: 0 }),
      status: Type.Literal("connected"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      reason: Type.Literal("model_list_unsupported"),
      status: Type.Literal("manual_required"),
    },
    { additionalProperties: false },
  ),
]);

function operationResponse<TValue extends TSchema>(value: TValue) {
  return Type.Union([
    Type.Object(
      { ok: Type.Literal(true), value },
      { additionalProperties: false },
    ),
    Type.Object(
      { error: AppErrorSchema, ok: Type.Literal(false) },
      { additionalProperties: false },
    ),
  ]);
}

export const ProviderListProfilesResponseSchema = operationResponse(
  Type.Array(ProviderProfileSchema),
);
export const ProviderSaveProfileResponseSchema = operationResponse(
  ProviderProfileSchema,
);
export const ProviderDeleteProfileResponseSchema = operationResponse(
  Type.Object({ profileId: EntityIdSchema }, { additionalProperties: false }),
);
export const ProviderDiscoverModelsResponseSchema = operationResponse(
  ProviderModelDiscoverySchema,
);
export const ProviderTestConnectionResponseSchema = operationResponse(
  ProviderConnectionTestSchema,
);
