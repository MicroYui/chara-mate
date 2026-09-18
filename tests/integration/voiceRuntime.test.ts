import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import { realtimeSessionRequest } from "../../src/main/voice/azureWebRtcSession";
// @vitest-environment jsdom
import {
  installVoiceBrowserFixture,
  FakePeerConnection,
} from "../fixtures/webrtcVoiceBrowser";
import { WebRtcVoiceDriver } from "../../src/renderer/features/voice/WebRtcVoiceDriver";
import type { VoiceApi } from "../../src/shared/contracts/voice";
import type { ModelRequest } from "../../src/main/agent/modelProvider";
import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import * as inputBudget from "../../src/main/providers/inputBudget";
import { runMemoryIntake } from "../../src/main/app/runMemoryIntake";
import type { MemoryFormationIntake } from "../../src/shared/contracts/memoryRecall";
import type { CognitionPreparedContext } from "../../src/shared/contracts/cognition";
import type { CognitionServiceContract } from "../../src/main/cognition/cognitionTypes";
import { searchMemoryVectors } from "../../src/main/memory/memoryVectorSearch";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import {
  isUtcTimestamp,
  UTC_TIMESTAMP_FORMAT,
} from "../../src/shared/schemas/primitives";

import type { ChatTitleGenerator } from "../../src/main/chat/chatTitleService";
import type { ModelEvent } from "../../src/main/agent/modelProvider";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import type { SettingsRepository } from "../../src/main/app/settingsRepository";
import type { VoiceSettingsConfig } from "../../src/shared/contracts/settings";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { registerBrowserTools } from "../../src/main/browser/managedBrowser";
import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import {
  registerMemoryFormationTool,
  registerMemoryTool,
} from "../../src/main/memory/memoryTool";
import type { ProviderService } from "../../src/main/providers/providerService";
import { registerLocalTools } from "../../src/main/tools/localTools";
import {
  ToolRegistry,
  toolEvidenceHash,
  type ToolExecutionContext,
  type ToolResultContextMeasurement,
} from "../../src/main/tools/toolRegistry";
import type { RealtimeSessionIssuer } from "../../src/main/voice/azureWebRtcSession";
import { VoiceRepository } from "../../src/main/voice/voiceRepository";
import { VoiceService } from "../../src/main/voice/voiceService";
import { defaultPersonaSnapshot } from "../../src/main/persona/personaPresets";
import { registerVoiceTools } from "../../src/main/voice/voiceTool";
import type { PersonaSnapshot } from "../../src/shared/contracts/persona";
import type { ToolResult } from "../../src/shared/contracts/tool";
import {
  voiceToolResultEvents,
  voiceResponseCreateEvent,
  voicePreviewEvents,
  voiceWakeGreetingEvent,
} from "../../src/shared/contracts/voice";
import type {
  VoiceClientCommand,
  VoiceDriverEvent,
  VoiceSessionSnapshot,
} from "../../src/shared/contracts/voice";
import type { IdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const NOW = "2026-08-09T12:00:00.000Z";
const CHAT_ID = "10000000-0000-4000-8000-000000000001";
const PROFILE_ID = "10000000-0000-4000-8000-000000000002";

class SequenceIds implements IdGenerator {
  #next = 10;

  generate() {
    const value = `10000000-0000-4000-8000-${String(this.#next).padStart(12, "0")}`;
    this.#next += 1;
    return value;
  }
}

const temporaryDirectories: string[] = [];
const testPreparation = new WeakMap<
  VoiceService,
  {
    count: () => number;
    waitForCommand: (
      predicate: (command: VoiceClientCommand) => boolean,
      after: number,
    ) => Promise<void>;
    commands: VoiceClientCommand[];
  }
>();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(options?: {
  realtimeModelId?: string;
  supportsSessionRefresh?: boolean;
  title?: ChatTitleGenerator;
  onSnapshot?: (snapshot: VoiceSessionSnapshot | null) => void;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chara-mate-voice-"));
  temporaryDirectories.push(directory);
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const chats = new ChatRepository(database);
  chats.insertChat({
    createdAt: NOW,
    id: CHAT_ID,
    status: "active",
    title: "Voice",
    updatedAt: NOW,
  });
  const ids = new SequenceIds();
  const clock = new FakeClock(NOW);
  const runs = new RunRepository(database);
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, { publish: vi.fn() }),
    ids,
    clock,
  );
  const chatTurns = new ChatService(chats, runs, ids, clock);
  const repository = new VoiceRepository(database);
  const commands: VoiceClientCommand[] = [];
  const commandListeners = new Set<(command: VoiceClientCommand) => void>();
  const waitForCommand = (
    predicate: (command: VoiceClientCommand) => boolean,
    after = 0,
  ): Promise<void> => {
    if (commands.slice(after).some(predicate)) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = (command: VoiceClientCommand) => {
        if (!predicate(command)) return;
        commandListeners.delete(listener);
        resolve();
      };
      commandListeners.add(listener);
    });
  };
  const snapshots: Array<VoiceSessionSnapshot | null> = [];
  const tools = new ToolRegistry();
  const memoryRepository = new MemoryRepository(database);
  const memory = new MemoryService(
    memoryRepository,
    new LexicalRetrievalPipeline(database, memoryRepository, clock),
    ids,
    clock,
    {
      embedding: {
        modelKey: "voice-numeric-fixture",
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
              memoryRepository.recall.vectors(plan, modelKey, now),
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
      formation: formationRuntime({
        version: "voice-fixture-v1",
        form: () => Promise.resolve({ entities: [], units: [] }),
      }),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 8000 }),
    },
  );
  registerMemoryTool(tools, memory, () => ({}));
  let preparedContext: CognitionPreparedContext = {
    text: "",
    situationIds: [],
    intentIds: [],
    evidenceIds: [],
  };
  const prepareTurn = vi.fn<CognitionServiceContract["prepareTurn"]>(() =>
    Promise.resolve(preparedContext),
  );
  registerLocalTools(tools, undefined as never);
  registerBrowserTools(tools, undefined as never, undefined as never);
  const read = vi.fn().mockResolvedValue({
    artifacts: [],
    modelContent: { forecast: "晴" },
    retryable: false,
    status: "success",
    summary: "天气为晴",
  });
  tools.register({
    descriptor: {
      description: "查询指定城市天气。",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { city: { type: "string" } },
        required: ["city"],
        type: "object",
      },
      itemKind: "tool_call",
      name: "weather.lookup",
      namespace: "weather",
      source: "builtin",
      summary: "查询天气",
    },
    execute: read,
    summarize: (input) =>
      `查询${typeof input["city"] === "string" ? input["city"] : ""}天气`,
  });
  const write = vi.fn().mockResolvedValue({
    artifacts: [],
    modelContent: { saved: true },
    retryable: false,
    status: "success",
    summary: "已经保存",
  });
  tools.register({
    descriptor: {
      description: "保存一条便签。",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object",
      },
      itemKind: "tool_call",
      name: "note.save",
      namespace: "note",
      source: "builtin",
      summary: "保存便签",
    },
    execute: write,
    summarize: (input) =>
      `保存便签：${typeof input["text"] === "string" ? input["text"] : ""}`,
  });
  const voiceSettings: VoiceSettingsConfig = {
    inputMode: "hands_free",
    providerProfileId: PROFILE_ID,
  };
  let persona = defaultPersonaSnapshot(NOW);
  const settings = {
    getVoice: () => voiceSettings,
  } as unknown as SettingsRepository;
  const chatProvider = {
    measureInput(request: ModelRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      return Promise.resolve(this.estimateInput(request));
    },
    estimateInput: (request: ModelRequest) =>
      estimateInputBudget(request, request.modelId),
    resolveContextLimits: vi.fn().mockResolvedValue({}),
    stream: vi.fn(),
    supportsNativeWebSearch: true,
  };
  const chatRuntime = {
    provider: chatProvider,
    snapshot: {
      apiStyle: "openai-compatible" as const,
      modelId: "gpt-5.6",
      profileId: PROFILE_ID,
      profileName: "Chat",
    },
  };
  const createChatModelRuntime = vi.fn().mockResolvedValue(chatRuntime);
  const providers = {
    createChatModelRuntime,
    createRealtimeProviderRuntime: vi.fn().mockResolvedValue({
      apiKey: "test-key",
      profile: {
        apiStyle: "azure-openai",
        baseUrl: "https://unit.openai.azure.com/openai/v1",
        id: PROFILE_ID,
        name: "Azure Voice",
        realtimeEndpoint: "https://unit.openai.azure.com/openai/v1/realtime",
        realtimeModel: options?.realtimeModelId ?? "gpt-realtime-2.1",
      },
      snapshot: {
        apiStyle: "azure-openai",
        modelId: options?.realtimeModelId ?? "gpt-realtime-2.1",
        profileId: PROFILE_ID,
        profileName: "Azure Voice",
      },
    }),
    getDefaultChatProfileId: vi.fn().mockReturnValue(PROFILE_ID),
  } as unknown as ProviderService;
  const issue = vi.fn<RealtimeSessionIssuer["issue"]>().mockResolvedValue({
    callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
    clientSecret: "ephemeral",
    expiresAt: "2026-08-09T12:01:00.000Z",
  });
  const service = new VoiceService(
    repository,
    settings,
    providers,
    { issue, supportsSessionRefresh: options?.supportsSessionRefresh ?? true },
    tools,
    runs,
    writer,
    chatTurns,
    chats,
    ids,
    clock,
    {
      command: (command) => {
        commands.push(command);
        for (const listener of commandListeners) listener(command);
      },
      snapshot: (snapshot) => {
        snapshots.push(snapshot);
        options?.onSnapshot?.(snapshot);
      },
    },
    { getActiveSnapshot: () => persona },
    () => "Workspace skill instructions.",
    options?.title,
    { prepareTurn },
    undefined,
    undefined,
    undefined,
    undefined,
  );
  testPreparation.set(service, {
    count: () => prepareTurn.mock.calls.length,
    waitForCommand,
    commands,
  });
  registerVoiceTools(tools, {
    requestEndAfterResponse: (runId) => service.requestEndAfterResponse(runId),
  });
  return {
    waitForCommand,
    providers,
    chatProvider,
    chatRuntime,
    chatTurns,
    chats,
    clock,
    commands,
    createChatModelRuntime,
    database,
    directory,
    issue,
    memory,
    memoryRepository,
    prepareTurn,
    setPreparedContext: (context: CognitionPreparedContext) => {
      preparedContext = context;
    },
    read,
    repository,
    runs,
    service,
    setPersona: (value: Partial<PersonaSnapshot>) => {
      persona = {
        ...persona,
        ...value,
        revision: persona.revision + 1,
        revisionCreatedAt: NOW,
      };
    },
    snapshots,
    tools,
    writer,
    write,
  };
}

async function report(
  service: VoiceService,
  sessionId: string,
  event: VoiceDriverEvent,
) {
  const fixture = testPreparation.get(service);
  const before = fixture?.count() ?? 0;
  const offset = fixture?.commands.length ?? 0;
  const result = await service.report({ event, occurredAt: NOW, sessionId });
  // Existing answer tests wait for the real response.create publication. Tests
  // of an in-flight preparation call report directly and hold their own latch.
  if (
    event.type === "transcript.user.completed" &&
    fixture &&
    fixture.count() > before
  ) {
    await fixture.waitForCommand(
      (command) =>
        command.type === "response.create" &&
        command.generation === result.generation,
      offset,
    );
  }
  return result;
}

function insertCompletedVoiceHistory(
  value: Awaited<ReturnType<typeof fixture>>,
  contents: readonly string[],
) {
  for (const [index, content] of contents.entries()) {
    const suffix = String(index + 1).padStart(12, "0");
    const runId = `20000000-0000-4000-8000-${suffix}`;
    value.writer.startRun({
      chatId: CHAT_ID,
      createdAt: NOW,
      execution: { mode: "chat" },
      id: runId,
      latestSequence: 1,
      persona: defaultPersonaSnapshot(NOW),
      provider: value.chatRuntime.snapshot,
      source: "voice",
      startedAt: NOW,
      status: "running",
    });
    value.chats.insertMessage({
      chatId: CHAT_ID,
      content,
      createdAt: NOW,
      id: `30000000-0000-4000-8000-${suffix}`,
      role: "user",
      runId,
      status: "completed",
      updatedAt: NOW,
    });
    value.writer.transition(runId, "completed");
  }
}

async function startTurn(
  value: Awaited<ReturnType<typeof fixture>>,
  execution:
    | { mode: "chat" }
    | {
        approvalMode: "request_approval";
        mode: "agent";
      },
  transcript: string,
) {
  const connection = await value.service.start({
    chatId: CHAT_ID,
    chatProviderProfileId: PROFILE_ID,
    execution,
    requestedAt: NOW,
  });
  await report(value.service, connection.sessionId, {
    protocolSessionId: "protocol-session",
    type: "session.ready",
  });
  await report(value.service, connection.sessionId, {
    itemId: "user-item-1",
    type: "speech.started",
  });
  await report(value.service, connection.sessionId, {
    itemId: "user-item-1",
    transcript,
    type: "transcript.user.completed",
  });
  const run = value.runs.getActiveRun(CHAT_ID);
  if (!run) throw new Error("Voice Run was not created");
  return { connection, run };
}

async function finalResponse(
  value: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  generation: number,
  responseId: string,
  text: string,
) {
  await report(value.service, sessionId, {
    generation,
    responseId,
    type: "response.started",
  });
  await report(value.service, sessionId, {
    delta: text,
    generation,
    itemId: `${responseId}-item`,
    outputIndex: 0,
    responseId,
    type: "transcript.assistant.delta",
  });
  await report(value.service, sessionId, {
    generation,
    itemId: `${responseId}-item`,
    outputIndex: 0,
    responseId,
    transcript: text,
    type: "transcript.assistant.done",
  });
  await report(value.service, sessionId, {
    generation,
    hasAudio: false,
    responseId,
    status: "completed",
    type: "response.done",
  });
}

describe("Realtime native Voice runtime", () => {
  it("materializes only cognition's selected EvidencePack for the Voice turn", async () => {
    const value = await fixture();
    const created = value.memory.create({
      confidence: 1,
      content: "用户长期游玩 CS2，并关注职业选手比赛。",
      importance: 0.9,
      reason: "用户明确说明",
      sources: [],
      type: "preference",
    });

    value.memory.create({
      type: "profile",
      content: "无关的其他个人资料。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    value.setPreparedContext({
      text: "用户正在询问爱好。",
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
      evidencePack: {
        items: value.memoryRepository.recall.evidence(
          [created.memory.currentRevisionId],
          NOW,
        ),
        coverage: [],
        gaps: [],
        estimatedTokens: 1000,
        truncated: false,
        incompleteReasons: [],
      },
    });
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "我有什么爱好？",
    );
    expect(run.persona).toEqual(defaultPersonaSnapshot(NOW));
    expect(value.service.getActive()?.persona).toEqual(run.persona);
    expect(value.repository.getSession(connection.sessionId)?.persona).toEqual(
      run.persona,
    );
    const response = value.commands.findLast(
      (command) => command.type === "response.create",
    );
    if (response?.type !== "response.create") {
      throw new Error("Voice response command was not emitted");
    }
    expect(response.instructions).not.toContain(created.memory.id);
    expect(response.instructions).not.toContain(
      created.memory.currentRevisionId,
    );
    expect(response.instructions).not.toContain("无关的其他个人资料");
    expect(value.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        currentInput: "我有什么爱好？",
        chatId: CHAT_ID,
      }),
    );
    expect(response.instructions).toContain("长期游玩 CS2");
    expect(value.issue.mock.calls[0]?.[1].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "memory_search" }),
      ]),
    );
    expect(value.memory.get(created.memory.id).usages).toEqual([]);
    await value.service.end({ sessionId: connection.sessionId });
    await value.service.shutdown();
    value.database.close();
  });

  it("shares consumed Voice provenance with formation, excluding a just-sent Tool result until the next response starts", async () => {
    const value = await fixture();
    const first = value.memory.create({
      type: "event",
      content: "以前和妈妈约定过雨天在家练习。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    const second = value.memory.create({
      type: "event",
      content: "送给阿澄一本摄影集。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    const historyRef = {
      memoryId: first.memory.id,
      revisionId: first.memory.currentRevisionId,
      use: "history",
    };
    const secondRef = {
      memoryId: second.memory.id,
      revisionId: second.memory.currentRevisionId,
      use: "current",
    };
    value.setPreparedContext({
      text: "回忆过去雨天约定",
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
      historicalMemoryRevisionIds: [first.memory.currentRevisionId],
      evidencePack: {
        items: value.memoryRepository.recall.evidence(
          [first.memory.currentRevisionId],
          NOW,
        ),
        coverage: [],
        gaps: [],
        estimatedTokens: 500,
        truncated: false,
        incompleteReasons: [],
      },
    });
    const captured: MemoryFormationIntake[] = [];
    registerMemoryFormationTool(value.tools, value.memory, (runId, itemId) => {
      const intake = runMemoryIntake(
        value.runs.getRun(runId)!,
        value.runs,
        value.chats,
        itemId,
      );
      if (intake) captured.push(intake);
      return intake;
    });
    await value.memory.indexPending();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "那个雨天约定对我很重要。",
    );
    expect(value.runs.suppliedMemoryReferences(run.id)).toEqual([]);
    const initialRequestId = value.commands.findLast(
      (command) => command.type === "response.create",
    )!.requestId;
    // Missing and unrelated request IDs allow normal tools to continue without
    // crediting any prepared context to that response.
    for (const requestId of [undefined, "unrelated-request"]) {
      const responseId = requestId ?? "missing-request";
      await report(value.service, connection.sessionId, {
        type: "response.started",
        generation: 1,
        responseId,
        ...(requestId ? { requestId } : {}),
      });
      await report(value.service, connection.sessionId, {
        type: "tool.call",
        itemId: "voice-function-unlinked",
        generation: 1,
        responseId,
        callId: responseId,
        name: "memory_record",
        arguments: "{}",
      });
      await vi.waitFor(() =>
        expect(value.commands).toContainEqual(
          expect.objectContaining({ type: "tool.result", callId: responseId }),
        ),
      );
      expect(captured.at(-1)?.episode.availableMemoryReferences ?? []).toEqual(
        [],
      );
    }
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "voice-search-response",
      requestId: initialRequestId,
    });
    await report(value.service, connection.sessionId, {
      type: "tool.call",
      itemId: "voice-function-item",
      generation: 1,
      responseId: "voice-search-response",
      callId: "voice-search",
      name: "memory_search",
      arguments: JSON.stringify({
        arguments: {
          query: "阿澄 摄影集",
          questions: [{ id: "photo", text: "送给阿澄的摄影集" }],
        },
      }),
    });
    await vi.waitFor(() =>
      expect(value.commands).toContainEqual(
        expect.objectContaining({
          type: "tool.result",
          callId: "voice-search",
        }),
      ),
    );
    expect(value.runs.suppliedMemoryReferences(run.id)).toEqual([historyRef]);
    // Another function call in the original response cannot see the first
    // call's subsequently returned data, even though the host has sent it.
    await report(value.service, connection.sessionId, {
      type: "tool.call",
      itemId: "voice-function-item",
      generation: 1,
      responseId: "voice-search-response",
      callId: "voice-record-before",
      name: "memory_record",
      arguments: "{}",
    });
    await vi.waitFor(() =>
      expect(value.commands).toContainEqual(
        expect.objectContaining({
          type: "tool.result",
          callId: "voice-record-before",
        }),
      ),
    );
    expect(captured.at(-1)?.episode.availableMemoryReferences).toEqual([
      historyRef,
    ]);
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "voice-record-response",
      requestId: value.commands
        .filter((command) => command.type === "tool.result")
        .find((command) => command.callId === "voice-search")!.requestId,
    });
    await report(value.service, connection.sessionId, {
      type: "tool.call",
      itemId: "voice-function-item",
      generation: 1,
      responseId: "voice-record-response",
      callId: "voice-record-after",
      name: "memory_record",
      arguments: "{}",
    });
    await vi.waitFor(() =>
      expect(value.commands).toContainEqual(
        expect.objectContaining({
          type: "tool.result",
          callId: "voice-record-after",
        }),
      ),
    );
    expect(captured.at(-1)?.episode.availableMemoryReferences).toEqual(
      expect.arrayContaining([historyRef, secondRef]),
    );
    // A duplicate acknowledgement and a delayed function from the old response
    // must keep its original basis even after a newer response saw search data.
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "voice-search-response",
      requestId: initialRequestId,
    });
    await report(value.service, connection.sessionId, {
      type: "tool.call",
      itemId: "voice-function-delayed",
      generation: 1,
      responseId: "voice-search-response",
      callId: "voice-record-delayed",
      name: "memory_record",
      arguments: "{}",
    });
    await vi.waitFor(() =>
      expect(value.commands).toContainEqual(
        expect.objectContaining({
          type: "tool.result",
          callId: "voice-record-delayed",
        }),
      ),
    );
    expect(captured.at(-1)?.episode.availableMemoryReferences).toEqual([
      historyRef,
    ]);
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "voice-silent-success",
      requestId: value.commands
        .filter((command) => command.type === "tool.result")
        .find((command) => command.callId === "voice-record-after")!.requestId,
    });
    await report(value.service, connection.sessionId, {
      type: "response.done",
      generation: 1,
      responseId: "voice-silent-success",
      status: "completed",
      hasAudio: false,
    });
    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(
      value.chats
        .listRunMessages(run.id)
        .filter(({ role }) => role === "assistant"),
    ).toEqual([]);
    expect(
      value.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "assistant_message"),
    ).toHaveLength(1);
    expect(value.runs.suppliedMemoryReferences(run.id)).toEqual(
      expect.arrayContaining([historyRef, secondRef]),
    );
    value.setPreparedContext({
      text: "",
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
    });
    await report(value.service, connection.sessionId, {
      type: "speech.started",
      itemId: "voice-user-next",
    });
    await report(value.service, connection.sessionId, {
      type: "transcript.user.completed",
      itemId: "voice-user-next",
      transcript: "刚才那个提醒没有帮到我，但约定很重要。",
    });
    const next = value.runs.getActiveRun(CHAT_ID)!;
    const nextIntake = runMemoryIntake(next, value.runs, value.chats);
    expect(nextIntake?.episode.availableMemoryReferences).toEqual(
      expect.arrayContaining([historyRef, secondRef]),
    );
    expect(value.runs.suppliedMemoryReferences(next.id)).toEqual([]);
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "voice-late-prior-turn",
      requestId: initialRequestId,
    });
    expect(value.runs.suppliedMemoryReferences(next.id)).toEqual([]);
    await value.service.end({ sessionId: connection.sessionId });
    await value.service.shutdown();
    value.database.close();
  });

  it("records a malformed Memory Tool payload as a failed item and still returns a Voice tool result", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "我和妈妈有什么约定？",
    );
    const request = value.commands.findLast(
      (command) => command.type === "response.create",
    )!;
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "malformed-memory",
      requestId: request.requestId,
    });
    vi.spyOn(value.tools, "execute").mockResolvedValueOnce({
      status: "success",
      retryable: false,
      artifacts: [],
      summary: "invalid fixture",
      modelContent: { items: "not-an-evidence-pack" },
    });
    await report(value.service, connection.sessionId, {
      type: "tool.call",
      itemId: "malformed-function-item",
      generation: 1,
      responseId: "malformed-memory",
      callId: "malformed-search",
      name: "memory_search",
      arguments: JSON.stringify({
        arguments: {
          query: "妈妈 约定",
          questions: [{ id: "q", text: "妈妈的约定" }],
        },
      }),
    });
    await vi.waitFor(() =>
      expect(value.commands).toContainEqual(
        expect.objectContaining({
          type: "tool.result",
          callId: "malformed-search",
        }),
      ),
    );
    const item = value.runs
      .listRunItems(run.id)
      .find(({ kind }) => kind === "tool_call")!;
    expect(item.status).toBe("failed");
    expect(item.error).toBeDefined();
    expect(value.runs.suppliedMemoryReferences(run.id)).toEqual([]);
    expect(value.service.getActive()).toBeDefined();
    await value.service.end({ sessionId: connection.sessionId });
    await value.service.shutdown();
    value.database.close();
  });

  it("does not read the complete profile for a Voice greeting", async () => {
    const value = await fixture();
    value.memory.create({
      type: "profile",
      content: "用户在杭州工作。",
      confidence: 1,
      importance: 0.5,
      reason: "user",
      sources: [],
    });
    const recall = vi.spyOn(value.memory, "recall");
    const { connection } = await startTurn(value, { mode: "chat" }, "晚上好");
    const response = value.commands.findLast(
      (command) => command.type === "response.create",
    );
    if (response?.type !== "response.create")
      throw new Error("Voice response was not emitted");
    expect(value.prepareTurn).toHaveBeenCalledTimes(1);
    expect(recall).not.toHaveBeenCalled();
    expect(response.instructions).not.toContain("用户在杭州工作");
    await value.service.end({ sessionId: connection.sessionId });
    await value.service.shutdown();
    value.database.close();
  });

  it("prepares long Voice-only history before the first text usage measurement", async () => {
    const value = await fixture();
    const measuredText: ModelRequest[] = [];
    value.chatProvider.measureInput = (request, signal) => {
      signal.throwIfAborted();
      measuredText.push(request);
      return Promise.resolve({
        ...value.chatProvider.estimateInput(request),
        exactInputTokens: 100,
      });
    };
    insertCompletedVoiceHistory(
      value,
      Array.from({ length: 4 }, () => "回顾".repeat(5_000)),
    );
    expect(value.chats.getContextSnapshot(CHAT_ID)).toBeUndefined();
    value.chatProvider.stream.mockImplementation(
      async function* (): AsyncIterable<ModelEvent> {
        yield await Promise.resolve<ModelEvent>({
          type: "text.delta",
          delta: "已整理过往语音对话。",
        });
        yield {
          type: "response.completed",
          responseId: "summary-voice",
          status: "completed",
          usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 20 },
        };
      },
    );
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    expect(value.createChatModelRuntime).toHaveBeenCalledOnce();
    // The complete instructions and tool schemas determine how many completed
    // segments fit per summary request. The contract is prepared history before
    // session creation, not a fixed number of model calls.
    expect(value.chatProvider.stream).toHaveBeenCalled();
    // The tiny Responses count can fit a text-summary request, never authorize
    // the Realtime startup/replay. Replay still required this actual summary.
    expect(measuredText.length).toBeGreaterThan(0);
    expect(
      measuredText.every((request) => request.instructions.length > 0),
    ).toBe(true);
    expect(value.chats.getContextSnapshot(CHAT_ID)?.summary).toBe(
      "已整理过往语音对话。",
    );
    expect(connection.history.length).toBeLessThan(4);
    expect(value.chats.listMessages(CHAT_ID)).toHaveLength(4);
    expect(value.issue.mock.calls[0]?.[1].instructions).toContain(
      "已整理过往语音对话。",
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("rejects an oversized first Voice history segment before opening a session", async () => {
    const value = await fixture();
    insertCompletedVoiceHistory(value, ["汉".repeat(90_000)]);
    await expect(
      value.service.start({
        chatId: CHAT_ID,
        chatProviderProfileId: PROFILE_ID,
        execution: { mode: "chat" },
        requestedAt: NOW,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(value.chatProvider.stream).not.toHaveBeenCalled();
    expect(value.issue).not.toHaveBeenCalled();
    expect(value.chats.getContextSnapshot(CHAT_ID)).toBeUndefined();
    expect(value.chats.listMessages(CHAT_ID)).toHaveLength(1);
    await value.service.shutdown();
    value.database.close();
  });

  it("keeps short Voice-only history independent of an unavailable text summarizer", async () => {
    const value = await fixture();
    insertCompletedVoiceHistory(value, ["上次聊过我的猫。"]);
    value.createChatModelRuntime.mockRejectedValue(
      new Error("Optional text Provider is unavailable"),
    );
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    expect(connection.history).toEqual([
      { content: "上次聊过我的猫。", role: "user" },
    ]);
    expect(value.createChatModelRuntime).not.toHaveBeenCalled();
    expect(value.issue).toHaveBeenCalledOnce();
    await value.service.shutdown();
    value.database.close();
  });

  it.each(["instructions", "tools"])(
    "includes startup %s before obtaining a Realtime session",
    async (field) => {
      const value = await fixture();
      if (field === "instructions")
        value.setPersona({ voiceInstructions: "指令".repeat(20_000) });
      else
        value.tools.register({
          descriptor: {
            name: "large.lookup",
            namespace: "large",
            description: "工具".repeat(20_000),
            summary: "读取",
            effect: "read",
            idempotency: "idempotent",
            itemKind: "tool_call",
            source: "builtin",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
          execute: () => Promise.reject(new Error("Must not execute")),
          summarize: () => "读取",
        });
      await expect(
        value.service.start({
          chatId: CHAT_ID,
          chatProviderProfileId: PROFILE_ID,
          execution: { mode: "chat" },
          requestedAt: NOW,
        }),
      ).rejects.toMatchObject({
        code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
        retryable: false,
      });
      expect(value.createChatModelRuntime).not.toHaveBeenCalled();
      expect(value.issue).not.toHaveBeenCalled();
      await value.service.shutdown();
      value.database.close();
    },
  );

  it("does not infer a native window from an unknown Azure deployment alias", async () => {
    const value = await fixture({ realtimeModelId: "my-voice-deployment" });
    insertCompletedVoiceHistory(value, ["回顾".repeat(20_000)]);
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    expect(connection.history).toHaveLength(1);
    expect(value.createChatModelRuntime).not.toHaveBeenCalled();
    expect(value.issue).toHaveBeenCalledOnce();
    await value.service.shutdown();
    value.database.close();
  });

  it("injects the durable Chat summary and only uncovered history on start and reconnect", async () => {
    const value = await fixture();
    const runIds = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ];
    const messageIds = [
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
      "30000000-0000-4000-8000-000000000004",
    ];
    const startRun = (runId: string) =>
      value.writer.startRun({
        chatId: CHAT_ID,
        createdAt: NOW,
        execution: { mode: "chat" },
        id: runId,
        latestSequence: 1,
        persona: defaultPersonaSnapshot(NOW),
        provider: {
          apiStyle: "openai-compatible",
          modelId: "gpt-5.6",
          profileId: PROFILE_ID,
          profileName: "Chat",
        },
        source: "text",
        startedAt: NOW,
        status: "running",
      });
    startRun(runIds[0]!);
    value.chats.insertMessage({
      chatId: CHAT_ID,
      content: "已覆盖用户消息",
      createdAt: NOW,
      id: messageIds[0]!,
      role: "user",
      runId: runIds[0]!,
      status: "completed",
      updatedAt: NOW,
    });
    value.chats.insertMessage({
      chatId: CHAT_ID,
      content: "已覆盖助手消息",
      createdAt: NOW,
      id: messageIds[1]!,
      role: "assistant",
      runId: runIds[0]!,
      status: "completed",
      updatedAt: NOW,
    });
    value.writer.transition(runIds[0]!, "completed");
    startRun(runIds[1]!);
    value.chats.insertMessage({
      chatId: CHAT_ID,
      content: "近期用户消息",
      createdAt: NOW,
      id: messageIds[2]!,
      role: "user",
      runId: runIds[1]!,
      status: "completed",
      updatedAt: NOW,
    });
    value.chats.insertMessage({
      chatId: CHAT_ID,
      content: "近期助手消息",
      createdAt: NOW,
      id: messageIds[3]!,
      role: "assistant",
      runId: runIds[1]!,
      status: "completed",
      updatedAt: NOW,
    });
    value.writer.transition(runIds[1]!, "completed");
    value.chats.recordContextUsage({
      chatId: CHAT_ID,
      inputTokens: 10,
      modelId: "gpt-5.6",
      requestBytes: 1_000,
      updatedAt: NOW,
    });
    value.chats.advanceContextSnapshot({
      boundary: { createdAt: NOW, messageId: messageIds[1]! },
      chatId: CHAT_ID,
      expectedGeneration: 0,
      summary: "已覆盖对话的持久摘要。",
      updatedAt: NOW,
    });

    const request = {
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" as const },
      requestedAt: NOW,
    };
    const connection = await value.service.start(request);
    expect(connection.history).toEqual([
      { content: "近期用户消息", role: "user" },
      { content: "近期助手消息", role: "assistant" },
    ]);
    expect(value.issue.mock.calls[0]?.[1].instructions).toContain(
      "已覆盖对话的持久摘要",
    );
    expect(JSON.stringify(connection.history)).not.toContain("已覆盖用户消息");

    await report(value.service, connection.sessionId, {
      protocolSessionId: "protocol-context-session",
      type: "session.ready",
    });
    await report(value.service, connection.sessionId, {
      reason: "network closed",
      type: "connection.closed",
    });
    const reconnected = await value.service.start(request);
    expect(reconnected.history).toEqual(connection.history);
    expect(value.issue.mock.calls[1]?.[1].instructions).toContain(
      "已覆盖对话的持久摘要",
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("pauses media without closing WebRTC and refreshes instructions and tools on resume", async () => {
    const value = await fixture();
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    await report(value.service, connection.sessionId, {
      protocolSessionId: "protocol-session-pause",
      type: "session.ready",
    });

    const paused = await value.service.setPaused({
      paused: true,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });
    expect(paused).not.toHaveProperty("connection");
    expect(paused.snapshot.phase).toBe("paused");
    expect(value.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: false, type: "capture.set" }),
        expect.objectContaining({ enabled: false, type: "playback.set" }),
      ]),
    );
    expect(value.commands.some(({ type }) => type === "session.close")).toBe(
      false,
    );

    value.setPersona({ voiceInstructions: "恢复后优先给出简短结论。" });
    const resumed = await value.service.setPaused({
      paused: false,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });
    expect(resumed).not.toHaveProperty("connection");
    expect(resumed.snapshot.phase).toBe("resuming");
    expect(value.issue).toHaveBeenCalledOnce();
    const refresh = value.commands.findLast(
      (command) => command.type === "session.refresh",
    );
    if (refresh?.type !== "session.refresh") {
      throw new Error("Session refresh command was not emitted");
    }
    expect(refresh).toMatchObject({
      sessionId: connection.sessionId,
      type: "session.refresh",
    });
    expect(refresh.instructions).not.toContain("恢复后优先给出简短结论。");
    expect(refresh.instructions).toContain("语气明快、有温度但不催促");
    expect(refresh.tools.length).toBeGreaterThan(0);
    await report(value.service, connection.sessionId, {
      requestId: refresh.requestId,
      type: "session.refreshed",
    });

    expect(value.service.getActive()).toMatchObject({
      phase: "listening",
      sessionId: connection.sessionId,
    });
    expect(value.repository.getSession(connection.sessionId)?.status).toBe(
      "active",
    );
    expect(value.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: true, type: "playback.set" }),
        expect.objectContaining({ enabled: true, type: "capture.set" }),
      ]),
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("keeps the original Persona voice when the active Persona changes while paused", async () => {
    const value = await fixture();
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    await report(value.service, connection.sessionId, {
      protocolSessionId: "protocol-session-before-config-change",
      type: "session.ready",
    });
    await value.service.setPaused({
      paused: true,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });
    value.setPersona({ defaultVoice: "coral" });

    const resumed = await value.service.setPaused({
      origin: "voice_wake",
      paused: false,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });
    expect(resumed.snapshot).toMatchObject({
      chatId: CHAT_ID,
      phase: "resuming",
      sessionId: connection.sessionId,
      voice: "verse",
    });
    expect(resumed).not.toHaveProperty("connection");
    expect(value.issue).toHaveBeenCalledOnce();
    expect(value.repository.getSession(connection.sessionId)?.status).toBe(
      "active",
    );
    const refresh = value.commands.findLast(
      (command) => command.type === "session.refresh",
    );
    if (refresh?.type !== "session.refresh") {
      throw new Error("Session refresh command was not emitted");
    }
    await report(value.service, connection.sessionId, {
      requestId: refresh.requestId,
      type: "session.refreshed",
    });
    expect(value.service.getActive()).toMatchObject({
      persona: { defaultVoice: "verse" },
      phase: "thinking",
      sessionId: connection.sessionId,
    });
    await value.service.shutdown();
    value.database.close();
  });

  it("uses the same cold-reconnect contract when a future adapter cannot refresh in place", async () => {
    const value = await fixture({ supportsSessionRefresh: false });
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    await report(value.service, connection.sessionId, {
      protocolSessionId: "protocol-session-without-refresh",
      type: "session.ready",
    });
    await value.service.setPaused({
      paused: true,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });

    const resumed = await value.service.setPaused({
      paused: false,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });

    expect(resumed.connection?.sessionId).not.toBe(connection.sessionId);
    expect(resumed.snapshot).toMatchObject({
      chatId: CHAT_ID,
      phase: "connecting",
    });
    expect(value.issue).toHaveBeenCalledTimes(2);
    expect(value.repository.getSession(connection.sessionId)?.status).toBe(
      "completed",
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("interrupts an active Voice Run before entering the paused state", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "先开始回答，再暂停",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-before-pause",
      type: "response.started",
    });

    await value.service.setPaused({
      paused: true,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });

    expect(value.runs.getRun(run.id)?.status).toBe("interrupted");
    expect(value.service.getActive()?.phase).toBe("paused");
    expect(value.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          responseId: "response-before-pause",
          type: "response.cancel",
        }),
      ]),
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("freezes the final turn instructions after time advances during speech", async () => {
    const value = await fixture();
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    await report(value.service, connection.sessionId, {
      protocolSessionId: "protocol-session",
      type: "session.ready",
    });
    await report(value.service, connection.sessionId, {
      itemId: "user-item-after-delay",
      type: "speech.started",
    });

    value.clock.advance(1_000);
    await value.service.report({
      event: {
        itemId: "user-item-after-delay",
        transcript: "你好啊",
        type: "transcript.user.completed",
      },
      occurredAt: value.clock.now(),
      sessionId: connection.sessionId,
    });

    await value.waitForCommand((command) => command.type === "response.create");
    const turn = value.repository.getCurrentTurn(connection.sessionId);
    expect(turn).toMatchObject({
      status: "responding",
      userTranscript: "你好啊",
    });
    expect(turn?.instructions).toContain(value.clock.now());
    await value.service.shutdown();
    value.database.close();
  });

  it("lets Realtime own the answer while persisting the exact transcript in one Voice Run", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "你好，直接回答我",
    );

    const responseCreate = value.commands.find(
      (command) => command.type === "response.create",
    );
    expect(responseCreate).toMatchObject({
      generation: 1,
      type: "response.create",
    });
    expect(responseCreate).not.toHaveProperty("text");
    expect(responseCreate?.instructions).toContain(
      "Realtime owns this spoken conversation",
    );
    expect(responseCreate?.instructions).toContain(
      "Workspace skill instructions.",
    );
    expect(responseCreate?.instructions).toContain(
      "never claim that an earlier query is still loading",
    );

    await finalResponse(
      value,
      connection.sessionId,
      1,
      "response-final",
      "你好，我会直接回答。",
    );

    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(value.chats.listRunMessages(run.id)).toMatchObject([
      { content: "你好，直接回答我", role: "user", status: "completed" },
      {
        content: "你好，我会直接回答。",
        role: "assistant",
        status: "completed",
      },
    ]);
    expect(value.chatProvider.stream).not.toHaveBeenCalled();
    expect(value.commands.some(({ type }) => type === "tool.result")).toBe(
      false,
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("keeps one Chat message aligned with ordered audio items in a response", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "帮我查天气",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-multiple-audio-items",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      delta: "北京明天晴。",
      generation: 1,
      itemId: "assistant-final",
      outputIndex: 1,
      responseId: "response-multiple-audio-items",
      type: "transcript.assistant.delta",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-acknowledgement",
      outputIndex: 0,
      responseId: "response-multiple-audio-items",
      transcript: "好的，我来查一下。",
      type: "transcript.assistant.done",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-final",
      outputIndex: 1,
      responseId: "response-multiple-audio-items",
      transcript: "北京明天晴。",
      type: "transcript.assistant.done",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      hasAudio: false,
      responseId: "response-multiple-audio-items",
      status: "completed",
      type: "response.done",
    });

    const assistantMessages = value.chats
      .listRunMessages(run.id)
      .filter(({ role }) => role === "assistant");
    expect(assistantMessages).toMatchObject([
      {
        content: "好的，我来查一下。\n\n北京明天晴。",
        status: "completed",
      },
    ]);
    expect(value.repository.listTurns(connection.sessionId)[0]).toMatchObject({
      assistantTranscript: assistantMessages[0]?.content,
      status: "completed",
    });
    expect(
      value.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "assistant_message"),
    ).toMatchObject([
      {
        displayOutput: assistantMessages[0]?.content,
        status: "completed",
      },
    ]);
    await value.service.shutdown();
    value.database.close();
  });

  it("does not block Realtime when the optional title Provider credential cannot be read", async () => {
    const generate = vi
      .fn<ChatTitleGenerator["generate"]>()
      .mockResolvedValue();
    const value = await fixture({ title: { generate } });
    value.createChatModelRuntime.mockRejectedValue(
      new Error("title credential unavailable"),
    );

    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "先正常开始语音",
    );
    expect(value.createChatModelRuntime).not.toHaveBeenCalled();

    await finalResponse(
      value,
      connection.sessionId,
      1,
      "response-without-title-provider",
      "语音连接不受标题服务影响。",
    );

    await vi.waitFor(() =>
      expect(value.createChatModelRuntime).toHaveBeenCalledOnce(),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(value.service.getActive()?.phase).toBe("listening");
    await value.service.shutdown();
    value.database.close();
  });

  it("exports the complete Memory search contract inside a Realtime object root", async () => {
    const value = await fixture();
    const original = value.tools.get("memory.search")!.descriptor.inputSchema;
    const before = JSON.stringify(original);
    value.issue.mockImplementation((_runtime, options) => {
      // The actual Azure client_secrets rejection concerns these root fields,
      // not nested composition or the host's complete input validation.
      for (const tool of options.tools ?? []) {
        expect(tool.parameters).toHaveProperty("type", "object");
        for (const key of ["oneOf", "anyOf", "allOf", "enum", "not"])
          expect(tool.parameters).not.toHaveProperty(key);
      }
      return Promise.resolve({
        callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
        clientSecret: "ephemeral",
        expiresAt: "2026-08-09T12:01:00.000Z",
      });
    });
    try {
      const connection = await value.service.start({
        chatId: CHAT_ID,
        chatProviderProfileId: PROFILE_ID,
        execution: { mode: "chat" },
        requestedAt: NOW,
      });
      const tools = value.issue.mock.calls[0]![1].tools!;
      const parameters = tools.find(
        ({ name }) => name === "memory_search",
      )!.parameters;
      expect(parameters).toEqual({
        type: "object",
        additionalProperties: false,
        properties: { arguments: original },
        required: ["arguments"],
      });
      expect(
        tools.find(({ name }) => name === "weather_lookup")!.parameters,
      ).toEqual(value.tools.get("weather.lookup")!.descriptor.inputSchema);
      expect(value.tools.get("memory.search")!.descriptor.inputSchema).toBe(
        original,
      );
      expect(JSON.stringify(original)).toBe(before);
      const ajv = new Ajv({ strict: true, allErrors: true });
      ajv.addFormat(UTC_TIMESTAMP_FORMAT, isUtcTimestamp);
      const validate = ajv.compile(parameters as object);
      const reference = {
        memoryId: CHAT_ID,
        revisionId: PROFILE_ID,
        use: "history",
      };
      const questions = [{ id: "q1", text: "原来的约定是什么？" }];
      const cases = [
        { input: { query: "原计划" }, valid: true },
        {
          input: { query: "", references: [reference], questions },
          valid: true,
        },
        { input: { query: "" }, valid: false },
        { input: { query: " ", references: [], questions: [] }, valid: false },
        { input: { query: "", references: [reference] }, valid: false },
        { input: { query: "", questions }, valid: false },
        { input: { query: "原计划", owner: "other" }, valid: false },
        {
          input: { query: "原计划", questions: [{ id: "q", text: "" }] },
          valid: false,
        },
      ];
      for (const { input, valid } of cases) {
        expect(validate({ arguments: input })).toBe(valid);
        if (valid)
          expect(() =>
            value.tools.validateInput("memory.search", input),
          ).not.toThrow();
        else
          expect(() =>
            value.tools.validateInput("memory.search", input),
          ).toThrow();
      }
      expect(validate({ query: "原计划" })).toBe(false);
      expect(validate({ arguments: { query: "原计划" }, extra: true })).toBe(
        false,
      );
      await value.service.end({ sessionId: connection.sessionId });
    } finally {
      await value.service.shutdown();
      value.database.close();
    }
  });

  it("unwraps Realtime Memory arguments before the original validator and returns the same call ID", async () => {
    const value = await fixture();
    const execute = vi.spyOn(value.tools, "execute");
    try {
      const { connection, run } = await startTurn(
        value,
        { mode: "chat" },
        "我们原来的约定是什么？",
      );
      await report(value.service, connection.sessionId, {
        type: "response.started",
        generation: 1,
        responseId: "wrapped-search-response",
      });
      const inputs = [
        { arguments: { query: "原来的约定" } },
        { arguments: { query: "" } },
        { query: "原来的约定" },
        { arguments: { query: "原来的约定" }, extra: true },
      ];
      for (const [index, input] of inputs.entries()) {
        const callId = `wrapped-search-${String(index)}`;
        await report(value.service, connection.sessionId, {
          type: "tool.call",
          generation: 1,
          responseId: "wrapped-search-response",
          itemId: `function-${String(index)}`,
          callId,
          name: "memory_search",
          arguments: JSON.stringify(input),
        });
        await vi.waitFor(() =>
          expect(value.commands).toContainEqual(
            expect.objectContaining({ type: "tool.result", callId }),
          ),
        );
        const command = value.commands.findLast(
          (command) =>
            command.type === "tool.result" && command.callId === callId,
        )!;
        if (command.type !== "tool.result")
          throw new Error("Missing Tool result");
        const result = JSON.parse(command.output) as ToolResult;
        expect(result.status).toBe(index === 0 ? "success" : "error");
        const wire = voiceToolResultEvents(command);
        expect(wire[0].item).toEqual({
          type: "function_call_output",
          call_id: callId,
          output: command.output,
        });
        expect(wire).toHaveLength(2);
        expect(wire[1].type).toBe("response.create");
      }
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toEqual({ query: "原来的约定" });
      const items = value.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "tool_call");
      expect(items.map(({ status }) => status)).toEqual([
        "completed",
        "failed",
        "failed",
        "failed",
      ]);
      expect(items[0]?.input).toMatchObject({
        arguments: { query: "原来的约定" },
        toolName: "memory.search",
      });
      await value.service.end({ sessionId: connection.sessionId });
    } finally {
      await value.service.shutdown();
      value.database.close();
    }
  });

  it("keeps an object-union Tool contract while satisfying Realtime's object root", async () => {
    const value = await fixture();
    value.tools.register({
      descriptor: {
        description: "按查询或 ID 读取内容。",
        effect: "read",
        idempotency: "idempotent",
        inputSchema: {
          anyOf: [
            {
              additionalProperties: false,
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: { id: { type: "string" } },
              required: ["id"],
              type: "object",
            },
          ],
        },
        itemKind: "tool_call",
        name: "choice.lookup",
        namespace: "choice",
        source: "builtin",
        summary: "读取内容",
      },
      execute: vi.fn().mockResolvedValue({
        artifacts: [],
        modelContent: { found: true },
        retryable: false,
        status: "success",
        summary: "已读取",
      }),
      summarize: () => "读取内容",
    });

    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    const unionTool = value.issue.mock.calls[0]?.[1].tools?.find(
      ({ name }) => name === "choice_lookup",
    );
    expect(unionTool?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        query: { type: "string" },
      },
      type: "object",
    });
    expect(unionTool?.parameters).not.toHaveProperty("anyOf");
    await value.service.end({ sessionId: connection.sessionId });
    await value.service.shutdown();
    value.database.close();
  });

  it("injects the same allowed client tools and continues after function_call_output", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "北京天气如何",
    );
    const issueOptions = value.issue.mock.calls[0]?.[1];
    expect(issueOptions?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_navigate", type: "function" }),
        expect.objectContaining({ name: "browser_snapshot", type: "function" }),
        expect.objectContaining({ name: "file_read", type: "function" }),
        expect.objectContaining({ name: "voice_end", type: "function" }),
        expect.objectContaining({ name: "weather_lookup", type: "function" }),
      ]),
    );
    expect(issueOptions?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "command_run" }),
        expect.objectContaining({ name: "note_save" }),
      ]),
    );

    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-tool",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"city":"北京"}',
      callId: "call-weather",
      generation: 1,
      itemId: "function-item",
      name: "weather_lookup",
      responseId: "response-tool",
      type: "tool.call",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      hasAudio: false,
      responseId: "response-tool",
      status: "completed",
      type: "response.done",
    });
    await vi.waitFor(() => expect(value.read).toHaveBeenCalledOnce());
    const executionContext = value.read.mock.calls[0]?.[1] as
      ToolExecutionContext | undefined;
    expect(executionContext?.availableToolNames).toEqual(
      expect.arrayContaining([
        "browser.navigate",
        "file.read",
        "weather.lookup",
      ]),
    );
    expect(executionContext?.availableToolNames).not.toContain("note.save");
    const result = value.commands.find(
      (command) => command.type === "tool.result",
    );
    expect(result).toMatchObject({
      callId: "call-weather",
      generation: 1,
      type: "tool.result",
    });
    expect(
      JSON.parse(result?.type === "tool.result" ? result.output : "{}"),
    ).toMatchObject({ modelContent: { forecast: "晴" }, status: "success" });

    await finalResponse(
      value,
      connection.sessionId,
      1,
      "response-after-tool",
      "北京今天晴。",
    );
    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(value.runs.listRunItems(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool_call", status: "completed" }),
      ]),
    );
    await value.service.shutdown();
    value.database.close();
  });

  it("lets the Voice Agent say goodbye and hang up only after audio drains", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "拜拜，你挂了吧",
    );

    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-end-tool",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: "{}",
      callId: "call-end",
      generation: 1,
      itemId: "function-end-item",
      name: "voice_end",
      responseId: "response-end-tool",
      type: "tool.call",
    });
    await vi.waitFor(() =>
      expect(
        value.commands.find(
          (command) =>
            command.type === "tool.result" && command.callId === "call-end",
        ),
      ).toBeDefined(),
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      hasAudio: false,
      responseId: "response-end-tool",
      status: "completed",
      type: "response.done",
    });

    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-goodbye",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      delta: "拜拜，回头见。",
      generation: 1,
      itemId: "assistant-goodbye",
      outputIndex: 0,
      responseId: "response-goodbye",
      type: "transcript.assistant.delta",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-goodbye",
      responseId: "response-goodbye",
      type: "audio.started",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-goodbye",
      outputIndex: 0,
      responseId: "response-goodbye",
      transcript: "拜拜，回头见。",
      type: "transcript.assistant.done",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      hasAudio: true,
      responseId: "response-goodbye",
      status: "completed",
      type: "response.done",
    });

    expect(value.service.getActive()?.sessionId).toBe(connection.sessionId);
    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(
      value.commands.filter((command) => command.type === "session.close"),
    ).toHaveLength(0);
    expect(
      value.runs.listRunItems(run.id).filter(({ kind }) => kind === "approval"),
    ).toHaveLength(0);

    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-goodbye",
      responseId: "response-goodbye",
      type: "audio.stopped",
    });

    expect(value.service.getActive()).toBeNull();
    expect(value.repository.getSession(connection.sessionId)?.status).toBe(
      "completed",
    );
    expect(value.commands.at(-1)).toMatchObject({ type: "session.close" });
    await value.service.shutdown();
    value.database.close();
  });

  it("uses the existing Approval item and bubble decision before a write tool", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "帮我保存便签",
    );
    expect(value.issue.mock.calls[0]?.[1].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "command_run" }),
        expect.objectContaining({ name: "note_save" }),
        expect.objectContaining({ name: "weather_lookup" }),
      ]),
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-write",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"text":"买牛奶"}',
      callId: "call-note",
      generation: 1,
      itemId: "function-note",
      name: "note_save",
      responseId: "response-write",
      type: "tool.call",
    });

    const approval = value.runs.getLatestPendingApproval();
    expect(approval).toMatchObject({
      runId: run.id,
      status: "pending",
      toolName: "note.save",
    });
    expect(value.service.getActive()?.phase).toBe("waiting_approval");
    if (!approval) throw new Error("Approval was not created");
    value.service.resolveApproval({
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "approved",
    });

    await vi.waitFor(() => expect(value.write).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        value.commands.find((command) => command.type === "tool.result"),
      ).toMatchObject({ callId: "call-note", type: "tool.result" }),
    );
    expect(value.runs.getApproval(approval.id)?.status).toBe("approved");
    expect(value.runs.getRun(run.id)?.status).toBe("running");
    await value.service.shutdown();
    value.database.close();
  });

  it("returns a rejected Approval to Realtime without executing the write", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "帮我保存便签",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-rejected-write",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"text":"买牛奶"}',
      callId: "call-rejected-note",
      generation: 1,
      itemId: "function-rejected-note",
      name: "note_save",
      responseId: "response-rejected-write",
      type: "tool.call",
    });

    const approval = value.runs.getLatestPendingApproval();
    if (!approval) throw new Error("Approval was not created");
    value.service.resolveApproval({
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "rejected",
      reason: "暂时不要保存",
    });

    await vi.waitFor(() =>
      expect(
        value.commands.find(
          (command) =>
            command.type === "tool.result" &&
            command.callId === "call-rejected-note",
        ),
      ).toBeDefined(),
    );
    const result = value.commands.find(
      (command) =>
        command.type === "tool.result" &&
        command.callId === "call-rejected-note",
    );
    expect(
      JSON.parse(result?.type === "tool.result" ? result.output : "{}"),
    ).toMatchObject({
      modelContent: { decision: "rejected", reason: "暂时不要保存" },
      status: "rejected",
    });
    expect(value.write).not.toHaveBeenCalled();
    expect(value.runs.getApproval(approval.id)?.status).toBe("rejected");
    expect(value.runs.getRun(run.id)?.status).toBe("running");
    expect(value.service.getActive()?.phase).toBe("thinking");
    await value.service.shutdown();
    value.database.close();
  });

  it("cancels a pending Approval when the Realtime turn fails", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "帮我保存便签",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-failed-write",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"text":"买牛奶"}',
      callId: "call-failed-note",
      generation: 1,
      itemId: "function-failed-note",
      name: "note_save",
      responseId: "response-failed-write",
      type: "tool.call",
    });
    const approval = value.runs.getLatestPendingApproval();
    if (!approval) throw new Error("Approval was not created");

    await report(value.service, connection.sessionId, {
      code: "VOICE.REALTIME_ERROR",
      message: "Realtime failed",
      type: "server.error",
    });

    expect(value.runs.getApproval(approval.id)?.status).toBe("cancelled");
    expect(value.runs.getLatestPendingApproval()).toBeUndefined();
    expect(value.runs.getRun(run.id)?.status).toBe("failed");
    expect(value.service.getActive()?.phase).toBe("failed");
    expect(value.write).not.toHaveBeenCalled();
    await value.service.shutdown();
    value.database.close();
  });

  it("interrupts the prior Run on natural barge-in and accepts the next turn", async () => {
    const value = await fixture();
    const { connection, run: firstRun } = await startTurn(
      value,
      { mode: "chat" },
      "先回答第一问",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-first",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      delta: "还没说完",
      generation: 1,
      itemId: "assistant-first",
      outputIndex: 0,
      responseId: "response-first",
      type: "transcript.assistant.delta",
    });

    await report(value.service, connection.sessionId, {
      assistantItemId: "assistant-first",
      audioEndMs: 240,
      itemId: "user-item-2",
      type: "speech.started",
    });
    expect(value.runs.getRun(firstRun.id)?.status).toBe("interrupted");
    expect(value.chats.listRunMessages(firstRun.id).at(-1)).toMatchObject({
      content: "还没说完",
      role: "assistant",
      status: "interrupted",
    });

    await report(value.service, connection.sessionId, {
      itemId: "user-item-2",
      transcript: "改问第二个问题",
      type: "transcript.user.completed",
    });
    const secondRun = value.runs.getActiveRun(CHAT_ID);
    expect(secondRun?.id).not.toBe(firstRun.id);
    await finalResponse(
      value,
      connection.sessionId,
      2,
      "response-second",
      "这是第二个问题的回答。",
    );
    expect(value.runs.getRun(secondRun!.id)?.status).toBe("completed");
    expect(value.service.getActive()?.phase).toBe("listening");
    await value.service.shutdown();
    value.database.close();
  });

  it("binds a proactive bubble Voice reply to the same Chat with Chat permission", async () => {
    const value = await fixture();
    const before = value.chats.listChats({ status: "active" }).length;
    const connection = await value.service.quickStart({
      chatId: CHAT_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    expect(value.service.getActive()?.chatId).toBe(CHAT_ID);
    expect(value.chats.listChats({ status: "active" })).toHaveLength(before);

    await report(value.service, connection.sessionId, {
      protocolSessionId: "proactive-reply-session",
      type: "session.ready",
    });
    await report(value.service, connection.sessionId, {
      itemId: "proactive-user",
      transcript: "对，我在继续整理。",
      type: "transcript.user.completed",
    });
    expect(value.runs.getActiveRun(CHAT_ID)?.execution).toEqual({
      mode: "chat",
    });
    await value.service.shutdown();
    value.database.close();
  });

  it("creates a non-persistent Mika greeting only after a wake-started Realtime session is ready", async () => {
    const value = await fixture();
    const connection = await value.service.quickStart({
      origin: "voice_wake",
      requestedAt: NOW,
    });
    const chatId = value.service.getActive()?.chatId;
    if (!chatId) throw new Error("Wake Voice Chat was not created");

    expect(
      value.commands.some(({ type }) => type === "wake.greeting.create"),
    ).toBe(false);
    await report(value.service, connection.sessionId, {
      protocolSessionId: "wake-greeting-session",
      type: "session.ready",
    });

    const greeting = value.commands.find(
      (command) => command.type === "wake.greeting.create",
    );
    expect(value.service.getActive()?.phase).toBe("thinking");
    expect(greeting).toMatchObject({
      prompt: "Hi Mika",
      sessionId: connection.sessionId,
      type: "wake.greeting.create",
    });
    expect(greeting?.instructions).toContain("语气明快、有温度但不催促");
    expect(greeting?.instructions).toContain('say exactly "我在，请说。"');
    expect(greeting?.instructions).not.toContain(
      "Workspace skill instructions.",
    );
    expect(value.runs.getActiveRun(chatId)).toBeUndefined();
    expect(value.chats.listMessages(chatId)).toEqual([]);

    await report(value.service, connection.sessionId, {
      responseId: "wake-greeting-response",
      type: "wake.greeting.audio.started",
    });
    expect(value.service.getActive()?.phase).toBe("speaking");
    await report(value.service, connection.sessionId, {
      hasAudio: true,
      responseId: "wake-greeting-response",
      status: "completed",
      type: "wake.greeting.done",
    });
    await report(value.service, connection.sessionId, {
      responseId: "wake-greeting-response",
      type: "wake.greeting.audio.stopped",
    });
    expect(value.service.getActive()?.phase).toBe("listening");
    expect(value.runs.getActiveRun(chatId)).toBeUndefined();
    expect(value.chats.listMessages(chatId)).toEqual([]);
    await value.service.shutdown();
    value.database.close();
  });

  it("adds the same wake greeting after an in-place paused-session resume", async () => {
    const value = await fixture();
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    await report(value.service, connection.sessionId, {
      protocolSessionId: "wake-resume-session",
      type: "session.ready",
    });
    await value.service.setPaused({
      paused: true,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });

    await value.service.setPaused({
      origin: "voice_wake",
      paused: false,
      requestedAt: NOW,
      sessionId: connection.sessionId,
    });
    const refresh = value.commands.findLast(
      (command) => command.type === "session.refresh",
    );
    if (refresh?.type !== "session.refresh") {
      throw new Error("Session refresh command was not emitted");
    }
    expect(
      value.commands.filter(({ type }) => type === "wake.greeting.create"),
    ).toHaveLength(0);
    await report(value.service, connection.sessionId, {
      requestId: refresh.requestId,
      type: "session.refreshed",
    });

    expect(
      value.commands.filter(({ type }) => type === "wake.greeting.create"),
    ).toHaveLength(1);
    expect(value.chats.listMessages(CHAT_ID)).toEqual([]);
    expect(value.runs.getActiveRun(CHAT_ID)).toBeUndefined();
    await value.service.shutdown();
    value.database.close();
  });

  it("reuses the ordinary fallback and AI title chain for a quick Voice Chat", async () => {
    const generate = vi
      .fn<ChatTitleGenerator["generate"]>()
      .mockResolvedValue();
    const value = await fixture({ title: { generate } });
    const connection = await value.service.quickStart({ requestedAt: NOW });
    const chatId = value.service.getActive()?.chatId;
    if (!chatId) throw new Error("Quick Voice Chat was not created");
    expect(value.chats.getChat(chatId)?.title).toBe("语音对话");
    await report(value.service, connection.sessionId, {
      protocolSessionId: "quick-session",
      type: "session.ready",
    });
    expect(
      value.commands.some(({ type }) => type === "wake.greeting.create"),
    ).toBe(false);
    await report(value.service, connection.sessionId, {
      itemId: "quick-user",
      type: "speech.started",
    });
    await report(value.service, connection.sessionId, {
      itemId: "quick-user",
      transcript: "帮我安排今天",
      type: "transcript.user.completed",
    });
    expect(value.runs.getActiveRun(chatId)?.execution).toEqual({
      approvalMode: "full_access",
      mode: "agent",
    });
    expect(value.chats.getChat(chatId)?.title).toBe("帮我安排今天");
    await finalResponse(
      value,
      connection.sessionId,
      1,
      "quick-response",
      "可以，我们从最重要的事情开始。",
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      assistantContent: "可以，我们从最重要的事情开始。",
      chatId,
      firstUserContent: "帮我安排今天",
      modelId: "gpt-5.6",
      provider: value.chatRuntime.provider,
    });
    await value.service.shutdown();
    value.database.close();
  });
});

describe("Voice local tool-result measurement", () => {
  it.each([
    { modelId: "gpt-realtime-2.1", usage: undefined },
    { modelId: "gpt-realtime-2.1", usage: { input_tokens: 0 } },
    {
      modelId: "my-realtime-deployment",
      usage: {
        input_tokens: 100,
        input_token_details: { cached_tokens: 20 },
        output_tokens: 10,
      },
    },
  ])(
    "measures the actual driver submission before and after completion usage for $modelId / $usage",
    async ({ modelId, usage }) => {
      const browser = installVoiceBrowserFixture();
      const value = await fixture({ realtimeModelId: modelId });
      const entered = held<void>();
      const completed = held<void>();
      const release = held<void>();
      const observations: ToolResultContextMeasurement[] = [];
      const result: ToolResult = {
        artifacts: [],
        modelContent: { forecast: "weather detail ".repeat(700) },
        retryable: false,
        status: "success",
        summary: "Weather detail",
        evidenceHash: "0".repeat(64),
      };
      value.read.mockImplementation(
        async (_input: unknown, context: ToolExecutionContext) => {
          const measure = context.measureResult;
          if (!measure) {
            entered.resolve();
            throw new Error("Missing result owner");
          }
          try {
            observations.push(await measure(result));
          } finally {
            entered.resolve();
          }
          await release.promise;
          observations.push(await measure(result));
          return result;
        },
      );
      let driver: WebRtcVoiceDriver | undefined;
      try {
        const { connection, run } = await startTurn(
          value,
          { mode: "chat" },
          "Read the detailed weather report.",
        );
        const api = {
          cancelStart: vi.fn(),
          end: vi.fn(),
          getActive: vi.fn(),
          preview: vi.fn(),
          quickStart: vi.fn(),
          setMuted: vi.fn(),
          setPaused: vi.fn(),
          start: vi.fn(),
          subscribeChanged: vi.fn(),
          subscribeCommand: vi.fn(),
          report: async (request) => {
            const snapshot = await value.service.report(request);
            if (request.event.type === "response.done") completed.resolve();
            return { ok: true as const, value: snapshot };
          },
        } satisfies VoiceApi;
        driver = new WebRtcVoiceDriver(api, connection, vi.fn());
        await driver.connect({
          durationMs: 0,
          stream: browser.stream as unknown as MediaStream,
        });
        const channel = FakePeerConnection.latest!.channel;
        const initial = value.commands.find(
          (command) => command.type === "response.create",
        );
        if (!initial || initial.type !== "response.create") {
          throw new Error("Missing actual initial response command");
        }
        driver.handle(initial);
        const estimate = vi.spyOn(inputBudget, "estimateInputBudget");
        const textCount = vi.spyOn(value.chatProvider, "measureInput");
        channel.emit({
          type: "response.created",
          response: {
            id: "measured-response",
            metadata: {
              charamate_generation: String(initial.generation),
              charamate_request_id: initial.requestId,
            },
          },
        });
        channel.emit({
          type: "response.function_call_arguments.done",
          arguments: '{"city":"Shanghai"}',
          call_id: "measured-call",
          item_id: "measured-item",
          name: "weather_lookup",
          response_id: "measured-response",
        });
        await entered.promise;
        expect(observations).toHaveLength(1);
        expect(
          value.commands.some((command) => command.type === "tool.result"),
        ).toBe(false);
        channel.emit({
          type: "response.done",
          response: {
            id: "measured-response",
            status: "completed",
            ...(usage === undefined ? {} : { usage }),
          },
        });
        await completed.promise;
        release.resolve();
        await value.waitForCommand(
          (command) =>
            command.type === "tool.result" &&
            command.callId === "measured-call",
        );
        const command = value.commands.find(
          (command) =>
            command.type === "tool.result" &&
            command.callId === "measured-call",
        );
        if (!command || command.type !== "tool.result") {
          throw new Error("Missing actual tool result command");
        }
        const item = value.runs
          .listRunItems(run.id)
          .find((item) => item.kind === "tool_call");
        expect(item?.status).toBe("completed");
        expect(item?.output).toEqual({
          ...result,
          evidenceHash: toolEvidenceHash(result.modelContent),
        });
        expect(command.output).toBe(JSON.stringify(item?.output));
        const expectedPayload = {
          events: voiceToolResultEvents(command),
          effectiveTools: value.issue.mock.calls[0]?.[1].tools,
        };
        expect(expectedPayload.effectiveTools?.length).toBeGreaterThan(0);
        expect(estimate).toHaveBeenCalledTimes(3);
        for (const [payload] of estimate.mock.calls) {
          expect(payload).toEqual(expectedPayload);
        }
        expect(observations).toHaveLength(2);
        expect(observations[1]).toEqual(observations[0]);
        expect(observations[0]).toMatchObject({
          kind: "realtime_submission",
          conversationOccupancy: "unknown",
          capacityBasis:
            modelId === "gpt-realtime-2.1"
              ? "configured_name_rule"
              : "user_limit_only",
          inputBudgetTokens: inputBudget.modelInputBudget(
            modelId === "gpt-realtime-2.1"
              ? { maxContextTokens: 128_000, maxOutputTokens: 32_000 }
              : {},
          ),
        });
        expect(observations[0]?.measurement.estimatedTokens).toBeGreaterThan(
          8192,
        );
        expect(observations[0]?.measurement).not.toHaveProperty(
          "exactInputTokens",
        );
        expect(textCount).not.toHaveBeenCalled();
        expect(value.chatProvider.stream).not.toHaveBeenCalled();
        expect(value.read).toHaveBeenCalledOnce();
        driver.handle(command);
        expect(channel.sent.slice(-2)).toEqual(
          expectedPayload.events.map((event) => JSON.stringify(event)),
        );
      } finally {
        release.resolve();
        driver?.close();
        await value.service.shutdown();
        value.database.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["end", "speech", "pause"] as const)(
    "rejects a late allocation after %s and never publishes the old tool output",
    async (boundary) => {
      const value = await fixture();
      const entered = held<ToolExecutionContext>();
      const release = held<void>();
      const late = held<unknown>();
      let firstMeasured = false;
      const result: ToolResult = {
        artifacts: [],
        modelContent: { forecast: "sunny" },
        retryable: false,
        status: "success",
        summary: "Sunny",
      };
      value.read.mockImplementation(
        async (_input: unknown, context: ToolExecutionContext) => {
          const measure = context.measureResult;
          if (!measure) {
            entered.resolve(context);
            throw new Error("Missing result owner");
          }
          try {
            await measure(result);
            firstMeasured = true;
          } finally {
            entered.resolve(context);
          }
          await release.promise;
          try {
            await measure(result);
            late.resolve(undefined);
          } catch (error) {
            late.resolve(error);
          }
          return result;
        },
      );
      let ending: Promise<null> | undefined;
      try {
        const { connection, run } = await startTurn(
          value,
          { mode: "chat" },
          "Weather?",
        );
        await report(value.service, connection.sessionId, {
          type: "response.started",
          responseId: "cancelled-measurement",
          generation: 1,
        });
        const call: Extract<VoiceDriverEvent, { type: "tool.call" }> = {
          type: "tool.call",
          responseId: "cancelled-measurement",
          callId: "allocation-call",
          itemId: "allocation-item",
          generation: 1,
          name: "weather_lookup",
          arguments: '{"city":"Shanghai"}',
        };
        await report(value.service, connection.sessionId, call);
        const context = await entered.promise;
        expect(context.measureResult).toBeTypeOf("function");
        expect(firstMeasured).toBe(true);
        expect(value.runs.getRunItem(context.itemId)?.status).toBe("running");
        let endSettled = false;
        if (boundary === "end") {
          ending = value.service
            .end({ sessionId: connection.sessionId })
            .then((result) => {
              endSettled = true;
              return result;
            });
        } else if (boundary === "pause") {
          await value.service.setPaused({
            sessionId: connection.sessionId,
            paused: true,
            requestedAt: NOW,
          });
        } else {
          await report(value.service, connection.sessionId, {
            type: "speech.started",
            itemId: "new-user-input",
          });
        }
        expect(context.signal.aborted).toBe(true);
        // Drain already-runnable callbacks, without releasing the actual Tool.
        // End must still be joining that owner's held work on the next turn.
        if (ending) await setImmediate();
        expect(endSettled).toBe(false);
        release.resolve();
        expect(await late.promise).toMatchObject({ name: "AbortError" });
        if (ending) await ending;
        expect(
          value.commands.filter((command) => command.type === "tool.result"),
        ).toEqual([]);
        expect(value.runs.getRun(run.id)?.status).toBe(
          boundary === "end" ? "cancelled" : "interrupted",
        );
        expect(value.runs.getRunItem(context.itemId)?.status).toBe(
          boundary === "end" ? "cancelled" : "interrupted",
        );
        if (boundary === "speech") {
          value.read.mockResolvedValue(result);
          await report(value.service, connection.sessionId, {
            type: "transcript.user.completed",
            itemId: "new-user-input",
            transcript: "Use the new question.",
          });
          await report(value.service, connection.sessionId, {
            type: "response.started",
            responseId: "new-measurement",
            generation: 2,
          });
          await report(value.service, connection.sessionId, {
            ...call,
            responseId: "new-measurement",
            generation: 2,
          });
          await value.waitForCommand(
            (command) =>
              command.type === "tool.result" && command.generation === 2,
          );
          expect(
            value.commands.filter((command) => command.type === "tool.result"),
          ).toEqual([
            expect.objectContaining({ callId: call.callId, generation: 2 }),
          ]);
        }
      } finally {
        release.resolve();
        if (ending) await ending;
        await value.service.shutdown();
        value.database.close();
      }
    },
  );
});

describe("Voice function call identity", () => {
  const call = (
    overrides: Partial<Extract<VoiceDriverEvent, { type: "tool.call" }>> = {},
  ) => ({
    arguments: '{"city":"上海"}',
    callId: "same-call",
    generation: 1,
    itemId: "same-function-item",
    name: "weather_lookup",
    responseId: "same-response",
    type: "tool.call" as const,
    ...overrides,
  });
  const results = (value: Awaited<ReturnType<typeof fixture>>) =>
    value.commands.filter((command) => command.type === "tool.result");

  it("does not repeat a real file effect or emit another result during execution or after completion", async () => {
    const value = await fixture();
    const file = path.join(value.directory, "actual-effects.txt");
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.write.mockImplementation(async () => {
      await appendFile(file, "saved once\n");
      entered();
      await pending;
      return {
        artifacts: [],
        modelContent: { saved: true },
        retryable: false,
        status: "success",
        summary: "已经保存",
      };
    });
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "保存便签",
    );
    const event = call({ name: "note_save", arguments: '{"text":"买牛奶"}' });
    await report(value.service, connection.sessionId, {
      type: "response.started",
      responseId: event.responseId,
      generation: 1,
    });
    await report(value.service, connection.sessionId, event);
    const approval = value.runs.getLatestPendingApproval()!;
    value.service.resolveApproval({
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "approved",
    });
    await began;
    await report(value.service, connection.sessionId, event);
    release();
    await vi.waitFor(() =>
      expect(
        value.runs
          .listRunItems(run.id)
          .some(
            (item) => item.kind === "tool_call" && item.status === "completed",
          ),
      ).toBe(true),
    );
    await report(value.service, connection.sessionId, event);
    expect(value.write).toHaveBeenCalledOnce();
    expect(await readFile(file, "utf8")).toBe("saved once\n");
    expect(
      value.runs
        .listRunItems(run.id)
        .filter((item) => item.kind === "tool_call"),
    ).toHaveLength(1);
    expect(
      value.runs
        .listRunItems(run.id)
        .filter((item) => item.kind === "approval"),
    ).toHaveLength(1);
    expect(results(value)).toHaveLength(1);
    await value.service.shutdown();
    value.database.close();
  });

  it("keeps a failed call failed when repeated and accepts a different explicit call", async () => {
    const value = await fixture();
    value.read.mockRejectedValueOnce(new Error("ordinary unavailable source"));
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "看看天气",
    );
    const event = call();
    await report(value.service, connection.sessionId, {
      type: "response.started",
      responseId: event.responseId,
      generation: 1,
    });
    await report(value.service, connection.sessionId, event);
    await vi.waitFor(() => expect(results(value)).toHaveLength(1));
    await report(value.service, connection.sessionId, event);
    expect(value.read).toHaveBeenCalledOnce();
    expect(results(value)).toHaveLength(1);
    expect(
      value.runs
        .listRunItems(run.id)
        .filter((item) => item.kind === "tool_call")
        .map((item) => item.status),
    ).toEqual(["failed"]);
    await report(
      value.service,
      connection.sessionId,
      call({ callId: "new-explicit-call", itemId: "new-function-item" }),
    );
    await vi.waitFor(() => expect(results(value)).toHaveLength(2));
    expect(value.read).toHaveBeenCalledTimes(2);
    expect(
      value.runs
        .listRunItems(run.id)
        .filter((item) => item.kind === "tool_call")
        .map((item) => item.status),
    ).toEqual(["failed", "completed"]);
    await value.service.shutdown();
    value.database.close();
  });

  it("does not create a second approval or reverse a rejection for the same call", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "保存便签",
    );
    const event = call({ name: "note_save", arguments: '{"text":"买牛奶"}' });
    await report(value.service, connection.sessionId, {
      type: "response.started",
      responseId: event.responseId,
      generation: 1,
    });
    await report(value.service, connection.sessionId, event);
    const approval = value.runs.getLatestPendingApproval()!;
    await report(value.service, connection.sessionId, event);
    expect(results(value)).toHaveLength(0);
    expect(value.runs.getLatestPendingApproval()?.id).toBe(approval.id);
    value.service.resolveApproval({
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "rejected",
    });
    await vi.waitFor(() => expect(results(value)).toHaveLength(1));
    await report(value.service, connection.sessionId, event);
    expect(value.write).not.toHaveBeenCalled();
    expect(results(value)).toHaveLength(1);
    expect(value.runs.getLatestPendingApproval()).toBeUndefined();
    expect(
      value.runs
        .listRunItems(run.id)
        .filter((item) => item.kind === "approval"),
    ).toHaveLength(1);
    await value.service.shutdown();
    value.database.close();
  });

  it("accepts a valid generation after a late call and scopes the identity to its actual Run", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "看看天气",
    );
    const event = call();
    await report(value.service, connection.sessionId, {
      type: "response.started",
      responseId: event.responseId,
      generation: 1,
    });
    await report(value.service, connection.sessionId, call({ generation: 2 }));
    expect(value.read).not.toHaveBeenCalled();
    await report(value.service, connection.sessionId, event);
    await vi.waitFor(() => expect(results(value)).toHaveLength(1));
    await report(value.service, connection.sessionId, {
      type: "speech.started",
      itemId: "next-user",
    });
    await report(value.service, connection.sessionId, event);
    expect(value.read).toHaveBeenCalledOnce();
    await report(value.service, connection.sessionId, {
      type: "transcript.user.completed",
      itemId: "next-user",
      transcript: "再看看另一个城市",
    });
    const second = value.runs.getActiveRun(CHAT_ID)!;
    expect(second.id).not.toBe(run.id);
    const generation = value.service.getActive()!.generation;
    await report(value.service, connection.sessionId, {
      type: "response.started",
      responseId: "next-response",
      generation,
    });
    await report(
      value.service,
      connection.sessionId,
      call({ responseId: "next-response", generation }),
    );
    await vi.waitFor(() => expect(value.read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(results(value)).toHaveLength(2));
    expect(
      value.runs
        .listRunItems(second.id)
        .filter((item) => item.kind === "tool_call"),
    ).toHaveLength(1);
    await value.service.shutdown();
    value.database.close();
  });

  it("deduplicates a plan Item while preserving its original unwrapped input", async () => {
    const value = await fixture();
    const execute = vi.fn().mockResolvedValue({
      artifacts: [],
      modelContent: { recorded: true },
      retryable: false,
      status: "success",
      summary: "计划已保存",
    });
    value.tools.register({
      descriptor: {
        description: "记录计划",
        effect: "read",
        idempotency: "idempotent",
        inputSchema: {
          additionalProperties: false,
          properties: { title: { type: "string" } },
          required: ["title"],
          type: "object",
        },
        itemKind: "plan",
        name: "replay.plan",
        namespace: "replay",
        source: "builtin",
        summary: "记录计划",
      },
      execute,
      summarize: () => "记录计划",
    });
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "先列一个计划",
    );
    const event = call({
      name: "replay_plan",
      arguments: '{"title":"整理书桌"}',
    });
    await report(value.service, connection.sessionId, {
      type: "response.started",
      responseId: event.responseId,
      generation: 1,
    });
    await report(value.service, connection.sessionId, event);
    await vi.waitFor(() => expect(results(value)).toHaveLength(1));
    await report(value.service, connection.sessionId, event);
    expect(execute).toHaveBeenCalledOnce();
    expect(
      value.runs.listRunItems(run.id).filter((item) => item.kind === "plan"),
    ).toEqual([
      expect.objectContaining({
        input: { title: "整理书桌" },
        status: "completed",
      }),
    ]);
    expect(results(value)).toHaveLength(1);
    await value.service.shutdown();
    value.database.close();
  });
});

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const startRequest = {
  chatId: CHAT_ID,
  chatProviderProfileId: PROFILE_ID,
  execution: { mode: "chat" as const },
  requestedAt: NOW,
};
const emptyPreparedContext: CognitionPreparedContext = {
  text: "",
  situationIds: [],
  intentIds: [],
  evidenceIds: [],
};

describe("Voice preparation ownership", () => {
  it("reserves startup synchronously across start, quick start and preview and joins an unabortable secret on shutdown", async () => {
    const value = await fixture();
    const runtime =
      await value.providers.createRealtimeProviderRuntime(PROFILE_ID);
    const entered = held<void>();
    const release = held<void>();
    vi.spyOn(
      value.providers,
      "createRealtimeProviderRuntime",
    ).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return runtime;
    });
    const starting = value.service.start(startRequest);
    const outcome = starting.catch((error: unknown) => error);
    expect(() => value.service.quickStart({ requestedAt: NOW })).toThrow(
      "正在准备",
    );
    expect(() =>
      value.service.preview({
        providerProfileId: PROFILE_ID,
        instructions: "试听",
        voice: "verse",
      }),
    ).toThrow("正在准备");
    await entered.promise;
    let stopped = false;
    const stopping = value.service.shutdown().then(() => {
      stopped = true;
    });
    expect(value.service.shutdown()).toBe(value.service.shutdown());
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(value.repository.listActiveSessions()).toEqual([]);
    release.resolve();
    await stopping;
    await outcome;
    expect(value.issue).not.toHaveBeenCalled();
    expect(value.service.getActive()).toBeNull();
    expect(() => value.service.start(startRequest)).toThrow("退出");
    value.database.close();
  });

  it("still joins reconnect preparation before reporting a shutdown persistence error", async () => {
    const value = await fixture();
    const first = await value.service.start(startRequest);
    await report(value.service, first.sessionId, {
      type: "connection.closed",
      reason: "fixture disconnect",
    });
    const entered = held<AbortSignal>();
    const release = held<void>();
    value.issue.mockImplementationOnce(async (_runtime, _options, signal) => {
      entered.resolve(signal);
      await release.promise;
      return {
        callsUrl: first.callsUrl,
        clientSecret: first.clientSecret,
        expiresAt: first.expiresAt,
      };
    });
    const starting = value.service
      .start(startRequest)
      .catch((error: unknown) => error);
    const signal = await entered.promise;
    const failure = new Error("fixture session persistence failed");
    const update = vi
      .spyOn(value.repository, "updateSession")
      .mockImplementationOnce(() => {
        throw failure;
      });
    let settled = false;
    const stopping = value.service.shutdown().catch((error: unknown) => {
      settled = true;
      return error;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await stopping).toBe(failure);
    await starting;
    expect(update).toHaveBeenCalledOnce();
    expect(value.repository.getSession(first.sessionId)?.status).toBe(
      "interrupted",
    );
    update.mockRestore();
    value.database.close();
  });

  it.each(["metadata", "count", "summary"] as const)(
    "owns text %s during conservative Realtime replay preparation",
    async (stage) => {
      const value = await fixture();
      insertCompletedVoiceHistory(
        value,
        Array.from({ length: 4 }, () => "回顾".repeat(5_000)),
      );
      const entered = held<AbortSignal>();
      const release = held<void>();
      value.chatProvider.measureInput = async (request, signal) => {
        if (stage === "count") {
          entered.resolve(signal);
          await release.promise;
        }
        return {
          ...value.chatProvider.estimateInput(request),
          exactInputTokens: 100,
        };
      };
      if (stage === "metadata")
        value.chatProvider.resolveContextLimits.mockImplementationOnce(
          async (_model: string, signal: AbortSignal) => {
            entered.resolve(signal);
            await release.promise;
            return {};
          },
        );
      value.chatProvider.stream.mockImplementation(async function* (
        _request: ModelRequest,
        signal: AbortSignal,
      ): AsyncIterable<ModelEvent> {
        if (stage === "summary") {
          entered.resolve(signal);
          await release.promise;
        }
        yield { type: "text.delta", delta: "过往语音摘要" };
        yield {
          type: "response.completed",
          responseId: "summary",
          status: "completed",
          usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
        };
      });
      const requestId = "90000000-0000-4000-8000-000000000001";
      const result = value.service
        .start(startRequest, { requestId })
        .catch((error: unknown) => error);
      const signal = await entered.promise;
      let cancelled = false;
      const cancel = value.service.cancelStart({ requestId }).then(() => {
        cancelled = true;
      });
      expect(signal.aborted).toBe(true);
      await Promise.resolve();
      expect(cancelled).toBe(false);
      release.resolve();
      await cancel;
      await result;
      expect(value.chats.getContextSnapshot(CHAT_ID)).toBeUndefined();
      expect(value.issue).not.toHaveBeenCalled();
      expect(value.repository.listActiveSessions()).toEqual([]);
      await value.service.shutdown();
      value.database.close();
    },
  );

  it("joins a late issuer without activating a cancelled request and permits a fresh request afterwards", async () => {
    const value = await fixture();
    const issued = {
      callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
      clientSecret: "fixture",
      expiresAt: "2026-08-09T12:01:00.000Z",
    };
    const entered = held<AbortSignal>();
    const release = held<void>();
    value.issue.mockImplementationOnce(async (_runtime, _options, signal) => {
      entered.resolve(signal);
      await release.promise;
      return issued;
    });
    const requestId = "90000000-0000-4000-8000-000000000002";
    const result = value.service
      .start(startRequest, { requestId })
      .catch((error: unknown) => error);
    const signal = await entered.promise;
    let cancelled = false;
    const cancel = value.service.cancelStart({ requestId }).then(() => {
      cancelled = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(cancelled).toBe(false);
    release.resolve();
    await result;
    await cancel;
    expect(value.repository.listActiveSessions()).toEqual([]);
    const next = await value.service.start(startRequest, {
      requestId: "90000000-0000-4000-8000-000000000003",
    });
    expect(await value.service.cancelStart({ requestId })).toEqual({
      outcome: "not_pending",
    });
    expect(value.service.getActive()?.sessionId).toBe(next.sessionId);
    await value.service.shutdown();
    value.database.close();
  });

  it("retains only the issued preview reservation until that exact submission ends", async () => {
    const value = await fixture();
    const requestId = "90000000-0000-4000-8000-000000000005";
    await value.service.preview(
      { providerProfileId: PROFILE_ID, instructions: "试听", voice: "verse" },
      { requestId },
    );
    expect(value.service.hasPendingConnection()).toBe(true);
    expect(value.service.getActive()).toBeNull();
    expect(() => value.service.start(startRequest)).toThrow("正在准备");
    expect(await value.service.cancelStart({ requestId })).toEqual({
      outcome: "accepted",
    });
    expect(value.service.hasPendingConnection()).toBe(false);
    const next = await value.service.start(startRequest);
    expect(await value.service.cancelStart({ requestId })).toEqual({
      outcome: "not_pending",
    });
    expect(value.service.getActive()?.sessionId).toBe(next.sessionId);
    await value.service.shutdown();
    value.database.close();
  });

  it.each([true, false])(
    "cancels the exact resume handoff before Renderer consumes the result (reuse=%s)",
    async (supportsSessionRefresh) => {
      const value = await fixture({ supportsSessionRefresh });
      const first = await value.service.start(startRequest);
      await report(value.service, first.sessionId, {
        type: "session.ready",
        protocolSessionId: "first",
      });
      await value.service.setPaused({
        sessionId: first.sessionId,
        paused: true,
        requestedAt: NOW,
      });
      const requestId = "90000000-0000-4000-8000-000000000004";
      const preparedForRenderer = await value.service.setPaused(
        { sessionId: first.sessionId, paused: false, requestedAt: NOW },
        { requestId },
      );
      const target =
        preparedForRenderer.connection?.sessionId ?? first.sessionId;
      expect(target === first.sessionId).toBe(supportsSessionRefresh);
      expect(await value.service.cancelStart({ requestId })).toEqual({
        outcome: "accepted",
      });
      expect(value.service.getActive()).toBeNull();
      expect(value.repository.getSession(target)?.status).toBe("completed");
      const next = await value.service.start(startRequest);
      expect(await value.service.cancelStart({ requestId })).toEqual({
        outcome: "not_pending",
      });
      expect(value.service.getActive()?.sessionId).toBe(next.sessionId);
      await value.service.shutdown();
      value.database.close();
    },
  );

  it("joins reconnect work on End without resurrecting the interrupted session", async () => {
    const value = await fixture();
    const first = await value.service.start(startRequest);
    await report(value.service, first.sessionId, {
      type: "connection.closed",
      reason: "fixture disconnect",
    });
    const entered = held<AbortSignal>();
    const release = held<void>();
    value.issue.mockImplementationOnce(async (_runtime, _options, signal) => {
      entered.resolve(signal);
      await release.promise;
      return {
        callsUrl: first.callsUrl,
        clientSecret: first.clientSecret,
        expiresAt: first.expiresAt,
      };
    });
    const result = value.service
      .start(startRequest)
      .catch((error: unknown) => error);
    const signal = await entered.promise;
    const ending = value.service.end({ sessionId: first.sessionId });
    expect(signal.aborted).toBe(true);
    release.resolve();
    await ending;
    await result;
    expect(value.repository.getSession(first.sessionId)?.status).toBe(
      "completed",
    );
    expect(value.service.getActive()).toBeNull();
    await value.service.shutdown();
    value.database.close();
  });

  it("joins an executing approved tool before End and never replays the action", async () => {
    const value = await fixture();
    const entered = held<AbortSignal>();
    const release = held<void>();
    value.write.mockImplementation(
      async (_input: unknown, context: ToolExecutionContext) => {
        entered.resolve(context.signal);
        await release.promise;
        return {
          artifacts: [],
          modelContent: { cancelled: true },
          retryable: false,
          status: "cancelled",
          summary: "取消",
        };
      },
    );
    const { connection, run } = await startTurn(
      value,
      { mode: "agent", approvalMode: "request_approval" },
      "保存便签",
    );
    await report(value.service, connection.sessionId, {
      type: "response.started",
      generation: 1,
      responseId: "tool-response",
    });
    const call = {
      type: "tool.call" as const,
      name: "note_save",
      arguments: '{"text":"便签"}',
      callId: "save-once",
      itemId: "save-function",
      responseId: "tool-response",
      generation: 1,
    };
    await report(value.service, connection.sessionId, call);
    const approval = value.runs.getLatestPendingApproval();
    if (!approval) throw new Error("Missing actual approval");
    value.service.resolveApproval({
      approvalId: approval.id,
      decision: "approved",
      decidedAt: NOW,
    });
    const signal = await entered.promise;
    let ended = false;
    const ending = value.service
      .end({ sessionId: connection.sessionId })
      .then(() => {
        ended = true;
      });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(ended).toBe(false);
    release.resolve();
    await ending;
    expect(value.runs.getRun(run.id)?.status).toBe("cancelled");
    expect(value.write).toHaveBeenCalledOnce();
    await value.service.shutdown();
    value.database.close();
  });

  it("joins optional title work on shutdown while ordinary End remains independent", async () => {
    const entered = held<AbortSignal>();
    const release = held<void>();
    const title: ChatTitleGenerator = {
      generate: async ({ signal }) => {
        entered.resolve(signal);
        await release.promise;
      },
    };
    const value = await fixture({ title });
    const { connection } = await startTurn(value, { mode: "chat" }, "你好");
    await finalResponse(
      value,
      connection.sessionId,
      1,
      "title-response",
      "你好",
    );
    const signal = await entered.promise;
    await value.service.end({ sessionId: connection.sessionId });
    expect(signal.aborted).toBe(false);
    let stopped = false;
    const stopping = value.service.shutdown().then(() => {
      stopped = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    value.database.close();
  });

  it("allows actual WebRTC reportTail to interrupt held transcript preparation before any stale Run is allocated", async () => {
    const browser = installVoiceBrowserFixture();
    const value = await fixture();
    const connection = await value.service.start(startRequest);
    const prepared = held<CognitionPreparedContext>();
    const entered = held<AbortSignal>();
    value.prepareTurn.mockImplementationOnce(({ signal }) => {
      entered.resolve(signal);
      return prepared.promise;
    });
    const ready = held<void>();
    const secondSpeech = held<void>();
    const api = {
      cancelStart: vi.fn(),
      end: vi.fn(),
      getActive: vi.fn(),
      preview: vi.fn(),
      quickStart: vi.fn(),
      setMuted: vi.fn(),
      setPaused: vi.fn(),
      start: vi.fn(),
      subscribeChanged: vi.fn(),
      subscribeCommand: vi.fn(),
      report: async (request) => {
        const snapshot = await value.service.report(request);
        if (request.event.type === "session.ready") ready.resolve();
        if (
          request.event.type === "speech.started" &&
          request.event.itemId === "second-input"
        )
          secondSpeech.resolve();
        return { ok: true as const, value: snapshot };
      },
    } satisfies VoiceApi;
    const driver = new WebRtcVoiceDriver(api, connection, vi.fn());
    try {
      await driver.connect({
        durationMs: 0,
        stream: browser.stream as unknown as MediaStream,
      });
      const channel = FakePeerConnection.latest!.channel;
      channel.emit({
        type: "session.created",
        session: { id: "real-driver-session" },
      });
      await ready.promise;
      channel.emit({
        type: "input_audio_buffer.speech_started",
        item_id: "first-input",
      });
      channel.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "first-input",
        transcript: "第一句",
      });
      const signal = await entered.promise;
      channel.emit({
        type: "input_audio_buffer.speech_started",
        item_id: "second-input",
      });
      await secondSpeech.promise;
      expect(signal.aborted).toBe(true);
      expect(value.runs.getActiveRun(CHAT_ID)).toBeUndefined();
      expect(value.chats.listMessages(CHAT_ID)).toEqual([]);
      prepared.resolve({
        ...emptyPreparedContext,
        text: "过时材料".repeat(40_000),
      });
      channel.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "second-input",
        transcript: "第二句",
      });
      await value.waitForCommand(
        (command) =>
          command.type === "response.create" && command.generation === 2,
      );
      expect(
        value.commands
          .filter((command) => command.type === "response.create")
          .map((command) => command.generation),
      ).toEqual([2]);
      expect(
        value.chats.listMessages(CHAT_ID).map((message) => message.content),
      ).toEqual(["第二句"]);
    } finally {
      prepared.resolve(emptyPreparedContext);
      driver.close();
      await value.service.shutdown();
      value.database.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      FakePeerConnection.latest = undefined;
    }
  });
});

describe("Voice known local response budget", () => {
  it.each(["gpt-realtime-2.1", "my-voice-deployment"])(
    "allocates the remaining actual response shell for %s and rechecks each transcript",
    async (modelId) => {
      const value = await fixture({ realtimeModelId: modelId });
      const estimate = vi.spyOn(inputBudget, "estimateInputBudget");
      try {
        const context = "完整当前条件和相反来源".repeat(
          modelId === "gpt-realtime-2.1" ? 650 : 6000,
        );
        value.setPreparedContext({ ...emptyPreparedContext, text: context });
        const { connection } = await startTurn(
          value,
          { mode: "chat" },
          "请接着刚才的话题",
        );
        const first = value.commands.findLast(
          (command) => command.type === "response.create",
        );
        if (!first || first.type !== "response.create")
          throw new Error("No response");
        const tools = value.issue.mock.calls[0]?.[1].tools ?? [];
        const finalPayload = {
          events: [voiceResponseCreateEvent(first)],
          effectiveTools: tools,
        };
        expect(estimate).toHaveBeenCalledWith(finalPayload);
        expect(first.instructions).toContain(context);
        expect(Buffer.byteLength(context)).toBeGreaterThan(8192);
        const budget = modelId === "gpt-realtime-2.1" ? 96_000 : 258_000;
        const firstRead = value.prepareTurn.mock.calls[0]?.[0];
        expect(firstRead?.contextBudget.maxTokens).toBeGreaterThan(8192);
        expect(firstRead?.contextBudget.maxTokens).toBeLessThan(
          Math.floor(budget * 0.9),
        );
        const shellPayload = estimate.mock.calls
          .map(([payload]) => payload)
          .find((payload) => {
            const event = (
              payload as {
                events?: Array<{
                  event_id?: string;
                  response?: { instructions?: string };
                }>;
              }
            )?.events?.[0];
            return (
              event?.event_id === first.requestId &&
              event.response?.instructions &&
              !event.response.instructions.includes(context)
            );
          });
        expect(shellPayload).toBeDefined();
        expect(firstRead?.contextBudget.maxTokens).toBe(
          Math.floor(budget * 0.9) -
            estimateInputBudget(shellPayload).estimatedTokens,
        );
        expect(
          inputBudget.fitsInputBudget(
            estimateInputBudget(finalPayload),
            budget,
          ),
        ).toBe(true);
        expect(estimateInputBudget(finalPayload)).not.toHaveProperty(
          "exactInputTokens",
        );
        await finalResponse(
          value,
          connection.sessionId,
          1,
          "first-known",
          "记住当前条件了。",
        );
        value.setPreparedContext({
          ...emptyPreparedContext,
          text: "新一轮已经撤销原约定。",
        });
        await report(value.service, connection.sessionId, {
          type: "speech.started",
          itemId: "later-input",
          audioEndMs: 0,
        });
        await report(value.service, connection.sessionId, {
          type: "transcript.user.completed",
          itemId: "later-input",
          transcript: "我改主意了",
        });
        const second = value.commands.findLast(
          (command) => command.type === "response.create",
        );
        if (!second || second.type !== "response.create")
          throw new Error("No second response");
        expect(second.requestId).not.toBe(first.requestId);
        expect(second.generation).toBe(2);
        expect(second.instructions).toContain("新一轮已经撤销原约定。");
        expect(second.instructions).not.toContain(context);
        expect(estimate).toHaveBeenCalledWith({
          events: [voiceResponseCreateEvent(second)],
          effectiveTools: tools,
        });
        expect(value.prepareTurn).toHaveBeenCalledTimes(2);
        expect(value.createChatModelRuntime).not.toHaveBeenCalled();
      } finally {
        await value.service.shutdown();
        value.database.close();
        vi.restoreAllMocks();
      }
    },
  );

  it("rejects the final prepared material without clipping or a smaller reread, then permits the next turn", async () => {
    const value = await fixture();
    try {
      const connection = await value.service.start(startRequest);
      await report(value.service, connection.sessionId, {
        type: "session.ready",
        protocolSessionId: "budget-final",
      });
      value.prepareTurn.mockImplementationOnce(({ contextBudget }) =>
        Promise.resolve({
          ...emptyPreparedContext,
          text: "x".repeat(contextBudget.maxTokens),
        }),
      );
      await report(value.service, connection.sessionId, {
        type: "speech.started",
        itemId: "oversized-turn",
        audioEndMs: 0,
      });
      await value.service.report({
        sessionId: connection.sessionId,
        occurredAt: NOW,
        event: {
          type: "transcript.user.completed",
          itemId: "oversized-turn",
          transcript: "保留所有必要内容",
        },
      });
      await vi.waitFor(() =>
        expect(value.service.getActive()?.error?.code).toBe(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
        ),
      );
      expect(value.prepareTurn).toHaveBeenCalledOnce();
      expect(
        value.commands.filter(({ type }) => type === "response.create"),
      ).toEqual([]);
      expect(value.chats.listMessages(CHAT_ID)).toEqual([]);
      expect(value.runs.getActiveRun(CHAT_ID)).toBeUndefined();
      value.setPreparedContext({
        ...emptyPreparedContext,
        text: "已经明确缩小后的新事项。",
      });
      await report(value.service, connection.sessionId, {
        type: "speech.started",
        itemId: "valid-turn",
        audioEndMs: 0,
      });
      await report(value.service, connection.sessionId, {
        type: "transcript.user.completed",
        itemId: "valid-turn",
        transcript: "改为这个新事项",
      });
      const command = value.commands.findLast(
        ({ type }) => type === "response.create",
      );
      expect(command).toMatchObject({ type: "response.create", generation: 2 });
      expect(
        value.chats.listMessages(CHAT_ID).map(({ content }) => content),
      ).toEqual(["改为这个新事项"]);
    } finally {
      await value.service.shutdown();
      value.database.close();
    }
  });

  it("joins a prepared turn waiting on the actual Chat owner after End without publishing", async () => {
    const value = await fixture();
    const entered = held<void>();
    const release = held<void>();
    let blocker: Promise<void> | undefined;
    try {
      const connection = await value.service.start(startRequest);
      await report(value.service, connection.sessionId, {
        type: "session.ready",
        protocolSessionId: "serial-budget",
      });
      blocker = value.chatTurns.runSerializedTurn(CHAT_ID, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      value.setPreparedContext({
        ...emptyPreparedContext,
        text: "完整可用上下文".repeat(1000),
      });
      await report(value.service, connection.sessionId, {
        type: "speech.started",
        itemId: "serial-input",
        audioEndMs: 0,
      });
      await value.service.report({
        sessionId: connection.sessionId,
        occurredAt: NOW,
        event: {
          type: "transcript.user.completed",
          itemId: "serial-input",
          transcript: "这句不要继续",
        },
      });
      await vi.waitFor(() =>
        expect(value.service.getActive()?.phase).toBe("thinking"),
      );
      const signal = value.prepareTurn.mock.calls[0]?.[0].signal;
      let ended = false;
      const ending = value.service
        .end({ sessionId: connection.sessionId })
        .then(() => {
          ended = true;
        });
      expect(signal?.aborted).toBe(true);
      await Promise.resolve();
      expect(ended).toBe(false);
      release.resolve();
      await blocker;
      await ending;
      expect(
        value.commands.filter(({ type }) => type === "response.create"),
      ).toEqual([]);
      expect(value.chats.listMessages(CHAT_ID)).toEqual([]);
      expect(value.runs.getActiveRun(CHAT_ID)).toBeUndefined();
    } finally {
      release.resolve();
      await blocker;
      await value.service.shutdown();
      value.database.close();
    }
  });

  it("checks the full preview session and fixed input before issuing credentials", async () => {
    const value = await fixture();
    const estimate = vi.spyOn(inputBudget, "estimateInputBudget");
    try {
      const request = {
        instructions: "自然说话",
        providerProfileId: PROFILE_ID,
        voice: "verse" as const,
      };
      await value.service.preview(request, { requestId: "preview-budget" });
      expect(estimate).toHaveBeenCalledWith({
        ...realtimeSessionRequest("gpt-realtime-2.1", request),
        events: voicePreviewEvents(),
      });
      expect(value.issue).toHaveBeenCalledOnce();
      await value.service.cancelStart({ requestId: "preview-budget" });
      value.issue.mockClear();
      await expect(
        value.service.preview({
          ...request,
          instructions: "大".repeat(90_000),
        }),
      ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
      expect(value.issue).not.toHaveBeenCalled();
    } finally {
      await value.service.shutdown();
      value.database.close();
      vi.restoreAllMocks();
    }
  });

  it("measures the full explicit wake input without treating none as hidden conversation", async () => {
    const value = await fixture();
    const estimate = vi.spyOn(inputBudget, "estimateInputBudget");
    try {
      const connection = await value.service.quickStart({
        origin: "voice_wake",
        requestedAt: NOW,
      });
      await report(value.service, connection.sessionId, {
        protocolSessionId: "wake-budget",
        type: "session.ready",
      });
      const command = value.commands.find(
        ({ type }) => type === "wake.greeting.create",
      );
      if (!command || command.type !== "wake.greeting.create")
        throw new Error("Missing wake greeting");
      const payload = voiceWakeGreetingEvent(command);
      expect(estimate).toHaveBeenCalledWith(payload);
      expect(payload.response.input).toHaveLength(1);
      expect(payload.response.tools).toEqual([]);
      // Shared estimator remains conservative for arbitrary conversation references.
      expect(estimateInputBudget(payload).unknownKinds).toEqual([
        "conversation",
      ]);
      expect(value.service.getActive()?.phase).toBe("thinking");
    } finally {
      await value.service.shutdown();
      value.database.close();
      vi.restoreAllMocks();
    }
  });

  it.each(["wake", "transcript"] as const)(
    "does not publish %s after its thinking snapshot synchronously ends the owner",
    async (mode) => {
      let ending: Promise<null> | undefined;
      let endedFromSnapshot = false;
      const value = await fixture({
        onSnapshot: (snapshot) => {
          if (
            !endedFromSnapshot &&
            snapshot?.phase === "thinking" &&
            (mode === "wake" || snapshot.runId)
          ) {
            endedFromSnapshot = true;
            ending = value.service.end({ sessionId: snapshot.sessionId });
          }
        },
      });
      try {
        const connection =
          mode === "wake"
            ? await value.service.quickStart({
                origin: "voice_wake",
                requestedAt: NOW,
              })
            : await value.service.start(startRequest);
        await report(value.service, connection.sessionId, {
          type: "session.ready",
          protocolSessionId: "synchronous-end",
        });
        if (mode === "transcript") {
          await report(value.service, connection.sessionId, {
            type: "speech.started",
            itemId: "sync-input",
            audioEndMs: 0,
          });
          await value.service.report({
            sessionId: connection.sessionId,
            occurredAt: NOW,
            event: {
              type: "transcript.user.completed",
              itemId: "sync-input",
              transcript: "这时结束",
            },
          });
        }
        await vi.waitFor(() => expect(ending).toBeDefined());
        await ending;
        expect(
          value.commands.filter(
            ({ type }) =>
              type === "response.create" || type === "wake.greeting.create",
          ),
        ).toEqual([]);
        expect(
          value.runs.getActiveRun(value.service.getActive()?.chatId ?? CHAT_ID),
        ).toBeUndefined();
        if (mode === "transcript")
          expect(
            value.runs.getRun(value.chats.listMessages(CHAT_ID)[0]!.runId!)
              ?.status,
          ).toBe("cancelled");
      } finally {
        await value.service.shutdown();
        value.database.close();
      }
    },
  );

  it("keeps a completed large Tool durable but refuses its oversized continuation", async () => {
    const value = await fixture();
    try {
      value.read.mockResolvedValue({
        artifacts: [],
        modelContent: { text: "实际已完成结果".repeat(20_000) },
        retryable: false,
        status: "success",
        summary: "读取已完成",
      });
      const { connection, run } = await startTurn(
        value,
        { mode: "chat" },
        "查询北京天气",
      );
      await report(value.service, connection.sessionId, {
        type: "response.started",
        responseId: "large-tool-response",
        generation: 1,
      });
      await report(value.service, connection.sessionId, {
        type: "tool.call",
        responseId: "large-tool-response",
        generation: 1,
        itemId: "large-tool-item",
        callId: "large-tool-call",
        name: "weather_lookup",
        arguments: '{"city":"北京"}',
      });
      await vi.waitFor(() =>
        expect(value.runs.getRun(run.id)?.status).toBe("failed"),
      );
      const item = value.runs
        .listRunItems(run.id)
        .find(({ kind }) => kind === "tool_call");
      expect(item?.status).toBe("completed");
      expect(item?.output).toMatchObject({
        status: "success",
        summary: "读取已完成",
      });
      expect(value.read).toHaveBeenCalledOnce();
      expect(
        value.commands.filter(({ type }) => type === "tool.result"),
      ).toEqual([]);
      expect(value.service.getActive()?.error?.code).toBe(
        "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
      );
    } finally {
      await value.service.shutdown();
      value.database.close();
    }
  });
});
