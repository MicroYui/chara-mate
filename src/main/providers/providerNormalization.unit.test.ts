import { describe, expect, it } from "vitest";

import { normalizeProviderDraft } from "./providerNormalization";

describe("Provider configuration normalization", () => {
  it("normalizes one OpenAI-compatible profile without adding Azure fields", () => {
    expect(
      normalizeProviderDraft({
        apiStyle: "openai-compatible",
        baseUrl: " https://api.example.com/v1/ ",
        chatModel: " model-a ",
        name: " Example Provider ",
      }),
    ).toEqual({
      apiStyle: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      chatModel: "model-a",
      name: "Example Provider",
    });
  });

  it("keeps Azure API Version and endpoint query parameters", () => {
    expect(
      normalizeProviderDraft({
        apiStyle: "azure-openai",
        apiVersion: " 2025-04-01-preview ",
        baseUrl: "https://example.openai.azure.com/",
        imageGenerationEndpoint:
          "https://example.openai.azure.com/openai/deployments/image/images/generations?api-version=2025-04-01-preview",
        name: " Azure ",
      }),
    ).toEqual({
      apiStyle: "azure-openai",
      apiVersion: "2025-04-01-preview",
      baseUrl: "https://example.openai.azure.com",
      imageGenerationEndpoint:
        "https://example.openai.azure.com/openai/deployments/image/images/generations?api-version=2025-04-01-preview",
      name: "Azure",
    });
  });

  it("accepts a Realtime-only Azure profile without an API Version", () => {
    expect(
      normalizeProviderDraft({
        apiStyle: "azure-openai",
        apiVersion: "   ",
        baseUrl: "https://example.openai.azure.com/",
        name: " Azure Realtime ",
        realtimeEndpoint: "https://example.openai.azure.com/openai/v1/realtime",
        realtimeModel: " gpt-realtime-2.1 ",
      }),
    ).toEqual({
      apiStyle: "azure-openai",
      baseUrl: "https://example.openai.azure.com",
      name: "Azure Realtime",
      realtimeEndpoint: "https://example.openai.azure.com/openai/v1/realtime",
      realtimeModel: "gpt-realtime-2.1",
    });
  });

  it.each([
    "file:///tmp/provider",
    "https://user:password@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "not a url",
  ])("rejects unsafe or malformed Base URL %s", (baseUrl) => {
    expect(() =>
      normalizeProviderDraft({
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Example",
      }),
    ).toThrow();
  });
});
