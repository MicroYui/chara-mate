import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import type { RealtimeProviderRuntime } from "../../src/main/providers/providerService";
import { AzureWebRtcSessionIssuer } from "../../src/main/voice/azureWebRtcSession";
import type { VoicePreviewConnection } from "../../src/shared/contracts/voice";

const apiKey = process.env["AZURE_OPENAI_API_KEY"];
const resourceEndpoint = process.env["AZURE_OPENAI_ENDPOINT"];
const model = process.env["AZURE_OPENAI_REALTIME_MODEL"] ?? "gpt-realtime-2.1";
const configured = Boolean(apiKey && resourceEndpoint);
const execFileAsync = promisify(execFile);

function realtimeEndpoint(value: string): string {
  const endpoint = new URL(value);
  endpoint.pathname = "/openai/v1/realtime";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

function liveRuntime(): RealtimeProviderRuntime {
  return {
    apiKey: apiKey!,
    profile: {
      apiStyle: "azure-openai",
      baseUrl: new URL("/openai/v1", resourceEndpoint).toString(),
      id: "10000000-0000-4000-8000-000000000001",
      name: "Azure Voice Live",
      realtimeEndpoint: realtimeEndpoint(resourceEndpoint!),
      realtimeModel: model,
    },
    snapshot: {
      apiStyle: "azure-openai",
      modelId: model,
      profileId: "10000000-0000-4000-8000-000000000001",
      profileName: "Azure Voice Live",
    },
  };
}

async function negotiate(
  connection: VoicePreviewConnection,
  scenario: "answer" | "tool",
) {
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    return await page.evaluate<
      {
        readonly audioStarted: boolean;
        readonly completedResponses: number;
        readonly functionCalls: number;
        readonly metadataMatched: number;
        readonly remoteAudio: boolean;
        readonly transcript: string;
      },
      { connection: VoicePreviewConnection; scenario: "answer" | "tool" }
    >(
      async ({ connection: { callsUrl, clientSecret }, scenario }) => {
        const peer = new RTCPeerConnection();
        peer.addTransceiver("audio", { direction: "recvonly" });
        const channel = peer.createDataChannel("oai-events");
        const generation = "9";
        let audioStarted = false;
        let completedResponses = 0;
        let functionCalls = 0;
        let metadataMatched = 0;
        let remoteAudio = false;
        let transcript = "";
        let toolOutputSent = false;

        const opened = new Promise<void>((resolve, reject) => {
          channel.addEventListener("open", () => resolve(), { once: true });
          channel.addEventListener(
            "error",
            () => reject(new Error("Realtime data channel failed to open")),
            { once: true },
          );
        });
        peer.addEventListener("track", (event) => {
          if (event.track.kind === "audio") remoteAudio = true;
        });

        const result = new Promise<{
          readonly audioStarted: boolean;
          readonly completedResponses: number;
          readonly functionCalls: number;
          readonly metadataMatched: number;
          readonly remoteAudio: boolean;
          readonly transcript: string;
        }>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("Realtime native response timed out")),
            35_000,
          );
          const finish = () => {
            if (!transcript.trim() || !audioStarted) return;
            if (completedResponses < (scenario === "tool" ? 2 : 1)) return;
            if (
              scenario === "tool" &&
              (!toolOutputSent || functionCalls !== 1)
            ) {
              return;
            }
            window.clearTimeout(timeout);
            resolve({
              audioStarted,
              completedResponses,
              functionCalls,
              metadataMatched,
              remoteAudio,
              transcript,
            });
          };
          channel.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            const value = JSON.parse(event.data) as Record<string, unknown>;
            if (value["type"] === "session.created") {
              channel.send(
                JSON.stringify({
                  item: {
                    content: [
                      {
                        text:
                          scenario === "tool"
                            ? "Call contract_echo once with value hello, then report the result."
                            : "In one short sentence, greet me in English.",
                        type: "input_text",
                      },
                    ],
                    role: "user",
                    type: "message",
                  },
                  type: "conversation.item.create",
                }),
              );
              channel.send(
                JSON.stringify({
                  response: {
                    metadata: { charamate_generation: generation },
                    output_modalities: ["audio"],
                  },
                  type: "response.create",
                }),
              );
            } else if (value["type"] === "response.created") {
              const response = value["response"] as
                Record<string, unknown> | undefined;
              const metadata = response?.["metadata"] as
                Record<string, unknown> | undefined;
              if (metadata?.["charamate_generation"] === generation) {
                metadataMatched += 1;
              }
            } else if (
              value["type"] === "response.function_call_arguments.done"
            ) {
              functionCalls += 1;
              const callId = value["call_id"];
              if (typeof callId !== "string") {
                reject(new Error("Realtime Function Call omitted call_id"));
                return;
              }
              channel.send(
                JSON.stringify({
                  item: {
                    call_id: callId,
                    output: JSON.stringify({
                      echoed: "hello",
                      status: "success",
                    }),
                    type: "function_call_output",
                  },
                  type: "conversation.item.create",
                }),
              );
              toolOutputSent = true;
              channel.send(
                JSON.stringify({
                  response: {
                    metadata: { charamate_generation: generation },
                    output_modalities: ["audio"],
                  },
                  type: "response.create",
                }),
              );
            } else if (
              value["type"] === "response.output_audio_transcript.done" &&
              typeof value["transcript"] === "string"
            ) {
              transcript += `${value["transcript"]} `;
              finish();
            } else if (value["type"] === "output_audio_buffer.started") {
              audioStarted = true;
              finish();
            } else if (value["type"] === "response.done") {
              const response = value["response"] as
                Record<string, unknown> | undefined;
              const status = response?.["status"];
              if (status === "completed") {
                completedResponses += 1;
                finish();
              } else if (status === "failed" || status === "incomplete") {
                reject(
                  new Error(`Realtime response ended as ${String(status)}`),
                );
              }
            } else if (value["type"] === "error") {
              reject(new Error(JSON.stringify(value["error"] ?? value)));
            }
          });
        });

        try {
          await peer.setLocalDescription(await peer.createOffer());
          if (peer.iceGatheringState !== "complete") {
            await new Promise<void>((resolve) => {
              const changed = () => {
                if (peer.iceGatheringState !== "complete") return;
                peer.removeEventListener("icegatheringstatechange", changed);
                resolve();
              };
              peer.addEventListener("icegatheringstatechange", changed);
            });
          }
          const sdp = peer.localDescription?.sdp;
          if (!sdp) throw new Error("WebRTC did not create an SDP offer");
          const answer = await fetch(callsUrl, {
            body: sdp,
            headers: {
              Authorization: `Bearer ${clientSecret}`,
              "Content-Type": "application/sdp",
            },
            method: "POST",
            redirect: "error",
          });
          if (!answer.ok) {
            throw new Error(`Azure Realtime SDP HTTP ${String(answer.status)}`);
          }
          await peer.setRemoteDescription({
            sdp: await answer.text(),
            type: "answer",
          });
          if (channel.readyState !== "open") await opened;
          return await result;
        } finally {
          channel.close();
          peer.close();
        }
      },
      { connection, scenario },
    );
  } finally {
    await browser.close();
  }
}

async function createMixedSpeechFixture(): Promise<{
  readonly dispose: () => Promise<void>;
  readonly wavPath: string;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-voice-live-"),
  );
  const aiffPath = path.join(directory, "mixed.aiff");
  const wavPath = path.join(directory, "mixed.wav");
  await execFileAsync("/usr/bin/say", [
    "-v",
    "Tingting",
    "-r",
    "175",
    "-o",
    aiffPath,
    "[[slnc 2500]] 请打开 CharaMate settings，然后检查 voice model。 [[slnc 2000]]",
  ]);
  await execFileAsync("/usr/bin/afconvert", [
    "-f",
    "WAVE",
    "-d",
    "LEI16@24000",
    aiffPath,
    wavPath,
  ]);
  return {
    dispose: () => rm(directory, { force: true, recursive: true }),
    wavPath,
  };
}

async function transcribeFakeMicrophone(
  connection: VoicePreviewConnection,
  wavPath: string,
) {
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
    ],
    headless: true,
  });
  try {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    await page.goto("https://example.com");
    return await page.evaluate<
      {
        readonly speechStarted: boolean;
        readonly speechStopped: boolean;
        readonly transcript: string;
      },
      VoicePreviewConnection
    >(async ({ callsUrl, clientSecret }) => {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const peer = new RTCPeerConnection();
      for (const track of media.getAudioTracks()) peer.addTrack(track, media);
      const channel = peer.createDataChannel("oai-events");
      let speechStarted = false;
      let speechStopped = false;
      const opened = new Promise<void>((resolve) => {
        channel.addEventListener("open", () => resolve(), { once: true });
      });
      const completed = new Promise<{
        readonly speechStarted: boolean;
        readonly speechStopped: boolean;
        readonly transcript: string;
      }>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("Realtime transcription timed out")),
          25_000,
        );
        channel.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const value = JSON.parse(event.data) as Record<string, unknown>;
          if (value["type"] === "input_audio_buffer.speech_started") {
            speechStarted = true;
          } else if (value["type"] === "input_audio_buffer.speech_stopped") {
            speechStopped = true;
          } else if (
            value["type"] ===
              "conversation.item.input_audio_transcription.completed" &&
            typeof value["transcript"] === "string"
          ) {
            window.clearTimeout(timeout);
            resolve({
              speechStarted,
              speechStopped,
              transcript: value["transcript"],
            });
          } else if (
            value["type"] ===
              "conversation.item.input_audio_transcription.failed" ||
            value["type"] === "error"
          ) {
            window.clearTimeout(timeout);
            reject(new Error(JSON.stringify(value["error"] ?? value)));
          }
        });
      });
      try {
        await peer.setLocalDescription(await peer.createOffer());
        if (peer.iceGatheringState !== "complete") {
          await new Promise<void>((resolve) => {
            const changed = () => {
              if (peer.iceGatheringState !== "complete") return;
              peer.removeEventListener("icegatheringstatechange", changed);
              resolve();
            };
            peer.addEventListener("icegatheringstatechange", changed);
          });
        }
        const sdp = peer.localDescription?.sdp;
        if (!sdp) throw new Error("WebRTC did not create an SDP offer");
        const answer = await fetch(callsUrl, {
          body: sdp,
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          method: "POST",
        });
        if (!answer.ok) throw new Error(`Azure SDP HTTP ${answer.status}`);
        await peer.setRemoteDescription({
          sdp: await answer.text(),
          type: "answer",
        });
        if (channel.readyState !== "open") await opened;
        return await completed;
      } finally {
        for (const track of media.getTracks()) track.stop();
        channel.close();
        peer.close();
      }
    }, connection);
  } finally {
    await browser.close();
  }
}

describe.skipIf(!configured)("Azure Voice live contract", () => {
  it("returns native Realtime transcript and audio without a TTS handoff", async () => {
    const connection = await new AzureWebRtcSessionIssuer().issue(
      liveRuntime(),
      {
        instructions: "Reply naturally and briefly in the user's language.",
        voice: "verse",
      },
      new AbortController().signal,
    );
    const result = await negotiate(connection, "answer");
    expect(result).toMatchObject({
      audioStarted: true,
      functionCalls: 0,
      metadataMatched: 1,
      remoteAudio: true,
    });
    expect(result.completedResponses).toBeGreaterThanOrEqual(1);
    expect(result.transcript.trim().length).toBeGreaterThan(0);
  });

  it("executes one Realtime Function Call and speaks after function_call_output", async () => {
    const connection = await new AzureWebRtcSessionIssuer().issue(
      liveRuntime(),
      {
        instructions:
          "Always call contract_echo exactly once for the user's request. After receiving its output, briefly report the echoed value.",
        tools: [
          {
            description: "Echo a value for a live contract check.",
            name: "contract_echo",
            parameters: {
              additionalProperties: false,
              properties: { value: { type: "string" } },
              required: ["value"],
              type: "object",
            },
            type: "function",
          },
        ],
        voice: "verse",
      },
      new AbortController().signal,
    );
    const result = await negotiate(connection, "tool");
    expect(result).toMatchObject({
      audioStarted: true,
      functionCalls: 1,
      remoteAudio: true,
    });
    expect(result.completedResponses).toBeGreaterThanOrEqual(2);
    expect(result.metadataMatched).toBeGreaterThanOrEqual(2);
    expect(result.transcript.toLowerCase()).toContain("hello");
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps mixed Mandarin and English input in the spoken language",
    async () => {
      const fixture = await createMixedSpeechFixture();
      try {
        const connection = await new AzureWebRtcSessionIssuer().issue(
          liveRuntime(),
          {
            instructions: "Follow the user's current language.",
            voice: "verse",
          },
          new AbortController().signal,
        );
        const result = await transcribeFakeMicrophone(
          connection,
          fixture.wavPath,
        );
        expect(result).toMatchObject({
          speechStarted: true,
          speechStopped: true,
        });
        const normalized = result.transcript.toLowerCase();
        expect(normalized).toContain("charamate");
        expect(normalized).toContain("settings");
        expect(result.transcript).toContain("打开");
        expect(result.transcript).toContain("然后");
        expect(
          ["請", "開", "設", "檢", "聲", "語"].some((value) =>
            result.transcript.includes(value),
          ),
        ).toBe(false);
        expect(
          [...result.transcript].some((value) => {
            const code = value.codePointAt(0) ?? 0;
            return code >= 0xac00 && code <= 0xd7af;
          }),
        ).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
  );
});
