import { describe, expect, it } from "vitest";

import { AzureTerritoryImageProvider } from "../../src/main/providers/azureImageProvider";

const endpoint = process.env["CHARAMATE_LIVE_AZURE_IMAGE_ENDPOINT"];
const apiKey = process.env["CHARAMATE_LIVE_AZURE_IMAGE_API_KEY"];
const model = process.env["CHARAMATE_LIVE_AZURE_IMAGE_MODEL"] ?? "gpt-image-2";
const configured = Boolean(endpoint && apiKey);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe.skipIf(!configured)("live Azure Territory Image", () => {
  it("generates and edits through the configured deployment", async () => {
    const generationEndpoint = endpoint!;
    const url = new URL(generationEndpoint);
    const provider = new AzureTerritoryImageProvider(
      {
        apiStyle: "azure-openai",
        ...(url.searchParams.get("api-version")
          ? {}
          : {
              apiVersion:
                process.env["CHARAMATE_LIVE_AZURE_IMAGE_API_VERSION"] ??
                "2025-04-01-preview",
            }),
        baseUrl: url.origin,
        imageGenerationEndpoint: generationEndpoint,
        imageModel: model,
        name: "Live Azure Image",
      },
      apiKey!,
    );
    const generated = await provider.generate(
      "A single small brass pixel-art desk lamp, centered with generous margin, on one flat pure magenta (#ff00ff) background. No room, text, frame, floor, or shadow.",
    );
    const edited = await provider.edit(
      generated,
      "Keep the same isolated pixel-art lamp and change only its shade to amber glass. Preserve the pure magenta background and generous margin.",
    );

    expect(generated.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(edited.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  }, 600_000);
});
