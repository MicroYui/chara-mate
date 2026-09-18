import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../shared/contracts/chat";
import type {
  MemoryDetail,
  MemoryHit,
  MemorySnapshot,
  MemoryType,
} from "../../shared/contracts/memory";
import type { CognitionEvidenceInput } from "../../shared/contracts/cognition";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { PersonaRepository } from "../persona/personaRepository";
import { CognitionRepository } from "../cognition/cognitionRepository";
import { opportunityIsCurrent } from "../cognition/cognitionProjection";
import { ProactiveOpportunityRepository } from "./proactiveOpportunityRepository";
import {
  proactiveOpportunityEvaluateAt,
  ProactiveOpportunityService,
} from "./proactiveOpportunityService";
const CREATED_AT = "2026-09-01T00:00:00.000Z";
const OCCURS_AT = "2026-09-02T07:00:00.000Z";
const EVALUATE_AT = "2026-09-02T06:30:00.000Z";
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
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
        priorDispositions: [],
        historyStatus: "current",
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

function harness(input?: { detail?: MemoryDetail; enabled?: boolean }) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  const repository = new ProactiveOpportunityRepository(database);
  const cognition = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const personas = new PersonaRepository(database);
  personas.initialize(CREATED_AT);
  let now = CREATED_AT;
  let currentDetail = input?.detail ?? memoryDetail();
  let enabled = input?.enabled ?? true;
  let chatActive = true;
  database
    .prepare(
      "INSERT INTO chats (id,title,status,created_at,updated_at) VALUES (?,?,'active',?,?)",
    )
    .run(CHAT_ID, "Presentation", CREATED_AT, CREATED_AT);
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
  const ingest = vi.fn((evidence: CognitionEvidenceInput) => {
    cognition.ingest(evidence, now);
  });
  const warn = vi.fn();
  const options = {
    repository,
    memory: {
      get: (id: string) => {
        if (id !== MEMORY_ID) throw new Error("Missing");
        return currentDetail;
      },
      list: ({ type }: { type: "event" | "commitment" }): MemorySnapshot => ({
        candidates: [],
        profile: [],
        memories:
          currentDetail.memory.type === type ? [memoryHit(currentDetail)] : [],
      }),
    },
    chats: {
      getChat: (id: string) =>
        id === CHAT_ID
          ? {
              ...chat(),
              status: chatActive ? ("active" as const) : ("archived" as const),
            }
          : undefined,
    },
    cognition: { ingest },
    personas,
    ids: { generate: randomUUID },
    clock: { now: () => now },
    logger: { warn },
    policy: {
      getCompanionInitiative: () => ({
        level: "balanced" as const,
        importantMomentOutreachEnabled: enabled,
        importantMomentOutreachPrompted: true,
        territoryMomentSurprisesEnabled: true,
        territoryMomentSurprisesPrompted: true,
        quietHours: { enabled: false, startMinute: 0, endMinute: 0 },
      }),
    },
  };
  const service = new ProactiveOpportunityService(options);
  return {
    service,
    repository,
    cognition,
    ingest,
    warn,
    options,
    personaId: personas.getActiveSnapshot().personaId,
    setNow: (value: string) => {
      now = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setChatActive: (value: boolean) => {
      chatActive = value;
    },
    setDetail: (value: MemoryDetail) => {
      currentDetail = value;
      persistMemoryDetail(value);
    },
  };
}

describe("important-moment source feeding the single Cognition runtime", () => {
  it("preserves the selected thirty-minute consideration time", () => {
    expect(proactiveOpportunityEvaluateAt(OCCURS_AT)).toBe(EVALUATE_AT);
    expect(proactiveOpportunityEvaluateAt("invalid")).toBeUndefined();
  });

  it("publishes an actual memory revision once, without an independent model, Run or delivery outcome", async () => {
    const h = harness();
    h.service.initialize();
    expect(h.service.earliestNextRunAt()).toBe(EVALUATE_AT);
    h.setNow("2026-09-02T06:29:59.999Z");
    await h.service.runDue();
    expect(h.ingest).not.toHaveBeenCalled();
    h.setNow(EVALUATE_AT);
    await h.service.runDue();
    await h.service.runDue();
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest.mock.calls[0]![0]).toMatchObject({
      actor: "system",
      kind: "observation",
      chatId: CHAT_ID,
      source: { kind: "memory", id: MEMORY_ID, revision: REVISION_ID },
      opportunity: {
        targetChatId: CHAT_ID,
        evaluateAt: EVALUATE_AT,
        occursAt: OCCURS_AT,
        status: "due",
      },
    });
    expect(h.repository.findLatestForMemory(MEMORY_ID)).toMatchObject({
      state: "resolved",
    });
    expect(h.repository.findLatestForMemory(MEMORY_ID)).not.toHaveProperty(
      "outcome",
    );
    expect(h.service.earliestNextRunAt()).toBeUndefined();
  });

  it("does not create catch-up signals from newly formed late or vague memories", () => {
    const h = harness();
    h.setNow("2026-09-02T06:45:00.000Z");
    h.service.initialize();
    expect(h.repository.listOpen()).toEqual([]);
    const vague = harness({ detail: memoryDetail({ importantMoment: false }) });
    vague.service.initialize();
    expect(vague.repository.listOpen()).toEqual([]);
  });

  it("recovers an already pending window on restart, but expires it when the event passed", async () => {
    const h = harness();
    h.service.initialize();
    h.service.shutdown();
    h.setNow("2026-09-02T06:45:00.000Z");
    const restarted = new ProactiveOpportunityService(h.options);
    restarted.initialize();
    await restarted.runDue();
    expect(
      h.ingest.mock.calls.filter(
        ([item]) => item.opportunity?.status === "due",
      ),
    ).toHaveLength(1);
    h.setNow(OCCURS_AT);
    await restarted.runDue();
    expect(h.ingest.mock.calls.at(-1)![0].opportunity?.status).toBe(
      "cancelled",
    );
    expect(h.repository.findLatestForMemory(MEMORY_ID)?.state).toBe(
      "cancelled",
    );
  });

  it("cancels a published cue on source revision change and schedules only the new explicit time", async () => {
    const h = harness();
    h.service.initialize();
    h.setNow(EVALUATE_AT);
    await h.service.runDue();
    const revised = memoryDetail({
      revisionId: randomUUID(),
      occursAt: "2026-09-03T07:00:00.000Z",
    });
    h.setDetail(revised);
    h.service.handleMemoryChanged(MEMORY_ID);
    h.service.handleMemoryChanged(MEMORY_ID);
    expect(
      h.ingest.mock.calls.filter(
        ([item]) => item.opportunity?.status === "cancelled",
      ),
    ).toHaveLength(1);
    expect(h.service.earliestNextRunAt()).toBe("2026-09-03T06:30:00.000Z");
  });

  it("revokes category permission after publication and allows pre-window re-enablement", async () => {
    const h = harness();
    h.service.initialize();
    h.setEnabled(false);
    h.service.handlePermissionChanged(false);
    expect(h.repository.findLatestForMemory(MEMORY_ID)?.state).toBe(
      "cancelled",
    );
    h.setEnabled(true);
    h.service.handlePermissionChanged(true);
    h.setNow(EVALUATE_AT);
    await h.service.runDue();
    expect(h.ingest.mock.calls.at(-1)![0].opportunity?.status).toBe("due");
    h.setEnabled(false);
    h.service.handlePermissionChanged(false);
    expect(h.repository.findLatestForMemory(MEMORY_ID)?.state).toBe(
      "cancelled",
    );
    const snapshot = h.cognition.getSnapshot(h.personaId, EVALUATE_AT);
    const due = snapshot.evidence.find(
      (item) => item.opportunity?.status === "due",
    )!;
    expect(opportunityIsCurrent(due, snapshot, EVALUATE_AT)).toBe(false);
  });

  it("keeps failed publication recoverable without an immediate polling loop", async () => {
    const h = harness();
    h.service.initialize();
    h.setNow(EVALUATE_AT);
    h.ingest.mockImplementationOnce(() => {
      throw new Error("Synthetic persistence failure");
    });
    await h.service.runDue();
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.repository.findLatestForMemory(MEMORY_ID)?.state).toBe(
      "evaluating",
    );
    expect(h.service.earliestNextRunAt()).toBeUndefined();
    h.service.shutdown();
    const restarted = new ProactiveOpportunityService(h.options);
    restarted.initialize();
    await restarted.runDue();
    expect(
      h.cognition
        .getSnapshot(h.personaId, EVALUATE_AT)
        .evidence.filter((item) => item.opportunity?.status === "due"),
    ).toHaveLength(1);
  });

  it("deduplicates a crash after Cognition persistence but before source marking", async () => {
    const h = harness();
    h.service.initialize();
    h.setNow(EVALUATE_AT);
    vi.spyOn(h.repository, "markPublished").mockImplementationOnce(() => {
      throw new Error("Synthetic crash");
    });
    await h.service.runDue();
    const restarted = new ProactiveOpportunityService(h.options);
    restarted.initialize();
    await restarted.runDue();
    expect(
      h.cognition
        .getSnapshot(h.personaId, EVALUATE_AT)
        .evidence.filter((item) => item.opportunity?.status === "due"),
    ).toHaveLength(1);
    expect(h.repository.findLatestForMemory(MEMORY_ID)?.state).toBe("resolved");
  });

  it("does not publish after shutdown or into an archived Chat", async () => {
    const h = harness();
    h.service.initialize();
    h.service.shutdown();
    h.setNow(EVALUATE_AT);
    await h.service.runDue();
    expect(h.ingest).not.toHaveBeenCalled();
    const archived = harness();
    archived.service.initialize();
    archived.setChatActive(false);
    archived.setNow(EVALUATE_AT);
    await archived.service.runDue();
    expect(
      archived.ingest.mock.calls.every(
        ([item]) => item.opportunity?.status === "cancelled",
      ),
    ).toBe(true);
  });
});
