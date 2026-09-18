import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceApi,
  VoiceConnection,
} from "../../../shared/contracts/voice";
import {
  voiceToolResultEvents,
  voicePreviewEvents,
  VOICE_PREVIEW_PHRASE,
} from "../../../shared/contracts/voice";
import { VoiceDriverEventRequestSchema } from "../../../shared/schemas/voice";
import { parseSchema } from "../../../shared/schemas/validation";
import { previewVoice, WebRtcVoiceDriver } from "./WebRtcVoiceDriver";

import {
  FakePeerConnection,
  type FakeDataChannel,
  FakeAudioContext,
  installVoiceBrowserFixture,
} from "../../../../tests/fixtures/webrtcVoiceBrowser";

const connection: VoiceConnection = {
  callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
  clientSecret: "ephemeral",
  expiresAt: "2026-08-08T12:01:00.000Z",
  history: [
    { content: "之前的问题", role: "user" },
    { content: "之前的回答", role: "assistant" },
  ],
  inputMode: "hands_free",
  sessionId: "10000000-0000-4000-8000-000000000001",
  voice: "verse",
};

function api() {
  const report = vi.fn<VoiceApi["report"]>().mockResolvedValue({
    ok: true,
    value: null,
  });
  return {
    report,
    value: {
      cancelStart: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { outcome: "accepted" } }),
      end: vi.fn(),
      getActive: vi.fn(),
      preview: vi.fn(),
      quickStart: vi.fn(),
      report,
      setMuted: vi.fn(),
      setPaused: vi.fn(),
      start: vi.fn(),
      subscribeChanged: vi.fn(),
      subscribeCommand: vi.fn(),
    } satisfies VoiceApi,
  };
}

function sent(channel: FakeDataChannel) {
  return channel.sent.map((value) => JSON.parse(value) as unknown);
}

beforeEach(() => {
  installVoiceBrowserFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document
    .querySelectorAll("audio[data-charamate-voice-output]")
    .forEach((audio) => audio.remove());
  FakePeerConnection.latest = undefined;
});

describe("WebRTC Voice driver", () => {
  it.each(["response.done", "wake.greeting.done"] as const)(
    "preserves usage presence from actual driver %s reports through the shared schema",
    async (type) => {
      const fixture = api();
      const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
      await driver.connect();
      try {
        const channel = FakePeerConnection.latest?.channel;
        if (!channel) throw new Error("Missing fake data channel");
        const cases = [
          {
            wire: {
              input_tokens: 10,
              input_token_details: { cached_tokens: 2 },
              output_tokens: 4,
            },
            expected: {
              cachedInputTokens: 2,
              inputTokens: 10,
              outputTokens: 4,
            },
          },
          {
            wire: {
              input_tokens: 0,
              input_token_details: { cached_tokens: 0 },
              output_tokens: 0,
            },
            expected: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
          },
          { wire: undefined, expected: undefined },
          { wire: {}, expected: {} },
          { wire: { input_tokens: 10 }, expected: { inputTokens: 10 } },
          { wire: { output_tokens: 4 }, expected: { outputTokens: 4 } },
          {
            wire: { input_token_details: { cached_tokens: 2 } },
            expected: { cachedInputTokens: 2 },
          },
        ];
        for (const [index, sample] of cases.entries()) {
          const requestId = `10000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`;
          const responseId = `usage-${String(index)}`;
          const generation = index + 1;
          if (type === "wake.greeting.done") {
            driver.handle({
              instructions: "简短欢迎。",
              prompt: "Hi",
              requestId,
              sessionId: connection.sessionId,
              type: "wake.greeting.create",
            });
          } else {
            driver.handle({
              generation,
              instructions: "简短回答。",
              requestId,
              sessionId: connection.sessionId,
              type: "response.create",
            });
          }
          channel.emit({
            type: "response.created",
            response: {
              id: responseId,
              metadata: {
                charamate_request_id: requestId,
                ...(type === "wake.greeting.done"
                  ? { charamate_purpose: "wake_greeting" }
                  : { charamate_generation: String(generation) }),
              },
            },
          });
          channel.emit({
            type: "response.done",
            response: {
              id: responseId,
              status: "completed",
              ...(sample.wire === undefined ? {} : { usage: sample.wire }),
            },
          });
          await vi.waitFor(() =>
            expect(
              fixture.report.mock.calls.filter(
                ([request]) => request.event.type === type,
              ),
            ).toHaveLength(index + 1),
          );
          const request = fixture.report.mock.calls
            .map(([value]) => value)
            .find(
              (value) =>
                (value.event.type === "response.done" ||
                  value.event.type === "wake.greeting.done") &&
                value.event.type === type &&
                value.event.responseId === responseId,
            );
          if (!request) {
            throw new Error("Missing actual driver completion report");
          }
          const parsed = parseSchema(VoiceDriverEventRequestSchema, request);
          expect(parsed).toEqual(request);
          expect(parsed.event).toEqual({
            type,
            responseId,
            status: "completed",
            hasAudio: false,
            ...(type === "response.done" ? { generation } : {}),
            ...(sample.expected === undefined
              ? {}
              : { usage: sample.expected }),
          });
        }
      } finally {
        driver.close();
      }
    },
  );

  it("seeds Chat history and creates a native Realtime response without a speech script", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");

    channel.emit({ session: { id: "session-1" }, type: "session.created" });
    await vi.waitFor(() =>
      expect(
        fixture.report.mock.calls
          .map(([request]) => request.event)
          .some(({ type }) => type === "session.ready"),
      ).toBe(true),
    );
    expect(
      fixture.report.mock.calls
        .map(([request]) => request.event)
        .filter(({ type }) => type === "connection.stage")
        .map((event) => (event.type === "connection.stage" ? event.stage : "")),
    ).toEqual(["microphone", "ice", "sdp", "data_channel"]);
    expect(sent(channel).slice(0, 2)).toEqual([
      {
        item: {
          content: [{ text: "之前的问题", type: "input_text" }],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      },
      {
        item: {
          content: [{ text: "之前的回答", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
        type: "conversation.item.create",
      },
    ]);

    driver.handle({
      generation: 1,
      instructions: "直接自然回答。",
      requestId: "10000000-0000-4000-8000-000000000002",
      sessionId: connection.sessionId,
      type: "response.create",
    });
    expect(sent(channel).at(-1)).toEqual({
      event_id: "10000000-0000-4000-8000-000000000002",
      response: {
        instructions: "直接自然回答。",
        metadata: {
          charamate_generation: "1",
          charamate_request_id: "10000000-0000-4000-8000-000000000002",
        },
        output_modalities: ["audio"],
      },
      type: "response.create",
    });
    expect(JSON.stringify(sent(channel).at(-1))).not.toContain("input_text");
    driver.close();
  });

  it("reports only metadata actually echoed by response.created", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");
    const requestId = "10000000-0000-4000-8000-000000000020";
    driver.handle({
      generation: 1,
      instructions: "自然回应。",
      requestId,
      sessionId: connection.sessionId,
      type: "response.create",
    });
    channel.emit({
      type: "response.created",
      response: {
        id: "response-correlated",
        metadata: {
          charamate_generation: "1",
          charamate_request_id: requestId,
        },
      },
    });
    channel.emit({
      type: "response.created",
      response: {
        id: "response-unlinked",
        metadata: { charamate_generation: "1" },
      },
    });
    await vi.waitFor(() =>
      expect(
        fixture.report.mock.calls.map(([request]) => request.event),
      ).toEqual(
        expect.arrayContaining([
          {
            type: "response.started",
            generation: 1,
            responseId: "response-correlated",
            requestId,
          },
          {
            type: "response.started",
            generation: 1,
            responseId: "response-unlinked",
          },
        ]),
      ),
    );
    driver.close();
  });

  it("plays a wake greeting as an out-of-band response without reporting a normal turn", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");

    driver.handle({
      instructions: "用一句简短欢迎语确认已经可以聊天。",
      prompt: "Hi Mika",
      requestId: "10000000-0000-4000-8000-000000000010",
      sessionId: connection.sessionId,
      type: "wake.greeting.create",
    });
    expect(sent(channel).at(-1)).toEqual({
      event_id: "10000000-0000-4000-8000-000000000010",
      response: {
        conversation: "none",
        input: [
          {
            content: [{ text: "Hi Mika", type: "input_text" }],
            role: "user",
            type: "message",
          },
        ],
        instructions: "用一句简短欢迎语确认已经可以聊天。",
        metadata: {
          charamate_purpose: "wake_greeting",
          charamate_request_id: "10000000-0000-4000-8000-000000000010",
        },
        output_modalities: ["audio"],
        tools: [],
      },
      type: "response.create",
    });

    channel.emit({
      response: {
        id: "response-wake-greeting",
        metadata: { charamate_purpose: "wake_greeting" },
      },
      type: "response.created",
    });
    channel.emit({
      item: { id: "wake-greeting-item", type: "message" },
      response_id: "response-wake-greeting",
      type: "response.output_item.added",
    });
    channel.emit({
      response_id: "response-wake-greeting",
      type: "output_audio_buffer.started",
    });
    await vi.waitFor(() =>
      expect(
        fixture.report.mock.calls
          .map(([request]) => request.event)
          .some(({ type }) => type === "wake.greeting.audio.started"),
      ).toBe(true),
    );
    channel.emit({
      response: {
        id: "response-wake-greeting",
        status: "completed",
        usage: {
          input_token_details: { cached_tokens: 2 },
          input_tokens: 12,
          output_tokens: 5,
        },
      },
      type: "response.done",
    });
    channel.emit({
      response_id: "response-wake-greeting",
      type: "output_audio_buffer.stopped",
    });

    await vi.waitFor(() => {
      const events = fixture.report.mock.calls.map(
        ([request]) => request.event,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            responseId: "response-wake-greeting",
            type: "wake.greeting.audio.started",
          }),
          expect.objectContaining({
            responseId: "response-wake-greeting",
            type: "wake.greeting.audio.stopped",
          }),
          expect.objectContaining({
            hasAudio: true,
            status: "completed",
            type: "wake.greeting.done",
            usage: {
              cachedInputTokens: 2,
              inputTokens: 12,
              outputTokens: 5,
            },
          }),
        ]),
      );
      expect(events.some(({ type }) => type === "response.started")).toBe(
        false,
      );
      expect(
        events.some(({ type }) => type.startsWith("transcript.assistant")),
      ).toBe(false);
    });
    driver.close();
  });

  it("cancels the wake greeting when the user starts speaking", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");

    driver.handle({
      instructions: "简短欢迎。",
      prompt: "Hi Mika",
      requestId: "10000000-0000-4000-8000-000000000011",
      sessionId: connection.sessionId,
      type: "wake.greeting.create",
    });
    channel.emit({
      response: {
        id: "response-wake-interrupted",
        metadata: { charamate_purpose: "wake_greeting" },
      },
      type: "response.created",
    });
    channel.emit({
      item: { id: "wake-interrupted-item", type: "message" },
      response_id: "response-wake-interrupted",
      type: "response.output_item.added",
    });
    channel.emit({
      response_id: "response-wake-interrupted",
      type: "output_audio_buffer.started",
    });
    await vi.waitFor(() =>
      expect(
        fixture.report.mock.calls
          .map(([request]) => request.event)
          .some(({ type }) => type === "wake.greeting.audio.started"),
      ).toBe(true),
    );

    channel.emit({
      item_id: "user-after-wake",
      type: "input_audio_buffer.speech_started",
    });

    expect(sent(channel).slice(-2)).toEqual([
      {
        response_id: "response-wake-interrupted",
        type: "response.cancel",
      },
      { type: "output_audio_buffer.clear" },
    ]);
    await vi.waitFor(() => {
      const events = fixture.report.mock.calls.map(
        ([request]) => request.event,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "wake.greeting.audio.stopped" }),
          expect.objectContaining({
            itemId: "user-after-wake",
            type: "speech.started",
          }),
        ]),
      );
      const speech = events.find(({ type }) => type === "speech.started");
      expect(speech).not.toHaveProperty("assistantItemId");
    });
    driver.close();
  });

  it("rejects a late wake greeting response when speech begins before response.created", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");

    driver.handle({
      instructions: "简短欢迎。",
      prompt: "Hi Mika",
      requestId: "10000000-0000-4000-8000-000000000012",
      sessionId: connection.sessionId,
      type: "wake.greeting.create",
    });
    channel.emit({
      item_id: "user-before-wake-response",
      type: "input_audio_buffer.speech_started",
    });
    channel.emit({
      response: {
        id: "late-wake-greeting",
        metadata: { charamate_purpose: "wake_greeting" },
      },
      type: "response.created",
    });

    expect(sent(channel).slice(-2)).toEqual([
      { response_id: "late-wake-greeting", type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
    channel.emit({
      response_id: "late-wake-greeting",
      type: "output_audio_buffer.started",
    });
    await Promise.resolve();
    expect(
      fixture.report.mock.calls
        .map(([request]) => request.event)
        .some(({ type }) => type === "wake.greeting.audio.started"),
    ).toBe(false);
    driver.close();
  });

  it("keeps the data channel open while refreshing a paused session", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");

    driver.handle({
      enabled: false,
      sessionId: connection.sessionId,
      type: "playback.set",
    });
    driver.handle({
      instructions: "恢复后的新指令。",
      requestId: "10000000-0000-4000-8000-000000000009",
      sessionId: connection.sessionId,
      tools: [
        {
          description: "读取天气。",
          name: "weather_lookup",
          parameters: { properties: {}, type: "object" },
          type: "function",
        },
      ],
      type: "session.refresh",
    });
    expect(sent(channel).at(-1)).toEqual({
      event_id: "10000000-0000-4000-8000-000000000009",
      session: {
        instructions: "恢复后的新指令。",
        parallel_tool_calls: false,
        tool_choice: "auto",
        tools: [
          {
            description: "读取天气。",
            name: "weather_lookup",
            parameters: { properties: {}, type: "object" },
            type: "function",
          },
        ],
        type: "realtime",
      },
      type: "session.update",
    });
    expect(channel.readyState).toBe("open");

    channel.emit({ type: "session.updated" });
    await vi.waitFor(() =>
      expect(
        fixture.report.mock.calls
          .map(([request]) => request.event)
          .find(({ type }) => type === "session.refreshed"),
      ).toMatchObject({
        requestId: "10000000-0000-4000-8000-000000000009",
        type: "session.refreshed",
      }),
    );
    driver.close();
  });

  it("preserves Realtime output item order in assistant transcripts", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");
    driver.handle({
      generation: 1,
      instructions: "直接回答。",
      requestId: "10000000-0000-4000-8000-000000000006",
      sessionId: connection.sessionId,
      type: "response.create",
    });
    channel.emit({
      response: {
        id: "response-transcript",
        metadata: { charamate_generation: "1" },
      },
      type: "response.created",
    });
    channel.emit({
      delta: "第二段",
      item_id: "assistant-item-2",
      output_index: 1,
      response_id: "response-transcript",
      type: "response.output_audio_transcript.delta",
    });
    channel.emit({
      item_id: "assistant-item-2",
      output_index: 1,
      response_id: "response-transcript",
      transcript: "第二段",
      type: "response.output_audio_transcript.done",
    });

    await vi.waitFor(() => {
      const transcriptEvents = fixture.report.mock.calls
        .map(([request]) => request.event)
        .filter(({ type }) => type.startsWith("transcript.assistant"));
      expect(transcriptEvents).toMatchObject([
        {
          itemId: "assistant-item-2",
          outputIndex: 1,
          type: "transcript.assistant.delta",
        },
        {
          itemId: "assistant-item-2",
          outputIndex: 1,
          type: "transcript.assistant.done",
        },
      ]);
    });
    driver.close();
  });

  it("reports native function calls and continues with function_call_output", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");
    driver.handle({
      generation: 2,
      instructions: "使用工具后回答。",
      requestId: "10000000-0000-4000-8000-000000000003",
      sessionId: connection.sessionId,
      type: "response.create",
    });
    channel.emit({
      response: {
        id: "response-tool",
        metadata: { charamate_generation: "2" },
      },
      type: "response.created",
    });
    channel.emit({
      arguments: '{"city":"北京"}',
      call_id: "call-weather",
      item_id: "item-tool",
      name: "weather_lookup",
      response_id: "response-tool",
      type: "response.function_call_arguments.done",
    });
    await vi.waitFor(() => {
      const toolCall = fixture.report.mock.calls
        .map(([request]) => request.event)
        .find((event) => event.type === "tool.call");
      expect(toolCall).toMatchObject({
        callId: "call-weather",
        generation: 2,
        name: "weather_lookup",
        type: "tool.call",
      });
    });

    const command = {
      callId: "call-weather",
      generation: 2,
      instructions: "使用工具后回答。",
      output: '{"status":"success","summary":"晴"}',
      requestId: "10000000-0000-4000-8000-000000000004",
      sessionId: connection.sessionId,
      type: "tool.result" as const,
    };
    const beforeResult = channel.sent.length;
    driver.handle(command);
    expect(channel.sent.slice(beforeResult)).toEqual(
      voiceToolResultEvents(command).map((event) => JSON.stringify(event)),
    );
    expect(sent(channel).slice(-2)).toEqual([
      {
        event_id: "10000000-0000-4000-8000-000000000004.output",
        item: {
          call_id: "call-weather",
          output: '{"status":"success","summary":"晴"}',
          type: "function_call_output",
        },
        type: "conversation.item.create",
      },
      {
        event_id: "10000000-0000-4000-8000-000000000004",
        response: {
          instructions: "使用工具后回答。",
          metadata: {
            charamate_generation: "2",
            charamate_request_id: "10000000-0000-4000-8000-000000000004",
          },
          output_modalities: ["audio"],
        },
        type: "response.create",
      },
    ]);
    driver.close();
  });

  it("keeps tool continuation audible when the prior response drains late", async () => {
    const fixture = api();
    const driver = new WebRtcVoiceDriver(fixture.value, connection, vi.fn());
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");
    driver.handle({
      generation: 2,
      instructions: "使用工具后回答。",
      requestId: "10000000-0000-4000-8000-000000000007",
      sessionId: connection.sessionId,
      type: "response.create",
    });
    channel.emit({
      response: {
        id: "response-before-tool",
        metadata: { charamate_generation: "2" },
      },
      type: "response.created",
    });
    channel.emit({
      item: { id: "assistant-before-tool", type: "message" },
      response_id: "response-before-tool",
      type: "response.output_item.added",
    });
    channel.emit({
      response_id: "response-before-tool",
      type: "output_audio_buffer.started",
    });
    const audio = document.querySelector<HTMLAudioElement>(
      "audio[data-charamate-voice-output]",
    );
    await vi.waitFor(() => expect(audio?.muted).toBe(false));

    driver.handle({
      callId: "call-weather",
      generation: 2,
      instructions: "使用工具后回答。",
      output: '{"status":"success","summary":"晴"}',
      requestId: "10000000-0000-4000-8000-000000000008",
      sessionId: connection.sessionId,
      type: "tool.result",
    });
    channel.emit({
      response: {
        id: "response-after-tool",
        metadata: { charamate_generation: "2" },
      },
      type: "response.created",
    });
    channel.emit({
      item: { id: "assistant-after-tool", type: "message" },
      response_id: "response-after-tool",
      type: "response.output_item.added",
    });
    channel.emit({
      response_id: "response-after-tool",
      type: "output_audio_buffer.started",
    });
    await vi.waitFor(() => expect(audio?.muted).toBe(false));
    channel.emit({
      response: { id: "response-after-tool", status: "completed" },
      type: "response.done",
    });
    let responseDone = fixture.report.mock.calls
      .map(([request]) => request.event)
      .find(({ type }) => type === "response.done");
    await vi.waitFor(() => {
      responseDone = fixture.report.mock.calls
        .map(([request]) => request.event)
        .find(({ type }) => type === "response.done");
      expect(responseDone).toBeDefined();
    });
    expect(responseDone).toMatchObject({
      hasAudio: true,
      responseId: "response-after-tool",
      type: "response.done",
    });

    channel.emit({
      response_id: "response-before-tool",
      type: "output_audio_buffer.stopped",
    });
    expect(audio?.muted).toBe(false);

    channel.emit({
      response_id: "response-after-tool",
      type: "output_audio_buffer.stopped",
    });
    expect(audio?.muted).toBe(true);
    driver.close();
  });

  it("mutes immediately on barge-in and surfaces report failures", async () => {
    const fixture = api();
    fixture.report.mockRejectedValueOnce(new Error("main rejected event"));
    const errors: string[] = [];
    const driver = new WebRtcVoiceDriver(
      fixture.value,
      connection,
      vi.fn(),
      new FakeAudioContext() as unknown as AudioContext,
      (message) => errors.push(message),
    );
    await driver.connect();
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake data channel");
    driver.handle({
      generation: 1,
      instructions: "回答。",
      requestId: "10000000-0000-4000-8000-000000000005",
      sessionId: connection.sessionId,
      type: "response.create",
    });
    channel.emit({
      response: {
        id: "response-1",
        metadata: { charamate_generation: "1" },
      },
      type: "response.created",
    });
    channel.emit({
      item: { id: "assistant-1", type: "message" },
      response_id: "response-1",
      type: "response.output_item.added",
    });
    channel.emit({
      item_id: "assistant-1",
      response_id: "response-1",
      type: "output_audio_buffer.started",
    });
    await vi.waitFor(() => {
      const audio = document.querySelector<HTMLAudioElement>(
        "audio[data-charamate-voice-output]",
      );
      expect(audio?.muted).toBe(false);
    });
    channel.emit({
      item_id: "user-2",
      type: "input_audio_buffer.speech_started",
    });
    const audio = document.querySelector<HTMLAudioElement>(
      "audio[data-charamate-voice-output]",
    );
    expect(audio?.muted).toBe(true);
    await vi.waitFor(() => expect(errors).toEqual(["main rejected event"]));
    driver.close();
  });

  it("plays a native Realtime preview and removes its media element", async () => {
    const task = previewVoice(
      {
        callsUrl: connection.callsUrl,
        clientSecret: connection.clientSecret,
        expiresAt: connection.expiresAt,
      },
      VOICE_PREVIEW_PHRASE,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(FakePeerConnection.latest).toBeDefined());
    const channel = FakePeerConnection.latest?.channel;
    if (!channel) throw new Error("Missing fake preview data channel");

    channel.emit({
      session: { id: "preview-session" },
      type: "session.created",
    });
    await vi.waitFor(() => expect(sent(channel)).toHaveLength(2));
    expect(sent(channel)).toEqual([
      {
        item: {
          content: [{ text: VOICE_PREVIEW_PHRASE, type: "input_text" }],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      },
      { type: "response.create" },
    ]);
    expect(channel.sent).toEqual(
      voicePreviewEvents().map((event) => JSON.stringify(event)),
    );
    channel.emit({ type: "output_audio_buffer.stopped" });

    await expect(task).resolves.toBeUndefined();
    expect(
      document.querySelector("audio[data-charamate-voice-preview]"),
    ).toBeNull();
  });
});

it.each(["ice", "sdp", "channel"] as const)(
  "closes the actual %s preparation wait and releases its listeners",
  async (stage) => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const driver = new WebRtcVoiceDriver(api().value, connection, vi.fn());
    const peer = FakePeerConnection.latest!;
    const channel = peer.channel;
    let signal: AbortSignal | undefined;
    if (stage === "ice") {
      peer.iceGatheringState = "gathering";
      const add = peer.addEventListener.bind(peer);
      vi.spyOn(peer, "addEventListener").mockImplementation(
        (type, listener, options) => {
          add(type, listener, options);
          if (type === "icegatheringstatechange") enter();
        },
      );
    } else if (stage === "sdp") {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              signal = options?.signal ?? undefined;
              if (!signal) throw new Error("SDP has no owned signal");
              signal.addEventListener(
                "abort",
                () => {
                  const reason: unknown = signal?.reason;
                  reject(
                    reason instanceof Error
                      ? reason
                      : new DOMException("Operation was aborted", "AbortError"),
                  );
                },
                { once: true },
              );
              enter();
            }),
        ),
      );
    } else {
      channel.readyState = "connecting";
      const add = channel.addEventListener.bind(channel);
      vi.spyOn(channel, "addEventListener").mockImplementation(
        (type, listener, options) => {
          add(type, listener, options);
          if (type === "open") enter();
        },
      );
    }
    const removedPeer = vi.spyOn(peer, "removeEventListener");
    const removedChannel = vi.spyOn(channel, "removeEventListener");
    const task = driver.connect().catch((error: unknown) => error);
    await entered;
    driver.close();
    expect(await task).toMatchObject({ name: "AbortError" });
    expect(peer.connectionState).toBe("closed");
    expect(channel.readyState).toBe("closed");
    if (stage === "ice")
      expect(
        removedPeer.mock.calls.some(
          ([type]) => type === "icegatheringstatechange",
        ),
      ).toBe(true);
    if (stage === "sdp") expect(signal?.aborted).toBe(true);
    if (stage === "channel")
      expect(removedChannel.mock.calls.some(([type]) => type === "open")).toBe(
        true,
      );
    expect(
      document.querySelector("audio[data-charamate-voice-output]"),
    ).toBeNull();
  },
);
