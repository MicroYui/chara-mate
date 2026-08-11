import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceApi,
  VoiceStartResponse,
} from "../../../shared/contracts/voice";
import { VoiceStore } from "./voiceStore";

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

    expect(getUserMedia).toHaveBeenCalledOnce();
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
  });
});
