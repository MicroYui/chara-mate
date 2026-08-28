import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceApi,
  VoiceConnection,
} from "../../../shared/contracts/voice";
import { previewVoice, WebRtcVoiceDriver } from "./WebRtcVoiceDriver";

class FakeDataChannel extends EventTarget {
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "open";

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  emit(value: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

class FakePeerConnection extends EventTarget {
  static latest: FakePeerConnection | undefined;
  readonly channel = new FakeDataChannel();
  connectionState: RTCPeerConnectionState = "connected";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;

  constructor() {
    super();
    FakePeerConnection.latest = this;
  }

  addTrack(): void {}
  addTransceiver(): RTCRtpTransceiver {
    return {} as RTCRtpTransceiver;
  }
  close(): void {}
  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ sdp: "offer-sdp", type: "offer" });
  }
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    return Promise.resolve();
  }
  setRemoteDescription(): Promise<void> {
    const event = new Event("track");
    Object.defineProperties(event, {
      streams: { value: [{}] },
      track: { value: {} },
    });
    this.dispatchEvent(event);
    return Promise.resolve();
  }
}

class FakeAnalyser {
  fftSize = 256;
  connect(): void {}
  disconnect(): void {}
  getByteTimeDomainData(samples: Uint8Array): void {
    samples.fill(128);
  }
}

class FakeGain {
  readonly gain = { value: 0 };
  connect(): void {}
}

class FakeAudioContext {
  readonly currentTime = 4;
  readonly destination = {};
  state: AudioContextState = "suspended";

  createAnalyser(): AnalyserNode {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }
  createGain(): GainNode {
    return new FakeGain() as unknown as GainNode;
  }
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
}

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
  const track = { enabled: false, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("answer-sdp")));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
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
        metadata: { charamate_generation: "1" },
        output_modalities: ["audio"],
      },
      type: "response.create",
    });
    expect(JSON.stringify(sent(channel).at(-1))).not.toContain("input_text");
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

    driver.handle({
      callId: "call-weather",
      generation: 2,
      instructions: "使用工具后回答。",
      output: '{"status":"success","summary":"晴"}',
      requestId: "10000000-0000-4000-8000-000000000004",
      sessionId: connection.sessionId,
      type: "tool.result",
    });
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
          metadata: { charamate_generation: "2" },
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
      "你好，我是 CharaMate。",
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
          content: [{ text: "你好，我是 CharaMate。", type: "input_text" }],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      },
      { type: "response.create" },
    ]);
    channel.emit({ type: "output_audio_buffer.stopped" });

    await expect(task).resolves.toBeUndefined();
    expect(
      document.querySelector("audio[data-charamate-voice-preview]"),
    ).toBeNull();
  });
});
