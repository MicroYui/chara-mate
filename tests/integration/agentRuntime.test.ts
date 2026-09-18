import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../fixtures/formationModel";
import { estimatedCognitionContextTokens } from "../../src/main/agent/cognitionContext";
import {
  estimateInputBudget,
  fitsInputBudget,
} from "../../src/main/providers/inputBudget";
import type { CognitionPreparedContext } from "../../src/shared/contracts/cognition";
import type { CognitionServiceContract } from "../../src/main/cognition/cognitionTypes";
import type { MemoryEmbeddingProvider } from "../../src/main/memory/memoryModels";
import { LocalEmbedding } from "../../src/main/providers/localEmbedding";
import { searchMemoryVectors } from "../../src/main/memory/memoryVectorSearch";
import { runMemoryIntake } from "../../src/main/app/runMemoryIntake";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { AttachmentInputProvider } from "../../src/main/agent/attachmentInput";
import { ChatContextService } from "../../src/main/agent/chatContextService";
import {
  ACTIVITY_OBSERVE_TOOL_NAME,
  ACTIVITY_SEARCH_TOOL_NAME,
  registerActivityTool,
} from "../../src/main/activity/activityTool";
import { ActivityAssetStore } from "../../src/main/activity/activityAssetStore";
import { ActivityRepository } from "../../src/main/activity/activityRepository";
import { ActivityService } from "../../src/main/activity/activityService";
import {
  visualFrameFixture,
  visualSurfaceFixture,
} from "../../src/main/activity/activityVisual.fixture";
import type {
  ActivityVisualLookupResult,
  ActivityVisualMatch,
} from "../../src/shared/contracts/activity";
import {
  COLLABORATION_DISPATCH_TOOL_NAME,
  registerCollaborationTool,
} from "../../src/main/agent/collaborationTool";
import type {
  ImageInputProvider,
  PreparedImageInput,
} from "../../src/main/agent/imageInput";
import { decodeRuntimeCheckpoint } from "../../src/main/agent/runtimeCheckpoint";
import { CheckpointRepository } from "../../src/main/agent/checkpointRepository";
import { registerPlanTool } from "../../src/main/agent/planTool";
import type {
  ModelContextLimits,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelUsage,
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
  type ToolExecutionContext,
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

  measureInput(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.estimateInput(request));
  }
  estimateInput(request: ModelRequest) {
    return estimateInputBudget(request, request.modelId);
  }

  resolveContextLimits(modelId: string, signal?: AbortSignal) {
    this.contextLimitRequests.push(modelId);
    signal?.throwIfAborted();
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
  readonly writer: RunEventWriter;
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

function searchTurn(callId: string, query: string, limit = 8): Turn {
  return () => [
    {
      item: {
        arguments: { limit, query },
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
  attachmentInputs?: AttachmentInputProvider,
  beforeUserInteraction?: (continuingRunId?: string) => Promise<void>,
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
    undefined,
    attachmentInputs,
    beforeUserInteraction,
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
    writer,
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
  cognition?: Pick<CognitionServiceContract, "prepareTurn">,
  chatContext?: ChatContextService,
  beforeUserInteraction?: (continuingRunId?: string) => Promise<void>,
  images?: ImageInputProvider,
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
    images,
    cognition,
    chatContext,
    undefined,
    beforeUserInteraction,
  );
}

function createMemoryFor(
  fixture: RuntimeFixture,
  embedding?: MemoryEmbeddingProvider,
) {
  const clock = new SystemClock();
  const repository = new MemoryRepository(fixture.database);
  const formation: FormationModelMock = {
    version: "run-source-fixture-v1",
    form: vi.fn<FormationModelMock["form"]>(({ episode }) =>
      Promise.resolve({
        entities: [],
        units: episode.sources
          .filter(
            (source) =>
              source.speaker !== "assistant" &&
              (!episode.evidenceSourceIds ||
                episode.evidenceSourceIds.includes(source.id)),
          )
          .map((source) => ({
            operation: "create" as const,
            type: "event" as const,
            content: source.content,
            semantics: {
              kind: "episode" as const,
              owner: "user" as const,
              basis:
                source.speaker === "user"
                  ? ("explicit_user_statement" as const)
                  : ("direct_observation" as const),
              qualifiers: {},
            },
            entityKeys: [],
            citations: [{ sourceId: source.id, quote: source.content }],
            links: [],
          })),
      }),
    ),
  };
  // Deterministic numerical adapters exercise real SQL/formation/recall contracts;
  // language quality is measured in the separate real-model development evaluation.
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(fixture.database, repository, clock),
    new CryptoIdGenerator(),
    clock,
    {
      embedding: embedding ?? {
        modelKey: "run-numeric-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: (texts) =>
          Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
        embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
      },
      vectorSearch: {
        search: ({ query, plan, modelKey, now, limit }, signal) =>
          Promise.resolve(
            searchMemoryVectors(
              query,
              repository.recall.vectors(plan, modelKey, now),
              limit,
              () => signal?.throwIfAborted(),
            ),
          ),
      },
      selector: {
        select: ({ plan, candidates }) =>
          Promise.resolve({
            selected: candidates.map(({ revisionId }) => ({
              revisionId,
              questionIds: plan.questions.map(({ id }) => id),
            })),
            coverage: plan.questions.map(({ id }) => ({
              questionId: id,
              status: candidates.length ? "supported" : "missing",
              revisionIds: candidates.map(({ revisionId }) => revisionId),
            })),
          }),
      },
      formation: formationRuntime(formation),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 8000 }),
    },
  );
  return { memory, formation, repository };
}

function emptyCognition(): CognitionPreparedContext {
  return { text: "", situationIds: [], intentIds: [], evidenceIds: [] };
}

function registerRunFormation(
  fixture: RuntimeFixture,
  memory: MemoryService,
): void {
  registerMemoryFormationTool(fixture.tools, memory, (runId, itemId) =>
    runMemoryIntake(
      fixture.runs.getRun(runId)!,
      fixture.runs,
      new ChatRepository(fixture.database),
      itemId,
    ),
  );
}

function expectNoPersistedRunOrMessage(fixture: RuntimeFixture): void {
  expect(
    fixture.database.prepare("SELECT COUNT(*) AS count FROM runs").get(),
  ).toEqual({ count: 0 });
  expect(
    fixture.database.prepare("SELECT COUNT(*) AS count FROM messages").get(),
  ).toEqual({ count: 0 });
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
    readonly description?: string;
    readonly effect?: "read" | "write" | "critical";
    readonly execute: (
      input: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
      context: ToolExecutionContext,
    ) => Promise<ToolResult>;
    readonly idempotency?: "idempotent" | "non_idempotent";
    readonly name: string;
    readonly namespace?: string;
    readonly recoveryGroup?: string;
  },
): void {
  fixture.tools.register({
    descriptor: {
      description: input.description ?? `Test capability ${input.name}`,
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
    execute: (arguments_, context) =>
      input.execute(arguments_, context.signal, context),
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
  it.each([
    { label: "unreported", usage: {} },
    { label: "output only", usage: { outputTokens: 7 } },
    {
      label: "reported zero",
      usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
    },
    { label: "known input only", usage: { inputTokens: 123 } },
  ] satisfies readonly { label: string; usage: ModelUsage }[])(
    "persists $label usage in actual Run items and checkpoints without inventing Chat calibration",
    async ({ usage }) => {
      const ask = namespacedFunctionTurn(
        "usage-input",
        "request_user_input",
        "interaction",
        {
          questions: [
            {
              id: "scope",
              header: "范围",
              question: "接下来核对哪部分？",
              options: [
                { label: "代码", description: "核对当前代码。" },
                { label: "日志", description: "核对现有日志。" },
              ],
            },
          ],
        },
      );
      const fixture = await createFixture([
        async (request, signal) =>
          (await ask(request, signal)).map((event) =>
            event.type === "response.completed" ? { ...event, usage } : event,
          ),
      ]);
      try {
        const chats = new ChatRepository(fixture.database);
        const prior = chats.recordContextUsage({
          chatId: fixture.chatId,
          inputTokens: 100,
          modelId: "gpt-5.6-sol",
          requestBytes: 1_000,
          updatedAt: REQUESTED_AT,
        });
        const run = await fixture.runtime.start({
          attachments: [],
          chatId: fixture.chatId,
          content: "先确认范围",
          execution: { mode: "chat" },
          providerProfileId: PROFILE_ID,
          requestedAt: REQUESTED_AT,
        });
        await waitForStatus(fixture, run.id, "needs_input");
        const assistant = fixture.runs
          .listRunItems(run.id)
          .find(({ kind }) => kind === "assistant_message");
        const savedOutput = assistant?.output;
        if (
          !savedOutput ||
          typeof savedOutput !== "object" ||
          Array.isArray(savedOutput)
        ) {
          throw new Error("Missing persisted assistant output");
        }
        expect(savedOutput["usage"]).toEqual(usage);
        const savedContext = fixture.checkpoints.get(run.id)?.context;
        if (
          !savedContext ||
          typeof savedContext !== "object" ||
          Array.isArray(savedContext)
        ) {
          throw new Error("Missing persisted waiting checkpoint");
        }
        expect(savedContext["lastUsage"]).toEqual(usage);
        expect(fixture.checkpoints.get(run.id)?.phase).toBe("input");
        expect(fixture.runs.getRun(run.id)?.error).toBeUndefined();
        if (typeof usage.inputTokens === "number" && usage.inputTokens > 0) {
          expect(chats.getContextSnapshot(fixture.chatId)).toMatchObject({
            lastInputTokens: usage.inputTokens,
            lastRequestBytes: savedContext["lastRequestBytes"],
          });
        } else {
          expect(chats.getContextSnapshot(fixture.chatId)).toEqual(prior);
        }
      } finally {
        try {
          await fixture.runtime.interruptAll();
        } finally {
          fixture.database.close();
        }
      }
    },
  );

  it.each(
    (["selected", "chat"] as const).flatMap((scope) =>
      [
        "current layout",
        "+test.blocked_0 current layout",
        `${Array.from({ length: 8 }, (_, index) => `test.blocked_${String(index)}`).join(" ")} test.allowed`,
      ].map((query) => ({ scope, query })),
    ),
  )(
    "finds an available Tool beyond eight unavailable matches: $scope / $query",
    async ({ scope, query }) => {
      const fixture = await createFixture([
        searchTurn("find-available-layout", query, 1),
        (request, signal) => {
          const output = request.input.find(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              !Array.isArray(item) &&
              item["type"] === "tool_search_output",
          );
          return JSON.stringify(output).includes('"test.allowed"')
            ? functionTurn(
                "read-available-layout",
                "test.allowed",
                {},
              )(request, signal)
            : finalTurn("没有找到可用的读取工具。")(request, signal);
        },
        finalTurn("已通过可用工具读取当前布局。"),
      ]);
      let reads = 0;
      try {
        for (let index = 0; index < 8; index += 1)
          registerTool(fixture, {
            name: `test.blocked_${String(index)}`,
            description: "current layout",
            effect: "write",
            idempotency: "non_idempotent",
            execute: () => {
              throw new Error("An unavailable tool must not execute");
            },
          });
        registerTool(fixture, {
          name: "test.allowed",
          description:
            "Read the current layout, including furniture dimensions, windows, lighting, seating, storage, materials, orientation, floor surfaces and object positions.",
          execute: () => {
            reads += 1;
            return Promise.resolve(successfulResult("current layout"));
          },
        });
        // The global top eight are all unavailable for this Run.
        expect(
          fixture.tools
            .search(query, 99)
            .map(({ descriptor }) => descriptor.name),
        ).not.toContain("test.allowed");
        const request = {
          attachments: [],
          chatId: fixture.chatId,
          content: "读取当前布局。",
          execution:
            scope === "chat"
              ? { mode: "chat" as const }
              : {
                  mode: "agent" as const,
                  approvalMode: "full_access" as const,
                },
          providerProfileId: PROFILE_ID,
          requestedAt: REQUESTED_AT,
        };
        const run =
          scope === "selected"
            ? await fixture.runtime.startAutomation(request, {
                modelId: "gpt-5.6-sol",
                persona: defaultPersonaSnapshot(REQUESTED_AT),
                toolNames: ["test.allowed"],
              })
            : await fixture.runtime.start(request);
        await waitForStatus(fixture, run.id, "completed");
        expect(fixture.provider.requests[1]?.input).toContainEqual(
          expect.objectContaining({
            type: "tool_search_output",
            call_id: "find-available-layout",
            tools: [
              expect.objectContaining({
                name: "test",
                tools: [expect.objectContaining({ name: "test.allowed" })],
              }),
            ],
          }),
        );
        expect(reads).toBe(1);
        expect(fixture.provider.requests[1]?.allowedTools).toEqual([
          { name: "request_user_input", namespace: "interaction" },
          { name: "test.allowed", namespace: "test" },
        ]);
        expect(fixture.runs.getRun(run.id)?.error).toBeUndefined();
      } finally {
        fixture.database.close();
      }
    },
  );

  it.each([
    "+territory.observe",
    "territory.observe 读取当前住处布局 revisionId targets",
  ])(
    "loads and executes an explicitly named Tool through native discovery: %s",
    async (query) => {
      const fixture = await createFixture([
        searchTurn("find-observation", query, 1),
        namespacedFunctionTurn("read-layout", "observe", "territory", {}),
        finalTurn("已读取当前布局"),
      ]);
      let reads = 0;
      registerTool(fixture, {
        name: "territory.observe",
        namespace: "territory",
        description: "Read the current layout and World revision.",
        execute: () => {
          reads += 1;
          return Promise.resolve(successfulResult("current layout"));
        },
      });
      registerTool(fixture, {
        name: "territory.act",
        namespace: "territory",
        description:
          "Use territory.observe before an action; territory.observe supplies revisionId targets.",
        execute: () => {
          throw new Error("A named read must not execute the related action");
        },
      });
      const run = await startAgent(fixture);
      await waitForStatus(fixture, run.id, "completed");
      expect(reads).toBe(1);
      expect(fixture.provider.requests[1]?.input).toContainEqual(
        expect.objectContaining({
          type: "tool_search_output",
          call_id: "find-observation",
          tools: [
            expect.objectContaining({
              name: "territory",
              tools: [expect.objectContaining({ name: "territory.observe" })],
            }),
          ],
        }),
      );
      expect(fixture.provider.requests[1]?.allowedTools).toEqual([
        { name: "request_user_input", namespace: "interaction" },
        { name: "territory.observe", namespace: "territory" },
      ]);
      expect(fixture.runs.getRun(run.id)?.error).toBeUndefined();
      fixture.database.close();
    },
  );

  it.each(["selected", "chat"] as const)(
    "filters a named unavailable Tool before returning discovery output: %s",
    async (scope) => {
      const fixture = await createFixture([
        searchTurn("find-current-layout", "test.blocked current layout", 1),
        functionTurn("read-current-layout", "test.allowed", {}),
        finalTurn("已读取允许的内容"),
      ]);
      let reads = 0;
      registerTool(fixture, {
        name: "test.allowed",
        description: "Read current layout.",
        execute: () => {
          reads += 1;
          return Promise.resolve(successfulResult("current layout"));
        },
      });
      registerTool(fixture, {
        name: "test.blocked",
        effect: "write",
        idempotency: "non_idempotent",
        execute: () => {
          throw new Error("The unavailable tool must never execute");
        },
      });
      const request = {
        attachments: [],
        chatId: fixture.chatId,
        content: "读取当前布局",
        execution:
          scope === "chat"
            ? { mode: "chat" as const }
            : { mode: "agent" as const, approvalMode: "full_access" as const },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      };
      const run =
        scope === "selected"
          ? await fixture.runtime.startAutomation(request, {
              modelId: "gpt-5.6-sol",
              persona: defaultPersonaSnapshot(REQUESTED_AT),
              toolNames: ["test.allowed"],
            })
          : await fixture.runtime.start(request);
      await waitForStatus(fixture, run.id, "completed");
      expect(reads).toBe(1);
      expect(fixture.provider.requests[1]?.input).toContainEqual(
        expect.objectContaining({
          type: "tool_search_output",
          tools: [
            expect.objectContaining({
              name: "test",
              tools: [expect.objectContaining({ name: "test.allowed" })],
            }),
          ],
        }),
      );
      expect(fixture.provider.requests[1]?.allowedTools).toEqual([
        { name: "request_user_input", namespace: "interaction" },
        { name: "test.allowed", namespace: "test" },
      ]);
      fixture.database.close();
    },
  );

  it("preserves only streamed text when cancellation precedes final display materialization", async () => {
    const raw = "已到达的内容。\uE200cite\uE202turn0search0\uE201";
    class PendingProvider extends ScriptedProvider {
      override async *stream(
        request: ModelRequest,
        signal: AbortSignal,
      ): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        yield { type: "text.delta", delta: raw };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("cancelled", "AbortError"),
              ),
            { once: true },
          );
        });
      }
    }
    const fixture = await createFixture([]);
    const runtime = createRuntimeFor(fixture, new PendingProvider([]));
    const run = await startAgent({ ...fixture, runtime });
    await fixture.collector.wait(({ event }) => event.type === "item.delta");
    const chats = new ChatRepository(fixture.database);
    expect(
      chats
        .listMessages(fixture.chatId)
        .find(({ role }) => role === "assistant"),
    ).toMatchObject({ content: raw, status: "streaming" });
    await runtime.cancel({ runId: run.id, requestedAt: REQUESTED_AT });
    await waitForStatus(fixture, run.id, "cancelled");
    expect(
      chats
        .listMessages(fixture.chatId)
        .filter(({ role }) => role === "assistant"),
    ).toEqual([expect.objectContaining({ content: raw, status: "cancelled" })]);
    expect(
      fixture.runs
        .listRunItems(run.id)
        .some(({ displayOutput }) => displayOutput?.includes("https://")),
    ).toBe(false);
    fixture.database.close();
  });

  it.each(["completed", "needs_input"] as const)(
    "replaces the final display once at %s and preserves raw model context",
    async (status) => {
      const raw = "已核对来源。\uE200cite\uE202turn0search0\uE201";
      const display = '已核对来源。[1](<https://example.com/source> "来源")';
      const rawItem = {
        id: "message-source",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: raw,
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/source",
                title: "来源",
                start_index: 6,
                end_index: raw.length,
              },
            ],
          },
        ],
      };
      const fixture = await createFixture([
        () => [
          { type: "text.delta", delta: raw.slice(0, 6) },
          { type: "text.delta", delta: raw.slice(6) },
          { type: "output.item", item: rawItem },
          {
            type: "output.item",
            item: {
              type: "function_call",
              name:
                status === "needs_input" ? "request_user_input" : "test.read",
              ...(status === "needs_input" ? { namespace: "interaction" } : {}),
              call_id: "source-read",
              arguments:
                status === "needs_input"
                  ? JSON.stringify({
                      questions: [
                        {
                          id: "scope",
                          header: "下一步",
                          question: "要继续查哪一部分？",
                          options: [
                            { label: "代码", description: "核对当前代码。" },
                            { label: "日志", description: "核对现有日志。" },
                          ],
                        },
                      ],
                    })
                  : "{}",
            },
          },
          {
            type: "response.completed",
            responseId: "response-source",
            status: "completed",
            displayText: display,
            usage: { cachedInputTokens: 0, inputTokens: 64, outputTokens: 32 },
          },
        ],
        finalTurn("后续读取完成。"),
      ]);
      registerTool(fixture, {
        name: "test.read",
        execute: () => Promise.resolve(successfulResult("读取完成")),
      });
      const run = await startAgent(fixture);
      await waitForStatus(fixture, run.id, status);
      const messages = new ChatRepository(fixture.database)
        .listMessages(fixture.chatId)
        .filter(({ role }) => role === "assistant");
      expect(messages.map(({ content }) => content)).toEqual(
        status === "needs_input" ? [display] : [display, "后续读取完成。"],
      );
      const item = fixture.runs
        .listRunItems(run.id)
        .find(({ displayOutput }) => displayOutput === display)!;
      expect(item.status).toBe("completed");
      const deltas = fixture.collector.events.flatMap(({ event }) =>
        event.type === "item.delta" && event.itemId === item.id
          ? [event.delta]
          : [],
      );
      expect(
        deltas.map((delta) => (delta as { text: string }).text).join(""),
      ).toBe(raw);
      expect(
        fixture.collector.events.filter(
          ({ event }) =>
            event.type === "item.completed" && event.item.id === item.id,
        ),
      ).toHaveLength(1);
      const nextInput =
        status === "needs_input"
          ? (fixture.checkpoints.get(run.id)?.context as { input: JsonValue[] })
              .input
          : fixture.provider.requests[1]?.input;
      expect(nextInput).toContainEqual(rawItem);
      expect(JSON.stringify(nextInput)).not.toContain(display);
      fixture.database.close();
    },
  );

  it.each(["assistant", "automation"] as const)(
    "keeps %s triggers out of user history",
    async (origin) => {
      const fixture = await createFixture([finalTurn("我在这里。")]);
      const request = {
        attachments: [],
        chatId: fixture.chatId,
        content: "内部唤醒：继续角色日常",
        execution: { mode: "chat" as const },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      };
      const options = {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        toolNames: [],
      };
      const run =
        origin === "assistant"
          ? await fixture.runtime.startAssistantInitiated(request, options)
          : await fixture.runtime.startAutomation(request, options);
      await waitForStatus(fixture, run.id, "completed");
      expect(
        fixture.runs
          .listRunItems(run.id)
          .some(({ kind }) => kind === "user_message"),
      ).toBe(false);
      expect(
        new ChatRepository(fixture.database)
          .listRunMessages(run.id)
          .map(({ role }) => role),
      ).toEqual(["assistant"]);
      expect(fixture.provider.requests[0]?.input).toContainEqual(
        expect.objectContaining({
          role: "developer",
          content: request.content,
        }),
      );
      fixture.database.close();
    },
  );

  it.each([false, true])(
    "allows a host-authorized quiet life ending with prior action=%s without inventing a message",
    async (withAction) => {
      const fixture = await createFixture([
        ...(withAction ? [functionTurn("quiet-action", "test.write", {})] : []),
        () => [complete("quiet-final")],
      ]);
      const directory = await mkdtemp(path.join(os.tmpdir(), "quiet-life-"));
      temporaryDirectories.push(directory);
      const target = path.join(directory, "action.txt");
      registerTool(fixture, {
        name: "test.write",
        effect: "write",
        execute: async () => {
          await writeFile(target, "actual completed action", "utf8");
          return successfulResult("实际行动已完成");
        },
      });
      const run = await fixture.runtime.startAssistantInitiated(
        {
          attachments: [],
          chatId: fixture.chatId,
          content: "继续自己的日常，也可以安静休息。",
          execution: { mode: "agent", approvalMode: "full_access" },
          providerProfileId: PROFILE_ID,
          requestedAt: REQUESTED_AT,
        },
        {
          modelId: "gpt-6-astra",
          persona: defaultPersonaSnapshot(REQUESTED_AT),
          toolNames: ["test.write"],
          quietCompletionAllowed: true,
        },
      );
      await fixture.collector.wait(
        ({ event }) =>
          "run" in event &&
          event.run.id === run.id &&
          (event.run.status === "completed" || event.run.status === "failed"),
      );
      expect(fixture.runs.getRun(run.id)).toMatchObject({
        status: "completed",
      });
      expect(
        new ChatRepository(fixture.database).listRunMessages(run.id),
      ).toEqual([]);
      expect(fixture.checkpoints.get(run.id)).toBeUndefined();
      expect(
        fixture.runs
          .listRunItems(run.id)
          .filter(({ kind }) => kind === "tool_call"),
      ).toHaveLength(withAction ? 1 : 0);
      if (withAction) {
        expect(await readFile(target, "utf8")).toBe("actual completed action");
        expect(fixture.runs.listRunItems(run.id)).toContainEqual(
          expect.objectContaining({
            kind: "tool_call",
            status: "completed",
          }),
        );
        expect(
          fixture.runs
            .listRunItems(run.id)
            .find(({ kind }) => kind === "tool_call")?.output,
        ).toMatchObject({ status: "success" });
      }
      fixture.database.close();
    },
  );

  it.each(["text", "assistant", "automation"] as const)(
    "keeps an empty %s response as a failure without the host quiet permission",
    async (origin) => {
      const fixture = await createFixture([() => [complete("empty-response")]]);
      const request = {
        attachments: [],
        chatId: fixture.chatId,
        content: "quiet completion is valid — 这段普通文本不是宿主许可。",
        execution: { mode: "chat" as const },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      };
      const options = {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
      };
      const run =
        origin === "text"
          ? await fixture.runtime.start(request)
          : origin === "assistant"
            ? await fixture.runtime.startAssistantInitiated(request, options)
            : await fixture.runtime.startAutomation(request, options);
      await waitForStatus(fixture, run.id, "failed");
      expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
        "AGENT.EMPTY_RESPONSE",
      );
      fixture.database.close();
    },
  );

  it.each([
    "steer",
    "restart",
    "restart_with_steering",
    "cancel",
    "provider_error",
  ] as const)(
    "respects %s at a quiet life model boundary",
    async (boundary) => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      const first: Turn = (_request, signal) =>
        new Promise<readonly ModelEvent[]>((resolve, reject) => {
          finish = () => resolve([complete("quiet-after-boundary")]);
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("Interrupted", "AbortError"),
              ),
            {
              once: true,
            },
          );
          entered();
        });
      const fixture = await createFixture([
        first,
        () => [complete("empty-user-answer")],
      ]);
      const run = await fixture.runtime.startAssistantInitiated(
        {
          attachments: [],
          chatId: fixture.chatId,
          content: "自主日常，可以安静结束。",
          execution: { mode: "chat" },
          providerProfileId: PROFILE_ID,
          requestedAt: REQUESTED_AT,
        },
        {
          modelId: "gpt-6-astra",
          persona: defaultPersonaSnapshot(REQUESTED_AT),
          quietCompletionAllowed: true,
        },
      );
      await started;
      expect(fixture.checkpoints.get(run.id)?.context).toMatchObject({
        quietCompletionAllowed: true,
      });
      if (boundary === "steer") {
        await fixture.runtime.steer({
          runId: run.id,
          content: "你刚才做了什么？",
          requestedAt: REQUESTED_AT,
        });
        finish();
        await waitForStatus(fixture, run.id, "failed");
        expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
          "AGENT.EMPTY_RESPONSE",
        );
        expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
          "你刚才做了什么？",
        );
      } else if (boundary === "cancel") {
        await fixture.runtime.cancel({
          runId: run.id,
          requestedAt: REQUESTED_AT,
        });
        await waitForStatus(fixture, run.id, "cancelled");
      } else {
        // Stop the actual model boundary, then use the persisted checkpoint in
        // a new Runtime. The extra message models a crash after its durable
        // receipt but before merging it into that checkpoint.
        await fixture.runtime.interruptAll();
        await waitForStatus(fixture, run.id, "interrupted");
        if (boundary === "restart_with_steering") {
          const item = fixture.writer.startItem(run.id, "user_message", {
            content: "先回答我。",
            steering: true,
          });
          fixture.writer.completeItem(item.id, {
            status: "completed",
            output: {},
          });
        }
        const provider = new ScriptedProvider([
          boundary === "provider_error"
            ? () => {
                throw new ProviderError(
                  "PROVIDER.REQUEST_FAILED",
                  "实际请求失败",
                  false,
                );
              }
            : () => [complete("quiet-restored")],
        ]);
        const restarted = createRuntimeFor(fixture, provider);
        await restarted.initialize();
        await restarted.resume({ runId: run.id, requestedAt: REQUESTED_AT });
        const expected = boundary === "restart" ? "completed" : "failed";
        await waitForStatus(fixture, run.id, expected);
        if (boundary === "restart_with_steering") {
          expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
            "AGENT.EMPTY_RESPONSE",
          );
          expect(JSON.stringify(provider.requests[0]?.input)).toContain(
            "先回答我。",
          );
        }
        if (boundary === "provider_error")
          expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
            "PROVIDER.REQUEST_FAILED",
          );
      }
      expect(
        new ChatRepository(fixture.database)
          .listRunMessages(run.id)
          .filter(({ role }) => role === "assistant"),
      ).toEqual([]);
      fixture.database.close();
    },
  );

  it("uses an already decided assistant cognition context without preparing it again", async () => {
    const fixture = await createFixture([]);
    const provider = new ScriptedProvider([
      finalTurn("我刚刚想起了那片星空。"),
    ]);
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.reject(new Error("Must not prepare a decided initiative twice")),
    );
    const runtime = createRuntimeFor(fixture, provider, { prepareTurn });
    const run = await runtime.startAssistantInitiated(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "继续已经决策的角色日常",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        prepareCognitionContext: () => ({
          ...emptyCognition(),
          text: "已选择：分享刚刚形成的观星经历。",
        }),
      },
    );
    await waitForStatus(fixture, run.id, "completed");
    expect(prepareTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.requests[0]?.input)).toContain(
      "已选择：分享刚刚形成的观星经历",
    );
    fixture.database.close();
  });

  it("allocates a large necessary action context before compacting old Chat and saves only concrete context", async () => {
    const fixture = await createFixture(
      [
        finalTurn("旧会话已完成"),
        chatSummaryTurn("旧项目已结束；保留曾讨论过的材料清单。"),
        finalTurn("已依据当前条件完成。"),
      ],
      undefined,
      undefined,
      undefined,
      { effectiveInputTokens: 120_000 },
    );
    const first = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "past discussion: " + "x".repeat(65_000),
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, first.id, "completed");
    const context = {
      ...emptyCognition(),
      text: JSON.stringify({
        goal: "按当前图纸检查全部材料，旧图纸不可继续使用。",
        conditions: Array.from({ length: 240 }, (_, index) => ({
          part: `component-${index}`,
          original: `drawing-original-${index}`,
          revised: `drawing-revised-${index}`,
          detail: `required specification ${index}: ${"x".repeat(90)}`,
        })),
        counterevidence: "材料17已经撤回，不能安装；其余材料须以对应修订为准。",
      }),
    };
    const prepare = vi.fn(
      ({
        maxReadBytes,
        signal,
      }: {
        readonly maxReadBytes: number;
        readonly signal: AbortSignal;
      }) => {
        expect(signal.aborted).toBe(false);
        expect(maxReadBytes).toBeGreaterThan(32_768);
        expect(Buffer.byteLength(context.text)).toBeGreaterThan(32_768);
        return context;
      },
    );
    let stored = "";
    const run = await fixture.runtime.startAssistantInitiated(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "执行当前已选定的检查目标。",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        prepareCognitionContext: prepare,
        onStarted: (started) => {
          stored = JSON.stringify(fixture.checkpoints.get(started.id)!.context);
        },
      },
    );
    await waitForStatus(fixture, run.id, "completed");
    expect(prepare).toHaveBeenCalledOnce();
    expect(fixture.provider.requests).toHaveLength(3);
    expect(fixture.provider.requests[1]!.instructions).toContain(
      "conversation working memory",
    );
    const request = fixture.provider.requests[2]!;
    expect(request.input).toContainEqual({
      type: "message",
      role: "developer",
      content: context.text,
    });
    expect(JSON.stringify(request.input)).toContain("旧项目已结束");
    expect(
      fixture.provider.estimateInput(request).estimatedTokens,
    ).toBeLessThan(108_000);
    expect(stored).toContain("charamate_cognition_context");
    expect(stored).not.toContain("prepareCognitionContext");
    const messages = new ChatRepository(fixture.database).listMessages(
      fixture.chatId,
    );
    expect(messages[0]!.content).toHaveLength(65_017);
    fixture.database.close();
  });

  it.each(["fits", "too_large"] as const)(
    "counts complete mandatory action material before allocation when its estimate is oversized: %s",
    async (outcome) => {
      const fixture = await createFixture([]);
      const provider = new ScriptedProvider(
        [finalTurn("Complete material received")],
        {
          maxPromptTokens: 30_000,
        },
      );
      const measurements: ModelRequest[] = [];
      provider.measureInput = (request, signal) => {
        signal.throwIfAborted();
        measurements.push(structuredClone(request));
        return Promise.resolve({
          ...provider.estimateInput(request),
          exactInputTokens: outcome === "fits" ? 6_000 : 30_001,
        });
      };
      const runtime = createRuntimeFor(fixture, provider);
      const content = Array.from(
        { length: 600 },
        (_, index) =>
          `Required component ${index}: current revision ${index + 1}, exception ${index % 9}.`,
      ).join("\n");
      const context = { ...emptyCognition(), text: content };
      const prepare = vi.fn(({ signal }: { signal: AbortSignal }) => {
        signal.throwIfAborted();
        return context;
      });
      const pending = runtime.startAssistantInitiated(
        {
          attachments: [],
          chatId: fixture.chatId,
          content: "Execute the selected complete specification.",
          execution: { mode: "chat" },
          providerProfileId: PROFILE_ID,
          requestedAt: REQUESTED_AT,
        },
        {
          modelId: "gpt-6-astra",
          persona: defaultPersonaSnapshot(REQUESTED_AT),
          prepareCognitionContext: prepare,
        },
      );
      if (outcome === "fits") {
        const run = await pending;
        await waitForStatus(fixture, run.id, "completed");
        expect(provider.requests).toHaveLength(1);
        expect(JSON.stringify(provider.requests[0]!.input)).toContain(
          JSON.stringify(content).slice(1, -1),
        );
      } else {
        await expect(pending).rejects.toMatchObject({
          code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
        });
        expect(provider.requests).toHaveLength(0);
        expect(
          fixture.database.prepare("SELECT count(*) AS n FROM runs").get(),
        ).toEqual({ n: 0 });
        expect(
          new ChatRepository(fixture.database).listMessages(fixture.chatId),
        ).toEqual([]);
      }
      expect(prepare).toHaveBeenCalledOnce();
      expect(measurements.length).toBeGreaterThan(0);
      expect(
        measurements.every((request) =>
          JSON.stringify(request.input).includes("Required component 599"),
        ),
      ).toBe(true);
      expect(
        provider.estimateInput(measurements[0]!).estimatedTokens,
      ).toBeGreaterThan(30_000);
      fixture.database.close();
    },
  );

  it("omits optional background when only its frame would crowd out an otherwise valid ordinary message", async () => {
    const baseline = await createFixture([finalTurn("基准")]);
    const input = {
      attachments: [],
      content: "普通消息",
      execution: { mode: "chat" as const },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    };
    const first = await baseline.runtime.start({
      ...input,
      chatId: baseline.chatId,
    });
    await waitForStatus(baseline, first.id, "completed");
    const shell = baseline.provider.estimateInput(
      baseline.provider.requests[0]!,
    ).estimatedTokens;
    const remaining = Math.floor(
      estimatedCognitionContextTokens(emptyCognition()) / 2,
    );
    const provider = new ScriptedProvider([finalTurn("正常回复")], {
      effectiveInputTokens: Math.ceil((shell + remaining) / 0.9),
    });
    const fixture = await createFixture([]);
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.reject(new Error("Optional frame cannot fit")),
    );
    const runtime = createRuntimeFor(fixture, provider, { prepareTurn });
    const run = await runtime.start({ ...input, chatId: fixture.chatId });
    await waitForStatus(fixture, run.id, "completed");
    expect(prepareTurn).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.input).toEqual([
      { type: "message", role: "user", content: "普通消息" },
    ]);
    baseline.database.close();
    fixture.database.close();
  });

  it("accounts for the full instruction shell when rejecting a lower Provider limit before allocation", async () => {
    const fixture = await createFixture([], undefined, undefined, undefined, {
      effectiveInputTokens: 1_000,
    });
    await expect(startAgent(fixture)).rejects.toMatchObject({
      code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
    });
    expect(fixture.provider.requests).toEqual([]);
    expect(fixture.runs.getSnapshot(fixture.chatId).runs).toEqual([]);
    fixture.database.close();
  });

  it("does not launch a model when assistant initialization is cancelled at allocation", async () => {
    const fixture = await createFixture([]);
    const run = await fixture.runtime.startAssistantInitiated(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "角色日常",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        toolNames: [],
        onStarted: (created) => {
          void fixture.runtime.cancel({
            runId: created.id,
            requestedAt: REQUESTED_AT,
          });
        },
      },
    );
    await waitForStatus(fixture, run.id, "cancelled");
    expect(fixture.provider.requests).toHaveLength(0);
    fixture.database.close();
  });

  it("cancels model metadata preflight without creating a Run or User Message", async () => {
    const fixture = await createFixture([]);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markMetadataStarted!: () => void;
    const metadataStarted = new Promise<void>((resolve) => {
      markMetadataStarted = resolve;
    });
    vi.spyOn(fixture.provider, "resolveContextLimits").mockImplementation(
      (_modelId, signal) => {
        receivedSignal = signal;
        markMetadataStarted();
        return new Promise<ModelContextLimits>((_resolve, reject) => {
          if (!signal) {
            reject(new Error("missing metadata cancellation signal"));
            return;
          }
          const abort = () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("cancelled", "AbortError"),
            );
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    );

    const starting = fixture.runtime.start(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "取消模型元数据准备",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      { signal: controller.signal },
    );
    const cancelled = expect(starting).rejects.toMatchObject({
      name: "AbortError",
    });
    await metadataStarted;
    expect(receivedSignal?.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);

    await cancelled;
    expectNoPersistedRunOrMessage(fixture);
    fixture.database.close();
  });

  it("cancels Chat Context preflight before allocating a Run", async () => {
    const fixture = await createFixture([]);
    const clock = new SystemClock();
    const chatContext = new ChatContextService(
      new ChatRepository(fixture.database),
      clock,
      fixture.runs,
    );
    const runtime = createRuntimeFor(
      fixture,
      fixture.provider,
      undefined,
      chatContext,
    );
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    let releaseContext!: () => void;
    const contextRelease = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    vi.spyOn(chatContext, "prepare").mockImplementation(async (request) => {
      receivedSignal = request.signal;
      markContextStarted();
      await contextRelease;
      return { compacted: false, input: [], messages: [] };
    });

    const starting = runtime.start(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "取消上下文准备",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      { signal: controller.signal },
    );
    const cancelled = expect(starting).rejects.toMatchObject({
      name: "AbortError",
    });
    await contextStarted;
    expect(receivedSignal?.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
    releaseContext();

    await cancelled;
    expectNoPersistedRunOrMessage(fixture);
    fixture.database.close();
  });

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

  it("prepares an ordinary greeting without reading or injecting the full profile", async () => {
    const fixture = await createFixture([]);
    const { memory } = createMemoryFor(fixture);
    memory.create({
      type: "preference",
      claimSlot: "preference.hobbies",
      content: "用户长期游玩 CS2。",
      confidence: 1,
      importance: 0.5,
      reason: "用户说明",
      sources: [],
    });
    const recall = vi.spyOn(memory, "recall");
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.resolve(emptyCognition()),
    );
    registerMemoryTool(fixture.tools, memory, () => ({}));
    const provider = new ScriptedProvider([finalTurn("早上好。")]);
    const runtime = createRuntimeFor(fixture, provider, { prepareTurn });
    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "早上好",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");
    expect(prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        currentInput: "早上好",
        chatId: fixture.chatId,
      }),
    );
    expect(recall).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain("CS2");
    expect(
      provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "memory")
        ?.tools.find(({ name }) => name === "memory.search"),
    ).toMatchObject({ deferLoading: false });
    fixture.database.close();
  });

  it("materializes only the EvidencePack selected by cognition for the current Run", async () => {
    const fixture = await createFixture([]);
    const { memory, repository } = createMemoryFor(fixture);
    const chosen = memory.create({
      type: "event",
      content: "周末一起看到了流星。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    memory.create({
      type: "profile",
      content: "用户的无关个人资料。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    const evidence = repository.recall.evidence(
      [chosen.memory.currentRevisionId],
      new Date().toISOString(),
    );
    const prepared: CognitionPreparedContext = {
      ...emptyCognition(),
      text: "用户正在回忆周末。",
      evidencePack: {
        items: evidence,
        coverage: [],
        gaps: [],
        estimatedTokens: 1000,
        truncated: false,
        incompleteReasons: [],
      },
    };
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.resolve(prepared),
    );
    const provider = new ScriptedProvider([finalTurn("那次流星很好看。")]);
    const run = await createRuntimeFor(fixture, provider, {
      prepareTurn,
    }).start({
      attachments: [],
      chatId: fixture.chatId,
      content: "周末有什么印象深刻的事？",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");
    const input = JSON.stringify(provider.requests[0]?.input);
    expect(input).toContain("一起看到了流星");
    expect(input).not.toContain("无关个人资料");
    expect(input).not.toContain(chosen.memory.id);
    fixture.database.close();
  });

  it("keeps memory.search loaded and accepts a changed follow-up evidence question", async () => {
    const fixture = await createFixture([
      namespacedFunctionTurn("memory-hobby", "search", "memory", {
        query: "兴趣",
        questions: [{ id: "hobby", text: "用户喜欢什么？" }],
      }),
      namespacedFunctionTurn("memory-trip", "search", "memory", {
        query: "周末经历",
        questions: [{ id: "trip", text: "上次露营发生了什么？" }],
      }),
      finalTurn("你喜欢游戏，周末也聊到了露营。"),
    ]);
    const { memory } = createMemoryFor(fixture);
    memory.create({
      type: "preference",
      content: "用户喜欢玩 CS2。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    memory.create({
      type: "event",
      content: "周末露营时看了流星。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    await memory.indexPending();
    const recall = vi.spyOn(memory, "recall");
    registerMemoryTool(fixture.tools, memory, () => ({}));
    const runtime = createRuntimeFor(fixture, fixture.provider);
    const run = await runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "聊聊我的兴趣和周末经历",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");
    expect(recall.mock.calls.map(([plan]) => plan.questions[0]?.id)).toEqual([
      "hobby",
      "trip",
    ]);
    expect(
      fixture.provider.requests[0]?.toolNamespaces
        .find(({ name }) => name === "memory")
        ?.tools.find(({ name }) => name === "memory.search"),
    ).toMatchObject({ deferLoading: false });
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "tool_call"),
    ).toHaveLength(2);
    const searchItems = fixture.runs
      .listRunItems(run.id)
      .filter(({ kind }) => kind === "tool_call");
    expect(
      fixture.runs.toolSuppliedMemoryReferences(run.id, searchItems[0]!.id),
    ).toEqual([]);
    const suppliedToSecond = fixture.runs.toolSuppliedMemoryReferences(
      run.id,
      searchItems[1]!.id,
    );
    expect(suppliedToSecond).toBeDefined();
    expect(suppliedToSecond!.length).toBeGreaterThan(0);
    const firstSearch = searchItems[0]!.output as unknown as {
      modelContent: {
        items: { memoryId: string; revisionId: string; current: boolean }[];
      };
    };
    expect(suppliedToSecond).toEqual(
      firstSearch.modelContent.items.map(
        ({ memoryId, revisionId, current }) => ({
          memoryId,
          revisionId,
          use: current ? "current" : "history",
        }),
      ),
    );
    expect(JSON.stringify(fixture.provider.requests[2]?.input)).toContain(
      "周末露营",
    );
    fixture.database.close();
  });

  it("loads compact Activity recall on demand without exposing raw evidence in the Run", async () => {
    const fixture = await createFixture([
      searchTurn("search-activity", "software activity usage history"),
      functionTurn("call-activity", ACTIVITY_SEARCH_TOOL_NAME, {}),
      finalTurn("你最近经常使用 Visual Studio Code。"),
    ]);
    registerActivityTool(fixture.tools, {
      observe: () => {
        throw new Error("This usage-only fixture must not read page content");
      },
      search: () => ({
        observedBehaviorOnly: true,
        patterns: [
          {
            actor: "user",
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

  it("reads retained page updates in nonvisual Chat while background interpretation is still old", async () => {
    const oldText =
      "木岸手作空间，周六下午三点，二楼小教室。当天正门电梯检修，预约参加者可从院内侧门走坡道到教室。";
    const newText =
      "场次更新：原周六下午三点的夜灯课改为周六四点半，地点仍是木岸二楼小教室。预约说明更新完成，活动未开始。";
    const fixture = await createFixture(
      [
        namespacedFunctionTurn("read-workshop", "observe", "activity", {
          latest: { query: "夜灯工作坊" },
        }),
        finalTurn("刚才采集到的页面写着周六四点半；你还没下单。"),
      ],
      undefined,
      undefined,
      undefined,
      {
        effectiveInputTokens: 128_000,
        maxContextTokens: 144_384,
        maxOutputTokens: 16_384,
        maxPromptTokens: 128_000,
        supportsVision: false,
      },
    );
    const clock = new SystemClock();
    const ids = new CryptoIdGenerator();
    const repository = new ActivityRepository(fixture.database);
    repository.initialize(clock.now());
    const memory = new MemoryService(
      new MemoryRepository(fixture.database),
      { search: () => [] },
      ids,
      clock,
    );
    const activity = new ActivityService(
      repository,
      memory,
      new ActivityAssetStore(
        path.join(path.dirname(fixture.database.name), "activity-assets"),
      ),
      ids,
      clock,
    );
    const page = {
      source: "active_app" as const,
      appName: "Safari",
      windowTitle: "夜灯工作坊｜周末安排",
      boundary: "content" as const,
      contentStatus: "available" as const,
      visualStatus: "unavailable" as const,
    };
    activity.recordEvent(
      {
        ...page,
        content: { source: "accessibility", scope: "viewport", text: oldText },
      },
      "unknown",
      "2026-03-08T02:01:09.000Z",
    );
    const newEventId = activity.recordEvent(
      {
        ...page,
        content: { source: "accessibility", scope: "viewport", text: newText },
      },
      "unknown",
      "2026-03-08T02:03:25.000Z",
    );
    registerActivityTool(fixture.tools, activity);
    const prepareTurn = vi.fn(() =>
      Promise.resolve({ ...emptyCognition(), text: oldText }),
    );
    const runtime = createRuntimeFor(fixture, fixture.provider, {
      prepareTurn,
    });
    try {
      const run = await runtime.start({
        attachments: [],
        chatId: fixture.chatId,
        content: "场次改了就按页面现在的来，我还没下单。",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      });
      await fixture.collector.wait(
        ({ event }) =>
          "run" in event &&
          event.run.id === run.id &&
          ["completed", "failed", "cancelled"].includes(event.run.status),
      );
      expect(fixture.runs.getRun(run.id)?.status).toBe("completed");
      expect(fixture.provider.requests).toHaveLength(2);
      const first = fixture.provider.requests[0]!;
      expect(
        first.toolNamespaces
          .find(({ name }) => name === "activity")
          ?.tools.find(({ name }) => name === ACTIVITY_OBSERVE_TOOL_NAME),
      ).toMatchObject({ deferLoading: false });
      expect(JSON.stringify(first.input)).toContain(oldText);
      expect(JSON.stringify(first.input)).not.toContain(newText);
      const supplied = fixture.provider.requests[1]!.input.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          item["type"] === "function_call_output" &&
          item["call_id"] === "read-workshop",
      );
      expect(JSON.stringify(supplied)).toContain(newText);
      expect(JSON.stringify(supplied)).toContain(newEventId);
      expect(JSON.stringify(supplied)).toContain("unknown");
      expect(prepareTurn).toHaveBeenCalledTimes(1);
      const items = fixture.runs.listRunItems(run.id);
      expect(items.filter(({ kind }) => kind === "approval")).toEqual([]);
      const read = items.find(
        ({ input }) =>
          typeof input === "object" &&
          input !== null &&
          !Array.isArray(input) &&
          input["toolName"] === ACTIVITY_OBSERVE_TOOL_NAME,
      );
      expect(read?.status).toBe("completed");
      expect(read?.displayOutput).not.toContain(newEventId);
      expect(read?.displayOutput).not.toContain('"actor"');
      expect(memory.list({}).memories).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("forms memory.record {} from persisted user messages in Chat mode without approval", async () => {
    const fixture = await createFixture([]);
    const { memory, formation } = createMemoryFor(fixture);
    registerRunFormation(fixture, memory);
    const provider = new ScriptedProvider([
      namespacedFunctionTurn("memory-call", "record", "memory", {}),
      finalTurn("我会先给结论。"),
    ]);
    const runtime = createRuntimeFor(fixture, provider);
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
    expect(
      fixture.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "approval"),
    ).toEqual([]);
    const formed = memory.list({ query: "技术回答" }).memories[0]!;
    expect(formed.revision.content).toBe("以后技术回答先给结论。");
    const persisted = new ChatRepository(fixture.database)
      .listMessages(fixture.chatId)
      .find(({ role }) => role === "user")!;
    expect(formed.sources[0]).toMatchObject({
      id: persisted.id,
      referenceId: fixture.chatId,
      type: "chat",
    });
    expect(
      vi.mocked(formation).form.mock.calls[0]?.[0].episode.sources[0],
    ).toMatchObject({
      id: persisted.id,
      speaker: "user",
      content: persisted.content,
    });
    expect(
      fixture.runs.listRunItems(run.id).find(({ kind }) => kind === "tool_call")
        ?.displayOutput,
    ).toBe("已根据原始证据更新记忆");
    fixture.database.close();
  });

  it("records actual successful Tool receipts and rejects model-authored memory payloads", async () => {
    const fixture = await createFixture([]);
    const { memory, formation } = createMemoryFor(fixture);
    registerRunFormation(fixture, memory);
    fixture.tools.register({
      descriptor: {
        name: "test.read",
        namespace: "test",
        source: "builtin",
        effect: "read",
        idempotency: "idempotent",
        itemKind: "tool_call",
        summary: "读发布检查",
        description: "读取检查结果",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      execute: () =>
        Promise.resolve({
          artifacts: [],
          modelContent: { verified: "离线验收已通过" },
          retryable: false,
          status: "success",
          summary: "检查通过",
        }),
      summarize: () => "读检查结果",
    });
    const provider = new ScriptedProvider([
      searchTurn("discover-read", "test read check"),
      functionTurn("read-check", "test.read", {}),
      namespacedFunctionTurn("invented-memory", "record", "memory", {
        content: "用户喜欢咖啡",
        sourceId: "invented",
      }),
      namespacedFunctionTurn("actual-memory", "record", "memory", {}),
      finalTurn("检查结果已记录。"),
    ]);
    const run = await createRuntimeFor(fixture, provider).start({
      attachments: [],
      chatId: fixture.chatId,
      content: "查看发布检查",
      execution: { approvalMode: "full_access", mode: "agent" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");
    const sources =
      vi.mocked(formation).form.mock.calls[0]?.[0].episode.sources ?? [];
    const receipt = fixture.runs
      .listRunItems(run.id)
      .find(
        (item) =>
          item.kind === "tool_call" &&
          item.displayOutput?.includes("离线验收已通过"),
      )!;
    expect(receipt).toBeDefined();
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: receipt.id,
          speaker: "tool",
          type: "tool",
        }),
      ]),
    );
    expect(sources.map((source) => source.content).join(" ")).toContain(
      "离线验收已通过",
    );
    expect(sources.map((source) => source.content).join(" ")).not.toContain(
      "用户喜欢咖啡",
    );
    expect(memory.list({ query: "离线验收" }).memories).toHaveLength(1);
    expect(memory.list({}).candidates).toEqual([]);
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
          80_000,
        ),
        namespacedFunctionTurn(
          "plan-progress",
          "update",
          "plan",
          progressedPlan,
          80_000,
        ),
        finalTurn(),
      ],
      undefined,
      undefined,
      undefined,
      { effectiveInputTokens: 80_000 },
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
          80_000,
        ),
      ],
      undefined,
      undefined,
      undefined,
      { effectiveInputTokens: 80_000 },
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
      "Interpret current relative dates such as today in that time zone",
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
      Promise.resolve(
        preparedImage(
          Buffer.from(
            typeof source === "string" ? source : JSON.stringify(source),
          ).toString("base64"),
        ),
      ),
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

    expect(prepare).toHaveBeenCalledWith(
      "/workspace/layout.png",
      expect.any(AbortSignal),
    );
    const input = fixture.provider.requests[0]?.input[0];
    expect(input).toMatchObject({ role: "user", type: "message" });
    expect(JSON.stringify(input)).toContain('"type":"input_image"');
    expect(JSON.stringify(input)).toContain("data:image/png;base64,");
    expect(JSON.stringify(input)).not.toContain("/workspace/layout.png");
    fixture.database.close();
  });

  it("reads a shared text document into model context and persists verified facts", async () => {
    const prepare = vi.fn<AttachmentInputProvider["prepare"]>(() =>
      Promise.resolve({
        byteLength: 42,
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        text: "# Demo 分享\n\n结论比预想顺利。",
      }),
    );
    const fixture = await createFixture(
      [finalTurn("我看完了")],
      new SystemClock(),
      undefined,
      undefined,
      undefined,
      undefined,
      { prepare },
    );

    const run = await fixture.runtime.start({
      attachments: [
        {
          artifactId: "20000000-0000-4000-8000-000000000010",
          displayName: "sharing.md",
          kind: "file",
          mediaType: "text/markdown",
          storageKey: "/workspace/sharing.md",
        },
      ],
      chatId: fixture.chatId,
      content: "分享结束了",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: "/workspace/sharing.md" }),
    );
    const input = JSON.stringify(fixture.provider.requests[0]?.input);
    expect(input).toContain("user-supplied attachment content");
    expect(input).toContain("结论比预想顺利");
    expect(input).not.toContain("/workspace/sharing.md");
    expect(
      fixture.database
        .prepare("SELECT byte_length, sha256 FROM attachments WHERE id = ?")
        .get("20000000-0000-4000-8000-000000000010"),
    ).toEqual({
      byte_length: 42,
      sha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    fixture.database.close();
  });

  it("rejects an attachment that changed after selection before creating a Run", async () => {
    const fixture = await createFixture(
      [finalTurn("不应发送")],
      new SystemClock(),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        prepare: () =>
          Promise.resolve({
            byteLength: 11,
            sha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          }),
      },
    );

    await expect(
      fixture.runtime.start({
        attachments: [
          {
            artifactId: "20000000-0000-4000-8000-000000000011",
            byteLength: 10,
            displayName: "changed.txt",
            kind: "file",
            storageKey: "/workspace/changed.txt",
          },
        ],
        chatId: fixture.chatId,
        content: "读一下",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      }),
    ).rejects.toMatchObject({ code: "AGENT.ATTACHMENT_INPUT_INVALID" });
    expect(fixture.provider.requests).toHaveLength(0);
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM runs").get(),
    ).toEqual({ count: 0 });
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

  it.each(["chat", "agent"] as const)(
    "loads image.inspect pixels into the next %s model turn and preserves them through compaction",
    async (mode) => {
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

      const run = await fixture.runtime.start({
        attachments: [],
        chatId: fixture.chatId,
        content: "完成测试任务",
        execution:
          mode === "agent" ? { approvalMode: "full_access", mode } : { mode },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      });
      await waitForStatus(fixture, run.id, "completed");

      expect(prepare).toHaveBeenCalledWith(
        "run/image.png",
        expect.any(AbortSignal),
      );
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
    },
  );

  it.each(["unsupported_model", "restricted_scope"] as const)(
    "keeps image inspection unavailable in Chat for %s",
    async (reason) => {
      const prepare = vi.fn<ImageInputProvider["prepare"]>(() =>
        Promise.resolve(preparedImage("aW1hZ2U=")),
      );
      const fixture = await createFixture(
        [
          namespacedFunctionTurn("inspect-unavailable", "inspect", "image", {
            path: "run/image.png",
          }),
          finalTurn("这次无法读取图片"),
        ],
        new SystemClock(),
        undefined,
        { prepare },
        {
          effectiveInputTokens: 100_000,
          supportsVision: reason !== "unsupported_model",
        },
      );
      const request = {
        attachments: [],
        chatId: fixture.chatId,
        content: "看看刚才保存的图片",
        execution: { mode: "chat" as const },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      };
      const run =
        reason === "restricted_scope"
          ? await fixture.runtime.startAssistantInitiated(request, {
              modelId: "gpt-6-astra",
              persona: defaultPersonaSnapshot(REQUESTED_AT),
              toolNames: [],
            })
          : await fixture.runtime.start(request);
      await waitForStatus(fixture, run.id, "completed");

      expect(
        fixture.provider.requests[0]?.toolNamespaces.some(
          ({ name }) => name === "image",
        ),
      ).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      const continued = JSON.stringify(fixture.provider.requests[1]?.input);
      expect(continued).toContain('"call_id":"inspect-unavailable"');
      expect(continued).not.toContain('"type":"input_image"');
      expect(continued).toContain(
        reason === "restricted_scope"
          ? "TOOL.SCOPE_NOT_ALLOWED"
          : "IMAGE.INPUT_UNAVAILABLE",
      );
      fixture.database.close();
    },
  );

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
    const limits = { effectiveInputTokens: 80_000 };
    const fixture = await createFixture(
      [
        finalTurnWithUsage("第一轮回答", 80_000),
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
        finalTurnWithUsage("已完成的旧回答", 80_000),
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
      { effectiveInputTokens: 80_000 },
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
      chatSummaryTurn("旧对话摘要：两个旧问题都已经得到回答。"),
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
    const retryInput = JSON.stringify(fixture.provider.requests[4]?.input);
    expect(retryInput).toContain("旧对话摘要");
    expect(retryInput).toContain("触发恢复");
    expect(fixture.provider.requests[4]?.input).not.toContainEqual({
      content: "旧问题",
      role: "user",
      type: "message",
    });
    expect(fixture.provider.requests[4]?.input).not.toContainEqual({
      content: "旧回答",
      role: "assistant",
      type: "message",
    });
    expect(fixture.provider.requests[4]?.input).not.toContainEqual({
      content: "第二个旧问题",
      role: "user",
      type: "message",
    });
    expect(fixture.provider.requests[4]?.input).not.toContainEqual({
      content: "第二个旧回答",
      role: "assistant",
      type: "message",
    });
    const nextInput = JSON.stringify(fixture.provider.requests[5]?.input);
    expect(nextInput).toContain("旧对话摘要");
    expect(fixture.provider.requests[5]?.input).not.toContainEqual({
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
    ).toMatchObject({ generation: 1 });
    fixture.database.close();
  });

  it("preserves an already merged correction when the first request needs a durable Chat summary", async () => {
    const fixture = await createFixture([
      finalTurn("旧回答"),
      () => {
        throw new ProviderError(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          "context is full",
          true,
        );
      },
      chatSummaryTurn("旧对话已结束，旧问题得到回答。"),
      finalTurn("遵照改期后的安排。"),
    ]);
    const prior = await startAgent(fixture);
    await waitForStatus(fixture, prior.id, "completed");
    const estimate = fixture.provider.estimateInput.bind(fixture.provider);
    let delivered = false;
    let steering: Promise<{ runId: string }> | undefined;
    vi.spyOn(fixture.provider, "estimateInput").mockImplementation(
      (request) => {
        const run = fixture.runs.listRunsByStatus(["running"])[0];
        if (run && !delivered) {
          delivered = true;
          steering = fixture.runtime.steer({
            runId: run.id,
            requestedAt: REQUESTED_AT,
            content: "更正：周六下午三点，周五的安排取消。",
          });
        }
        return estimate(request);
      },
    );
    const run = await fixture.runtime.start({
      attachments: [],
      chatId: fixture.chatId,
      content: "周五下午三点去松柏陶艺。",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: REQUESTED_AT,
    });
    await waitForStatus(fixture, run.id, "completed");
    await steering;
    expect(delivered).toBe(true);
    expect(fixture.provider.requests).toHaveLength(4);
    for (const request of [
      fixture.provider.requests[1]!,
      fixture.provider.requests[3]!,
    ]) {
      expect(request.input).toContainEqual({
        content: "周五下午三点去松柏陶艺。",
        role: "user",
        type: "message",
      });
      expect(request.input).toContainEqual({
        content: "更正：周六下午三点，周五的安排取消。",
        role: "user",
        type: "message",
      });
    }
    const chats = new ChatRepository(fixture.database);
    expect(chats.getContextSnapshot(fixture.chatId)).toMatchObject({
      generation: 1,
    });
    expect(
      chats.listRunMessages(prior.id).map(({ content }) => content),
    ).toEqual(["完成测试任务", "旧回答"]);
    expect(
      chats
        .listRunMessages(run.id)
        .map(({ content }) => content)
        .sort(),
    ).toEqual(
      [
        "周五下午三点去松柏陶艺。",
        "更正：周六下午三点，周五的安排取消。",
        "遵照改期后的安排。",
      ].sort(),
    );
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
    await fixture.runtime.resolveApproval({
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

    await fixture.runtime.resolveApproval({
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
    await fixture.runtime.resolveApproval({
      approvalId: approval!.id,
      decidedAt: REQUESTED_AT,
      decision: "approved",
    });
    await waitForStatus(fixture, run.id, "completed");

    expect(calls).toBe(1);
    expect(fixture.runs.getApproval(approval!.id)?.status).toBe("approved");
    fixture.database.close();
  });

  it.each([
    "new-message-first",
    "approval-first",
    "restart",
    "crash-before-resolution",
    "crash-after-resolution",
  ] as const)(
    "reconsiders an unexecuted approval-bound call after new input (%s)",
    async (boundary) => {
      const fixture = await createFixture([
        functionTurn("old-write", "test.write", { value: "old" }),
        finalTurn("按新的内容继续，原写入没有执行。"),
      ]);
      const execute = vi.fn(() => Promise.resolve(successfulResult("wrote")));
      registerTool(fixture, {
        effect: "write",
        execute,
        idempotency: "non_idempotent",
        name: "test.write",
      });
      const run = await startAgent(fixture, "request_approval");
      await waitForStatus(fixture, run.id, "waiting_approval");
      const approval = fixture.runtime.getPendingApproval()!;
      let provider = fixture.provider;
      let runtime = fixture.runtime;
      if (boundary === "restart") {
        provider = new ScriptedProvider([finalTurn("按照新内容继续。")]);
        runtime = createRuntimeFor(fixture, provider);
        await runtime.initialize();
      }
      const approvalFirst =
        boundary === "approval-first"
          ? runtime.resolveApproval({
              approvalId: approval.id,
              decidedAt: REQUESTED_AT,
              decision: "approved",
            })
          : undefined;
      const steering = {
        content: "先别写了，我们重新讨论内容。",
        requestedAt: REQUESTED_AT,
        runId: run.id,
      };
      if (boundary.startsWith("crash-")) {
        const original = fixture.writer.resolveApproval.bind(fixture.writer);
        const fault = vi.spyOn(fixture.writer, "resolveApproval");
        fault.mockImplementationOnce((value) => {
          if (boundary === "crash-after-resolution") original(value);
          throw new Error("Simulated crash at approval resolution");
        });
        await expect(runtime.steer(steering)).rejects.toThrow(
          "Simulated crash",
        );
        fault.mockRestore();
        provider = new ScriptedProvider([
          finalTurn("按照已收到的新消息继续。"),
        ]);
        runtime = createRuntimeFor(fixture, provider);
        await runtime.initialize();
      } else await runtime.steer(steering);
      await approvalFirst;
      await waitForStatus(fixture, run.id, "completed");

      expect(execute).not.toHaveBeenCalled();
      expect(fixture.runs.getApproval(approval.id)?.status).toBe(
        boundary === "approval-first" ? "approved" : "cancelled",
      );
      const next = provider.requests.at(-1)!;
      expect(next.input).toContainEqual(
        expect.objectContaining({ role: "user", content: steering.content }),
      );
      expect(
        next.input.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            item["type"] === "function_call_output" &&
            item["call_id"] === "old-write",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(next.input)).toContain("TOOL.INPUT_CHANGED");
      expect(
        new ChatRepository(fixture.database)
          .listRunMessages(run.id)
          .filter(({ content }) => content === steering.content),
      ).toHaveLength(1);
      await runtime.resolveApproval({
        approvalId: approval.id,
        decidedAt: REQUESTED_AT,
        decision: "approved",
      });
      expect(execute).not.toHaveBeenCalled();
      fixture.database.close();
    },
  );

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

  it("includes a correction received during full request preparation in its first generation", async () => {
    const fixture = await createFixture([finalTurn("已按新方向回复。")]);
    const estimate = fixture.provider.estimateInput.bind(fixture.provider);
    let delivered = false;
    let steering: Promise<{ runId: string }> | undefined;
    vi.spyOn(fixture.provider, "estimateInput").mockImplementation(
      (request) => {
        const run = fixture.runs.listRunsByStatus(["running"])[0];
        if (run && !delivered) {
          delivered = true;
          steering = fixture.runtime.steer({
            runId: run.id,
            requestedAt: REQUESTED_AT,
            content: "这是准备阶段的新方向。",
          });
        }
        return estimate(request);
      },
    );
    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");
    await steering;
    expect(delivered).toBe(true);
    expect(fixture.provider.requests).toHaveLength(1);
    expect(fixture.provider.requests[0]!.input).toContainEqual({
      content: "这是准备阶段的新方向。",
      role: "user",
      type: "message",
    });
    fixture.database.close();
  });

  it("includes a correction received while materializing the first model input without an obsolete generation", async () => {
    const fixture = await createFixture([finalTurn("只按最新方向回复。")]);
    const publish = fixture.collector.publish;
    let delivered = false;
    let steering: Promise<{ runId: string }> | undefined;
    vi.spyOn(fixture.collector, "publish").mockImplementation((envelope) => {
      publish(envelope);
      if (
        envelope.event.type === "item.started" &&
        envelope.event.item.kind === "assistant_message" &&
        !delivered
      ) {
        delivered = true;
        queueMicrotask(() => {
          steering = fixture.runtime.steer({
            runId: envelope.streamId,
            requestedAt: REQUESTED_AT,
            content: "这是输入材料化期间的新方向。",
          });
        });
      }
    });
    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "completed");
    await steering;
    expect(delivered).toBe(true);
    expect(fixture.provider.requests).toHaveLength(1);
    expect(fixture.provider.requests[0]!.input).toContainEqual({
      content: "这是输入材料化期间的新方向。",
      role: "user",
      type: "message",
    });
    fixture.database.close();
  });

  it("merges steering at the next model boundary", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let releaseFirst!: () => void;
    const firstTurnReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fixture = await createFixture([
      async () => {
        enter();
        await firstTurnReady;
        return [{ delta: "旧方向", type: "text.delta" }, complete("first")];
      },
      finalTurn("已按新方向完成"),
    ]);
    const run = await startAgent(fixture);
    await entered;
    await fixture.runtime.steer({
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

  it.each([false, true])(
    "continues a pending question from an ordinary message without inventing an answer (restart=%s)",
    async (restart) => {
      const questions = [
        {
          header: "安排",
          id: "plan",
          question: "想出门还是留在家？",
          options: [
            { label: "出门", description: "到外面走走。" },
            { label: "在家", description: "留在家里。" },
          ],
        },
      ];
      const fixture = await createFixture([
        namespacedFunctionTurn(
          "pending-plan",
          "request_user_input",
          "interaction",
          { questions },
        ),
        finalTurn("好，先听你说。"),
      ]);
      const run = await startAgent(fixture);
      await waitForStatus(fixture, run.id, "needs_input");
      const item = fixture.runs
        .listRunItems(run.id)
        .find(({ kind }) => kind === "input_request")!;
      const provider = restart
        ? new ScriptedProvider([finalTurn("好，先听你说。")])
        : fixture.provider;
      const runtime = restart
        ? createRuntimeFor(fixture, provider)
        : fixture.runtime;
      if (restart) await runtime.initialize();
      await runtime.steer({
        runId: run.id,
        content: "先不安排了，我想讲讲今天的事。",
        requestedAt: REQUESTED_AT,
      });
      await waitForStatus(fixture, run.id, "completed");
      const input = provider.requests.at(-1)!.input;
      expect(input).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: "先不安排了，我想讲讲今天的事。",
        }),
      );
      expect(fixture.runs.getRunItem(item.id)).toMatchObject({
        status: "completed",
        output: { status: "cancelled" },
      });
      const toolResults = input.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry["type"] === "function_call_output",
      );
      expect(toolResults).toHaveLength(1);
      expect(JSON.stringify(toolResults)).toContain("cancelled");
      expect(JSON.stringify(toolResults)).not.toContain("answers");
      expect(
        new ChatRepository(fixture.database)
          .listRunMessages(run.id)
          .filter(
            ({ content }) => content === "先不安排了，我想讲讲今天的事。",
          ),
      ).toHaveLength(1);
      await runtime.resolveUserInput({
        runId: run.id,
        itemId: item.id,
        resolution: {
          status: "answered",
          answers: [
            { questionId: "plan", value: { kind: "text", text: "出门" } },
          ],
          resolvedAt: REQUESTED_AT,
        },
      });
      expect(provider.requests).toHaveLength(restart ? 1 : 2);
      expect(
        fixture.collector.events.filter(
          ({ event }) => event.type === "input.resolved",
        ),
      ).toHaveLength(1);
      fixture.database.close();
    },
  );

  it("recovers a persisted new message if the process stops before the old question is resolved", async () => {
    const fixture = await createFixture([
      namespacedFunctionTurn(
        "crash-question",
        "request_user_input",
        "interaction",
        {
          questions: [
            {
              header: "安排",
              id: "plan",
              question: "想做哪件事？",
              options: [
                { label: "聊天", description: "说说今天。" },
                { label: "阅读", description: "读一点书。" },
              ],
            },
          ],
        },
      ),
    ]);
    const run = await startAgent(fixture);
    await waitForStatus(fixture, run.id, "needs_input");
    const boundary = vi
      .spyOn(RunEventWriter.prototype, "resolveInput")
      .mockImplementationOnce(() => {
        throw new Error("Simulated stop before input resolution");
      });
    await expect(
      fixture.runtime.steer({
        runId: run.id,
        content: "换个话题，讲个短故事。",
        requestedAt: REQUESTED_AT,
      }),
    ).rejects.toThrow("Simulated stop");
    boundary.mockRestore();
    const provider = new ScriptedProvider([finalTurn("从前有一朵小云。")]);
    const restarted = createRuntimeFor(fixture, provider);
    await restarted.initialize();
    await waitForStatus(fixture, run.id, "completed");
    expect(provider.requests).toHaveLength(1);
    expect(
      provider.requests[0]!.input.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry["content"] === "换个话题，讲个短故事。",
      ),
    ).toHaveLength(1);
    expect(
      fixture.collector.events.filter(
        ({ event }) => event.type === "input.resolved",
      ),
    ).toHaveLength(1);
    fixture.database.close();
  });

  it("does not execute calls proposed before a new message arrived during the model response", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createFixture([
      async () => {
        enter();
        await ready;
        return [
          {
            type: "output.item" as const,
            item: {
              type: "function_call",
              name: "test.write",
              call_id: "stale-write",
              arguments: "{}",
            },
          },
          complete("old-proposal"),
        ];
      },
      finalTurn("已经换成新的方向。"),
    ]);
    let effects = 0;
    registerTool(fixture, {
      name: "test.write",
      effect: "write",
      execute: () => {
        effects += 1;
        return Promise.resolve(successfulResult("已写入"));
      },
    });
    const run = await startAgent(fixture, "full_access");
    await entered;
    await fixture.runtime.steer({
      runId: run.id,
      content: "不要写文件了，先聊聊。",
      requestedAt: REQUESTED_AT,
    });
    release();
    await waitForStatus(fixture, run.id, "completed");
    expect(effects).toBe(0);
    expect(JSON.stringify(fixture.provider.requests[1]!.input)).toContain(
      "TOOL.INPUT_CHANGED",
    );
    expect(fixture.runs.listRunItems(run.id)).toContainEqual(
      expect.objectContaining({ kind: "tool_call", status: "cancelled" }),
    );
    fixture.database.close();
  });

  it.each(["steer", "answer"] as const)(
    "reconsiders calls following a question after receiving %s and preserves earlier effects",
    async (method) => {
      const questions = [
        {
          header: "方向",
          id: "next",
          question: "接下来想做什么？",
          options: [
            { label: "聊天", description: "说说今天。" },
            { label: "阅读", description: "读一点书。" },
          ],
        },
      ];
      const fixture = await createFixture([
        () => [
          {
            type: "output.item",
            item: {
              type: "function_call",
              name: "test.write",
              call_id: "before-question",
              arguments: '{"value":"before"}',
            },
          },
          {
            type: "output.item",
            item: {
              type: "function_call",
              name: "request_user_input",
              namespace: "interaction",
              call_id: "question",
              arguments: JSON.stringify({ questions }),
            },
          },
          {
            type: "output.item",
            item: {
              type: "function_call",
              name: "test.write",
              call_id: "after-question",
              arguments: '{"value":"after"}',
            },
          },
          complete("mixed-calls"),
        ],
        finalTurn("已按新的方向继续，先前的结果仍保留。"),
      ]);
      let currentContext = "context-before-user-correction";
      const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
        Promise.resolve({ ...emptyCognition(), text: currentContext }),
      );
      const runtime = createRuntimeFor(fixture, fixture.provider, {
        prepareTurn,
      });
      const effects: string[] = [];
      registerTool(fixture, {
        name: "test.write",
        effect: "write",
        execute: (input) => {
          if (typeof input["value"] !== "string")
            throw new Error("Missing effect value");
          effects.push(input["value"]);
          return Promise.resolve(successfulResult("写入完成"));
        },
      });
      const run = await runtime.start({
        ...preparationRequest(fixture.chatId),
        execution: { mode: "agent", approvalMode: "full_access" },
      });
      await waitForStatus(fixture, run.id, "needs_input");
      const item = fixture.runs
        .listRunItems(run.id)
        .find(({ kind }) => kind === "input_request")!;
      currentContext = "context-after-user-correction";
      if (method === "steer")
        await runtime.steer({
          runId: run.id,
          content: "先停下余下的写入，聊点别的。",
          requestedAt: REQUESTED_AT,
        });
      else
        await runtime.resolveUserInput({
          runId: run.id,
          itemId: item.id,
          resolution: {
            status: "answered",
            answers: [
              {
                questionId: "next",
                value: { kind: "text", text: "先聊天，不继续写" },
              },
            ],
            resolvedAt: REQUESTED_AT,
          },
        });
      await waitForStatus(fixture, run.id, "completed");
      expect(effects).toEqual(["before"]);
      const input = fixture.provider.requests[1]!.input;
      for (const id of ["before-question", "question", "after-question"])
        expect(
          input.filter(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              !Array.isArray(entry) &&
              entry["type"] === "function_call_output" &&
              entry["call_id"] === id,
          ),
        ).toHaveLength(1);
      expect(JSON.stringify(input)).toContain("TOOL.INPUT_CHANGED");
      expect(prepareTurn).toHaveBeenCalledTimes(2);
      expect(prepareTurn.mock.calls[1]![0]).toMatchObject({
        resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
      });
      const latest = JSON.stringify(input);
      expect(latest).toContain("context-after-user-correction");
      expect(latest).not.toContain("context-before-user-correction");
      expect(latest.match(/context-after-user-correction/g)).toHaveLength(1);
      expect(prepareTurn.mock.calls[1]![0].currentInput).toContain(
        method === "steer" ? "先停下余下的写入" : "先聊天，不继续写",
      );
      fixture.database.close();
    },
  );

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
    const originalMessage: JsonValue = {
      id: "phase-before-tool",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [
        { type: "output_text", text: "准备执行一次。", annotations: [] },
      ],
    };
    const firstTool = functionTurn("call-once", "test.once", {});
    const fixture = await createFixture([
      async (request, signal) => [
        { type: "text.delta", delta: "准备执行一次。" },
        { type: "output.item", item: originalMessage },
        ...(await firstTool(request, signal)),
      ],
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
    let currentContext = "context-before-process-reopen";
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.resolve({ ...emptyCognition(), text: currentContext }),
    );
    const runtime = createRuntimeFor(fixture, fixture.provider, {
      prepareTurn,
    });
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

    const run = await runtime.start({
      ...preparationRequest(fixture.chatId),
      execution: { mode: "agent", approvalMode: "full_access" },
    });
    await boundary;
    await runtime.interruptAll();
    expect(prepareTurn).toHaveBeenCalledTimes(1);
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
    const fileName = fixture.database.name;
    fixture.database.close();
    const reopened = openApplicationDatabase(fileName);
    const resumedFixture = {
      ...fixture,
      database: reopened,
      runs: new RunRepository(reopened),
      checkpoints: new CheckpointRepository(reopened),
    };
    currentContext = "context-after-process-reopen";
    const resumedRuntime = createRuntimeFor(resumedFixture, resumedProvider, {
      prepareTurn,
    });
    try {
      await resumedRuntime.resume({ requestedAt: REQUESTED_AT, runId: run.id });
      await waitForStatus(resumedFixture, run.id, "completed");
      expect(calls).toBe(1);
      expect(prepareTurn).toHaveBeenCalledTimes(2);
      const resumedInput = JSON.stringify(resumedProvider.requests[0]!.input);
      expect(resumedInput).toContain("context-after-process-reopen");
      expect(resumedInput).not.toContain("context-before-process-reopen");
      expect(fixture.provider.contextLimitRequests).toEqual(["gpt-5.6-sol"]);
      expect(resumedProvider.contextLimitRequests).toEqual([]);
      expect(resumedProvider.requests).toHaveLength(1);
      expect(resumedProvider.requests[0]?.input).toContainEqual(
        originalMessage,
      );
    } finally {
      await resumedRuntime.interruptAll();
      reopened.close();
    }
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

describe("application shutdown during a real Memory search", () => {
  it("interrupts an active Memory search before closing its local encoder", async () => {
    const fixture = await createFixture([
      namespacedFunctionTurn("shutdown-memory", "search", "memory", {
        query: "hold",
        questions: [{ id: "q", text: "hold" }],
      }),
      finalTurn("The tool ended; this must not be a shutdown completion."),
    ]);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cm-shutdown-encoder-"),
    );
    temporaryDirectories.push(directory);
    const marker = path.join(directory, "holding");
    const nativeFixture = path.resolve(
      "src/main/providers/localEmbedding.fixture.mjs",
    );
    const supervisor = path.join(directory, "embedding-supervisor");
    await writeFile(
      supervisor,
      [
        "#!" + process.execPath,
        "const socket = process.argv[2];",
        "process.argv = [process.execPath, " +
          JSON.stringify(nativeFixture) +
          ", socket, '4', " +
          JSON.stringify(marker) +
          ", 'ready'];",
        "import(" + JSON.stringify(nativeFixture) + ");",
      ].join("\n"),
    );
    await chmod(supervisor, 0o755);
    const encoder = new LocalEmbedding({
      directory,
      modelFile: "fixture.gguf",
      modelKey: "shutdown-fixture",
      nativeDimensions: 4,
      dimensions: 2,
      contextTokens: 1024,
      batchTokens: 256,
      threads: 1,
      queryInstruction: "Find evidence.",
    });
    try {
      const { memory } = createMemoryFor(fixture, encoder);
      memory.create({
        type: "preference",
        content: "A remembered preference.",
        confidence: 1,
        importance: 0.5,
        reason: "user",
        sources: [],
      });
      expect(await memory.indexPending()).toBeGreaterThan(0);
      registerMemoryTool(fixture.tools, memory, () => ({}));
      const run = await fixture.runtime.start({
        attachments: [],
        chatId: fixture.chatId,
        content: "Recall the preference.",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      });
      await vi.waitFor(async () =>
        expect(await readFile(marker, "utf8")).toBe("holding"),
      );
      await fixture.runtime.interruptAll();
      await encoder.shutdown();
      expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");
      expect(fixture.provider.requests).toHaveLength(1);
      expect(
        fixture.runs
          .listRunItems(run.id)
          .filter(({ kind }) => kind === "tool_call"),
      ).toEqual([expect.objectContaining({ status: "interrupted" })]);
    } finally {
      await fixture.runtime.interruptAll();
      await encoder.shutdown();
      fixture.database.close();
    }
  });
});

function userTakeoverGate() {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const continuingRunIds: string[] = [];
  return {
    entered: enteredPromise,
    release,
    continuingRunIds,
    before: async (continuingRunId?: string) => {
      if (!continuingRunId) return;
      continuingRunIds.push(continuingRunId);
      entered();
      await released;
    },
  };
}

const takeoverQuestions = [
  {
    id: "scope",
    header: "范围",
    question: "处理哪一份材料？",
    options: [
      { label: "笔记", description: "处理这份笔记。" },
      { label: "清单", description: "处理这份清单。" },
    ],
  },
];

describe("user continuation rechecks the durable boundary after yielding", () => {
  it.each([
    ["answer", "cancel"],
    ["answer", "checkpoint"],
    ["steer", "cancel"],
    ["steer", "checkpoint"],
  ] as const)(
    "rejects stale %s after %s during yield",
    async (method, change) => {
      const gate = userTakeoverGate();
      const fixture = await createFixture(
        [
          namespacedFunctionTurn(
            "question",
            "request_user_input",
            "interaction",
            {
              questions: takeoverQuestions,
            },
          ),
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gate.before,
      );
      const run = await startAgent(fixture);
      await waitForStatus(fixture, run.id, "needs_input");
      const item = fixture.runs
        .listRunItems(run.id)
        .find(({ kind }) => kind === "input_request")!;
      const pending =
        method === "answer"
          ? fixture.runtime.resolveUserInput({
              runId: run.id,
              itemId: item.id,
              resolution: { status: "cancelled", resolvedAt: REQUESTED_AT },
            })
          : fixture.runtime.steer({
              runId: run.id,
              requestedAt: REQUESTED_AT,
              content: "等一下，先处理另一份材料。",
            });
      const rejected = expect(pending).rejects.toMatchObject({
        code:
          change === "cancel"
            ? "AGENT.PREPARATION_CANCELLED"
            : method === "answer"
              ? "AGENT.INPUT_NOT_PENDING"
              : "AGENT.RUN_NOT_ACTIVE",
      });
      let cancelling: Promise<unknown> | undefined;
      try {
        await gate.entered;
        expect(gate.continuingRunIds).toEqual([run.id]);
        expect(fixture.runs.getRunItem(item.id)?.status).toBe("waiting_input");
        if (change === "cancel") {
          // Cancellation owns this pending continuation and joins its callback.
          cancelling = fixture.runtime.cancel({
            runId: run.id,
            requestedAt: REQUESTED_AT,
          });
          await Promise.resolve();
        } else {
          const checkpoint = fixture.checkpoints.get(run.id)!;
          fixture.checkpoints.save({
            ...checkpoint,
            generation: checkpoint.generation + 1,
          });
        }
        gate.release();
        await rejected;
        await cancelling;
        expect(fixture.provider.requests).toHaveLength(1);
        expect(
          fixture.collector.events.filter(
            ({ event }) => event.type === "input.resolved",
          ),
        ).toEqual([]);
        expect(
          new ChatRepository(fixture.database)
            .listRunMessages(run.id)
            .filter(({ role }) => role === "user"),
        ).toHaveLength(1);
      } finally {
        gate.release();
        await cancelling;
        await fixture.runtime.cancel({
          runId: run.id,
          requestedAt: REQUESTED_AT,
        });
        fixture.database.close();
      }
    },
  );

  it.each(["cancel", "checkpoint", "approval"] as const)(
    "does not approve an obsolete Tool after %s during yield",
    async (change) => {
      const gate = userTakeoverGate();
      const fixture = await createFixture(
        [functionTurn("write", "test.write", { value: "original" })],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gate.before,
      );
      const execute = vi.fn(() => Promise.resolve(successfulResult("written")));
      registerTool(fixture, {
        name: "test.write",
        effect: "write",
        idempotency: "non_idempotent",
        execute,
      });
      const run = await startAgent(fixture, "request_approval");
      await waitForStatus(fixture, run.id, "waiting_approval");
      const approval = fixture.runtime.getPendingApproval()!;
      const pending = fixture.runtime.resolveApproval({
        approvalId: approval.id,
        decidedAt: REQUESTED_AT,
        decision: "approved",
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code:
          change === "cancel"
            ? "AGENT.PREPARATION_CANCELLED"
            : "AGENT.APPROVAL_NOT_PENDING",
      });
      let cancelling: Promise<unknown> | undefined;
      try {
        await gate.entered;
        expect(gate.continuingRunIds).toEqual([run.id]);
        expect(fixture.runs.getApproval(approval.id)?.status).toBe("pending");
        if (change === "cancel") {
          // Cancellation owns this pending continuation and joins its callback.
          cancelling = fixture.runtime.cancel({
            runId: run.id,
            requestedAt: REQUESTED_AT,
          });
          await Promise.resolve();
        } else if (change === "checkpoint") {
          const checkpoint = fixture.checkpoints.get(run.id)!;
          fixture.checkpoints.save({
            ...checkpoint,
            generation: checkpoint.generation + 1,
          });
        } else {
          fixture.writer.resolveApproval({
            ...approval,
            status: "rejected",
            decidedAt: REQUESTED_AT,
          });
        }
        gate.release();
        await rejected;
        await cancelling;
        expect(execute).not.toHaveBeenCalled();
        expect(fixture.runs.getApproval(approval.id)?.status).not.toBe(
          "approved",
        );
        expect(fixture.provider.requests).toHaveLength(1);
      } finally {
        gate.release();
        await cancelling;
        await fixture.runtime.cancel({
          runId: run.id,
          requestedAt: REQUESTED_AT,
        });
        fixture.database.close();
      }
    },
  );

  it.each(["unchanged", "checkpoint"] as const)(
    "resumes the original interrupted Run only after yield and a current checkpoint (%s)",
    async (boundary) => {
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const fixture = await createFixture([
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(new DOMException("Model fixture aborted", "AbortError")),
              { once: true },
            );
            entered();
          }),
      ]);
      const run = await startAgent(fixture);
      await enteredPromise;
      await fixture.runtime.interruptAll();
      expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");
      const gate = userTakeoverGate();
      const provider = new ScriptedProvider([finalTurn("原任务继续完成。")]);
      const restarted = createRuntimeFor(
        fixture,
        provider,
        undefined,
        undefined,
        gate.before,
      );
      const pending = restarted.resume({
        runId: run.id,
        requestedAt: REQUESTED_AT,
      });
      const rejected =
        boundary === "checkpoint"
          ? expect(pending).rejects.toMatchObject({
              code: "AGENT.RUN_NOT_RESUMABLE",
            })
          : undefined;
      try {
        await gate.entered;
        expect(gate.continuingRunIds).toEqual([run.id]);
        expect(provider.requests).toHaveLength(0);
        expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");
        if (boundary === "checkpoint") {
          const checkpoint = fixture.checkpoints.get(run.id)!;
          fixture.checkpoints.save({
            ...checkpoint,
            generation: checkpoint.generation + 1,
          });
        }
        gate.release();
        if (rejected) {
          await rejected;
          expect(provider.requests).toHaveLength(0);
          expect(fixture.runs.getRun(run.id)?.status).toBe("interrupted");
        } else {
          expect(await pending).toEqual({ runId: run.id });
          await waitForStatus(fixture, run.id, "completed");
          expect(provider.requests).toHaveLength(1);
          expect(fixture.runs.listRunsByStatus(["completed"])).toHaveLength(1);
        }
      } finally {
        gate.release();
        await restarted.interruptAll();
        fixture.database.close();
      }
    },
  );

  it("does not yield again for a completed approval or an invalid continuation", async () => {
    const before = vi.fn(() => Promise.resolve());
    const fixture = await createFixture(
      [functionTurn("write", "test.write", {}), finalTurn("写入完成。")],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      before,
    );
    registerTool(fixture, {
      name: "test.write",
      effect: "write",
      execute: () => Promise.resolve(successfulResult("written")),
    });
    const run = await startAgent(fixture, "request_approval");
    await waitForStatus(fixture, run.id, "waiting_approval");
    const approval = fixture.runtime.getPendingApproval()!;
    const request = {
      approvalId: approval.id,
      decidedAt: REQUESTED_AT,
      decision: "approved" as const,
    };
    await fixture.runtime.resolveApproval(request);
    await waitForStatus(fixture, run.id, "completed");
    before.mockClear();
    expect(await fixture.runtime.resolveApproval(request)).toMatchObject({
      id: approval.id,
      status: "approved",
    });
    await expect(
      fixture.runtime.steer({
        runId: run.id,
        requestedAt: REQUESTED_AT,
        content: "迟到的消息",
      }),
    ).rejects.toMatchObject({ code: "AGENT.RUN_NOT_ACTIVE" });
    await expect(
      fixture.runtime.resume({ runId: run.id, requestedAt: REQUESTED_AT }),
    ).rejects.toMatchObject({ code: "AGENT.RUN_NOT_RESUMABLE" });
    expect(before).not.toHaveBeenCalled();
    fixture.database.close();
  });
});

describe("structured user continuation of a quiet Run", () => {
  it("requires a normal answer after a real input resolution", async () => {
    const fixture = await createFixture([
      namespacedFunctionTurn("question", "request_user_input", "interaction", {
        questions: takeoverQuestions,
      }),
      () => [complete("empty-after-answer")],
    ]);
    const run = await fixture.runtime.startAssistantInitiated(
      {
        attachments: [],
        chatId: fixture.chatId,
        content: "可以安静结束的自主活动。",
        execution: { mode: "chat" },
        providerProfileId: PROFILE_ID,
        requestedAt: REQUESTED_AT,
      },
      {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        quietCompletionAllowed: true,
      },
    );
    await waitForStatus(fixture, run.id, "needs_input");
    const item = fixture.runs
      .listRunItems(run.id)
      .find(({ kind }) => kind === "input_request")!;
    await fixture.runtime.resolveUserInput({
      runId: run.id,
      itemId: item.id,
      resolution: {
        status: "answered",
        resolvedAt: REQUESTED_AT,
        answers: [
          { questionId: "scope", value: { kind: "option", label: "笔记" } },
        ],
      },
    });
    await waitForStatus(fixture, run.id, "failed");
    expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
      "AGENT.EMPTY_RESPONSE",
    );
    expect(JSON.stringify(fixture.provider.requests[1]?.input)).toContain(
      "笔记",
    );
    fixture.database.close();
  });
});

function preparationGate() {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}

function preparationModelRuntime(fixture: RuntimeFixture) {
  return {
    provider: fixture.provider,
    snapshot: {
      apiStyle: "openai-compatible" as const,
      modelId: "gpt-6-astra",
      profileId: PROFILE_ID,
      profileName: "Offline fixture",
    },
  };
}

function preparationRuntimeFor(
  fixture: RuntimeFixture,
  factory: ConstructorParameters<
    typeof AgentRuntime
  >[6]["createChatModelRuntime"],
  context?: ChatContextService,
) {
  const ids = new CryptoIdGenerator();
  const clock = new SystemClock();
  const chats = new ChatRepository(fixture.database);
  return new AgentRuntime(
    chats,
    new ChatService(chats, fixture.runs, ids, clock),
    fixture.runs,
    fixture.checkpoints,
    fixture.writer,
    fixture.tools,
    { createChatModelRuntime: factory },
    ids,
    clock,
    { getActiveSnapshot: () => defaultPersonaSnapshot(clock.now()) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    context,
  );
}

function preparationRequest(chatId: string) {
  return {
    attachments: [],
    chatId,
    content: "整理这段普通对话。",
    execution: { mode: "chat" as const },
    providerProfileId: PROFILE_ID,
    requestedAt: REQUESTED_AT,
  };
}

function preparationOutcome<T>(task: Promise<T>) {
  return task.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function preparationTurn() {
  // A deterministic event-loop boundary, not a delay or product timeout.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("preparation ownership", () => {
  it.each(
    (["start", "inline"] as const).flatMap((method) =>
      (["provider", "metadata", "chat_context"] as const).map((boundary) => ({
        method,
        boundary,
      })),
    ),
  )(
    "joins ordinary $method at $boundary without an external signal",
    async ({ method, boundary }) => {
      const fixture = await createFixture([]);
      const gate = preparationGate();
      let suppliedSignal: AbortSignal | undefined;
      const context = new ChatContextService(
        new ChatRepository(fixture.database),
        new SystemClock(),
        fixture.runs,
      );
      const prepare = context.prepare.bind(context);
      const metadata = fixture.provider.resolveContextLimits.bind(
        fixture.provider,
      );
      if (boundary === "metadata") {
        vi.spyOn(fixture.provider, "resolveContextLimits").mockImplementation(
          async (modelId, signal) => {
            suppliedSignal = signal;
            gate.enter();
            await gate.released;
            return metadata(modelId, signal);
          },
        );
      }
      if (boundary === "chat_context") {
        vi.spyOn(context, "prepare").mockImplementation(async (request) => {
          suppliedSignal = request.signal;
          gate.enter();
          await gate.released;
          return prepare(request);
        });
      }
      const runtime = preparationRuntimeFor(
        fixture,
        async () => {
          if (boundary === "provider") {
            gate.enter();
            await gate.released; // safeStorage-style Promise without an AbortSignal API
          }
          return preparationModelRuntime(fixture);
        },
        context,
      );
      const allocated = vi.fn();
      const pending = preparationOutcome(
        method === "start"
          ? runtime.start(preparationRequest(fixture.chatId))
          : runtime.startInlineConversation(
              preparationRequest(fixture.chatId),
              { onRunAllocated: allocated },
            ),
      );
      let stopping: Promise<void> | undefined;
      try {
        await gate.entered;
        expectNoPersistedRunOrMessage(fixture);
        let stopped = false;
        stopping = runtime.interruptAll().then(() => {
          stopped = true;
        });
        await preparationTurn();
        const returnedBeforePreparationSettled = stopped;
        const propagatedAbort = suppliedSignal?.aborted;
        gate.release();
        const [outcome] = await Promise.all([pending, stopping]);
        await runtime.interruptAll();
        expect(returnedBeforePreparationSettled).toBe(false);
        if (boundary !== "provider") expect(propagatedAbort).toBe(true);
        expect(outcome.ok).toBe(false);
        expectNoPersistedRunOrMessage(fixture);
        expect(allocated).not.toHaveBeenCalled();
        expect(fixture.provider.requests).toHaveLength(0);
      } finally {
        gate.release();
        await pending;
        await stopping;
        await runtime.interruptAll();
        fixture.database.close();
      }
    },
  );

  it("does not close a real SQLite connection before the held preparation settles", async () => {
    const fixture = await createFixture([]);
    const gate = preparationGate();
    const order: string[] = [];
    const context = new ChatContextService(
      new ChatRepository(fixture.database),
      new SystemClock(),
      fixture.runs,
    );
    const prepare = context.prepare.bind(context);
    vi.spyOn(context, "prepare").mockImplementation(async (request) => {
      gate.enter();
      await gate.released;
      order.push("prepare-resumed");
      return prepare(request); // actual repository access, not a fake completed projection
    });
    const runtime = preparationRuntimeFor(
      fixture,
      () => Promise.resolve(preparationModelRuntime(fixture)),
      context,
    );
    const pending = preparationOutcome(
      runtime.start(preparationRequest(fixture.chatId)),
    ).then((outcome) => {
      order.push("operation-settled");
      return outcome;
    });
    let closing: Promise<void> | undefined;
    try {
      await gate.entered;
      closing = runtime.interruptAll().then(() => {
        order.push("database-close");
        fixture.database.close();
      });
      await preparationTurn();
      gate.release();
      const [outcome] = await Promise.all([pending, closing]);
      expect(order.indexOf("prepare-resumed")).toBeLessThan(
        order.indexOf("database-close"),
      );
      expect(outcome.ok).toBe(false);
      expect(fixture.provider.requests).toHaveLength(0);
      // On the current source the close happens first and the real repository
      // access fails. Do not match localized SQLite wording as the oracle.
    } finally {
      gate.release();
      await pending;
      await closing;
      if (fixture.database.open) {
        await runtime.interruptAll();
        fixture.database.close();
      }
    }
  });

  it("owns both the running preparation and the same-Chat serialized successor", async () => {
    const fixture = await createFixture([]);
    const gate = preparationGate();
    const context = new ChatContextService(
      new ChatRepository(fixture.database),
      new SystemClock(),
      fixture.runs,
    );
    const prepare = context.prepare.bind(context);
    vi.spyOn(context, "prepare").mockImplementation(async (request) => {
      gate.enter();
      await gate.released;
      return prepare(request);
    });
    const runtime = preparationRuntimeFor(
      fixture,
      () => Promise.resolve(preparationModelRuntime(fixture)),
      context,
    );
    const first = preparationOutcome(
      runtime.start(preparationRequest(fixture.chatId)),
    );
    await gate.entered;
    const second = preparationOutcome(
      runtime.start(preparationRequest(fixture.chatId)),
    );
    const stopping = runtime.interruptAll();
    try {
      await preparationTurn();
      gate.release();
      const outcomes = await Promise.all([first, second]);
      await stopping;
      await runtime.interruptAll();
      expect(outcomes.every(({ ok }) => !ok)).toBe(true);
      expectNoPersistedRunOrMessage(fixture);
      expect(fixture.provider.requests).toHaveLength(0);
    } finally {
      gate.release();
      await Promise.all([first, second, stopping]);
      await runtime.interruptAll();
      fixture.database.close();
    }
  });
});

async function preparationRestoredFixture(kind: "resume" | "input") {
  const modelEntered = preparationGate();
  const seed = await createFixture(
    kind === "resume"
      ? [
          (_request, signal) => {
            modelEntered.enter();
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () =>
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new DOMException("Cancelled", "AbortError"),
                  ),
                {
                  once: true,
                },
              );
              if (signal.aborted)
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Cancelled", "AbortError"),
                );
            });
          },
        ]
      : [
          namespacedFunctionTurn(
            "question",
            "request_user_input",
            "interaction",
            {
              questions: [
                {
                  id: "destination",
                  header: "位置",
                  question: "放在哪个目录？",
                  options: [
                    { label: "当前目录", description: "保留在当前目录。" },
                    { label: "子目录", description: "放入指定子目录。" },
                  ],
                },
              ],
            },
          ),
        ],
  );
  const run = await seed.runtime.start(preparationRequest(seed.chatId));
  if (kind === "resume") {
    await modelEntered.entered;
    await seed.runtime.interruptAll();
    expect(seed.runs.getRun(run.id)?.status).toBe("interrupted");
  } else {
    await waitForStatus(seed, run.id, "needs_input");
  }
  const item = seed.runs
    .listRunItems(run.id)
    .find(({ kind }) => kind === "input_request");
  // Real prior Run/checkpoint, SQLite backup, then close/reopen; no hand-authored
  // Run state and no second live owner sharing the restored connection.
  const file = path.join(path.dirname(seed.database.name), "restored.sqlite");
  await seed.database.backup(file);
  await seed.runtime.interruptAll();
  seed.database.close();
  const database = openApplicationDatabase(file);
  const runs = new RunRepository(database);
  const collector = new EventCollector();
  const checkpoints = new CheckpointRepository(database);
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, collector),
    new CryptoIdGenerator(),
    new SystemClock(),
  );
  const provider = new ScriptedProvider([]);
  const fixture = {
    ...seed,
    database,
    runs,
    collector,
    checkpoints,
    writer,
    provider,
  };
  return { fixture, runId: run.id, itemId: item?.id };
}

describe("restored preparation ownership", () => {
  it.each(
    (["resume", "input"] as const).flatMap((method) =>
      (["shutdown", "stop"] as const).map((control) => ({ method, control })),
    ),
  )(
    "joins $method Provider preparation during $control",
    async ({ method, control }) => {
      const { fixture, runId, itemId } =
        await preparationRestoredFixture(method);
      const beforeRun = fixture.runs.getRun(runId);
      const gate = preparationGate();
      const runtime = preparationRuntimeFor(fixture, async () => {
        gate.enter();
        await gate.released;
        return preparationModelRuntime(fixture);
      });
      const pending = preparationOutcome<unknown>(
        method === "resume"
          ? runtime.resume({ runId, requestedAt: REQUESTED_AT })
          : runtime.resolveUserInput({
              runId,
              itemId: itemId!,
              resolution: { status: "cancelled", resolvedAt: REQUESTED_AT },
            }),
      );
      let stopping: Promise<unknown> | undefined;
      try {
        await gate.entered;
        let stopped = false;
        stopping = (
          control === "shutdown"
            ? runtime.interruptAll()
            : runtime.cancel({ runId, requestedAt: REQUESTED_AT })
        ).then((value) => {
          stopped = true;
          return value;
        });
        await preparationTurn();
        const returnedBeforePreparationSettled = stopped;
        gate.release();
        const [outcome] = await Promise.all([pending, stopping]);
        await runtime.interruptAll();
        expect(returnedBeforePreparationSettled).toBe(false);
        expect(outcome.ok).toBe(false);
        expect(fixture.provider.requests).toHaveLength(0);
        if (control === "shutdown" || method === "resume") {
          expect(fixture.runs.getRun(runId)).toEqual(beforeRun);
        } else {
          expect(fixture.runs.getRun(runId)?.status).toBe("cancelled");
        }
        expect(
          fixture.collector.events.some(
            ({ event }) => event.type === "input.resolved",
          ),
        ).toBe(false);
      } finally {
        gate.release();
        await pending;
        await stopping;
        await runtime.interruptAll();
        fixture.database.close();
      }
    },
  );
});

describe("submission identity and lifecycle ownership", () => {
  it("cancels only the identified preparation, rejects its duplicate and leaves another Chat usable", async () => {
    const fixture = await createFixture([finalTurn("另一个会话完成")]);
    const gate = preparationGate();
    let calls = 0;
    const runtime = preparationRuntimeFor(fixture, async () => {
      calls += 1;
      if (calls === 1) {
        gate.enter();
        await gate.released;
      }
      return preparationModelRuntime(fixture);
    });
    const requestId = "20000000-0000-4000-8000-000000000001";
    const pending = preparationOutcome(
      runtime.start(preparationRequest(fixture.chatId), { requestId }),
    );
    try {
      await gate.entered;
      await expect(
        runtime.start(preparationRequest(fixture.chatId), { requestId }),
      ).rejects.toMatchObject({ code: "AGENT.REQUEST_IN_PROGRESS" });
      const chats = new ChatRepository(fixture.database);
      const other = new ChatService(
        chats,
        fixture.runs,
        new CryptoIdGenerator(),
        new SystemClock(),
      ).create({});
      const otherRun = await runtime.start(preparationRequest(other.id), {
        requestId: "20000000-0000-4000-8000-000000000002",
      });
      await waitForStatus(fixture, otherRun.id, "completed");
      let settled = false;
      const stopping = runtime
        .cancelStart({ requestId, requestedAt: REQUESTED_AT })
        .then((value) => {
          settled = true;
          return value;
        });
      await preparationTurn();
      expect(settled).toBe(false);
      gate.release();
      expect(await stopping).toEqual({ requestId, outcome: "accepted" });
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: "AGENT.PREPARATION_CANCELLED" },
      });
      expect(
        fixture.runs
          .listRunsByStatus([
            "queued",
            "running",
            "waiting_approval",
            "needs_input",
            "completed",
            "cancelled",
            "interrupted",
            "failed",
          ])
          .filter(({ chatId }) => chatId === fixture.chatId),
      ).toEqual([]);
      expect(fixture.runs.getRun(otherRun.id)?.status).toBe("completed");
      expect(fixture.provider.requests).toHaveLength(1);
      expect(
        await runtime.cancelStart({ requestId, requestedAt: REQUESTED_AT }),
      ).toEqual({ requestId, outcome: "not_pending" });
    } finally {
      gate.release();
      await pending;
      await runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("keeps identity after allocation before the start reply is delivered, then joins the real Tool", async () => {
    const entered = preparationGate();
    const exiting = preparationGate();
    const reply = preparationGate();
    const fixture = await createFixture([
      functionTurn("held-tool", "test.held", {}),
    ]);
    registerTool(fixture, {
      name: "test.held",
      execute: async (_input, signal) => {
        entered.enter();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              exiting.enter();
              resolve();
            },
            { once: true },
          );
        });
        await exiting.released;
        signal.throwIfAborted();
        return successfulResult("unreachable");
      },
    });
    const requestId = "20000000-0000-4000-8000-000000000003";
    const pendingReply = fixture.runtime
      .start(
        {
          ...preparationRequest(fixture.chatId),
          execution: { mode: "agent", approvalMode: "full_access" },
        },
        { requestId },
      )
      .then(async (run) => {
        reply.enter();
        await reply.released;
        return run;
      });
    try {
      await reply.entered;
      await entered.entered;
      let stopped = false;
      const stopping = fixture.runtime
        .cancelStart({ requestId, requestedAt: REQUESTED_AT })
        .then((result) => {
          stopped = true;
          return result;
        });
      await exiting.entered;
      expect(stopped).toBe(false);
      exiting.release();
      const result = await stopping;
      expect(result).toMatchObject({
        requestId,
        outcome: "accepted",
      });
      expect(typeof result.runId).toBe("string");
      expect(result.runId).not.toBe(requestId);
      expect(fixture.runs.getRun(result.runId!)?.status).toBe("cancelled");
      reply.release();
      expect((await pendingReply).id).toBe(result.runId);
      expect(
        await fixture.runtime.cancelStart({
          requestId,
          requestedAt: REQUESTED_AT,
        }),
      ).toEqual({ requestId, outcome: "not_pending" });
    } finally {
      exiting.release();
      reply.release();
      await pendingReply;
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("drops failed preparation identity and closes admission once shutdown starts", async () => {
    const fixture = await createFixture([]);
    const runtime = preparationRuntimeFor(fixture, () =>
      Promise.reject(
        new ProviderError("PROVIDER.REQUEST_FAILED", "Fixture failure", false),
      ),
    );
    const requestId = "20000000-0000-4000-8000-000000000004";
    try {
      await expect(
        runtime.start(preparationRequest(fixture.chatId), { requestId }),
      ).rejects.toBeInstanceOf(ProviderError);
      expect(
        await runtime.cancelStart({ requestId, requestedAt: REQUESTED_AT }),
      ).toEqual({ requestId, outcome: "not_pending" });
      const stopping = runtime.interruptAll();
      expect(runtime.interruptAll()).toBe(stopping);
      await expect(
        runtime.start(preparationRequest(fixture.chatId)),
      ).rejects.toMatchObject({ code: "AGENT.APP_SHUTTING_DOWN" });
      await stopping;
      expectNoPersistedRunOrMessage(fixture);
    } finally {
      await runtime.interruptAll();
      fixture.database.close();
    }
  });
});

it.each(["input", "approval"] as const)(
  "joins the actual %s waiter before SQLite close and restores the same pending boundary in a new Runtime",
  async (kind) => {
    const question = {
      questions: [
        {
          id: "next",
          header: "继续",
          question: "是否继续？",
          options: [
            { label: "继续", description: "继续任务" },
            { label: "停止", description: "停止任务" },
          ],
        },
      ],
    };
    const seed = await createFixture([
      functionTurn("read-once", "test.read", {}),
      kind === "input"
        ? namespacedFunctionTurn(
            "question",
            "request_user_input",
            "interaction",
            question,
          )
        : functionTurn("write-after-approval", "test.write", {}),
    ]);
    let reads = 0;
    let writes = 0;
    registerTool(seed, {
      name: "test.read",
      execute: () => {
        reads += 1;
        return Promise.resolve(successfulResult("read"));
      },
    });
    registerTool(seed, {
      name: "test.write",
      effect: "write",
      idempotency: "non_idempotent",
      execute: () => {
        writes += 1;
        return Promise.resolve(successfulResult("write"));
      },
    });
    const run = await startAgent(seed, "request_approval");
    const waiting = kind === "input" ? "needs_input" : "waiting_approval";
    await waitForStatus(seed, run.id, waiting);
    const before = {
      run: seed.runs.getRun(run.id),
      items: seed.runs.listRunItems(run.id),
      checkpoint: seed.checkpoints.get(run.id),
      approval: seed.runtime.getPendingApproval(),
    };
    await seed.runtime.interruptAll();
    expect(seed.runs.getRun(run.id)).toEqual(before.run);
    expect(seed.runs.listRunItems(run.id)).toEqual(before.items);
    expect(seed.checkpoints.get(run.id)).toEqual(before.checkpoint);
    expect(seed.runtime.getPendingApproval()).toEqual(before.approval);
    await expect(
      seed.runtime.resume({ runId: run.id, requestedAt: REQUESTED_AT }),
    ).rejects.toMatchObject({ code: "AGENT.APP_SHUTTING_DOWN" });
    const file = seed.database.name;
    seed.database.close();
    const database = openApplicationDatabase(file);
    const runs = new RunRepository(database);
    const checkpoints = new CheckpointRepository(database);
    const collector = new EventCollector();
    const writer = new RunEventWriter(
      runs,
      new RunEventService(runs, collector),
      new CryptoIdGenerator(),
      new SystemClock(),
    );
    const provider = new ScriptedProvider([finalTurn("恢复后的真实终态")]);
    const restored = {
      ...seed,
      database,
      runs,
      checkpoints,
      collector,
      writer,
      provider,
    };
    const runtime = preparationRuntimeFor(restored, () =>
      Promise.resolve(preparationModelRuntime(restored)),
    );
    try {
      await runtime.initialize();
      expect(runs.getRun(run.id)).toEqual(before.run);
      expect(checkpoints.get(run.id)).toEqual(before.checkpoint);
      expect(runs.listRunItems(run.id)).toEqual(before.items);
      expect(provider.requests).toHaveLength(0);
      expect(reads).toBe(1);
      expect(writes).toBe(0);
      if (kind === "input") {
        const input = before.items.find(
          ({ kind }) => kind === "input_request",
        )!;
        await runtime.resolveUserInput({
          runId: run.id,
          itemId: input.id,
          resolution: {
            status: "answered",
            resolvedAt: REQUESTED_AT,
            answers: [
              { questionId: "next", value: { kind: "option", label: "继续" } },
            ],
          },
        });
      } else {
        expect(runtime.getPendingApproval()?.id).toBe(before.approval!.id);
        await runtime.resolveApproval({
          approvalId: before.approval!.id,
          decision: "approved",
          decidedAt: REQUESTED_AT,
        });
      }
      await waitForStatus(restored, run.id, "completed");
      expect(reads).toBe(1);
      expect(writes).toBe(kind === "approval" ? 1 : 0);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await runtime.interruptAll();
      database.close();
    }
  },
);

it("owns Provider initialization for a persisted waiting Run during application startup", async () => {
  const { fixture, runId } = await preparationRestoredFixture("input");
  const before = {
    run: fixture.runs.getRun(runId),
    checkpoint: fixture.checkpoints.get(runId),
    items: fixture.runs.listRunItems(runId),
  };
  const gate = preparationGate();
  const runtime = preparationRuntimeFor(fixture, async () => {
    gate.enter();
    await gate.released;
    return preparationModelRuntime(fixture);
  });
  const initializing = preparationOutcome(runtime.initialize());
  try {
    await gate.entered;
    let stopped = false;
    const stopping = runtime.interruptAll().then(() => {
      stopped = true;
    });
    await preparationTurn();
    expect(stopped).toBe(false);
    gate.release();
    expect(await initializing).toMatchObject({
      ok: false,
      error: { code: "AGENT.APP_SHUTTING_DOWN" },
    });
    await stopping;
    expect(fixture.runs.getRun(runId)).toEqual(before.run);
    expect(fixture.checkpoints.get(runId)).toEqual(before.checkpoint);
    expect(fixture.runs.listRunItems(runId)).toEqual(before.items);
    expect(fixture.provider.requests).toHaveLength(0);
  } finally {
    gate.release();
    await initializing;
    await runtime.interruptAll();
    fixture.database.close();
  }
});

it("persists separate raw assistant messages without deltas and replays them in the next ordinary Run", async () => {
  const messages: JsonValue[] = [
    {
      id: "phase-progress",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "检查中。", annotations: [] }],
    },
    {
      id: "phase-answer",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "结果。", annotations: [] }],
    },
  ];
  const f = await createFixture([
    () => [
      {
        type: "response.completed",
        responseId: "phase-response",
        status: "completed",
        outputEvents: messages.map((item, outputIndex) => ({
          type: "output.item" as const,
          item,
          outputIndex,
        })),
        usage: {},
      },
    ],
    finalTurn("后续回答。"),
  ]);
  try {
    const first = await startAgent(f);
    await waitForStatus(f, first.id, "completed");
    const chat = new ChatRepository(f.database);
    const displayed = chat
      .listMessages(f.chatId)
      .filter((message) => message.role === "assistant");
    expect(displayed).toHaveLength(1);
    expect(displayed[0]?.content).toBe("检查中。结果。");
    expect(displayed[0]).not.toHaveProperty("phase");
    expect(f.runs.getAssistantMessages(first.id, displayed[0]!.id)).toEqual(
      messages,
    );
    const second = await startAgent(f);
    await waitForStatus(f, second.id, "completed");
    const input = f.provider.requests[1]!.input;
    expect(
      input.filter((value) =>
        messages.some(
          (message) => JSON.stringify(message) === JSON.stringify(value),
        ),
      ),
    ).toEqual(messages);
    expect(input).not.toContainEqual({
      type: "message",
      role: "assistant",
      content: "检查中。结果。",
    });
    expect(f.provider.requests).toHaveLength(2);
  } finally {
    await f.runtime.interruptAll();
    f.database.close();
  }
});

it.each(["failure", "cancel"] as const)(
  "excludes a partial response after %s even when one final-labelled output item completed",
  async (outcome) => {
    const f = await createFixture([]);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(f.provider, "stream").mockImplementation(
      async function* (_request, signal) {
        yield await Promise.resolve<ModelEvent>({
          type: "text.delta",
          delta: "只有这一段。",
        });
        yield {
          type: "output.item",
          item: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "只有这一段。" }],
          },
        };
        entered();
        if (outcome === "cancel") {
          await new Promise<void>((_resolve, reject) => {
            const rejectAbort = () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("Operation was aborted", "AbortError"),
              );
            signal.addEventListener("abort", rejectAbort, { once: true });
            if (signal.aborted) rejectAbort();
          });
        }
        throw new Error("recorded partial failure");
      },
    );
    try {
      const run = await startAgent(f);
      await ready;
      if (outcome === "cancel")
        await f.runtime.cancel({ runId: run.id, requestedAt: REQUESTED_AT });
      await waitForStatus(
        f,
        run.id,
        outcome === "cancel" ? "cancelled" : "failed",
      );
      const chat = new ChatRepository(f.database);
      const partial = chat
        .listMessages(f.chatId)
        .find((message) => message.role === "assistant")!;
      expect(partial.status).toBe(
        outcome === "cancel" ? "cancelled" : "failed",
      );
      expect(f.runs.getAssistantMessages(run.id, partial.id)).toBeUndefined();
      const projection = new ChatContextService(
        chat,
        new SystemClock(),
        f.runs,
      ).project(f.chatId);
      expect(JSON.stringify(projection.input)).not.toContain("只有这一段。");
    } finally {
      await f.runtime.interruptAll();
      f.database.close();
    }
  },
);

it("keeps committed assistant phase and Chat when completion publication fails", async () => {
  const original: JsonValue = {
    id: "durable-phase",
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text: "已返回的正文。", annotations: [] }],
  };
  const f = await createFixture([
    () => [
      {
        type: "response.completed",
        responseId: "durable-response",
        status: "completed",
        outputEvents: [{ type: "output.item", item: original }],
        usage: {},
      },
    ],
  ]);
  const publish = f.collector.publish;
  vi.spyOn(f.collector, "publish").mockImplementation((envelope) => {
    if (
      envelope.event.type === "item.completed" &&
      envelope.event.item.kind === "assistant_message"
    ) {
      expect(f.database.inTransaction).toBe(false);
      throw new Error("completion publication failed after commit");
    }
    publish(envelope);
  });
  try {
    const run = await startAgent(f);
    await waitForStatus(f, run.id, "failed");
    const messages = new ChatRepository(f.database)
      .listMessages(f.chatId)
      .filter((message) => message.role === "assistant");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBe("completed");
    expect(f.runs.getAssistantMessages(run.id, messages[0]!.id)).toEqual([
      original,
    ]);
    const items = f.runs
      .listRunItems(run.id)
      .filter((item) => item.kind === "assistant_message");
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("completed");
    expect(
      f.runs
        .replay({ streamId: run.id, afterSequence: 0 })
        .events.filter(
          ({ event }) =>
            event.type === "item.completed" && event.item.id === items[0]!.id,
        ),
    ).toHaveLength(1);
  } finally {
    await f.runtime.interruptAll();
    f.database.close();
  }
});

describe("complete Tool result working-set allocation", () => {
  const outputs = (request: ModelRequest, callId: string) =>
    request.input.filter(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item["type"] === "function_call_output" &&
        item["call_id"] === callId,
    );

  it.each([
    { limits: { effectiveInputTokens: 922_000 }, expected: 258_000 },
    {
      limits: {
        effectiveInputTokens: 70_000,
        maxContextTokens: 50_000,
        maxOutputTokens: 10_000,
      },
      expected: 40_000,
    },
  ])(
    "measures actual normalized outputs and keeps multiple raw calls at budget $expected",
    async ({ limits, expected }) => {
      const phase: JsonValue = {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "正在查阅。", annotations: [] }],
      };
      const f = await createFixture(
        [
          () => [
            { type: "output.item", item: phase },
            ...["read-a", "read-b"].map((id): ModelEvent => ({
              type: "output.item",
              item: {
                type: "function_call",
                call_id: id,
                name: "test.measured",
                arguments: JSON.stringify({ value: id }),
              },
            })),
            complete("two-real-calls"),
          ],
          finalTurn("采用已返回材料。"),
        ],
        undefined,
        undefined,
        undefined,
        limits,
      );
      const measurements: ModelRequest[] = [];
      let calls = 0;
      const measure = f.provider.measureInput.bind(f.provider);
      vi.spyOn(f.provider, "measureInput").mockImplementation(
        (request, signal) => {
          if (
            outputs(request, "read-a").length ||
            outputs(request, "read-b").length
          )
            measurements.push(structuredClone(request));
          return measure(request, signal);
        },
      );
      registerTool(f, {
        name: "test.measured",
        execute: async (input, _signal, context) => {
          calls += 1;
          let result: ToolResult = {
            ...successfulResult("查阅完成"),
            modelContent: {
              source: input["value"]!,
              text: "完整材料\n".repeat(1000),
              apiKey: "fixture-value",
            },
          };
          let observation = await context.measureResult!(result);
          if (
            !fitsInputBudget(
              observation.measurement,
              observation.inputBudgetTokens,
            )
          ) {
            result = {
              ...result,
              modelContent: {
                source: input["value"]!,
                text: "较小的完整来源",
                apiKey: "fixture-value",
              },
            };
            observation = await context.measureResult!(result);
          }
          expect(
            fitsInputBudget(
              observation.measurement,
              observation.inputBudgetTokens,
            ),
          ).toBe(true);
          expect(observation.kind).toBe("responses_request");
          expect(observation.inputBudgetTokens).toBe(expected);
          expect(f.checkpoints.get(context.runId)?.phase).toBe("tool");
          expect(f.runs.getRunItem(context.itemId)?.status).toBe("running");
          return result;
        },
      });
      try {
        const run = await startAgent(f);
        await waitForStatus(f, run.id, "completed");
        expect(calls).toBe(2);
        const first = measurements[0]!;
        expect(first.input).toContainEqual(phase);
        expect(first.input).toContainEqual(
          expect.objectContaining({ type: "function_call", call_id: "read-b" }),
        );
        expect(outputs(first, "read-b")).toHaveLength(0);
        expect(first.allowedTools).toBeUndefined();
        expect(JSON.stringify(first.input)).not.toContain("fixture-value");
        const final = f.provider.requests.at(-1)!;
        for (const id of ["read-a", "read-b"]) {
          expect(outputs(final, id)).toHaveLength(1);
          const observed = measurements.findLast(
            (request) => outputs(request, id).length,
          )!;
          expect(outputs(observed, id)).toEqual(outputs(final, id));
        }
        expect(
          f.runs
            .listRunItems(run.id)
            .filter((item) => item.kind === "context_compaction"),
        ).toEqual([]);
      } finally {
        await f.runtime.interruptAll();
        f.database.close();
      }
    },
  );

  it("remeasures steering without refreshing ordinary state or executing the later stale call", async () => {
    const gate = preparationGate();
    const f = await createFixture([
      () => [
        ...[
          ["current-read", "test.measured"],
          ["later-write", "test.write"],
        ].map(([id, name]): ModelEvent => ({
          type: "output.item",
          item: {
            type: "function_call",
            call_id: id!,
            name: name!,
            arguments: "{}",
          },
        })),
        complete("read-and-later-write"),
      ],
      finalTurn("按新输入继续。"),
    ]);
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(
      (input) =>
        Promise.resolve({
          ...emptyCognition(),
          text: `ordinary:${input.currentInput}`,
        }),
    );
    const runtime = createRuntimeFor(f, f.provider, { prepareTurn });
    const counted: string[] = [];
    const measure = f.provider.measureInput.bind(f.provider);
    vi.spyOn(f.provider, "measureInput").mockImplementation(
      async (request, signal) => {
        if (outputs(request, "current-read").length) {
          counted.push(JSON.stringify(request.input));
          if (counted.length === 1) {
            gate.enter();
            await gate.released;
          }
        }
        return measure(request, signal);
      },
    );
    let reads = 0;
    let writes = 0;
    registerTool(f, {
      name: "test.measured",
      execute: async (_input, _signal, context) => {
        reads += 1;
        const result = successfulResult("实际读取结果");
        await context.measureResult!(result);
        return result;
      },
    });
    registerTool(f, {
      name: "test.write",
      effect: "write",
      execute: () => {
        writes += 1;
        return Promise.resolve(successfulResult("不该执行"));
      },
    });
    try {
      const run = await runtime.start({
        ...preparationRequest(f.chatId),
        content: "原问题",
        execution: { mode: "agent", approvalMode: "full_access" },
      });
      await gate.entered;
      await runtime.steer({
        runId: run.id,
        content: "新条件先别写",
        requestedAt: REQUESTED_AT,
      });
      expect(prepareTurn).toHaveBeenCalledTimes(1);
      expect(f.checkpoints.get(run.id)?.phase).toBe("tool");
      expect(JSON.stringify(f.checkpoints.get(run.id)?.context)).not.toContain(
        "实际读取结果",
      );
      gate.release();
      await waitForStatus(f, run.id, "completed");
      expect(reads).toBe(1);
      expect(writes).toBe(0);
      expect(counted[1]).toContain("新条件先别写");
      expect(counted[1]).not.toContain("ordinary:原问题");
      expect(counted[1]).not.toContain("ordinary:新条件先别写");
      expect(prepareTurn).toHaveBeenCalledTimes(2);
      const final = JSON.stringify(f.provider.requests.at(-1)!.input);
      expect(final).toContain("ordinary:新条件先别写");
      expect(final).toContain("实际读取结果");
      expect(final).toContain("TOOL.INPUT_CHANGED");
    } finally {
      gate.release();
      await runtime.interruptAll();
      f.database.close();
    }
  });

  it.each(["stop", "shutdown"] as const)(
    "joins a pending result count during %s and cannot publish late success",
    async (control) => {
      const gate = preparationGate();
      const f = await createFixture([
        functionTurn("held-result", "test.measured", {}),
      ]);
      const measure = f.provider.measureInput.bind(f.provider);
      vi.spyOn(f.provider, "measureInput").mockImplementation(
        async (request, signal) => {
          if (outputs(request, "held-result").length) {
            gate.enter();
            await gate.released;
          }
          return measure(request, signal);
        },
      );
      let completed = 0;
      registerTool(f, {
        name: "test.measured",
        execute: async (_input, _signal, context) => {
          const result = successfulResult("晚到材料不能提交");
          await context.measureResult!(result);
          completed += 1;
          return result;
        },
      });
      let stopping: Promise<unknown> | undefined;
      try {
        const run = await startAgent(f);
        await gate.entered;
        let joined = false;
        stopping = (
          control === "stop"
            ? f.runtime.cancel({ runId: run.id, requestedAt: REQUESTED_AT })
            : f.runtime.interruptAll()
        ).then(() => {
          joined = true;
        });
        await preparationTurn();
        expect(joined).toBe(false);
        gate.release();
        await stopping;
        expect(completed).toBe(0);
        expect(f.provider.requests).toHaveLength(1);
        expect(
          f.runs
            .listRunItems(run.id)
            .filter(
              (item) =>
                item.kind === "tool_call" && item.status === "completed",
            ),
        ).toEqual([]);
        if (control === "stop")
          expect(f.checkpoints.get(run.id)).toBeUndefined();
        else {
          expect(f.checkpoints.get(run.id)?.phase).toBe("interrupted");
          expect(f.checkpoints.get(run.id)?.context).toMatchObject({
            pendingTool: { callId: "held-result" },
          });
        }
      } finally {
        gate.release();
        await stopping;
        await f.runtime.interruptAll();
        f.database.close();
      }
    },
  );

  it("recovers a committed measured Item before the model checkpoint without redoing the read", async () => {
    const f = await createFixture([
      functionTurn("durable-result", "test.measured", {}),
    ]);
    let calls = 0;
    registerTool(f, {
      name: "test.measured",
      execute: async (_input, _signal, context) => {
        calls += 1;
        const result = successfulResult("真实已提交的读取材料");
        await context.measureResult!(result);
        return result;
      },
    });
    const publish = f.collector.publish;
    let stopping: Promise<void> | undefined;
    vi.spyOn(f.collector, "publish").mockImplementation((envelope) => {
      publish(envelope);
      if (
        envelope.event.type === "item.completed" &&
        envelope.event.item.kind === "tool_call"
      ) {
        expect(f.database.inTransaction).toBe(false);
        expect(f.runs.getRunItem(envelope.event.item.id)?.status).toBe(
          "completed",
        );
        stopping = f.runtime.interruptAll();
      }
    });
    const run = await startAgent(f);
    await waitForStatus(f, run.id, "interrupted");
    await stopping;
    expect(f.checkpoints.get(run.id)?.phase).toBe("interrupted");
    expect(f.checkpoints.get(run.id)?.context).toMatchObject({
      pendingTool: { callId: "durable-result" },
    });
    const stored = f.runs
      .listRunItems(run.id)
      .find((item) => item.kind === "tool_call")!.output;
    const fileName = f.database.name;
    f.database.close();
    const database = openApplicationDatabase(fileName);
    const resumed = {
      ...f,
      database,
      collector: new EventCollector(),
      runs: new RunRepository(database),
      checkpoints: new CheckpointRepository(database),
    };
    const provider = new ScriptedProvider([finalTurn("直接沿用已提交材料。")]);
    const runtime = createRuntimeFor(resumed, provider);
    try {
      await runtime.resume({ runId: run.id, requestedAt: REQUESTED_AT });
      await waitForStatus(resumed, run.id, "completed");
      expect(calls).toBe(1);
      expect(outputs(provider.requests[0]!, "durable-result")).toEqual([
        {
          type: "function_call_output",
          call_id: "durable-result",
          output: JSON.stringify(stored),
        },
      ]);
    } finally {
      await runtime.interruptAll();
      database.close();
    }
  });
});

describe("ordinary cognition refresh at actual Runtime boundaries", () => {
  const questions = [
    {
      header: "安排",
      id: "next",
      question: "接下来想做什么？",
      options: [
        { label: "聊天", description: "继续聊聊。" },
        { label: "阅读", description: "读一点书。" },
      ],
    },
  ];
  const questionTurn = () =>
    namespacedFunctionTurn(
      "cognition-question",
      "request_user_input",
      "interaction",
      { questions },
    );

  it("discards a read overtaken by another user correction without sending an obsolete request", async () => {
    const fixture = await createFixture([
      questionTurn(),
      finalTurn("使用最新情境。"),
    ]);
    const gate = preparationGate();
    const savedContexts: string[] = [];
    const save = fixture.checkpoints.save.bind(fixture.checkpoints);
    vi.spyOn(fixture.checkpoints, "save").mockImplementation((checkpoint) => {
      const saved = save(checkpoint);
      savedContexts.push(JSON.stringify(saved.context));
      return saved;
    });
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(
      async (input) => {
        if (input.currentInput === "第一次更正") {
          gate.enter();
          await gate.released;
        }
        return {
          ...emptyCognition(),
          text: `context-for:${input.currentInput}`,
        };
      },
    );
    const runtime = createRuntimeFor(fixture, fixture.provider, {
      prepareTurn,
    });
    const run = await runtime.start(preparationRequest(fixture.chatId));
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      await runtime.steer({
        runId: run.id,
        content: "第一次更正",
        requestedAt: REQUESTED_AT,
      });
      await gate.entered;
      await runtime.steer({
        runId: run.id,
        content: "第二次更正",
        requestedAt: REQUESTED_AT,
      });
      gate.release();
      await waitForStatus(fixture, run.id, "completed");
      expect(prepareTurn).toHaveBeenCalledTimes(3);
      expect(fixture.provider.requests).toHaveLength(2);
      const input = JSON.stringify(fixture.provider.requests[1]!.input);
      expect(input).toContain("context-for:第二次更正");
      expect(input).not.toContain("context-for:第一次更正");
      expect(input).not.toContain("context-for:整理这段普通对话");
      expect(input.match(/context-for:/g)).toHaveLength(1);
      expect(savedContexts.length).toBeGreaterThan(0);
      expect(savedContexts.join("\n")).not.toContain("context-for:第一次更正");
      expect(fixture.checkpoints.get(run.id)).toBeUndefined();
    } finally {
      gate.release();
      await runtime.interruptAll();
      fixture.database.close();
    }
  });

  it.each(["stop", "shutdown"] as const)(
    "joins a delayed cognition read during %s and discards its late result",
    async (control) => {
      const fixture = await createFixture([questionTurn()]);
      const gate = preparationGate();
      const savedContexts: string[] = [];
      const save = fixture.checkpoints.save.bind(fixture.checkpoints);
      vi.spyOn(fixture.checkpoints, "save").mockImplementation((checkpoint) => {
        const saved = save(checkpoint);
        savedContexts.push(JSON.stringify(saved.context));
        return saved;
      });
      const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(
        async (input) => {
          if (input.currentInput === "需要重新读取") {
            gate.enter();
            await gate.released;
            return { ...emptyCognition(), text: "late-unusable-context" };
          }
          return { ...emptyCognition(), text: "original-state" };
        },
      );
      const runtime = createRuntimeFor(fixture, fixture.provider, {
        prepareTurn,
      });
      const run = await runtime.start(preparationRequest(fixture.chatId));
      let stopping: Promise<unknown> | undefined;
      try {
        await waitForStatus(fixture, run.id, "needs_input");
        await runtime.steer({
          runId: run.id,
          content: "需要重新读取",
          requestedAt: REQUESTED_AT,
        });
        await gate.entered;
        let closed = false;
        stopping = (
          control === "stop"
            ? runtime.cancel({ runId: run.id, requestedAt: REQUESTED_AT })
            : runtime.interruptAll()
        ).then(() => {
          closed = true;
        });
        await preparationTurn();
        expect(closed).toBe(false);
        gate.release();
        await stopping;
        expect(fixture.provider.requests).toHaveLength(1);
        expect(fixture.runs.getRun(run.id)?.status).toBe(
          control === "stop" ? "cancelled" : "interrupted",
        );
        expect(savedContexts.length).toBeGreaterThan(0);
        expect(savedContexts.join("\n")).not.toContain("late-unusable-context");
        const checkpoint = fixture.checkpoints.get(run.id);
        if (control === "stop") expect(checkpoint).toBeUndefined();
        else {
          expect(checkpoint).toBeDefined();
          expect(JSON.stringify(checkpoint!.context)).not.toContain(
            "late-unusable-context",
          );
        }
      } finally {
        gate.release();
        await stopping;
        await runtime.interruptAll();
        fixture.database.close();
      }
    },
  );

  it("does not resend an unchanged over-budget required context after forced compaction", async () => {
    const failure = new ProviderError(
      "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      "required context does not fit",
      false,
    );
    const fixture = await createFixture([
      functionTurn("large-read", "test.read", {}),
      () => {
        throw failure;
      },
      () => {
        throw failure;
      },
    ]);
    registerTool(fixture, {
      name: "test.read",
      execute: () =>
        Promise.resolve(
          successfulResult("required-full-read:" + "x".repeat(260_000)),
        ),
    });
    const run = await startAgent(fixture);
    try {
      await waitForStatus(fixture, run.id, "failed");
      expect(fixture.provider.requests).toHaveLength(2);
      expect(fixture.runs.getRun(run.id)?.error?.code).toBe(
        "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      );
      expect(
        fixture.runs
          .listRunItems(run.id)
          .filter(({ kind }) => kind === "context_compaction"),
      ).toEqual([]);
    } finally {
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("retains the selected action basis, refreshed ordinary state and actual Tool result through Run compaction", async () => {
    const fixture = await createFixture([
      functionTurn("observed-before-question", "test.read", {}),
      questionTurn(),
      () => {
        throw new ProviderError(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          "force compact",
          true,
        );
      },
      finalTurn("保留依据和观察结果继续。"),
    ]);
    let reads = 0;
    registerTool(fixture, {
      name: "test.read",
      execute: () => {
        reads += 1;
        return Promise.resolve(successfulResult("actual-observed-world"));
      },
    });
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.resolve({ ...emptyCognition(), text: "current-user-state" }),
    );
    const runtime = createRuntimeFor(fixture, fixture.provider, {
      prepareTurn,
    });
    const run = await runtime.startAssistantInitiated(
      {
        ...preparationRequest(fixture.chatId),
        content: "继续已经选定的行动",
        execution: { mode: "agent", approvalMode: "full_access" },
      },
      {
        modelId: "gpt-6-astra",
        toolNames: ["test.read"],
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        prepareCognitionContext: () => ({
          ...emptyCognition(),
          text: "action-original-proof",
          decisionAttemptId: "10000000-0000-4000-8000-000000000081",
        }),
      },
    );
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      expect(prepareTurn).not.toHaveBeenCalled();
      await runtime.steer({
        runId: run.id,
        content: "按最新情况继续",
        requestedAt: REQUESTED_AT,
      });
      await waitForStatus(fixture, run.id, "completed");
      expect(prepareTurn).toHaveBeenCalledTimes(1);
      expect(reads).toBe(1);
      expect(fixture.provider.requests).toHaveLength(4);
      const input = JSON.stringify(fixture.provider.requests.at(-1)!.input);
      expect(input).toContain("action-original-proof");
      expect(input).toContain("current-user-state");
      expect(input).toContain("actual-observed-world");
      expect(input.match(/current-user-state/g)).toHaveLength(1);
      expect(fixture.runs.listRunItems(run.id)).toContainEqual(
        expect.objectContaining({
          kind: "context_compaction",
          status: "completed",
        }),
      );
    } finally {
      await runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("retains both selected action basis and newly refreshed state in first-request durable Chat compaction", async () => {
    const fixture = await createFixture([
      finalTurn("旧回答"),
      () => {
        throw new ProviderError(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          "force Chat compaction",
          true,
        );
      },
      chatSummaryTurn("之前的讨论已经结束。"),
      finalTurn("按更正后的安排继续。"),
    ]);
    const prior = await startAgent(fixture);
    await waitForStatus(fixture, prior.id, "completed");
    const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.resolve({
        ...emptyCognition(),
        text: "state-after-current-correction",
      }),
    );
    const runtime = createRuntimeFor(fixture, fixture.provider, {
      prepareTurn,
    });
    const estimate = fixture.provider.estimateInput.bind(fixture.provider);
    let delivered = false;
    let steering: Promise<unknown> | undefined;
    vi.spyOn(fixture.provider, "estimateInput").mockImplementation(
      (request) => {
        const active = fixture.runs.listRunsByStatus(["running"])[0];
        if (active && !delivered) {
          delivered = true;
          steering = runtime.steer({
            runId: active.id,
            content: "已有新安排",
            requestedAt: REQUESTED_AT,
          });
        }
        return estimate(request);
      },
    );
    const run = await runtime.startAssistantInitiated(
      {
        ...preparationRequest(fixture.chatId),
        content: "继续原行动",
      },
      {
        modelId: "gpt-6-astra",
        persona: defaultPersonaSnapshot(REQUESTED_AT),
        prepareCognitionContext: () => ({
          ...emptyCognition(),
          text: "required-action-proof-before-correction",
          decisionAttemptId: "10000000-0000-4000-8000-000000000082",
        }),
      },
    );
    try {
      await waitForStatus(fixture, run.id, "completed");
      await steering;
      expect(delivered).toBe(true);
      expect(prepareTurn).toHaveBeenCalledTimes(1);
      expect(fixture.provider.requests).toHaveLength(4);
      for (const request of [
        fixture.provider.requests[1]!,
        fixture.provider.requests[3]!,
      ]) {
        const input = JSON.stringify(request.input);
        expect(input).toContain("required-action-proof-before-correction");
        expect(input).toContain("state-after-current-correction");
        expect(input.match(/state-after-current-correction/g)).toHaveLength(1);
        expect(input).toContain("已有新安排");
      }
      expect(
        new ChatRepository(fixture.database).getContextSnapshot(fixture.chatId),
      ).toMatchObject({ generation: 1 });
    } finally {
      await runtime.interruptAll();
      fixture.database.close();
    }
  });
});

describe("ordinary Chat Activity images", () => {
  function lookupOutput(
    request: ModelRequest,
    callId: string,
  ): ActivityVisualLookupResult {
    const output = request.input.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value["type"] === "function_call_output" &&
        value["call_id"] === callId,
    ) as { output: string } | undefined;
    if (!output) throw new Error("Missing actual image lookup Tool result");
    return (
      JSON.parse(output.output) as { modelContent: ActivityVisualLookupResult }
    ).modelContent;
  }

  it.each([false, true])(
    "allocates a large visual directory against the whole request and preserves continuation (steering=%s)",
    async (steering) => {
      const observations: ActivityVisualMatch[] = Array.from(
        { length: 120 },
        (_, index) => {
          const id = `30000000-0000-4000-8000-${String(120 - index).padStart(12, "0")}`;
          return {
            actor: "unknown",
            position: { eventId: id, startedAt: REQUESTED_AT },
            reference: {
              eventId: id,
              artifactId: `40000000-0000-4000-8000-${String(120 - index).padStart(12, "0")}`,
              capturedAt: REQUESTED_AT,
              contentRevision: "fixture-image-revision",
              width: 1,
              height: 1,
              trigger: "frame",
              surface: {
                ...visualSurfaceFixture,
                windowTitle: `Document ${index}: ${"retained window title ".repeat(70)}`,
              },
            },
          };
        },
      );
      const gate = preparationGate();
      const prepare = vi.fn(() =>
        Promise.reject(new Error("Lookup does not read pixels")),
      );
      const images: ImageInputProvider = {
        prepare,
        activity: {
          lookup: (request) =>
            Promise.resolve({
              request: { ...request, periodEnd: REQUESTED_AT },
              observations,
              readBytes: observations.reduce(
                (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
                0,
              ),
              loaded: false,
              retainedOnly: true,
              complete: true,
              order: "newest_first",
            }),
          current: () => Promise.resolve(undefined),
          resolve: () =>
            Promise.resolve({
              status: "unavailable",
              reason: "source_missing",
            }),
        },
      };
      const fixture = await createFixture(
        [
          namespacedFunctionTurn("directory", "inspect", "image", {
            activity: { search: {} },
          }),
          finalTurn("已经定位保留下来的画面，余下范围可继续查找。"),
        ],
        new SystemClock(),
        undefined,
        images,
        { effectiveInputTokens: 128_000, supportsVision: true },
      );
      const originalMeasure = fixture.provider.measureInput.bind(
        fixture.provider,
      );
      const measured: ModelRequest[] = [];
      let delayed = false;
      vi.spyOn(fixture.provider, "measureInput").mockImplementation(
        async (request, signal) => {
          measured.push(structuredClone(request));
          if (
            !delayed &&
            request.input.some(
              (value) =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                value["type"] === "function_call_output" &&
                value["call_id"] === "directory",
            )
          ) {
            delayed = true;
            gate.enter();
            await gate.released;
          }
          return originalMeasure(request, signal);
        },
      );
      try {
        const run = await fixture.runtime.start({
          ...preparationRequest(fixture.chatId),
          content: "帮我找之前的画面。",
        });
        await gate.entered;
        if (steering)
          await fixture.runtime.steer({
            runId: run.id,
            content: `补充条件：${"请保留这一段用户提供的查找背景。".repeat(1000)}`,
            requestedAt: REQUESTED_AT,
          });
        gate.release();
        await waitForStatus(fixture, run.id, "completed");
        expect(fixture.provider.requests).toHaveLength(2);
        const actual = fixture.provider.requests[1]!;
        const result = lookupOutput(actual, "directory");
        expect(result).toMatchObject({
          complete: false,
          loaded: false,
          omittedReason: "context_budget",
        });
        expect(result.observations.length).toBeGreaterThan(0);
        expect(result.observations.length).toBeLessThan(observations.length);
        expect(result.observations).toEqual(
          observations.slice(0, result.observations.length),
        );
        expect(
          Buffer.byteLength(JSON.stringify(result.observations)),
        ).toBeGreaterThan(8192);
        expect(result.continuation).toEqual({
          periodEnd: REQUESTED_AT,
          before: result.observations.at(-1)!.position,
        });
        expect(
          fitsInputBudget(fixture.provider.estimateInput(actual), 128_000),
        ).toBe(true);
        expect(
          measured.some(
            (request) =>
              !fitsInputBudget(
                fixture.provider.estimateInput(request),
                128_000,
              ),
          ),
        ).toBe(true);
        expect(prepare).not.toHaveBeenCalled();
        if (steering)
          expect(JSON.stringify(actual.input)).toContain("补充条件");
      } finally {
        gate.release();
        await fixture.runtime.interruptAll();
        fixture.database.close();
      }
    },
  );

  it("keeps a repeatedly inspected image at the latest Tool boundary through compaction", async () => {
    const prepare = vi.fn<ImageInputProvider["prepare"]>(() =>
      Promise.resolve(preparedImage("c2FtZQ==")),
    );
    const fixture = await createFixture(
      [
        namespacedFunctionTurn("first-inspection", "inspect", "image", {
          path: "same.png",
        }),
        namespacedFunctionTurn("second-inspection", "inspect", "image", {
          path: "same.png",
        }),
        () => {
          throw new ProviderError(
            "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
            "context is full",
            true,
          );
        },
        finalTurn("根据再次读取的图片回答。"),
      ],
      new SystemClock(),
      undefined,
      { prepare },
    );
    try {
      const run = await fixture.runtime.start(
        preparationRequest(fixture.chatId),
      );
      await waitForStatus(fixture, run.id, "completed");
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(fixture.provider.requests).toHaveLength(4);
      const compacted = JSON.stringify(fixture.provider.requests[3]!.input);
      expect(compacted).toContain('"call_id":"second-inspection"');
      expect(compacted).not.toContain('"call_id":"first-inspection"');
      expect(compacted.match(/data:image\/png;base64,c2FtZQ==/g)).toHaveLength(
        1,
      );
    } finally {
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it.each(["record", "another image", "record then another image"] as const)(
    "preserves inspected pixels after %s and forced compaction",
    async (nextTool) => {
      const prepare = vi.fn<ImageInputProvider["prepare"]>((source) =>
        Promise.resolve(
          preparedImage(source === "first.png" ? "Zmlyc3Q=" : "c2Vjb25k"),
        ),
      );
      const fixture = await createFixture(
        [
          namespacedFunctionTurn("first-image", "inspect", "image", {
            path: "first.png",
          }),
          nextTool !== "another image"
            ? namespacedFunctionTurn("next-tool", "record", "memory", {})
            : namespacedFunctionTurn("next-tool", "inspect", "image", {
                path: "second.png",
              }),
          ...(nextTool === "record then another image"
            ? [
                namespacedFunctionTurn("last-image", "inspect", "image", {
                  path: "second.png",
                }),
              ]
            : []),
          () => {
            throw new ProviderError(
              "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
              "context is full",
              true,
            );
          },
          finalTurn("依据已经读取的图片完成回答。"),
        ],
        new SystemClock(),
        undefined,
        { prepare },
      );
      if (nextTool !== "another image")
        registerRunFormation(fixture, createMemoryFor(fixture).memory);
      try {
        const run = await fixture.runtime.start({
          ...preparationRequest(fixture.chatId),
          content: "请记住我喜欢的画布，再一起看看图片。",
        });
        await waitForStatus(fixture, run.id, "completed");
        expect(fixture.provider.requests).toHaveLength(
          nextTool === "record then another image" ? 5 : 4,
        );
        const compacted = fixture.provider.requests.at(-1)!.input;
        const serialized = JSON.stringify(compacted);
        expect(serialized).toContain('"call_id":"first-image"');
        expect(serialized).toContain('"call_id":"next-tool"');
        expect(
          serialized.match(/data:image\/png;base64,Zmlyc3Q=/g),
        ).toHaveLength(1);
        if (nextTool !== "record")
          expect(
            serialized.match(/data:image\/png;base64,c2Vjb25k/g),
          ).toHaveLength(1);
        const calls = compacted.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            item["type"] === "function_call",
        );
        expect(calls).toMatchObject(
          [
            "first-image",
            "next-tool",
            ...(nextTool === "record then another image" ? ["last-image"] : []),
          ].map((call_id) => ({ call_id })),
        );
        const tools = fixture.runs
          .listRunItems(run.id)
          .filter(({ kind }) => kind === "tool_call");
        expect(tools).toHaveLength(
          nextTool === "record then another image" ? 3 : 2,
        );
        expect(tools.every(({ status }) => status === "completed")).toBe(true);
      } finally {
        await fixture.runtime.interruptAll();
        fixture.database.close();
      }
    },
  );

  it.each(["retained", "current"] as const)(
    "supplies the exact unaggregated Activity PNG to ordinary Chat from %s",
    async (mode) => {
      const clock = new SystemClock();
      const images: ImageInputProvider = {
        activity: {
          lookup: (request, budget, signal) =>
            activity.lookupVisualEvidence(request, budget, signal),
          current: async (signal) => {
            const observed = await activity.consumeLatestVisualEvidence(signal);
            return observed
              ? {
                  actor: observed.event.actor,
                  reference: observed.reference,
                  position: {
                    startedAt: observed.event.startedAt,
                    eventId: observed.event.id,
                  },
                }
              : undefined;
          },
          resolve: (reference, signal) =>
            activity.resolveVisualEvidence(reference, signal),
        },
        prepare: async (source, signal) => {
          if (typeof source === "string")
            throw new Error("The model has not been given an image path");
          const resolved = await activity.resolveVisualEvidence(
            source.activity,
            signal,
          );
          if (resolved.status !== "available") throw new Error(resolved.reason);
          return {
            ...preparedImage(resolved.bytes.toString("base64")),
            observation: {
              reference: resolved.reference,
              actor: resolved.actor,
              position: {
                startedAt: resolved.startedAt,
                eventId: resolved.reference.eventId,
              },
            },
          };
        },
      };
      const fixture = await createFixture(
        mode === "retained"
          ? [
              namespacedFunctionTurn("locate-visual", "inspect", "image", {
                activity: { search: { query: "Fixture" } },
              }),
              (request, signal) => {
                const lookup = lookupOutput(request, "locate-visual");
                expect(lookup.loaded).toBe(false);
                expect(lookup.observations).toHaveLength(1);
                return namespacedFunctionTurn(
                  "read-visual",
                  "inspect",
                  "image",
                  {
                    activity: { reference: lookup.observations[0]!.reference },
                  },
                )(request, signal);
              },
              finalTurn("已根据本次实际像素回答。"),
            ]
          : [
              namespacedFunctionTurn("current-visual", "inspect", "image", {
                activity: { current: true },
              }),
              finalTurn("已根据当前采集画面的实际像素回答。"),
            ],
        clock,
        undefined,
        images,
      );
      const repository = new ActivityRepository(fixture.database);
      repository.initialize(clock.now());
      const memoryRepository = new MemoryRepository(fixture.database);
      const ids = new CryptoIdGenerator();
      const activity = new ActivityService(
        repository,
        new MemoryService(memoryRepository, { search: () => [] }, ids, clock),
        new ActivityAssetStore(
          path.join(path.dirname(fixture.database.name), "activity-assets"),
        ),
        ids,
        clock,
      );
      try {
        const eventId = activity.recordEvent(
          {
            source: "active_app",
            appName: "Synthetic fixture",
            surface: visualSurfaceFixture,
          },
          "user",
        )!;
        activity.setVisualContext({
          eventId,
          actor: "user",
          surface: visualSurfaceFixture,
        });
        const frame = await visualFrameFixture();
        const captured =
          mode === "retained"
            ? await activity.recordVisualFrame(frame, "foreground")
            : undefined;
        if (mode === "current")
          expect(activity.stageVisualFrame(frame)).toBe(true);
        else expect(captured).toBeDefined();
        expect(
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS n FROM activity_events WHERE source='screenshot'",
            )
            .get(),
        ).toEqual({ n: mode === "retained" ? 1 : 0 });
        expect(
          fixture.database
            .prepare("SELECT COUNT(*) AS n FROM activity_episodes")
            .get(),
        ).toEqual({ n: 0 });
        expect(
          fixture.database
            .prepare("SELECT COUNT(*) AS n FROM cognition_evidence")
            .get(),
        ).toEqual({ n: 0 });
        const run = await fixture.runtime.start({
          ...preparationRequest(fixture.chatId),
          content:
            mode === "retained"
              ? "刚才 Fixture 窗口的画面是什么？"
              : "现在 Fixture 窗口的画面是什么？",
        });
        await waitForStatus(fixture, run.id, "completed");
        const retained = await activity.lookupVisualEvidence(
          {},
          { maxReadBytes: 1024 * 1024 },
        );
        expect(retained.observations).toHaveLength(1);
        const reference = retained.observations[0]!.reference;
        expect(
          JSON.stringify(fixture.provider.requests[0]!.input),
        ).not.toContain(reference.eventId);
        if (mode === "retained") {
          const lookup = lookupOutput(
            fixture.provider.requests[1]!,
            "locate-visual",
          );
          expect(lookup.observations[0]!.reference).toEqual(
            captured!.reference,
          );
        }
        const supplied = JSON.stringify(
          fixture.provider.requests.at(-1)!.input,
        );
        expect(supplied).toContain(
          `data:image/png;base64,${frame.bytes.toString("base64")}`,
        );
        expect(supplied).toContain(reference.capturedAt);
        expect(supplied).toContain('\\"actor\\":\\"user\\"');
        expect(supplied).not.toContain("charamate_image_reference");
      } finally {
        await fixture.runtime.interruptAll();
        await activity.stopVisualCapture();
        fixture.database.close();
      }
    },
  );

  it.each(["stop", "shutdown"] as const)(
    "joins an image read during %s without a late completed Item",
    async (control) => {
      const gate = preparationGate();
      let signalSeen: AbortSignal | undefined;
      const fixture = await createFixture(
        [
          namespacedFunctionTurn("slow-image", "inspect", "image", {
            path: "current.png",
          }),
        ],
        new SystemClock(),
        undefined,
        {
          prepare: async (_source, signal) => {
            signalSeen = signal;
            gate.enter();
            await gate.released;
            return preparedImage("cmVhbC1yZWFk");
          },
        },
      );
      let stopping: Promise<unknown> | undefined;
      try {
        const run = await fixture.runtime.start(
          preparationRequest(fixture.chatId),
        );
        await gate.entered;
        expect(fixture.checkpoints.get(run.id)?.phase).toBe("tool");
        let joined = false;
        stopping = (
          control === "stop"
            ? fixture.runtime.cancel({
                runId: run.id,
                requestedAt: REQUESTED_AT,
              })
            : fixture.runtime.interruptAll()
        ).then(() => {
          joined = true;
        });
        await preparationTurn();
        expect(joined).toBe(false);
        expect(signalSeen?.aborted).toBe(true);
        gate.release();
        await stopping;
        await waitForStatus(
          fixture,
          run.id,
          control === "stop" ? "cancelled" : "interrupted",
        );
        expect(fixture.provider.requests).toHaveLength(1);
        const tool = fixture.runs
          .listRunItems(run.id)
          .find((item) => item.kind === "tool_call");
        expect(tool?.status).toBe(
          control === "stop" ? "cancelled" : "interrupted",
        );
        expect(tool?.output).toBeUndefined();
      } finally {
        gate.release();
        await stopping;
        await fixture.runtime.interruptAll();
        fixture.database.close();
      }
    },
  );

  it("restores a completed image Tool after database reopen without repeating inspection", async () => {
    const source = "/workspace/preserved.png";
    const prepare = vi.fn<ImageInputProvider["prepare"]>(() =>
      Promise.resolve(preparedImage("cHJlc2VydmVk")),
    );
    const fixture = await createFixture(
      [
        namespacedFunctionTurn("saved-image", "inspect", "image", {
          path: source,
        }),
      ],
      new SystemClock(),
      undefined,
      { prepare },
    );
    const publish = fixture.collector.publish;
    let stopping: Promise<void> | undefined;
    vi.spyOn(fixture.collector, "publish").mockImplementation((event) => {
      publish(event);
      if (
        event.event.type === "item.completed" &&
        event.event.item.kind === "tool_call"
      )
        stopping = fixture.runtime.interruptAll();
    });
    const run = await fixture.runtime.start(preparationRequest(fixture.chatId));
    await waitForStatus(fixture, run.id, "interrupted");
    await stopping;
    expect(prepare).toHaveBeenCalledOnce();
    expect(fixture.checkpoints.get(run.id)?.context).toMatchObject({
      pendingTool: { callId: "saved-image" },
    });
    const filename = fixture.database.name;
    fixture.database.close();
    const database = openApplicationDatabase(filename);
    const resumed = {
      ...fixture,
      database,
      collector: new EventCollector(),
      runs: new RunRepository(database),
      checkpoints: new CheckpointRepository(database),
    };
    const provider = new ScriptedProvider([finalTurn("根据恢复的图片继续。")]);
    const runtime = createRuntimeFor(
      resumed,
      provider,
      undefined,
      undefined,
      undefined,
      { prepare },
    );
    try {
      await runtime.resume({ runId: run.id, requestedAt: REQUESTED_AT });
      await waitForStatus(resumed, run.id, "completed");
      expect(prepare).toHaveBeenCalledTimes(2); // A fresh Runtime must materialize the saved reference once.
      expect(
        resumed.runs
          .listRunItems(run.id)
          .filter((item) => item.kind === "tool_call"),
      ).toHaveLength(1);
      expect(JSON.stringify(provider.requests[0]!.input)).toContain(
        "data:image/png;base64,cHJlc2VydmVk",
      );
      expect(JSON.stringify(provider.requests[0]!.input)).toContain(
        '"call_id":"saved-image"',
      );
    } finally {
      await runtime.interruptAll();
      database.close();
    }
  });
});

describe("same Run environment continuation", () => {
  const attemptId = "00000000-0000-4000-8000-000000000011";
  const evidenceIds = [
    "00000000-0000-4000-8000-000000000012",
    "00000000-0000-4000-8000-000000000013",
  ];
  const contextText = "新环境事实：表格中的两项金额是 660 和 40。";
  const questions = [
    {
      id: "table",
      header: "表格",
      question: "可以提供当前表格吗？",
      options: [
        { label: "稍后提供", description: "等当前表格准备好。" },
        { label: "取消", description: "暂不继续。" },
      ],
    },
  ];
  const question = () =>
    namespacedFunctionTurn(
      "environment-question",
      "request_user_input",
      "interaction",
      { questions },
    );
  const continuation = (
    runId: string,
    itemId: string,
    signal = new AbortController().signal,
  ) => ({
    runId,
    itemId,
    attemptId,
    requestedAt: REQUESTED_AT,
    signal,
    prepareContext: vi.fn((): CognitionPreparedContext => ({
      text: contextText,
      evidenceIds,
      situationIds: [],
      intentIds: [],
      decisionAttemptId: attemptId,
    })),
    assertCurrent: vi.fn(() => undefined),
    onAccepted:
      vi.fn<
        Parameters<
          AgentRuntime["continueWithCognitionContext"]
        >[0]["onAccepted"]
      >(),
  });
  const pendingItem = (fixture: RuntimeFixture, runId: string) =>
    fixture.runs
      .listRunItems(runId)
      .find(({ kind }) => kind === "input_request")!;
  const outputFor = (request: ModelRequest, callId: string) =>
    request.input.filter(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value["type"] === "function_call_output" &&
        value["call_id"] === callId,
    );

  it("atomically accepts real context, keeps the original Provider and Tool receipts, and invalidates unexecuted old calls", async () => {
    const beforeInteraction = vi.fn(() => Promise.resolve());
    const fixture = await createFixture(
      [
        searchTurn("discover", "read"),
        namespacedFunctionTurn("already-done", "read", "test", {
          value: "原真实结果",
        }),
        async (request, signal) => [
          ...(await question()(request, signal)),
          {
            type: "output.item",
            item: {
              type: "function_call",
              call_id: "obsolete-call",
              name: "read",
              namespace: "test",
              arguments: JSON.stringify({ value: "不该再执行" }),
            },
          },
        ],
        finalTurn("收到环境材料，继续原任务。"),
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      beforeInteraction,
    );
    let toolCalls = 0;
    registerTool(fixture, {
      name: "test.read",
      namespace: "test",
      execute: () => {
        toolCalls += 1;
        return Promise.resolve(successfulResult("原真实结果"));
      },
    });
    const ordinary = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
      Promise.resolve({
        ...emptyCognition(),
        text: "当前普通情境",
      }),
    );
    const runtime = createRuntimeFor(
      fixture,
      fixture.provider,
      { prepareTurn: ordinary },
      undefined,
      beforeInteraction,
    );
    const run = await startAgent({ ...fixture, runtime });
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      const item = pendingItem(fixture, run.id);
      const before = decodeRuntimeCheckpoint(
        fixture.checkpoints.get(run.id)!.context,
      );
      const userMessages = fixture.database
        .prepare("SELECT * FROM messages WHERE role = 'user'")
        .all();
      const intakeCalls = beforeInteraction.mock.calls.length;
      const pfc = new AbortController();
      const request = continuation(run.id, item.id, pfc.signal);
      let acceptedAt = "";
      request.onAccepted.mockImplementation((receipt) => {
        acceptedAt = receipt.resolvedAt;
        expect(acceptedAt).not.toBe(REQUESTED_AT);
        expect(fixture.database.inTransaction).toBe(true);
        const checkpoint = fixture.checkpoints.get(run.id)!;
        expect(checkpoint.phase).toBe("input");
        expect(JSON.stringify(checkpoint.context)).toContain(contextText);
        expect(fixture.runs.getRun(run.id)?.status).toBe("needs_input");
      });
      const publish = fixture.collector.publish.bind(fixture.collector);
      vi.spyOn(fixture.collector, "publish").mockImplementation((event) => {
        if (event.event.type === "input.resolved") {
          expect(fixture.database.inTransaction).toBe(false);
          expect(fixture.runs.getRun(run.id)?.status).toBe("running");
          const checkpoint = decodeRuntimeCheckpoint(
            fixture.checkpoints.get(run.id)!.context,
          );
          expect(checkpoint.latestUserInput).toEqual(before.latestUserInput);
          expect(checkpoint.recentUsers).toEqual(before.recentUsers);
          expect(checkpoint.pendingInput?.itemId).toBe(item.id);
          expect(event.occurredAt).toBe(acceptedAt);
          expect(event.event.item.endedAt).toBe(acceptedAt);
          expect(fixture.checkpoints.get(run.id)?.updatedAt).toBe(acceptedAt);
          pfc.abort(new DOMException("PFC has finished", "AbortError"));
        }
        publish(event);
      });
      const measured: ModelRequest[] = [];
      const measure = fixture.provider.measureInput.bind(fixture.provider);
      vi.spyOn(fixture.provider, "measureInput").mockImplementation(
        (input, signal) => {
          measured.push(input);
          return measure(input, signal);
        },
      );
      await expect(
        runtime.continueWithCognitionContext(request),
      ).resolves.toEqual({ runId: run.id });
      await waitForStatus(fixture, run.id, "completed");
      expect(toolCalls).toBe(1);
      expect(request.onAccepted).toHaveBeenCalledExactlyOnceWith({
        resolvedAt: acceptedAt,
        evidenceIds,
      });
      expect(beforeInteraction).toHaveBeenCalledTimes(intakeCalls);
      expect(
        fixture.database
          .prepare("SELECT * FROM messages WHERE role = 'user'")
          .all(),
      ).toEqual(userMessages);
      expect(
        fixture.database.prepare("SELECT COUNT(*) AS count FROM runs").get(),
      ).toEqual({ count: 1 });
      const finalRequest = fixture.provider.requests.at(-1)!;
      expect(outputFor(finalRequest, "already-done")).toHaveLength(1);
      expect(outputFor(finalRequest, "environment-question")).toEqual([
        {
          type: "function_call_output",
          call_id: "environment-question",
          output: JSON.stringify({
            status: "context_available",
            attemptId,
            evidenceIds,
          }),
        },
      ]);
      expect(
        JSON.stringify(outputFor(finalRequest, "obsolete-call")),
      ).toContain("TOOL.INPUT_CHANGED");
      expect(JSON.stringify(finalRequest.input)).toContain(contextText);
      expect(JSON.stringify(finalRequest.input)).toContain("当前普通情境");
      const admission = measured.find((input) =>
        JSON.stringify(input.input).includes(contextText),
      );
      expect(admission?.modelId).toBe(run.provider.modelId);
      expect(admission?.instructions.length).toBeGreaterThan(0);
      expect(
        admission?.toolNamespaces.some(({ name }) => name === "interaction"),
      ).toBe(true);
      expect(outputFor(admission!, "already-done")).toHaveLength(1);
      expect(outputFor(admission!, "environment-question")).toHaveLength(1);
      expect(fixture.runs.getRunItem(item.id)?.output).toMatchObject({
        status: "context_available",
        attemptId,
      });
      await expect(
        runtime.continueWithCognitionContext(request),
      ).resolves.toEqual({ runId: run.id });
      expect(request.onAccepted).toHaveBeenCalledTimes(1);
      expect(
        fixture.collector.events.filter(
          ({ event }) => event.type === "input.resolved",
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("rolls back the checkpoint and resolved event together when acceptance fails", async () => {
    const fixture = await createFixture([question()]);
    const run = await startAgent(fixture);
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      const item = pendingItem(fixture, run.id);
      const checkpoint = fixture.checkpoints.get(run.id);
      const request = continuation(run.id, item.id);
      request.onAccepted.mockImplementation(() => {
        throw new Error("intake rejected");
      });
      await expect(
        fixture.runtime.continueWithCognitionContext(request),
      ).rejects.toThrow("intake rejected");
      expect(fixture.checkpoints.get(run.id)).toEqual(checkpoint);
      expect(fixture.runs.getRunItem(item.id)).toEqual(item);
      expect(fixture.runs.getRun(run.id)?.status).toBe("needs_input");
      expect(
        fixture.collector.events.some(
          ({ event }) => event.type === "input.resolved",
        ),
      ).toBe(false);
      expect(fixture.provider.requests).toHaveLength(1);
    } finally {
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("keeps a committed intake and wakes the same Run while reporting a publication failure", async () => {
    const fixture = await createFixture([question(), finalTurn("仍然继续")]);
    const run = await startAgent(fixture);
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      const item = pendingItem(fixture, run.id);
      const request = continuation(run.id, item.id);
      const publish = fixture.collector.publish.bind(fixture.collector);
      vi.spyOn(fixture.collector, "publish").mockImplementation((event) => {
        publish(event);
        if (event.event.type === "input.resolved")
          throw new Error("resolved publisher failed");
      });
      await expect(
        fixture.runtime.continueWithCognitionContext(request),
      ).rejects.toThrow("resolved publisher failed");
      await waitForStatus(fixture, run.id, "completed");
      expect(request.onAccepted).toHaveBeenCalledTimes(1);
      await expect(
        fixture.runtime.continueWithCognitionContext(request),
      ).resolves.toEqual({ runId: run.id });
      expect(fixture.provider.requests).toHaveLength(2);
    } finally {
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it.each(["abort", "stale"] as const)(
    "rejects %s preparation after the held full-request measurement without accepting",
    async (kind) => {
      const fixture = await createFixture([question()]);
      const run = await startAgent(fixture);
      const gate = preparationGate();
      try {
        await waitForStatus(fixture, run.id, "needs_input");
        const item = pendingItem(fixture, run.id);
        const checkpoint = fixture.checkpoints.get(run.id);
        const controller = new AbortController();
        const request = continuation(run.id, item.id, controller.signal);
        let current = true;
        request.assertCurrent.mockImplementation(() => {
          if (!current) throw new Error("selected input changed");
        });
        vi.spyOn(fixture.provider, "measureInput").mockImplementation(
          async (input) => {
            gate.enter();
            await gate.released;
            return estimateInputBudget(input);
          },
        );
        const outcome = preparationOutcome(
          fixture.runtime.continueWithCognitionContext(request),
        );
        await gate.entered;
        if (kind === "abort")
          controller.abort(new DOMException("PFC interrupted", "AbortError"));
        else current = false;
        gate.release();
        const result = await outcome;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(Error);
        expect(request.onAccepted).not.toHaveBeenCalled();
        expect(fixture.checkpoints.get(run.id)).toEqual(checkpoint);
        expect(fixture.runs.getRunItem(item.id)).toEqual(item);
        expect(fixture.runs.getRun(run.id)?.status).toBe("needs_input");
      } finally {
        gate.release();
        await fixture.runtime.interruptAll();
        fixture.database.close();
      }
    },
  );

  it("rejects an over-capacity complete request and an already user-resolved question", async () => {
    const fixture = await createFixture([question(), finalTurn()]);
    const run = await startAgent(fixture);
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      const item = pendingItem(fixture, run.id);
      const request = continuation(run.id, item.id);
      const estimate = vi
        .spyOn(fixture.provider, "measureInput")
        .mockImplementation(() =>
          Promise.resolve({
            ...estimateInputBudget({
              modelId: "fixture",
              input: [],
              instructions: "",
              toolNamespaces: [],
            }),
            exactInputTokens: 300_000,
          }),
        );
      await expect(
        fixture.runtime.continueWithCognitionContext(request),
      ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
      expect(request.onAccepted).not.toHaveBeenCalled();
      expect(fixture.runs.getRun(run.id)?.status).toBe("needs_input");
      estimate.mockRestore();
      await fixture.runtime.resolveUserInput({
        runId: run.id,
        itemId: item.id,
        resolution: {
          status: "cancelled",
          resolvedAt: REQUESTED_AT,
        },
      });
      await waitForStatus(fixture, run.id, "completed");
      await expect(
        fixture.runtime.continueWithCognitionContext(request),
      ).rejects.toMatchObject({ code: "AGENT.INPUT_NOT_PENDING" });
      expect(fixture.runs.getRunItem(item.id)?.output).toMatchObject({
        status: "cancelled",
      });
    } finally {
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("restores the original Run and reopens an atomically accepted input checkpoint without replaying the old question", async () => {
    const { fixture, runId, itemId } =
      await preparationRestoredFixture("input");
    const provider = new ScriptedProvider([finalTurn("续接完成")]);
    const runtime = createRuntimeFor(fixture, provider);
    const request = continuation(runId, itemId!);
    const snapshot = path.join(
      path.dirname(fixture.database.name),
      "accepted.sqlite",
    );
    const publish = fixture.collector.publish.bind(fixture.collector);
    vi.spyOn(fixture.collector, "publish").mockImplementation((event) => {
      if (event.event.type === "input.resolved") {
        expect(fixture.checkpoints.get(runId)?.phase).toBe("input");
        fixture.database.exec(
          `VACUUM INTO '${snapshot.replaceAll("'", "''")}'`,
        );
      }
      publish(event);
    });
    try {
      await runtime.continueWithCognitionContext(request);
      await waitForStatus(fixture, runId, "completed");
      expect(provider.requests).toHaveLength(1);
    } finally {
      await runtime.interruptAll();
      fixture.database.close();
    }
    const database = openApplicationDatabase(snapshot);
    const runs = new RunRepository(database);
    const checkpoints = new CheckpointRepository(database);
    const collector = new EventCollector();
    const reopened = { ...fixture, database, runs, checkpoints, collector };
    const resumedProvider = new ScriptedProvider([
      finalTurn("重开已接纳的材料"),
    ]);
    const resumed = createRuntimeFor(reopened, resumedProvider);
    try {
      expect(runs.getRun(runId)?.status).toBe("running");
      expect(checkpoints.get(runId)?.phase).toBe("input");
      await resumed.initialize();
      await waitForStatus(reopened, runId, "completed");
      expect(resumedProvider.requests).toHaveLength(1);
      expect(JSON.stringify(resumedProvider.requests[0]?.input)).toContain(
        contextText,
      );
      expect(outputFor(resumedProvider.requests[0]!, "question")).toHaveLength(
        1,
      );
      expect(
        runs.listRunItems(runId).filter(({ kind }) => kind === "input_request"),
      ).toHaveLength(1);
      expect(
        collector.events.some(({ event }) => event.type === "input.resolved"),
      ).toBe(false);
      expect(runs.getRunItem(itemId!)?.output).toMatchObject({
        status: "context_available",
      });
    } finally {
      await resumed.interruptAll();
      database.close();
    }
  });

  it("joins Stop issued by the post-commit publisher before the input waiter resumes", async () => {
    const fixture = await createFixture([question()]);
    const run = await startAgent(fixture);
    let cancellation: Promise<unknown> | undefined;
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      const item = pendingItem(fixture, run.id);
      const publish = fixture.collector.publish.bind(fixture.collector);
      vi.spyOn(fixture.collector, "publish").mockImplementation((event) => {
        publish(event);
        if (event.event.type === "input.resolved") {
          cancellation = fixture.runtime.cancel({
            runId: run.id,
            requestedAt: REQUESTED_AT,
          });
        }
      });
      await fixture.runtime.continueWithCognitionContext(
        continuation(run.id, item.id),
      );
      expect(cancellation).toBeDefined();
      await cancellation;
      expect(fixture.runs.getRun(run.id)?.status).toBe("cancelled");
      expect(fixture.provider.requests).toHaveLength(1);
      expect(fixture.runs.getRunItem(item.id)?.output).toMatchObject({
        status: "context_available",
      });
    } finally {
      await cancellation;
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });

  it("joins a real Stop after acceptance without assigning the Run to the PFC signal", async () => {
    const entered = preparationGate();
    const fixture = await createFixture([
      question(),
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          entered.enter();
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("Stopped", "AbortError"),
              ),
            {
              once: true,
            },
          );
          if (signal.aborted)
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Stopped", "AbortError"),
            );
        }),
    ]);
    const run = await startAgent(fixture);
    try {
      await waitForStatus(fixture, run.id, "needs_input");
      const item = pendingItem(fixture, run.id);
      await fixture.runtime.continueWithCognitionContext(
        continuation(run.id, item.id),
      );
      await entered.entered;
      await fixture.runtime.cancel({
        runId: run.id,
        requestedAt: REQUESTED_AT,
      });
      expect(fixture.runs.getRun(run.id)?.status).toBe("cancelled");
      expect(fixture.runs.getRunItem(item.id)?.output).toMatchObject({
        status: "context_available",
      });
    } finally {
      await fixture.runtime.interruptAll();
      fixture.database.close();
    }
  });
});
