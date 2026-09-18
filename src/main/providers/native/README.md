# Local embedding resources

Main owns one `LocalEmbedding` instance. Model selection and output dimensions are build decisions; they are not runtime modes or Settings.

`localEmbeddingResources({ appPath, resourcesPath, isPackaged })` asynchronously validates the selected `manifest.json`. Development reads `resources/generated/local-embedding`; a packaged app reads `Resources/local-embedding`. Missing resources fail explicitly. The caller must join `shutdown()` during application exit.

Prepare a selected resource descriptor conforming to `LocalEmbeddingManifestSchema`, then run:

```sh
node scripts/prepare-local-embedding.mjs path/to/selected-descriptor.json
```

The optional second and third arguments are a fresh output directory and the build download cache. The script downloads only official llama.cpp GitHub releases and the official Qwen model repository, checks pinned SHA-256 values, builds the supervisor with Apple's SDK, and copies exactly one model plus the server, dynamic libraries, model card and licenses. It refuses to replace an existing output directory. A build may reuse verified cache files; the resulting directory has no dependency on the cache. `verified-files.json` describes the prepared files before application signing.

Forge must copy the generated directory to `Resources/local-embedding` outside ASAR, preserve dylib symlinks, and sign its Mach-O executables and libraries as part of signing the application. The native archive is arm64; do not advertise an x64/universal bundle. The measured binary's deployment target is macOS 13.3; that is a compiled minimum, not a claim of testing that OS release. Runtime library paths are relative to the executable. No Python, Homebrew or Node package is needed by the sidecar.

Protocol reference: llama.cpp `b10964` / commit `b29c606e28a01b1bc8c1351026a0fa6e616bf6c4`, inspected 2026-09-15. Qwen3 uses causal attention with LAST pooling. A sequence can span multiple microbatches. The server rejects token counts greater than **or equal to** the allocated context, so document chunks include special-token overhead and remain strictly below that allocation. The `/tokenize` request uses `add_special:true, parse_special:false`; `/v1/embeddings` receives the resulting token IDs, because raw strings use different special-marker parsing. Output uses the selected MRL prefix followed by L2 normalization. The index namespace includes all encoding choices and document window size.

`embedding-supervisor.c` uses macOS kqueue parent-exit and signal notifications, terminates/joins its sole server child, and unlinks its owned socket. Five seconds is a cleanup grace for a child ignoring SIGTERM, not a Run deadline or model request limit. Native logs are not persisted by the adapter. Main cleans the temporary directory on orderly shutdown; after a hard parent exit the supervisor removes the socket, and an empty temporary directory may remain.

The focused tests use a deterministic HTTP fixture only to verify protocol and cancellation; it is not a semantic embedding model. Real encoding and quality evidence remain external and are summarized by the owning Chinese Decision Record. Formal signed/notarized application acceptance belongs to the build integration owner.
