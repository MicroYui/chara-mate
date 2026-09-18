import { VOICE_PREVIEW_PHRASE } from "../../../shared/contracts/voice";
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

export type VoiceMicrophonePreparer = () => Promise<PreparedMicrophone>;

function beginMicrophonePreparation(
  prepare: VoiceMicrophonePreparer,
): Promise<PreparedMicrophoneResult> {
  return prepare().then(
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

interface VoicePreparation {
  readonly abort: AbortController;
  readonly kind: "start" | "resume" | "preview";
  readonly requestId?: string;
  sessionId?: string;
  task: Promise<void>;
}

export class VoiceStore {
  readonly #listeners = new Set<() => void>();
  readonly #envelopeListeners = new Set<() => void>();
  #driver: WebRtcVoiceDriver | undefined;
  #driverSessionId: string | undefined;
  #envelope: VoiceEnvelope = SILENT_ENVELOPE;
  #playbackContext: AudioContext | undefined;
  #state: VoiceUiState = {
    error: null,
    snapshot: null,
    starting: false,
  };
  #preparation: VoicePreparation | undefined;
  #ending: Promise<boolean> | undefined;
  #listenGeneration = 0;
  // getUserMedia has no abort API. Retain its real completion and stop any
  // late tracks; cancelling the UI does not claim that an OS prompt settled.
  readonly #microphones = new Set<Promise<PreparedMicrophoneResult>>();
  #unsubscribeChanged: (() => void) | undefined;
  #unsubscribeCommand: (() => void) | undefined;

  constructor(
    private readonly api: VoiceApi,
    private readonly microphonePreparer: VoiceMicrophonePreparer = () =>
      prepareMicrophone(),
  ) {}

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
    const generation = ++this.#listenGeneration;
    this.#unsubscribeChanged = this.api.subscribeChanged((snapshot) => {
      this.#setState({ ...this.#state, snapshot });
      if (!snapshot || snapshot.phase === "interrupted") {
        this.#driver?.close();
        this.#driver = undefined;
        this.#driverSessionId = undefined;
        this.#setEnvelope(SILENT_ENVELOPE);
      }
    });
    this.#unsubscribeCommand = this.api.subscribeCommand((command) => {
      try {
        if (command.type === "preparation.cancel") {
          if (this.#preparation?.requestId === command.requestId) {
            this.#preparation.abort.abort();
            this.#driver?.close();
          }
          return;
        }
        // A cold resume closes the replaced Session before the new connection
        // reply arrives. Only its submission ID can cancel preparation.
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
      if (generation === this.#listenGeneration && response.ok)
        this.#setState({ ...this.#state, snapshot: response.value });
    });
    return () => {
      if (generation !== this.#listenGeneration) return;
      this.#listenGeneration++;
      void this.end().catch(() => undefined);
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
    return this.#beginStart((requestId) =>
      this.api.start({ requestId, request }),
    );
  }

  startQuick(target?: { readonly chatId: string }): Promise<void> {
    this.preparePlayback();
    return this.#beginStart((requestId) =>
      this.api.quickStart({
        requestId,
        request: target
          ? {
              chatId: target.chatId,
              execution: { mode: "chat" },
              requestedAt: new Date().toISOString(),
            }
          : { requestedAt: new Date().toISOString() },
      }),
    );
  }

  startWake(signal?: AbortSignal): Promise<void> {
    this.preparePlayback();
    return this.#beginStart(
      (requestId) =>
        this.api.quickStart({
          requestId,
          request: {
            origin: "voice_wake",
            requestedAt: new Date().toISOString(),
          },
        }),
      signal,
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

  #prepare(
    kind: VoicePreparation["kind"],
    action: (owner: VoicePreparation) => Promise<void>,
    options: {
      requestId?: string;
      sessionId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (this.#preparation) return this.#preparation.task;
    const owner: VoicePreparation = {
      abort: new AbortController(),
      kind,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      task: Promise.resolve(),
    };
    this.#preparation = owner;
    const cancelled = () => {
      if (this.#preparation === owner) void this.end().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancelled, { once: true });
    if (options.signal?.aborted) {
      owner.abort.abort(options.signal.reason);
      this.#discardPreparedPlayback();
    }
    owner.task = Promise.resolve()
      .then(async () => {
        options.signal?.throwIfAborted();
        owner.abort.signal.throwIfAborted();
        await action(owner);
      })
      .catch((error: unknown) => {
        if (
          kind === "preview" ||
          (!owner.abort.signal.aborted && !options.signal?.aborted)
        )
          throw error;
      })
      .finally(() => {
        options.signal?.removeEventListener("abort", cancelled);
        if (this.#preparation === owner) {
          this.#preparation = undefined;
          if (kind !== "preview")
            this.#setState({ ...this.#state, starting: false });
        }
      });
    return owner.task;
  }

  #beginStart(
    connect: (requestId: string) => Promise<VoiceStartResponse>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#preparation) return this.#preparation.task;
    const reconnecting = this.#state.snapshot?.phase === "interrupted";
    if (this.#ending || this.#driver || (this.#state.snapshot && !reconnecting))
      return Promise.resolve();
    const requestId = crypto.randomUUID();
    const task = this.#prepare(
      "start",
      async (owner) => {
        const microphone = this.#beginMicrophone(owner);
        try {
          const response = await connect(requestId);
          if (response.ok) owner.sessionId = response.value.sessionId;
          owner.abort.signal.throwIfAborted();
          if (!response.ok) {
            this.#setState({ ...this.#state, error: response.error });
            owner.abort.abort();
            this.#discardPreparedPlayback();
            return;
          }
          await this.#connectDriver(response.value, microphone, owner);
        } catch (error) {
          if (!owner.abort.signal.aborted) {
            this.#setState({
              ...this.#state,
              error: {
                message: connectionErrorMessage(error),
                retryable: true,
              },
            });
          }
          owner.abort.abort();
          this.#discardPreparedPlayback();
        }
      },
      { requestId, ...(signal ? { signal } : {}) },
    );
    this.#setState({ ...this.#state, error: null, starting: true });
    return task;
  }

  #beginMicrophone(owner: VoicePreparation): Promise<PreparedMicrophoneResult> {
    const task = beginMicrophonePreparation(this.microphonePreparer);
    this.#microphones.add(task);
    owner.abort.signal.addEventListener(
      "abort",
      () => {
        void task.then(stopPreparedMicrophone);
      },
      { once: true },
    );
    void task.then(() => {
      this.#microphones.delete(task);
    });
    return task;
  }

  #awaitMicrophone(
    task: Promise<PreparedMicrophoneResult>,
    signal: AbortSignal,
  ): Promise<PreparedMicrophoneResult> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const aborted = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Operation was aborted", "AbortError"),
        );
      };
      signal.addEventListener("abort", aborted, { once: true });
      void task.then((result) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) return;
        resolve(result);
      });
    });
  }

  async #connectDriver(
    connection: VoiceConnection,
    microphone: Promise<PreparedMicrophoneResult>,
    owner: VoicePreparation,
  ): Promise<void> {
    let prepared: PreparedMicrophoneResult | undefined;
    let driver: WebRtcVoiceDriver | undefined;
    try {
      prepared = await this.#awaitMicrophone(microphone, owner.abort.signal);
      owner.abort.signal.throwIfAborted();
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
      this.#driverSessionId = connection.sessionId;
      await driver.connect(prepared.value);
      owner.abort.signal.throwIfAborted();
      this.#setState({ ...this.#state, error: null, starting: false });
    } catch (error) {
      driver?.close();
      if (!driver && prepared) stopPreparedMicrophone(prepared);
      if (this.#driver === driver) {
        this.#driver = undefined;
        this.#driverSessionId = undefined;
      }
      this.#discardPreparedPlayback();
      if (owner.abort.signal.aborted) return;
      const message = connectionErrorMessage(error);
      try {
        await this.api.report({
          event: { reason: message, type: "connection.closed" },
          occurredAt: new Date().toISOString(),
          sessionId: connection.sessionId,
        });
      } catch {
        // Main may already be unavailable; local media is still closed.
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

  end(): Promise<boolean> {
    if (this.#ending) return this.#ending;
    const owner = this.#preparation;
    const sessionId =
      owner?.sessionId ??
      this.#driverSessionId ??
      this.#state.snapshot?.sessionId;
    owner?.abort.abort();
    this.#driver?.close();
    this.#driver = undefined;
    this.#driverSessionId = undefined;
    this.#discardPreparedPlayback();
    const stop = owner?.requestId
      ? this.api.cancelStart({ requestId: owner.requestId })
      : sessionId
        ? this.api.end({ sessionId })
        : Promise.resolve({ ok: true as const, value: null });
    const task = (async () => {
      const response = await stop;
      // Main has joined preparation before this resolves. The local Driver's
      // real negotiation settles too; an unanswered OS mic prompt retains only
      // the explicit late-track cleanup above.
      await owner?.task.catch(() => undefined);
      if (!response.ok) {
        this.#setState({ ...this.#state, error: response.error });
        return false;
      }
      if (
        !this.#state.snapshot ||
        this.#state.snapshot.sessionId === sessionId
      ) {
        this.#setState({ error: null, snapshot: null, starting: false });
      }
      return true;
    })();
    this.#ending = task.finally(() => {
      if (this.#ending === ending) this.#ending = undefined;
    });
    const ending = this.#ending;
    return ending;
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
    await this.#setPaused(paused);
  }

  async resumeFromWake(signal?: AbortSignal): Promise<void> {
    await this.#setPaused(false, "voice_wake", signal);
  }

  async #setPaused(
    paused: boolean,
    origin?: "voice_wake",
    signal?: AbortSignal,
  ): Promise<void> {
    const sessionId = this.#state.snapshot?.sessionId;
    if (!sessionId) return;
    if (paused) {
      const response = await this.api.setPaused({
        request: {
          paused: true,
          requestedAt: new Date().toISOString(),
          sessionId,
        },
      });
      if (!response.ok)
        this.#setState({ ...this.#state, error: response.error });
      return;
    }
    if (this.#ending) return;
    const requestId = crypto.randomUUID();
    await this.#prepare(
      "resume",
      async (owner) => {
        const response = await this.api.setPaused({
          requestId,
          request: {
            ...(origin ? { origin } : {}),
            paused: false,
            requestedAt: new Date().toISOString(),
            sessionId,
          },
        });
        if (response.ok && response.value.connection)
          owner.sessionId = response.value.connection.sessionId;
        owner.abort.signal.throwIfAborted();
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
          this.#beginMicrophone(owner),
          owner,
        );
      },
      { requestId, sessionId, ...(signal ? { signal } : {}) },
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

  preview(request: VoicePreviewRequest): Promise<void> {
    if (
      this.#preparation ||
      this.#ending ||
      this.#state.snapshot ||
      this.#driver
    ) {
      return Promise.reject(new Error("请先结束当前语音，再试听声音。"));
    }
    const requestId = crypto.randomUUID();
    return this.#prepare(
      "preview",
      async (owner) => {
        try {
          const response = await this.api.preview({ requestId, request });
          owner.abort.signal.throwIfAborted();
          if (!response.ok) throw new Error(response.error.message);
          await previewVoice(
            response.value,
            VOICE_PREVIEW_PHRASE,
            owner.abort.signal,
          );
        } finally {
          await this.api.cancelStart({ requestId });
        }
      },
      { requestId },
    );
  }

  cancelPreview(): Promise<boolean> {
    return this.#preparation?.kind === "preview"
      ? this.end()
      : Promise.resolve(true);
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
