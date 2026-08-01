import type { Static } from "@sinclair/typebox";

import type {
  ProviderApiStyleSchema,
  ProviderConnectionSchema,
  ProviderConnectionTestSchema,
  ProviderCredentialUpdateSchema,
  ProviderDeleteProfileRequestSchema,
  ProviderDeleteProfileResponseSchema,
  ProviderDiscoverModelsRequestSchema,
  ProviderDiscoverModelsResponseSchema,
  ProviderListProfilesResponseSchema,
  ProviderModelDescriptorSchema,
  ProviderModelDiscoverySchema,
  ProviderProfileDraftSchema,
  ProviderProfileSchema,
  ProviderSaveProfileRequestSchema,
  ProviderSaveProfileResponseSchema,
  ProviderSnapshotSchema,
  ProviderTestCapabilitySchema,
  ProviderTestConnectionRequestSchema,
  ProviderTestConnectionResponseSchema,
} from "../schemas/provider";

export const PROVIDER_CHANNELS = {
  deleteProfile: "provider.deleteProfile",
  discoverModels: "provider.discoverModels",
  listProfiles: "provider.listProfiles",
  saveProfile: "provider.saveProfile",
  testConnection: "provider.testConnection",
} as const;

export type ProviderApiStyle = Static<typeof ProviderApiStyleSchema>;
export type ProviderSnapshot = Static<typeof ProviderSnapshotSchema>;
export type ProviderProfileDraft = Static<typeof ProviderProfileDraftSchema>;
export type ProviderProfile = Static<typeof ProviderProfileSchema>;
export type ProviderCredentialUpdate = Static<
  typeof ProviderCredentialUpdateSchema
>;
export type ProviderConnection = Static<typeof ProviderConnectionSchema>;
export type ProviderModelDescriptor = Static<
  typeof ProviderModelDescriptorSchema
>;
export type ProviderModelDiscovery = Static<
  typeof ProviderModelDiscoverySchema
>;
export type ProviderConnectionTest = Static<
  typeof ProviderConnectionTestSchema
>;
export type ProviderTestCapability = Static<
  typeof ProviderTestCapabilitySchema
>;
export type ProviderSaveProfileRequest = Static<
  typeof ProviderSaveProfileRequestSchema
>;
export type ProviderDeleteProfileRequest = Static<
  typeof ProviderDeleteProfileRequestSchema
>;
export type ProviderDiscoverModelsRequest = Static<
  typeof ProviderDiscoverModelsRequestSchema
>;
export type ProviderTestConnectionRequest = Static<
  typeof ProviderTestConnectionRequestSchema
>;
export type ProviderListProfilesResponse = Static<
  typeof ProviderListProfilesResponseSchema
>;
export type ProviderSaveProfileResponse = Static<
  typeof ProviderSaveProfileResponseSchema
>;
export type ProviderDeleteProfileResponse = Static<
  typeof ProviderDeleteProfileResponseSchema
>;
export type ProviderDiscoverModelsResponse = Static<
  typeof ProviderDiscoverModelsResponseSchema
>;
export type ProviderTestConnectionResponse = Static<
  typeof ProviderTestConnectionResponseSchema
>;

export interface ProviderApi {
  deleteProfile(
    request: ProviderDeleteProfileRequest,
  ): Promise<ProviderDeleteProfileResponse>;
  discoverModels(
    request: ProviderDiscoverModelsRequest,
  ): Promise<ProviderDiscoverModelsResponse>;
  listProfiles(): Promise<ProviderListProfilesResponse>;
  saveProfile(
    request: ProviderSaveProfileRequest,
  ): Promise<ProviderSaveProfileResponse>;
  testConnection(
    request: ProviderTestConnectionRequest,
  ): Promise<ProviderTestConnectionResponse>;
}
