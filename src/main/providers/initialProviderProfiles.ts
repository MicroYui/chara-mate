import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import type { ProviderRecord } from "./providerRepository";

export const INITIAL_PROVIDER_PROFILES = [
  {
    apiStyle: "openai-compatible",
    baseUrl: "http://localhost:4141/v1",
    chatModel: "gpt-5.6-sol",
    id: "a71b58c9-baba-42d3-b5d2-b9c6597bc186",
    name: "copilot_api",
  },
  {
    apiStyle: "azure-openai",
    apiVersion: "2025-04-01-preview",
    baseUrl: "https://datasetannotator-openai.openai.azure.com",
    id: "d0197d17-a231-41e0-afe2-664791a531ec",
    imageGenerationEndpoint:
      "https://datasetannotator-openai.openai.azure.com/openai/deployments/gpt-image-2/images/generations",
    imageModel: "gpt-image-2",
    name: "azure",
    realtimeEndpoint:
      "https://datasetannotator-openai.openai.azure.com/openai/v1/realtime",
    realtimeModel: "gpt-realtime-2.1",
  },
] as const satisfies readonly ProviderProfileDraft[];

export function createInitialProviderRecords(
  timestamp: string,
): ProviderRecord[] {
  return INITIAL_PROVIDER_PROFILES.map((profile) => ({
    ...profile,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}
