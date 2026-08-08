import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { JsonValue } from "../../src/shared/contracts/primitives";
import type { ApprovalMode } from "../../src/shared/contracts/run";
import type { ToolResult } from "../../src/shared/contracts/tool";
import { SystemClock, type Clock } from "../../src/shared/pure/clock";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { AgentRuntime } from "../../src/main/agent/agentRuntime";
import { CheckpointRepository } from "../../src/main/agent/checkpointRepository";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../../src/main/agent/modelProvider";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import {
  ToolRegistry,
  toolEvidenceHash,
} from "../../src/main/tools/toolRegistry";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTED_AT = "2026-08-08T12:00:00.000Z";

type Turn = (
  request: ModelRequest,
  signal: AbortSignal,
) => Promise<readonly ModelEvent[]> | readonly ModelEvent[];

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly turns: Turn[]) {}

  resolveContextLimits() {
    return Promise.resolve({
      maxContextTokens: 1_050_000,
      maxOutputTokens: 128_000,
    });
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted model turn remains");
    for (const event of await turn(request, signal)) {
      signal.throwIfAborted();
      yield event;
    }
  }
}

class EventCollector {
  readonly events: RunEventEnvelope[] = [];
  readonly #waiters: Array<{
    readonly predicate: (event: RunEventEnvelope) => boolean;
    readonly resolve: (event: RunEventEnvelope) => void;
  }> = [];

  publish = (event: RunEventEnvelope): void => {
    this.events.push(event);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(event)) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  wait(predicate: (event: RunEventEnvelope) => boolean) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<RunEventEnvelope>((resolve) => {
      this.#waiters.push({ predicate, resolve });
    });
  }
}

interface RuntimeFixture {
  readonly chatId: string;
  readonly checkpoints: CheckpointRepository;
  readonly collector: EventCollector;
  readonly database: ReturnType<typeof openApplicationDatabase>;
  readonly provider: ScriptedProvider;
  readonly runs: RunRepository;
  readonly runtime: AgentRuntime;
  readonly tools: ToolRegistry;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function complete(responseId: string): ModelEvent {
  return {
    responseId,
    type: "response.completed",
    usage: { cachedInputTokens: 0, inputTokens: 64, outputTokens: 8 },
  };
}

function finalTurn(text = "完成"): Turn {
  return () => [
    { delta: text, type: "text.delta" },
    complete(`response-${text}`),
  ];
}

function functionTurn(
  callId: string,
  name: string,
  arguments_: Readonly<Record<string, JsonValue>>,
): Turn {
  return () => [
    {
      item: {
        arguments: JSON.stringify(arguments_),
        call_id: callId,
        name,
        type: "function_call",
      },
      type: "output.item",
    },
    complete(`response-${callId}`),
  ];
}

function namespacedFunctionTurn(
  callId: string,
  name: string,
  namespace: string,
  arguments_: Readonly<Record<string, JsonValue>>,
): Turn {
  return () => [
    {
      item: {
        arguments: JSON.stringify(arguments_),
        call_id: callId,
        name,
        namespace,
        type: "function_call",
      },
      type: "output.item",
    },
    complete(`response-${callId}`),
  ];
}

function searchTurn(callId: string, query: string): Turn {
  return () => [
    {
      item: {
        arguments: { limit: 8, query },
        call_id: callId,
        type: "tool_search_call",
      },
      type: "output.item",
    },
    complete(`response-${callId}`),
  ];
}

async function createFixture(
  turns: Turn[],
  clock: Clock = new SystemClock(),
): Promise<RuntimeFixture> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-agent-runtime-"),
  );
  temporaryDirectories.push(directory);
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const ids = new CryptoIdGenerator();
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  const chatService = new ChatService(chats, runs, ids, clock);
  const chat = chatService.create({});
  const collector = new EventCollector();
  const events = new RunEventService(runs, collector);
  const writer = new RunEventWriter(runs, events, ids, clock);
  const provider = new ScriptedProvider(turns);
  const tools = new ToolRegistry();
  const checkpoints = new CheckpointRepository(database);
  const runtime = new AgentRuntime(
    chats,
    chatService,
    runs,
    checkpoints,
    writer,
    tools,
    {
      createChatModelRuntime: () =>
        Promise.resolve({
          provider,
          snapshot: {
            apiStyle: "openai-compatible" as const,
            modelId: "gpt-5.6-sol",
            profileId: PROFILE_ID,
            profileName: "Test Provider",
          },
        }),
    },
    ids,
    clock,
  );
  return {
    chatId: chat.id,
    checkpoints,
    collector,
    database,
    provider,
    runs,
    runtime,
    tools,
  };
}

function createRuntimeFor(
  fixture: RuntimeFixture,
  provider: ScriptedProvider,
): AgentRuntime {
  const ids = new CryptoIdGenerator();
  const clock = new SystemClock();
  const chats = new ChatRepository(fixture.database);
  const chatService = new ChatService(chats, fixture.runs, ids, clock);
  const events = new RunEventService(fixture.runs, fixture.collector);
  return new AgentRuntime(
    chats,
    chatService,
    fixture.runs,
    fixture.checkpoints,
    new RunEventWriter(fixture.runs, events, ids, clock),
    fixture.tools,
    {
      createChatModelRuntime: () =>
        Promise.resolve({
          provider,
          snapshot: {
            apiStyle: "openai-compatible" as const,
            modelId: "gpt-5.6-sol",
            profileId: PROFILE_ID,
            profileName: "Test Provider",
          },
        }),
    },
    ids,
    clock,
  );
}

function startAgent(
  fixture: RuntimeFixture,
  approvalMode: ApprovalMode = "full_access",
) {
  return fixture.runtime.start({
    attachments: [],
    chatId: fixture.chatId,
    content: "完成测试任务",
    execution: { approvalMode, mode: "agent" },
    providerProfileId: PROFILE_ID,
    requestedAt: REQUESTED_AT,
  });
}

function successfulResult(summary: string): ToolResult {
  const modelContent = { summary };
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary,
  };
}

function failedResult(code = "TEST.NO_PROGRESS"): ToolResult {
  return {
    artifacts: [],
    error: { code, message: "没有进展", retryable: true },
    modelContent: { code },
    retryable: true,
    status: "error",
    summary: "没有进展",
  };
}

function registerTool(
  fixture: RuntimeFixture,
  input: {
    readonly effect?: "read" | "write" | "critical";
    readonly execute: (
      input: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
    ) => Promise<ToolResult>;
    readonly idempotency?: "idempotent" | "non_idempotent";
    readonly name: string;
    readonly recoveryGroup?: string;
  },
): void {
  fixture.tools.register({
    descriptor: {
      description: `Test capability ${input.name}`,
      effect: input.effect ?? "read",
      idempotency: input.idempotency ?? "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        type: "object",
      },
      itemKind: "tool_call",
      name: input.name,
      namespace: "test",
      ...(input.recoveryGroup ? { recoveryGroup: input.recoveryGroup } : {}),
      source: "builtin",
      summary: input.name,
    },
    execute: (arguments_, context) => input.execute(arguments_, context.signal),
    summarize: () => input.name,
  });
}

async function waitForStatus(
  fixture: RuntimeFixture,
  runId: string,
  status: string,
): Promise<void> {
  if (fixture.runs.getRun(runId)?.status === status) return;
  await fixture.collector.wait(
    (envelope) =>
      envelope.streamId === runId &&
      (status === "waiting_approval"
        ? envelope.event.type === "approval.requested"
        : "run" in envelope.event && envelope.event.run.status === status),
  );
}

describe("Agent Runtime production path", () => {
  it("resolves a Provider leaf Tool name through its namespace", async () => {
    const fixture = await createFixture(
      [
        namespacedFunctionTurn("call-read", "read", "test", { value: "x" }),
        finalTurn(),
      ],
      { now: () => REQUESTED_AT },
    );
    let calls = 0;
    registerTool(fixture, {
      execute: () => {
        calls += 1;
        return Promise.resolve(successfulResult("read"));
      },
      name: "test.read",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(1);
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "Use Provider-native web search for current public information",
    );
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "Interpret relative dates such as today in that time zone",
    );
    expect(fixture.provider.requests[0]?.instructions).toContain(
      `Current timestamp: ${REQUESTED_AT}`,
    );
    expect(fixture.runs.getRun(run.id)?.error).toBeUndefined();
    fixture.database.close();
  });

  it("completes a Direct no-op Chat without exposing or calling capabilities", async () => {
    const fixture = await createFixture([finalTurn("直接回答")]);
    registerTool(fixture, {
      execute: () => Promise.resolve(successfulResult("unused")),
      name: "test.unused",
    });

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "只回答，不执行动作",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(fixture.provider.requests[0]?.toolNamespaces).toEqual([]);
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "tool_call"),
    ).toEqual([]);
    fixture.database.close();
  });

  it("enforces Chat mode at execution even when a Provider emits an unexposed Tool call", async () => {
    const fixture = await createFixture([
      functionTurn("chat-write", "test.write", {}),
      finalTurn("请切换到 Agent 模式"),
    ]);
    let calls = 0;
    registerTool(fixture, {
      effect: "write",
      execute: () => {
        calls += 1;
        return Promise.resolve(successfulResult("wrote"));
      },
      idempotency: "non_idempotent",
      name: "test.write",
    });

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "只聊天",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(0);
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
      "TOOL.MODE_NOT_ALLOWED",
    );
    fixture.database.close();
  });

  it("includes completed messages from the same Chat in the next Run", async () => {
    const fixture = await createFixture([
      finalTurn("第一轮回答"),
      finalTurn("第二轮回答"),
    ]);

    const first = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "第一轮问题",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, first.id, "completed");
    const second = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "第二轮问题",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, second.id, "completed");

    expect(fixture.provider.requests[1]?.input).toEqual([
      { content: "第一轮问题", role: "user", type: "message" },
      { content: "第一轮回答", role: "assistant", type: "message" },
      { content: "第二轮问题", role: "user", type: "message" },
    ]);
    fixture.database.close();
  });

  it("uses native Tool Search, executes a long Run without a global step cap, and finishes honestly", async () => {
    const longCalls = Array.from({ length: 24 }, (_, index) =>
      functionTurn(`call-${String(index)}`, "test.read", {
        value: String(index),
      }),
    );
    const fixture = await createFixture([
      searchTurn("search-1", "read test value"),
      ...longCalls,
      finalTurn(),
    ]);
    let calls = 0;
    registerTool(fixture, {
      execute: () => {
        calls += 1;
        return Promise.resolve(successfulResult(`read-${String(calls)}`));
      },
      name: "test.read",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(24);
    expect(fixture.provider.requests).toHaveLength(26);
    expect(
      fixture.provider.requests[0]?.toolNamespaces[0]?.tools[0],
    ).toMatchObject({ name: "test.read" });
    expect(fixture.provider.requests[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "search-1",
        type: "tool_search_output",
      }),
    );
    expect(fixture.runs.getRun(run.id)?.error).toBeUndefined();
    fixture.database.close();
  });

  it("shares one approval fact, never executes before approval, and treats rejection as a Tool Result", async () => {
    const fixture = await createFixture([
      functionTurn("call-write", "test.write", { value: "x" }),
      finalTurn("已按拒绝结果继续"),
    ]);
    let calls = 0;
    registerTool(fixture, {
      effect: "write",
      execute: () => {
        calls += 1;
        return Promise.resolve(successfulResult("wrote"));
      },
      idempotency: "non_idempotent",
      name: "test.write",
    });

    const run = await startAgent(fixture, "request_approval");
    await waitForStatus(fixture, run.id, "waiting_approval");
    const approval = fixture.runtime.getPendingApproval();
    expect(approval).not.toBeNull();
    expect(calls).toBe(0);
    expect(fixture.runtime.getApprovalNavigation(approval!.id)).toMatchObject({
      approvalId: approval!.id,
      chatId: fixture.chatId,
      itemId: approval!.itemId,
      runId: run.id,
    });

    fixture.runtime.resolveApproval({
      approvalId: approval!.id,
      decidedAt: REQUESTED_AT,
      decision: "rejected",
      reason: "本次不写入",
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(0);
    expect(fixture.runs.getApproval(approval!.id)?.status).toBe("rejected");
    const rejectionInput = JSON.stringify(fixture.provider.requests[1]?.input);
    expect(rejectionInput).toContain('"call_id":"call-write"');
    expect(rejectionInput).toContain('\\"status\\":\\"rejected\\"');
    fixture.database.close();
  });

  it("executes an approved side effect exactly once", async () => {
    const fixture = await createFixture([
      functionTurn("call-write", "test.write", {}),
      finalTurn(),
    ]);
    let calls = 0;
    registerTool(fixture, {
      effect: "write",
      execute: () => {
        calls += 1;
        return Promise.resolve(successfulResult("wrote"));
      },
      idempotency: "non_idempotent",
      name: "test.write",
    });

    const run = await startAgent(fixture, "request_approval");
    await waitForStatus(fixture, run.id, "waiting_approval");
    const approval = fixture.runtime.getPendingApproval();
    expect(approval).not.toBeNull();
    fixture.runtime.resolveApproval({
      approvalId: approval!.id,
      decidedAt: REQUESTED_AT,
      decision: "approved",
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(1);
    expect(fixture.runs.getApproval(approval!.id)?.status).toBe("approved");
    fixture.database.close();
  });

  it("constrains one candidate recovery without adding a non-standard input item", async () => {
    const fixture = await createFixture([
      ...Array.from({ length: 5 }, (_, index) =>
        functionTurn(`failed-${String(index)}`, "test.primary", {
          value: "same",
        }),
      ),
      functionTurn("recovered", "test.alternative", { value: "same" }),
      finalTurn(),
    ]);
    let alternativeCalls = 0;
    registerTool(fixture, {
      execute: () => Promise.resolve(failedResult()),
      name: "test.primary",
      recoveryGroup: "test.recovery",
    });
    registerTool(fixture, {
      execute: () => {
        alternativeCalls += 1;
        return Promise.resolve(successfulResult("recovered"));
      },
      name: "test.alternative",
      recoveryGroup: "test.recovery",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(alternativeCalls).toBe(1);
    expect(fixture.provider.requests[5]?.allowedTools).toEqual([
      { name: "test.alternative", namespace: "test" },
    ]);
    expect(fixture.provider.requests[5]?.input).not.toContainEqual(
      expect.objectContaining({ type: "additional_tools" }),
    );
    fixture.database.close();
  });

  it("allows only one bounded no-candidate retry for an idempotent read", async () => {
    const fixture = await createFixture(
      Array.from({ length: 10 }, (_, index) =>
        functionTurn(`failed-${String(index)}`, "test.lonely", {
          value: index < 5 ? "same" : "changed",
        }),
      ),
    );
    registerTool(fixture, {
      execute: () => Promise.resolve(failedResult()),
      name: "test.lonely",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "failed");
    expect(fixture.provider.requests[5]?.allowedTools).toEqual([
      { name: "test.lonely", namespace: "test" },
    ]);
    expect(
      fixture.provider.requests.filter(({ allowedTools }) => allowedTools)
        .length,
    ).toBe(1);
    expect(fixture.runs.getRun(run.id)?.error?.code).toBe("AGENT.NO_PROGRESS");
    fixture.database.close();
  });

  it("merges steering at the next model boundary", async () => {
    let releaseFirst!: () => void;
    const firstTurnReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fixture = await createFixture([
      async () => {
        await firstTurnReady;
        return [{ delta: "旧方向", type: "text.delta" }, complete("first")];
      },
      finalTurn("已按新方向完成"),
    ]);
    const run = await startAgent(fixture);
    fixture.runtime.steer({
      content: "改成新方向",
      requestedAt: REQUESTED_AT,
      runId: run.id,
    });
    releaseFirst();
    await waitForStatus(fixture, run.id, "completed");

    expect(fixture.provider.requests[1]?.input).toContainEqual(
      expect.objectContaining({ content: "改成新方向", role: "user" }),
    );
    fixture.database.close();
  });

  it("cancels an in-flight Tool through AbortSignal without a later side effect", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let sideEffects = 0;
    const fixture = await createFixture([
      functionTurn("call-slow", "test.slow_write", {}),
    ]);
    registerTool(fixture, {
      effect: "write",
      execute: async (_input, signal) => {
        toolStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        sideEffects += 1;
        return successfulResult("should not happen");
      },
      idempotency: "non_idempotent",
      name: "test.slow_write",
    });

    const run = await startAgent(fixture);
    await started;
    await fixture.runtime.cancel({ requestedAt: REQUESTED_AT, runId: run.id });

    expect(fixture.runs.getRun(run.id)?.status).toBe("cancelled");
    expect(sideEffects).toBe(0);
    fixture.database.close();
  });

  it("resumes after interruption without replaying an already completed side effect", async () => {
    let modelBoundaryStarted!: () => void;
    const boundary = new Promise<void>((resolve) => {
      modelBoundaryStarted = resolve;
    });
    const fixture = await createFixture([
      functionTurn("call-once", "test.once", {}),
      async (_request, signal) => {
        modelBoundaryStarted();
        return new Promise<readonly ModelEvent[]>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("interrupted", "AbortError")),
            { once: true },
          );
        });
      },
    ]);
    let calls = 0;
    registerTool(fixture, {
      effect: "write",
      execute: () => {
        calls += 1;
        return Promise.resolve(successfulResult("done once"));
      },
      idempotency: "non_idempotent",
      name: "test.once",
    });

    const run = await startAgent(fixture);
    await boundary;
    await fixture.runtime.interruptAll();
    expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");

    const resumedProvider = new ScriptedProvider([finalTurn("恢复完成")]);
    const resumedRuntime = createRuntimeFor(fixture, resumedProvider);
    await resumedRuntime.resume({ requestedAt: REQUESTED_AT, runId: run.id });
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(1);
    expect(resumedProvider.requests).toHaveLength(1);
    fixture.database.close();
  });

  it("does not replay a non-idempotent Tool whose interruption outcome is unknown", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const fixture = await createFixture([
      functionTurn("call-unknown", "test.unknown", {}),
    ]);
    let executions = 0;
    registerTool(fixture, {
      effect: "write",
      execute: async (_input, signal) => {
        executions += 1;
        toolStarted();
        return new Promise<ToolResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("interrupted", "AbortError")),
            { once: true },
          );
        });
      },
      idempotency: "non_idempotent",
      name: "test.unknown",
    });

    const run = await startAgent(fixture);
    await started;
    await fixture.runtime.interruptAll();
    expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");

    const resumedProvider = new ScriptedProvider([finalTurn()]);
    const resumedRuntime = createRuntimeFor(fixture, resumedProvider);
    await resumedRuntime.resume({ requestedAt: REQUESTED_AT, runId: run.id });
    await waitForStatus(fixture, run.id, "needs_input");

    expect(executions).toBe(1);
    expect(resumedProvider.requests).toHaveLength(0);
    expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
      "AGENT.SIDE_EFFECT_UNKNOWN",
    );
    fixture.database.close();
  });
});
