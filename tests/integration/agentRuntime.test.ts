import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { PersonaSnapshot } from "../../src/shared/contracts/persona";
import type { JsonValue } from "../../src/shared/contracts/primitives";
import type { ApprovalMode } from "../../src/shared/contracts/run";
import type { ToolResult } from "../../src/shared/contracts/tool";
import { SystemClock, type Clock } from "../../src/shared/pure/clock";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { AgentRuntime } from "../../src/main/agent/agentRuntime";
import {
  ACTIVITY_SEARCH_TOOL_NAME,
  registerActivityTool,
} from "../../src/main/activity/activityTool";
import {
  COLLABORATION_DISPATCH_TOOL_NAME,
  registerCollaborationTool,
} from "../../src/main/agent/collaborationTool";
import type {
  ImageInputProvider,
  PreparedImageInput,
} from "../../src/main/agent/imageInput";
import { CheckpointRepository } from "../../src/main/agent/checkpointRepository";
import { registerPlanTool } from "../../src/main/agent/planTool";
import type {
  ModelContextLimits,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../../src/main/agent/modelProvider";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import type { ChatTitleGenerator } from "../../src/main/chat/chatTitleService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { defaultPersonaSnapshot } from "../../src/main/persona/personaPresets";
import { registerCompanionshipTool } from "../../src/main/journey/companionshipTool";
import type { JourneyService } from "../../src/main/journey/journeyService";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import {
  registerMemoryFormationTool,
  registerMemoryTool,
} from "../../src/main/memory/memoryTool";
import { ProviderError } from "../../src/main/providers/providerError";
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
  readonly contextLimitRequests: string[] = [];
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly turns: Turn[],
    private readonly contextLimits: ModelContextLimits = {
      effectiveInputTokens: 922_000,
      maxContextTokens: 1_050_000,
      maxOutputTokens: 128_000,
      maxPromptTokens: 922_000,
    },
  ) {}

  resolveContextLimits(modelId: string) {
    this.contextLimitRequests.push(modelId);
    return Promise.resolve(this.contextLimits);
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

function complete(responseId: string, inputTokens = 64): ModelEvent {
  return {
    responseId,
    status: "completed",
    type: "response.completed",
    usage: { cachedInputTokens: 0, inputTokens, outputTokens: 8 },
  };
}

function finalTurn(text = "完成"): Turn {
  return () => [
    { delta: text, type: "text.delta" },
    complete(`response-${text}`),
  ];
}

function finalTurnWithUsage(text: string, inputTokens: number): Turn {
  return () => [
    { delta: text, type: "text.delta" },
    complete(`response-${text}`, inputTokens),
  ];
}

function chatSummaryTurn(summary: string, expectedPrevious?: string): Turn {
  return (request) => {
    expect(request.instructions).toContain(
      "CharaMate conversation working memory",
    );
    expect(request.toolNamespaces).toEqual([]);
    if (expectedPrevious) {
      expect(JSON.stringify(request.input)).toContain(expectedPrevious);
    }
    return [
      { delta: summary, type: "text.delta" },
      complete(`response-summary-${summary}`, 32),
    ];
  };
}

function childSummaryTurn(): Turn {
  return (request) => {
    const first = request.input[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) {
      throw new TypeError("Missing child input");
    }
    const content = first["content"];
    if (typeof content !== "string") throw new TypeError("Missing child goal");
    const parsed = JSON.parse(content) as { goal: string };
    return [
      { delta: `子任务结论：${parsed.goal}`, type: "text.delta" },
      complete(`response-child-${parsed.goal}`),
    ];
  };
}

function collaborationDispatch(): Readonly<Record<string, JsonValue>> {
  return {
    subtasks: [
      {
        goal: "核对模块 A",
        id: "module_a",
        reads: [
          {
            input: { value: "A evidence" },
            resourceClaim: "module:A",
            toolName: "test.read",
          },
        ],
        resourceClaims: ["module:A"],
      },
      {
        goal: "核对模块 B",
        id: "module_b",
        reads: [
          {
            input: { value: "B evidence" },
            resourceClaim: "module:B",
            toolName: "test.read",
          },
        ],
        resourceClaims: ["module:B"],
      },
    ],
  };
}

function hostedSearchTurn(text: string): Turn {
  return () => [
    {
      item: {
        action: { query: "海淀区未来一周天气", type: "search" },
        id: "web-search-1",
        status: "completed",
        type: "web_search_call",
      },
      type: "output.item",
    },
    { delta: text, type: "text.delta" },
    complete("response-hosted-search"),
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
  inputTokens = 64,
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
    complete(`response-${callId}`, inputTokens),
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
  chatTitles?: ChatTitleGenerator,
  images?: ImageInputProvider,
  contextLimits?: ModelContextLimits,
  persona?: PersonaSnapshot,
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
  const provider = new ScriptedProvider(turns, contextLimits);
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
    { getActiveSnapshot: () => persona ?? defaultPersonaSnapshot(clock.now()) },
    undefined,
    undefined,
    chatTitles,
    images,
    undefined,
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

function preparedImage(label: string): PreparedImageInput {
  return {
    byteLength: 12,
    content: {
      detail: "auto",
      image_url: `data:image/png;base64,${label}`,
      type: "input_image",
    },
    height: 24,
    mediaType: "image/png",
    width: 32,
  };
}

function createRuntimeFor(
  fixture: RuntimeFixture,
  provider: ScriptedProvider,
  memory?: MemoryService,
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
    { getActiveSnapshot: () => defaultPersonaSnapshot(clock.now()) },
    undefined,
    undefined,
    undefined,
    undefined,
    memory,
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
    readonly namespace?: string;
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
      namespace: input.namespace ?? "test",
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
  it("stamps one Persona snapshot on the Run and compiles that same snapshot into model instructions", async () => {
    const persona = {
      ...defaultPersonaSnapshot(REQUESTED_AT),
      displayName: "Lumi",
      speechStyle: "先回应事实，再给一小句有温度的观察。",
      styleName: "清醒温暖",
    };
    const fixture = await createFixture(
      [finalTurn("已按当前角色完成回应")],
      new SystemClock(),
      undefined,
      undefined,
      undefined,
      persona,
    );

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "介绍一下你自己",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(run.persona).toEqual(persona);
    expect(fixture.runs.getRun(run.id)?.persona).toEqual(persona);
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "displayName: Lumi",
    );
    expect(fixture.provider.requests[0]?.instructions).toContain(
      persona.speechStyle,
    );
    fixture.database.close();
  });

  it("lets the Agent choose two validated read-only children and rejoins the same parent Run", async () => {
    const dispatch = collaborationDispatch();
    const fixture = await createFixture([
      namespacedFunctionTurn(
        "collaboration-call",
        "dispatch",
        "collaboration",
        dispatch,
      ),
      childSummaryTurn(),
      childSummaryTurn(),
      finalTurn("父 Agent 已合并两个结论"),
    ]);
    registerTool(fixture, {
      execute: (input) => {
        const value = input["value"];
        if (typeof value !== "string") {
          throw new TypeError("value must be a string");
        }
        return Promise.resolve(successfulResult(value));
      },
      name: "test.read",
    });
    registerCollaborationTool(fixture.tools, {
      createChatModelRuntime: () =>
        Promise.resolve({
          provider: fixture.provider,
          snapshot: {
            apiStyle: "openai-compatible",
            modelId: "gpt-5.6-sol",
            profileId: PROFILE_ID,
            profileName: "Test Provider",
          },
        }),
      getRun: (runId) => fixture.runs.getRun(runId),
    });

    const run = await startAgent(fixture);
    await fixture.collector.wait(
      (envelope) =>
        envelope.streamId === run.id &&
        "run" in envelope.event &&
        ["completed", "failed", "cancelled", "interrupted"].includes(
          envelope.event.run.status,
        ),
    );
    const terminalRun = fixture.runs.getRun(run.id);
    expect(terminalRun?.error).toBeUndefined();
    expect(terminalRun?.status).toBe("completed");

    const item = fixture.runs
      .listRunItems(run.id)
      .find(({ kind }) => kind === "subtask");
    expect(item).toMatchObject({ input: dispatch, status: "completed" });
    expect(item?.output).toMatchObject({
      modelContent: {
        children: [
          { id: "module_a", status: "completed" },
          { id: "module_b", status: "completed" },
        ],
        joinRequired: true,
      },
      status: "success",
    });
    expect(fixture.provider.requests).toHaveLength(4);
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "collaboration")
        ?.tools.find(({ name }) => name === COLLABORATION_DISPATCH_TOOL_NAME),
    ).toMatchObject({ deferLoading: false });
    expect(fixture.provider.requests.slice(1, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nativeWebSearch: false, toolNamespaces: [] }),
        expect.objectContaining({ nativeWebSearch: false, toolNamespaces: [] }),
      ]),
    );
    expect(JSON.stringify(fixture.provider.requests[3]?.input)).toContain(
      "子任务结论：核对模块 A",
    );
    expect(JSON.stringify(fixture.provider.requests[3]?.input)).toContain(
      "子任务结论：核对模块 B",
    );
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "approval"),
    ).toEqual([]);
    fixture.database.close();
  });

  it("keeps collaboration unavailable in Chat mode without a hidden switch", async () => {
    const fixture = await createFixture([finalTurn("单 Agent 回答")]);
    registerCollaborationTool(fixture.tools, {
      createChatModelRuntime: () =>
        Promise.resolve({
          provider: fixture.provider,
          snapshot: {
            apiStyle: "openai-compatible",
            modelId: "gpt-5.6-sol",
            profileId: PROFILE_ID,
            profileName: "Test Provider",
          },
        }),
      getRun: (runId) => fixture.runs.getRun(runId),
    });

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "直接回答",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(
      fixture.provider.requests[0]?.toolNamespaces.some(
        ({ name }) => name === "collaboration",
      ),
    ).toBe(false);
    expect(
      fixture.runs.listRunItems(run.id).some(({ kind }) => kind === "subtask"),
    ).toBe(false);
    fixture.database.close();
  });

  it("replays an interrupted collaboration through the existing idempotent Tool boundary", async () => {
    const dispatch = collaborationDispatch();
    let startedChildren = 0;
    let bothChildrenStarted!: () => void;
    const childrenStarted = new Promise<void>((resolve) => {
      bothChildrenStarted = resolve;
    });
    const blockedChild: Turn = async (_request, signal) => {
      startedChildren += 1;
      if (startedChildren === 2) bothChildrenStarted();
      return new Promise<readonly ModelEvent[]>((_resolve, reject) => {
        const abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("interrupted", "AbortError"),
          );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    };
    const fixture = await createFixture([
      namespacedFunctionTurn(
        "collaboration-restart",
        "dispatch",
        "collaboration",
        dispatch,
      ),
      blockedChild,
      blockedChild,
    ]);
    let reads = 0;
    registerTool(fixture, {
      execute: (input) => {
        reads += 1;
        const value = input["value"];
        if (typeof value !== "string") {
          throw new TypeError("value must be a string");
        }
        return Promise.resolve(successfulResult(value));
      },
      name: "test.read",
    });
    let collaborationProvider: ModelProvider = fixture.provider;
    registerCollaborationTool(fixture.tools, {
      createChatModelRuntime: () =>
        Promise.resolve({
          provider: collaborationProvider,
          snapshot: {
            apiStyle: "openai-compatible",
            modelId: "gpt-5.6-sol",
            profileId: PROFILE_ID,
            profileName: "Test Provider",
          },
        }),
      getRun: (runId) => fixture.runs.getRun(runId),
    });

    const run = await startAgent(fixture);
    await childrenStarted;
    await fixture.runtime.interruptAll();

    expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "subtask"),
    ).toEqual([expect.objectContaining({ status: "interrupted" })]);

    const resumedProvider = new ScriptedProvider([
      childSummaryTurn(),
      childSummaryTurn(),
      finalTurn("恢复后完成父 Join"),
    ]);
    collaborationProvider = resumedProvider;
    const resumedRuntime = createRuntimeFor(fixture, resumedProvider);
    await resumedRuntime.resume({ requestedAt: REQUESTED_AT, runId: run.id });
    await waitForStatus(fixture, run.id, "completed");

    expect(fixture.runs.getRun(run.id)?.status).toBe("completed");
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "subtask")
        .map(({ status }) => status),
    ).toEqual(["interrupted", "completed"]);
    expect(reads).toBe(4);
    expect(resumedProvider.requests).toHaveLength(3);
    fixture.database.close();
  });

  it("preinjects stable profile claims even when the raw question has no lexical match", async () => {
    const fixture = await createFixture([]);
    const clock = new SystemClock();
    const ids = new CryptoIdGenerator();
    const repository = new MemoryRepository(fixture.database);
    const memory = new MemoryService(
      repository,
      new LexicalRetrievalPipeline(fixture.database, repository, clock),
      ids,
      clock,
    );
    const created = memory.create({
      claimSlot: "preference.hobbies",
      confidence: 1,
      content: "用户长期游玩 CS2，并关注职业选手比赛。",
      importance: 0.9,
      reason: "用户明确偏好",
      sources: [],
      type: "preference",
    });
    registerMemoryTool(fixture.tools, memory);
    const provider = new ScriptedProvider([finalTurn("已按偏好回答")]);
    const runtime = createRuntimeFor(fixture, provider, memory);

    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "我有什么爱好？",
      execution: { approvalMode: "full_access", mode: "agent" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    const input = provider.requests[0]?.input ?? [];
    expect(input.at(-1)).toEqual({
      content: "我有什么爱好？",
      role: "user",
      type: "message",
    });
    expect(input.at(-2)).toMatchObject({ role: "developer", type: "message" });
    expect(JSON.stringify(input.at(-2))).not.toContain(created.memory.id);
    expect(JSON.stringify(input.at(-2))).not.toContain(
      created.memory.currentRevisionId,
    );
    expect(JSON.stringify(input.at(-2))).toContain("preference.hobbies");
    expect(JSON.stringify(input.at(-2))).toContain("长期游玩 CS2");
    expect(
      provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "memory")
        ?.tools.find(({ name }) => name === "memory.search"),
    ).toMatchObject({ deferLoading: true });
    expect(
      fixture.database.prepare("SELECT consumer FROM memory_usage").all(),
    ).toEqual([{ consumer: "context" }]);
    fixture.database.close();
  });

  it("lets the current model perform one evidence-oriented R0 search for legacy records", async () => {
    const fixture = await createFixture([
      searchTurn("search-memory", "long-term memory personal preferences"),
      functionTurn("call-memory", "memory.search", {
        query: "用户喜欢 兴趣",
        type: "preference",
      }),
      finalTurn("你喜欢玩 CS2。"),
    ]);
    const clock = new SystemClock();
    const ids = new CryptoIdGenerator();
    const repository = new MemoryRepository(fixture.database);
    const memory = new MemoryService(
      repository,
      new LexicalRetrievalPipeline(fixture.database, repository, clock),
      ids,
      clock,
    );
    const legacy = memory.create({
      confidence: 1,
      content: "用户喜欢玩 CS2。",
      importance: 0.8,
      reason: "v5 旧数据",
      sources: [],
      type: "preference",
    });
    registerMemoryTool(fixture.tools, memory);
    const runtime = createRuntimeFor(fixture, fixture.provider, memory);

    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "我有什么爱好？",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(JSON.stringify(fixture.provider.requests[0]?.input)).toContain(
      "1 active legacy profile/preference record(s)",
    );
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).not.toContain(
      legacy.memory.id,
    );
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).toContain(
      "用户喜欢玩 CS2。",
    );
    expect(
      fixture.runs.listRunItems(run.id).find(({ kind }) => kind === "tool_call")
        ?.displayOutput,
    ).toBe("找到 1 条记忆");
    expect(memory.get(legacy.memory.id).usages).toEqual([
      expect.objectContaining({ consumer: "tool" }),
    ]);
    fixture.database.close();
  });

  it("loads compact Activity recall on demand without exposing raw evidence in the Run", async () => {
    const fixture = await createFixture([
      searchTurn("search-activity", "software activity usage history"),
      functionTurn("call-activity", ACTIVITY_SEARCH_TOOL_NAME, {}),
      finalTurn("你最近经常使用 Visual Studio Code。"),
    ]);
    registerActivityTool(fixture.tools, {
      search: () => ({
        observedBehaviorOnly: true,
        patterns: [
          {
            activeDays: 3,
            episodeCount: 4,
            firstSeenAt: "2026-08-01T01:00:00.000Z",
            kind: "app",
            label: "Visual Studio Code",
            lastSeenAt: "2026-08-03T02:00:00.000Z",
            totalMinutes: 180,
          },
        ],
        periodEnd: "2026-08-04T00:00:00.000Z",
        periodStart: "2026-08-01T00:00:00.000Z",
      }),
    });
    const runtime = createRuntimeFor(fixture, fixture.provider);

    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "我最近一般在用什么软件？",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "activity")
        ?.tools.find(({ name }) => name === ACTIVITY_SEARCH_TOOL_NAME),
    ).toMatchObject({ deferLoading: true });
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).toContain(
      "Visual Studio Code",
    );
    expect(
      fixture.runs.listRunItems(run.id).find(({ kind }) => kind === "tool_call")
        ?.displayOutput,
    ).toBe("找到 1 条活动模式");
    fixture.database.close();
  });

  it("forms a sourced memory inside Chat mode without execution approval", async () => {
    const fixture = await createFixture([]);
    const clock = new SystemClock();
    const ids = new CryptoIdGenerator();
    const repository = new MemoryRepository(fixture.database);
    const memory = new MemoryService(
      repository,
      new LexicalRetrievalPipeline(fixture.database, repository, clock),
      ids,
      clock,
    );
    registerMemoryFormationTool(fixture.tools, memory, (runId, basis) => ({
      allowedMemoryIds: [],
      label:
        basis === "run_observation"
          ? `Agent Run ${runId}`
          : "用户消息 20000000-0000-4000-8000-000000000001",
      referenceId: basis === "run_observation" ? runId : fixture.chatId,
      sourceType: basis === "run_observation" ? "tool" : "chat",
    }));
    const provider = new ScriptedProvider([
      namespacedFunctionTurn("memory-call", "record", "memory", {
        basis: "explicit_user_statement",
        claimSlot: "preference.response_style",
        content: "用户偏好技术回答先给结论。",
        operation: "create",
      }),
      finalTurn("记住了，我会先给结论。"),
    ]);
    const runtime = createRuntimeFor(fixture, provider, memory);

    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "以后技术回答先给结论。",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(
      provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "memory")
        ?.tools.find(({ name }) => name === "memory.record"),
    ).toMatchObject({ deferLoading: false });
    expect(provider.requests[0]?.instructions).toContain(
      "always-loaded memory.record tool",
    );
    expect(provider.requests[0]?.instructions).toContain(
      "only internal persistence exceptions",
    );
    expect(provider.requests[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          call_id: "memory-call",
          type: "function_call_output",
        }),
      ]),
    );
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "approval"),
    ).toEqual([]);
    const formed = memory.list({ query: "技术回答" }).memories[0];
    if (!formed) throw new Error("Expected formed Memory");
    expect(formed.revision.content).toBe("用户偏好技术回答先给结论。");
    expect(formed.sources).toEqual([
      expect.objectContaining({
        referenceId: fixture.chatId,
        type: "chat",
      }),
    ]);
    expect(JSON.stringify(provider.requests[1]?.input)).not.toContain(
      formed.memory.id,
    );
    expect(JSON.stringify(provider.requests[1]?.input)).not.toContain(
      formed.memory.currentRevisionId,
    );
    expect(
      fixture.runs.listRunItems(run.id).find(({ kind }) => kind === "tool_call")
        ?.displayOutput,
    ).toBe("已形成长期记忆");

    const followupProvider = new ScriptedProvider([
      finalTurn("我会继续先给结论。"),
    ]);
    const followupRuntime = createRuntimeFor(fixture, followupProvider, memory);
    const followup = await followupRuntime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "技术回答应该怎么组织？",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, followup.id, "completed");
    expect(JSON.stringify(followupProvider.requests[0]?.input)).not.toContain(
      formed.memory.id,
    );
    expect(JSON.stringify(followupProvider.requests[0]?.input)).toContain(
      "用户偏好技术回答先给结论。",
    );
    fixture.database.close();
  });

  it("routes an Agent execution observation to a sourced review candidate", async () => {
    const fixture = await createFixture([]);
    const clock = new SystemClock();
    const ids = new CryptoIdGenerator();
    const repository = new MemoryRepository(fixture.database);
    const memory = new MemoryService(
      repository,
      new LexicalRetrievalPipeline(fixture.database, repository, clock),
      ids,
      clock,
    );
    registerMemoryFormationTool(fixture.tools, memory, (runId, basis) => ({
      allowedMemoryIds: [],
      label: `Agent Run ${runId}`,
      referenceId: basis === "run_observation" ? runId : fixture.chatId,
      sourceType: basis === "run_observation" ? "tool" : "chat",
    }));
    const provider = new ScriptedProvider([
      namespacedFunctionTurn("memory-observation", "record", "memory", {
        basis: "run_observation",
        content: "Lantern 的发布检查需要先运行离线验收。",
        operation: "create",
        type: "procedure",
      }),
      finalTurn("任务完成，已把可复用观察留作候选。"),
    ]);
    const runtime = createRuntimeFor(fixture, provider, memory);

    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "完成发布检查",
      execution: { approvalMode: "request_approval", mode: "agent" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "approval"),
    ).toEqual([]);
    expect(memory.list({ query: "发布检查" }).memories).toEqual([]);
    expect(memory.list({}).candidates).toEqual([
      expect.objectContaining({
        content: "Lantern 的发布检查需要先运行离线验收。",
        sourceIds: [run.id],
        sourceType: "tool",
        status: "pending",
        type: "procedure",
      }),
    ]);
    fixture.database.close();
  });

  it("requests an AI title only after the first persisted Turn completes", async () => {
    const generate = vi.fn<ChatTitleGenerator["generate"]>(() =>
      Promise.resolve(),
    );
    const fixture = await createFixture(
      [finalTurn("首轮回答")],
      new SystemClock(),
      { generate },
    );

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");
    await Promise.resolve();

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      assistantContent: "首轮回答",
      chatId: fixture.chatId,
      firstUserContent: "完成测试任务",
      modelId: "gpt-5.6-sol",
    });
    fixture.database.close();
  });

  it("persists full plan.update snapshots as live Plan Run items", async () => {
    const initialPlan = {
      explanation: "先检查，再实现。",
      plan: [
        { status: "in_progress" as const, step: "检查现有实现" },
        { status: "pending" as const, step: "补齐能力" },
        { status: "pending" as const, step: "运行验收" },
      ],
    };
    const progressedPlan = {
      explanation: "检查完成，开始实现。",
      plan: [
        { status: "completed" as const, step: "检查现有实现" },
        { status: "in_progress" as const, step: "补齐能力" },
        { status: "pending" as const, step: "运行验收" },
      ],
    };
    const fixture = await createFixture(
      [
        namespacedFunctionTurn(
          "plan-first",
          "update",
          "plan",
          initialPlan,
          100,
        ),
        namespacedFunctionTurn(
          "plan-progress",
          "update",
          "plan",
          progressedPlan,
          100,
        ),
        finalTurn(),
      ],
      undefined,
      undefined,
      undefined,
      { effectiveInputTokens: 100 },
    );
    registerPlanTool(fixture.tools);

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    const planItems = fixture.runs
      .listRunItems(run.id)
      .filter(({ kind }) => kind === "plan");
    expect(planItems).toHaveLength(2);
    expect(planItems[0]).toMatchObject({
      input: initialPlan,
      status: "completed",
    });
    expect(planItems[1]).toMatchObject({
      input: progressedPlan,
      status: "completed",
    });
    expect(
      fixture.collector.events.some(
        ({ event }) =>
          event.type === "item.started" && event.item.kind === "plan",
      ),
    ).toBe(true);
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "call the always-loaded plan.update tool directly before other work",
    );
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "plan")
        ?.tools.find(({ name }) => name === "plan.update"),
    ).toMatchObject({ deferLoading: false });
    expect(
      fixture.provider.requests[0]?.toolNamespaces.flatMap(({ tools }) =>
        tools
          .filter(({ deferLoading }) => deferLoading === false)
          .map(({ name }) => name),
      ),
    ).toEqual(["request_user_input", "plan.update"]);
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
      "Current execution plan (authoritative latest complete snapshot)",
    );
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
      "检查现有实现",
    );
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
      "运行验收",
    );
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).toContain(
      "检查完成，开始实现",
    );
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).not.toContain(
      "先检查，再实现",
    );
    expect(
      fixture.runs
        .listRunItems(run.id)
        .some(({ kind }) => kind === "context_compaction"),
    ).toBe(true);
    expect(
      new ChatRepository(fixture.database).getContextSnapshot(fixture.chatId),
    ).toMatchObject({ generation: 0 });
    fixture.database.close();
  });

  it("keeps the latest Plan through an ordinary Tool, compaction, and restart", async () => {
    const plan = {
      explanation: "先检查，再实现并验证。",
      plan: [
        { status: "completed" as const, step: "检查现有实现" },
        { status: "in_progress" as const, step: "修复 checkpoint" },
        { status: "pending" as const, step: "运行回归测试" },
      ],
    };
    const questions = [
      {
        header: "继续",
        id: "continue",
        options: [
          { description: "继续执行剩余步骤。", label: "继续" },
          { description: "停止当前执行。", label: "停止" },
        ],
        question: "是否继续完成剩余计划？",
      },
    ];
    const fixture = await createFixture(
      [
        namespacedFunctionTurn("plan-current", "update", "plan", plan, 10),
        namespacedFunctionTurn(
          "ordinary-read",
          "read",
          "test",
          { value: "state" },
          10,
        ),
        namespacedFunctionTurn(
          "input-continue",
          "request_user_input",
          "interaction",
          { questions },
          100,
        ),
      ],
      undefined,
      undefined,
      undefined,
      { effectiveInputTokens: 100 },
    );
    registerPlanTool(fixture.tools);
    registerTool(fixture, {
      execute: () => Promise.resolve(successfulResult("ordinary read")),
      name: "test.read",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "needs_input");
    expect(fixture.checkpoints.get(run.id)).toMatchObject({
      context: { currentPlan: plan },
      phase: "input",
    });
    const checkpoint = fixture.checkpoints.get(run.id)!;
    const legacyContext = {
      ...(checkpoint.context as Readonly<Record<string, JsonValue>>),
    };
    delete legacyContext["currentPlan"];
    fixture.checkpoints.save({ ...checkpoint, context: legacyContext });

    const item = fixture.runs
      .listRunItems(run.id)
      .find(({ kind }) => kind === "input_request");
    const restartedProvider = new ScriptedProvider([
      finalTurn("已完成剩余计划"),
    ]);
    const restartedRuntime = createRuntimeFor(fixture, restartedProvider);
    await restartedRuntime.initialize();
    await restartedRuntime.resolveUserInput({
      itemId: item!.id,
      resolution: {
        answers: [
          {
            questionId: "continue",
            value: { kind: "option", label: "继续" },
          },
        ],
        resolvedAt: REQUESTED_AT,
        status: "answered",
      },
      runId: run.id,
    });
    await waitForStatus(fixture, run.id, "completed");

    const continuedInput = JSON.stringify(restartedProvider.requests[0]?.input);
    expect(continuedInput).toContain(
      "Current execution plan (authoritative latest complete snapshot)",
    );
    expect(continuedInput).toContain("检查现有实现");
    expect(continuedInput).toContain("修复 checkpoint");
    expect(continuedInput).toContain("运行回归测试");
    expect(continuedInput).toContain("ordinary read");
    expect(
      fixture.runs
        .listRunItems(run.id)
        .some(({ kind }) => kind === "context_compaction"),
    ).toBe(true);
    fixture.database.close();
  });

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

  it("completes a direct Chat response with hosted search and no client loop", async () => {
    const fixture = await createFixture([
      hostedSearchTurn("海淀区天气查询结果。"),
    ]);
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

    expect(fixture.provider.requests).toHaveLength(1);
    expect(fixture.provider.requests[0]?.nativeWebSearch).toBe(true);
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "answer without a plan or progress preamble",
    );
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "must not be searched for in the client registry",
    );
    expect(fixture.provider.requests[0]?.toolNamespaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "interaction",
          tools: [
            expect.objectContaining({
              deferLoading: false,
              name: "request_user_input",
            }),
          ],
        }),
        expect.objectContaining({
          name: "test",
          tools: [expect.objectContaining({ name: "test.unused" })],
        }),
      ]),
    );
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "tool_call"),
    ).toEqual([]);
    expect(JSON.stringify(fixture.provider.requests[0])).not.toContain(
      "web.search",
    );
    fixture.database.close();
  });

  it("runs an inline bubble reply in the same Chat without exposing structured input", async () => {
    const fixture = await createFixture([finalTurn("气泡里的连续回答")]);
    registerCompanionshipTool(fixture.tools, {
      getRun: (runId) => fixture.runs.getRun(runId),
      journeys: {} as JourneyService,
    });
    let allocatedRunId: string | undefined;

    const run = await fixture.runtime.startInlineConversation(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "继续聊刚才的实验设计",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      {
        onRunAllocated: (runId) => {
          allocatedRunId = runId;
        },
      },
    );
    await waitForStatus(fixture, run.id, "completed");

    expect(allocatedRunId).toBe(run.id);
    expect(fixture.runs.getRun(run.id)).toMatchObject({
      chatId: fixture.chatId,
      execution: { mode: "chat" },
      status: "completed",
    });
    expect(fixture.provider.requests[0]?.nativeWebSearch).toBe(true);
    expect(
      fixture.provider.requests[0]?.toolNamespaces.some(
        ({ name }) => name === "interaction",
      ),
    ).toBe(false);
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "companionship")
        ?.tools.find(({ name }) => name === "companionship.update"),
    ).toMatchObject({ deferLoading: false, strict: false });
    expect(
      new ChatRepository(fixture.database)
        .listMessages(fixture.chatId)
        .map(({ content, role, runId }) => ({ content, role, runId })),
    ).toEqual([
      {
        content: "继续聊刚才的实验设计",
        role: "user",
        runId: run.id,
      },
      {
        content: "气泡里的连续回答",
        role: "assistant",
        runId: run.id,
      },
    ]);
    fixture.database.close();
  });

  it("binds an ordinary turn at allocation before persisting its Run and User Message", async () => {
    const fixture = await createFixture([finalTurn("收到手机分享")]);
    let allocatedRunId: string | undefined;

    const run = await fixture.runtime.start(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "从手机分享的文字",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      {
        onRunAllocated: (runId) => {
          allocatedRunId = runId;
          expect(fixture.runs.getRun(runId)).toBeUndefined();
          expect(
            new ChatRepository(fixture.database).listRunMessages(runId),
          ).toEqual([]);
        },
      },
    );
    await waitForStatus(fixture, run.id, "completed");

    expect(allocatedRunId).toBe(run.id);
    expect(
      new ChatRepository(fixture.database).listRunMessages(run.id),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "从手机分享的文字",
          role: "user",
          status: "completed",
        }),
      ]),
    );
    fixture.database.close();
  });

  it("lets Chat use plan and idempotent read tools while retaining the same Harness", async () => {
    const plan = {
      plan: [{ status: "in_progress" as const, step: "查询信息" }],
    };
    const fixture = await createFixture([
      namespacedFunctionTurn("chat-plan", "update", "plan", plan),
      functionTurn("chat-read", "test.read", { value: "海淀天气" }),
      finalTurn("查询完成"),
    ]);
    registerPlanTool(fixture.tools);
    let reads = 0;
    registerTool(fixture, {
      execute: () => {
        reads += 1;
        return Promise.resolve(successfulResult("晴朗"));
      },
      name: "test.read",
    });

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "查询海淀天气",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(reads).toBe(1);
    expect(fixture.runs.listRunItems(run.id).map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["plan", "tool_call"]),
    );
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "idempotent read-only query and plan tools",
    );
    fixture.database.close();
  });

  it("pauses for direct structured input, consumes one answer, and continues the same Run", async () => {
    const questions = [
      {
        header: "范围",
        id: "scope",
        options: [
          { description: "只处理当前文件。", label: "当前文件" },
          { description: "处理整个目录。", label: "整个目录" },
        ],
        question: "这次要处理多大范围？",
      },
    ];
    const fixture = await createFixture([
      namespacedFunctionTurn(
        "input-scope",
        "request_user_input",
        "interaction",
        { questions },
      ),
      () => {
        throw new ProviderError(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          "context is full",
          true,
        );
      },
      finalTurn("已按选择完成"),
    ]);

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "先问清楚范围再继续",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "needs_input");
    const item = fixture.runs
      .listRunItems(run.id)
      .find(({ kind }) => kind === "input_request");
    expect(item).toMatchObject({
      input: { questions },
      status: "waiting_input",
    });
    expect(fixture.checkpoints.get(run.id)).toMatchObject({ phase: "input" });

    const resolution = {
      answers: [
        {
          questionId: "scope",
          value: { kind: "option" as const, label: "整个目录" },
        },
      ],
      resolvedAt: REQUESTED_AT,
      status: "answered" as const,
    };
    await fixture.runtime.resolveUserInput({
      itemId: item!.id,
      resolution,
      runId: run.id,
    });
    await waitForStatus(fixture, run.id, "completed");

    const resolvedItem = fixture.runs.getRunItem(item!.id);
    expect(resolvedItem).toMatchObject({
      output: resolution,
      status: "completed",
    });
    const continuedInput = JSON.stringify(fixture.provider.requests[1]?.input);
    expect(continuedInput).toContain('"call_id":"input-scope"');
    expect(continuedInput).toContain("整个目录");
    expect(continuedInput.match(/input-scope/gu)).toHaveLength(2);
    const compactedInput = JSON.stringify(fixture.provider.requests[2]?.input);
    expect(compactedInput).toContain("先问清楚范围再继续");
    expect(compactedInput).toContain("structured answers");
    expect(compactedInput).toContain("整个目录");
    expect(compactedInput).not.toContain("input-scope");
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "call the always-loaded request_user_input tool directly",
    );

    const duplicate = await fixture.runtime.resolveUserInput({
      itemId: item!.id,
      resolution,
      runId: run.id,
    });
    expect(duplicate.status).toBe("completed");
    expect(
      fixture.collector.events.filter(
        ({ event }) => event.type === "input.resolved",
      ),
    ).toHaveLength(1);
    fixture.database.close();
  });

  it("restores a pending structured question after restart and accepts cancellation", async () => {
    const questions = [
      {
        header: "输出",
        id: "format",
        options: [
          { description: "保存为 Markdown。", label: "Markdown" },
          { description: "只在聊天中回答。", label: "聊天回答" },
        ],
        question: "希望如何交付结果？",
      },
    ];
    const fixture = await createFixture([
      namespacedFunctionTurn(
        "input-format",
        "request_user_input",
        "interaction",
        { questions },
      ),
    ]);
    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "needs_input");
    const item = fixture.runs
      .listRunItems(run.id)
      .find(({ kind }) => kind === "input_request");

    const restartedProvider = new ScriptedProvider([
      finalTurn("已尊重取消并完成"),
    ]);
    const restartedRuntime = createRuntimeFor(fixture, restartedProvider);
    await restartedRuntime.initialize();
    await restartedRuntime.resolveUserInput({
      itemId: item!.id,
      resolution: { resolvedAt: REQUESTED_AT, status: "cancelled" },
      runId: run.id,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(restartedProvider.requests).toHaveLength(1);
    expect(JSON.stringify(restartedProvider.requests[0]?.input)).toContain(
      '\\"status\\":\\"cancelled\\"',
    );
    expect(fixture.runs.getRunItem(item!.id)).toMatchObject({
      output: { status: "cancelled" },
      status: "completed",
    });
    fixture.database.close();
  });

  it("sends user image attachments as real Provider image content", async () => {
    const prepare = vi.fn<ImageInputProvider["prepare"]>((source) =>
      Promise.resolve(preparedImage(Buffer.from(source).toString("base64"))),
    );
    const fixture = await createFixture(
      [finalTurn("我已读取图片")],
      new SystemClock(),
      undefined,
      { prepare },
    );

    const run = await fixture.runtime.start({
      attachments: [
        {
          artifactId: "20000000-0000-4000-8000-000000000001",
          byteLength: 123,
          displayName: "layout.png",
          kind: "image",
          mediaType: "image/png",
          storageKey: "/workspace/layout.png",
        },
      ],
      chatId: fixture.chatId,
      content: "这张图有什么问题？",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(prepare).toHaveBeenCalledWith("/workspace/layout.png");
    const input = fixture.provider.requests[0]?.input[0];
    expect(input).toMatchObject({ role: "user", type: "message" });
    expect(JSON.stringify(input)).toContain('"type":"input_image"');
    expect(JSON.stringify(input)).toContain("data:image/png;base64,");
    expect(JSON.stringify(input)).not.toContain("/workspace/layout.png");
    fixture.database.close();
  });

  it("persists image references while materializing pixels only for the Provider", async () => {
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const prepare = vi.fn<ImageInputProvider["prepare"]>(() =>
      Promise.resolve(preparedImage("cGl4ZWxz")),
    );
    const fixture = await createFixture(
      [
        async () => {
          await turnGate;
          return [
            { delta: "我已读取图片", type: "text.delta" },
            complete("response-image-reference"),
          ];
        },
      ],
      new SystemClock(),
      undefined,
      { prepare },
    );

    const run = await fixture.runtime.start({
      attachments: [
        {
          artifactId: "20000000-0000-4000-8000-000000000004",
          displayName: "layout.png",
          kind: "image",
          mediaType: "image/png",
          storageKey: "/workspace/layout.png",
        },
      ],
      chatId: fixture.chatId,
      content: "读取这张图",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await vi.waitFor(() => expect(fixture.provider.requests).toHaveLength(1));

    const checkpoint = JSON.stringify(fixture.checkpoints.get(run.id)?.context);
    expect(checkpoint).toContain("charamate_image_reference");
    expect(checkpoint).toContain("/workspace/layout.png");
    expect(checkpoint).not.toContain("data:image");
    expect(checkpoint).not.toContain("cGl4ZWxz");
    expect(JSON.stringify(fixture.provider.requests[0]?.input)).toContain(
      "data:image/png;base64,cGl4ZWxz",
    );

    releaseTurn?.();
    await waitForStatus(fixture, run.id, "completed");
    fixture.database.close();
  });

  it("rejects image input before the request when model metadata says vision is unsupported", async () => {
    const prepare = vi.fn<ImageInputProvider["prepare"]>(() =>
      Promise.resolve(preparedImage("aW1hZ2U=")),
    );
    const fixture = await createFixture(
      [finalTurn("不应发送")],
      new SystemClock(),
      undefined,
      { prepare },
      { effectiveInputTokens: 100_000, supportsVision: false },
    );

    await expect(
      fixture.runtime.start({
        attachments: [
          {
            artifactId: "20000000-0000-4000-8000-000000000003",
            displayName: "unsupported.png",
            kind: "image",
            storageKey: "/workspace/unsupported.png",
          },
        ],
        chatId: fixture.chatId,
        content: "读取图片",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      }),
    ).rejects.toMatchObject({ code: "AGENT.IMAGE_INPUT_UNAVAILABLE" });
    expect(prepare).not.toHaveBeenCalled();
    expect(fixture.provider.requests).toHaveLength(0);
    fixture.database.close();
  });

  it("loads image.inspect pixels into the next Agent model turn", async () => {
    const prepare = vi.fn<ImageInputProvider["prepare"]>(() =>
      Promise.resolve(preparedImage("aW1hZ2U=")),
    );
    const fixture = await createFixture(
      [
        namespacedFunctionTurn("inspect-1", "inspect", "image", {
          path: "run/image.png",
        }),
        () => {
          throw new ProviderError(
            "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
            "context is full",
            true,
          );
        },
        finalTurn("图片是一张界面截图"),
      ],
      new SystemClock(),
      undefined,
      { prepare },
    );

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(prepare).toHaveBeenCalledWith("run/image.png");
    expect(
      fixture.provider.requests[0]?.toolNamespaces.find(
        ({ name }) => name === "image",
      )?.tools[0],
    ).toMatchObject({ deferLoading: false, name: "image.inspect" });
    const continued = JSON.stringify(fixture.provider.requests[1]?.input);
    expect(continued).toContain('"call_id":"inspect-1"');
    expect(continued).toContain('"type":"input_image"');
    expect(continued).toContain("data:image/png;base64,aW1hZ2U=");
    const compacted = JSON.stringify(fixture.provider.requests[2]?.input);
    expect(compacted).toContain("完成测试任务");
    expect(compacted).toContain('"type":"input_image"');
    expect(compacted).toContain("data:image/png;base64,aW1hZ2U=");
    expect(
      fixture.runs
        .listRunItems(run.id)
        .find(
          ({ input }) =>
            typeof input === "object" &&
            input !== null &&
            !Array.isArray(input) &&
            input["toolName"] === "image.inspect",
        ),
    ).toMatchObject({ status: "completed" });
    fixture.database.close();
  });

  it("reports an explicit capability error when a Provider rejects image input", async () => {
    const fixture = await createFixture(
      [
        () => {
          throw new ProviderError(
            "PROVIDER.REQUEST_FAILED",
            "bad request",
            false,
          );
        },
      ],
      new SystemClock(),
      undefined,
      { prepare: () => Promise.resolve(preparedImage("aW1hZ2U=")) },
    );

    const run = await fixture.runtime.start({
      attachments: [
        {
          artifactId: "20000000-0000-4000-8000-000000000002",
          displayName: "unsupported.png",
          kind: "image",
          storageKey: "/workspace/unsupported.png",
        },
      ],
      chatId: fixture.chatId,
      content: "读取图片",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "failed");

    expect(fixture.runs.getRun(run.id)?.error).toMatchObject({
      code: "PROVIDER.IMAGE_INPUT_UNAVAILABLE",
      retryable: false,
    });
    fixture.database.close();
  });

  it("keeps a transient Provider image request failure retryable", async () => {
    const fixture = await createFixture(
      [
        () => {
          throw new ProviderError(
            "PROVIDER.REQUEST_FAILED",
            "temporary upstream failure",
            true,
          );
        },
      ],
      new SystemClock(),
      undefined,
      { prepare: () => Promise.resolve(preparedImage("aW1hZ2U=")) },
    );

    const run = await fixture.runtime.start({
      attachments: [
        {
          artifactId: "20000000-0000-4000-8000-000000000003",
          displayName: "retryable.png",
          kind: "image",
          storageKey: "/workspace/retryable.png",
        },
      ],
      chatId: fixture.chatId,
      content: "读取图片",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "interrupted");

    expect(fixture.runs.getRun(run.id)?.error).toMatchObject({
      code: "PROVIDER.REQUEST_FAILED",
      retryable: true,
    });
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

  it("persists one Chat summary across Runs and restart without trimming UI history", async () => {
    const limits = { effectiveInputTokens: 1_000 };
    const fixture = await createFixture(
      [
        finalTurnWithUsage("第一轮回答", 1_000),
        chatSummaryTurn("第一轮摘要：用户询问第一轮问题，助手已回答。"),
        finalTurnWithUsage("第二轮回答", 1),
      ],
      undefined,
      undefined,
      undefined,
      limits,
    );

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

    expect(fixture.provider.requests).toHaveLength(3);
    const secondInput = JSON.stringify(fixture.provider.requests[2]?.input);
    expect(secondInput).toContain("第一轮摘要");
    expect(secondInput).toContain("第二轮问题");
    expect(fixture.provider.requests[2]?.input).not.toContainEqual({
      content: "第一轮问题",
      role: "user",
      type: "message",
    });
    expect(fixture.provider.requests[2]?.input).not.toContainEqual({
      content: "第一轮回答",
      role: "assistant",
      type: "message",
    });

    const snapshot = new ChatRepository(fixture.database).getContextSnapshot(
      fixture.chatId,
    );
    expect(snapshot).toMatchObject({
      generation: 1,
      lastInputTokens: 1,
      summary: "第一轮摘要：用户询问第一轮问题，助手已回答。",
    });

    const restartedProvider = new ScriptedProvider(
      [finalTurnWithUsage("第三轮回答", 1)],
      limits,
    );
    const restartedRuntime = createRuntimeFor(fixture, restartedProvider);
    await restartedRuntime.initialize();
    const third = await restartedRuntime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "第三轮问题",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, third.id, "completed");

    expect(restartedProvider.requests).toHaveLength(1);
    const thirdInput = JSON.stringify(restartedProvider.requests[0]?.input);
    expect(thirdInput).toContain("第一轮摘要");
    expect(thirdInput).toContain("第二轮问题");
    expect(thirdInput).toContain("第二轮回答");
    expect(thirdInput).toContain("第三轮问题");
    expect(restartedProvider.requests[0]?.input).not.toContainEqual({
      content: "第一轮问题",
      role: "user",
      type: "message",
    });
    expect(restartedProvider.requests[0]?.input).not.toContainEqual({
      content: "第一轮回答",
      role: "assistant",
      type: "message",
    });

    const messages = new ChatRepository(fixture.database).listMessages(
      fixture.chatId,
    );
    expect(messages.map(({ content }) => content)).toEqual([
      "第一轮问题",
      "第一轮回答",
      "第二轮问题",
      "第二轮回答",
      "第三轮问题",
      "第三轮回答",
    ]);
    expect(
      fixture.provider.requests.filter(({ instructions }) =>
        instructions.includes("CharaMate conversation working memory"),
      ),
    ).toHaveLength(1);
    fixture.database.close();
  });

  it("keeps the previous Snapshot and does not allocate a Run when summarization fails", async () => {
    const fixture = await createFixture(
      [
        finalTurnWithUsage("已完成的旧回答", 1_000),
        () => {
          throw new ProviderError(
            "PROVIDER.UNREACHABLE",
            "summary provider unavailable",
            true,
          );
        },
      ],
      undefined,
      undefined,
      undefined,
      { effectiveInputTokens: 1_000 },
    );
    const first = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "已完成的旧问题",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, first.id, "completed");

    await expect(
      fixture.runtime.start({
        attachments: [],
        chatId: fixture.chatId,
        content: "不应被持久化的新问题",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER.UNREACHABLE" });

    expect(fixture.runs.getSnapshot(fixture.chatId).runs).toHaveLength(1);
    expect(
      new ChatRepository(fixture.database).getContextSnapshot(fixture.chatId),
    ).toMatchObject({ generation: 0, summary: "" });
    expect(
      new ChatRepository(fixture.database)
        .listMessages(fixture.chatId)
        .map(({ content }) => content),
    ).toEqual(["已完成的旧问题", "已完成的旧回答"]);
    fixture.database.close();
  });

  it("turns a first-request context-limit recovery into durable Chat state", async () => {
    const fixture = await createFixture([
      finalTurnWithUsage("旧回答", 64),
      finalTurnWithUsage("第二个旧回答", 64),
      () => {
        throw new ProviderError(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          "context is full",
          true,
        );
      },
      chatSummaryTurn("旧对话摘要：旧问题已经得到回答。"),
      chatSummaryTurn(
        "旧对话摘要：两个旧问题都已经得到回答。",
        "旧问题已经得到回答",
      ),
      finalTurnWithUsage("恢复后的回答", 1),
      finalTurnWithUsage("后续回答", 1),
    ]);

    const first = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "旧问题",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, first.id, "completed");
    const secondPrior = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "第二个旧问题",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, secondPrior.id, "completed");
    fixture.database
      .prepare("DELETE FROM chat_context_snapshots WHERE chat_id = ?")
      .run(fixture.chatId);

    const recovered = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "触发恢复",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, recovered.id, "completed");
    const next = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "恢复后的下一轮",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, next.id, "completed");

    expect(JSON.stringify(fixture.provider.requests[2]?.input)).toContain(
      "旧问题",
    );
    expect(fixture.provider.requests[3]?.instructions).toContain(
      "CharaMate conversation working memory",
    );
    expect(fixture.provider.requests[4]?.instructions).toContain(
      "CharaMate conversation working memory",
    );
    const retryInput = JSON.stringify(fixture.provider.requests[5]?.input);
    expect(retryInput).toContain("旧对话摘要");
    expect(retryInput).toContain("触发恢复");
    expect(fixture.provider.requests[5]?.input).not.toContainEqual({
      content: "旧问题",
      role: "user",
      type: "message",
    });
    expect(fixture.provider.requests[5]?.input).not.toContainEqual({
      content: "旧回答",
      role: "assistant",
      type: "message",
    });
    expect(fixture.provider.requests[5]?.input).not.toContainEqual({
      content: "第二个旧问题",
      role: "user",
      type: "message",
    });
    expect(fixture.provider.requests[5]?.input).not.toContainEqual({
      content: "第二个旧回答",
      role: "assistant",
      type: "message",
    });
    const nextInput = JSON.stringify(fixture.provider.requests[6]?.input);
    expect(nextInput).toContain("旧对话摘要");
    expect(fixture.provider.requests[6]?.input).not.toContainEqual({
      content: "旧问题",
      role: "user",
      type: "message",
    });
    expect(
      fixture.runs
        .listRunItems(recovered.id)
        .find(({ kind }) => kind === "context_compaction"),
    ).toMatchObject({ status: "completed" });
    expect(
      new ChatRepository(fixture.database).getContextSnapshot(fixture.chatId),
    ).toMatchObject({ generation: 2 });
    fixture.database.close();
  });

  it("loads core local tools and calls file.list without a Tool Search round trip", async () => {
    const fixture = await createFixture([
      namespacedFunctionTurn("list-core", "list", "file", { value: "." }),
      finalTurn("已列出目录"),
    ]);
    let listCalls = 0;
    registerTool(fixture, {
      execute: () => {
        listCalls += 1;
        return Promise.resolve(successfulResult("listed"));
      },
      name: "file.list",
      namespace: "file",
    });
    for (const name of ["file.read", "file.search"] as const) {
      registerTool(fixture, {
        execute: () => Promise.resolve(successfulResult("read")),
        name,
        namespace: "file",
      });
    }
    for (const name of ["file.patch", "file.write"] as const) {
      registerTool(fixture, {
        effect: "write",
        execute: () => Promise.resolve(successfulResult("wrote")),
        idempotency: "non_idempotent",
        name,
        namespace: "file",
      });
    }
    registerTool(fixture, {
      effect: "critical",
      execute: () => Promise.resolve(successfulResult("trashed")),
      idempotency: "non_idempotent",
      name: "file.trash",
      namespace: "file",
    });
    registerTool(fixture, {
      effect: "write",
      execute: () => Promise.resolve(successfulResult("ran")),
      idempotency: "non_idempotent",
      name: "command.run",
      namespace: "command",
    });
    registerTool(fixture, {
      execute: () => Promise.resolve(successfulResult("special")),
      name: "test.special",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(listCalls).toBe(1);
    expect(fixture.provider.requests).toHaveLength(2);
    const coreTools = fixture.provider.requests[0]?.toolNamespaces
      .filter(({ name }) => name === "command" || name === "file")
      .flatMap(({ tools }) => tools);
    expect(coreTools).toHaveLength(7);
    expect(coreTools?.every(({ deferLoading }) => deferLoading === false)).toBe(
      true,
    );
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "file")
        ?.tools.find(({ name }) => name === "file.list"),
    ).toMatchObject({ deferLoading: false });
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "command")
        ?.tools.find(({ name }) => name === "command.run"),
    ).toMatchObject({ deferLoading: false });
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "test")
        ?.tools.find(({ name }) => name === "test.special"),
    ).toMatchObject({ deferLoading: true });
    expect(fixture.provider.requests[0]?.instructions).toContain(
      "Core local file and command capabilities are already loaded",
    );
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).not.toContain(
      "tool_search_output",
    );
    fixture.database.close();
  });

  it("keeps write-capable core tools behind Agent approval", async () => {
    const fixture = await createFixture([
      namespacedFunctionTurn("write-core", "write", "file", { value: "x" }),
      finalTurn("未写入"),
    ]);
    let writeCalls = 0;
    registerTool(fixture, {
      effect: "write",
      execute: () => {
        writeCalls += 1;
        return Promise.resolve(successfulResult("wrote"));
      },
      idempotency: "non_idempotent",
      name: "file.write",
      namespace: "file",
    });

    const run = await startAgent(fixture, "request_approval");
    await waitForStatus(fixture, run.id, "waiting_approval");

    expect(writeCalls).toBe(0);
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "file")
        ?.tools.find(({ name }) => name === "file.write"),
    ).toMatchObject({ deferLoading: false });
    const approval = fixture.runtime.getPendingApproval();
    expect(approval).not.toBeNull();
    fixture.runtime.resolveApproval({
      approvalId: approval!.id,
      decidedAt: REQUESTED_AT,
      decision: "rejected",
      reason: "测试权限边界",
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(writeCalls).toBe(0);
    fixture.database.close();
  });

  it("exposes only read-only core tools in Chat mode", async () => {
    const fixture = await createFixture([finalTurn("只读回答")]);
    registerTool(fixture, {
      execute: () => Promise.resolve(successfulResult("read")),
      name: "file.read",
      namespace: "file",
    });
    registerTool(fixture, {
      effect: "write",
      execute: () => Promise.resolve(successfulResult("wrote")),
      idempotency: "non_idempotent",
      name: "file.write",
      namespace: "file",
    });
    registerTool(fixture, {
      effect: "write",
      execute: () => Promise.resolve(successfulResult("ran")),
      idempotency: "non_idempotent",
      name: "command.run",
      namespace: "command",
    });

    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "读取当前文件",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    const firstRequest = fixture.provider.requests[0];
    expect(
      firstRequest?.toolNamespaces
        .find(({ name }) => name === "file")
        ?.tools.map(({ name }) => name),
    ).toEqual(["file.read"]);
    expect(
      firstRequest?.toolNamespaces.find(({ name }) => name === "file")
        ?.tools[0],
    ).toMatchObject({ deferLoading: false });
    expect(
      firstRequest?.toolNamespaces.some(({ name }) => name === "command"),
    ).toBe(false);
    fixture.database.close();
  });

  it("keeps core local tools callable after Tool Search narrows the deferred scope", async () => {
    const fixture = await createFixture([
      searchTurn("search-special", "file list special"),
      namespacedFunctionTurn("list-after-search", "list", "file", {
        value: ".",
      }),
      finalTurn("核心能力仍可用"),
    ]);
    let listCalls = 0;
    registerTool(fixture, {
      execute: () => {
        listCalls += 1;
        return Promise.resolve(successfulResult("listed"));
      },
      name: "file.list",
      namespace: "file",
    });
    registerTool(fixture, {
      execute: () => Promise.resolve(successfulResult("special")),
      name: "test.special",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(listCalls).toBe(1);
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
      "test.special",
    );
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).not.toContain(
      "file.list",
    );
    expect(fixture.provider.requests[1]?.allowedTools).toEqual(
      expect.arrayContaining([
        { name: "file.list", namespace: "file" },
        { name: "test.special", namespace: "test" },
      ]),
    );
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).not.toContain(
      "TOOL.SCOPE_NOT_ALLOWED",
    );
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
      fixture.provider.requests[0]?.toolNamespaces.find(
        ({ name }) => name === "test",
      )?.tools[0],
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

  it("rejects a deferred Tool that Tool Search did not load", async () => {
    const fixture = await createFixture([
      searchTurn("search-allowed", "allowed"),
      functionTurn("call-blocked", "test.blocked", {}),
      finalTurn("未执行未加载能力"),
    ]);
    let blockedCalls = 0;
    registerTool(fixture, {
      execute: () => Promise.resolve(successfulResult("allowed")),
      name: "test.allowed",
    });
    registerTool(fixture, {
      execute: () => {
        blockedCalls += 1;
        return Promise.resolve(successfulResult("blocked"));
      },
      name: "test.blocked",
    });

    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");

    expect(blockedCalls).toBe(0);
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).toContain(
      "TOOL.SCOPE_NOT_ALLOWED",
    );
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
      { name: "request_user_input", namespace: "interaction" },
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
      { name: "request_user_input", namespace: "interaction" },
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
    expect(fixture.checkpoints.get(run.id)?.context).toMatchObject({
      contextLimits: {
        effectiveInputTokens: 922_000,
        maxContextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        maxPromptTokens: 922_000,
      },
    });

    const resumedProvider = new ScriptedProvider([finalTurn("恢复完成")], {
      effectiveInputTokens: 32_000,
      maxPromptTokens: 32_000,
    });
    const resumedRuntime = createRuntimeFor(fixture, resumedProvider);
    await resumedRuntime.resume({ requestedAt: REQUESTED_AT, runId: run.id });
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(1);
    expect(fixture.provider.contextLimitRequests).toEqual(["gpt-5.6-sol"]);
    expect(resumedProvider.contextLimitRequests).toEqual([]);
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
