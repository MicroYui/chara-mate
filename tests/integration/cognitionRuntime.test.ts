import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CognitionChoice,
  CognitionEvidenceInput,
  CognitionPreparedContext,
} from "../../src/shared/contracts/cognition";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { Run } from "../../src/shared/contracts/run";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../../src/main/agent/modelProvider";
import { AgentRuntime } from "../../src/main/agent/agentRuntime";
import {
  createCognitionContextInput,
  materializeCognitionContextInput,
} from "../../src/main/agent/cognitionContext";
import { CheckpointRepository } from "../../src/main/agent/checkpointRepository";
import { RunRepository } from "../../src/main/agent/runRepository";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import {
  CognitionRuntime,
  projectCognitionMessage,
} from "../../src/main/app/cognitionRuntime";
import { SettingsRepository } from "../../src/main/app/settingsRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { CognitionRepository } from "../../src/main/cognition/cognitionRepository";
import { isIntentCompletionEvidence } from "../../src/main/cognition/cognitionProjection";
import { attachSelectedRecollections } from "../../src/main/cognition/cognitionActionContext";
import { CognitionService } from "../../src/main/cognition/cognitionService";
import type {
  CognitionAnalysis,
  CognitionDriver,
  CognitionDispatchRequest,
} from "../../src/main/cognition/cognitionTypes";
import { openApplicationDatabase } from "../../src/main/db/database";
import { CompanionBridgeRepository } from "../../src/main/companion/companionBridgeRepository";
import { CompanionMessageProjectionService } from "../../src/main/companion/companionMessageProjectionService";
import type { CompanionRelayClient } from "../../src/main/companion/companionRelayClient";
import { CompanionInitiativeRepository } from "../../src/main/journey/companionInitiativeRepository";
import { JourneyRepository } from "../../src/main/journey/journeyRepository";
import { JourneyService } from "../../src/main/journey/journeyService";
import { ProactiveConversationSurface } from "../../src/main/journey/proactiveConversationSurface";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { registerMemoryTool } from "../../src/main/memory/memoryTool";
import { ProviderError } from "../../src/main/providers/providerError";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import { ProviderRepository } from "../../src/main/providers/providerRepository";
import { ProviderService } from "../../src/main/providers/providerService";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import { TerritoryWorldRepository } from "../../src/main/territory/territoryWorldRepository";
import { TerritoryWorldService } from "../../src/main/territory/territoryWorldService";
import { createStarterTerritoryWorldSeed } from "../../src/main/territory/territoryStarterWorld";
import { registerTerritoryTools } from "../../src/main/territory/territoryTools";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const NOW = "2026-09-15T08:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly entered = deferred();
  readonly release = deferred();
  turns: Array<ModelEvent[] | Error> = [
    [
      {
        type: "text.delta",
        delta: "你的陶艺小杯已经晾好了，想起你说很期待它。",
      },
      {
        type: "response.completed",
        responseId: "reply",
        status: "completed",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
      },
    ],
  ];
  measureInput(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.estimateInput(request));
  }
  estimateInput(request: ModelRequest) {
    return estimateInputBudget(request, request.modelId);
  }

  resolveContextLimits() {
    return Promise.resolve({ effectiveInputTokens: 258000 });
  }
  async *stream(request: ModelRequest, signal: AbortSignal) {
    this.requests.push(request);
    this.entered.resolve();
    await this.release.promise;
    signal.throwIfAborted();
    const turn = this.turns.shift();
    if (turn instanceof Error) throw turn;
    for (const event of turn ?? []) yield event;
  }
}

const emptyDelta: CognitionAnalysis["delta"] = {
  createSituations: [],
  updateSituations: [],
  createIntents: [],
  updateIntents: [],
  attention: {},
};

async function fixture(
  analyze?: CognitionDriver["analyze"],
  existingDirectory?: string,
  userTakeover = false,
) {
  const directory =
    existingDirectory ??
    (await mkdtemp(path.join(os.tmpdir(), "charamate-cognition-runtime-")));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const clock = new FakeClock(NOW);
  const ids = new CryptoIdGenerator();
  const personaRepository = new PersonaRepository(database);
  personaRepository.initialize(NOW);
  const persona = personaRepository.getActiveSnapshot();
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const messages = new ChatRepository(database);
  const runs = new RunRepository(database);
  const chats = new ChatService(messages, runs, ids, clock);
  const provider = new ControlledProvider();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const providers = new ProviderService(
    new ProviderRepository(database),
    {
      delete: () => Promise.resolve(),
      get: () => Promise.resolve("offline-fixture"),
      prune: () => Promise.resolve(),
      store: () => Promise.resolve(randomUUID()),
    },
    ids,
    clock,
    logger,
    undefined,
    () => provider,
  );
  await providers.saveProfile({
    profile: {
      apiStyle: "openai-compatible",
      name: "Offline scripted model",
      baseUrl: "https://example.invalid/v1",
      chatModel: "gpt-6-astra",
    },
    credential: { mode: "replace", value: "offline-fixture" },
  });
  const tools = new ToolRegistry();
  const memoryRepository = new MemoryRepository(database);
  const memory = new MemoryService(
    memoryRepository,
    new LexicalRetrievalPipeline(database, memoryRepository, clock),
    ids,
    clock,
  );
  const events: RunEventEnvelope[] = [];
  const terminal = new Map<string, ReturnType<typeof deferred>>();
  const statusWaiters = new Map<string, ReturnType<typeof deferred>>();
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, {
      publish(envelope) {
        events.push(envelope);
        runtime.observeRun(envelope);
        statusWaiters
          .get(`${envelope.streamId}:${runs.getRun(envelope.streamId)?.status}`)
          ?.resolve();
        if (
          [
            "run.completed",
            "run.cancelled",
            "run.failed",
            "run.interrupted",
          ].includes(envelope.event.type)
        )
          terminal.get(envelope.streamId)?.resolve();
      },
    }),
    ids,
    clock,
  );
  const agent: AgentRuntime = new AgentRuntime(
    messages,
    chats,
    runs,
    new CheckpointRepository(database),
    writer,
    tools,
    providers,
    ids,
    clock,
    { getActiveSnapshot: () => persona },
    undefined,
    undefined,
    undefined,
    undefined,
    { prepareTurn: (input) => cognition.prepareTurn(input) },
    undefined,
    undefined,
    userTakeover
      ? (continuingRunId) =>
          cognition.yieldToUser(persona.personaId, continuingRunId)
      : undefined,
  );
  const projected = vi.fn();
  const surface = new ProactiveConversationSurface(
    {
      discardProvisional: (id) => chats.discardProvisional(id),
      establishProvisional: (id) => {
        chats.establishProvisional(id);
      },
      getStatus: (id) => messages.getChat(id)?.status,
      restore: (id) => {
        chats.restore({ chatId: id });
      },
    },
    agent,
    providers,
    {
      getRun: (id) => runs.getRun(id),
      readCompletedAssistantMessage: (id) =>
        messages.listRunMessages(id).findLast((m) => m.role === "assistant")
          ?.content,
    },
    { clear: vi.fn(), show: projected },
  );
  const history = new CompanionInitiativeRepository(database);
  const settings = new SettingsRepository(database, directory);
  settings.saveCompanionInitiative(
    {
      ...settings.getCompanionInitiative(),
      level: "balanced",
      quietHours: { enabled: false, startMinute: 0, endMinute: 0 },
    },
    NOW,
  );
  const bridge = new CompanionBridgeRepository(database);
  if (!existingDirectory)
    bridge.pairDevice({
      credentialRef: randomUUID(),
      device: {
        displayName: "Offline Android fixture",
        id: randomUUID(),
        installationId: randomUUID(),
        notificationPermission: "granted",
        notificationsEnabled: true,
        pairedAt: NOW,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: NOW, state: "online" },
      },
      relayOrigin: "https://relay.example.invalid",
      updatedAt: NOW,
    });
  const enqueueAndroidMailbox = vi.fn<
    CompanionRelayClient["enqueueAndroidMailbox"]
  >(({ request }) =>
    Promise.resolve({
      protocolVersion: 1,
      envelope: {
        id: request.envelopeId,
        protocolVersion: 1,
        event: request.event,
        recipient: request.recipient,
        createdAt: clock.now(),
        expiresAt: "2026-09-16T08:00:00.000Z",
        cursor: "offline-delivery-receipt",
      },
    }),
  );
  const messageProjection = new CompanionMessageProjectionService({
    bridge,
    chats: messages,
    runs,
    clock,
    idGenerator: ids,
    relay: { enqueueAndroidMailbox },
    secretStore: { get: () => Promise.resolve("offline-fixture") },
    onBackgroundError: logger.error,
  });
  const projectMessage = vi.fn(
    (
      bubble: Parameters<ProactiveConversationSurface["publish"]>[0],
      sourceKind: "activity" | "memory_event",
    ) =>
      projectCognitionMessage(
        { surface, projector: messageProjection, isIdle: () => true },
        bubble,
        sourceKind,
      ),
  );
  const isCurrentVisualSource = vi.fn(() => true);
  const activeVoice = vi.fn(() => false);
  const lifePaused = vi.fn(() => false);
  const runtime: CognitionRuntime = new CognitionRuntime({
    cognition: () => cognition,
    repository,
    runs,
    agent,
    chats,
    messages,
    memory,
    journeys: new JourneyService(
      new JourneyRepository(database),
      chats,
      runs,
      ids,
      clock,
      { publish: vi.fn() },
    ),
    providers,
    tools,
    persona: () => persona,
    surface,
    projectMessage,
    initiativeHistory: history,
    settings,
    activeVoice,
    lifePaused,
    isCurrentVisualSource,
    clock,
    logger,
  });
  const cognition: CognitionService = new CognitionService({
    repository,
    driver: {
      analyze:
        analyze ??
        (() =>
          Promise.reject(
            new Error("This adapter test starts from a committed decision"),
          )),
    },
    memory,
    runtime,
    clock,
    activePersonaId: () => persona.personaId,
    analysisReadBudgetBytes: 16000,
    analysisBudgetTokens: 16000,
    batchWindowMs: 0,
  });
  cognition.initialize();
  const waitTerminal = async (runId: string) => {
    if (
      events.some(
        (e) =>
          e.streamId === runId &&
          [
            "run.completed",
            "run.cancelled",
            "run.failed",
            "run.interrupted",
          ].includes(e.event.type),
      )
    )
      return;
    const waiter = deferred();
    terminal.set(runId, waiter);
    await waiter.promise;
  };
  let closed = false;
  const closeForRestart = async () => {
    if (closed) return;
    closed = true;
    provider.release.resolve();
    await agent.interruptAll();
    await cognition.shutdown();
    surface.shutdown();
    await messageProjection.shutdown();
    database.close();
  };
  cleanup.push(async () => {
    await closeForRestart();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    database,
    directory,
    closeForRestart,
    clock,
    ids,
    persona,
    repository,
    messages,
    memory,
    memoryRepository,
    runs,
    chats,
    provider,
    tools,
    writer,
    runtime,
    agent,
    providers,
    cognition,
    projected,
    isCurrentVisualSource,
    activeVoice,
    lifePaused,
    settings,
    projectMessage,
    bridge,
    enqueueAndroidMailbox,
    surface,
    history,
    events,
    waitTerminal,
    waitStatus: (runId: string, status: string) => {
      if (runs.getRun(runId)?.status === status) return Promise.resolve();
      const waiter = deferred();
      statusWaiters.set(`${runId}:${status}`, waiter);
      return waiter.promise;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function savedRecollection(f: Fixture, occurredFrom?: string) {
  const detail = f.memoryRepository.create({
    memoryId: randomUUID(),
    revisionId: randomUUID(),
    content: "用户喜欢在陶艺完成后听到一句简短的祝贺。",
    type: "preference",
    confidence: 1,
    importance: 0.5,
    reason: "用户明确表达的偏好",
    sources: [
      {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        createdAt: NOW,
      },
    ],
    now: NOW,
  });
  f.memoryRepository.recall.putSemantics(
    detail.memory.currentRevisionId,
    {
      kind: "claim",
      owner: "user",
      basis: "explicit_user_statement",
      qualifiers: {},
      ...(occurredFrom ? { occurredFrom } : {}),
    },
    [],
  );
  const item = f.memoryRepository.recall.evidence(
    [detail.memory.currentRevisionId],
    NOW,
  )[0]!;
  const reading = f.repository.createAttempt(
    f.repository.readSnapshot(f.persona.personaId, f.clock.now()),
    "semantic_change",
    f.clock.now(),
  );
  f.repository.saveAttempt({ ...reading, status: "settled", outcome: "quiet" });
  const evidence: Partial<CognitionEvidenceInput> = {
    actor: "system",
    kind: "recollection",
    text: item.content,
    source: {
      kind: "memory",
      id: item.memoryId,
      revision: item.revisionId,
      fragment: reading.id,
    },
    recollection: {
      historyStatus: "current",
      type: item.type,
      owner: "user",
      basis: "explicit_user_statement",
      current: true,
      recordedAt: item.recordedAt,
    },
  };
  const revise = () =>
    f.memory.revise({
      memoryId: item.memoryId,
      content: "用户现在希望陶艺完成时先安静陪着，暂时不要祝贺。",
      sources: [],
      reason: "用户在 Memory 页面修正当前偏好",
    });
  return { item, evidence, revise };
}

function prepare(
  f: Fixture,
  extra: Partial<CognitionEvidenceInput> = {},
  choiceExtra: Partial<CognitionChoice> = {},
  context?: CognitionPreparedContext,
  evidenceUse:
    | "history"
    | "current_object"
    | "current_foreground"
    | "current_recollection" = "history",
): CognitionDispatchRequest {
  const id = randomUUID();
  const evidence: CognitionEvidenceInput = {
    id,
    personaId: f.persona.personaId,
    actor: "user",
    source: { kind: "activity", id },
    observedAt: f.clock.now(),
    kind: "observation",
    text: "用户先前提到的陶艺小杯已经晾好，眼前有相关内容。",
    ...extra,
  };
  f.cognition.ingest(evidence);
  const choice: CognitionChoice = {
    id: "offer",
    kind: "start_conversation",
    evidenceIds: [evidence.id],
    rationale: "关联明确的共同话题，有一条轻量的新内容。",
    userImpact: "light",
    executionScope: "conversation",
    reversibility: "read_only",
    timing: "now",
    resumeConditions: [],
    ...choiceExtra,
  };
  let attempt = f.repository.createAttempt(
    f.repository.readSnapshot(f.persona.personaId, f.clock.now()),
    "semantic_change",
    f.clock.now(),
  );
  attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
  attempt = f.repository.commitAnalysis(
    attempt.id,
    {
      delta: emptyDelta,
      decision: {
        choices: [choice],
        selectedChoiceId: choice.id,
        selectedBasis: {
          choiceId: choice.id,
          evidenceUses: [{ evidenceId: evidence.id, use: evidenceUse }],
          currentClaimRefs: [],
        },
        reason: choice.rationale,
      },
    },
    f.clock.now(),
  );
  return {
    attemptId: attempt.id,
    signal: new AbortController().signal,
    dispatchKey: attempt.dispatchKey,
    personaId: f.persona.personaId,
    choice,
    prepareContext: () =>
      context ?? {
        situationIds: [],
        intentIds: [],
        evidenceIds: [evidence.id],
        text: "当前是陶艺话题，尚未有用户回复。",
        decisionAttemptId: attempt.id,
      },
  };
}

function modelText(content: string): ModelEvent[] {
  return [
    { type: "text.delta", delta: content },
    {
      type: "response.completed",
      responseId: randomUUID(),
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
    },
  ];
}

async function conditionalRequest(f: Fixture) {
  const chat = f.chats.create({ title: "字句的约定" });
  f.provider.turns = [modelText("好，等这一段实际出现，我再接它的最后一句。")];
  f.provider.release.resolve();
  const run = await f.agent.start({
    chatId: chat.id,
    attachments: [],
    execution: { mode: "chat" },
    content: "等我打开那段信，帮我把最后一句接完，一次就好。",
    providerProfileId: f.providers.getDefaultChatProfileId(),
    requestedAt: f.clock.now(),
  });
  await f.waitTerminal(run.id);
  const request = f.cognition
    .getSnapshot(f.persona.personaId)
    .evidence.find(
      (item) =>
        item.source.id === run.id &&
        item.kind === "utterance" &&
        item.actor === "user",
    )!;
  expect(request?.source.revision).toBe("completed");
  f.clock.advance(1000);
  const condition = f.repository.ingest(
    {
      id: randomUUID(),
      personaId: f.persona.personaId,
      actor: "unknown",
      kind: "observation",
      boundary: "content",
      observedAt: f.clock.now(),
      source: { kind: "activity", id: randomUUID() },
      object: { key: "letter", identity: "adapter" },
      text: "信件正文：下次见面，我想和你……",
    },
    f.clock.now(),
  ).evidence;
  const output: CognitionAnalysis = {
    delta: {
      ...emptyDelta,
      createSituations: [
        {
          localId: "new:letter",
          value: {
            status: "current",
            title: "信的收尾",
            summary: "用户请求等正文出现后接一句。",
            objectRefs: [],
            episodes: [],
            unresolved: [],
            relatedSituationIds: [],
            claims: [
              {
                id: "visible",
                text: "信件正文已经显示",
                basis: "observed",
                state: "supported",
                evidenceIds: [condition.id],
                contradictingEvidenceIds: [],
              },
            ],
          },
        },
      ],
      createIntents: [
        {
          localId: "new:request",
          value: {
            owner: "user",
            basis: "explicit_user",
            status: "active",
            situationId: "new:letter",
            goal: "正文出现后接完信的最后一句",
            successCriteria: ["在原 Chat 接一句"],
            evidenceIds: [request.id],
            blockers: [],
            progress: "条件已出现",
            effectEvidenceIds: [],
            resumeConditions: [
              {
                kind: "new_evidence",
                description: "实际信件正文出现",
                referenceId: condition.id,
              },
            ],
          },
        },
      ],
    },
    decision: {
      choices: [
        {
          id: "continue",
          kind: "continue_shared",
          chatId: chat.id,
          situationId: "new:letter",
          intentId: "new:request",
          evidenceIds: [request.id, condition.id],
          rationale: "履行先前的一次明确续接请求",
          userImpact: "light",
          executionScope: "conversation",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
          instruction: "在实际信件最后一句接一个自然的结尾。",
        },
      ],
      selectedChoiceId: "continue",
      reason: "请求条件实际出现",
      selectedBasis: {
        choiceId: "continue",
        evidenceUses: [
          { evidenceId: request.id, use: "history" },
          { evidenceId: condition.id, use: "current_object" },
        ],
        currentClaimRefs: [{ situationId: "new:letter", claimId: "visible" }],
        requestedContinuation: {
          requestEvidenceId: request.id,
          conditionClaimRefs: [
            { situationId: "new:letter", claimId: "visible" },
          ],
        },
      },
    },
  };
  const commit = (value = output): CognitionDispatchRequest => {
    let attempt = f.repository.createAttempt(
      f.repository.readSnapshot(f.persona.personaId, f.clock.now()),
      "semantic_change",
      f.clock.now(),
    );
    attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    attempt = f.repository.commitAnalysis(
      attempt.id,
      value,
      f.clock.now(),
      f.cognition.getSnapshot(f.persona.personaId).evidence,
    );
    return {
      attemptId: attempt.id,
      signal: new AbortController().signal,
      dispatchKey: attempt.dispatchKey,
      personaId: f.persona.personaId,
      choice: attempt.decision!.choices[0]!,
      prepareContext: () => ({
        situationIds: [],
        intentIds: [],
        evidenceIds: [request.id, condition.id],
        text: "用户明确请求在信件出现后接一句，正文现在已实际出现。",
        decisionAttemptId: attempt.id,
      }),
    };
  };
  return { chat, run, request, condition, output, commit };
}

function recentInitiative(f: Fixture) {
  f.history.recordAccepted({
    id: randomUUID(),
    sourceKind: "activity",
    kind: "invitation",
    grounding: "刚刚已有一条普通主动开场",
    message: "窗外天光很好。",
    acceptedAt: f.clock.now(),
    appName: "Notes",
    windowTitle: "随手记",
  });
  expect(
    f.runtime.availability(f.persona.personaId).mayInitiateConversation,
  ).toBe(false);
}

describe("explicit conditional continuation with actual Run and Chat receipts", () => {
  it("bypasses only unsolicited cooldown and offers exactly one original-Chat contribution across new Intent IDs", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    recentInitiative(f);
    const request = h.commit();
    const attempt = f.repository.getAttempt(request.attemptId)!;
    expect(
      attempt.decision!.selectedBasis.requestedContinuation!
        .conditionClaimRefs[0]!.situationId,
    ).not.toMatch(/^new:/);
    expect(
      f.runtime.availability(f.persona.personaId, attempt)
        .mayInitiateConversation,
    ).toBe(true);
    f.provider.turns = [
      modelText("下次见面，我想和你慢慢走完那条没有赶路声的小巷。"),
    ];
    const { runId } = await f.runtime.dispatch(request);
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.chatId).toBe(h.chat.id);
    expect(f.surface.current()?.messageId).toBe(
      f.messages.listRunMessages(runId).find((m) => m.role === "assistant")!.id,
    );
    expect(
      f.repository.hasEvidence(
        f.persona.personaId,
        { kind: "run", id: runId, revision: "surface:offered" },
        "observation",
      ),
    ).toBe(true);
    const calls = f.provider.requests.length;
    expect((await f.runtime.dispatch(request)).runId).toBe(runId);
    f.runtime.restoreSurfaces();
    expect(f.provider.requests).toHaveLength(calls);
    const again = h.commit();
    await expect(f.runtime.dispatch(again)).rejects.toThrow("decision changed");
    expect(f.provider.requests).toHaveLength(calls);
    expect(
      f.repository.requestedContinuationBinding(
        f.persona.personaId,
        h.request.id,
        again.attemptId,
      )?.runId,
    ).toBe(runId);
  });

  it("keeps a completed but unoffered contribution durable and restores that same message without another model request", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    recentInitiative(f);
    const request = h.commit();
    f.projectMessage.mockReturnValue(false);
    f.provider.turns = [modelText("想和你一起听到傍晚的钟声。")];
    const { runId } = await f.runtime.dispatch(request);
    await f.waitTerminal(runId);
    f.activeVoice.mockReturnValue(true);
    expect(f.runtime.reconcileRun(runId).deliveryPending).toBe(true);
    await f.cognition.runDue();
    expect(f.repository.getAttempt(request.attemptId)?.status).toBe(
      "dispatched",
    );
    const message = f.messages
      .listRunMessages(runId)
      .find((m) => m.role === "assistant")!;
    const calls = f.provider.requests.length;
    f.activeVoice.mockReturnValue(false);
    f.projectMessage.mockImplementation((bubble, kind) =>
      projectCognitionMessage(
        { surface: f.surface, isIdle: () => true },
        bubble,
        kind,
      ),
    );
    f.runtime.restoreSurfaces();
    expect(f.surface.current()?.messageId).toBe(message.id);
    expect(f.provider.requests).toHaveLength(calls);
    await f.cognition.runDue();
    expect(f.repository.getAttempt(request.attemptId)?.outcome).toBe(
      "delivered",
    );
    f.runtime.restoreSurfaces();
    expect(f.provider.requests).toHaveLength(calls);
  });

  it("reopens the actual SQLite file and republishes only its already generated message", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    recentInitiative(f);
    const request = h.commit();
    f.projectMessage.mockReturnValue(false);
    f.provider.turns = [modelText("下次见面，我们去看那条河。")];
    const { runId } = await f.runtime.dispatch(request);
    await f.waitTerminal(runId);
    await f.cognition.runDue();
    const messageId = f.messages
      .listRunMessages(runId)
      .find((m) => m.role === "assistant")!.id;
    await f.closeForRestart();
    const restarted = await fixture(undefined, f.directory);
    restarted.clock.advance(1000);
    restarted.runtime.restoreSurfaces();
    expect(restarted.surface.current()?.messageId).toBe(messageId);
    expect(restarted.surface.current()?.id).toBe(runId);
    expect(restarted.provider.requests).toHaveLength(0);
    expect(restarted.repository.getAttempt(request.attemptId)?.runId).toBe(
      runId,
    );
    restarted.runtime.restoreSurfaces();
    expect(restarted.projected).toHaveBeenCalledOnce();
  });

  it("reserves one Run when the same requested decision enters concurrently", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    const request = h.commit();
    f.provider.turns = [modelText("下次一起去桥边走走。")];
    const results = await Promise.all([
      f.runtime.dispatch(request),
      f.runtime.dispatch(request),
    ]);
    expect(results[0].runId).toBe(results[1].runId);
    await f.waitTerminal(results[0].runId);
    expect(f.provider.requests).toHaveLength(2);
    expect(f.projected).toHaveBeenCalledOnce();
  });

  it("does not upgrade a partial model-supplied request to the complete persisted request", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    const snapshotRead = f.repository.readSnapshot(
      f.persona.personaId,
      f.clock.now(),
    );
    const snapshot = snapshotRead.snapshot;
    const attempt = f.repository.createAttempt(
      snapshotRead,
      "semantic_change",
      f.clock.now(),
    );
    f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    expect(() =>
      f.repository.commitAnalysis(
        attempt.id,
        h.output,
        f.clock.now(),
        snapshot.evidence.map((item) =>
          item.id === h.request.id ? { ...item, text: "等我打开那段信" } : item,
        ),
      ),
    ).toThrow("complete request text");
    expect(f.provider.requests).toHaveLength(1);
  });

  it("allows a later re-evaluation after an unsuccessful Run without generating automatic retries", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    const request = h.commit();
    f.provider.turns = [[]];
    const first = await f.runtime.dispatch(request);
    await f.waitTerminal(first.runId);
    expect(f.runs.getRun(first.runId)?.status).toBe("failed");
    await f.cognition.runDue();
    expect(f.repository.getAttempt(request.attemptId)?.outcome).toBe("failed");
    expect(f.provider.requests).toHaveLength(2);
    const reconsidered = h.commit();
    f.provider.turns = [modelText("下次见面，我们去看那条河。")];
    const second = await f.runtime.dispatch(reconsidered);
    await f.waitTerminal(second.runId);
    expect(second.runId).not.toBe(first.runId);
    expect(f.surface.current()?.id).toBe(second.runId);
    expect(f.provider.requests).toHaveLength(3);
  });

  it.each([false, true])(
    "reconsiders a failed contribution after a successful actual Memory read, with completed commentary=%s",
    async (withCommentary) => {
      const f = await fixture();
      const h = await conditionalRequest(f);
      const prior = savedRecollection(f).item;
      const unused = vi.fn((): Promise<never> => {
        return Promise.reject(
          new Error(
            "Exact-read fixture must not invoke formation or semantic search",
          ),
        );
      });
      const memory = new MemoryService(
        f.memoryRepository,
        new LexicalRetrievalPipeline(f.database, f.memoryRepository, f.clock),
        f.ids,
        f.clock,
        {
          embedding: {
            modelKey: "unused-exact-read",
            dimensions: 1,
            splitDocument: unused,
            embedDocuments: unused,
            embedQuery: unused,
          },
          vectorSearch: { search: unused },
          selector: {
            select: ({ plan, candidates }) =>
              Promise.resolve({
                selected: candidates.map(({ revisionId }) => ({
                  revisionId,
                  questionIds: plan.questions.map(({ id }) => id),
                })),
                coverage: plan.questions.map(({ id }) => ({
                  questionId: id,
                  status: "supported" as const,
                  revisionIds: candidates.map(({ revisionId }) => revisionId),
                })),
              }),
          },
          formation: formationRuntime({ version: "unused", form: unused }),
          formationResourceBudget,
          formationContextBudget: () => ({ maxTokens: 8192 }),
        },
      );
      registerMemoryTool(f.tools, memory, () => ({
        personaId: f.persona.personaId,
      }));
      const firstRequest = h.commit();
      f.provider.turns = [
        [
          ...(withCommentary
            ? [
                {
                  type: "text.delta" as const,
                  delta: "我先回忆一下信里的约定。",
                },
              ]
            : []),
          {
            type: "output.item",
            item: {
              type: "function_call",
              call_id: "read-letter-promise",
              namespace: "memory",
              name: "search",
              arguments: JSON.stringify({
                query: "",
                references: [
                  {
                    memoryId: prior.memoryId,
                    revisionId: prior.revisionId,
                    use: "history",
                  },
                ],
                questions: [{ id: "prior", text: "这条原有约定是什么" }],
              }),
            },
          },
          {
            type: "response.completed",
            responseId: "read-before-failure",
            status: "completed",
            usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
          },
        ],
        new ProviderError(
          "PROVIDER.REQUEST_FAILED",
          "Provider failed after the actual read",
          false,
        ),
      ];
      const first = await f.runtime.dispatch(firstRequest);
      await f.waitTerminal(first.runId);
      expect(f.runs.getRun(first.runId)).toMatchObject({ status: "failed" });
      const read = f.runs
        .listRunItems(first.runId)
        .find((item) => item.kind === "tool_call");
      expect(read?.output).toMatchObject({
        status: "success",
        modelContent: {
          items: [
            expect.objectContaining({
              revisionId: prior.revisionId,
              content: prior.content,
            }),
          ],
        },
      });
      expect(unused).not.toHaveBeenCalled();
      const feedback = f.runtime.reconcileRun(first.runId);
      expect(
        feedback.evidence.find((item) => item.effect?.itemId === read?.id)
          ?.effect,
      ).toMatchObject({
        outcome: "performed",
        worldChange: "unchanged",
      });
      const comments = f.messages
        .listRunMessages(first.runId)
        .filter(
          (item) => item.role === "assistant" && item.status === "completed",
        );
      expect(
        comments.some((item) => item.content === "我先回忆一下信里的约定。"),
      ).toBe(withCommentary);
      await f.cognition.runDue();
      expect(f.repository.getAttempt(firstRequest.attemptId)?.outcome).toBe(
        "failed",
      );
      expect(f.surface.current()).toBeUndefined();
      expect(f.provider.requests).toHaveLength(3);
      f.clock.advance(1000);
      f.repository.ingest(
        {
          id: randomUUID(),
          personaId: f.persona.personaId,
          actor: "unknown",
          kind: "observation",
          boundary: "content",
          observedAt: f.clock.now(),
          source: { kind: "activity", id: randomUUID() },
          object: { key: "letter-arrived-again", identity: "adapter" },
          text: "信仍在屏幕上，正文没有改变。",
        },
        f.clock.now(),
      );
      const reconsidered = h.commit();
      f.provider.turns = [modelText("下次见面，我们去看那条河。")];
      const second = await f.runtime.dispatch(reconsidered);
      await f.waitTerminal(second.runId);
      expect(second.runId).not.toBe(first.runId);
      expect(f.runs.getRun(second.runId)?.status).toBe("completed");
      expect(f.surface.current()).toMatchObject({
        id: second.runId,
        content: "下次见面，我们去看那条河。",
      });
      expect(f.runs.getRunItem(read!.id)?.output).toMatchObject({
        status: "success",
      });
      expect(f.provider.requests).toHaveLength(4);
    },
  );

  it("rejects an earlier observation as evidence that the requested later condition occurred", async () => {
    const f = await fixture();
    const prior = f.repository.ingest(
      {
        id: randomUUID(),
        personaId: f.persona.personaId,
        actor: "unknown",
        kind: "observation",
        observedAt: f.clock.now(),
        source: { kind: "activity", id: randomUUID() },
        object: { key: "older-letter", identity: "adapter" },
        text: "此前另一封信的正文",
      },
      f.clock.now(),
    ).evidence;
    const h = await conditionalRequest(f);
    const value = structuredClone(h.output);
    value.delta.createSituations[0]!.value.claims[0]!.evidenceIds = [prior.id];
    value.decision.choices[0]!.evidenceIds[1] = prior.id;
    value.decision.selectedBasis.evidenceUses[1]!.evidenceId = prior.id;
    expect(() => h.commit(value)).toThrow("received after the request");
  });

  it("keeps the same generated contribution retired when its actual page changes before delivery", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    const request = h.commit();
    f.projectMessage.mockReturnValue(false);
    f.provider.turns = [modelText("先前信件对应的结尾。")];
    const { runId } = await f.runtime.dispatch(request);
    await f.waitTerminal(runId);
    f.repository.ingest(
      {
        id: randomUUID(),
        personaId: f.persona.personaId,
        actor: "unknown",
        kind: "observation",
        boundary: "content",
        observedAt: f.clock.now(),
        source: { kind: "activity", id: randomUUID() },
        object: h.condition.object!,
        text: "现在这个编辑器显示的是另一封信。",
      },
      f.clock.now(),
    );
    f.projectMessage.mockImplementation((bubble, kind) =>
      projectCognitionMessage(
        { surface: f.surface, isIdle: () => true },
        bubble,
        kind,
      ),
    );
    f.runtime.restoreSurfaces();
    expect(f.runtime.reconcileRun(runId).deliveryPending).not.toBe(true);
    expect(f.surface.current()).toBeUndefined();
    expect(f.provider.requests).toHaveLength(2);
  });

  it("does not replay a generated message after new user input withdraws the request", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    const request = h.commit();
    f.projectMessage.mockReturnValue(false);
    f.provider.turns = [modelText("一个已经生成的结尾。")];
    const { runId } = await f.runtime.dispatch(request);
    await f.waitTerminal(runId);
    f.provider.turns = [modelText("好，先放下这封信。")];
    const user = await f.agent.start({
      chatId: h.chat.id,
      attachments: [],
      execution: { mode: "chat" },
      content: "那封信不接了，现在先别发给我。",
      providerProfileId: f.providers.getDefaultChatProfileId(),
      requestedAt: f.clock.now(),
    });
    await f.waitTerminal(user.id);
    f.projectMessage.mockImplementation((bubble, kind) =>
      projectCognitionMessage(
        { surface: f.surface, isIdle: () => true },
        bubble,
        kind,
      ),
    );
    f.runtime.restoreSurfaces();
    expect(f.runtime.reconcileRun(runId).deliveryPending).not.toBe(true);
    expect(f.surface.current()).toBeUndefined();
    expect(
      f.repository.hasEvidence(
        f.persona.personaId,
        { kind: "run", id: runId, revision: "surface:offered" },
        "observation",
      ),
    ).toBe(false);
  });

  it("retains the request's existing resumption conditions while current Voice prevents dispatch", async () => {
    const analyze = vi.fn<CognitionDriver["analyze"]>();
    const f = await fixture(analyze);
    const h = await conditionalRequest(f);
    analyze.mockResolvedValue(h.output);
    f.activeVoice.mockReturnValue(true);
    await f.cognition.runDue();
    expect(analyze).toHaveBeenCalledOnce();
    const attempt = f.cognition
      .getSnapshot(f.persona.personaId)
      .recentAttempts.find(
        (value) =>
          value.projection === "complete" &&
          value.decision?.selectedBasis.requestedContinuation,
      )!;
    expect(attempt.projection).toBe("complete");
    if (attempt.projection !== "complete")
      throw new Error("Expected the complete continuation Attempt view");
    const intent = f.repository.getIntent(
      attempt.decision!.choices[0]!.intentId!,
    )!;
    expect(intent.resumeConditions).toEqual(
      h.output.delta.createIntents[0]!.value.resumeConditions,
    );
    expect(attempt.outcome).toBe("deferred");
    expect(f.runs.listRunsByStatus(["running", "queued"])).toHaveLength(0);
  });

  it.each([
    "outside-current-claims",
    "inferred-condition",
    "uncertain-condition",
    "wrong-chat",
    "inferred-intent",
    "missing-request",
  ] as const)(
    "rejects %s before allocating any continuation Run",
    async (problem) => {
      const f = await fixture();
      const h = await conditionalRequest(f);
      const value = structuredClone(h.output);
      if (problem === "outside-current-claims")
        value.decision.selectedBasis.currentClaimRefs = [];
      if (problem === "inferred-condition")
        value.delta.createSituations[0]!.value.claims[0]!.basis = "inferred";
      if (problem === "uncertain-condition")
        value.delta.createSituations[0]!.value.claims[0]!.state = "uncertain";
      if (problem === "wrong-chat")
        value.decision.choices[0]!.chatId = f.chats.create({
          title: "别的对话",
        }).id;
      if (problem === "inferred-intent") {
        value.delta.createIntents[0]!.value.basis = "inferred_user";
        value.delta.createIntents[0]!.value.status = "candidate";
      }
      if (problem === "missing-request")
        value.decision.selectedBasis.requestedContinuation!.requestEvidenceId =
          h.condition.id;
      expect(() => h.commit(value)).toThrow();
      expect(f.provider.requests).toHaveLength(1);
    },
  );

  it("checks the actual RunItem and Chat text rather than accepting a model-declared request receipt", async () => {
    const f = await fixture();
    const h = await conditionalRequest(f);
    const forged = f.repository.ingest(
      {
        personaId: h.request.personaId,
        actor: h.request.actor,
        kind: h.request.kind,
        observedAt: h.request.observedAt,
        text: h.request.text!,
        chatId: h.request.chatId!,
        id: randomUUID(),
        source: { ...h.request.source, fragment: randomUUID() },
      },
      f.clock.now(),
    ).evidence;
    const value = structuredClone(h.output);
    value.delta.createIntents[0]!.value.evidenceIds = [forged.id];
    value.decision.choices[0]!.evidenceIds[0] = forged.id;
    value.decision.selectedBasis.evidenceUses[0]!.evidenceId = forged.id;
    value.decision.selectedBasis.requestedContinuation!.requestEvidenceId =
      forged.id;
    const nextCondition = f.repository.ingest(
      {
        personaId: h.condition.personaId,
        actor: h.condition.actor,
        kind: h.condition.kind,
        observedAt: h.condition.observedAt,
        text: h.condition.text!,
        object: h.condition.object!,
        id: randomUUID(),
        source: { kind: "activity", id: randomUUID() },
      },
      f.clock.now(),
    ).evidence;
    value.delta.createSituations[0]!.value.claims[0]!.evidenceIds = [
      nextCondition.id,
    ];
    value.decision.choices[0]!.evidenceIds[1] = nextCondition.id;
    value.decision.selectedBasis.evidenceUses[1]!.evidenceId = nextCondition.id;
    const request = h.commit(value);
    await expect(f.runtime.dispatch(request)).rejects.toThrow(
      "decision changed",
    );
    expect(f.provider.requests).toHaveLength(1);
  });
});

describe("Cognition Main adapter with real Run, Chat and SQLite", () => {
  it("reports current own-life capabilities independently of a temporary life pause", async () => {
    const f = await fixture();
    const register = (
      name: string,
      effect: "read" | "write",
      idempotency: "idempotent" | "non_idempotent" = "idempotent",
    ) => {
      f.tools.register({
        descriptor: {
          name,
          namespace: name.split(".")[0]!,
          description: `Actual metadata for ${name}`,
          summary: name,
          source: "builtin",
          itemKind: "tool_call",
          effect,
          idempotency,
          inputSchema: Type.Object({}, { additionalProperties: false }),
        },
        execute: () =>
          Promise.resolve({
            status: "success",
            artifacts: [],
            retryable: false,
            summary: name,
            modelContent: {},
          }),
        summarize: () => name,
      });
    };
    register("territory.act", "write");
    register("territory.observe", "read", "non_idempotent");
    register("memory.search", "read");
    register("file.read", "read");
    const available = f.runtime.availability(f.persona.personaId);
    expect(available.characterTools).toEqual([
      {
        name: "memory.search",
        description: "Actual metadata for memory.search",
        summary: "memory.search",
        effect: "read",
      },
      {
        name: "territory.act",
        description: "Actual metadata for territory.act",
        summary: "territory.act",
        effect: "write",
      },
    ]);
    f.lifePaused.mockReturnValue(true);
    expect(f.runtime.availability(f.persona.personaId)).toMatchObject({
      mayActInTerritory: false,
      characterTools: available.characterTools,
    });
    f.tools.unregisterWhere(({ name }) => name === "territory.act");
    expect(
      f.runtime
        .availability(f.persona.personaId)
        .characterTools.map(({ name }) => name),
    ).toEqual(["memory.search"]);
  });

  it("does not publish a historical contribution after the same read revision becomes unresolved", async () => {
    const f = await fixture();
    const memory = savedRecollection(f);
    const request = prepare(f, memory.evidence, {}, undefined, "history");
    const attempt = f.repository.getAttempt(request.attemptId)!;
    const readRequest = f.repository.actionRecollectionRequest(attempt);
    expect(readRequest.references[0]?.use).toBe("history");
    expect(readRequest.expectedHistory?.[0]).toMatchObject({
      revisionId: memory.item.revisionId,
      historyStatus: "current",
    });
    const context = attachSelectedRecollections(
      f.repository.readActionContext(attempt, 8000, (value) => value),
      attempt,
      f.memory,
      readRequest,
      8000,
    );
    const { runId } = await f.runtime.dispatch({
      ...request,
      prepareContext: () => context,
    });
    await f.provider.entered.promise;
    memory.revise();
    // The original revision still exists and may be read as a corrected record.
    expect(
      f.memory.validateEvidenceReferences({
        personaId: f.persona.personaId,
        references: readRequest.references,
      }),
    ).toEqual([]);
    expect(f.memory.validateEvidenceReferences(readRequest)).toEqual(
      readRequest.references,
    );
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.projectMessage).not.toHaveBeenCalled();
    f.runtime.restoreSurfaces();
    expect(f.projectMessage).not.toHaveBeenCalled();
  });

  it("dispatches an independent opening with its complete current claim, prior visual and counterevidence without a topic intent", async () => {
    const f = await fixture();
    const userId = randomUUID();
    const user = f.repository.ingest(
      {
        id: userId,
        personaId: f.persona.personaId,
        actor: "user",
        kind: "utterance",
        source: { kind: "message", id: userId },
        observedAt: NOW,
        text: "The draft should keep the green card beside the label.",
      },
      NOW,
    ).evidence;
    const visual = (sequence: number, text: string) => {
      const id = randomUUID();
      return f.repository.ingest(
        {
          id,
          personaId: f.persona.personaId,
          actor: "unknown",
          kind: "observation",
          source: { kind: "activity", id, revision: `frame-${sequence}` },
          observedAt: NOW,
          text,
          object: { key: `draft-window-${sequence}`, identity: "adapter" },
          sourceEpoch: "window-generation",
          sourceSequence: sequence,
          boundary: "content",
        },
        NOW,
      ).evidence;
    };
    const previous = visual(1, "Earlier frame: green card beside the label.");
    const current = visual(
      2,
      "Current frame: green card moved away from the label.",
    );
    const output: CognitionAnalysis = {
      delta: {
        ...emptyDelta,
        createSituations: [
          {
            localId: "new:draft",
            value: {
              status: "current",
              title: "Draft",
              summary: "Unselected background summary",
              objectRefs: [],
              episodes: [],
              unresolved: [],
              relatedSituationIds: [],
              claims: [
                {
                  id: "condition",
                  text: "The user requested the green card beside the label.",
                  basis: "reported",
                  state: "supported",
                  evidenceIds: [user.id],
                  contradictingEvidenceIds: [],
                },
                {
                  id: "layout",
                  text: "The currently visible layout differs from the earlier one.",
                  basis: "observed",
                  state: "supported",
                  evidenceIds: [current.id],
                  contradictingEvidenceIds: [previous.id],
                },
              ],
            },
          },
        ],
      },
      decision: {
        choices: [
          {
            id: "notice",
            kind: "start_conversation",
            situationId: "new:draft",
            evidenceIds: [user.id, previous.id, current.id],
            rationale:
              "Point out a visible difference without editing the draft.",
            instruction:
              "Offer a brief observation of the changed layout and the user's stated condition.",
            userImpact: "light",
            executionScope: "conversation",
            reversibility: "read_only",
            timing: "now",
            resumeConditions: [],
          },
        ],
        selectedChoiceId: "notice",
        selectedBasis: {
          choiceId: "notice",
          evidenceUses: [
            { evidenceId: user.id, use: "history" },
            { evidenceId: previous.id, use: "history" },
            { evidenceId: current.id, use: "current_foreground" },
          ],
          currentClaimRefs: [
            { situationId: "new:draft", claimId: "condition" },
            { situationId: "new:draft", claimId: "layout" },
          ],
        },
        reason:
          "This independent opening does not adopt or resume a broader goal.",
      },
    };
    const started = f.repository.createAttempt(
      f.repository.readSnapshot(f.persona.personaId, NOW),
      "semantic_change",
      NOW,
    );
    f.repository.saveAttempt({ ...started, status: "analyzing" });
    const attempt = f.repository.commitAnalysis(started.id, output, NOW);
    expect(attempt.actionReadSet?.selectedIntent).toBeUndefined();
    expect(attempt.actionReadSet?.claims).toHaveLength(2);
    expect(attempt.actionReadSet?.currentObjects).toMatchObject([
      { evidenceId: current.id, requireForeground: true },
    ]);
    const context = f.repository.readActionContext(
      attempt,
      32_768,
      (value) => value,
    );
    expect(context.intentIds).toEqual([]);
    expect(context.evidenceIds).toEqual([user.id, previous.id, current.id]);
    expect(context.text).not.toContain("Unselected background summary");
    const { runId } = await f.runtime.dispatch({
      attemptId: attempt.id,
      dispatchKey: attempt.dispatchKey,
      personaId: f.persona.personaId,
      choice: attempt.decision!.choices[0]!,
      signal: new AbortController().signal,
      prepareContext: () => context,
    });
    await f.provider.entered.promise;
    const wire = JSON.stringify(f.provider.requests[0]);
    for (const source of [user, previous, current]) {
      expect(wire).toContain(source.id);
      expect(wire).toContain(source.text);
    }
    for (const claim of output.delta.createSituations[0]!.value.claims)
      expect(wire).toContain(claim.text);
    expect(wire).toContain("contradictingEvidenceIds");
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.status).toBe("completed");
    expect(f.projectMessage).toHaveBeenCalledTimes(1);
  });

  it("allocates the actual Memory message once while retaining checkpoint provenance", async () => {
    const f = await fixture();
    const memory = savedRecollection(f);
    const request = prepare(
      f,
      memory.evidence,
      {},
      undefined,
      "current_recollection",
    );
    const attempt = f.repository.getAttempt(request.attemptId)!;
    const ready = f.repository.saveAttempt({
      ...attempt,
      recallPlan: {
        purpose: "initiative",
        query: "",
        references: [
          {
            memoryId: memory.item.memoryId,
            revisionId: memory.item.revisionId,
            use: "current",
          },
        ],
        questions: [
          {
            id: "response",
            text: "What response fits the user's stated preference?",
          },
        ],
        contextBudget: { maxTokens: 3000 },
      },
      recallSummary: {
        coverage: [
          {
            questionId: "response",
            status: "supported",
            revisionIds: [memory.item.revisionId],
          },
        ],
        gaps: [
          {
            questionId: "response",
            reason:
              "The supplied record does not establish the user's present surroundings. ".repeat(
                35,
              ),
          },
        ],
        truncated: false,
        incompleteReasons: [],
      },
    });
    const basis = f.repository.readActionContext(ready, 8000, (value) => value);
    const references = f.repository.actionRecollectionRequest(ready);
    const context = attachSelectedRecollections(
      basis,
      ready,
      f.memory,
      references,
      8000,
    );
    const checkpoint = createCognitionContextInput(context);
    const message = materializeCognitionContextInput(checkpoint);
    expect(
      Buffer.byteLength(JSON.stringify(checkpoint), "utf8"),
    ).toBeGreaterThan(8000);
    expect(
      Buffer.byteLength(JSON.stringify(message), "utf8"),
    ).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(checkpoint)).toContain(memory.item.revisionId);
    expect(JSON.stringify(checkpoint)).toContain(
      memory.item.sourceRefs[0]!.sourceId,
    );
    // The allowance here covers Memory reads, not already materialized text or
    // final model framing. Runtime owns the complete input token measurement.
    const expandedScope = "Required scope. ".repeat(540);
    expect(
      attachSelectedRecollections(
        { ...basis, text: expandedScope },
        ready,
        f.memory,
        references,
        8000,
      ).text,
    ).toBe(expandedScope);
    const { runId } = await f.runtime.dispatch({
      ...request,
      prepareContext: () => context,
    });
    await f.provider.entered.promise;
    expect(f.provider.requests[0]!.input).toContainEqual(message);
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.status).toBe("completed");
    expect(f.projectMessage).toHaveBeenCalledTimes(1);
    memory.revise();
    expect(() =>
      attachSelectedRecollections(basis, ready, f.memory, references, 8000),
    ).toThrow("no longer eligible");
  });

  it("carries an exact future Memory read through allocation and publication without applying related-search time filters", async () => {
    const f = await fixture();
    const memory = savedRecollection(f, "2026-09-16T10:00:00.000Z");
    const request = prepare(
      f,
      memory.evidence,
      {},
      undefined,
      "current_recollection",
    );
    const attempt = f.repository.getAttempt(request.attemptId)!;
    const ready = f.repository.saveAttempt({
      ...attempt,
      recallPlan: {
        purpose: "initiative",
        query: "",
        questions: [{ id: "known", text: "Read the known record." }],
        references: [
          {
            memoryId: memory.item.memoryId,
            revisionId: memory.item.revisionId,
            use: "current",
          },
        ],
        timeScope: { occurredTo: NOW },
        contextBudget: { maxTokens: 3200 },
      },
    });
    const recall = vi.spyOn(f.memory, "recall");
    const context = attachSelectedRecollections(
      f.repository.readActionContext(ready, 8000, (value) => value),
      ready,
      f.memory,
      f.repository.actionRecollectionRequest(ready),
      8000,
    );
    const { runId } = await f.runtime.dispatch({
      ...request,
      prepareContext: () => context,
    });
    await f.provider.entered.promise;
    const wire = JSON.stringify(f.provider.requests[0]);
    expect(context.evidencePack?.items[0]).toMatchObject({
      memoryId: memory.item.memoryId,
      revisionId: memory.item.revisionId,
      current: true,
    });
    expect(wire).toContain(memory.item.content);
    expect(wire).toContain("2026-09-16T10:00:00.000Z");
    expect(recall).not.toHaveBeenCalled();
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.status).toBe("completed");
    expect(f.projectMessage).toHaveBeenCalledTimes(1);
  });

  it("materializes the Service's selected recollection and gaps in the real Agent request", async () => {
    const driver = vi.fn<CognitionDriver["analyze"]>((input) => {
      const recalled = input.snapshot.evidence.find(
        (item) => item.kind === "recollection",
      );
      const choice: CognitionChoice = {
        id: recalled ? "offer" : "wait_for_evidence",
        kind: recalled ? "start_conversation" : "remain_quiet",
        evidenceIds: recalled ? [recalled.id] : [],
        rationale: recalled ? "依照用户说过的偏好简短祝贺" : "先确认回应偏好",
        ...(recalled
          ? { instruction: "简短祝贺陶艺完成，不断言未知的作品用途。" }
          : {}),
        userImpact: recalled ? "light" : "none",
        executionScope: recalled ? "conversation" : "none",
        reversibility: "read_only",
        timing: "now",
        resumeConditions: [],
      };
      return Promise.resolve({
        delta: emptyDelta,
        ...(!input.evidencePack
          ? {
              recallPlan: {
                purpose: "conversation" as const,
                query: "陶艺完成后的回应偏好和用途",
                questions: [
                  { id: "q1", text: "用户喜欢怎样回应陶艺完成？" },
                  { id: "q2", text: "作品用途是什么？" },
                ],
                contextBudget: { maxTokens: 8192 },
              },
            }
          : {}),
        decision: {
          choices: [choice],
          selectedChoiceId: choice.id,
          selectedBasis: {
            choiceId: choice.id,
            evidenceUses: recalled
              ? [
                  {
                    evidenceId: recalled.id,
                    use: "current_recollection" as const,
                  },
                ]
              : [],
            currentClaimRefs: [],
          },
          reason: choice.rationale,
        },
      });
    });
    const f = await fixture(driver);
    const memory = savedRecollection(f);
    const recall = vi.spyOn(f.memory, "recall").mockResolvedValue({
      items: [{ ...memory.item, questionIds: ["q1"] }],
      coverage: [
        {
          questionId: "q1",
          status: "supported",
          revisionIds: [memory.item.revisionId],
        },
        { questionId: "q2", status: "missing", revisionIds: [] },
      ],
      gaps: [{ questionId: "q2", reason: "没有作品用途的证据" }],
      estimatedTokens: 100,
      truncated: false,
      incompleteReasons: [],
    });
    f.cognition.saveCharacterIntent({
      id: randomUUID(),
      personaId: f.persona.personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "无关的星球种子计划",
      successCriteria: [],
      evidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "",
      effectEvidenceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    f.cognition.ingest({
      id: randomUUID(),
      personaId: f.persona.personaId,
      actor: "user",
      kind: "observation",
      source: { kind: "activity", id: randomUUID() },
      observedAt: NOW,
      text: "陶艺成品页面现在显示作品已完成。",
    });
    await f.cognition.runDue();
    expect(driver).toHaveBeenCalledTimes(2);
    expect(recall).toHaveBeenCalledTimes(1);
    await f.provider.entered.promise;
    const request = f.provider.requests[0]!;
    const wire = JSON.stringify(request);
    expect(wire).toContain(memory.item.content);
    expect(wire).toContain("没有作品用途的证据");
    expect(wire).not.toContain("无关的星球种子计划");
    const attempt = f.repository
      .getSnapshot(f.persona.personaId, NOW)
      .recentAttempts.find((item) => item.runId);
    expect(attempt).toBeDefined();
    const checkpoint = new CheckpointRepository(f.database).get(
      attempt!.runId!,
    );
    expect(JSON.stringify(checkpoint)).toContain(attempt!.id);
    f.provider.release.resolve();
    await f.waitTerminal(attempt!.runId!);
    expect(f.projectMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses a selected current recollection corrected before dispatch", async () => {
    const f = await fixture();
    const memory = savedRecollection(f);
    const request = prepare(
      f,
      memory.evidence,
      {},
      undefined,
      "current_recollection",
    );
    memory.revise();
    await expect(f.runtime.dispatch(request)).rejects.toThrow("memory_changed");
    expect(f.provider.requests).toHaveLength(0);
    expect(f.repository.getAttempt(request.attemptId)?.runId).toBeUndefined();
  });

  it.each(["metadata", "count"] as const)(
    "checks Memory again inside allocation after asynchronous %s preparation",
    async (phase) => {
      const f = await fixture();
      const memory = savedRecollection(f);
      const request = prepare(
        f,
        memory.evidence,
        {},
        undefined,
        "current_recollection",
      );
      if (phase === "metadata") {
        const resolveLimits = f.provider.resolveContextLimits.bind(f.provider);
        vi.spyOn(f.provider, "resolveContextLimits").mockImplementationOnce(
          async () => {
            const limits = await resolveLimits();
            memory.revise();
            return limits;
          },
        );
      } else {
        const measure = f.provider.measureInput.bind(f.provider);
        vi.spyOn(f.provider, "measureInput").mockImplementationOnce(
          async (input, signal) => {
            const result = await measure(input, signal);
            memory.revise();
            return { ...result, exactInputTokens: 100 };
          },
        );
      }
      await expect(f.runtime.dispatch(request)).rejects.toThrow(
        "decision changed",
      );
      expect(f.provider.requests).toHaveLength(0);
      expect(f.repository.getAttempt(request.attemptId)?.runId).toBeUndefined();
      expect(
        f.database.prepare("SELECT count(*) AS n FROM runs").get(),
      ).toEqual({
        n: 0,
      });
    },
  );

  it.each(["history", "current_recollection"] as const)(
    "withdraws a selected %s when its read-time qualification changes during generation",
    async (use) => {
      const f = await fixture();
      const memory = savedRecollection(f);
      const request = prepare(f, memory.evidence, {}, undefined, use);
      const { runId } = await f.runtime.dispatch(request);
      await f.provider.entered.promise;
      memory.revise();
      f.provider.release.resolve();
      await f.waitTerminal(runId);
      expect(f.runs.getRun(runId)).toBeUndefined();
      expect(f.projectMessage).not.toHaveBeenCalled();
      f.runtime.restoreSurfaces();
      expect(f.projectMessage).not.toHaveBeenCalled();
    },
  );

  it("allows a fresh account of a corrected record and supplies its actual qualification to the Agent", async () => {
    const f = await fixture();
    const memory = savedRecollection(f);
    const correction = f.memoryRepository.revise({
      memoryId: memory.item.memoryId,
      revisionId: randomUUID(),
      predecessorRevisionId: memory.item.revisionId,
      priorDispositions: [
        { revisionId: memory.item.revisionId, disposition: "corrected" },
      ],
      content: "更正：用户希望陶艺完成时先安静陪着，先前祝贺偏好记错了。",
      now: f.clock.now(),
      sources: [],
      reason: "修正原先记录的内容",
    });
    const request = prepare(
      f,
      {
        ...memory.evidence,
        recollection: {
          ...memory.evidence.recollection!,
          current: false,
          historyStatus: "corrected",
          historyStatusRevisionId: correction.memory.currentRevisionId,
        },
      },
      {
        instruction:
          "说明原先记录过的祝贺偏好已被纠正，不能再当成用户的真实偏好。",
      },
    );
    const attempt = f.repository.getAttempt(request.attemptId)!;
    const context = attachSelectedRecollections(
      f.repository.readActionContext(attempt, 8000, (value) => value),
      attempt,
      f.memory,
      f.repository.actionRecollectionRequest(attempt),
      8000,
    );
    expect(context.evidencePack?.items[0]).toMatchObject({
      revisionId: memory.item.revisionId,
      historyStatus: "corrected",
      historyStatusRevisionId: correction.memory.currentRevisionId,
    });
    const { runId } = await f.runtime.dispatch({
      ...request,
      prepareContext: () => context,
    });
    await f.provider.entered.promise;
    const wire = JSON.stringify(f.provider.requests[0]!.input);
    expect(wire).toContain("corrected");
    expect(wire).toContain(correction.memory.currentRevisionId);
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.projectMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["archive", "purge"] as const)(
    "does not publish a historical recollection after Memory %s",
    async (operation) => {
      const f = await fixture();
      const memory = savedRecollection(f);
      const { runId } = await f.runtime.dispatch(prepare(f, memory.evidence));
      await f.provider.entered.promise;
      if (operation === "purge") f.memory.delete(memory.item.memoryId);
      f.memory[operation](memory.item.memoryId);
      f.provider.release.resolve();
      await f.waitTerminal(runId);
      expect(f.projectMessage).not.toHaveBeenCalled();
      f.runtime.restoreSurfaces();
      expect(f.projectMessage).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "establishes the character's own Chat and reuses it for the next autonomous Run with quiet=%s",
    async (quiet) => {
      const f = await fixture();
      if (quiet) {
        f.provider.turns = [
          [
            {
              type: "response.completed",
              responseId: "quiet-own-life",
              status: "completed",
              usage: {
                inputTokens: 100,
                outputTokens: 1,
                cachedInputTokens: 0,
              },
            },
          ],
        ];
      }
      const intentId = randomUUID();
      f.cognition.saveCharacterIntent({
        id: intentId,
        personaId: f.persona.personaId,
        revision: 1,
        owner: "character",
        basis: "character",
        status: "active",
        goal: "继续做自己的小灯",
        successCriteria: [],
        evidenceIds: [],
        blockers: [],
        resumeConditions: [],
        progress: "",
        effectEvidenceIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const choice = {
        kind: "continue_character" as const,
        intentId,
        executionScope: "territory" as const,
        userImpact: "none" as const,
        reversibility: "undoable" as const,
      };
      f.provider.turns.push(f.provider.turns[0]!);
      const first = await f.runtime.dispatch(
        prepare(f, { actor: "agent" }, choice),
      );
      const firstRun = f.runs.getRun(first.runId)!;
      expect(f.messages.getChat(firstRun.chatId)?.status).toBe("active");
      expect(f.repository.characterRunIds(f.persona.personaId)).toContain(
        first.runId,
      );
      await f.provider.entered.promise;
      f.provider.release.resolve();
      await f.waitTerminal(first.runId);
      const second = await f.runtime.dispatch(
        prepare(f, { actor: "agent" }, choice),
      );
      await f.waitTerminal(second.runId);
      expect(second.runId).not.toBe(first.runId);
      expect(f.runs.getRun(second.runId)?.chatId).toBe(firstRun.chatId);
      expect(f.runs.getRun(second.runId)?.status).toBe("completed");
      expect(f.messages.getChat(firstRun.chatId)?.status).toBe("active");
      expect(
        f.database.prepare("SELECT count(*) AS n FROM chats").get(),
      ).toEqual({ n: 1 });
      expect(f.projectMessage).not.toHaveBeenCalled();
      if (quiet) {
        expect(f.messages.listRunMessages(first.runId)).toEqual([]);
        expect(f.messages.listRunMessages(second.runId)).toEqual([]);
        expect(f.repository.getIntent(intentId)).toMatchObject({
          status: "active",
          effectEvidenceIds: [],
        });
      }
    },
  );

  it("persists a real collected Tool result without projecting it as a placed world object", async () => {
    const f = await fixture();
    const intentId = randomUUID();
    f.cognition.saveCharacterIntent({
      id: intentId,
      personaId: f.persona.personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "制作一盏小灯",
      successCriteria: [],
      evidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "",
      effectEvidenceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    f.tools.register({
      descriptor: {
        name: "territory.generate_item",
        namespace: "territory",
        description: "Create a local virtual object",
        summary: "制作小灯",
        source: "builtin",
        itemKind: "tool_call",
        effect: "write",
        idempotency: "idempotent",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      execute: () =>
        Promise.resolve({
          status: "success",
          summary: "小灯已生成并收入收藏，尚未放置。",
          artifacts: [],
          retryable: false,
          modelContent: {
            status: "applied",
            worldRevisionChangedSinceCreation: false,
            placement: { kind: "collection" },
          },
        }),
      summarize: () => "制作小灯",
    });
    expect(
      f.runtime.availability(f.persona.personaId).characterTools,
    ).toContainEqual({
      name: "territory.generate_item",
      summary: "制作小灯",
      description: "Create a local virtual object",
      effect: "write",
    });
    f.provider.turns.unshift([
      {
        type: "output.item",
        item: {
          type: "function_call",
          call_id: "create-lamp",
          namespace: "territory",
          name: "generate_item",
          arguments: "{}",
        },
      },
      {
        type: "response.completed",
        responseId: "tool-step",
        status: "completed",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
      },
    ]);
    const request = prepare(
      f,
      { actor: "agent" },
      {
        kind: "continue_character",
        intentId,
        executionScope: "territory",
        userImpact: "none",
        reversibility: "undoable",
      },
    );
    const { runId } = await f.runtime.dispatch(request);
    await f.provider.entered.promise;
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.status).toBe("completed");
    const toolItem = f.runs
      .listRunItems(runId)
      .find((item) => item.kind === "tool_call");
    expect(toolItem?.output).toMatchObject({
      status: "success",
      modelContent: { placement: { kind: "collection" } },
    });
    const receipt = f.cognition
      .getSnapshot(f.persona.personaId)
      .evidence.find((evidence) => evidence.effect?.itemId === toolItem?.id);
    expect(receipt?.effect).toMatchObject({
      runId,
      outcome: "performed",
      worldChange: "collected",
    });
    expect(
      f.runtime
        .reconcileRun(runId)
        .evidence.find((evidence) => evidence.effect?.itemId === toolItem?.id)
        ?.effect?.worldChange,
    ).toBe("collected");
    expect(f.projectMessage).not.toHaveBeenCalled();
  });

  it.each(["activity", "memory_event"] as const)(
    "projects a %s offer through the actual desktop/mobile routing contract",
    async (sourceKind) => {
      const f = await fixture();
      const chat = f.chats.create({});
      const request =
        sourceKind === "activity"
          ? prepare(f)
          : prepare(
              f,
              {
                actor: "system",
                source: { kind: "memory", id: randomUUID(), revision: "1" },
                chatId: chat.id,
                opportunity: {
                  id: randomUUID(),
                  targetChatId: chat.id,
                  evaluateAt: NOW,
                  occursAt: "2026-09-15T09:00:00.000Z",
                  status: "due",
                },
              },
              { chatId: chat.id },
            );
      const { runId } = await f.runtime.dispatch(request);
      await f.provider.entered.promise;
      f.provider.release.resolve();
      await f.waitTerminal(runId);
      const message = f.messages
        .listRunMessages(runId)
        .findLast((m) => m.role === "assistant")!;
      expect(f.projectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: message.id }),
        sourceKind,
      );
      if (sourceKind === "activity") {
        expect(f.surface.current()?.id).toBe(runId);
        expect(f.enqueueAndroidMailbox).not.toHaveBeenCalled();
        expect(f.bridge.getMessageProjection(message.id)).toBeUndefined();
      } else {
        await vi.waitFor(() =>
          expect(f.bridge.getMessageProjection(message.id)?.state).toBe(
            "acknowledged",
          ),
        );
        expect(f.enqueueAndroidMailbox).toHaveBeenCalledTimes(1);
        expect(f.bridge.getMessageProjection(message.id)?.surface).toBe(
          "android_notification",
        );
        expect(f.surface.current()).toBeUndefined();
        expect(
          JSON.stringify(f.enqueueAndroidMailbox.mock.calls[0]![0].request),
        ).toContain(message.content);
      }
      expect(f.history.listRecent()).toHaveLength(1);
      const terminal = f.events.find(
        (e) => e.streamId === runId && e.event.type === "run.completed",
      )!;
      f.runtime.observeRun(terminal);
      f.runtime.restoreSurfaces();
      expect(f.projectMessage).toHaveBeenCalledTimes(1);
      expect(f.enqueueAndroidMailbox).toHaveBeenCalledTimes(
        sourceKind === "memory_event" ? 1 : 0,
      );
    },
  );

  it("passes only the decided EvidencePack to the shared assistant-origin Run", async () => {
    const f = await fixture();
    const memoryId = randomUUID(),
      revisionId = randomUUID();
    const pack = {
      items: [
        {
          memoryId,
          revisionId,
          type: "event" as const,
          content: "用户期待自己第一次烧制的小杯。",
          historyStatus: "current" as const,
          entityIds: [],
          sourceRefs: [],
          recordedAt: NOW,
          current: true,
          questionIds: ["q1"],
        },
      ],
      coverage: [
        {
          questionId: "q1",
          status: "supported" as const,
          revisionIds: [revisionId],
        },
      ],
      gaps: [],
      estimatedTokens: 100,
      truncated: false,
      incompleteReasons: [],
    };
    const request = prepare(
      f,
      {},
      {},
      {
        situationIds: [],
        intentIds: [],
        evidenceIds: [],
        text: "已决定的陶艺情境",
        evidencePack: pack,
      },
    );
    const { runId } = await f.runtime.dispatch(request);
    await f.provider.entered.promise;
    expect(JSON.stringify(f.provider.requests[0])).toContain(
      pack.items[0]!.content,
    );
    expect(
      f.runs.listRunItems(runId).some((item) => item.kind === "user_message"),
    ).toBe(false);
    expect(
      f.messages
        .listRunMessages(runId)
        .some((message) => message.role === "user"),
    ).toBe(false);
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.status).toBe("completed");
    expect(f.surface.current()?.id).toBe(runId);
  });

  it("reserves one Run and one provisional Chat when the same decision dispatches concurrently", async () => {
    const f = await fixture();
    const request = prepare(f);
    const results = await Promise.all([
      f.runtime.dispatch(request),
      f.runtime.dispatch(request),
    ]);
    expect(results[0]).toEqual(results[1]);
    await f.provider.entered.promise;
    expect(f.provider.requests).toHaveLength(1);
    expect(f.database.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({
      n: 1,
    });
    expect(f.database.prepare("SELECT count(*) AS n FROM chats").get()).toEqual(
      { n: 1 },
    );
    f.provider.release.resolve();
    await f.waitTerminal(results[0].runId);
    expect(await f.runtime.dispatch(request)).toEqual(results[0]);
  });

  it("does not offer the old reply after the user corrects its decision", async () => {
    const f = await fixture();
    const request = prepare(f);
    const { runId } = await f.runtime.dispatch(request);
    await f.provider.entered.promise;
    f.cognition.ingest({
      id: randomUUID(),
      personaId: f.persona.personaId,
      actor: "user",
      source: { kind: "message", id: randomUUID() },
      observedAt: f.clock.now(),
      kind: "control",
      control: "user_correction",
      text: "不是我的杯子，先别提这个。",
    });
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.projectMessage).not.toHaveBeenCalled();
    expect(f.history.listRecent()).toEqual([]);
    expect(f.surface.current()).toBeUndefined();
    f.runtime.restoreSurfaces();
    expect(f.projectMessage).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "expired"] as const)(
    "does not project an opportunity reply after its source is %s",
    async (change) => {
      const f = await fixture();
      const chat = f.chats.create({});
      const opportunityId = randomUUID(),
        memoryId = randomUUID();
      const cue = {
        id: opportunityId,
        targetChatId: chat.id,
        evaluateAt: NOW,
        occursAt: "2026-09-15T09:00:00.000Z",
        status: "due" as const,
      };
      const request = prepare(
        f,
        {
          actor: "system",
          source: { kind: "memory", id: memoryId, revision: "1" },
          chatId: chat.id,
          opportunity: cue,
        },
        { chatId: chat.id },
      );
      const { runId } = await f.runtime.dispatch(request);
      await f.provider.entered.promise;
      if (change === "cancelled")
        f.cognition.ingest({
          id: randomUUID(),
          personaId: f.persona.personaId,
          actor: "system",
          source: { kind: "memory", id: memoryId, revision: "2" },
          chatId: chat.id,
          observedAt: NOW,
          kind: "observation",
          opportunity: { ...cue, status: "cancelled" },
          text: "用户改期，先前机会已取消。",
        });
      else f.clock.advance(60 * 60 * 1000);
      f.provider.release.resolve();
      await f.waitTerminal(runId);
      expect(f.projectMessage).not.toHaveBeenCalled();
      expect(f.history.listRecent()).toEqual([]);
      f.runtime.restoreSurfaces();
      expect(f.projectMessage).not.toHaveBeenCalled();
    },
  );

  it("records accepted projection once across terminal event replay and surface restoration", async () => {
    const f = await fixture();
    const { runId } = await f.runtime.dispatch(prepare(f));
    await f.provider.entered.promise;
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    const completed = f.events.find(
      (e) => e.streamId === runId && e.event.type === "run.completed",
    )!;
    f.runtime.observeRun(completed);
    f.runtime.restoreSurfaces();
    expect(f.projectMessage).toHaveBeenCalledTimes(1);
    expect(f.history.listRecent()).toHaveLength(1);
    expect(
      f.repository
        .getSnapshot(f.persona.personaId, NOW)
        .evidence.filter(
          (e) =>
            e.source.id === runId && e.source.revision === "surface:offered",
        ),
    ).toHaveLength(1);
  });
});

describe("native Activity evidence handoff", () => {
  it.each(["history", "current_foreground"] as const)(
    "uses the %s declaration when the visible object changes before delivery",
    async (use) => {
      const f = await fixture();
      const request = prepare(
        f,
        { object: { key: "drawing:cat", identity: "adapter" } },
        {},
        undefined,
        use,
      );
      const { runId } = await f.runtime.dispatch(request);
      await f.provider.entered.promise;
      f.clock.advance(1_000);
      f.cognition.ingest({
        id: randomUUID(),
        personaId: f.persona.personaId,
        actor: "user",
        source: { kind: "activity", id: randomUUID() },
        observedAt: f.clock.now(),
        kind: "observation",
        boundary: "window",
        object: { key: "mail:inbox", identity: "adapter" },
        text: "用户切到了收件箱。",
      });
      f.provider.release.resolve();
      await f.waitTerminal(runId);
      expect(f.projectMessage).toHaveBeenCalledTimes(use === "history" ? 1 : 0);
    },
  );

  it("rechecks availability during allocation after asynchronous model preparation", async () => {
    const f = await fixture();
    const request = prepare(f);
    const resolveLimits = f.provider.resolveContextLimits.bind(f.provider);
    vi.spyOn(f.provider, "resolveContextLimits").mockImplementationOnce(
      async () => {
        const limits = await resolveLimits();
        f.activeVoice.mockReturnValue(true);
        return limits;
      },
    );
    await expect(f.runtime.dispatch(request)).rejects.toThrow(
      "decision changed",
    );
    expect(f.provider.requests).toHaveLength(0);
    expect(f.repository.getAttempt(request.attemptId)?.runId).toBeUndefined();
  });

  it("does not publish a completed sentence after the actual Persona revision changes", async () => {
    const f = await fixture();
    const { runId } = await f.runtime.dispatch(prepare(f));
    await f.provider.entered.promise;
    f.persona.revision += 1;
    f.provider.release.resolve();
    await f.waitTerminal(runId);
    expect(f.projectMessage).not.toHaveBeenCalled();
  });

  it.each(["user", "unknown"] as const)(
    "rechecks the real capture owner before starting and publishing an offer without requiring a new journal event (%s)",
    async (actor) => {
      const f = await fixture();
      const surface = {
        id: "window:77",
        epoch: "capture-generation:2",
        displayId: "1",
        windowId: "77",
        processId: 200,
        appName: "Fixture editor",
        bounds: { x: 5, y: 10, width: 900, height: 700 },
        scaleFactor: 2,
        clipped: false,
      };
      const request = prepare(
        f,
        {
          actor,
          object: {
            key: "surface:window:77:capture-generation:2",
            identity: "adapter",
          },
          visual: {
            eventId: randomUUID(),
            artifactId: randomUUID(),
            contentRevision: "frame-42",
            surface,
            capturedAt: NOW,
            width: 1800,
            height: 1400,
            trigger: "frame",
          },
        },
        {},
        undefined,
        "current_foreground",
      );
      f.isCurrentVisualSource.mockReturnValue(false);
      await expect(f.runtime.dispatch(request)).rejects.toThrow(
        "decision changed",
      );
      expect(f.provider.requests).toHaveLength(0);
      f.isCurrentVisualSource.mockReturnValue(true);
      const { runId } = await f.runtime.dispatch(request);
      await f.provider.entered.promise;
      f.isCurrentVisualSource.mockReturnValue(false);
      f.provider.release.resolve();
      await f.waitTerminal(runId);
      expect(f.isCurrentVisualSource).toHaveBeenCalledWith({
        surface,
        actor,
      });
      expect(f.projectMessage).not.toHaveBeenCalled();
    },
  );

  it("binds current pixels and AX text to one real surface with the capture sequence", async () => {
    const f = await fixture();
    const surface = {
      id: "window:77",
      epoch: "capture-generation:2",
      displayId: "1",
      windowId: "77",
      processId: 200,
      appName: "Fixture editor",
      appId: "dev.fixture.editor",
      windowTitle: "Travel notes",
      bounds: { x: 5, y: 10, width: 900, height: 700 },
      scaleFactor: 2,
      clipped: false,
    };
    const appEventId = randomUUID();
    f.runtime.observeActivity({
      id: appEventId,
      actor: "user",
      startedAt: NOW,
      details: {
        source: "active_app",
        appName: surface.appName,
        appId: surface.appId,
        windowTitle: surface.windowTitle,
        surface,
        boundary: "content",
        contentStatus: "available",
        content: {
          source: "accessibility",
          scope: "focused_element",
          text: "旅行备忘",
        },
      },
    });
    f.clock.advance(1_000);
    const capturedAt = f.clock.now();
    const eventId = randomUUID();
    const artifactId = randomUUID();
    f.runtime.observeActivity({
      id: eventId,
      actor: "user",
      startedAt: capturedAt,
      details: {
        source: "screenshot",
        artifactId,
        width: 1800,
        height: 1400,
        mediaType: "image/png",
        storageKey: "fixture.png",
        ocrText: "预算 980",
        visual: {
          surface,
          capturedAt,
          receivedAt: capturedAt,
          contentRevision: "frame-42",
          sequence: 42,
          coalescedFrames: 11,
          trigger: "frame",
          redactedRegions: 0,
          ocr: {
            engine: "apple_vision",
            revision: 3,
            languages: ["zh-Hans"],
            status: "complete",
            lines: [],
          },
        },
      },
    });
    const snapshot = f.repository.getSnapshot(
      f.persona.personaId,
      f.clock.now(),
    );
    const appEvidence = snapshot.evidence.find(
      ({ source }) => source.id === appEventId,
    )!;
    const imageEvidence = snapshot.evidence.find(
      ({ source }) => source.id === eventId,
    )!;
    expect(imageEvidence.object).toEqual(appEvidence.object);
    expect(imageEvidence).toMatchObject({
      actor: "user",
      observedAt: capturedAt,
      text: "预算 980",
      sourceSequence: 42,
      sourceEpoch: "visual:window:77:capture-generation:2",
      source: { kind: "activity", id: eventId, revision: "frame-42" },
      visual: {
        eventId,
        artifactId,
        surface,
        contentRevision: "frame-42",
        capturedAt,
      },
    });
    expect(snapshot.attention.foregroundObject?.key).toBe(
      "surface:window:77:capture-generation:2",
    );
  });
  it("preserves source-declared truncation through the actual Activity to Cognition boundary", async () => {
    const f = await fixture();
    const eventId = randomUUID();
    f.runtime.observeActivity({
      id: eventId,
      actor: "unknown",
      startedAt: NOW,
      details: {
        source: "active_app",
        appName: "Fixture editor",
        contentStatus: "available",
        content: {
          source: "accessibility",
          scope: "focused_element",
          text: "An actual prefix only",
          truncated: true,
        },
      },
    });
    const evidence = f.repository
      .getSnapshot(f.persona.personaId, f.clock.now())
      .evidence.find(({ source }) => source.id === eventId);
    expect(evidence).toMatchObject({
      actor: "unknown",
      text: "An actual prefix only",
      visibility: {
        status: "available",
        source: "accessibility",
        scope: "focused_element",
        truncated: true,
      },
    });
  });
});

function attentionTurn(name?: string, arguments_: object = {}): ModelEvent[] {
  return [
    ...(name
      ? [
          {
            type: "output.item" as const,
            item: {
              type: "function_call",
              name,
              call_id: randomUUID(),
              arguments: JSON.stringify(arguments_),
            },
          },
        ]
      : [{ type: "text.delta" as const, delta: "已按你现在的意思继续。" }]),
    {
      type: "response.completed",
      responseId: randomUUID(),
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
    },
  ];
}

const attentionQuestion = {
  questions: [
    {
      id: "next",
      header: "安排",
      question: "接下来想做什么？",
      options: [
        { label: "聊天", description: "说说今天。" },
        { label: "阅读", description: "读一点书。" },
      ],
    },
  ],
};

function ownActivity(f: Fixture) {
  const intentId = randomUUID();
  f.cognition.saveCharacterIntent({
    id: intentId,
    personaId: f.persona.personaId,
    revision: 1,
    owner: "character",
    basis: "character",
    status: "active",
    goal: "去椅子上坐一会儿",
    successCriteria: [],
    evidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "",
    effectEvidenceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return prepare(
    f,
    { actor: "agent" },
    {
      kind: "continue_character",
      intentId,
      executionScope: "territory",
      userImpact: "none",
      reversibility: "undoable",
    },
  );
}

function attentionWorld(f: Fixture) {
  const repository = new TerritoryWorldRepository(f.database, f.ids);
  repository.ensureInitialized(createStarterTerritoryWorldSeed(NOW));
  const world = new TerritoryWorldService(repository, f.clock);
  registerTerritoryTools(f.tools, {
    runs: f.runs,
    territory: world,
    candidates: {
      createAutonomousItem: () =>
        Promise.reject(new Error("No image creation in this fixture")),
    },
  });
  return world;
}

describe("waiting Runs and actual user takeover", () => {
  it.each(["steer", "answer", "approve", "reject", "resume"] as const)(
    "lets a waiting ordinary Run coexist with a real Territory action, then awaits its Tool exit on %s",
    async (method) => {
      let f = await fixture(undefined, undefined, true);
      let world = attentionWorld(f);
      let priorModelRequests = 0;
      const observation = world.observePetActions();
      const seat = observation.targets.find(
        (target) => target.reachable && target.actions.includes("sit"),
      );
      expect(seat).toBeDefined();
      const effects: string[] = [];
      f.tools.register({
        descriptor: {
          name: "test.write",
          namespace: "test",
          source: "builtin",
          itemKind: "tool_call",
          description: "A local fixture write",
          summary: "写入测试记录",
          effect: "write",
          idempotency: "non_idempotent",
          inputSchema: Type.Object({}, { additionalProperties: false }),
        },
        execute: () => {
          effects.push("user-write");
          return Promise.resolve({
            status: "success",
            summary: "已写入",
            modelContent: { written: true },
            artifacts: [],
            retryable: false,
          });
        },
        summarize: () => "写入测试记录",
      });
      const approval = method === "approve" || method === "reject";
      f.provider.turns = [
        method === "resume"
          ? new ProviderError(
              "PROVIDER.REQUEST_FAILED",
              "Interrupted fixture request",
              true,
            )
          : attentionTurn(
              approval ? "test.write" : "interaction.request_user_input",
              approval ? {} : attentionQuestion,
            ),
        attentionTurn("territory.observe"),
        attentionTurn("territory.act", {
          action: "sit",
          expectedRevisionId: observation.revisionId,
          target: { kind: "instance", instanceId: seat!.instanceId },
        }),
        attentionTurn("territory.observe"),
        attentionTurn(),
      ];
      f.provider.release.resolve();
      const chat = f.chats.create({});
      const ordinary = await f.agent.start({
        attachments: [],
        chatId: chat.id,
        content: "先问清楚，再处理这件事。",
        execution: { mode: "agent", approvalMode: "request_approval" },
        providerProfileId: f.providers.getDefaultChatProfileId(),
        requestedAt: NOW,
      });
      const waitingStatus =
        method === "resume"
          ? "interrupted"
          : approval
            ? "waiting_approval"
            : "needs_input";
      await f.waitStatus(ordinary.id, waitingStatus);
      if (method === "resume") {
        const directory = f.directory;
        const remainingTurns = [...f.provider.turns];
        priorModelRequests = f.provider.requests.length;
        await f.closeForRestart();
        f = await fixture(undefined, directory, true);
        world = attentionWorld(f);
        f.provider.turns = remainingTurns;
        f.provider.release.resolve();
        await f.agent.initialize();
      }
      expect(f.runtime.availability(f.persona.personaId)).toMatchObject({
        userEngaged: false,
        activeUserRunIds: [],
      });
      const entered = deferred();
      const abortSeen = deferred();
      const releaseExit = deferred();
      const reader = f.tools.get("territory.observe")!;
      const original = reader.execute.bind(reader);
      let reads = 0;
      vi.spyOn(reader, "execute").mockImplementation(async (input, context) => {
        reads += 1;
        if (reads === 2) {
          entered.resolve();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                abortSeen.resolve();
                resolve();
              },
              { once: true },
            );
          });
          await releaseExit.promise;
          effects.push("character-tool-exited");
          context.signal.throwIfAborted();
        }
        return original(input, context);
      });
      const request = ownActivity(f);
      const own = await f.runtime.dispatch(request);
      cleanup.push(async () => {
        releaseExit.resolve();
        await f.agent.cancel({ runId: own.runId, requestedAt: NOW });
        await f.agent.cancel({ runId: ordinary.id, requestedAt: NOW });
      });
      await entered.promise;
      expect(world.getSnapshot().pet.behavior).toBe("sitting");
      expect(f.runs.getRun(ordinary.id)?.status).toBe(waitingStatus);
      expect(
        f.runs
          .listRunItems(own.runId)
          .findLast(
            ({ kind, status }) =>
              kind === "tool_call" && status === "completed",
          ),
      ).toMatchObject({
        output: {
          status: "success",
          modelContent: { status: "performed", action: "sit" },
        },
      });
      const input = f.runs
        .listRunItems(ordinary.id)
        .find((item) => item.kind === "input_request");
      const pending = f.agent.getPendingApproval();
      const continuation =
        method === "steer"
          ? f.agent.steer({
              runId: ordinary.id,
              requestedAt: NOW,
              content: "先不安排了，聊聊今天吧。",
            })
          : method === "answer"
            ? f.agent.resolveUserInput({
                runId: ordinary.id,
                itemId: input!.id,
                resolution: {
                  status: "answered",
                  resolvedAt: NOW,
                  answers: [
                    {
                      questionId: "next",
                      value: { kind: "text", text: "先聊天" },
                    },
                  ],
                },
              })
            : method === "resume"
              ? f.agent.resume({ runId: ordinary.id, requestedAt: NOW })
              : f.agent.resolveApproval({
                  approvalId: pending!.id,
                  decidedAt: NOW,
                  decision: method === "approve" ? "approved" : "rejected",
                });
      await abortSeen.promise;
      expect(f.runs.getRun(ordinary.id)?.status).toBe(waitingStatus);
      expect(priorModelRequests + f.provider.requests.length).toBe(4);
      expect(effects).toEqual([]);
      releaseExit.resolve();
      await continuation;
      await f.waitStatus(ordinary.id, "completed");
      expect(f.runs.getRun(own.runId)?.status).toBe("cancelled");
      expect(f.runs.getRun(ordinary.id)?.status).toBe("completed");
      expect(effects).toEqual(
        method === "approve"
          ? ["character-tool-exited", "user-write"]
          : ["character-tool-exited"],
      );
      expect(world.getSnapshot().pet.behavior).toBe("sitting");
      expect(f.runs.listRunsByStatus(["completed"])).toHaveLength(1);
    },
  );

  it.each(["steer", "answer"] as const)(
    "continues its own bound question through %s while invalidating old PFC authority without self-cancellation",
    async (method) => {
      const analyzing = deferred();
      const pfcAborted = deferred();
      const f = await fixture(
        (_input, signal) =>
          new Promise((_resolve, reject) => {
            analyzing.resolve();
            signal.addEventListener(
              "abort",
              () => {
                pfcAborted.resolve();
                reject(new DOMException("PFC fixture aborted", "AbortError"));
              },
              { once: true },
            );
          }),
        undefined,
        true,
      );
      f.provider.turns = [
        attentionTurn("interaction.request_user_input", attentionQuestion),
        attentionTurn(),
      ];
      f.provider.release.resolve();
      const request = ownActivity(f);
      const { runId } = await f.runtime.dispatch(request);
      await f.waitStatus(runId, "needs_input");
      const item = f.runs
        .listRunItems(runId)
        .find((value) => value.kind === "input_request")!;
      const attempt = f.repository.getAttempt(request.attemptId)!;
      expect(await f.runtime.dispatch(request)).toEqual({ runId });
      expect(
        f.repository.choiceBlockReason(
          request.choice,
          f.persona.personaId,
          f.runtime.availability(f.persona.personaId),
        ),
      ).toBe("character_run_active");
      f.clock.advance(1);
      f.cognition.notifyVisualChange();
      const pfc = f.cognition.runDue();
      await analyzing.promise;
      const beforeGeneration = f.cognition.getSnapshot(f.persona.personaId)
        .attention.userGeneration;
      if (method === "steer")
        await f.agent.steer({
          runId,
          requestedAt: NOW,
          content: "说说你刚才想做的事情。",
        });
      else
        await f.agent.resolveUserInput({
          runId,
          itemId: item.id,
          resolution: {
            status: "answered",
            resolvedAt: NOW,
            answers: [
              { questionId: "next", value: { kind: "text", text: "先聊聊" } },
            ],
          },
        });
      await pfcAborted.promise;
      await pfc;
      await f.waitTerminal(runId);
      expect(f.runs.getRun(runId)?.status).toBe("completed");
      expect(f.repository.getAttempt(request.attemptId)?.runId).toBe(runId);
      expect(f.repository.actionFreshness(attempt, f.clock.now()).current).toBe(
        false,
      );
      expect(
        f.cognition.getSnapshot(f.persona.personaId).attention.userGeneration,
      ).toBeGreaterThan(beforeGeneration);
      expect(
        f.events.filter(
          (event) =>
            event.streamId === runId && event.event.type === "run.cancelled",
        ),
      ).toEqual([]);
      expect(f.runs.listRunsByStatus(["completed"])).toHaveLength(1);
      const count = f.cognition.getSnapshot(f.persona.personaId).attention
        .lastReceiptSequence;
      await f.agent.resolveUserInput({
        runId,
        itemId: item.id,
        resolution: { status: "cancelled", resolvedAt: NOW },
      });
      expect(
        f.cognition.getSnapshot(f.persona.personaId).attention
          .lastReceiptSequence,
      ).toBe(count);
    },
  );
});

describe("the continued bound Run keeps its identity", () => {
  it("does not cancel a bound assistant-initiated Agent approval or repeat its effect", async () => {
    const f = await fixture(undefined, undefined, true);
    const effects: string[] = [];
    f.tools.register({
      descriptor: {
        name: "test.write",
        namespace: "test",
        source: "builtin",
        itemKind: "tool_call",
        description: "Write one local fixture record",
        summary: "写入测试记录",
        effect: "write",
        idempotency: "non_idempotent",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      execute: () => {
        effects.push("written");
        return Promise.resolve({
          status: "success",
          summary: "已写入",
          modelContent: { written: true },
          artifacts: [],
          retryable: false,
        });
      },
      summarize: () => "写入测试记录",
    });
    f.provider.turns = [attentionTurn("test.write"), attentionTurn()];
    f.provider.release.resolve();
    const request = ownActivity(f);
    const chat = f.chats.create({});
    // Normal own-life dispatch is Chat/internal-Tool only and cannot need
    // approval. Exercise the public bound Agent entry without changing that rule.
    const run = await f.agent.startAssistantInitiated(
      {
        chatId: chat.id,
        attachments: [],
        content: "按审批决定处理这一条本地测试记录。",
        execution: { mode: "agent", approvalMode: "request_approval" },
        providerProfileId: f.providers.getDefaultChatProfileId(),
        requestedAt: NOW,
      },
      {
        modelId: "gpt-6-astra",
        persona: f.persona,
        toolNames: ["test.write"],
        prepareCognitionContext: request.prepareContext,
        allocation: {
          existing: () => {
            const id = f.repository.getAttempt(request.attemptId)?.runId;
            return id ? f.runs.getRun(id) : undefined;
          },
          bind: (id) => {
            f.repository.bindDispatched(request.dispatchKey, id, f.clock.now());
          },
        },
      },
    );
    cleanup.push(async () => {
      await f.agent.cancel({ runId: run.id, requestedAt: NOW });
    });
    await f.waitStatus(run.id, "waiting_approval");
    expect(f.runtime.availability(f.persona.personaId)).toMatchObject({
      userEngaged: false,
      activeUserRunIds: [],
      activeCharacterRunId: run.id,
    });
    expect(await f.runtime.dispatch(request)).toEqual({ runId: run.id });
    const approval = f.agent.getPendingApproval()!;
    const resolution = {
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "approved" as const,
    };
    await f.agent.resolveApproval(resolution);
    await f.waitTerminal(run.id);
    expect(f.runs.getRun(run.id)?.status).toBe("completed");
    expect(f.repository.getAttempt(request.attemptId)?.runId).toBe(run.id);
    expect(effects).toEqual(["written"]);
    const receipts = f.cognition.getSnapshot(f.persona.personaId).attention
      .lastReceiptSequence;
    await f.agent.resolveApproval(resolution);
    expect(
      f.cognition.getSnapshot(f.persona.personaId).attention
        .lastReceiptSequence,
    ).toBe(receipts);
    expect(effects).toEqual(["written"]);
  });

  it("keeps running execution, a queued projection, Voice, and paused Life as dispatch guards", async () => {
    const f = await fixture(undefined, undefined, true);
    const chat = f.chats.create({});
    const ordinary = await f.agent.start({
      chatId: chat.id,
      attachments: [],
      content: "请继续当前任务。",
      execution: { mode: "chat" },
      providerProfileId: f.providers.getDefaultChatProfileId(),
      requestedAt: NOW,
    });
    cleanup.push(async () => {
      f.provider.release.resolve();
      await f.agent.cancel({ runId: ordinary.id, requestedAt: NOW });
    });
    await f.provider.entered.promise;
    const runningRequest = ownActivity(f);
    expect(f.runtime.availability(f.persona.personaId)).toMatchObject({
      userEngaged: true,
      activeUserRunIds: [ordinary.id],
    });
    await expect(f.runtime.dispatch(runningRequest)).rejects.toThrow(
      "runtime_unavailable",
    );
    f.provider.release.resolve();
    await f.waitTerminal(ordinary.id);
    const queued: Run = {
      ...ordinary,
      id: randomUUID(),
      status: "queued",
    };
    // run.started always allocates a running Run. Exercise the declared queued
    // availability projection without inventing an invalid persisted event.
    const listRuns = f.runs.listRunsByStatus.bind(f.runs);
    const queuedProjection = vi
      .spyOn(f.runs, "listRunsByStatus")
      .mockImplementation((statuses) => [
        ...listRuns(statuses),
        ...(statuses.includes("queued") ? [queued] : []),
      ]);
    try {
      expect(f.runtime.availability(f.persona.personaId)).toMatchObject({
        userEngaged: true,
        activeUserRunIds: [queued.id],
      });
      await expect(f.runtime.dispatch(runningRequest)).rejects.toThrow(
        "runtime_unavailable",
      );
    } finally {
      queuedProjection.mockRestore();
    }
    const request = runningRequest;
    f.activeVoice.mockReturnValue(true);
    expect(f.runtime.availability(f.persona.personaId)).toMatchObject({
      userEngaged: true,
      activeVoice: true,
    });
    await expect(f.runtime.dispatch(request)).rejects.toThrow(
      "runtime_unavailable",
    );
    f.activeVoice.mockReturnValue(false);
    f.lifePaused.mockReturnValue(true);
    expect(f.runtime.availability(f.persona.personaId).mayActInTerritory).toBe(
      false,
    );
    await expect(f.runtime.dispatch(request)).rejects.toThrow(
      "runtime_unavailable",
    );
    expect(f.runs.listRunsByStatus(["running", "queued"])).toEqual([]);
  });
});

async function waitingMaterial(f: Fixture, existing?: Run) {
  const materialQuestion = {
    questions: [
      {
        id: "table",
        header: "表格",
        question: "怎样提供最新表格？",
        options: [
          { label: "粘贴内容", description: "发送当前相关几行。" },
          { label: "发截图", description: "发送最新画面。" },
        ],
      },
    ],
  };
  f.provider.turns = [
    attentionTurn("image.inspect", { activity: { current: true } }),
    attentionTurn("interaction.request_user_input", materialQuestion),
    modelText(
      "如果停车 40 是额外待付，660 加 40 是 700；已付押金 300 不再相加。",
    ),
  ];
  f.provider.release.resolve();
  const chat = existing
    ? f.messages.getChat(existing.chatId)!
    : f.chats.create({});
  const content = "再帮我看一下搬家费用表，已付押金不要重复计入。";
  const run =
    existing ??
    (await f.agent.start({
      chatId: chat.id,
      attachments: [],
      execution: { mode: "chat" },
      content,
      providerProfileId: f.providers.getDefaultChatProfileId(),
      requestedAt: f.clock.now(),
    }));
  if (existing)
    await f.agent.steer({
      runId: existing.id,
      content,
      requestedAt: f.clock.now(),
    });
  await f.waitStatus(run.id, "needs_input");
  const question = f.runs
    .listRunItems(run.id)
    .find(
      ({ kind, status }) =>
        kind === "input_request" && status === "waiting_input",
    )!;
  const user = f.repository
    .readSnapshot(f.persona.personaId, f.clock.now())
    .snapshot.evidence.find(
      (item) =>
        item.source.id === run.id &&
        item.actor === "user" &&
        item.kind === "utterance",
    )!;
  expect(user).toBeDefined();
  f.clock.advance(1000);
  const material = f.repository.ingest(
    {
      id: randomUUID(),
      personaId: f.persona.personaId,
      source: { kind: "activity", id: randomUUID() },
      actor: "unknown",
      kind: "observation",
      boundary: "content",
      observedAt: f.clock.now(),
      object: { key: "moving-table", identity: "adapter" },
      text: "本次仍需付款660，另加临时停车40，新的应付总计660。已付押金300。",
    },
    f.clock.now(),
  ).evidence;
  const output: CognitionAnalysis = {
    delta: {
      ...emptyDelta,
      createIntents: [
        {
          localId: "new:review",
          value: {
            owner: "user",
            basis: "explicit_user",
            status: "active",
            goal: "核对当前费用表，押金不重复计入",
            successCriteria: ["给出当前可见费用的核对结果"],
            evidenceIds: [user.id],
            blockers: [],
            progress: "最新文字已出现，仍需实际核对",
            effectEvidenceIds: [],
            resumeConditions: [],
          },
        },
      ],
    },
    decision: {
      choices: [
        {
          id: "review",
          kind: "continue_shared",
          chatId: chat.id,
          intentId: "new:review",
          evidenceIds: [user.id, material.id],
          rationale: "索取的表格文字现已可供核对",
          userImpact: "light",
          executionScope: "conversation",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
          instruction: "基于当前视口核对，押金不重复计入；不声称修改或付款。",
        },
      ],
      selectedChoiceId: "review",
      reason: "相关材料补足原问题",
      selectedBasis: {
        choiceId: "review",
        evidenceUses: [
          { evidenceId: user.id, use: "history" },
          { evidenceId: material.id, use: "current_object" },
        ],
        currentClaimRefs: [],
        waitingInputContinuation: {
          runId: run.id,
          itemId: question.id,
          requestEvidenceId: user.id,
        },
      },
    },
  };
  const commit = (value = output): CognitionDispatchRequest => {
    let attempt = f.repository.createAttempt(
      f.repository.readSnapshot(f.persona.personaId, f.clock.now()),
      "semantic_change",
      f.clock.now(),
    );
    attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    attempt = f.repository.commitAnalysis(attempt.id, value, f.clock.now());
    return {
      attemptId: attempt.id,
      dispatchKey: attempt.dispatchKey,
      personaId: f.persona.personaId,
      signal: new AbortController().signal,
      choice: attempt.decision!.choices[0]!,
      prepareContext: ({ maxReadBytes }) =>
        f.repository.readActionContext(
          attempt,
          maxReadBytes,
          (selected) => selected,
        ),
    };
  };
  return { run, chat, question, user, material, output, commit };
}

describe("sourced material continues the original waiting Run", () => {
  it("passes the new material and old failed Tool receipt to that same Run, without a user answer or new delivery owner", async () => {
    const f = await fixture();
    const h = await waitingMaterial(f);
    const request = h.commit();
    const prepare = vi.fn(request.prepareContext);
    const dispatched = { ...request, prepareContext: prepare };
    expect(
      f.runtime.availability(
        f.persona.personaId,
        f.repository.getAttempt(request.attemptId),
      ),
    ).toMatchObject({
      userEngaged: false,
      activeUserRunIds: [],
      chatRuns: [
        {
          runId: h.run.id,
          chatId: h.chat.id,
          status: "needs_input",
          waitingInput: { itemId: h.question.id },
        },
      ],
      continuableInput: { runId: h.run.id, itemId: h.question.id },
    });
    const result = await f.runtime.dispatch(dispatched);
    expect(result).toEqual({
      runId: h.run.id,
      continuedInputItemId: h.question.id,
    });
    await f.waitTerminal(h.run.id);
    const completed = f.runs.getRun(h.run.id)!;
    expect(completed).toMatchObject({
      status: "completed",
      provider: h.run.provider,
      persona: h.run.persona,
      execution: h.run.execution,
    });
    const items = f.runs.listRunItems(h.run.id);
    expect(items.filter(({ kind }) => kind === "user_message")).toHaveLength(1);
    expect(items.filter(({ kind }) => kind === "input_request")).toHaveLength(
      1,
    );
    expect(f.runs.getRunItem(h.question.id)).toMatchObject({
      status: "completed",
      output: {
        status: "context_available",
        attemptId: request.attemptId,
      },
    });
    expect(f.runs.getRunItem(h.question.id)?.output).toHaveProperty(
      "evidenceIds",
      expect.arrayContaining([h.material.id, h.user.id]),
    );
    expect(f.provider.requests).toHaveLength(3);
    const wire = JSON.stringify(f.provider.requests[2]!.input);
    expect(wire).toContain(h.material.text);
    expect(wire).toContain("IMAGE.INPUT_UNAVAILABLE");
    expect(wire).toContain("context_available");
    expect(wire).not.toContain("The user supplied structured answers");
    expect(wire).not.toContain(
      "The user cancelled the structured input request",
    );
    expect(
      f.messages
        .listRunMessages(h.run.id)
        .filter(({ role }) => role === "user"),
    ).toHaveLength(1);
    expect(f.messages.listRunMessages(h.run.id).at(-1)?.content).toContain(
      "700",
    );
    expect(f.repository.getAttempt(request.attemptId)).toMatchObject({
      status: "settled",
      outcome: "context_supplied",
      contextContinuation: { runId: h.run.id, itemId: h.question.id },
    });
    expect(f.repository.getAttempt(request.attemptId)?.runId).toBeUndefined();
    expect(f.repository.getAttemptForRun(h.run.id)).toBeUndefined();
    expect(f.projectMessage).not.toHaveBeenCalled();
    expect(await f.runtime.dispatch(dispatched)).toEqual(result);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(
      f.events.filter(({ event }) => event.type === "input.resolved"),
    ).toHaveLength(1);
    const directory = f.directory;
    const acceptedOutput = f.runs.getRunItem(h.question.id)!.output;
    await f.closeForRestart();
    const reopened = await fixture(undefined, directory);
    await reopened.agent.initialize();
    expect(await reopened.runtime.dispatch(dispatched)).toEqual(result);
    expect(reopened.provider.requests).toHaveLength(0);
    expect(reopened.runs.getRunItem(h.question.id)?.output).toEqual(
      acceptedOutput,
    );
  });

  it.each(["same_chat", "omitted_chat"] as const)(
    "defers an unmatched %s opening for the pending intent without another Provider request",
    async (scope) => {
      const driver = vi.fn<() => Promise<CognitionAnalysis>>();
      const f = await fixture(driver);
      const h = await waitingMaterial(f);
      const analysis = h.output;
      driver.mockResolvedValue(analysis);
      delete h.output.decision.selectedBasis.waitingInputContinuation;
      if (scope === "omitted_chat") delete analysis.decision.choices[0]!.chatId;
      f.cognition.notifyVisualChange();
      await f.cognition.runDue();
      expect(driver).toHaveBeenCalledTimes(1);
      const attempt = f.repository.getSnapshot(
        f.persona.personaId,
        f.clock.now(),
      ).recentAttempts[0]!;
      expect(attempt).toMatchObject({
        status: "settled",
        outcome: "deferred",
      });
      const current = f.repository.getAttempt(attempt.id)!;
      expect(
        f.repository.choiceBlockReason(
          current.decision!.choices[0]!,
          f.persona.personaId,
          f.runtime.availability(f.persona.personaId, current),
        ),
      ).toBe("waiting_input_requires_original_run");
      expect(f.runs.getRun(h.run.id)?.status).toBe("needs_input");
      expect(f.runs.getRunItem(h.question.id)?.status).toBe("waiting_input");
      expect(f.provider.requests).toHaveLength(2);
    },
  );

  it("continues a character Run after its actual user steering and material question without replacing its original owner", async () => {
    const f = await fixture(undefined, undefined, true);
    f.provider.turns = [
      attentionTurn("interaction.request_user_input", attentionQuestion),
    ];
    f.provider.release.resolve();
    const original = ownActivity(f);
    const { runId } = await f.runtime.dispatch(original);
    await f.waitStatus(runId, "needs_input");
    const h = await waitingMaterial(f, f.runs.getRun(runId));
    const request = h.commit();
    expect(
      f.runtime.availability(
        f.persona.personaId,
        f.repository.getAttempt(request.attemptId),
      ),
    ).toMatchObject({
      activeCharacterRunId: runId,
      continuableInput: { runId, itemId: h.question.id },
    });
    await expect(f.runtime.dispatch(request)).resolves.toEqual({
      runId,
      continuedInputItemId: h.question.id,
    });
    await f.waitTerminal(runId);
    expect(f.runs.getRun(runId)?.status).toBe("completed");
    expect(f.repository.getAttemptForRun(runId)?.id).toBe(original.attemptId);
    expect(f.repository.getAttempt(request.attemptId)?.runId).toBeUndefined();
    expect(f.repository.getAttempt(request.attemptId)?.outcome).toBe(
      "context_supplied",
    );
    expect(
      f.runs.listRunItems(runId).filter(({ kind }) => kind === "user_message"),
    ).toHaveLength(1);
  });

  it("settles context acceptance through the real Cognition service without allocating its own Run", async () => {
    const driver = vi.fn<() => Promise<CognitionAnalysis>>();
    const f = await fixture(driver);
    const h = await waitingMaterial(f);
    driver.mockResolvedValue(h.output);
    f.cognition.notifyVisualChange();
    await f.cognition.runDue();
    await f.waitTerminal(h.run.id);
    expect(driver).toHaveBeenCalledTimes(1);
    const attempt = f.repository.getSnapshot(f.persona.personaId, f.clock.now())
      .recentAttempts[0]!;
    expect(f.repository.getAttempt(attempt.id)).toMatchObject({
      status: "settled",
      outcome: "context_supplied",
      contextContinuation: { runId: h.run.id, itemId: h.question.id },
    });
    expect(f.repository.getAttemptForRun(h.run.id)).toBeUndefined();
    expect(f.messages.listRunMessages(h.run.id).at(-1)?.content).toContain(
      "700",
    );
    expect(f.provider.requests).toHaveLength(3);
    expect(f.projectMessage).not.toHaveBeenCalled();
  });

  it("does not accept stale selected material when the same desktop object changes during complete input measurement", async () => {
    const f = await fixture();
    const h = await waitingMaterial(f);
    const request = h.commit();
    const entered = deferred();
    const release = deferred();
    const measure = f.provider.measureInput.bind(f.provider);
    vi.spyOn(f.provider, "measureInput").mockImplementation(
      async (input, signal) => {
        entered.resolve();
        await release.promise;
        return measure(input, signal);
      },
    );
    const pending = f.runtime.dispatch(request);
    const rejected = expect(pending).rejects.toThrow(/changed|current/);
    await entered.promise;
    f.clock.advance(1000);
    f.repository.ingest(
      {
        id: randomUUID(),
        personaId: f.persona.personaId,
        source: { kind: "activity", id: randomUUID() },
        actor: "unknown",
        kind: "observation",
        boundary: "content",
        observedAt: f.clock.now(),
        object: h.material.object!,
        text: "更新后的表格：停车不收费。",
      },
      f.clock.now(),
    );
    release.resolve();
    await rejected;
    expect(f.runs.getRun(h.run.id)?.status).toBe("needs_input");
    expect(f.runs.getRunItem(h.question.id)?.status).toBe("waiting_input");
    expect(
      f.repository.getAttempt(request.attemptId)?.contextContinuation,
    ).toBeUndefined();
    expect(f.provider.requests).toHaveLength(2);
  });

  it.each(["different_run", "history_only"] as const)(
    "rejects %s as a waiting-context source binding",
    async (invalid) => {
      const f = await fixture();
      const h = await waitingMaterial(f);
      if (invalid === "different_run")
        h.output.decision.selectedBasis.waitingInputContinuation!.runId =
          randomUUID();
      else h.output.decision.selectedBasis.evidenceUses[1]!.use = "history";
      expect(() => h.commit()).toThrow("Waiting input continuation requires");
      expect(f.runs.getRunItem(h.question.id)?.status).toBe("waiting_input");
    },
  );
});

describe("actual saved assistant replies as Cognition sources", () => {
  it("keeps the completed Item text eligible after its parent Run is cancelled without claiming delivery", async () => {
    const f = await fixture();
    const text = "阿禾（对阿澄）：我会修好旧录音。";
    f.provider.turns = [
      [
        { type: "text.delta", delta: text },
        ...attentionTurn("interaction.request_user_input", attentionQuestion),
      ],
    ];
    f.provider.release.resolve();
    const chat = f.chats.create({});
    const run = await f.agent.start({
      attachments: [],
      chatId: chat.id,
      content: "先写这一行台词，再问我下一段写什么。不处理实际录音。",
      execution: { mode: "chat" },
      providerProfileId: f.providers.getDefaultChatProfileId(),
      requestedAt: NOW,
    });
    await f.waitStatus(run.id, "needs_input");
    const item = f.runs
      .listRunItems(run.id)
      .find((value) => value.kind === "assistant_message")!;
    expect(item).toMatchObject({ status: "completed", displayOutput: text });
    const message = f.messages
      .listRunMessages(run.id)
      .find((value) => value.role === "assistant")!;
    expect(item.output).toMatchObject({ messageId: message.id });
    expect(item.id).not.toBe(message.id);
    const source = f.repository
      .getSnapshot(f.persona.personaId, NOW)
      .evidence.find((value) => value.source.fragment === item.id)!;
    expect(source).toMatchObject({
      personaId: f.persona.personaId,
      chatId: chat.id,
      actor: "agent",
      kind: "utterance",
      text,
      source: {
        kind: "run",
        id: run.id,
        fragment: item.id,
        revision: "completed",
      },
    });
    expect(isIntentCompletionEvidence("completed_reply", source)).toBe(true);
    expect(isIntentCompletionEvidence("performed_effect", source)).toBe(false);
    expect(isIntentCompletionEvidence("user_report", source)).toBe(false);
    await f.agent.cancel({ runId: run.id, requestedAt: NOW });
    expect(f.runs.getRun(run.id)?.status).toBe("cancelled");
    expect(f.runs.getRunItem(item.id)?.status).toBe("completed");
    const reconciled = f.runtime.reconcileRun(run.id);
    expect(
      reconciled.evidence.find((value) => value.source.fragment === item.id),
    ).toMatchObject({ text, source: source.source });
    expect(reconciled.unsuccessful).toBe("interrupted");
    expect(
      f.repository.hasEvidence(
        f.persona.personaId,
        { kind: "run", id: run.id, revision: "surface:offered" },
        "observation",
      ),
    ).toBe(false);
    expect(f.projectMessage).not.toHaveBeenCalled();
  });

  it("does not emit completion evidence for running or cancelled messages even when partial text looks finished", async () => {
    const f = await fixture();
    const partial = deferred();
    f.provider.stream = async function* (request, signal) {
      this.requests.push(request);
      yield { type: "text.delta", delta: "我做完了。" };
      partial.resolve();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Fixture model stopped after abort")),
          {
            once: true,
          },
        );
        signal.throwIfAborted();
      });
    };
    const chat = f.chats.create({});
    const run = await f.agent.start({
      attachments: [],
      chatId: chat.id,
      content: "写一句角色台词。",
      execution: { mode: "chat" },
      providerProfileId: f.providers.getDefaultChatProfileId(),
      requestedAt: NOW,
    });
    await partial.promise;
    const running = f.runs
      .listRunItems(run.id)
      .find((value) => value.kind === "assistant_message")!;
    expect(
      f.runtime
        .reconcileRun(run.id)
        .evidence.some((value) => value.source.fragment === running.id),
    ).toBe(false);
    await f.agent.cancel({ runId: run.id, requestedAt: NOW });
    const item = f.runs.getRunItem(running.id)!;
    expect(item).toMatchObject({
      status: "cancelled",
      displayOutput: "我做完了。",
    });
    expect(
      f.runtime
        .reconcileRun(run.id)
        .evidence.some((value) => value.source.fragment === item.id),
    ).toBe(false);
    expect(
      f.repository
        .getSnapshot(f.persona.personaId, NOW)
        .evidence.some((value) => value.source.fragment === item.id),
    ).toBe(false);
  });
});
