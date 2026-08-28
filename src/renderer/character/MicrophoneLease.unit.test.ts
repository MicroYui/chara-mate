import { afterEach, describe, expect, it, vi } from "vitest";

import { MicrophoneLease } from "./MicrophoneLease";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}

  getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MicrophoneLease", () => {
  it("shares one pending microphone acquisition across Voice preparations", async () => {
    const acquisition = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => acquisition.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const baseStop = vi.fn();
    const clones = [
      { stop: vi.fn() } as unknown as MediaStreamTrack,
      { stop: vi.fn() } as unknown as MediaStreamTrack,
    ];
    let cloneIndex = 0;
    const cloneTrack = vi.fn(() => clones[cloneIndex++]!);
    const baseTrack = {
      clone: cloneTrack,
      readyState: "live",
      stop: baseStop,
    } as unknown as MediaStreamTrack;
    const baseStream = {
      getAudioTracks: () => [baseTrack],
      getTracks: () => [baseTrack],
    } as unknown as MediaStream;
    const lease = new MicrophoneLease();

    const first = lease.prepareVoiceMicrophone();
    const second = lease.prepareVoiceMicrophone();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledOnce();
    acquisition.resolve(baseStream);

    const [firstPrepared, secondPrepared] = await Promise.all([first, second]);
    expect(firstPrepared.stream.getTracks()).toEqual([clones[0]]);
    expect(secondPrepared.stream.getTracks()).toEqual([clones[1]]);
    expect(cloneTrack).toHaveBeenCalledTimes(2);

    await lease.stop();
    expect(baseStop).toHaveBeenCalledOnce();
  });
});
