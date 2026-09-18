import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  formationIntake,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import { ToolRegistry, type ToolExecutionContext } from "../tools/toolRegistry";
import type { EvidencePack } from "../../shared/contracts/memoryRecall";
import type { MemoryService } from "./memoryService";
import { registerMemoryFormationTool, registerMemoryTool } from "./memoryTool";

function context() {
  const measureResult = vi.fn<
    NonNullable<ToolExecutionContext["measureResult"]>
  >(() =>
    Promise.resolve({
      kind: "responses_request",
      inputBudgetTokens: 4200,
      measurement: {
        exactInputTokens: 1000,
        estimatedTokens: 99999,
        wireBytes: 100,
        unknownKinds: [],
      },
    }),
  );
  return {
    measureResult,
    itemId: randomUUID(),
    runId: randomUUID(),
    signal: new AbortController().signal,
    onDelta: () => undefined,
  };
}

describe("Structured memory tools", () => {
  it("reports changed historical receipts without promising a deleted memory was restored", async () => {
    const registry = new ToolRegistry();
    const unavailableChanges = [
      {
        memoryId: randomUUID(),
        revisionId: randomUUID(),
        operation: "created" as const,
      },
    ];
    const formEpisode = vi.fn(() =>
      Promise.resolve({
        changes: [],
        unavailableChanges,
        replayed: true as const,
      }),
    );
    registerMemoryFormationTool(
      registry,
      {
        formEpisode,
        enqueueEpisode: () => ({ workId: "persisted-work" }),
        retryFailedFormationWork: vi.fn(),
      } as unknown as MemoryService,
      () =>
        formationIntake({
          id: randomUUID(),
          version: "v1",
          recordedAt: "2026-09-15T00:00:00.000Z",
          sources: [
            {
              id: randomUUID(),
              referenceId: randomUUID(),
              type: "chat",
              speaker: "user",
              content: "合成测试来源",
              occurredAt: "2026-09-15T00:00:00.000Z",
            },
          ],
        }),
    );
    const result = await registry.execute("memory.record", {}, context());
    expect(result.modelContent).toMatchObject({
      changes: [],
      unavailableChanges,
      replayed: true,
      storage: "prior_result_changed",
    });
    expect(result.summary).toBe(
      "此前形成的记忆已被修改、归档或删除，未重新写入",
    );
  });

  it("accepts local question IDs and host-owned budget while rejecting model budget controls", async () => {
    const registry = new ToolRegistry();
    const recall = vi.fn<MemoryService["recall"]>(() =>
      Promise.resolve({
        items: [],
        coverage: [],
        gaps: [],
        estimatedTokens: 0,
        truncated: false,
        incompleteReasons: [],
      }),
    );
    registerMemoryTool(
      registry,
      { recall } as unknown as MemoryService,
      () => ({}),
    );
    const ctx = context();
    await registry.execute(
      "memory.search",
      {
        query: "旅行变化",
        questions: [
          { id: "q1", text: "之前去哪里" },
          { id: "q2", text: "后来为什么改期" },
        ],
        entityNames: ["小林"],
        timeScope: { includeSuperseded: true },
      },
      ctx,
    );
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        contextBudget: { maxTokens: 3200 },
        questions: [
          { id: "q1", text: "之前去哪里" },
          { id: "q2", text: "后来为什么改期" },
        ],
      }),
      ctx.signal,
      "tool",
      expect.objectContaining({
        candidateBudgetTokens: 32_000,
        fits: expect.any(Function) as unknown,
      }),
    );
    expect(() =>
      registry.validateInput("memory.search", {
        query: "旅行",
        contextBudget: { maxTokens: 258000 },
      }),
    ).toThrow("additional properties");
    await registry.execute("memory.search", { query: "进一步核对原因" }, ctx);
    expect(recall).toHaveBeenCalledTimes(2);
    const references = [
      { memoryId: randomUUID(), revisionId: randomUUID(), use: "current" },
    ];
    await registry.execute(
      "memory.search",
      {
        query: "",
        questions: [{ id: "known", text: "What does this record establish?" }],
        references,
      },
      ctx,
    );
    expect(recall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: "",
        references,
        contextBudget: { maxTokens: 3200 },
      }),
      ctx.signal,
      "tool",
      expect.objectContaining({
        candidateBudgetTokens: 32_000,
        fits: expect.any(Function) as unknown,
      }),
    );
    expect(() =>
      registry.validateInput("memory.search", { query: " " }),
    ).toThrow();
    expect(() =>
      registry.validateInput("memory.search", {
        query: "",
        references,
        questions: [],
      }),
    ).toThrow();
  });

  it("requires a current measurement owner instead of silently using a fixed allowance", async () => {
    const registry = new ToolRegistry();
    const recall = vi.fn<MemoryService["recall"]>();
    registerMemoryTool(
      registry,
      { recall } as unknown as MemoryService,
      () => ({}),
    );
    const ctx = context();
    const withoutOwner: ToolExecutionContext = {
      itemId: ctx.itemId,
      runId: ctx.runId,
      signal: ctx.signal,
      onDelta: ctx.onDelta,
    };
    await expect(
      registry.execute("memory.search", { query: "茶" }, withoutOwner),
    ).rejects.toThrow("measurement owner");
    expect(recall).not.toHaveBeenCalled();
  });

  it("returns the measured unsearched receipt at exact zero space without starting recall", async () => {
    const registry = new ToolRegistry();
    const recall = vi.fn<MemoryService["recall"]>();
    registerMemoryTool(
      registry,
      { recall } as unknown as MemoryService,
      () => ({}),
    );
    const ctx = context();
    ctx.measureResult.mockResolvedValue({
      kind: "responses_request",
      inputBudgetTokens: 1000,
      measurement: {
        exactInputTokens: 1000,
        estimatedTokens: 99999,
        wireBytes: 100,
        unknownKinds: [],
      },
    });
    const result = await registry.execute(
      "memory.search",
      { query: "茶" },
      ctx,
    );
    expect(result).toEqual(ctx.measureResult.mock.calls[0]?.[0]);
    expect(result.modelContent).toMatchObject({
      items: [],
      truncated: true,
      coverage: [
        { questionId: "memory-query", status: "missing", revisionIds: [] },
      ],
    });
    expect(JSON.stringify(result.modelContent)).toContain("本次未执行检索");
    expect(JSON.stringify(result.modelContent)).toContain(
      "不能据此判断记忆不存在",
    );
    expect(result.summary).not.toContain("没有足够");
    expect(recall).not.toHaveBeenCalled();
  });

  it.each(["over_limit", "unsupported_unknown"] as const)(
    "does not start retrieval when even its honest empty receipt cannot fit: %s",
    async (condition) => {
      const registry = new ToolRegistry();
      const recall = vi.fn<MemoryService["recall"]>();
      registerMemoryTool(
        registry,
        { recall } as unknown as MemoryService,
        () => ({}),
      );
      const ctx = context();
      ctx.measureResult.mockResolvedValue({
        kind: "responses_request",
        inputBudgetTokens: 1000,
        measurement: {
          estimatedTokens: 1,
          wireBytes: 1,
          ...(condition === "over_limit" ? { exactInputTokens: 1001 } : {}),
          unknownKinds:
            condition === "unsupported_unknown" ? ["input_file"] : [],
        },
      });
      await expect(
        registry.execute("memory.search", { query: "茶" }, ctx),
      ).rejects.toThrow("缺口说明");
      expect(recall).not.toHaveBeenCalled();
    },
  );

  it("measures exactly the same complete normalized result that is returned", async () => {
    const registry = new ToolRegistry();
    const pack: EvidencePack = {
      items: [],
      coverage: [{ questionId: "q1", status: "missing", revisionIds: [] }],
      gaps: [{ questionId: "q1", reason: "已检索但未能供给" }],
      estimatedTokens: 0,
      truncated: true,
      incompleteReasons: ["尚未形成"],
    };
    const recall = vi.fn<MemoryService["recall"]>(
      async (_plan, _signal, _consumer, allocation) => {
        if (!allocation) throw new Error("Missing output allocation");
        expect(await allocation.fits(pack)).toBe(true);
        return pack;
      },
    );
    registerMemoryTool(
      registry,
      { recall } as unknown as MemoryService,
      () => ({}),
    );
    const ctx = context();
    const result = await registry.execute(
      "memory.search",
      { query: "茶", questions: [{ id: "q1", text: "茶" }] },
      ctx,
    );
    expect(ctx.measureResult).toHaveBeenCalledTimes(2);
    expect(ctx.measureResult.mock.calls[1]?.[0]).toEqual(result);
    expect(result).toMatchObject({
      artifacts: [],
      modelContent: pack,
      retryable: false,
      status: "success",
    });
  });

  it("propagates measurement errors and an owner cancelled during measurement without recall", async () => {
    const registry = new ToolRegistry();
    const recall = vi.fn<MemoryService["recall"]>();
    registerMemoryTool(
      registry,
      { recall } as unknown as MemoryService,
      () => ({}),
    );
    const ctx = context();
    const failure = new Error("actual count request failed");
    ctx.measureResult.mockRejectedValueOnce(failure);
    await expect(
      registry.execute("memory.search", { query: "茶" }, ctx),
    ).rejects.toBe(failure);
    const abort = new AbortController();
    ctx.measureResult.mockImplementation(async () => {
      await Promise.resolve();
      abort.abort();
      return {
        kind: "responses_request",
        inputBudgetTokens: 4200,
        measurement: {
          exactInputTokens: 1000,
          estimatedTokens: 1000,
          wireBytes: 100,
          unknownKinds: [],
        },
      };
    });
    await expect(
      registry.execute(
        "memory.search",
        { query: "茶" },
        { ...ctx, signal: abort.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(recall).not.toHaveBeenCalled();
  });

  it("forms from host source episodes instead of accepting model-authored facts or source IDs", async () => {
    const registry = new ToolRegistry();
    const ctx = context();
    const episode: FormationFixture = {
      id: randomUUID(),
      version: "v1",
      recordedAt: "2026-09-15T00:00:00.000Z",
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: "我喜欢茶",
          occurredAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    };
    const result = {
      changes: [
        {
          memoryId: randomUUID(),
          revisionId: randomUUID(),
          operation: "created" as const,
        },
      ],
      processorVersion: "processor-v2:fixture",
      processorTransitions: [
        {
          fromProcessorVersion: "processor-v1:fixture",
          toProcessorVersion: "processor-v2:fixture",
          atCursor: { ordinal: 1, start: 0 },
          priorAttempt: 1,
          priorErrorCode: "formation_failed",
          recordedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      retrievalIncompleteReasons: ["部分记忆的语义索引尚未完成"],
    };
    const formEpisode = vi.fn(() => Promise.resolve(result));
    const resolver = vi.fn(() => formationIntake(episode));
    registerMemoryFormationTool(
      registry,
      {
        formEpisode,
        enqueueEpisode: () => ({ workId: "persisted-work" }),
        retryFailedFormationWork: vi.fn(),
      } as unknown as MemoryService,
      resolver,
    );
    const output = await registry.execute("memory.record", {}, ctx);
    expect(output.modelContent).toMatchObject({
      ...result,
      storage: "source_and_revision_committed",
      indexing: "asynchronous",
    });
    expect(resolver).toHaveBeenCalledWith(ctx.runId, ctx.itemId);
    expect(formEpisode).toHaveBeenCalledWith("persisted-work", ctx.signal);
    expect(() =>
      registry.validateInput("memory.record", {
        content: "模型自行添加的喜好",
      }),
    ).toThrow("additional properties");
  });
});
