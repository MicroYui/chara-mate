import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatContextService } from "../../src/main/agent/chatContextService";
import type { JsonValue } from "../../src/shared/contracts/primitives";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../../src/main/agent/modelProvider";
import { RunRepository } from "../../src/main/agent/runRepository";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import {
  estimateInputBudget,
  fitsInputBudget,
} from "../../src/main/providers/inputBudget";
import { chatFixture, runFixture } from "../fixtures/foundationContracts";
import { FakeClock } from "../fixtures/fakeClock";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(
  runCount: number,
  messageLength: number,
  summary = "已记录目标与完成事项。",
) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "charamate-context-budget-"),
  );
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanups.push(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  chats.insertChat(chatFixture);
  const clock = new FakeClock("2026-09-15T00:00:00.000Z");
  for (let index = 0; index < runCount; index += 1) {
    const run = {
      ...runFixture,
      id: randomUUID(),
      createdAt: clock.now(),
      startedAt: clock.now(),
    };
    runs.appendEvent({
      event: { type: "run.started", run },
      occurredAt: clock.now(),
      sequence: 1,
      streamId: run.id,
    });
    for (const role of ["user", "assistant"] as const) {
      clock.advance(1_000);
      chats.insertMessage({
        id: randomUUID(),
        chatId: chatFixture.id,
        runId: run.id,
        role,
        status: "completed",
        content: `${role}-${index}: ${"x".repeat(messageLength)}`,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
    }
    runs.appendEvent({
      event: {
        type: "run.completed",
        run: {
          ...run,
          endedAt: clock.now(),
          latestSequence: 2,
          status: "completed",
        },
      },
      occurredAt: clock.now(),
      sequence: 2,
      streamId: run.id,
    });
  }
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    measureInput(request: ModelRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      return Promise.resolve(this.estimateInput(request));
    },
    estimateInput: (request: ModelRequest) =>
      estimateInputBudget(request, request.modelId),
    resolveContextLimits: () => Promise.resolve({ maxPromptTokens: 20_000 }),
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield await Promise.resolve<ModelEvent>({
        type: "text.delta",
        delta: summary,
      });
      yield {
        type: "response.completed",
        responseId: randomUUID(),
        status: "completed",
        usage: { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 100 },
      };
    },
  };
  const service = new ChatContextService(chats, clock, runs);
  const request = {
    chatId: chatFixture.id,
    limits: { maxPromptTokens: 20_000 },
    modelId: "gpt-6-astra",
    provider,
    signal: new AbortController().signal,
  };
  return {
    chats,
    requests,
    service,
    request,
    database,
    runs,
    clock,
    directory,
  };
}

describe("Chat input budget and summary batching", () => {
  it("requests exact adjudication when old usage alone would reject a short current request", async () => {
    const f = fixture(0, 0);
    f.chats.recordContextUsage({
      chatId: chatFixture.id,
      inputTokens: 900_000,
      requestBytes: 1,
      modelId: "gpt-6-astra",
      updatedAt: "2026-09-15T00:00:00.000Z",
    });
    const calls: { readonly request: ModelRequest; readonly exact: boolean }[] =
      [];
    f.request.provider.measureInput = (request, signal, options) => {
      signal.throwIfAborted();
      calls.push({ request, exact: options?.requireExact === true });
      return Promise.resolve({
        ...f.request.provider.estimateInput(request),
        ...(options?.requireExact ? { exactInputTokens: 100 } : {}),
      });
    };
    const result = await f.service.prepare({
      ...f.request,
      additionalInput: [
        { type: "message", role: "user", content: "现在接着说。" },
      ],
    });
    expect(result.compacted).toBe(false);
    expect(calls.map((call) => call.exact)).toEqual([false, true]);
    expect(calls[0]!.request).toEqual(calls[1]!.request);
    expect(f.requests).toHaveLength(0);
  });

  it("accepts exact fitting current input despite an oversized estimate and old usage", async () => {
    const f = fixture(0, 0);
    f.chats.recordContextUsage({
      chatId: chatFixture.id,
      inputTokens: 900_000,
      requestBytes: 1,
      modelId: "gpt-6-astra",
      updatedAt: "2026-09-15T00:00:00.000Z",
    });
    f.request.provider.measureInput = (request, signal) => {
      signal.throwIfAborted();
      return Promise.resolve({
        ...f.request.provider.estimateInput(request),
        exactInputTokens: 20_000,
      });
    };
    const result = await f.service.prepare({
      ...f.request,
      additionalInput: [
        { type: "message", role: "user", content: "A".repeat(40_000) },
      ],
    });
    expect(result.compacted).toBe(false);
    expect(f.requests).toHaveLength(0);
  });

  it("keeps explicit conservative replay measurement separate from exact text summary measurement", async () => {
    const f = fixture(0, 0);
    let textMeasurements = 0;
    f.request.provider.measureInput = (request, signal) => {
      signal.throwIfAborted();
      textMeasurements += 1;
      return Promise.resolve({
        ...f.request.provider.estimateInput(request),
        exactInputTokens: 100,
      });
    };
    await expect(
      f.service.prepare({
        ...f.request,
        additionalInput: [
          { type: "message", role: "user", content: "A".repeat(40_000) },
        ],
        measureInput: (input) => Promise.resolve(estimateInputBudget(input)),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    expect(textMeasurements).toBe(0);
    expect(f.requests).toHaveLength(0);
  });

  it("retains an already committed summary batch when a later summary is too large", async () => {
    const f = fixture(3, 5_000);
    const provider = f.request.provider;
    const stream = provider.stream.bind(provider);
    let batch = 0;
    provider.stream = async function* (request, signal) {
      batch += 1;
      for await (const event of stream(request, signal)) {
        yield event.type === "text.delta" && batch === 2
          ? { ...event, delta: "x".repeat(30_000) }
          : event;
      }
    };
    const messages = f.chats.listMessages(chatFixture.id);
    await expect(
      f.service.prepare({ ...f.request, force: true }),
    ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    expect(f.requests).toHaveLength(2);
    expect(f.chats.getContextSnapshot(chatFixture.id)).toMatchObject({
      generation: 1,
      coveredThroughMessageId: messages[1]!.id,
    });
    expect(f.chats.listMessages(chatFixture.id)).toEqual(messages);
  });

  it("does not commit a summary whose completed exact measurement exceeds the input allowance", async () => {
    const summary = "This returned summary exceeds its actual token allowance.";
    const f = fixture(1, 100, summary);
    f.request.provider.measureInput = (request, signal) => {
      signal.throwIfAborted();
      return Promise.resolve({
        ...f.request.provider.estimateInput(request),
        exactInputTokens: JSON.stringify(request.input).includes(summary)
          ? 20_001
          : 100,
      });
    };
    await expect(
      f.service.prepare({ ...f.request, force: true }),
    ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    expect(f.requests).toHaveLength(1);
    expect(f.chats.getContextSnapshot(chatFixture.id)).toBeUndefined();
    expect(f.chats.listMessages(chatFixture.id)).toHaveLength(2);
  });

  it("compacts a large first history without previous usage and preserves UI history", async () => {
    const f = fixture(5, 3_000);
    expect(f.chats.getContextSnapshot(chatFixture.id)).toBeUndefined();
    const result = await f.service.prepare(f.request);
    expect(result.compacted).toBe(true);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.chats.listMessages(chatFixture.id)).toHaveLength(10);
    expect(fitsInputBudget(estimateInputBudget(result.input), 20_000)).toBe(
      true,
    );
    for (const request of f.requests) {
      expect(fitsInputBudget(estimateInputBudget(request), 20_000)).toBe(true);
      const text = JSON.stringify(request.input);
      for (let index = 0; index < 5; index += 1) {
        expect(text.includes(`user-${index}:`)).toBe(
          text.includes(`assistant-${index}:`),
        );
      }
    }
  });

  it("splits forced summarization at completed Run boundaries", async () => {
    const f = fixture(3, 5_000);
    const result = await f.service.prepare({ ...f.request, force: true });
    expect(f.requests).toHaveLength(3);
    expect(result.messages).toEqual([]);
    expect(result.snapshot?.generation).toBe(3);
    for (const [index, request] of f.requests.entries()) {
      const text = JSON.stringify(request.input);
      expect(text).toContain(`user-${index}:`);
      expect(text).toContain(`assistant-${index}:`);
      expect(fitsInputBudget(estimateInputBudget(request), 20_000)).toBe(true);
    }
  });

  it("rejects one oversized Run before summarization and keeps all source messages", async () => {
    const f = fixture(1, 150_000);
    await expect(f.service.prepare(f.request)).rejects.toMatchObject({
      code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(f.requests).toHaveLength(0);
    expect(f.chats.getContextSnapshot(chatFixture.id)).toBeUndefined();
    expect(f.chats.listMessages(chatFixture.id)).toHaveLength(2);
  });

  it("does not persist an oversized generated summary or retry it forever", async () => {
    const f = fixture(1, 100, "x".repeat(30_000));
    await expect(
      f.service.prepare({ ...f.request, force: true }),
    ).rejects.toMatchObject({
      code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(f.requests).toHaveLength(1);
    expect(f.chats.getContextSnapshot(chatFixture.id)).toBeUndefined();
  });

  it("rejects oversized new input with no history to compact", async () => {
    const f = fixture(0, 0);
    await expect(
      f.service.prepare({
        ...f.request,
        additionalInput: [{ role: "user", content: "汉".repeat(90_000) }],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(f.requests).toHaveLength(0);
  });
});

describe("Chat replay phase ownership", () => {
  it("commits the Chat projection and original Item messages together, rolls both back, and reopens without inferred phases", () => {
    const f = fixture(0, 0);
    const run = {
      ...runFixture,
      id: randomUUID(),
      createdAt: f.clock.now(),
      startedAt: f.clock.now(),
    };
    const publications: string[] = [];
    const events = new RunEventService(f.runs, {
      publish: (envelope) => {
        if (envelope.event.type !== "item.completed") return;
        expect(f.database.inTransaction).toBe(false);
        expect(f.chats.getMessage(message.id)?.status).toBe("completed");
        expect(f.runs.getAssistantMessages(run.id, message.id)).toEqual(
          original,
        );
        publications.push(envelope.event.item.id);
      },
    });
    const writer = new RunEventWriter(
      f.runs,
      events,
      new CryptoIdGenerator(),
      f.clock,
    );
    writer.startRun(run);
    const message = f.chats.insertMessage({
      id: randomUUID(),
      chatId: chatFixture.id,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      content: "显示正文",
      createdAt: f.clock.now(),
      updatedAt: f.clock.now(),
    });
    const original: JsonValue[] = [
      {
        type: "message",
        role: "assistant",
        id: "original",
        phase: "commentary",
        content: [{ type: "output_text", text: "原文", annotations: [] }],
      },
      {
        type: "message",
        role: "assistant",
        id: "null",
        phase: null,
        content: [{ type: "output_text", text: "空标记", annotations: [] }],
      },
      {
        type: "message",
        role: "assistant",
        id: "missing",
        content: [{ type: "output_text", text: "无标记", annotations: [] }],
      },
    ];
    const item = writer.startItem(run.id, "assistant_message");
    const patch = {
      status: "completed" as const,
      output: { messageId: message.id, assistantMessages: original },
    };
    expect(() =>
      writer.completeItem(item.id, patch, () => {
        f.chats.updateMessage({ ...message, status: "completed" });
        throw new Error("projection commit failed");
      }),
    ).toThrow("projection commit failed");
    expect(f.runs.getRunItem(item.id)?.status).toBe("running");
    expect(f.chats.getMessage(message.id)?.status).toBe("streaming");
    expect(f.runs.getAssistantMessages(run.id, message.id)).toBeUndefined();
    expect(publications).toEqual([]);
    writer.completeItem(item.id, patch, () => {
      f.chats.updateMessage({ ...message, status: "completed" });
    });
    expect(publications).toEqual([item.id]);
    const completion = f.runs
      .replay({ streamId: run.id, afterSequence: 0 })
      .events.at(-1)!;
    const duplicateCallback = vi.fn();
    events.append(completion, undefined, duplicateCallback);
    expect(duplicateCallback).not.toHaveBeenCalled();
    expect(publications).toEqual([item.id]);
    writer.transition(run.id, "completed");
    const old = f.chats.insertMessage({
      id: randomUUID(),
      chatId: chatFixture.id,
      role: "assistant",
      status: "completed",
      content: "旧消息",
      createdAt: f.clock.now(),
      updatedAt: f.clock.now(),
    });
    const before = f.service.project(chatFixture.id).input;
    expect(before).toEqual(expect.arrayContaining(original));
    expect(before).toContainEqual({
      type: "message",
      role: "assistant",
      content: old.content,
    });
    f.database.close();
    const reopened = openApplicationDatabase(
      path.join(f.directory, "app.sqlite"),
    );
    try {
      const projection = new ChatContextService(
        new ChatRepository(reopened),
        f.clock,
        new RunRepository(reopened),
      ).project(chatFixture.id);
      expect(projection.input).toEqual(before);
      expect(
        projection.messages.find((entry) => entry.id === message.id)?.content,
      ).toBe("显示正文");
    } finally {
      reopened.close();
    }
  });

  it("supplies the original phases to summary and measures the same expanded historical input", async () => {
    const f = fixture(0, 0);
    const writer = new RunEventWriter(
      f.runs,
      new RunEventService(f.runs, { publish: () => undefined }),
      new CryptoIdGenerator(),
      f.clock,
    );
    const run = {
      ...runFixture,
      id: randomUUID(),
      createdAt: f.clock.now(),
      startedAt: f.clock.now(),
    };
    writer.startRun(run);
    const message = f.chats.insertMessage({
      id: randomUUID(),
      chatId: chatFixture.id,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      content: "显示正文",
      createdAt: f.clock.now(),
      updatedAt: f.clock.now(),
    });
    const original: JsonValue[] = [
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: "准备检查，尚未执行。",
            annotations: [],
          },
        ],
      },
    ];
    writer.completeItem(
      writer.startItem(run.id, "assistant_message").id,
      {
        status: "completed",
        output: { messageId: message.id, assistantMessages: original },
      },
      () => {
        f.chats.updateMessage({ ...message, status: "completed" });
      },
    );
    writer.transition(run.id, "completed");
    const inputs: JsonValue[][] = [];
    const measureInput = (input: readonly JsonValue[]) => {
      inputs.push([...input]);
      return Promise.resolve(estimateInputBudget(input));
    };
    await f.service.prepare({ ...f.request, measureInput });
    const result = await f.service.prepare({
      ...f.request,
      force: true,
      measureInput,
    });
    expect(
      inputs.some(
        (input) => JSON.stringify(input) === JSON.stringify(original),
      ),
    ).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]!.input)).toContain(
      '\\"phase\\":\\"commentary\\"',
    );
    expect(f.requests[0]!.instructions).toContain("not proof of completion");
    expect(result.snapshot?.coveredThroughMessageId).toBe(message.id);
    expect(result.input).not.toContainEqual(original[0]);
    expect(result.input).toEqual([
      expect.objectContaining({ role: "developer" }),
    ]);
  });
});
