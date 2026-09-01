import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StartRunRequest } from "../../shared/contracts/agent";
import type { Chat, Message } from "../../shared/contracts/chat";
import type {
  MemoryDetail,
  MemoryHit,
  MemorySnapshot,
  MemoryType,
} from "../../shared/contracts/memory";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { ProactiveConversationBubble } from "../../shared/contracts/pet";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { Run } from "../../shared/contracts/run";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { defaultPersonaSnapshot } from "../persona/personaPresets";
import type {
  CompanionInitiativeRecord,
  NewCompanionInitiativeRecord,
} from "./companionInitiativeRepository";
import { ProactiveOpportunityRepository } from "./proactiveOpportunityRepository";
import {
  proactiveOpportunityEvaluateAt,
  ProactiveOpportunityService,
  type ProactiveOpportunityDecider,
  type ProactiveOpportunityEvaluation,
  type ProactiveOpportunityRunLauncher,
} from "./proactiveOpportunityService";

const CREATED_AT = "2026-09-01T00:00:00.000Z";
const OCCURS_AT = "2026-09-02T07:00:00.000Z";
const EVALUATE_AT = "2026-09-02T06:30:00.000Z";
const COMPLETED_AT = "2026-09-02T06:31:00.000Z";
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const MESSAGE_ID = "66666666-6666-4666-8666-666666666666";
const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const MISSING_RUN_ID = "88888888-8888-4888-8888-888888888888";

const provider: ProviderSnapshot = {
  apiStyle: "openai-compatible",
  modelId: "test-chat-model",
  profileId: PROFILE_ID,
  profileName: "Test provider",
};

interface MemoryOptions {
  readonly importantMoment?: boolean;
  readonly occursAt?: string;
  readonly revisionId?: string;
  readonly status?: MemoryDetail["memory"]["status"];
  readonly timeZone?: string;
  readonly type?: Extract<MemoryType, "commitment" | "event">;
}

function memoryDetail(options: MemoryOptions = {}): MemoryDetail {
  const revisionId = options.revisionId ?? REVISION_ID;
  const occursAt = options.occursAt ?? OCCURS_AT;
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  return {
    memory: {
      confidence: 1,
      createdAt: CREATED_AT,
      currentRevisionId: revisionId,
      id: MEMORY_ID,
      importance: 0.9,
      status: options.status ?? "active",
      type: options.type ?? "event",
      updatedAt: CREATED_AT,
    },
    revisions: [
      {
        content: "明天下午三点做 presentation，有点紧张",
        createdAt: CREATED_AT,
        id: revisionId,
        importantMoment: options.importantMoment ?? true,
        memoryId: MEMORY_ID,
        reason: "用户明确说明",
        sourceIds: [SOURCE_ID],
        sourceType: "chat",
        ...(occursAt && timeZone ? { occursAt, timeZone } : {}),
      },
    ],
    sources: [
      {
        createdAt: CREATED_AT,
        id: SOURCE_ID,
        referenceId: CHAT_ID,
        type: "chat",
      },
    ],
    usages: [],
  };
}

function memoryHit(detail: MemoryDetail): MemoryHit {
  return {
    memory: detail.memory,
    rank: 1,
    revision: detail.revisions[0]!,
    sources: detail.sources,
  };
}

function chat(): Chat {
  return {
    createdAt: CREATED_AT,
    id: CHAT_ID,
    status: "active",
    title: "Presentation",
    updatedAt: CREATED_AT,
  };
}

function run(
  status: Run["status"],
  persona: PersonaSnapshot,
  endedAt?: string,
): Run {
  return {
    chatId: CHAT_ID,
    createdAt: EVALUATE_AT,
    ...(endedAt ? { endedAt } : {}),
    execution: { mode: "chat" },
    id: RUN_ID,
    latestSequence: status === "completed" ? 3 : 1,
    persona,
    provider,
    source: "text",
    startedAt: EVALUATE_AT,
    status,
  };
}

function completedEnvelope(completedRun: Run): RunEventEnvelope {
  return {
    event: { run: completedRun, type: "run.completed" },
    occurredAt: COMPLETED_AT,
    sequence: 3,
    streamId: completedRun.id,
  };
}

interface LaunchRecord {
  readonly options: Parameters<
    ProactiveOpportunityRunLauncher["startAssistantInitiated"]
  >[1];
  readonly request: StartRunRequest;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function harness(input?: {
  readonly decision?: ProactiveOpportunityEvaluation["decision"];
  readonly decisionPromise?: Promise<ProactiveOpportunityEvaluation>;
  readonly detail?: MemoryDetail;
  readonly enabled?: boolean;
  readonly otherActiveRun?: boolean;
  readonly otherActiveRunOnStart?: boolean;
}) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  const repository = new ProactiveOpportunityRepository(database);
  let currentDetail = input?.detail ?? memoryDetail();
  let enabled = input?.enabled ?? true;
  let otherActiveRun = input?.otherActiveRun ?? false;
  let now = CREATED_AT;
  let idSequence = 1;
  let outstandingBubble = false;
  const currentPersona = defaultPersonaSnapshot(CREATED_AT);
  const currentChat = chat();
  database
    .prepare(
      `INSERT INTO chats (id, title, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(
      currentChat.id,
      currentChat.title,
      currentChat.createdAt,
      currentChat.updatedAt,
    );
  const persistMemoryDetail = (detail: MemoryDetail) => {
    const revision = detail.revisions.find(
      ({ id }) => id === detail.memory.currentRevisionId,
    )!;
    database.transaction(() => {
      database
        .prepare(
          `INSERT OR IGNORE INTO memory_sources (
             id, type, reference_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(SOURCE_ID, "chat", CHAT_ID, CREATED_AT);
      database
        .prepare(
          `INSERT OR IGNORE INTO memories (
             id, type, status, current_revision_id, importance, confidence,
             deleted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          detail.memory.id,
          detail.memory.type,
          detail.memory.status,
          revision.id,
          detail.memory.importance,
          detail.memory.confidence,
          detail.memory.deletedAt ?? null,
          detail.memory.createdAt,
          detail.memory.updatedAt,
        );
      database
        .prepare(
          `INSERT OR IGNORE INTO memory_revisions (
             id, memory_id, content, occurs_at, time_zone, important_moment,
             source_type, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.id,
          detail.memory.id,
          revision.content,
          revision.occursAt ?? null,
          revision.timeZone ?? null,
          revision.importantMoment ? 1 : 0,
          revision.sourceType,
          revision.reason,
          revision.createdAt,
        );
      database
        .prepare(
          `INSERT OR IGNORE INTO memory_revision_sources (
             revision_id, source_id
           ) VALUES (?, ?)`,
        )
        .run(revision.id, SOURCE_ID);
      database
        .prepare(
          `UPDATE memories
           SET type = ?, status = ?, current_revision_id = ?,
               importance = ?, confidence = ?, deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          detail.memory.type,
          detail.memory.status,
          revision.id,
          detail.memory.importance,
          detail.memory.confidence,
          detail.memory.deletedAt ?? null,
          detail.memory.updatedAt,
          detail.memory.id,
        );
    })();
  };
  persistMemoryDetail(currentDetail);
  const runById = new Map<string, Run>();
  const completedMessageByRun = new Map<
    string,
    { readonly content: string; readonly id: string }
  >();
  const launches: LaunchRecord[] = [];
  const bubbles: ProactiveConversationBubble[] = [];
  const historyRecords: CompanionInitiativeRecord[] = [];
  const listMessages = vi.fn<() => Message[]>(() => []);
  const recordShown = vi.fn((record: NewCompanionInitiativeRecord) => {
    historyRecords.unshift({
      ...record,
      outcome: "shown",
      updatedAt: record.shownAt,
    });
  });
  const decide = vi.fn(
    (
      _evidence: Parameters<ProactiveOpportunityDecider["decide"]>[0],
      _signal: AbortSignal,
    ) => {
      void _evidence;
      void _signal;
      return (
        input?.decisionPromise ??
        Promise.resolve({
          decision: input?.decision ?? {
            action: "send",
            grounding: "用户此前说这场分享让自己有点紧张",
          },
          provider,
        })
      );
    },
  );
  const decider: ProactiveOpportunityDecider = { decide };
  const startAssistantInitiated = vi.fn(
    (
      request: StartRunRequest,
      options: Parameters<
        ProactiveOpportunityRunLauncher["startAssistantInitiated"]
      >[1],
    ) => {
      launches.push({ options, request });
      const startedRun = run("running", options.persona);
      database
        .prepare(
          `INSERT INTO runs (
             id, chat_id, execution_json, persona_json, provider_json, source,
             status, latest_sequence, created_at, started_at
           ) VALUES (?, ?, ?, ?, ?, 'text', 'running', 1, ?, ?)`,
        )
        .run(
          startedRun.id,
          startedRun.chatId,
          JSON.stringify(startedRun.execution),
          JSON.stringify(startedRun.persona),
          JSON.stringify(startedRun.provider),
          startedRun.createdAt,
          startedRun.startedAt,
        );
      runById.set(startedRun.id, startedRun);
      if (input?.otherActiveRunOnStart) otherActiveRun = true;
      options.onStarted?.(startedRun);
      return Promise.resolve(startedRun);
    },
  );
  const cancel = vi.fn(
    (_request: Parameters<ProactiveOpportunityRunLauncher["cancel"]>[0]) => {
      void _request;
      return Promise.resolve({ outcome: "accepted" });
    },
  );
  const agent: ProactiveOpportunityRunLauncher = {
    cancel,
    startAssistantInitiated,
  };
  const service = new ProactiveOpportunityService(
    repository,
    {
      get: (memoryId) => {
        if (memoryId !== currentDetail.memory.id) {
          throw new Error("Memory not found");
        }
        return currentDetail;
      },
      list: ({ type }): MemorySnapshot => ({
        candidates: [],
        memories:
          currentDetail.memory.type === type ? [memoryHit(currentDetail)] : [],
        profile: [],
      }),
    },
    {
      getChat: (chatId) => (chatId === CHAT_ID ? currentChat : undefined),
      listMessages,
    },
    {
      getRun: (runId) => runById.get(runId),
      readCompletedAssistantMessage: (runId) =>
        completedMessageByRun.get(runId),
    },
    decider,
    agent,
    {
      hasOutstandingBubble: () => outstandingBubble,
      publishBubble: vi.fn((bubble: ProactiveConversationBubble) => {
        outstandingBubble = true;
        bubbles.push(bubble);
        return true;
      }),
    },
    {
      listRecent: () => historyRecords,
      recordShown,
    },
    {
      getCompanionInitiative: () => ({
        importantMomentOutreachEnabled: enabled,
        importantMomentOutreachPrompted: enabled,
        level: "lively",
        quietHours: {
          enabled: false,
          endMinute: 8 * 60,
          startMinute: 22 * 60,
        },
      }),
    },
    { hasActiveSession: () => false },
    { getActiveSnapshot: () => currentPersona },
    {
      generate: () =>
        `99999999-9999-4999-8999-${String(idSequence++).padStart(12, "0")}`,
    },
    { now: () => now },
    { warn: vi.fn() },
    () => false,
    () => otherActiveRun,
    () => true,
    () => 12 * 60,
  );

  return {
    bubbles,
    cancel,
    completeRun: (content = "要准备上场了吗？放轻松，照你的节奏来。") => {
      const completedRun = run("completed", currentPersona, COMPLETED_AT);
      database
        .prepare(
          `UPDATE runs
           SET status = 'completed', latest_sequence = 3, ended_at = ?
           WHERE id = ?`,
        )
        .run(COMPLETED_AT, completedRun.id);
      database
        .prepare(
          `INSERT INTO messages (
             id, chat_id, run_id, role, status, content, created_at, updated_at
           ) VALUES (?, ?, ?, 'assistant', 'completed', ?, ?, ?)`,
        )
        .run(
          MESSAGE_ID,
          CHAT_ID,
          completedRun.id,
          content,
          COMPLETED_AT,
          COMPLETED_AT,
        );
      runById.set(completedRun.id, completedRun);
      completedMessageByRun.set(completedRun.id, {
        content,
        id: MESSAGE_ID,
      });
      return completedRun;
    },
    currentPersona,
    decide,
    historyRecords,
    launches,
    recordShown,
    repository,
    runById,
    service,
    startAssistantInitiated,
    setDetail: (detail: MemoryDetail) => {
      persistMemoryDetail(detail);
      currentDetail = detail;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setNow: (value: string) => {
      now = value;
    },
    setOtherActiveRun: (value: boolean) => {
      otherActiveRun = value;
    },
    storeRunWithoutReaderVisibility: (runId: string) => {
      database
        .prepare(
          `INSERT INTO runs (
             id, chat_id, execution_json, persona_json, provider_json, source,
             status, latest_sequence, created_at, started_at
           ) VALUES (?, ?, ?, ?, ?, 'text', 'running', 1, ?, ?)`,
        )
        .run(
          runId,
          CHAT_ID,
          JSON.stringify({ mode: "chat" }),
          JSON.stringify(currentPersona),
          JSON.stringify(provider),
          EVALUATE_AT,
          EVALUATE_AT,
        );
    },
  };
}

describe("proactiveOpportunityEvaluateAt", () => {
  it("schedules one evaluation exactly 30 minutes before the event", () => {
    expect(proactiveOpportunityEvaluateAt(OCCURS_AT)).toBe(EVALUATE_AT);
    expect(proactiveOpportunityEvaluateAt("not-a-time")).toBeUndefined();
  });
});

describe("ProactiveOpportunityService", () => {
  it("creates only one opportunity for a future important event after permission", () => {
    const fixture = harness({ enabled: false });

    fixture.service.reconcileAll();
    expect(fixture.repository.listOpen()).toEqual([]);

    fixture.setEnabled(true);
    fixture.service.handlePermissionChanged(true);
    fixture.service.reconcileAll();

    expect(fixture.repository.listOpen()).toEqual([
      expect.objectContaining({
        evaluateAt: EVALUATE_AT,
        sourceMemoryId: MEMORY_ID,
        sourceRevisionId: REVISION_ID,
        state: "pending",
        targetChatId: CHAT_ID,
      }),
    ]);
  });

  it("reopens the same future opportunity after category permission is restored", () => {
    const fixture = harness();
    fixture.service.reconcileAll();
    const original = fixture.repository.listOpen()[0]!;

    fixture.setEnabled(false);
    fixture.service.handlePermissionChanged(false);
    expect(fixture.repository.get(original.id)?.state).toBe("cancelled");

    fixture.setEnabled(true);
    fixture.service.handlePermissionChanged(true);

    expect(fixture.repository.listOpen()).toEqual([
      expect.objectContaining({
        id: original.id,
        sourceRevisionId: REVISION_ID,
        state: "pending",
      }),
    ]);
  });

  it("reopens the same future opportunity when an archived Memory is restored", () => {
    const fixture = harness();
    fixture.service.reconcileAll();
    const original = fixture.repository.listOpen()[0]!;

    fixture.setDetail(memoryDetail({ status: "archived" }));
    fixture.service.handleMemoryChanged(MEMORY_ID);
    expect(fixture.repository.get(original.id)?.state).toBe("cancelled");

    fixture.setDetail(memoryDetail({ status: "active" }));
    fixture.service.handleMemoryChanged(MEMORY_ID);

    expect(fixture.repository.listOpen()).toEqual([
      expect.objectContaining({ id: original.id, state: "pending" }),
    ]);
  });

  it("skips unauthorized or late events and cancels an old opportunity on reschedule or cancellation", () => {
    const unauthorized = harness({ enabled: false });
    unauthorized.service.reconcileAll();
    expect(unauthorized.repository.listOpen()).toEqual([]);

    const late = harness();
    late.setNow("2026-09-02T06:40:00.000Z");
    late.service.reconcileAll();
    expect(late.repository.listOpen()).toEqual([]);

    const exactLead = harness();
    exactLead.setNow(EVALUATE_AT);
    exactLead.service.reconcileAll();
    expect(exactLead.repository.listOpen()).toEqual([
      expect.objectContaining({ evaluateAt: EVALUATE_AT, state: "pending" }),
    ]);

    const changed = harness();
    changed.service.reconcileAll();
    const original = changed.repository.listOpen()[0]!;
    const revisedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    changed.setDetail(
      memoryDetail({
        occursAt: "2026-09-02T08:00:00.000Z",
        revisionId: revisedId,
      }),
    );
    changed.service.handleMemoryChanged(MEMORY_ID);

    expect(changed.repository.get(original.id)?.state).toBe("cancelled");
    expect(changed.repository.listOpen()).toEqual([
      expect.objectContaining({
        evaluateAt: "2026-09-02T07:30:00.000Z",
        sourceRevisionId: revisedId,
        state: "pending",
      }),
    ]);

    const cancelledId = changed.repository.listOpen()[0]!.id;
    changed.setDetail(
      memoryDetail({
        importantMoment: false,
        occursAt: "",
        revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        timeZone: "",
      }),
    );
    changed.service.handleMemoryChanged(MEMORY_ID);

    expect(changed.repository.get(cancelledId)?.state).toBe("cancelled");
    expect(changed.repository.listOpen()).toEqual([]);
  });

  it("consumes a due opportunity silently when the semantic gate chooses none", async () => {
    const fixture = harness({
      decision: { action: "none", grounding: null },
    });
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);

    await fixture.service.runDue();
    await fixture.service.runDue();

    expect(fixture.decide).toHaveBeenCalledTimes(1);
    expect(fixture.startAssistantInitiated).not.toHaveBeenCalled();
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      outcome: "silent",
      state: "resolved",
    });
  });

  it("consumes a due opportunity silently while another Run is active", async () => {
    const fixture = harness({ otherActiveRun: true });
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);

    await fixture.service.runDue();

    expect(fixture.decide).not.toHaveBeenCalled();
    expect(fixture.startAssistantInitiated).not.toHaveBeenCalled();
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      outcome: "silent",
      state: "resolved",
    });
  });

  it("uses the source Chat, no tools, and current Persona, then projects and records the completed Run once", async () => {
    const fixture = harness();
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);

    await fixture.service.runDue();

    expect(fixture.launches).toHaveLength(1);
    expect(fixture.launches[0]!.request).toMatchObject({
      chatId: CHAT_ID,
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
    });
    expect(fixture.launches[0]!.request.attachments).toEqual([]);
    expect(fixture.launches[0]!.options.toolNames).toEqual([]);
    expect(fixture.launches[0]!.options.persona).toBe(fixture.currentPersona);
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      runId: RUN_ID,
      state: "evaluating",
    });

    fixture.setNow(COMPLETED_AT);
    const completedRun = fixture.completeRun();
    const envelope = completedEnvelope(completedRun);
    fixture.service.observeRun(envelope);
    fixture.service.observeRun(envelope);

    expect(fixture.bubbles).toEqual([
      expect.objectContaining({
        chatId: CHAT_ID,
        id: RUN_ID,
        kind: "continuation",
        messageId: MESSAGE_ID,
      }),
    ]);
    expect(fixture.recordShown).toHaveBeenCalledTimes(1);
    expect(fixture.recordShown).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RUN_ID,
        kind: "continuation",
        sourceKind: "memory_event",
      }),
    );
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      messageId: MESSAGE_ID,
      outcome: "delivered",
      state: "resolved",
    });
  });

  it("keeps the completed Chat message as delivered when a later active Run suppresses only the bubble", async () => {
    const fixture = harness();
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);
    await fixture.service.runDue();

    fixture.setNow(COMPLETED_AT);
    const completedRun = fixture.completeRun();
    fixture.setOtherActiveRun(true);
    fixture.service.observeRun(completedEnvelope(completedRun));

    expect(fixture.bubbles).toEqual([]);
    expect(fixture.recordShown).not.toHaveBeenCalled();
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      messageId: MESSAGE_ID,
      outcome: "delivered",
      state: "resolved",
    });
  });

  it("cancels and resolves an unbound launch when another Run wins the onStarted race", async () => {
    const fixture = harness({ otherActiveRunOnStart: true });
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);

    await fixture.service.runDue();

    expect(fixture.cancel).toHaveBeenCalledWith({
      requestedAt: EVALUATE_AT,
      runId: RUN_ID,
    });
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      outcome: "silent",
      state: "resolved",
    });
    expect(fixture.service.isBusy()).toBe(false);
  });

  it("records a completed shutdown-race message without projecting a transient bubble", async () => {
    const fixture = harness();
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);
    await fixture.service.runDue();

    fixture.service.shutdown();
    fixture.setNow(COMPLETED_AT);
    const completedRun = fixture.completeRun();
    fixture.service.observeRun(completedEnvelope(completedRun));

    expect(fixture.bubbles).toEqual([]);
    expect(fixture.recordShown).not.toHaveBeenCalled();
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      messageId: MESSAGE_ID,
      outcome: "delivered",
      state: "resolved",
    });
  });

  it("cancels a bound proactive Run when its Memory revision is cancelled or category permission is disabled", async () => {
    const revised = harness();
    revised.service.reconcileAll();
    revised.setNow(EVALUATE_AT);
    await revised.service.runDue();
    const revisedOpportunity =
      revised.repository.findLatestForMemory(MEMORY_ID)!;

    revised.setDetail(
      memoryDetail({
        importantMoment: false,
        occursAt: "",
        revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        timeZone: "",
      }),
    );
    revised.service.handleMemoryChanged(MEMORY_ID);

    expect(revised.cancel).toHaveBeenCalledWith({
      requestedAt: EVALUATE_AT,
      runId: RUN_ID,
    });
    expect(revised.repository.get(revisedOpportunity.id)?.state).toBe(
      "cancelled",
    );

    const disabled = harness();
    disabled.service.reconcileAll();
    disabled.setNow(EVALUATE_AT);
    await disabled.service.runDue();
    const disabledOpportunity =
      disabled.repository.findLatestForMemory(MEMORY_ID)!;

    disabled.setEnabled(false);
    disabled.service.handlePermissionChanged(false);

    expect(disabled.cancel).toHaveBeenCalledWith({
      requestedAt: EVALUATE_AT,
      runId: RUN_ID,
    });
    expect(disabled.repository.get(disabledOpportunity.id)?.state).toBe(
      "cancelled",
    );
  });

  it("does not launch after shutdown while the decider is pending and releases the claim for startup recovery", async () => {
    const pendingDecision = deferred<ProactiveOpportunityEvaluation>();
    const fixture = harness({ decisionPromise: pendingDecision.promise });
    fixture.service.reconcileAll();
    fixture.setNow(EVALUATE_AT);

    const due = fixture.service.runDue();
    expect(fixture.decide).toHaveBeenCalledTimes(1);

    fixture.service.shutdown();
    pendingDecision.resolve({
      decision: {
        action: "send",
        grounding: "用户此前说这场分享让自己有点紧张",
      },
      provider,
    });
    await due;

    expect(fixture.startAssistantInitiated).not.toHaveBeenCalled();
    expect(fixture.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      state: "pending",
    });
    expect(fixture.repository.earliestPendingAt()).toBe(EVALUATE_AT);
  });

  it("marks a restored evaluating opportunity failed when its bound Run is missing", () => {
    const fixture = harness();
    fixture.service.reconcileAll();
    const opportunity = fixture.repository.claimNextDue(EVALUATE_AT)!;
    fixture.storeRunWithoutReaderVisibility(MISSING_RUN_ID);
    fixture.repository.attachRun(opportunity.id, MISSING_RUN_ID, EVALUATE_AT);
    fixture.setNow(EVALUATE_AT);

    fixture.service.initialize();

    expect(fixture.repository.get(opportunity.id)).toMatchObject({
      outcome: "failed",
      runId: MISSING_RUN_ID,
      state: "resolved",
    });
    expect(fixture.repository.listOpen()).toEqual([]);
  });
});
