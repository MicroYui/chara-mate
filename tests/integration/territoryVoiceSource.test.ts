import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import type { ModelRequest } from "../../src/main/agent/modelProvider";
import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import type { SettingsRepository } from "../../src/main/app/settingsRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { registerMemoryTool } from "../../src/main/memory/memoryTool";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import type { ProviderService } from "../../src/main/providers/providerService";
import { TerritoryMomentService } from "../../src/main/territory/territoryMomentService";
import { registerTerritoryMomentTool } from "../../src/main/territory/territoryMomentTool";
import { TerritoryWorldAssetStore } from "../../src/main/territory/territoryWorldAssetStore";
import { TerritoryWorldCandidateService } from "../../src/main/territory/territoryWorldCandidateService";
import { assertTerritoryMemorySources } from "../../src/main/territory/territoryWorldMemoryService";
import { TerritoryWorldRepository } from "../../src/main/territory/territoryWorldRepository";
import { createStarterTerritoryWorldSeed } from "../../src/main/territory/territoryStarterWorld";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import { VoiceRepository } from "../../src/main/voice/voiceRepository";
import { VoiceService } from "../../src/main/voice/voiceService";
import type { CognitionPreparedContext } from "../../src/shared/contracts/cognition";
import type { MemoryEvidenceReference } from "../../src/shared/contracts/memoryRecall";
import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../src/shared/contracts/settings";
import type {
  VoiceClientCommand,
  VoiceDriverEvent,
} from "../../src/shared/contracts/voice";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const now = "2026-08-09T12:00:00.000Z";
const profileId = "20000000-0000-4000-8000-000000000001";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function png(width: number, height: number): Buffer {
  const chunk = (type: string, content: Buffer) => {
    const bytes = Buffer.alloc(12 + content.length);
    bytes.writeUInt32BE(content.length, 0);
    bytes.write(type, 4, "ascii");
    content.copy(bytes, 8);
    bytes.writeUInt32BE(
      crc32(bytes.subarray(4, 8 + content.length)),
      8 + content.length,
    );
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type ToolCommand = Extract<VoiceClientCommand, { type: "tool.result" }>;

async function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "territory-voice-source-"),
  );
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const ids = new CryptoIdGenerator();
  const clock = new FakeClock(now);
  const chats = new ChatRepository(database);
  const chatId = ids.generate();
  chats.insertChat({
    id: chatId,
    createdAt: now,
    updatedAt: now,
    status: "active",
    title: "Voice",
  });
  const runs = new RunRepository(database);
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, { publish: () => undefined }),
    ids,
    clock,
  );
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const persona = personas.getActiveSnapshot();
  const tools = new ToolRegistry();
  const memoryRepository = new MemoryRepository(database);
  // Deterministic numeric adapters make this a receipt/consumer integration
  // test. Actual lexical SQL, Recall, Tool execution and evidence stamps run.
  const memory = new MemoryService(
    memoryRepository,
    { search: () => [] },
    ids,
    clock,
    {
      formation: formationRuntime({
        version: "voice-source-boundary-fixture",
        form: () => Promise.resolve({ entities: [], units: [] }),
      }),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 8000 }),
      embedding: {
        modelKey: "voice-source-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: (texts) =>
          Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
        embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
      },
      vectorSearch: { search: () => Promise.resolve([]) },
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
    },
  );
  const first = memory.create({
    type: "event",
    content: "以前和妈妈约定过雨天在家练习。",
    confidence: 1,
    importance: 0.5,
    reason: "user",
    sources: [],
  });
  const second = memory.create({
    type: "event",
    content: "送给阿澄一本摄影集。",
    confidence: 1,
    importance: 0.5,
    reason: "user",
    sources: [],
  });
  const history: MemoryEvidenceReference = {
    memoryId: first.memory.id,
    revisionId: first.memory.currentRevisionId,
    use: "history",
  };
  const searched: MemoryEvidenceReference = {
    memoryId: second.memory.id,
    revisionId: second.memory.currentRevisionId,
    use: "current",
  };
  const preparation: CognitionPreparedContext = {
    text: "用户在回忆过去雨天的约定。",
    situationIds: [],
    intentIds: [],
    evidenceIds: [],
    historicalMemoryRevisionIds: [history.revisionId],
    evidencePack: {
      items: memoryRepository.recall.evidence([history.revisionId], now),
      coverage: [],
      gaps: [],
      estimatedTokens: 500,
      truncated: false,
      incompleteReasons: [],
    },
  };
  registerMemoryTool(tools, memory, () => ({}));
  const repository = new TerritoryWorldRepository(database, ids);
  repository.ensureInitialized(createStarterTerritoryWorldSeed(now));
  const before = repository.getSnapshot();
  const imageStarted = deferred<void>();
  const image = deferred<Buffer>();
  const assets = new TerritoryWorldAssetStore(path.join(directory, "assets"), {
    normalize: (_source, size) => png(size.width, size.height),
  });
  const installs = vi.spyOn(assets, "prepareInstall");
  const candidates = new TerritoryWorldCandidateService(
    repository,
    assets,
    {
      resolveImageProfileId: () => profileId,
      createImageProvider: () => {
        const generate = () => {
          imageStarted.resolve();
          return image.promise;
        };
        return Promise.resolve({ generate, edit: generate });
      },
    },
    ids,
    clock,
    (sources) =>
      assertTerritoryMemorySources(memory, persona.personaId, sources),
  );
  const settings = {
    getCompanionInitiative: () => ({
      ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      territoryMomentSurprisesEnabled: true,
    }),
  };
  registerTerritoryMomentTool(
    tools,
    settings,
    new TerritoryMomentService(
      runs,
      chats,
      repository,
      candidates,
      settings,
      memory,
    ),
  );

  const commands: VoiceClientCommand[] = [];
  const waiters = new Map<string, ReturnType<typeof deferred<ToolCommand>>>();
  const pending: Promise<ToolCommand>[] = [];
  const providers = {
    getDefaultChatProfileId: () => profileId,
    createChatModelRuntime: () =>
      Promise.resolve({
        provider: {
          measureInput(request: ModelRequest, signal: AbortSignal) {
            signal.throwIfAborted();
            return Promise.resolve(this.estimateInput(request));
          },
          estimateInput: (request: ModelRequest) =>
            estimateInputBudget(request, request.modelId),
          resolveContextLimits: () => Promise.resolve({}),
          stream: vi.fn(),
          supportsNativeWebSearch: true,
        },
        snapshot: {
          apiStyle: "openai-compatible",
          modelId: "gpt-6-astra",
          profileId,
          profileName: "Fixture",
        },
      }),
    createRealtimeProviderRuntime: () =>
      Promise.resolve({
        apiKey: "test-key",
        profile: {
          apiStyle: "azure-openai",
          id: profileId,
          name: "Fixture",
          baseUrl: "https://unit.openai.azure.com/openai/v1",
          realtimeEndpoint: "https://unit.openai.azure.com/openai/v1/realtime",
          realtimeModel: "gpt-realtime-2.1",
        },
        snapshot: {
          apiStyle: "azure-openai",
          modelId: "gpt-realtime-2.1",
          profileId,
          profileName: "Fixture",
        },
      }),
  } as unknown as ProviderService;
  const responseCreated = deferred<void>();
  const voice = new VoiceService(
    new VoiceRepository(database),
    {
      getVoice: () => ({
        inputMode: "hands_free",
        providerProfileId: profileId,
      }),
    } as unknown as SettingsRepository,
    providers,
    {
      supportsSessionRefresh: true,
      issue: () =>
        Promise.resolve({
          callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
          clientSecret: "fixture",
          expiresAt: "2026-08-09T12:01:00.000Z",
        }),
    },
    tools,
    runs,
    writer,
    new ChatService(chats, runs, ids, clock),
    chats,
    ids,
    clock,
    {
      command: (command) => {
        commands.push(command);
        if (command.type === "response.create") responseCreated.resolve();
        if (command.type === "tool.result")
          waiters.get(command.callId)?.resolve(command);
      },
      snapshot: () => undefined,
    },
    { getActiveSnapshot: () => persona },
    () => "",
    undefined,
    { prepareTurn: () => Promise.resolve(preparation) },
  );
  cleanups.push(async () => {
    image.resolve(png(1, 1));
    await Promise.allSettled(pending);
    await voice.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await memory.indexPending();
  const connection = await voice.start({
    chatId,
    chatProviderProfileId: profileId,
    execution: { mode: "chat" },
    requestedAt: now,
  });
  const report = (event: VoiceDriverEvent) =>
    voice.report({ event, occurredAt: now, sessionId: connection.sessionId });
  await report({ type: "session.ready", protocolSessionId: "fixture-session" });
  await report({ type: "speech.started", itemId: "user-1" });
  await report({
    type: "transcript.user.completed",
    itemId: "user-1",
    transcript: "那个雨天约定对我很重要，也让我想起送过阿澄的摄影集。",
  });
  await responseCreated.promise;
  const run = runs.getActiveRun(chatId)!;
  const request = commands.findLast(
    (command) => command.type === "response.create",
  )!;
  expect(request.type).toBe("response.create");
  expect(request.instructions).toContain("以前和妈妈约定过雨天在家练习");
  expect(request.instructions).not.toContain(second.memory.currentRevisionId);
  const startResponse = (responseId: string, requestId?: string) =>
    report({
      type: "response.started",
      responseId,
      generation: 1,
      ...(requestId ? { requestId } : {}),
    });
  const tool = (
    responseId: string,
    callId: string,
    name: string,
    argumentsValue: object,
  ) => {
    const result = deferred<ToolCommand>();
    waiters.set(callId, result);
    pending.push(result.promise);
    void report({
      type: "tool.call",
      responseId,
      callId,
      generation: 1,
      itemId: `${callId}-item`,
      name,
      arguments: JSON.stringify(argumentsValue),
    });
    return result.promise;
  };
  const toolItem = (callId: string) =>
    runs
      .listRunItems(run.id)
      .find(
        (item) =>
          item.kind === "tool_call" &&
          item.input !== null &&
          typeof item.input === "object" &&
          !Array.isArray(item.input) &&
          item.input["callId"] === callId,
      )!;
  const moment = (responseId: string) =>
    tool(responseId, "moment", "territory_propose_moment", {
      name: "雨天的小灯",
      description: "想起陪伴我们的雨天约定时亮起的一盏小灯。",
      visualPrompt: "一盏柔和的小灯",
    });
  return {
    directory,
    memory,
    repository,
    assets,
    installs,
    runs,
    chats,
    commands,
    connection,
    run,
    request,
    history,
    searched,
    before,
    startResponse,
    tool,
    toolItem,
    moment,
    imageStarted,
    finishImage: () => image.resolve(png(1, 1)),
    changeWithTrueHistory: () =>
      memoryRepository.revise({
        memoryId: history.memoryId,
        revisionId: ids.generate(),
        predecessorRevisionId: history.revisionId,
        priorDispositions: [
          { revisionId: history.revisionId, disposition: "retained_history" },
        ],
        content: "现在雨天会去室内步道练习。",
        reason: "更新安排",
        sources: [],
        now: clock.now(),
      }),
    deleteSearched: () => memory.delete(searched.memoryId),
  };
}

describe("Actual Voice response receipts bound Territory moment sources", () => {
  it.each([
    "same_response",
    "acknowledged_search",
    "delayed_original",
  ] as const)(
    "%s uses only that response's supplied references and rechecks them before World commit",
    async (boundary) => {
      const f = await fixture();
      await f.startResponse("initial", f.request.requestId);
      const search = await f.tool("initial", "search", "memory_search", {
        arguments: {
          query: "阿澄 摄影集",
          questions: [{ id: "gift", text: "送给阿澄的摄影集" }],
        },
      });
      expect(search.output).toContain(f.searched.revisionId);
      expect(
        f.runs.toolSuppliedMemoryReferences(f.run.id, f.toolItem("search").id),
      ).toEqual([f.history]);
      if (boundary !== "same_response")
        await f.startResponse("after-search", search.requestId);
      if (boundary === "delayed_original")
        await f.startResponse("initial", f.request.requestId);
      const responseId =
        boundary === "acknowledged_search" ? "after-search" : "initial";
      const result = f.moment(responseId);
      await f.imageStarted.promise;
      const expected =
        boundary === "acknowledged_search"
          ? [f.history, f.searched]
          : [f.history];
      const momentItem = f.toolItem("moment");
      expect(
        f.runs.toolSuppliedMemoryReferences(f.run.id, momentItem.id),
      ).toEqual(expected);
      expect(f.repository.getSnapshot().candidates[0]?.sources).toMatchObject([
        { memoryRevisions: expected },
      ]);
      f.changeWithTrueHistory();
      f.deleteSearched();
      f.finishImage();
      const output = await result;
      const candidate = f.repository.getSnapshot().candidates[0]!;
      if (boundary === "acknowledged_search") {
        expect(candidate).toMatchObject({
          status: "failed",
          error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
        });
        expect(f.repository.getSnapshot().world).toEqual(f.before.world);
        expect(output.output).toContain("TERRITORY.SOURCE_NOT_FOUND");
        const installed = f.installs.mock.results[0];
        if (installed?.type !== "return")
          throw new Error("Actual PNG install missing");
        const record = await installed.value;
        expect(record.created).toBe(true);
        expect(f.repository.getStoredAsset(record.asset.id)).toBeUndefined();
        expect(
          existsSync(path.join(f.directory, "assets", record.storageKey)),
        ).toBe(false);
      } else {
        expect(candidate).toMatchObject({
          status: "applied",
          sources: [{ memoryRevisions: [f.history] }],
        });
        expect(f.repository.getSnapshot().world.currentRevision.sequence).toBe(
          f.before.world.currentRevision.sequence + 1,
        );
        expect(f.runs.getRunItem(momentItem.id)?.status).toBe("completed");
      }
      // No assistant transcript was received; the actual voice Tool and receipt
      // must not fabricate an ordinary visible Chat answer.
      expect(
        f.chats
          .listRunMessages(f.run.id)
          .filter(({ role }) => role === "assistant"),
      ).toEqual([]);
    },
  );

  it.each([undefined, "unrelated-request"])(
    "does not credit prepared memories for missing or unrelated response metadata (%s)",
    async (requestId) => {
      const f = await fixture();
      await f.startResponse("unacknowledged", requestId);
      const result = f.moment("unacknowledged");
      await f.imageStarted.promise;
      expect(
        f.runs.toolSuppliedMemoryReferences(f.run.id, f.toolItem("moment").id),
      ).toEqual([]);
      f.memory.delete(f.history.memoryId);
      f.deleteSearched();
      f.finishImage();
      await result;
      // The current persisted user message remains a valid source. Missing
      // acknowledgement provides no Memory refs, not a fabricated approval.
      expect(f.repository.getSnapshot().candidates[0]).toMatchObject({
        status: "applied",
        sources: [{ memoryRevisions: [] }],
      });
    },
  );
});
