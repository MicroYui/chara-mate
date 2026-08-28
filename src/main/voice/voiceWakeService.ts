import type {
  VoiceWakeReportRequest,
  VoiceWakeSnapshot,
} from "../../shared/contracts/voiceWake";
import { VOICE_WAKE_PHRASE } from "../../shared/contracts/voiceWake";
import type { Clock } from "../../shared/pure/clock";
import type { SettingsRepository } from "../app/settingsRepository";

export interface VoiceWakePublisher {
  snapshot(snapshot: VoiceWakeSnapshot): void;
}

export interface MicrophonePermissionController {
  read(): VoiceWakeSnapshot["microphone"];
  request(): Promise<boolean>;
}

export interface VoiceWakePowerEvents {
  on(
    event: "lock-screen" | "resume" | "suspend" | "unlock-screen",
    listener: () => void,
  ): this;
  off(
    event: "lock-screen" | "resume" | "suspend" | "unlock-screen",
    listener: () => void,
  ): this;
}

export class VoiceWakeService {
  readonly #listeners = new Set<() => void>();
  #powerEvents: VoiceWakePowerEvents | undefined;
  #reportedError: string | undefined;
  #reportedPhase: VoiceWakeReportRequest["phase"] = "arming";
  #systemSuspended = false;
  #voiceActive = false;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly permissions: MicrophonePermissionController,
    private readonly clock: Clock,
    private readonly publisher: VoiceWakePublisher,
  ) {}

  initialize(powerEvents: VoiceWakePowerEvents): void {
    if (this.#powerEvents) return;
    this.#powerEvents = powerEvents;
    powerEvents.on("lock-screen", this.#suspend);
    powerEvents.on("suspend", this.#suspend);
    powerEvents.on("resume", this.#resume);
    powerEvents.on("unlock-screen", this.#resume);
  }

  shutdown(): void {
    const powerEvents = this.#powerEvents;
    this.#powerEvents = undefined;
    if (powerEvents) {
      powerEvents.off("lock-screen", this.#suspend);
      powerEvents.off("suspend", this.#suspend);
      powerEvents.off("resume", this.#resume);
      powerEvents.off("unlock-screen", this.#resume);
    }
    this.#listeners.clear();
  }

  getSnapshot(): VoiceWakeSnapshot {
    const enabled = this.settings.getVoiceWakeEnabled();
    if (!enabled) {
      return {
        enabled: false,
        microphone: this.permissions.read(),
        phase: "disabled",
        phrase: VOICE_WAKE_PHRASE,
      };
    }
    if (this.#systemSuspended) {
      return {
        enabled: true,
        microphone: this.permissions.read(),
        phase: "suspended",
        phrase: VOICE_WAKE_PHRASE,
      };
    }
    if (this.#voiceActive) {
      return {
        enabled: true,
        microphone: this.permissions.read(),
        phase: "voice_active",
        phrase: VOICE_WAKE_PHRASE,
      };
    }
    return {
      enabled: true,
      ...(this.#reportedError ? { error: this.#reportedError } : {}),
      microphone: this.permissions.read(),
      phase: this.#reportedPhase,
      phrase: VOICE_WAKE_PHRASE,
    };
  }

  async setEnabled(enabled: boolean): Promise<VoiceWakeSnapshot> {
    const current = this.settings.getVoiceWakeEnabled();
    if (enabled && !current) {
      const status = this.permissions.read();
      if (status === "denied" || status === "restricted") {
        throw new Error("请先在系统设置中允许 CharaMate 使用麦克风。");
      }
      if (status === "not_determined" && !(await this.permissions.request())) {
        throw new Error("没有获得麦克风权限，语音唤醒未开启。");
      }
    }
    if (current !== enabled) {
      this.settings.saveVoiceWakeEnabled(enabled, this.clock.now());
    }
    if (!enabled) {
      this.#reportedError = undefined;
      this.#reportedPhase = "arming";
    }
    this.#publish();
    return this.getSnapshot();
  }

  report(request: VoiceWakeReportRequest): VoiceWakeSnapshot {
    this.#reportedPhase = request.phase;
    this.#reportedError =
      request.phase === "error"
        ? request.error?.trim() || "本地语音唤醒暂时不可用。"
        : undefined;
    this.#publish();
    return this.getSnapshot();
  }

  setVoiceActive(active: boolean): void {
    if (this.#voiceActive === active) return;
    this.#voiceActive = active;
    this.#publish();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readonly #suspend = (): void => {
    if (this.#systemSuspended) return;
    this.#systemSuspended = true;
    this.#publish();
  };

  readonly #resume = (): void => {
    if (!this.#systemSuspended) return;
    this.#systemSuspended = false;
    this.#publish();
  };

  #publish(): void {
    const snapshot = this.getSnapshot();
    this.publisher.snapshot(snapshot);
    for (const listener of this.#listeners) listener();
  }
}
