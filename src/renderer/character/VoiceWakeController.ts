import type {
  VoiceWakeCharacterApi,
  VoiceWakeReportedPhase,
  VoiceWakeSnapshot,
} from "../../shared/contracts/voiceWake";
import type { VoiceStore, VoiceUiState } from "../features/voice/voiceStore";
import type { MicrophoneLease } from "./MicrophoneLease";

export const VOICE_WAKE_NO_SPEECH_TIMEOUT_MS = 10_000;

interface ActivationBaseline {
  readonly runId: string | undefined;
  readonly turnId: string | undefined;
  readonly userTranscript: string;
}

export class VoiceWakeController {
  #activationBaseline: ActivationBaseline | undefined;
  #activationTimer: ReturnType<typeof setTimeout> | undefined;
  #detectionActive = false;
  #lastReport:
    | { readonly error?: string; readonly phase: VoiceWakeReportedPhase }
    | undefined;
  #localFailure = false;
  #reconcileTask: Promise<void> = Promise.resolve();
  #running = false;
  #snapshot: VoiceWakeSnapshot | undefined;
  readonly #unsubscribers: Array<() => void> = [];

  constructor(
    private readonly api: VoiceWakeCharacterApi,
    private readonly voice: VoiceStore,
    private readonly microphone: MicrophoneLease,
  ) {}

  start(): () => void {
    if (this.#running) return () => this.stop();
    this.#running = true;
    this.#lastReport = undefined;
    this.#unsubscribers.push(
      this.api.subscribe((snapshot) => {
        const previousPhase = this.#snapshot?.phase;
        const wasEnabled = this.#snapshot?.enabled ?? false;
        this.#snapshot = snapshot;
        if (
          (!wasEnabled && snapshot.enabled) ||
          (previousPhase === "suspended" && snapshot.phase !== "suspended")
        ) {
          this.#localFailure = false;
          this.#lastReport = undefined;
        }
        this.#scheduleReconcile();
      }),
      this.voice.subscribe(() => {
        this.#observeActivation(this.voice.getState());
        this.#scheduleReconcile();
      }),
    );
    void this.api.getSnapshot().then((response) => {
      if (!this.#running || !response.ok) return;
      this.#snapshot = response.value;
      this.#scheduleReconcile();
    });
    return () => this.stop();
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#clearActivationTimer();
    void this.microphone.stop();
  }

  #scheduleReconcile(): void {
    this.#reconcileTask = this.#reconcileTask
      .then(() => this.#reconcile())
      .catch(async (error: unknown) => {
        this.#localFailure = true;
        await this.#report(
          "error",
          error instanceof Error ? error.message : "本地语音唤醒启动失败。",
        ).catch(() => undefined);
      });
  }

  async #reconcile(): Promise<void> {
    if (!this.#running) return;
    const wake = this.#snapshot;
    const voice = this.voice.getState();
    if (!wake?.enabled || wake.phase === "suspended") {
      this.#clearActivationTimer();
      await this.microphone.stop();
      return;
    }
    if (this.#localFailure) {
      await this.microphone.stop();
      return;
    }
    const phase = voice.snapshot?.phase;
    const mayListen =
      !voice.starting &&
      (!phase ||
        phase === "paused" ||
        phase === "failed" ||
        phase === "interrupted");
    if (!mayListen || this.#detectionActive) {
      await this.microphone.pauseListening();
      return;
    }
    await this.microphone.startListening(
      () => void this.#handleDetection(),
      (message) => {
        this.#localFailure = true;
        void this.#report("error", message);
      },
    );
    await this.#report("listening");
  }

  async #handleDetection(): Promise<void> {
    if (!this.#running || this.#detectionActive) return;
    this.#detectionActive = true;
    this.#clearActivationTimer();
    try {
      await this.microphone.pauseListening();
      await this.#report("detected");
      await this.microphone.playReadyCue();
      const before = this.voice.getState();
      const baseline: ActivationBaseline = {
        runId: before.snapshot?.runId,
        turnId: before.snapshot?.turnId,
        userTranscript: before.snapshot?.userTranscript ?? "",
      };
      await this.#report("connecting");
      if (before.snapshot?.phase === "paused") {
        await this.voice.resumeFromWake();
      } else {
        if (
          before.snapshot?.phase === "failed" ||
          before.snapshot?.phase === "interrupted"
        ) {
          const ended = await this.voice.end();
          if (!ended) throw new Error("异常语音会话没有成功清理。");
        }
        if (!this.voice.getState().snapshot) await this.voice.startWake();
      }
      const after = this.voice.getState();
      if (!after.snapshot || after.error) {
        throw new Error(after.error?.message ?? "没有成功进入语音对话。");
      }
      this.#activationBaseline = baseline;
      this.#observeActivation(after);
    } catch (error) {
      await this.#report(
        "error",
        error instanceof Error ? error.message : "自动语音唤醒失败。",
      );
    } finally {
      this.#detectionActive = false;
      this.#scheduleReconcile();
    }
  }

  #observeActivation(state: VoiceUiState): void {
    const baseline = this.#activationBaseline;
    const snapshot = state.snapshot;
    if (!baseline) return;
    if (!snapshot) {
      this.#clearActivationTimer();
      return;
    }
    if (this.#hasNewUserActivity(snapshot, baseline)) {
      this.#clearActivationTimer();
      return;
    }
    if (snapshot.phase === "listening") {
      this.#armActivationTimer();
      return;
    }
    if (
      snapshot.phase === "failed" ||
      snapshot.phase === "interrupted" ||
      snapshot.phase === "paused"
    ) {
      this.#clearActivationTimer();
      return;
    }
    this.#cancelActivationTimer();
  }

  #hasNewUserActivity(
    snapshot: NonNullable<VoiceUiState["snapshot"]>,
    baseline: ActivationBaseline,
  ): boolean {
    return (
      (snapshot.runId !== baseline.runId && snapshot.runId !== undefined) ||
      (snapshot.turnId !== baseline.turnId &&
        snapshot.userTranscript.trim().length > 0) ||
      snapshot.userTranscript !== baseline.userTranscript
    );
  }

  async #closeSilentActivation(): Promise<void> {
    this.#activationTimer = undefined;
    const baseline = this.#activationBaseline;
    const state = this.voice.getState();
    if (
      !baseline ||
      !state.snapshot ||
      this.#hasNewUserActivity(state.snapshot, baseline)
    ) {
      this.#activationBaseline = undefined;
      return;
    }
    if (state.snapshot.phase !== "listening") {
      this.#observeActivation(state);
      return;
    }
    this.#activationBaseline = undefined;
    const ended = await this.voice.end();
    if (!ended) return;
    await this.#report("arming");
    this.#scheduleReconcile();
  }

  #armActivationTimer(): void {
    if (!this.#activationBaseline || this.#activationTimer) return;
    this.#activationTimer = setTimeout(() => {
      void this.#closeSilentActivation();
    }, VOICE_WAKE_NO_SPEECH_TIMEOUT_MS);
  }

  #cancelActivationTimer(): void {
    if (this.#activationTimer) clearTimeout(this.#activationTimer);
    this.#activationTimer = undefined;
  }

  #clearActivationTimer(): void {
    this.#cancelActivationTimer();
    this.#activationBaseline = undefined;
  }

  async #report(phase: VoiceWakeReportedPhase, error?: string): Promise<void> {
    if (this.#lastReport?.phase === phase && this.#lastReport.error === error) {
      return;
    }
    const response = await this.api.report({
      ...(error ? { error } : {}),
      phase,
    });
    if (!response.ok) throw new Error(response.error.message);
    this.#lastReport = { ...(error ? { error } : {}), phase };
    this.#snapshot = response.value;
  }
}
