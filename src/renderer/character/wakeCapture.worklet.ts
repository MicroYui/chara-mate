interface AudioWorkletProcessorConstructor {
  new (): AudioWorkletProcessor;
}

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processor: AudioWorkletProcessorConstructor,
): void;

class CharaMateWakeCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      const samples = new Float32Array(channel);
      this.port.postMessage(samples, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor("charamate-wake-capture", CharaMateWakeCaptureProcessor);
