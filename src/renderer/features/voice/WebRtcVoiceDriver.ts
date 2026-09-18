import type {
  VoiceApi,
  VoiceClientCommand,
  VoiceConnection,
  VoiceDriverEvent,
  VoicePreviewConnection,
} from "../../../shared/contracts/voice";
import {
  voiceResponseCreateEvent,
  voiceHistoryItemEvent,
  voicePreviewEvents,
  voiceSessionRefreshEvent,
  voiceWakeGreetingEvent,
  voiceToolResultEvents,
} from "../../../shared/contracts/voice";

export interface VoiceEnvelope {
  readonly input: number;
  readonly output: number;
}

export interface PreparedMicrophone {
  readonly durationMs: number;
  readonly stream: MediaStream;
}

interface RealtimeEvent {
  readonly [key: string]: unknown;
  readonly type?: unknown;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function responseId(event: RealtimeEvent): string | undefined {
  return text(event["response_id"]) ?? text(object(event["response"])?.["id"]);
}

function itemId(event: RealtimeEvent): string | undefined {
  return text(event["item_id"]) ?? text(object(event["item"])?.["id"]);
}

function outputIndex(event: RealtimeEvent): number | undefined {
  const value = event["output_index"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function responseGeneration(event: RealtimeEvent): number | undefined {
  const metadata = object(object(event["response"])?.["metadata"]);
  const value = metadata?.["charamate_generation"];
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function wakeGreetingResponse(event: RealtimeEvent): boolean {
  const metadata = object(object(event["response"])?.["metadata"]);
  return metadata?.["charamate_purpose"] === "wake_greeting";
}

function usage(event: RealtimeEvent) {
  const value = object(object(event["response"])?.["usage"]);
  if (!value) return undefined;
  const inputDetails = object(value["input_token_details"]);
  const inputTokens = value["input_tokens"];
  const outputTokens = value["output_tokens"];
  const cachedInputTokens = inputDetails?.["cached_tokens"];
  return {
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
  };
}

async function gatherIce(
  peer: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener("icegatheringstatechange", changed);
      peer.removeEventListener("connectionstatechange", changed);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Operation was aborted", "AbortError"),
      );
    };
    const changed = () => {
      if (
        peer.connectionState === "closed" ||
        peer.connectionState === "failed"
      ) {
        cleanup();
        reject(new Error("WebRTC 连接已关闭。"));
      } else if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", changed);
    peer.addEventListener("connectionstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    changed();
  });
}

async function negotiate(
  peer: RTCPeerConnection,
  callsUrl: string,
  clientSecret: string,
  now: () => number,
  signal: AbortSignal,
): Promise<{ readonly iceDurationMs: number; readonly sdpDurationMs: number }> {
  signal.throwIfAborted();
  const offer = await peer.createOffer();
  signal.throwIfAborted();
  await peer.setLocalDescription(offer);
  signal.throwIfAborted();
  const iceStartedAt = now();
  await gatherIce(peer, signal);
  const iceDurationMs = Math.max(0, Math.round(now() - iceStartedAt));
  const sdp = peer.localDescription?.sdp;
  if (!sdp) throw new Error("WebRTC 无法创建本地 SDP。");
  const sdpStartedAt = now();
  let response: Response;
  try {
    response = await fetch(callsUrl, {
      body: sdp,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      method: "POST",
      redirect: "error",
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("WebRTC SDP 协商请求无法发出。", { cause: error });
  }
  signal.throwIfAborted();
  if (!response.ok) {
    throw new Error(`WebRTC SDP 协商失败（HTTP ${String(response.status)}）。`);
  }
  const answer = await response.text();
  signal.throwIfAborted();
  await peer.setRemoteDescription({ sdp: answer, type: "answer" });
  signal.throwIfAborted();
  return {
    iceDurationMs,
    sdpDurationMs: Math.max(0, Math.round(now() - sdpStartedAt)),
  };
}

export async function prepareMicrophone(
  now: () => number = () => performance.now(),
): Promise<PreparedMicrophone> {
  const startedAt = now();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  return {
    durationMs: Math.max(0, Math.round(now() - startedAt)),
    stream,
  };
}

function waitForOpen(
  channel: RTCDataChannel,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (channel.readyState === "open") return Promise.resolve();
  if (channel.readyState === "closed")
    return Promise.reject(new Error("Realtime data channel 已关闭。"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener("open", opened);
      channel.removeEventListener("error", failed);
      channel.removeEventListener("close", failed);
      signal.removeEventListener("abort", aborted);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Realtime data channel 无法打开。"));
    };
    const aborted = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Operation was aborted", "AbortError"),
      );
    };
    channel.addEventListener("open", opened, { once: true });
    channel.addEventListener("error", failed, { once: true });
    channel.addEventListener("close", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function rms(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples);
  let total = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    total += centered * centered;
  }
  return Math.min(1, Math.sqrt(total / samples.length) * 3);
}

export class WebRtcVoiceDriver {
  readonly #audioContext: AudioContext;
  readonly #inputAnalyser: AnalyserNode;
  readonly #outputAudio: HTMLAudioElement;
  readonly #outputAnalyser: AnalyserNode;
  readonly #outputAnalysisGain: GainNode;
  readonly #peer = new RTCPeerConnection();
  readonly #channel = this.#peer.createDataChannel("oai-events");
  #animationFrame: number | undefined;
  #closed = false;
  readonly #connectionAbort = new AbortController();
  #connectionClosedReported = false;
  readonly #completedResponses = new Set<string>();
  #currentAudioItemId: string | undefined;
  #currentAudioStartedAt = 0;
  #currentPlayingResponseId: string | undefined;
  #currentResponseId: string | undefined;
  #currentWakeGreetingResponseId: string | undefined;
  #latestGeneration = 0;
  #microphone: MediaStream | undefined;
  #outputEnabled = false;
  #playbackAllowed = true;
  #outputSource: MediaStreamAudioSourceNode | undefined;
  #pendingRefreshRequestId: string | undefined;
  #reportTail: Promise<void> = Promise.resolve();
  readonly #responseGenerations = new Map<string, number>();
  readonly #responseItems = new Map<string, string>();
  readonly #playbackReadyResponses = new Set<string>();
  readonly #reportedAudioStarts = new Set<string>();
  readonly #reportedWakeGreetingStops = new Set<string>();
  readonly #startedResponses = new Set<string>();
  readonly #stoppedResponses = new Set<string>();
  #suppressAudio = false;
  #wakeGreetingAllowed = false;
  readonly #wakeGreetingResponses = new Set<string>();

  constructor(
    private readonly api: VoiceApi,
    private readonly connection: VoiceConnection,
    private readonly onEnvelope: (envelope: VoiceEnvelope) => void,
    audioContext = new AudioContext(),
    private readonly onError: (message: string) => void = () => undefined,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.#audioContext = audioContext;
    this.#inputAnalyser = audioContext.createAnalyser();
    this.#outputAudio = document.createElement("audio");
    this.#outputAnalyser = audioContext.createAnalyser();
    this.#outputAnalysisGain = audioContext.createGain();
    this.#inputAnalyser.fftSize = 256;
    this.#outputAnalyser.fftSize = 256;
    this.#outputAnalysisGain.gain.value = 0;
    this.#outputAnalyser.connect(this.#outputAnalysisGain);
    this.#outputAnalysisGain.connect(this.#audioContext.destination);
    this.#outputAudio.autoplay = true;
    this.#outputAudio.dataset["charamateVoiceOutput"] = "true";
    this.#outputAudio.hidden = true;
    this.#outputAudio.muted = true;
    this.#outputAudio.setAttribute("playsinline", "");
    this.#outputAudio.volume = 1;
    document.body.append(this.#outputAudio);
    this.#channel.addEventListener("message", (event) => {
      void this.#readMessage(event.data);
    });
    this.#channel.addEventListener("close", () => {
      this.#reportConnectionClosed();
    });
    this.#peer.addEventListener("connectionstatechange", () => {
      if (
        !this.#closed &&
        (this.#peer.connectionState === "failed" ||
          this.#peer.connectionState === "disconnected")
      ) {
        this.#reportConnectionClosed(`WebRTC ${this.#peer.connectionState}`);
      }
    });
    this.#peer.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.#outputSource?.disconnect();
      this.#outputAnalyser.disconnect();
      this.#outputAnalyser.connect(this.#outputAnalysisGain);
      this.#outputAudio.srcObject = stream;
      this.#outputSource = this.#audioContext.createMediaStreamSource(stream);
      this.#outputSource.connect(this.#outputAnalyser);
    });
  }

  async connect(preparedMicrophone?: PreparedMicrophone): Promise<void> {
    void this.#audioContext.resume().catch(() => undefined);
    const prepared =
      preparedMicrophone ?? (await prepareMicrophone(this.monotonicNow));
    if (this.#closed) {
      for (const track of prepared.stream.getTracks()) track.stop();
      this.#connectionAbort.signal.throwIfAborted();
    }
    this.#microphone = prepared.stream;
    this.#reportStage("microphone", prepared.durationMs);
    for (const track of this.#microphone.getAudioTracks()) {
      track.enabled = false;
      this.#peer.addTrack(track, this.#microphone);
    }
    this.#audioContext
      .createMediaStreamSource(this.#microphone)
      .connect(this.#inputAnalyser);
    const negotiation = await negotiate(
      this.#peer,
      this.connection.callsUrl,
      this.connection.clientSecret,
      this.monotonicNow,
      this.#connectionAbort.signal,
    );
    this.#reportStage("ice", negotiation.iceDurationMs);
    this.#reportStage("sdp", negotiation.sdpDurationMs);
    const dataChannelStartedAt = this.monotonicNow();
    await waitForOpen(this.#channel, this.#connectionAbort.signal);
    this.#reportStage(
      "data_channel",
      Math.max(0, Math.round(this.monotonicNow() - dataChannelStartedAt)),
    );
    void this.#startOutputPlayback().catch(() => undefined);
    this.#sampleEnvelope();
  }

  setCapture(enabled: boolean): void {
    for (const track of this.#microphone?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  handle(command: VoiceClientCommand): void {
    if (command.type === "preparation.cancel") return;
    if (command.sessionId !== this.connection.sessionId) return;
    if (command.type === "capture.set") {
      this.setCapture(command.enabled);
      return;
    }
    if (command.type === "playback.set") {
      this.#playbackAllowed = command.enabled;
      if (!command.enabled) {
        this.#cancelWakeGreeting();
        this.#setOutputEnabled(false);
      }
      return;
    }
    if (command.type === "session.refresh") {
      this.#pendingRefreshRequestId = command.requestId;
      try {
        this.#send(voiceSessionRefreshEvent(command));
      } catch (error) {
        this.#pendingRefreshRequestId = undefined;
        throw error;
      }
      return;
    }
    if (command.type === "session.close") {
      this.close();
      return;
    }
    if (command.type === "wake.greeting.create") {
      this.#wakeGreetingAllowed = true;
      this.#suppressAudio = false;
      this.#send(voiceWakeGreetingEvent(command));
      return;
    }
    if (command.type === "response.create") {
      this.#cancelWakeGreeting();
      this.#latestGeneration = command.generation;
      this.#suppressAudio = false;
      this.#createResponse(
        command.generation,
        command.instructions,
        command.requestId,
      );
      return;
    }
    if (command.type === "tool.result") {
      this.#latestGeneration = command.generation;
      this.#suppressAudio = false;
      for (const event of voiceToolResultEvents(command)) this.#send(event);
      return;
    }
    if (command.type === "response.cancel") {
      this.#setOutputEnabled(false);
      this.#suppressAudio = true;
      this.#send({
        ...(command.responseId ? { response_id: command.responseId } : {}),
        type: "response.cancel",
      });
      this.#send({ type: "output_audio_buffer.clear" });
      return;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connectionAbort.abort();
    if (this.#animationFrame !== undefined) {
      cancelAnimationFrame(this.#animationFrame);
    }
    this.setCapture(false);
    for (const track of this.#microphone?.getTracks() ?? []) track.stop();
    this.#channel.close();
    this.#peer.close();
    this.#setOutputEnabled(false);
    this.#outputAudio.pause();
    this.#outputAudio.srcObject = null;
    this.#outputAudio.remove();
    this.#outputSource?.disconnect();
    this.#outputSource = undefined;
    this.#completedResponses.clear();
    this.#playbackReadyResponses.clear();
    this.#responseGenerations.clear();
    this.#responseItems.clear();
    this.#reportedAudioStarts.clear();
    this.#reportedWakeGreetingStops.clear();
    this.#startedResponses.clear();
    this.#stoppedResponses.clear();
    this.#wakeGreetingResponses.clear();
    this.#currentWakeGreetingResponseId = undefined;
    this.#wakeGreetingAllowed = false;
    this.#pendingRefreshRequestId = undefined;
    void this.#audioContext.close();
    this.onEnvelope({ input: 0, output: 0 });
  }

  #send(event: Readonly<Record<string, unknown>>): void {
    if (this.#channel.readyState !== "open") {
      throw new Error("Realtime data channel 尚未就绪。");
    }
    this.#channel.send(JSON.stringify(event));
  }

  #createResponse(
    generation: number,
    instructions: string,
    requestId: string,
  ): void {
    this.#send(
      voiceResponseCreateEvent({ generation, instructions, requestId }),
    );
  }

  async #readMessage(data: unknown): Promise<void> {
    const serialized =
      typeof data === "string"
        ? data
        : data instanceof Blob
          ? await data.text()
          : undefined;
    if (!serialized || this.#closed) return;
    let parsed: RealtimeEvent;
    try {
      parsed = JSON.parse(serialized) as RealtimeEvent;
    } catch {
      return;
    }
    this.#handleEvent(parsed);
  }

  #handleEvent(event: RealtimeEvent): void {
    const type = text(event.type);
    if (!type) return;
    if (type === "session.created") {
      const id = text(object(event["session"])?.["id"]);
      if (id) {
        for (const message of this.connection.history) {
          this.#send(voiceHistoryItemEvent(message));
        }
        this.#report({ protocolSessionId: id, type: "session.ready" });
      }
      return;
    }
    if (type === "session.updated") {
      const requestId = this.#pendingRefreshRequestId;
      if (requestId) {
        this.#pendingRefreshRequestId = undefined;
        this.#report({ requestId, type: "session.refreshed" });
      }
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      const inputItemId = itemId(event);
      if (!inputItemId) return;
      const wakeGreetingPlaying = this.#currentPlayingResponseId
        ? this.#isWakeGreeting(this.#currentPlayingResponseId)
        : false;
      const audioEndMs = Math.max(
        0,
        Math.round(
          (this.#outputAudio.currentTime - this.#currentAudioStartedAt) * 1_000,
        ),
      );
      if (wakeGreetingPlaying || this.#wakeGreetingAllowed) {
        this.#cancelWakeGreeting();
      }
      this.#setOutputEnabled(false);
      this.#suppressAudio = true;
      this.#report({
        ...(!wakeGreetingPlaying && this.#currentAudioItemId
          ? {
              assistantItemId: this.#currentAudioItemId,
              audioEndMs,
            }
          : {}),
        itemId: inputItemId,
        type: "speech.started",
      });
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const inputItemId = itemId(event);
      if (inputItemId) {
        this.#report({ itemId: inputItemId, type: "speech.stopped" });
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const delta = text(event["delta"]);
      const id = itemId(event);
      if (delta !== undefined && id) {
        this.#report({ delta, itemId: id, type: "transcript.user.delta" });
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = text(event["transcript"]);
      const id = itemId(event);
      if (transcript?.trim() && id) {
        this.#report({
          itemId: id,
          transcript: transcript.trim(),
          type: "transcript.user.completed",
        });
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      const error = object(event["error"]);
      const id = itemId(event);
      if (id) {
        this.#report({
          code: text(error?.["code"]) ?? "VOICE.TRANSCRIPTION_FAILED",
          itemId: id,
          message: text(error?.["message"]) ?? "语音转写失败。",
          type: "transcript.user.failed",
        });
      }
      return;
    }
    if (type === "response.created") {
      const id = responseId(event);
      if (id && wakeGreetingResponse(event)) {
        this.#wakeGreetingResponses.add(id);
        this.#currentWakeGreetingResponseId = id;
        if (!this.#wakeGreetingAllowed) this.#cancelWakeGreeting();
        return;
      }
      const generation = responseGeneration(event);
      if (id && generation) {
        this.#responseGenerations.set(id, generation);
        if (generation !== this.#latestGeneration) {
          this.#send({ response_id: id, type: "response.cancel" });
          this.#responseGenerations.delete(id);
          return;
        }
        this.#currentResponseId = id;
        const requestId = object(object(event["response"])?.["metadata"])?.[
          "charamate_request_id"
        ];
        this.#report({
          generation,
          responseId: id,
          ...(typeof requestId === "string" && requestId.trim()
            ? { requestId }
            : {}),
          type: "response.started",
        });
      }
      return;
    }
    if (type === "response.output_item.added") {
      const response =
        responseId(event) ??
        this.#currentResponseId ??
        this.#currentWakeGreetingResponseId;
      if (
        !response ||
        (!this.#isWakeGreeting(response) &&
          this.#generationFor(response) === undefined)
      ) {
        return;
      }
      const item = object(event["item"]);
      const id = text(item?.["id"]);
      if (id && item?.["type"] === "message") {
        this.#responseItems.set(response, id);
        if (this.#currentPlayingResponseId === response) {
          this.#currentAudioItemId = id;
        }
        this.#reportAudioStarted(response);
      }
      return;
    }
    if (type === "response.output_audio_transcript.delta") {
      const delta = text(event["delta"]);
      const response = responseId(event) ?? this.#currentResponseId;
      const generation = response ? this.#generationFor(response) : undefined;
      const item = response
        ? (itemId(event) ?? this.#responseItems.get(response))
        : undefined;
      const index = outputIndex(event);
      if (
        delta !== undefined &&
        response &&
        generation &&
        item &&
        index !== undefined
      ) {
        this.#report({
          delta,
          generation,
          itemId: item,
          outputIndex: index,
          responseId: response,
          type: "transcript.assistant.delta",
        });
      }
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      const transcript = text(event["transcript"]) ?? "";
      const response = responseId(event) ?? this.#currentResponseId;
      const generation = response ? this.#generationFor(response) : undefined;
      const item = response
        ? (itemId(event) ?? this.#responseItems.get(response))
        : undefined;
      const index = outputIndex(event);
      if (response && generation && item && index !== undefined) {
        this.#report({
          generation,
          itemId: item,
          outputIndex: index,
          responseId: response,
          transcript,
          type: "transcript.assistant.done",
        });
      }
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const response = responseId(event) ?? this.#currentResponseId;
      const generation = response ? this.#generationFor(response) : undefined;
      const id = itemId(event);
      const callId = text(event["call_id"]);
      const name = text(event["name"]);
      const argumentsValue = text(event["arguments"]);
      if (
        response &&
        generation &&
        id &&
        callId &&
        name &&
        argumentsValue !== undefined
      ) {
        this.#report({
          arguments: argumentsValue,
          callId,
          generation,
          itemId: id,
          name,
          responseId: response,
          type: "tool.call",
        });
      }
      return;
    }
    if (type === "output_audio_buffer.started") {
      const response = responseId(event);
      const generation = response ? this.#generationFor(response) : undefined;
      const wakeGreeting = response ? this.#isWakeGreeting(response) : false;
      if (
        !this.#suppressAudio &&
        response &&
        (generation !== undefined ||
          (wakeGreeting && this.#wakeGreetingAllowed))
      ) {
        const item = itemId(event) ?? this.#responseItems.get(response);
        if (item) this.#responseItems.set(response, item);
        this.#currentPlayingResponseId = response;
        this.#currentAudioItemId = item;
        this.#startedResponses.add(response);
        void this.#resumeOutput(response);
      }
      return;
    }
    if (type === "output_audio_buffer.stopped") {
      const response = responseId(event);
      const generation = response ? this.#generationFor(response) : undefined;
      const wakeGreeting = response ? this.#isWakeGreeting(response) : false;
      if (!response || (generation === undefined && !wakeGreeting)) return;
      const isCurrent = this.#currentPlayingResponseId === response;
      const item = this.#responseItems.get(response);
      this.#stoppedResponses.add(response);
      if (isCurrent) {
        if (wakeGreeting) this.#reportWakeGreetingStopped(response);
        else if (generation !== undefined) {
          this.#report({
            ...(item ? { itemId: item } : {}),
            generation,
            responseId: response,
            type: "audio.stopped",
          });
        }
        this.#setOutputEnabled(false);
        this.#currentPlayingResponseId = undefined;
        this.#currentAudioItemId = undefined;
      }
      this.#releaseCompletedResponse(response);
      return;
    }
    if (type === "output_audio_buffer.cleared") {
      const response = responseId(event);
      if (
        !response ||
        (!this.#isWakeGreeting(response) &&
          this.#generationFor(response) === undefined)
      ) {
        return;
      }
      this.#stoppedResponses.add(response);
      if (this.#currentPlayingResponseId === response) {
        if (this.#isWakeGreeting(response)) {
          this.#reportWakeGreetingStopped(response);
        }
        this.#setOutputEnabled(false);
        this.#currentPlayingResponseId = undefined;
        this.#currentAudioItemId = undefined;
      }
      this.#releaseCompletedResponse(response);
      return;
    }
    if (type === "response.done") {
      const response = object(event["response"]);
      const id = text(response?.["id"]);
      const wakeGreeting = id ? this.#isWakeGreeting(id) : false;
      const generation = id ? this.#generationFor(id) : undefined;
      const status = text(response?.["status"]);
      if (
        id &&
        (generation !== undefined || wakeGreeting) &&
        (status === "completed" ||
          status === "cancelled" ||
          status === "failed" ||
          status === "incomplete")
      ) {
        const details = object(response?.["status_details"]);
        const statusReason = details
          ? (text(details["reason"]) ??
            text(object(details["error"])?.["message"]))
          : undefined;
        const responseUsage = usage(event);
        if (wakeGreeting) {
          this.#report({
            hasAudio: this.#startedResponses.has(id),
            responseId: id,
            status,
            ...(statusReason ? { statusReason } : {}),
            type: "wake.greeting.done",
            ...(responseUsage ? { usage: responseUsage } : {}),
          });
        } else if (generation !== undefined) {
          this.#report({
            generation,
            hasAudio: this.#startedResponses.has(id),
            responseId: id,
            status,
            ...(statusReason ? { statusReason } : {}),
            type: "response.done",
            ...(responseUsage ? { usage: responseUsage } : {}),
          });
        }
        if (status === "completed") {
          if (this.#startedResponses.has(id)) {
            this.#completedResponses.add(id);
            this.#releaseCompletedResponse(id);
          } else {
            this.#releaseResponse(id);
          }
        } else {
          this.#releaseResponse(id);
        }
      }
      return;
    }
    if (type === "conversation.item.truncated") {
      const id = itemId(event);
      const audioEndMs = event["audio_end_ms"];
      if (id && typeof audioEndMs === "number") {
        this.#report({ audioEndMs, itemId: id, type: "item.truncated" });
      }
      return;
    }
    if (type === "error") {
      const error = object(event["error"]);
      if (this.#consumeInterruptionError(error)) return;
      const code = text(error?.["code"]);
      this.#report({
        code: code ?? "VOICE.REALTIME_ERROR",
        message: text(error?.["message"]) ?? "Realtime 返回错误。",
        type: "server.error",
      });
    }
  }

  #consumeInterruptionError(
    error: Readonly<Record<string, unknown>> | undefined,
  ): boolean {
    return text(error?.["code"]) === "response_cancel_not_active";
  }

  #report(event: VoiceDriverEvent): void {
    const occurredAt = new Date().toISOString();
    this.#reportTail = this.#reportTail
      .then(async () => {
        const response = await this.api.report({
          event,
          occurredAt,
          sessionId: this.connection.sessionId,
        });
        if (!response.ok) throw new Error(response.error.message);
      })
      .catch((error: unknown) => {
        this.onError(
          error instanceof Error ? error.message : "语音事件处理失败。",
        );
      });
  }

  #reportConnectionClosed(reason?: string): void {
    if (this.#closed || this.#connectionClosedReported) return;
    this.#connectionClosedReported = true;
    this.#report({ ...(reason ? { reason } : {}), type: "connection.closed" });
  }

  #generationFor(responseId: string): number | undefined {
    const generation = this.#responseGenerations.get(responseId);
    return generation === this.#latestGeneration ? generation : undefined;
  }

  #isWakeGreeting(responseId: string): boolean {
    return this.#wakeGreetingResponses.has(responseId);
  }

  #releaseCompletedResponse(responseId: string): void {
    if (
      !this.#completedResponses.has(responseId) ||
      !this.#stoppedResponses.has(responseId)
    ) {
      return;
    }
    this.#releaseResponse(responseId);
  }

  #releaseResponse(responseId: string): void {
    if (
      this.#currentPlayingResponseId === responseId &&
      this.#isWakeGreeting(responseId)
    ) {
      this.#reportWakeGreetingStopped(responseId);
      this.#setOutputEnabled(false);
      this.#currentPlayingResponseId = undefined;
      this.#currentAudioItemId = undefined;
    }
    this.#completedResponses.delete(responseId);
    this.#responseGenerations.delete(responseId);
    this.#responseItems.delete(responseId);
    this.#playbackReadyResponses.delete(responseId);
    this.#reportedAudioStarts.delete(responseId);
    this.#startedResponses.delete(responseId);
    this.#stoppedResponses.delete(responseId);
    this.#wakeGreetingResponses.delete(responseId);
    this.#reportedWakeGreetingStops.delete(responseId);
    if (this.#currentResponseId === responseId) {
      this.#currentResponseId = undefined;
    }
    if (this.#currentWakeGreetingResponseId === responseId) {
      this.#currentWakeGreetingResponseId = undefined;
      this.#wakeGreetingAllowed = false;
    }
  }

  #reportAudioStarted(responseId: string): void {
    if (
      this.#reportedAudioStarts.has(responseId) ||
      !this.#startedResponses.has(responseId) ||
      !this.#playbackReadyResponses.has(responseId) ||
      !this.#outputEnabled
    ) {
      return;
    }
    const item = this.#responseItems.get(responseId);
    if (!item) return;
    this.#reportedAudioStarts.add(responseId);
    if (this.#isWakeGreeting(responseId)) {
      this.#report({
        responseId,
        type: "wake.greeting.audio.started",
      });
      return;
    }
    const generation = this.#generationFor(responseId);
    if (!generation) return;
    this.#report({
      generation,
      itemId: item,
      responseId,
      type: "audio.started",
    });
  }

  #reportWakeGreetingStopped(responseId: string): void {
    if (this.#reportedWakeGreetingStops.has(responseId)) return;
    this.#reportedWakeGreetingStops.add(responseId);
    this.#report({
      responseId,
      type: "wake.greeting.audio.stopped",
    });
  }

  #cancelWakeGreeting(): void {
    this.#wakeGreetingAllowed = false;
    const responseId = this.#currentWakeGreetingResponseId;
    if (!responseId || !this.#isWakeGreeting(responseId)) return;
    this.#suppressAudio = true;
    this.#send({ response_id: responseId, type: "response.cancel" });
    this.#send({ type: "output_audio_buffer.clear" });
    this.#setOutputEnabled(false);
    this.#reportWakeGreetingStopped(responseId);
    this.#currentPlayingResponseId = undefined;
    this.#currentAudioItemId = undefined;
  }

  async #resumeOutput(responseId: string): Promise<void> {
    try {
      void this.#audioContext.resume().catch(() => undefined);
      if (
        this.#closed ||
        !this.#playbackAllowed ||
        this.#suppressAudio ||
        this.#stoppedResponses.has(responseId)
      ) {
        return;
      }
      this.#setOutputEnabled(true);
      await this.#startOutputPlayback();
      if (
        this.#closed ||
        !this.#playbackAllowed ||
        this.#suppressAudio ||
        this.#stoppedResponses.has(responseId)
      ) {
        return;
      }
      this.#currentAudioStartedAt = this.#outputAudio.currentTime;
      this.#playbackReadyResponses.add(responseId);
      this.#reportAudioStarted(responseId);
    } catch (error) {
      if (this.#closed) return;
      this.#setOutputEnabled(false);
      this.#suppressAudio = true;
      this.#report({
        code: "VOICE.PLAYBACK_FAILED",
        message:
          error instanceof Error
            ? `无法播放语音：${error.message}`
            : "无法播放语音。",
        type: "server.error",
      });
    }
  }

  async #startOutputPlayback(): Promise<void> {
    if (!this.#outputAudio.srcObject) {
      throw new Error("WebRTC 没有提供远端音轨。");
    }
    await this.#outputAudio.play();
  }

  #setOutputEnabled(enabled: boolean): void {
    this.#outputEnabled = enabled && this.#playbackAllowed;
    this.#outputAudio.muted = !this.#outputEnabled;
  }

  #reportStage(
    stage: "microphone" | "ice" | "sdp" | "data_channel",
    durationMs: number,
  ): void {
    this.#report({ durationMs, stage, type: "connection.stage" });
  }

  #sampleEnvelope(): void {
    const inputSamples = new Uint8Array(this.#inputAnalyser.fftSize);
    const outputSamples = new Uint8Array(this.#outputAnalyser.fftSize);
    const sample = () => {
      if (this.#closed) return;
      this.onEnvelope({
        input: rms(this.#inputAnalyser, inputSamples),
        output: !this.#outputEnabled
          ? 0
          : rms(this.#outputAnalyser, outputSamples),
      });
      this.#animationFrame = requestAnimationFrame(sample);
    };
    sample();
  }
}

export async function previewVoice(
  connection: VoicePreviewConnection,
  phrase: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const peer = new RTCPeerConnection();
  peer.addTransceiver("audio", { direction: "recvonly" });
  const channel = peer.createDataChannel("oai-events");
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.dataset["charamateVoicePreview"] = "true";
  audio.hidden = true;
  audio.setAttribute("playsinline", "");
  document.body.append(audio);
  peer.addEventListener("track", (event) => {
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void audio.play().catch((error: unknown) => {
      rejectDone(
        new Error(
          error instanceof Error
            ? `无法播放试听：${error.message}`
            : "无法播放试听。",
        ),
      );
    });
  });
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Observe early failure while SDP/ICE still owns the current await.
  void done.catch(() => undefined);
  const rejectClosed = () => rejectDone(new Error("试听连接已关闭。"));
  const aborted = () => {
    rejectDone(new DOMException("试听已结束。", "AbortError"));
    channel.close();
    peer.close();
  };
  signal.addEventListener("abort", aborted, { once: true });
  channel.addEventListener("close", rejectClosed);
  channel.addEventListener("error", rejectClosed);
  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let value: RealtimeEvent;
    try {
      value = JSON.parse(event.data) as RealtimeEvent;
    } catch {
      return;
    }
    if (value.type === "session.created") {
      for (const event of voicePreviewEvents(phrase))
        channel.send(JSON.stringify(event));
    } else if (value.type === "output_audio_buffer.stopped") {
      resolveDone();
    } else if (value.type === "error") {
      rejectDone(
        new Error(text(object(value["error"])?.["message"]) ?? "试听失败。"),
      );
    }
  });
  try {
    await negotiate(
      peer,
      connection.callsUrl,
      connection.clientSecret,
      () => performance.now(),
      signal,
    );
    await waitForOpen(channel, signal);
    await done;
  } finally {
    signal.removeEventListener("abort", aborted);
    channel.removeEventListener("close", rejectClosed);
    channel.removeEventListener("error", rejectClosed);
    channel.close();
    peer.close();
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
}
