import type { ModelUsage } from "../agent/modelProvider";
import type { VoiceConnectionStage } from "../../shared/contracts/voice";

interface SessionTiming {
  connectionStartedAt: number;
  readonly firstAudioGenerations: Set<number>;
  readonly interruptions: Map<string, number>;
  readonly speechStops: Map<string, number>;
  readonly turnSpeechStops: Map<number, number>;
  toolCallReceivedAt?: number;
}

export interface DurationMetric {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface VoiceMetricsSnapshot {
  readonly connection: DurationMetric;
  readonly connectionStages: Readonly<
    Record<VoiceConnectionStage, DurationMetric>
  >;
  readonly disconnects: number;
  readonly firstAudio: DurationMetric;
  readonly firstTranscript: DurationMetric;
  readonly lateEventsDiscarded: number;
  readonly reconnects: number;
  readonly sessions: number;
  readonly toolContinuation: DurationMetric;
  readonly tokens: ModelUsage;
  /**
   * Recorded completion observations, including absent usage.
   * Not unique responses or HTTP calls.
   */
  readonly usageCoverage: {
    readonly reports: number;
    readonly cachedInputTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly truncateAcknowledgement: DurationMetric;
  readonly turns: number;
}

function milliseconds(value: string): number {
  return Date.parse(value);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function duration(values: readonly number[]): DurationMetric {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

export class VoiceMetrics {
  readonly #connection: number[] = [];
  readonly #connectionStages: Record<VoiceConnectionStage, number[]> = {
    credential: [],
    data_channel: [],
    ice: [],
    microphone: [],
    sdp: [],
  };
  #disconnects = 0;
  readonly #firstAudio: number[] = [];
  readonly #firstTranscript: number[] = [];
  #lateEventsDiscarded = 0;
  #reconnects = 0;
  #sessions = 0;
  readonly #sessionTiming = new Map<string, SessionTiming>();
  readonly #toolContinuation: number[] = [];
  readonly #tokens = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  readonly #usageCoverage = {
    reports: 0,
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  readonly #truncateAcknowledgement: number[] = [];
  #turns = 0;

  startSession(sessionId: string, at: string): void {
    this.#sessions += 1;
    this.#sessionTiming.set(sessionId, {
      connectionStartedAt: milliseconds(at),
      firstAudioGenerations: new Set(),
      interruptions: new Map(),
      speechStops: new Map(),
      turnSpeechStops: new Map(),
    });
  }

  startReconnect(sessionId: string, at: string): void {
    this.#reconnects += 1;
    const timing = this.#timing(sessionId);
    timing.connectionStartedAt = milliseconds(at);
  }

  connected(sessionId: string, at: string): void {
    const timing = this.#sessionTiming.get(sessionId);
    if (!timing) return;
    this.#connection.push(
      Math.max(0, milliseconds(at) - timing.connectionStartedAt),
    );
  }

  connectionStage(stage: VoiceConnectionStage, durationMs: number): void {
    this.#connectionStages[stage].push(Math.max(0, durationMs));
  }

  speechStarted(
    sessionId: string,
    inputItemId: string,
    at: string,
    assistantItemId?: string,
  ): void {
    this.#turns += 1;
    const timing = this.#timing(sessionId);
    delete timing.toolCallReceivedAt;
    timing.speechStops.delete(inputItemId);
    if (assistantItemId) {
      timing.interruptions.set(assistantItemId, milliseconds(at));
    }
  }

  speechStopped(sessionId: string, inputItemId: string, at: string): void {
    this.#timing(sessionId).speechStops.set(inputItemId, milliseconds(at));
  }

  transcriptCompleted(
    sessionId: string,
    inputItemId: string,
    generation: number,
    at: string,
  ): void {
    const timing = this.#timing(sessionId);
    const stoppedAt = timing.speechStops.get(inputItemId);
    if (stoppedAt === undefined) return;
    this.#firstTranscript.push(Math.max(0, milliseconds(at) - stoppedAt));
    timing.turnSpeechStops.set(generation, stoppedAt);
  }

  audioStarted(sessionId: string, generation: number, at: string): void {
    const timing = this.#timing(sessionId);
    if (timing.firstAudioGenerations.has(generation)) return;
    const stoppedAt = timing.turnSpeechStops.get(generation);
    if (stoppedAt === undefined) return;
    timing.firstAudioGenerations.add(generation);
    this.#firstAudio.push(Math.max(0, milliseconds(at) - stoppedAt));
  }

  toolCallReceived(sessionId: string, at: string): void {
    const timing = this.#timing(sessionId);
    timing.toolCallReceivedAt ??= milliseconds(at);
  }

  responseStarted(sessionId: string, at: string): void {
    const timing = this.#timing(sessionId);
    if (timing.toolCallReceivedAt === undefined) return;
    this.#toolContinuation.push(
      Math.max(0, milliseconds(at) - timing.toolCallReceivedAt),
    );
    delete timing.toolCallReceivedAt;
  }

  truncated(sessionId: string, itemId: string, at: string): void {
    const timing = this.#timing(sessionId);
    const interruptedAt = timing.interruptions.get(itemId);
    if (interruptedAt === undefined) return;
    this.#truncateAcknowledgement.push(
      Math.max(0, milliseconds(at) - interruptedAt),
    );
    timing.interruptions.delete(itemId);
  }

  responseUsage(usage: ModelUsage | undefined): void {
    this.#usageCoverage.reports += 1;
    for (const field of [
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
    ] as const) {
      const value = usage?.[field];
      if (value === undefined) continue;
      this.#tokens[field] += value;
      this.#usageCoverage[field] += 1;
    }
  }

  disconnected(): void {
    this.#disconnects += 1;
  }

  discardedLateEvent(): void {
    this.#lateEventsDiscarded += 1;
  }

  snapshot(): VoiceMetricsSnapshot {
    return {
      connection: duration(this.#connection),
      connectionStages: {
        credential: duration(this.#connectionStages.credential),
        data_channel: duration(this.#connectionStages.data_channel),
        ice: duration(this.#connectionStages.ice),
        microphone: duration(this.#connectionStages.microphone),
        sdp: duration(this.#connectionStages.sdp),
      },
      disconnects: this.#disconnects,
      firstAudio: duration(this.#firstAudio),
      firstTranscript: duration(this.#firstTranscript),
      lateEventsDiscarded: this.#lateEventsDiscarded,
      reconnects: this.#reconnects,
      sessions: this.#sessions,
      toolContinuation: duration(this.#toolContinuation),
      tokens: { ...this.#tokens },
      usageCoverage: { ...this.#usageCoverage },
      truncateAcknowledgement: duration(this.#truncateAcknowledgement),
      turns: this.#turns,
    };
  }

  #timing(sessionId: string): SessionTiming {
    const existing = this.#sessionTiming.get(sessionId);
    if (existing) return existing;
    const timing: SessionTiming = {
      connectionStartedAt: 0,
      firstAudioGenerations: new Set(),
      interruptions: new Map(),
      speechStops: new Map(),
      turnSpeechStops: new Map(),
    };
    this.#sessionTiming.set(sessionId, timing);
    return timing;
  }
}
