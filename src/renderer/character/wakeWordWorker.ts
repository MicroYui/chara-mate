interface SherpaKeywordResult {
  readonly keyword?: string;
  readonly timestamps?: readonly number[];
  readonly tokens?: readonly string[];
}

interface SherpaKeywordStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

interface SherpaKeywordSpotter {
  createStream(): SherpaKeywordStream;
  decode(stream: SherpaKeywordStream): void;
  free(): void;
  getResult(stream: SherpaKeywordStream): SherpaKeywordResult;
  isReady(stream: SherpaKeywordStream): boolean;
  reset(stream: SherpaKeywordStream): void;
}

interface SherpaModule {
  readonly [key: string]: unknown;
  locateFile(path: string): string;
  onAbort(reason: unknown): void;
  onRuntimeInitialized(): void;
  printErr(message: unknown): void;
}

interface WakeWorkerScope {
  Module?: SherpaModule;
  createKws?: (
    module: SherpaModule,
    config: Readonly<Record<string, unknown>>,
  ) => SherpaKeywordSpotter;
  location: Location;
  onmessage: ((event: MessageEvent<WakeWorkerInput>) => void) | null;
  postMessage(message: WakeWorkerOutput): void;
}

type WakeWorkerInput =
  | {
      readonly baseUrl: string;
      readonly keywords: string;
      readonly type: "initialize";
    }
  | {
      readonly sampleRate: number;
      readonly samples: Float32Array;
      readonly type: "samples";
    }
  | { readonly type: "reset" }
  | { readonly type: "shutdown" };

type WakeWorkerOutput =
  | { readonly type: "ready" }
  | { readonly keyword: string; readonly type: "detected" }
  | { readonly message: string; readonly type: "error" };

declare function importScripts(...urls: string[]): void;

const workerScope = self as unknown as WakeWorkerScope;
const EXPECTED_SAMPLE_RATE = 16_000;
const DECODE_BATCH_SAMPLES = 1_600;

let keywordSpotter: SherpaKeywordSpotter | undefined;
let keywordStream: SherpaKeywordStream | undefined;
let sampleBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
let resampleBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
let resamplePosition = 0;

function append(
  left: Float32Array<ArrayBufferLike>,
  right: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBufferLike> {
  const value = new Float32Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return value;
}

function downsample(
  samples: Float32Array<ArrayBufferLike>,
  sampleRate: number,
): Float32Array<ArrayBufferLike> {
  if (sampleRate === EXPECTED_SAMPLE_RATE) return samples;
  if (sampleRate < EXPECTED_SAMPLE_RATE) {
    throw new Error(`不支持 ${String(sampleRate)} Hz 的麦克风采样率。`);
  }
  resampleBuffer = append(resampleBuffer, samples);
  const ratio = sampleRate / EXPECTED_SAMPLE_RATE;
  const output: number[] = [];
  while (resamplePosition + ratio <= resampleBuffer.length) {
    const start = Math.floor(resamplePosition);
    const end = Math.max(start + 1, Math.floor(resamplePosition + ratio));
    let total = 0;
    for (let index = start; index < end; index += 1) {
      total += resampleBuffer[index] ?? 0;
    }
    output.push(total / (end - start));
    resamplePosition += ratio;
  }
  const consumed = Math.floor(resamplePosition);
  if (consumed > 0) {
    resampleBuffer = resampleBuffer.slice(consumed);
    resamplePosition -= consumed;
  }
  return Float32Array.from(output);
}

function decodeAvailable(): void {
  if (!keywordSpotter || !keywordStream) return;
  while (sampleBuffer.length >= DECODE_BATCH_SAMPLES) {
    const batch = sampleBuffer.slice(0, DECODE_BATCH_SAMPLES);
    sampleBuffer = sampleBuffer.slice(DECODE_BATCH_SAMPLES);
    keywordStream.acceptWaveform(EXPECTED_SAMPLE_RATE, batch);
    while (keywordSpotter.isReady(keywordStream)) {
      keywordSpotter.decode(keywordStream);
      const result = keywordSpotter.getResult(keywordStream);
      const keyword = result.keyword?.trim();
      if (!keyword) continue;
      workerScope.postMessage({ keyword, type: "detected" });
      keywordSpotter.reset(keywordStream);
      sampleBuffer = new Float32Array(0);
      return;
    }
  }
}

function reset(): void {
  sampleBuffer = new Float32Array(0);
  resampleBuffer = new Float32Array(0);
  resamplePosition = 0;
  if (keywordSpotter && keywordStream) keywordSpotter.reset(keywordStream);
}

function shutdown(): void {
  keywordStream?.free();
  keywordSpotter?.free();
  keywordStream = undefined;
  keywordSpotter = undefined;
  reset();
}

async function initialize(baseUrl: string, keywords: string): Promise<void> {
  if (keywordSpotter) {
    workerScope.postMessage({ type: "ready" });
    return;
  }
  const runtimeBase = new URL(baseUrl, workerScope.location.href);
  const module = await new Promise<SherpaModule>((resolve, reject) => {
    const value: SherpaModule = {
      locateFile: (path) => new URL(path, runtimeBase).href,
      onAbort: (reason) => reject(new Error(String(reason))),
      onRuntimeInitialized: () => resolve(value),
      printErr: (message) => {
        if (String(message).includes("warning")) return;
      },
    };
    workerScope.Module = value;
    importScripts(new URL("sherpa-onnx-wasm-kws-main.js", runtimeBase).href);
  });
  importScripts(new URL("sherpa-onnx-kws.js", runtimeBase).href);
  const createKws = workerScope.createKws;
  if (!createKws) throw new Error("本地唤醒词运行时没有正确加载。");
  keywordSpotter = createKws(module, {
    featConfig: { featureDim: 80, samplingRate: EXPECTED_SAMPLE_RATE },
    keywords,
    keywordsScore: 2.5,
    keywordsThreshold: 0.05,
    maxActivePaths: 4,
    modelConfig: {
      bpeVocab: "./bpe.model",
      debug: 0,
      modelingUnit: "bpe",
      numThreads: 1,
      provider: "cpu",
      tokens: "./tokens.txt",
      transducer: {
        decoder: "./decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        encoder: "./encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        joiner: "./joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
      },
    },
    numTrailingBlanks: 1,
  });
  keywordStream = keywordSpotter.createStream();
  workerScope.postMessage({ type: "ready" });
}

workerScope.onmessage = (event): void => {
  const message = event.data;
  void (async () => {
    if (message.type === "initialize") {
      await initialize(message.baseUrl, message.keywords);
      return;
    }
    if (message.type === "samples") {
      if (!keywordSpotter || !keywordStream) return;
      sampleBuffer = append(
        sampleBuffer,
        downsample(message.samples, message.sampleRate),
      );
      decodeAvailable();
      return;
    }
    if (message.type === "reset") {
      reset();
      return;
    }
    shutdown();
  })().catch((error: unknown) => {
    workerScope.postMessage({
      message: error instanceof Error ? error.message : "本地唤醒词识别失败。",
      type: "error",
    });
  });
};
