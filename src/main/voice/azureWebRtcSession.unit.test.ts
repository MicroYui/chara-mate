import { describe, expect, it, vi } from "vitest";

import type { RealtimeProviderRuntime } from "../providers/providerService";
import { AzureWebRtcSessionIssuer } from "./azureWebRtcSession";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

function runtime(
  endpoint = "https://unit.openai.azure.com/openai/v1/realtime?model=old",
) {
  return {
    apiKey: "test-key",
    profile: {
      apiStyle: "azure-openai",
      baseUrl: "https://unit.openai.azure.com/openai/v1",
      id: PROFILE_ID,
      name: "Azure Realtime",
      realtimeEndpoint: endpoint,
      realtimeModel: "gpt-realtime-2.1",
    },
    snapshot: {
      apiStyle: "azure-openai",
      modelId: "gpt-realtime-2.1",
      profileId: PROFILE_ID,
      profileName: "Azure Realtime",
    },
  } satisfies RealtimeProviderRuntime;
}

describe("Azure GA WebRTC session issuer", () => {
  it("derives the single GA endpoint and requests a manual-turn ephemeral session", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ expires_at: 1_786_190_460, value: "ephemeral" }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    const issuer = new AzureWebRtcSessionIssuer(fetchImplementation);

    await expect(
      issuer.issue(runtime(), {
        instructions: "自然、简洁地说中文。",
        tools: [
          {
            description: "查询天气",
            name: "weather_lookup",
            parameters: { additionalProperties: false, type: "object" },
            type: "function",
          },
        ],
        voice: "verse",
      }),
    ).resolves.toEqual({
      callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
      clientSecret: "ephemeral",
      expiresAt: "2026-08-08T12:01:00.000Z",
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://unit.openai.azure.com/openai/v1/realtime/client_secrets",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.headers).toEqual({
      "api-key": "test-key",
      "content-type": "application/json",
    });
    if (typeof init?.body !== "string") throw new Error("Missing JSON body");
    const requestBody = JSON.parse(init.body) as unknown;
    expect(requestBody).toMatchObject({
      session: {
        audio: {
          input: {
            transcription: {
              model: "whisper-1",
            },
            turn_detection: {
              create_response: false,
              interrupt_response: true,
              type: "server_vad",
            },
          },
          output: { voice: "verse" },
        },
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        parallel_tool_calls: false,
        tool_choice: "auto",
        tools: [
          expect.objectContaining({
            name: "weather_lookup",
            type: "function",
          }),
        ],
      },
    });
    expect(JSON.stringify(requestBody)).toContain("简体中文");
  });

  it("rejects non-GA and non-HTTPS endpoints before networking", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const issuer = new AzureWebRtcSessionIssuer(fetchImplementation);

    await expect(
      issuer.issue(runtime("wss://unit.openai.azure.com/openai/realtime"), {
        instructions: "自然说话。",
        voice: "verse",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER.INVALID_CONFIGURATION" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("preserves Azure's structured request error for configuration diagnosis", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_value",
            message: "Unsupported tool schema",
            param: "session.tools[0].parameters",
          },
        }),
        { headers: { "content-type": "application/json" }, status: 400 },
      ),
    );
    const issuer = new AzureWebRtcSessionIssuer(fetchImplementation);

    await expect(
      issuer.issue(runtime(), {
        instructions: "自然说话。",
        voice: "verse",
      }),
    ).rejects.toThrow(
      "invalid_value · session.tools[0].parameters · Unsupported tool schema",
    );
  });
});
