import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceApi,
  VoiceClientCommand,
  VoicePauseResponse,
  VoiceSessionSnapshot,
  VoiceStartResponse,
} from "../../../shared/contracts/voice";
import { VoiceStore } from "./voiceStore";
import type { PreparedMicrophone } from "./WebRtcVoiceDriver";
import { personaSnapshotFixture } from "../../../../tests/fixtures/foundationContracts";
import {
  installVoiceBrowserFixture,
  FakePeerConnection,
} from "../../../../tests/fixtures/webrtcVoiceBrowser";

class FakeAudioContext {
  close(): Promise<void> {
    return Promise.resolve();
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

describe("Voice store connection startup", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts microphone permission while the ephemeral credential is pending", async () => {
    const close = vi.spyOn(FakeAudioContext.prototype, "close");
    const response = deferred<VoiceStartResponse>();
    const start = vi.fn<VoiceApi["start"]>().mockReturnValue(response.promise);
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [{ enabled: false, stop }],
      getTracks: () => [{ enabled: false, stop }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const api = {
      cancelStart: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { outcome: "accepted" } }),
      end: vi.fn(),
      getActive: vi.fn(),
      preview: vi.fn(),
      quickStart: vi.fn(),
      report: vi.fn(),
      setMuted: vi.fn(),
      setPaused: vi.fn(),
      start,
      subscribeChanged: vi.fn(),
      subscribeCommand: vi.fn(),
    } satisfies VoiceApi;
    const store = new VoiceStore(api);

    const task = store.start({
      chatId: "10000000-0000-4000-8000-000000000001",
      chatProviderProfileId: "10000000-0000-4000-8000-000000000002",
      execution: { mode: "chat" },
      requestedAt: "2026-08-11T06:00:00.000Z",
    });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0]!,
    );
    response.resolve({
      error: {
        code: "PROVIDER.UNREACHABLE",
        message: "Realtime 暂时不可用。",
        retryable: true,
      },
      ok: false,
    });
    await task;
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the injected desktop-pet microphone lease instead of opening a second capture", async () => {
    const stop = vi.fn();
    const prepare = vi.fn().mockResolvedValue({
      durationMs: 3,
      stream: {
        getTracks: () => [{ stop }],
      } as unknown as MediaStream,
    });
    const quickStart = vi.fn<VoiceApi["quickStart"]>().mockResolvedValue({
      error: {
        code: "PROVIDER.UNREACHABLE",
        message: "Realtime 暂时不可用。",
        retryable: true,
      },
      ok: false,
    });
    const api = {
      cancelStart: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { outcome: "accepted" } }),
      end: vi.fn(),
      getActive: vi.fn(),
      preview: vi.fn(),
      quickStart,
      report: vi.fn(),
      setMuted: vi.fn(),
      setPaused: vi.fn(),
      start: vi.fn(),
      subscribeChanged: vi.fn(),
      subscribeCommand: vi.fn(),
    } satisfies VoiceApi;
    const store = new VoiceStore(api, prepare);

    await store.startQuick();

    expect(prepare).toHaveBeenCalledOnce();
    expect(quickStart).toHaveBeenCalledOnce();
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      quickStart.mock.invocationCallOrder[0]!,
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("marks automatic wake quick-starts without changing ordinary Voice starts", async () => {
    const quickStart = vi.fn<VoiceApi["quickStart"]>().mockResolvedValue({
      error: {
        code: "PROVIDER.UNREACHABLE",
        message: "Realtime 暂时不可用。",
        retryable: true,
      },
      ok: false,
    });
    const api = {
      cancelStart: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { outcome: "accepted" } }),
      end: vi.fn(),
      getActive: vi.fn(),
      preview: vi.fn(),
      quickStart,
      report: vi.fn(),
      setMuted: vi.fn(),
      setPaused: vi.fn(),
      start: vi.fn(),
      subscribeChanged: vi.fn(),
      subscribeCommand: vi.fn(),
    } satisfies VoiceApi;
    const store = new VoiceStore(api, vi.fn().mockRejectedValue(new Error()));

    await store.startWake();

    expect(quickStart).toHaveBeenCalledOnce();
    expect(quickStart.mock.calls[0]?.[0].request).toMatchObject({
      origin: "voice_wake",
    });
    expect(quickStart.mock.calls[0]?.[0].request.requestedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });
});

it("ends the exact pending submission before a Session reply and stops a late microphone without constructing a Driver", async () => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const reply = deferred<VoiceStartResponse>();
  const microphone = deferred<PreparedMicrophone>();
  const entered = deferred<void>();
  const peer = vi.fn();
  vi.stubGlobal("RTCPeerConnection", peer);
  const start = vi.fn<VoiceApi["start"]>(() => {
    entered.resolve();
    return reply.promise;
  });
  const cancelStart = vi
    .fn<VoiceApi["cancelStart"]>()
    .mockResolvedValue({ ok: true, value: { outcome: "accepted" } });
  const api = {
    cancelStart,
    start,
    end: vi.fn(),
    getActive: vi.fn(),
    preview: vi.fn(),
    quickStart: vi.fn(),
    report: vi.fn(),
    setMuted: vi.fn(),
    setPaused: vi.fn(),
    subscribeChanged: vi.fn(),
    subscribeCommand: vi.fn(),
  } satisfies VoiceApi;
  const store = new VoiceStore(api, () => microphone.promise);
  const task = store.start({
    chatId: "10000000-0000-4000-8000-000000000001",
    chatProviderProfileId: "10000000-0000-4000-8000-000000000002",
    execution: { mode: "chat" },
    requestedAt: "2026-08-11T06:00:00.000Z",
  });
  await entered.promise;
  expect(store.getState().starting).toBe(true);
  let ended = false;
  const ending = store.end().then(() => {
    ended = true;
  });
  const requestId = start.mock.calls[0]![0].requestId;
  expect(cancelStart).toHaveBeenCalledWith({ requestId });
  await Promise.resolve();
  expect(ended).toBe(false);
  reply.resolve({
    ok: true,
    value: {
      callsUrl: "https://unit.invalid/calls",
      clientSecret: "fixture",
      expiresAt: "2026-08-11T06:01:00.000Z",
      history: [],
      inputMode: "hands_free",
      sessionId: "10000000-0000-4000-8000-000000000003",
      voice: "verse",
    },
  });
  await ending;
  await task;
  expect(store.getState()).toMatchObject({
    starting: false,
    snapshot: null,
    error: null,
  });
  expect(peer).not.toHaveBeenCalled();
  const stop = vi.fn();
  microphone.resolve({
    durationMs: 0,
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
  });
  await microphone.promise;
  await waitFor(() => expect(stop).toHaveBeenCalled());
  expect(api.report).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a cold resume alive when Main closes the replaced Session before returning the new connection", async () => {
  installVoiceBrowserFixture();
  const oldSessionId = "10000000-0000-4000-8000-000000000011";
  const newSessionId = "10000000-0000-4000-8000-000000000012";
  const previous: VoiceSessionSnapshot = {
    assistantTranscript: "",
    chatId: "10000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-11T06:00:00.000Z",
    generation: 1,
    inputMode: "hands_free",
    muted: false,
    persona: personaSnapshotFixture,
    phase: "paused",
    sessionId: oldSessionId,
    userTranscript: "",
    voice: "verse",
  };
  const next: VoiceSessionSnapshot = {
    ...previous,
    phase: "connecting",
    sessionId: newSessionId,
  };
  const reply = deferred<VoicePauseResponse>();
  const entered = deferred<void>();
  let changed!: (snapshot: VoiceSessionSnapshot | null) => void;
  let command!: (value: VoiceClientCommand) => void;
  const api = {
    cancelStart: vi
      .fn<VoiceApi["cancelStart"]>()
      .mockResolvedValue({ ok: true, value: { outcome: "not_pending" } }),
    end: vi.fn<VoiceApi["end"]>().mockResolvedValue({ ok: true, value: null }),
    getActive: vi
      .fn<VoiceApi["getActive"]>()
      .mockResolvedValue({ ok: true, value: previous }),
    preview: vi.fn(),
    quickStart: vi.fn(),
    report: vi
      .fn<VoiceApi["report"]>()
      .mockResolvedValue({ ok: true, value: null }),
    setMuted: vi.fn(),
    start: vi.fn(),
    setPaused: vi.fn<VoiceApi["setPaused"]>(() => {
      entered.resolve();
      return reply.promise;
    }),
    subscribeChanged: (listener) => {
      changed = listener;
      return vi.fn();
    },
    subscribeCommand: (listener) => {
      command = listener;
      return vi.fn();
    },
  } satisfies VoiceApi;
  const store = new VoiceStore(api);
  const unsubscribe = store.startListening();
  try {
    await waitFor(() =>
      expect(store.getState().snapshot?.sessionId).toBe(oldSessionId),
    );
    const task = store.setPaused(false);
    await entered.promise;
    expect(api.setPaused.mock.calls[0]?.[0]).toMatchObject({
      requestId: expect.any(String) as string,
      request: { paused: false, sessionId: oldSessionId },
    });
    changed(next);
    command({ type: "session.close", sessionId: oldSessionId });
    reply.resolve({
      ok: true,
      value: {
        snapshot: next,
        connection: {
          callsUrl: "https://unit.invalid/calls",
          clientSecret: "fixture",
          expiresAt: "2026-08-11T06:01:00.000Z",
          history: [],
          inputMode: "hands_free",
          sessionId: newSessionId,
          voice: "verse",
        },
      },
    });
    await task;
    expect(FakePeerConnection.latest?.connectionState).toBe("connected");
    expect(store.getState()).toMatchObject({
      error: null,
      starting: false,
      snapshot: { sessionId: newSessionId },
    });
    expect(api.cancelStart).not.toHaveBeenCalled();
    await store.end();
    expect(api.end).toHaveBeenCalledWith({ sessionId: newSessionId });
    expect(FakePeerConnection.latest?.connectionState).toBe("closed");
  } finally {
    reply.resolve({
      ok: false,
      error: {
        code: "VOICE.START_CANCELLED",
        message: "Fixture cleanup",
        retryable: false,
      },
    });
    await store.end();
    unsubscribe();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakePeerConnection.latest = undefined;
  }
});
