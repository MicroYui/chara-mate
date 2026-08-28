# CharaMate voice-wake runtime provenance

This directory contains the single offline wake-word runtime packaged by
CharaMate.

- Runtime: sherpa-onnx `v1.13.6`, commit
  `1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911`, built with the upstream
  `wasm/kws` target, Emscripten `4.0.23`, SIMD, a 64 MiB initial WebAssembly
  memory, and memory growth enabled.
- Model: `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, INT8
  encoder/decoder/joiner, tokens and BPE model. Original archive SHA-256:
  `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`.
- License: Apache License 2.0. The upstream license and model README are
  included beside this notice.

Packaged file SHA-256 values:

- `sherpa-onnx-kws.js`:
  `03b44e372795fd907e84eecd29419e1d052dc6704ac06935c9bf9fe19b3e3434`
- `sherpa-onnx-wasm-kws-main.data`:
  `a2ac267c52f314c76cdf81663543abdbf4cc2bc5b84084c47c47aa6cd451c99e`
- `sherpa-onnx-wasm-kws-main.js`:
  `9a9b404546bc877f41bc444f007442ba7514b5fbad9918f22d648731b3f4e16a`
- `sherpa-onnx-wasm-kws-main.wasm`:
  `62a4e488c6f37d6747fb1df007cb54cb1f36a1ebd01d9481ae53d7d71d7ccbe6`
