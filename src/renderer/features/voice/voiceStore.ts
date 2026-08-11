import type {
  VoiceApi,
  VoiceConnection,
  VoicePreviewRequest,
  VoiceSessionSnapshot,
  VoiceStartRequest,
  VoiceStartResponse,
} from "../../../shared/contracts/voice";
import {
  previewVoice,
  prepareMicrophone,
  WebRtcVoiceDriver,
  type PreparedMicrophone,
  type VoiceEnvelope,
} from "./WebRtcVoiceDriver";

export interface VoiceUiState {
  readonly error: {
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly snapshot: VoiceSessionSnapshot | null;
  readonly starting: boolean;
}

const SILENT_ENVELOPE = { input: 0, output: 0 } as const;

type PreparedMicrophoneResult =
  | { readonly ok: true; readonly value: PreparedMicrophone }
  | { readonly error: unknown; readonly ok: false };

function beginMicrophonePreparation(): Promise<PreparedMicrophoneResult> {
  return prepareMicrophone().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ error, ok: false }),
  );
}

function stopPreparedMicrophone(result: PreparedMicrophoneResult): void {
  if (!result.ok) return;
  for (const track of result.value.stream.getTracks()) track.stop();
}

function connectionErrorMessage(error: unknown): string {
  return error instanceof DOMException && error.name === "NotAllowedError"
    ? "请允许 CharaMate 使用麦克风。"
    : error instanceof Error
      ? error.message
      : "语音连接失败。";
}

export class VoiceStore {
  readonly #listeners = new Set<() => void>();
  readonly #envelopeListeners = new Set<() => void>();
  #driver: WebRtcVoiceDriver | undefined;
  #envelope: VoiceEnvelope = SILENT_ENVELOPE;
  #playbackContext: AudioContext | undefined;
  #state: VoiceUiState = {
    error: null,
    snapshot: null,
    starting: false,
  };
  #startTask: Promise<void> | undefined;
  #unsubscribeChanged: (() => void) | undefined;
  #unsubscribeCommand: (() => void) | undefined;

  constructor(private readonly api: VoiceApi) {}

  readonly getState = (): VoiceUiState => this.#state;
  readonly getEnvelope = (): VoiceEnvelope => this.#envelope;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly subscribeEnvelope = (listener: () => void): (() => void) => {
    this.#envelopeListeners.add(listener);
    return () => this.#envelopeListeners.delete(listener);
  };

  startListening(): () => void {
    this.#unsubscribeChanged = this.api.subscribeChanged((snapshot) => {
      this.#setState({ ...this.#state, snapshot });
      if (!snapshot || snapshot.phase === "interrupted") {
        this.#driver?.close();
        this.#driver = undefined;
        this.#setEnvelope(SILENT_ENVELOPE);
      }
    });
    this.#unsubscribeCommand = this.api.subscribeCommand((command) => {
      try {
        this.#driver?.handle(command);
      } catch (error) {
        this.#setState({
          ...this.#state,
          error: {
            message: error instanceof Error ? error.message : "语音命令失败。",
            retryable: false,
          },
        });
      }
    });
    void this.api.getActive().then((response) => {
      if (response.ok)
        this.#setState({ ...this.#state, snapshot: response.value });
    });
    return () => {
      this.#unsubscribeChanged?.();
      this.#unsubscribeChanged = undefined;
      this.#unsubscribeCommand?.();
      this.#unsubscribeCommand = undefined;
      this.#driver?.close();
      this.#driver = undefined;
      this.#discardPreparedPlayback();
    };
  }

  start(request: VoiceStartRequest): Promise<void> {
    this.preparePlayback();
    return this.#beginStart(() => this.api.start(request));
  }

  startQuick(): Promise<void> {
    this.preparePlayback();
    return this.#beginStart(() =>
      this.api.quickStart({ requestedAt: new Date().toISOString() }),
    );
  }

  preparePlayback(): void {
    if (
      this.#driver ||
      this.#playbackContext ||
      this.#state.snapshot ||
      this.#state.starting
    ) {
      return;
    }
    const context = new AudioContext();
    this.#playbackContext = context;
    void context.resume().catch(() => undefined);
  }

  #beginStart(connect: () => Promise<VoiceStartResponse>): Promise<void> {
    if (this.#startTask) return this.#startTask;
    const task = this.#startConnection(connect).finally(() => {
      if (this.#startTask === task) this.#startTask = undefined;
    });
    this.#startTask = task;
    return task;
  }

  async #startConnection(
    connect: () => Promise<VoiceStartResponse>,
  ): Promise<void> {
    const reconnecting = this.#state.snapshot?.phase === "interrupted";
    if (
      this.#state.starting ||
      this.#driver ||
      (this.#state.snapshot && !reconnecting)
    ) {
      return;
    }
    this.#setState({
      error: null,
      snapshot: this.#state.snapshot,
      starting: true,
    });
    const microphone = beginMicrophonePreparation();
    let response: VoiceStartResponse;
    try {
      response = await connect();
    } catch (error) {
      void microphone.then(stopPreparedMicrophone);
      this.#discardPreparedPlayback();
      this.#setState({
        error: {
          message: connectionErrorMessage(error),
          retryable: true,
        },
        snapshot: this.#state.snapshot,
        starting: false,
      });
      return;
    }
    if (!response.ok) {
      void microphone.then(stopPreparedMicrophone);
      this.#discardPreparedPlayback();
      this.#setState({
        error: response.error,
        snapshot: this.#state.snapshot,
        starting: false,
      });
      return;
    }
    await this.#connectDriver(response.value, microphone);
  }

  async #connectDriver(
    connection: VoiceConnection,
    microphone: Promise<PreparedMicrophoneResult>,
  ): Promise<void> {
    let prepared: PreparedMicrophoneResult | undefined;
    let driver: WebRtcVoiceDriver | undefined;
    try {
      prepared = await microphone;
      if (!prepared.ok) throw prepared.error;
      const playbackContext = this.#playbackContext ?? new AudioContext();
      this.#playbackContext = undefined;
      driver = new WebRtcVoiceDriver(
        this.api,
        connection,
        (envelope) => this.#setEnvelope(envelope),
        playbackContext,
        (message) =>
          this.#setState({
            ...this.#state,
            error: { message, retryable: true },
          }),
      );
      this.#driver = driver;
      await driver.connect(prepared.value);
      this.#setState({ ...this.#state, error: null, starting: false });
      return;
    } catch (error) {
      if (driver) driver.close();
      else if (prepared) stopPreparedMicrophone(prepared);
      if (this.#driver === driver) this.#driver = undefined;
      this.#discardPreparedPlayback();
      const message = connectionErrorMessage(error);
      try {
        await this.api.report({
          event: { reason: message, type: "connection.closed" },
          occurredAt: new Date().toISOString(),
          sessionId: connection.sessionId,
        });
      } catch {
        // The local error remains actionable if Main is already unavailable.
      }
      this.#setState({
        ...this.#state,
        error: {
          message,
          retryable: !(
            error instanceof DOMException && error.name === "NotAllowedError"
          ),
        },
        starting: false,
      });
    }
  }

  async end(): Promise<boolean> {
    await this.#startTask?.catch(() => undefined);
    const sessionId = this.#state.snapshot?.sessionId;
    if (!sessionId) return true;
    const response = await this.api.end({ sessionId });
    if (!response.ok) {
      this.#setState({ ...this.#state, error: response.error });
      return false;
    }
    this.#driver?.close();
    this.#driver = undefined;
    this.#setState({ error: null, snapshot: null, starting: false });
    return true;
  }

  async setMuted(muted: boolean): Promise<void> {
    const sessionId = this.#state.snapshot?.sessionId;
    if (!sessionId) return;
    const response = await this.api.setMuted({ muted, sessionId });
    if (!response.ok) {
      this.#setState({ ...this.#state, error: response.error });
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    const sessionId = this.#state.snapshot?.sessionId;
    if (!sessionId) return;
    const response = await this.api.setPaused({
      paused,
      requestedAt: new Date().toISOString(),
      sessionId,
    });
    if (!response.ok) {
      this.#setState({ ...this.#state, error: response.error });
      return;
    }
    this.#setState({
      ...this.#state,
      error: null,
      snapshot: response.value.snapshot,
    });
    if (!response.value.connection) return;
    this.#driver?.close();
    this.#driver = undefined;
    this.#setState({ ...this.#state, starting: true });
    await this.#connectDriver(
      response.value.connection,
      beginMicrophonePreparation(),
    );
  }

  setPushToTalk(enabled: boolean): void {
    const snapshot = this.#state.snapshot;
    if (
      !snapshot ||
      snapshot.inputMode !== "push_to_talk" ||
      snapshot.phase === "paused" ||
      snapshot.phase === "resuming" ||
      snapshot.phase === "connecting" ||
      snapshot.phase === "interrupted" ||
      snapshot.phase === "failed"
    ) {
      return;
    }
    this.#driver?.setCapture(enabled && !snapshot.muted);
  }

  async preview(request: VoicePreviewRequest): Promise<void> {
    const response = await this.api.preview(request);
    if (!response.ok) throw new Error(response.error.message);
    await previewVoice(
      response.value,
      "你好，我是 CharaMate，很高兴陪你聊聊。",
    );
  }

  clearError(): void {
    if (this.#state.error) this.#setState({ ...this.#state, error: null });
  }

  #setState(state: VoiceUiState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #setEnvelope(envelope: VoiceEnvelope): void {
    this.#envelope = envelope;
    for (const listener of this.#envelopeListeners) listener();
  }

  #discardPreparedPlayback(): void {
    const context = this.#playbackContext;
    this.#playbackContext = undefined;
    if (context) void context.close().catch(() => undefined);
  }
}
