import { describe, expect, it } from "vitest";
import {
  ContextCompiler,
  estimatedInputTokens,
  type ContextCheckpoint,
  type ContextInputMeasurement,
} from "./contextCompiler";
import type { ModelUsage } from "./modelProvider";

const checkpoint: ContextCheckpoint = {
  items: [{ type: "message", role: "user", content: "当前完整请求" }],
  recentUsers: ["当前完整请求"],
  lastUsage: { inputTokens: 900_000, cachedInputTokens: 0, outputTokens: 10 },
  lastRequestBytes: 1,
};

describe("Exact context measurement", () => {
  it.each([
    { label: "missing all fields", usage: {} },
    { label: "only output reported", usage: { outputTokens: 900_000 } },
    {
      label: "only cached input reported",
      usage: { cachedInputTokens: 900_000 },
    },
    { label: "reported zero input", usage: { inputTokens: 0 } },
  ] satisfies readonly { label: string; usage: ModelUsage }[])(
    "keeps the full-input budget independent of previous usage: $label",
    async ({ usage }) => {
      const calls: Parameters<ContextInputMeasurement>[] = [];
      const compiler = new ContextCompiler();
      const previous = { ...checkpoint, lastUsage: usage };
      const measurement = {
        estimatedTokens: 100,
        wireBytes: 100,
        unknownKinds: [],
      };
      expect(
        await compiler.shouldCompact(
          previous,
          { maxPromptTokens: 30_000 },
          (input, options) => {
            calls.push([input, options]);
            return Promise.resolve(measurement);
          },
        ),
      ).toBe(false);
      expect(calls).toEqual([[checkpoint.items, undefined]]);

      calls.length = 0;
      expect(
        await compiler.shouldCompact(
          previous,
          { maxPromptTokens: 30_000 },
          (input, options) => {
            calls.push([input, options]);
            return Promise.resolve({
              ...measurement,
              estimatedTokens: 30_001,
              ...(options?.requireExact ? { exactInputTokens: 30_001 } : {}),
            });
          },
        ),
      ).toBe(true);
      expect(calls).toEqual([
        [checkpoint.items, undefined],
        [checkpoint.items, { requireExact: true }],
      ]);
      expect(previous.lastUsage).toEqual(usage);
    },
  );

  it("asks the same full input for an exact decision only when historic usage would compact it", async () => {
    const calls: Parameters<ContextInputMeasurement>[] = [];
    const measure: ContextInputMeasurement = (input, options) => {
      calls.push([input, options]);
      return Promise.resolve({
        estimatedTokens: 100,
        wireBytes: 100,
        unknownKinds: [],
        ...(options?.requireExact ? { exactInputTokens: 100 } : {}),
      });
    };
    expect(
      await new ContextCompiler().shouldCompact(
        checkpoint,
        { maxPromptTokens: 30_000 },
        measure,
      ),
    ).toBe(false);
    expect(calls).toEqual([
      [checkpoint.items, undefined],
      [checkpoint.items, { requireExact: true }],
    ]);
    calls.length = 0;
    expect(
      await new ContextCompiler().shouldCompact(
        { items: checkpoint.items, recentUsers: [] },
        { maxPromptTokens: 30_000 },
        measure,
      ),
    ).toBe(false);
    expect(calls).toEqual([[checkpoint.items, undefined]]);
  });

  it("propagates exact measurement failures instead of compacting from the old estimate", async () => {
    const error = new Error("Counter unavailable");
    const measure: ContextInputMeasurement = (_input, options) =>
      options?.requireExact
        ? Promise.reject(error)
        : Promise.resolve({
            estimatedTokens: 100,
            wireBytes: 100,
            unknownKinds: [],
          });
    await expect(
      new ContextCompiler().shouldCompact(
        checkpoint,
        { maxPromptTokens: 30_000 },
        measure,
      ),
    ).rejects.toBe(error);
  });
  it("does not compact a fitting exact request because of old usage or 0.9 headroom", async () => {
    const value = {
      estimatedTokens: 100_000,
      wireBytes: 90_000,
      unknownKinds: [],
      exactInputTokens: 30_000,
    };
    expect(
      estimatedInputTokens(value, { inputTokens: 900_000, requestBytes: 1 }),
    ).toBe(30_000);
    expect(
      await new ContextCompiler().shouldCompact(
        checkpoint,
        { maxPromptTokens: 30_000 },
        () => Promise.resolve(value),
      ),
    ).toBe(false);
    expect(
      await new ContextCompiler().shouldCompact(
        checkpoint,
        { maxPromptTokens: 30_000 },
        () => Promise.resolve({ ...value, exactInputTokens: 30_001 }),
      ),
    ).toBe(true);
  });

  it("keeps conservative usage projections when no exact count is available", async () => {
    expect(
      await new ContextCompiler().shouldCompact(
        checkpoint,
        { maxPromptTokens: 30_000 },
        () =>
          Promise.resolve({
            estimatedTokens: 100,
            wireBytes: 100,
            unknownKinds: [],
          }),
      ),
    ).toBe(true);
  });
});
