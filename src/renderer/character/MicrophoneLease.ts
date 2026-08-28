import WakeWordWorker from "./wakeWordWorker?worker";
import wakeCaptureWorkletUrl from "./wakeCapture.worklet?worker&url";
import type { PreparedMicrophone } from "../features/voice/WebRtcVoiceDriver";

const WAKE_KEYWORDS = "▁HI ▁MI K A :2.5 #0.05 @Hi_Mika";

type WakeWorkerOutput =
  | { readonly type: "ready" }
  | { readonly keyword: string; readonly type: "detected" }
  | { readonly message: string; readonly type: "error" };

export class MicrophoneLease {
  #audioContext: AudioContext | undefined;
  #captureNode: AudioWorkletNode | undefined;
  #detected = false;
  #gainNode: GainNode | undefined;
  #listening = false;
  #onDetected: (() => void) | undefined;
  #onError: ((message: string) => void) | undefined;
  #sourceNode: MediaStreamAudioSourceNode | undefined;
  #stream: MediaStream | undefined;
  #streamTask: Promise<MediaStream> | undefined;
  #worker: Worker | undefined;
  #workerReady: Promise<void> | undefined;

  isListening(): boolean {
    return this.#listening;
  }

  async startListening(
    onDetected: () => void,
    onError: (message: string) => void,
  ): Promise<void> {
    this.#onDetected = onDetected;
    this.#onError = onError;
    if (this.#listening) return;
    await Promise.all([this.#ensureWorker(), this.#ensureStream()]);
    const stream = this.#stream;
    const worker = this.#worker;
    if (!stream || !worker) throw new Error("麦克风唤醒运行时没有准备好。");

    const context = new AudioContext();
    await context.audioWorklet.addModule(wakeCaptureWorkletUrl);
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "charamate-wake-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gain = context.createGain();
    gain.gain.value = 0;
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.#listening || this.#detected) return;
      const samples = event.data;
      worker.postMessage(
        { sampleRate: context.sampleRate, samples, type: "samples" },
        [samples.buffer],
      );
    };
    source.connect(capture);
    capture.connect(gain);
    gain.connect(context.destination);
    this.#audioContext = context;
    this.#sourceNode = source;
    this.#captureNode = capture;
    this.#gainNode = gain;
    this.#detected = false;
    this.#listening = true;
  }

  async pauseListening(): Promise<void> {
    this.#listening = false;
    this.#captureNode?.port.close();
    this.#sourceNode?.disconnect();
    this.#captureNode?.disconnect();
    this.#gainNode?.disconnect();
    this.#sourceNode = undefined;
    this.#captureNode = undefined;
    this.#gainNode = undefined;
    const context = this.#audioContext;
    this.#audioContext = undefined;
    if (context) await context.close().catch(() => undefined);
    this.#worker?.postMessage({ type: "reset" });
  }

  async stop(): Promise<void> {
    await this.pauseListening();
    this.#worker?.postMessage({ type: "shutdown" });
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#workerReady = undefined;
    await this.#streamTask?.catch(() => undefined);
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
    this.#streamTask = undefined;
    this.#onDetected = undefined;
    this.#onError = undefined;
  }

  async prepareVoiceMicrophone(): Promise<PreparedMicrophone> {
    const startedAt = performance.now();
    await this.pauseListening();
    const source = await this.#ensureStream();
    const tracks = source.getAudioTracks().map((track) => track.clone());
    if (tracks.length === 0) throw new Error("没有可用的麦克风音轨。");
    return {
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      stream: new MediaStream(tracks),
    };
  }

  async playReadyCue(): Promise<void> {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const ended = new Promise<void>((resolve) => {
      oscillator.addEventListener("ended", () => resolve(), { once: true });
    });
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.13);
    try {
      await context.resume();
      await ended;
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async #ensureStream(): Promise<MediaStream> {
    const existing = this.#stream;
    if (
      existing?.getAudioTracks().some((track) => track.readyState === "live")
    ) {
      return existing;
    }
    if (this.#streamTask) return this.#streamTask;
    for (const track of existing?.getTracks() ?? []) track.stop();
    const task = navigator.mediaDevices
      .getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      .then((stream) => {
        this.#stream = stream;
        return stream;
      })
      .finally(() => {
        if (this.#streamTask === task) this.#streamTask = undefined;
      });
    this.#streamTask = task;
    return task;
  }

  #ensureWorker(): Promise<void> {
    if (this.#workerReady) return this.#workerReady;
    const worker = new WakeWordWorker();
    this.#worker = worker;
    const task = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WakeWorkerOutput>) => {
        const message = event.data;
        if (message.type === "ready") {
          resolve();
          return;
        }
        if (message.type === "detected") {
          if (!this.#listening || this.#detected) return;
          this.#detected = true;
          this.#onDetected?.();
          return;
        }
        this.#onError?.(message.message);
        reject(new Error(message.message));
      };
      worker.onerror = (event) => {
        const message = event.message || "本地唤醒词 Worker 启动失败。";
        this.#onError?.(message);
        reject(new Error(message));
      };
      worker.postMessage({
        baseUrl: new URL("./wake-word/", window.location.href).href,
        keywords: WAKE_KEYWORDS,
        type: "initialize",
      });
    }).catch((error: unknown) => {
      worker.terminate();
      if (this.#worker === worker) this.#worker = undefined;
      this.#workerReady = undefined;
      throw error;
    });
    this.#workerReady = task;
    return task;
  }
}
