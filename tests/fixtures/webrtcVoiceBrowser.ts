import { vi } from "vitest";

export class FakeDataChannel extends EventTarget {
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "open";

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  emit(value: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

export class FakePeerConnection extends EventTarget {
  static latest: FakePeerConnection | undefined;
  readonly channel = new FakeDataChannel();
  connectionState: RTCPeerConnectionState = "connected";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;

  constructor() {
    super();
    FakePeerConnection.latest = this;
  }

  addTrack(): void {}
  addTransceiver(): RTCRtpTransceiver {
    return {} as RTCRtpTransceiver;
  }
  close(): void {
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ sdp: "offer-sdp", type: "offer" });
  }
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    return Promise.resolve();
  }
  setRemoteDescription(): Promise<void> {
    const event = new Event("track");
    Object.defineProperties(event, {
      streams: { value: [{}] },
      track: { value: {} },
    });
    this.dispatchEvent(event);
    return Promise.resolve();
  }
}

class FakeAnalyser {
  fftSize = 256;
  connect(): void {}
  disconnect(): void {}
  getByteTimeDomainData(samples: Uint8Array): void {
    samples.fill(128);
  }
}

class FakeGain {
  readonly gain = { value: 0 };
  connect(): void {}
}

export class FakeAudioContext {
  readonly currentTime = 4;
  readonly destination = {};
  state: AudioContextState = "suspended";

  createAnalyser(): AnalyserNode {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }
  createGain(): GainNode {
    return new FakeGain() as unknown as GainNode;
  }
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
}

export function installVoiceBrowserFixture() {
  const track = { enabled: false, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("answer-sdp")));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  return { track, stream };
}
