import { estimateInputBudget } from "../providers/inputBudget";
import { modelTimeContext } from "../agent/modelTimeContext";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import type { ChatModelRuntime } from "../providers/providerService";
import type { MemoryFormationInput } from "../memory/memoryModels";
import { createMemoryFormationRuntime } from "./memoryFormationRuntime";

function fixture() {
  const original: ProviderSnapshot = {
    profileId: randomUUID(),
    profileName: "Offline fixture",
    apiStyle: "openai-compatible",
    modelId: "fixture-a",
  };
  let current = original;
  const requests: ModelRequest[] = [];
  const resolveContextLimits = vi.fn(() =>
    Promise.resolve({ maxContextTokens: 32000 }),
  );
  const provider: ModelProvider = {
    measureInput(request: ModelRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      return Promise.resolve(this.estimateInput(request));
    },
    estimateInput: (request: ModelRequest) =>
      estimateInputBudget(request, request.modelId),
    resolveContextLimits,
    stream(request) {
      requests.push(request);
      return (async function* (): AsyncGenerator<ModelEvent> {
        await Promise.resolve();
        yield { type: "text.delta", delta: '{"entities":[],"units":[]}' };
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
  const sourceId = randomUUID();
  const model = createMemoryFormationRuntime(
    {
      getDefaultChatProfileId: () => current.profileId,
      createSnapshot: () => ({ ...current }),
      createChatModelRuntime: runtime,
    },
    onUsage,
    () => modelTimeContext("2026-09-15T00:00:00.000Z", "Asia/Shanghai"),
  );
  return {
    model,
    original,
    provider,
    resolveContextLimits,
    requests,
    runtime,
    onUsage,
    change: (snapshot: ProviderSnapshot) => {
      current = snapshot;
    },
    input: {
      episode: {
        id: randomUUID(),
        version: "fixture-v1",
        recordedAt: "2026-09-15T12:00:00.000Z",
        sources: [
          {
            id: sourceId,
            type: "chat",
            referenceId: randomUUID(),
            speaker: "user",
            occurredAt: "2026-09-15T12:00:00.000Z",
            content: "我给这只陶杯起名叫阿圆。",
          },
        ],
        evidenceSourceIds: [sourceId],
      },
      existing: [],
      entities: [],
    } satisfies MemoryFormationInput,
  };
}

describe("Memory actual formation runtime binding", () => {
  it("rejects an obsolete processor before creating a runtime", async () => {
    const f = fixture();
    const expectedProcessorVersion = f.model.version;
    f.change({ ...f.original, modelId: "fixture-b" });
    await expect(
      f.model.bind(
        { expectedProcessorVersion, assertInputCurrent: vi.fn() },
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
          { expectedProcessorVersion, assertInputCurrent: vi.fn() },
          new AbortController().signal,
        ),
      ).rejects.toThrow("expected processor");
      expect(f.requests).toEqual([]);
    },
  );

  it("keeps the bound runtime when the default changes during asynchronous preparation", async () => {
    const f = fixture();
    const expectedProcessorVersion = f.model.version;
    let release: (value: ChatModelRuntime) => void = () => undefined;
    f.runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const signal = new AbortController().signal;
    const pending = f.model.bind(
      { expectedProcessorVersion, assertInputCurrent: vi.fn() },
      signal,
    );
    expect(f.runtime).toHaveBeenCalledWith(
      f.original.profileId,
      f.original.modelId,
    );
    f.change({ ...f.original, profileId: randomUUID(), modelId: "fixture-b" });
    release({ provider: f.provider, snapshot: f.original });
    const bound = await pending;
    expect(bound.version).toBe(expectedProcessorVersion);
    const prepared = bound.prepare(f.input);
    expect((await prepared.measureInput(signal)).budget).toBe(32000);
    await expect(prepared.form(signal)).resolves.toEqual({
      entities: [],
      units: [],
    });
    expect(f.runtime).toHaveBeenCalledOnce();
    expect(f.resolveContextLimits).toHaveBeenCalledExactlyOnceWith(
      "fixture-a",
      signal,
    );
    expect(f.requests.map(({ modelId }) => modelId)).toEqual(["fixture-a"]);
    expect(f.onUsage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.requests[0]!.input)).toContain(
      "2026-09-15T08:00:00.000",
    );
  });

  it("cancels after runtime preparation without starting the model", async () => {
    const f = fixture();
    const controller = new AbortController();
    let release: (value: ChatModelRuntime) => void = () => undefined;
    f.runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.model.bind(
      {
        expectedProcessorVersion: f.model.version,
        assertInputCurrent: vi.fn(),
      },
      controller.signal,
    );
    controller.abort();
    release({ provider: f.provider, snapshot: f.original });
    await expect(pending).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(f.resolveContextLimits).not.toHaveBeenCalled();
  });

  it("joins cancelled metadata preparation without returning a bound model", async () => {
    const f = fixture();
    const controller = new AbortController();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(f.provider, "resolveContextLimits").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ maxContextTokens: 32000 });
          entered();
        }),
    );
    const pending = f.model.bind(
      {
        expectedProcessorVersion: f.model.version,
        assertInputCurrent: vi.fn(),
      },
      controller.signal,
    );
    await started;
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.requests).toEqual([]);
    expect(f.onUsage).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "revalidates input after measurement %s and preserves the rejection cause",
    async (settlement) => {
      const f = fixture();
      const signal = new AbortController().signal;
      const inputChanged = new Error("The supplied input changed");
      const providerFailure = new Error("Count service unavailable");
      let changed = false;
      const assertInputCurrent = vi.fn((cause?: unknown) => {
        void cause;
        if (changed) throw inputChanged;
      });
      const bound = await f.model.bind(
        { expectedProcessorVersion: f.model.version, assertInputCurrent },
        signal,
      );
      const prepared = bound.prepare(f.input);
      const measurement = prepared.estimateInput().measurement;
      let release: () => void = () => undefined;
      vi.spyOn(f.provider, "measureInput").mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            release = () => {
              if (settlement === "resolve") resolve(measurement);
              else reject(providerFailure);
            };
          }),
      );
      const pending = prepared.measureInput(signal);
      changed = true;
      release();
      await expect(pending).rejects.toBe(inputChanged);
      if (settlement === "reject")
        expect(assertInputCurrent).toHaveBeenLastCalledWith(providerFailure);
      expect(f.requests).toEqual([]);
      expect(f.onUsage).not.toHaveBeenCalled();
    },
  );

  it("requires the same execution signal for measurement and generation", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const bound = await f.model.bind(
      {
        expectedProcessorVersion: f.model.version,
        assertInputCurrent: vi.fn(),
      },
      signal,
    );
    const prepared = bound.prepare(f.input);
    const measure = vi.spyOn(f.provider, "measureInput");
    const otherSignal = new AbortController().signal;
    expect(() => prepared.measureInput(otherSignal)).toThrow(
      "bound execution signal",
    );
    expect(() => prepared.form(otherSignal)).toThrow("bound execution signal");
    expect(measure).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
});
