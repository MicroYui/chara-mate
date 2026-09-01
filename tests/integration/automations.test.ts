import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AutomationDefinition,
  AutomationEventEnvelope,
} from "../../src/shared/contracts/automation";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { PersonaSnapshot } from "../../src/shared/contracts/persona";
import type {
  EntityId,
  Timestamp,
} from "../../src/shared/contracts/primitives";
import type { ToolResult } from "../../src/shared/contracts/tool";
import type { Clock } from "../../src/shared/pure/clock";
import type { IdGenerator } from "../../src/shared/pure/id";
import { AgentRuntime } from "../../src/main/agent/agentRuntime";
import { CheckpointRepository } from "../../src/main/agent/checkpointRepository";
import type {
  ModelContextLimits,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../../src/main/agent/modelProvider";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import { AutomationRepository } from "../../src/main/automations/automationRepository";
import { AutomationService } from "../../src/main/automations/automationService";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { ProviderError } from "../../src/main/providers/providerError";
import {
  ToolRegistry,
  toolEvidenceHash,
} from "../../src/main/tools/toolRegistry";
import { defaultPersonaSnapshot } from "../../src/main/persona/personaPresets";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const PERSONA_ID = "20000000-0000-4000-8000-000000000002";
const TARGET_CHAT_ID = "30000000-0000-4000-8000-000000000003";

type Turn = (
  request: ModelRequest,
  signal: AbortSignal,
) => Promise<readonly ModelEvent[]> | readonly ModelEvent[];

class MutableClock implements Clock {
  constructor(public value: Timestamp) {}

  now(): Timestamp {
    return this.value;
  }
}

class SequentialIds implements IdGenerator {
  #next = 1;

  generate(): EntityId {
    const suffix = this.#next.toString(16).padStart(12, "0");
    this.#next += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(readonly turns: Turn[]) {}

  resolveContextLimits(): Promise<ModelContextLimits> {
    return Promise.resolve({
      effectiveInputTokens: 100_000,
      maxContextTokens: 120_000,
      maxOutputTokens: 8_000,
      maxPromptTokens: 100_000,
    });
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted Automation turn remains");
    for (const event of await turn(request, signal)) {
      signal.throwIfAborted();
      yield event;
    }
  }
}

class AutomationEventCollector {
  readonly events: AutomationEventEnvelope[] = [];
  readonly #waiters: Array<{
    readonly predicate: (event: AutomationEventEnvelope) => boolean;
    readonly resolve: (event: AutomationEventEnvelope) => void;
  }> = [];

  publish = (event: AutomationEventEnvelope): void => {
    this.events.push(event);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(event)) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  wait(predicate: (event: AutomationEventEnvelope) => boolean) {
    const current = this.events.find(predicate);
    if (current) return Promise.resolve(current);
    return new Promise<AutomationEventEnvelope>((resolve) => {
      this.#waiters.push({ predicate, resolve });
    });
  }
}

interface Fixture {
  readonly agent: AgentRuntime;
  readonly automationEvents: AutomationEventCollector;
  readonly automationRepository: AutomationRepository;
  readonly automationService: AutomationService;
  readonly chats: ChatRepository;
  readonly clock: MutableClock;
  readonly database: ReturnType<typeof openApplicationDatabase>;
  readonly modelRuntimeCalls: Array<{
    readonly modelId?: string;
    readonly profileId: string;
  }>;
  readonly persona: PersonaSnapshot;
  readonly provider: ScriptedProvider;
  readonly runs: RunRepository;
  readonly tools: ToolRegistry;
}

const fixtures: Fixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createFixture(turns: Turn[] = []): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-automations-"));
  temporaryDirectories.push(root);
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const clock = new MutableClock("2026-08-11T00:00:00.000Z");
  const persona = {
    ...defaultPersonaSnapshot(clock.now()),
    personaId: PERSONA_ID,
  };
  const ids = new SequentialIds();
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  const chatService = new ChatService(chats, runs, ids, clock);
  const provider = new ScriptedProvider(turns);
  const modelRuntimeCalls: Fixture["modelRuntimeCalls"] = [];
  const automationEvents = new AutomationEventCollector();
  const automationServiceReference: { current?: AutomationService } = {};
  const runEvents = new RunEventService(runs, {
    publish(event: RunEventEnvelope) {
      automationServiceReference.current?.observeRun(event);
    },
  });
  const tools = new ToolRegistry();
  const agent = new AgentRuntime(
    chats,
    chatService,
    runs,
    new CheckpointRepository(database),
    new RunEventWriter(runs, runEvents, ids, clock),
    tools,
    {
      createChatModelRuntime(profileId, modelId) {
        modelRuntimeCalls.push({
          ...(modelId ? { modelId } : {}),
          profileId,
        });
        return Promise.resolve({
          provider,
          snapshot: {
            apiStyle: "openai-compatible" as const,
            modelId: modelId ?? "default-model",
            profileId,
            profileName: "Test Provider",
          },
        });
      },
    },
    ids,
    clock,
    { getActiveSnapshot: () => persona },
  );
  const automationRepository = new AutomationRepository(database);
  const automationService = new AutomationService(
    automationRepository,
    chatService,
    {
      getRun: (runId) => runs.getRun(runId),
      listChatRuns: (chatId) => runs.getSnapshot(chatId).runs,
      readCompletedAssistantMessage: (runId) =>
        chats
          .listRunMessages(runId)
          .findLast(
            ({ role, status }) =>
              role === "assistant" && status === "completed",
          )?.content,
    },
    agent,
    ids,
    clock,
    { publish: automationEvents.publish },
    {
      getActiveSnapshot: () => persona,
      getSnapshot: () => persona,
    },
  );
  automationServiceReference.current = automationService;
  const fixture = {
    agent,
    automationEvents,
    automationRepository,
    automationService,
    chats,
    clock,
    database,
    modelRuntimeCalls,
    persona,
    provider,
    runs,
    tools,
  };
  fixtures.push(fixture);
  return fixture;
}

function reminderDefinition(name = "每日提醒"): AutomationDefinition {
  return {
    name,
    schedule: {
      kind: "daily",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    },
    task: {
      delivery: "bubble",
      kind: "reminder",
      message: "起来活动一下。",
    },
  };
}

function agentDefinition(toolNames: string[]): AutomationDefinition {
  return {
    name: "自动整理",
    schedule: {
      kind: "daily",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    },
    task: {
      execution: { approvalMode: "request_approval", mode: "agent" },
      goal: "整理项目状态。",
      kind: "agent_task",
      modelId: "saved-model",
      personaId: PERSONA_ID,
      providerProfileId: PROFILE_ID,
      toolScope: { mode: "selected", toolNames },
    },
  };
}

function assistantMessageDefinition(): AutomationDefinition {
  return {
    name: "约好再聊",
    schedule: { kind: "once", runAt: "2026-08-12T00:00:00.000Z" },
    task: {
      delivery: "assistant_message",
      execution: { mode: "chat" },
      goal: "自然问一句论文进展。",
      kind: "agent_task",
      modelId: "saved-model",
      personaId: PERSONA_ID,
      providerProfileId: PROFILE_ID,
      targetChatId: TARGET_CHAT_ID,
      toolScope: { mode: "selected", toolNames: [] },
    },
  };
}

function complete(responseId: string): ModelEvent {
  return {
    responseId,
    status: "completed",
    type: "response.completed",
    usage: { cachedInputTokens: 0, inputTokens: 32, outputTokens: 8 },
  };
}

function finalTurn(text: string): Turn {
  return () => [
    { delta: text, type: "text.delta" },
    complete(`response-${text}`),
  ];
}

function functionTurn(name: string): Turn {
  return () => [
    {
      item: {
        arguments: JSON.stringify({ value: "status" }),
        call_id: "call-1",
        name,
        type: "function_call",
      },
      type: "output.item",
    },
    complete("response-tool"),
  ];
}

function successfulToolResult(): ToolResult {
  const modelContent = { saved: true };
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary: "状态已保存",
  };
}

function registerTestTool(
  fixture: Fixture,
  name: string,
  execute = vi.fn(() => Promise.resolve(successfulToolResult())),
) {
  fixture.tools.register({
    descriptor: {
      description: `Test tool ${name}`,
      effect: "write",
      idempotency: "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
        type: "object",
      },
      itemKind: "tool_call",
      name,
      namespace: "test",
      source: "builtin",
      summary: name,
    },
    execute,
    summarize: () => name,
  });
  return execute;
}

function finishedFor(runId: string) {
  return (envelope: AutomationEventEnvelope): boolean =>
    envelope.event.type === "automation.run.finished" &&
    envelope.event.automationRunId === runId;
}

describe("Automations Core", () => {
  it("supports create/list/pause/resume/run-now/edit and immutable history", async () => {
    const fixture = await createFixture();
    const created = fixture.automationService.create({
      definition: reminderDefinition("旧名称"),
      requestedAt: fixture.clock.now(),
    });
    expect(created).toMatchObject({
      nextRunAt: "2026-08-11T01:00:00.000Z",
      revision: 1,
      state: "active",
    });

    const paused = fixture.automationService.setPaused({
      automationId: created.id,
      expectedRevision: 1,
      paused: true,
      requestedAt: fixture.clock.now(),
    });
    expect(paused).toMatchObject({ revision: 1, state: "paused" });
    expect(fixture.automationService.list().items[0]?.automation).toEqual(
      paused,
    );

    const resumed = fixture.automationService.setPaused({
      automationId: created.id,
      expectedRevision: 1,
      paused: false,
      requestedAt: fixture.clock.now(),
    });
    expect(resumed).toMatchObject({
      nextRunAt: "2026-08-11T01:00:00.000Z",
      state: "active",
    });

    const queued = fixture.automationService.runNow({
      automationId: created.id,
      requestedAt: fixture.clock.now(),
    });
    await fixture.automationEvents.wait(finishedFor(queued.id));

    fixture.clock.value = "2026-08-11T00:05:00.000Z";
    const updated = fixture.automationService.update({
      automationId: created.id,
      definition: reminderDefinition("新名称"),
      expectedRevision: 1,
      requestedAt: fixture.clock.now(),
    });
    expect(updated).toMatchObject({ revision: 2, state: "active" });

    const detail = fixture.automationService.get({ automationId: created.id });
    expect(detail.automation.definition.name).toBe("新名称");
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({
      automationRevision: 1,
      definition: { name: "旧名称" },
      status: "completed",
      summary: "起来活动一下。",
      trigger: { kind: "manual" },
    });
    expect(
      fixture.automationEvents.events.filter(finishedFor(queued.id)),
    ).toHaveLength(1);
    expect(() =>
      fixture.automationService.update({
        automationId: created.id,
        definition: reminderDefinition("冲突写入"),
        expectedRevision: 1,
        requestedAt: fixture.clock.now(),
      }),
    ).toThrow(/已经被更新/u);
  });

  it("coalesces elapsed recurring occurrences into one persisted recovery run", async () => {
    const fixture = await createFixture();
    fixture.clock.value = "2026-08-10T00:00:00.000Z";
    const automation = fixture.automationService.create({
      definition: {
        ...reminderDefinition(),
        schedule: {
          kind: "daily",
          localTime: "08:30",
          timeZone: "Asia/Shanghai",
        },
      },
      requestedAt: fixture.clock.now(),
    });
    expect(automation).toMatchObject({
      nextRunAt: "2026-08-10T00:30:00.000Z",
    });

    fixture.clock.value = "2026-08-14T12:00:00.000Z";
    await fixture.automationService.runDue();
    const run = fixture.automationRepository.listRuns(automation.id)[0]!;
    await fixture.automationEvents.wait(finishedFor(run.id));
    await fixture.automationService.runDue();

    const detail = fixture.automationService.get({
      automationId: automation.id,
    });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.trigger).toEqual({
      kind: "scheduled",
      scheduledFor: "2026-08-10T00:30:00.000Z",
    });
    expect(detail.automation).toMatchObject({
      nextRunAt: "2026-08-15T00:30:00.000Z",
      state: "active",
    });
  });

  it("uses the normal Agent Run with saved model, selected tools and approval", async () => {
    const fixture = await createFixture([
      functionTurn("test.write"),
      finalTurn("项目状态已整理。"),
    ]);
    const execute = registerTestTool(fixture, "test.write");
    registerTestTool(fixture, "test.unselected");
    const automation = fixture.automationService.create({
      definition: agentDefinition(["test.write"]),
      requestedAt: fixture.clock.now(),
    });
    const queued = fixture.automationService.runNow({
      automationId: automation.id,
      requestedAt: fixture.clock.now(),
    });
    await fixture.automationEvents.wait(
      (event) =>
        event.event.type === "automation.run.changed" &&
        event.event.run.id === queued.id &&
        event.event.run.status === "waiting_approval",
    );

    expect(fixture.automationEvents.events.some(finishedFor(queued.id))).toBe(
      false,
    );
    expect(fixture.modelRuntimeCalls).toEqual([
      { modelId: "saved-model", profileId: PROFILE_ID },
    ]);
    const offeredTools = fixture.provider.requests[0]!.toolNamespaces.flatMap(
      ({ tools }) => tools.map(({ name }) => name),
    );
    expect(offeredTools).toContain("test.write");
    expect(offeredTools).not.toContain("test.unselected");

    const approval = fixture.runs.getLatestPendingApproval();
    expect(approval).toBeDefined();
    fixture.clock.value = "2026-08-11T00:01:00.000Z";
    fixture.agent.resolveApproval({
      approvalId: approval!.id,
      decidedAt: fixture.clock.now(),
      decision: "approved",
    });
    await fixture.automationEvents.wait(finishedFor(queued.id));

    const completed = fixture.automationRepository.getRun(queued.id)!;
    expect(completed).toMatchObject({
      status: "completed",
      summary: "项目状态已整理。",
    });
    expect("chatId" in completed && completed.chatId).toBeTruthy();
    expect("runId" in completed && completed.runId).toBeTruthy();
    expect(completed.persona).toEqual(fixture.persona);
    if (!("runId" in completed)) throw new Error("Missing linked Run");
    expect(fixture.runs.getRun(completed.runId)?.persona).toEqual(
      fixture.persona,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(
      fixture.automationEvents.events.filter(finishedFor(queued.id)),
    ).toHaveLength(1);
  });

  it("delivers an assistant-only follow-up into the exact existing Chat", async () => {
    const fixture = await createFixture([finalTurn("论文整理得怎么样了？")]);
    fixture.chats.insertChat({
      createdAt: fixture.clock.now(),
      id: TARGET_CHAT_ID,
      status: "active",
      title: "毕业论文",
      updatedAt: fixture.clock.now(),
    });
    const chatCount = fixture.chats.listChats({ status: "active" }).length;
    const automation = fixture.automationService.create({
      definition: assistantMessageDefinition(),
      requestedAt: fixture.clock.now(),
    });
    const queued = fixture.automationService.runNow({
      automationId: automation.id,
      requestedAt: fixture.clock.now(),
    });
    await fixture.automationEvents.wait(finishedFor(queued.id));

    const completed = fixture.automationRepository.getRun(queued.id)!;
    expect(completed).toMatchObject({
      chatId: TARGET_CHAT_ID,
      status: "completed",
      summary: "论文整理得怎么样了？",
    });
    expect(fixture.chats.listChats({ status: "active" })).toHaveLength(
      chatCount,
    );
    const runtimeRunId = "runId" in completed ? completed.runId : undefined;
    expect(runtimeRunId).toBeTruthy();
    expect(fixture.chats.listRunMessages(runtimeRunId!)).toEqual([
      expect.objectContaining({
        chatId: TARGET_CHAT_ID,
        content: "论文整理得怎么样了？",
        role: "assistant",
        status: "completed",
      }),
    ]);
    expect(fixture.runs.getRun(runtimeRunId!)?.execution).toEqual({
      mode: "chat",
    });
    expect(fixture.provider.requests[0]?.toolNamespaces).toEqual([]);
    expect(fixture.provider.requests[0]?.nativeWebSearch).toBe(false);
  });

  it("projects ordinary Agent cancellation and failure into Automation history", async () => {
    const blocking: Turn = (_request, signal) =>
      new Promise<readonly ModelEvent[]>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Run cancelled", "AbortError"),
            ),
          { once: true },
        );
      });
    const cancelledFixture = await createFixture([blocking]);
    const cancelledAutomation = cancelledFixture.automationService.create({
      definition: agentDefinition([]),
      requestedAt: cancelledFixture.clock.now(),
    });
    const cancellation = cancelledFixture.automationService.runNow({
      automationId: cancelledAutomation.id,
      requestedAt: cancelledFixture.clock.now(),
    });
    await cancelledFixture.automationEvents.wait(
      (event) =>
        event.event.type === "automation.run.changed" &&
        event.event.run.id === cancellation.id &&
        event.event.run.status === "running",
    );
    const linked = cancelledFixture.automationRepository.getRun(
      cancellation.id,
    )!;
    expect("runId" in linked).toBe(true);
    await cancelledFixture.agent.cancel({
      requestedAt: cancelledFixture.clock.now(),
      runId: "runId" in linked ? linked.runId : "",
    });
    const cancelledEvent = await cancelledFixture.automationEvents.wait(
      finishedFor(cancellation.id),
    );
    expect(cancelledEvent.event).toMatchObject({ status: "cancelled" });

    const failedFixture = await createFixture([
      () => {
        throw new ProviderError(
          "PROVIDER.AUTHENTICATION_FAILED",
          "凭据无效。",
          false,
        );
      },
    ]);
    const failedAutomation = failedFixture.automationService.create({
      definition: agentDefinition([]),
      requestedAt: failedFixture.clock.now(),
    });
    const failed = failedFixture.automationService.runNow({
      automationId: failedAutomation.id,
      requestedAt: failedFixture.clock.now(),
    });
    const failedEvent = await failedFixture.automationEvents.wait(
      finishedFor(failed.id),
    );
    expect(failedEvent.event).toMatchObject({
      error: { code: "PROVIDER.AUTHENTICATION_FAILED" },
      status: "failed",
    });
  });

  it("recovers queued work on startup without creating a second occurrence", async () => {
    const fixture = await createFixture();
    const automation = fixture.automationService.create({
      definition: reminderDefinition(),
      requestedAt: fixture.clock.now(),
    });
    const queued = fixture.automationRepository.insertManualRun({
      automation,
      createdAt: fixture.clock.now(),
      persona: defaultPersonaSnapshot(fixture.clock.now()),
      requestedAt: fixture.clock.now(),
      runId: "30000000-0000-4000-8000-000000000003",
    });

    await fixture.automationService.initialize();
    await fixture.automationEvents.wait(finishedFor(queued.id));
    await fixture.automationService.initialize();

    expect(fixture.automationRepository.listRuns(automation.id)).toHaveLength(
      1,
    );
    expect(fixture.automationRepository.getRun(queued.id)).toMatchObject({
      status: "completed",
    });
  });
});
