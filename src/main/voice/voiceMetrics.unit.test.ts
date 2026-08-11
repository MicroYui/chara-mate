import { describe, expect, it } from "vitest";

import { VoiceMetrics } from "./voiceMetrics";

describe("Voice development metrics", () => {
  it("measures only observed protocol boundaries without inventing missing samples", () => {
    const metrics = new VoiceMetrics();
    metrics.startSession("session-1", "2026-08-08T12:00:00.000Z");
    metrics.connected("session-1", "2026-08-08T12:00:00.400Z");
    metrics.connectionStage("credential", 180);
    metrics.connectionStage("microphone", 220);
    metrics.connectionStage("ice", 40);
    metrics.connectionStage("sdp", 120);
    metrics.connectionStage("data_channel", 35);
    metrics.speechStarted(
      "session-1",
      "item-user-1",
      "2026-08-08T12:00:01.000Z",
      "item-assistant-old",
    );
    metrics.speechStopped(
      "session-1",
      "item-user-1",
      "2026-08-08T12:00:02.000Z",
    );
    metrics.transcriptCompleted(
      "session-1",
      "item-user-1",
      1,
      "2026-08-08T12:00:02.120Z",
    );
    metrics.audioStarted("session-1", 1, "2026-08-08T12:00:02.800Z");
    metrics.toolCallReceived("session-1", "2026-08-08T12:00:03.000Z");
    metrics.toolCallReceived("session-1", "2026-08-08T12:00:03.100Z");
    metrics.responseStarted("session-1", "2026-08-08T12:00:03.350Z");
    metrics.truncated(
      "session-1",
      "item-assistant-old",
      "2026-08-08T12:00:01.040Z",
    );
    metrics.responseUsage({
      cachedInputTokens: 2,
      inputTokens: 10,
      outputTokens: 4,
    });
    metrics.discardedLateEvent();
    metrics.disconnected();
    metrics.startReconnect("session-1", "2026-08-08T12:00:04.000Z");
    metrics.connected("session-1", "2026-08-08T12:00:04.500Z");

    expect(metrics.snapshot()).toEqual({
      connection: { count: 2, p50Ms: 400, p95Ms: 500 },
      connectionStages: {
        credential: { count: 1, p50Ms: 180, p95Ms: 180 },
        data_channel: { count: 1, p50Ms: 35, p95Ms: 35 },
        ice: { count: 1, p50Ms: 40, p95Ms: 40 },
        microphone: { count: 1, p50Ms: 220, p95Ms: 220 },
        sdp: { count: 1, p50Ms: 120, p95Ms: 120 },
      },
      disconnects: 1,
      firstAudio: { count: 1, p50Ms: 800, p95Ms: 800 },
      firstTranscript: { count: 1, p50Ms: 120, p95Ms: 120 },
      lateEventsDiscarded: 1,
      reconnects: 1,
      sessions: 1,
      toolContinuation: { count: 1, p50Ms: 350, p95Ms: 350 },
      tokens: { cachedInputTokens: 2, inputTokens: 10, outputTokens: 4 },
      truncateAcknowledgement: { count: 1, p50Ms: 40, p95Ms: 40 },
      turns: 1,
    });
  });
});
