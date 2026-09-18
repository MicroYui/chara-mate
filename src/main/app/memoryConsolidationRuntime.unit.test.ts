import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import type { ChatModelRuntime } from "../providers/providerService";
import { estimateInputBudget } from "../providers/inputBudget";
import type { MemoryConsolidationInput } from "../memory/memoryConsolidation";
import { MEMORY_CONSOLIDATION_VERSION } from "../memory/memoryLearningRepository";
import { createMemoryConsolidationRuntime } from "./memoryConsolidationRuntime";

function fixture() {
  const original: ProviderSnapshot = {
    profileId: randomUUID(),
    profileName: "Offline binding fixture",
    apiStyle: "openai-compatible",
    modelId: "fixture-a",
  };
  let current = original;
  const requests: ModelRequest[] = [];
  const measurements: ModelRequest[] = [];
  const output = {
    disposition: "retain_originals",
    reason: "No supplied evidence",
    dependencies: [],
    citations: [],
  };
  const resolveContextLimits = vi.fn(() =>
    Promise.resolve({ maxContextTokens: 32000 }),
  );
  const provider: ModelProvider = {
    measureInput(request: ModelRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      measurements.push(request);
      return Promise.resolve(this.estimateInput(request));
    },
    estimateInput: (request) => estimateInputBudget(request, request.modelId),
    resolveContextLimits,
    stream(request) {
      requests.push(request);
      return (async function* (): AsyncGenerator<ModelEvent> {
        await Promise.resolve();
        yield { type: "text.delta", delta: JSON.stringify(output) };
        yield {
          type: "response.completed",
          responseId: "offline-response",
          status: "completed",
          usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
        };
      })();
    },
  };
  const runtime = vi.fn(() => Promise.resolve({ provider, snapshot: current }));
  const onUsage = vi.fn();
  const model = createMemoryConsolidationRuntime(
    {
      getDefaultChatProfileId: () => current.profileId,
      createSnapshot: () => ({ ...current }),
      createChatModelRuntime: runtime,
    },
    onUsage,
  );
  const input: MemoryConsolidationInput = {
    anchorRevisionId: randomUUID(),
    evidence: [],
    support: [],
    coverage: {
      namespaceFormationIncomplete: false,
      retrieval: {
        coverage: [],
        gaps: [],
        truncated: false,
        incompleteReasons: [],
      },
      supplied: [],
      knownFormationConnections: [],
    },
  };
  return {
    model,
    original,
    provider,
    requests,
    measurements,
    resolveContextLimits,
    runtime,
    onUsage,
    input,
    output,
    change: (snapshot: ProviderSnapshot) => {
      current = snapshot;
    },
  };
}

describe("Memory actual consolidation runtime binding", () => {
  it("keeps the derived format stable and rejects an obsolete execution before creating a runtime", async () => {
    const f = fixture();
    const expectedProcessorVersion = f.model.version;
    expect(MEMORY_CONSOLIDATION_VERSION).toBe("grounded-consolidation-v1");
    expect(
      expectedProcessorVersion.startsWith(`${MEMORY_CONSOLIDATION_VERSION}:`),
    ).toBe(false);
    f.change({ ...f.original, modelId: "fixture-b" });
    await expect(
      f.model.bind(
        { expectedProcessorVersion, assertInputCurrent: () => undefined },
        new AbortController().signal,
      ),
    ).rejects.toThrow("configuration changed");
    expect(f.runtime).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it.each(["profile", "model", "protocol"])(
    "rejects a mismatched actual %s before generation",
    async (change) => {
      const f = fixture();
      const expectedProcessorVersion = f.model.version;
      const snapshot = { ...f.original };
      if (change === "profile") snapshot.profileId = randomUUID();
      if (change === "model") snapshot.modelId = "fixture-b";
      if (change === "protocol") snapshot.apiStyle = "azure-openai";
      f.runtime.mockResolvedValueOnce({ provider: f.provider, snapshot });
      await expect(
        f.model.bind(
          { expectedProcessorVersion, assertInputCurrent: () => undefined },
          new AbortController().signal,
        ),
      ).rejects.toThrow("expected processor");
      expect(f.requests).toEqual([]);
    },
  );

  it("keeps the already bound runtime when the default changes during asynchronous preparation", async () => {
    const f = fixture();
    const expectedProcessorVersion = f.model.version;
    let release!: (value: ChatModelRuntime) => void;
    f.runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const execution = {
      expectedProcessorVersion,
      assertInputCurrent: () => undefined,
    };
    const pending = f.model.bind(execution, controller.signal);
    expect(f.runtime).toHaveBeenCalledWith(
      f.original.profileId,
      f.original.modelId,
    );
    f.change({ ...f.original, profileId: randomUUID(), modelId: "fixture-b" });
    release({ provider: f.provider, snapshot: f.original });
    const bound = await pending;
    const measured = await bound.measureInput(
      f.input,
      execution,
      controller.signal,
    );
    expect(measured.budget).toBeLessThanOrEqual(32000);
    await expect(
      bound.consolidate(f.input, execution, controller.signal),
    ).resolves.toEqual(f.output);
    expect(f.measurements).toEqual(f.requests);
    expect(f.measurements[0]!.structuredOutput?.name).toBe(
      "memory_consolidation",
    );
    expect(f.measurements[0]!.instructions).toContain("Every dependency");
    expect(f.resolveContextLimits).toHaveBeenCalledOnce();
    expect(f.runtime).toHaveBeenCalledOnce();
    expect(f.requests.map(({ modelId }) => modelId)).toEqual(["fixture-a"]);
    expect(f.onUsage).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        String((f.requests[0]!.input[0] as { content: string }).content),
      ),
    ).toEqual(f.input);
  });

  it("cancels after runtime preparation without starting a model call", async () => {
    const f = fixture();
    const controller = new AbortController();
    let release!: (value: ChatModelRuntime) => void;
    f.runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.model.bind(
      {
        expectedProcessorVersion: f.model.version,
        assertInputCurrent: () => undefined,
      },
      controller.signal,
    );
    controller.abort();
    release({ provider: f.provider, snapshot: f.original });
    await expect(pending).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
  it.each(["metadata", "count"] as const)(
    "checks input on rejected %s and forwards the original cause",
    async (stage) => {
      const f = fixture();
      const failure = new Error(`${stage} rejected`);
      const changed = new Error("already valid input changed");
      let invalid = false;
      const causes: unknown[] = [];
      const execution = {
        expectedProcessorVersion: f.model.version,
        assertInputCurrent: (cause?: unknown) => {
          causes.push(cause);
          if (invalid) throw changed;
        },
      };
      const signal = new AbortController().signal;
      const rejectAfterChange = () => {
        invalid = true;
        return Promise.reject(failure);
      };
      if (stage === "metadata") {
        f.provider.resolveContextLimits = rejectAfterChange;
        await expect(f.model.bind(execution, signal)).rejects.toBe(changed);
      } else {
        const bound = await f.model.bind(execution, signal);
        f.provider.measureInput = rejectAfterChange;
        await expect(
          bound.measureInput(f.input, execution, signal),
        ).rejects.toBe(changed);
      }
      expect(causes.at(-1)).toBe(failure);
      expect(f.requests).toEqual([]);
      expect(f.onUsage).not.toHaveBeenCalled();
    },
  );

  it("preserves completed generation usage when an owned cancellation discards the late result", async () => {
    const f = fixture();
    const controller = new AbortController();
    const execution = {
      expectedProcessorVersion: f.model.version,
      assertInputCurrent: () => undefined,
    };
    const bound = await f.model.bind(execution, controller.signal);
    const reason = new Error("stop before completed response is consumed");
    f.provider.stream = () =>
      (async function* (): AsyncGenerator<ModelEvent> {
        yield await Promise.resolve<ModelEvent>({
          type: "text.delta",
          delta: JSON.stringify(f.output),
        });
        controller.abort(reason);
        yield {
          type: "response.completed",
          responseId: "late-response",
          status: "completed",
          usage: { inputTokens: 90, outputTokens: 8 },
        };
      })();
    await expect(
      bound.consolidate(f.input, execution, controller.signal),
    ).rejects.toBe(reason);
    expect(f.onUsage).toHaveBeenCalledWith({
      inputTokens: 90,
      outputTokens: 8,
    });
    expect(f.onUsage).toHaveBeenCalledOnce();
  });
});
