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
        imageEditEndpoint:
          "https://example.openai.azure.com/openai/deployments/image/images/edits?api-version=2025-04-01-preview",
        name: " Azure ",
      }),
    ).toEqual({
      apiStyle: "azure-openai",
      apiVersion: "2025-04-01-preview",
      baseUrl: "https://example.openai.azure.com",
      imageEditEndpoint:
        "https://example.openai.azure.com/openai/deployments/image/images/edits?api-version=2025-04-01-preview",
      name: "Azure",
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
