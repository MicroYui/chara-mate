import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceWakeCharacterApi,
  VoiceWakeReportRequest,
  VoiceWakeReportedPhase,
  VoiceWakeSnapshot,
} from "../../shared/contracts/voiceWake";
import type { VoiceSessionSnapshot } from "../../shared/contracts/voice";
import type { VoiceStore, VoiceUiState } from "../features/voice/voiceStore";
import type { MicrophoneLease } from "./MicrophoneLease";
import { personaSnapshotFixture } from "../../../tests/fixtures/foundationContracts";
import {
  VoiceWakeController,
  VOICE_WAKE_NO_SPEECH_TIMEOUT_MS,
} from "./VoiceWakeController";

const activeVoice: VoiceSessionSnapshot = {
  assistantTranscript: "",
  chatId: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-25T07:00:00.000Z",
  generation: 1,
  inputMode: "hands_free",
  muted: false,
  persona: personaSnapshotFixture,
  phase: "listening",
  sessionId: "20000000-0000-4000-8000-000000000001",
  userTranscript: "",
  voice: "verse",
};

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function createFixture(initialVoice: VoiceSessionSnapshot | null = null) {
  let wakeSnapshot: VoiceWakeSnapshot = {
    enabled: true,
    microphone: "granted",
    phase: "arming",
    phrase: "Hi Mika",
  };
  let wakeListener: ((snapshot: VoiceWakeSnapshot) => void) | undefined;
  const reports: VoiceWakeReportedPhase[] = [];
  const getSnapshot: VoiceWakeCharacterApi["getSnapshot"] = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      value: wakeSnapshot,
    }),
  );
  const report: VoiceWakeCharacterApi["report"] = vi.fn(
    (request: VoiceWakeReportRequest) => {
      reports.push(request.phase);
      wakeSnapshot = {
        ...wakeSnapshot,
        ...(request.error ? { error: request.error } : {}),
        phase: request.phase,
      };
      return Promise.resolve({ ok: true as const, value: wakeSnapshot });
    },
  );
  const subscribe: VoiceWakeCharacterApi["subscribe"] = vi.fn(
    (listener: (snapshot: VoiceWakeSnapshot) => void) => {
      wakeListener = listener;
      return vi.fn();
    },
  );
  const api: VoiceWakeCharacterApi = {
    getSnapshot,
    report,
    subscribe,
  };

  let voiceState: VoiceUiState = {
    error: null,
    snapshot: initialVoice,
    starting: false,
  };
  const voiceListeners = new Set<() => void>();
  const emitVoice = () => {
    for (const listener of voiceListeners) listener();
  };
  const startWake = vi.fn(() => {
    voiceState = { error: null, snapshot: activeVoice, starting: false };
    emitVoice();
    return Promise.resolve();
  });
  const resumeFromWake = vi.fn(() => {
    if (!voiceState.snapshot) return Promise.resolve();
    voiceState = {
      ...voiceState,
      snapshot: {
        ...voiceState.snapshot,
        phase: "listening",
      },
    };
    emitVoice();
    return Promise.resolve();
  });
  const end = vi.fn(() => {
    voiceState = { error: null, snapshot: null, starting: false };
    emitVoice();
    return Promise.resolve(true);
  });
  const voice = {
    end,
    getState: () => voiceState,
    resumeFromWake,
    startWake,
    subscribe: (listener: () => void) => {
      voiceListeners.add(listener);
      return () => voiceListeners.delete(listener);
    },
  } as unknown as VoiceStore;

  let detection: (() => void) | undefined;
  const pauseListening = vi.fn(() => Promise.resolve());
  const playReadyCue = vi.fn(() => Promise.resolve());
  const startListening = vi.fn((onDetected: () => void) => {
    detection = onDetected;
    return Promise.resolve();
  });
  const stop = vi.fn(() => Promise.resolve());
  const microphone = {
    pauseListening,
    playReadyCue,
    startListening,
    stop,
  } as unknown as MicrophoneLease;
  const controller = new VoiceWakeController(api, voice, microphone);

  return {
    controller,
    detect: () => detection?.(),
    end,
    microphone,
    pauseListening,
    playReadyCue,
    reports,
    resumeFromWake,
    startListening,
    startWake,
    updateVoice: (snapshot: VoiceSessionSnapshot | null) => {
      voiceState = { error: null, snapshot, starting: false };
      emitVoice();
    },
    updateWake: (snapshot: VoiceWakeSnapshot) => {
      wakeSnapshot = snapshot;
      wakeListener?.(snapshot);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceWakeController", () => {
  it("arms locally and quick-starts the existing full-access Voice path", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.controller.start();
    await flushMicrotasks();

    expect(fixture.startListening).toHaveBeenCalledOnce();
    expect(fixture.reports).toContain("listening");
    fixture.detect();
    await flushMicrotasks(24);

    expect(fixture.playReadyCue).toHaveBeenCalledOnce();
    expect(fixture.startWake).toHaveBeenCalledOnce();
    expect(fixture.reports).toEqual(
      expect.arrayContaining(["detected", "connecting"]),
    );

    await vi.advanceTimersByTimeAsync(VOICE_WAKE_NO_SPEECH_TIMEOUT_MS);
    await flushMicrotasks(24);
    expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.startListening.mock.calls.length).toBeGreaterThan(1);

    fixture.controller.stop();
  });

  it("keeps a wake-started session after the first real user turn", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.controller.start();
    await flushMicrotasks();
    fixture.detect();
    await flushMicrotasks(24);

    fixture.updateVoice({
      ...activeVoice,
      phase: "thinking",
      turnId: "30000000-0000-4000-8000-000000000001",
      userTranscript: "帮我看看今天的安排",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(VOICE_WAKE_NO_SPEECH_TIMEOUT_MS);
    await flushMicrotasks();

    expect(fixture.end).not.toHaveBeenCalled();
    fixture.controller.stop();
  });

  it("starts the no-speech window only after wake greeting playback finishes", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.controller.start();
    await flushMicrotasks();
    fixture.detect();
    await flushMicrotasks(24);

    fixture.updateVoice({
      ...activeVoice,
      assistantTranscript: "你好，我在。",
      phase: "speaking",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(VOICE_WAKE_NO_SPEECH_TIMEOUT_MS);
    await flushMicrotasks(24);

    expect(fixture.end).not.toHaveBeenCalled();
    fixture.updateVoice({
      ...activeVoice,
      assistantTranscript: "你好，我在。",
      phase: "listening",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(VOICE_WAKE_NO_SPEECH_TIMEOUT_MS - 1);
    expect(fixture.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks(24);

    expect(fixture.end).toHaveBeenCalledOnce();
    fixture.controller.stop();
  });

  it("reports listening again after the setting is disabled and re-enabled", async () => {
    const fixture = createFixture();
    fixture.controller.start();
    await flushMicrotasks();

    fixture.updateWake({
      enabled: false,
      microphone: "granted",
      phase: "disabled",
      phrase: "Hi Mika",
    });
    await flushMicrotasks();
    fixture.updateWake({
      enabled: true,
      microphone: "granted",
      phase: "arming",
      phrase: "Hi Mika",
    });
    await flushMicrotasks(24);

    expect(
      fixture.reports.filter((phase) => phase === "listening"),
    ).toHaveLength(2);
    expect(fixture.startListening).toHaveBeenCalledTimes(2);
    fixture.controller.stop();
  });

  it("resumes a paused Voice session instead of creating a second session", async () => {
    const fixture = createFixture({ ...activeVoice, phase: "paused" });
    fixture.controller.start();
    await flushMicrotasks();
    fixture.detect();
    await flushMicrotasks(24);

    expect(fixture.resumeFromWake).toHaveBeenCalledOnce();
    expect(fixture.startWake).not.toHaveBeenCalled();
    fixture.controller.stop();
  });
});
