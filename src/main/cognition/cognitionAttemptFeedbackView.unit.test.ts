import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import {
  CognitionDecisionAttemptSchema,
  CognitionSnapshotSchema,
} from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import { CognitionMaterialResourceError } from "./cognitionActionContext";
import { CognitionRepository } from "./cognitionRepository";
import { CognitionService } from "./cognitionService";
import {
  projectCognitionContext,
  selectAnalysisSnapshot,
} from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionDispatchRequest,
  CognitionIntent,
  CognitionSnapshot,
} from "./cognitionTypes";

const at = "2026-09-17T08:00:00.000Z";
const later = "2026-09-17T09:00:00.000Z";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.useRealTimers();
});
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

function quiet(): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: {},
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: [],
          rationale: "先保留未完成条件",
          userImpact: "none",
          executionScope: "none",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
        },
      ],
      selectedChoiceId: "quiet",
      selectedBasis: {
        choiceId: "quiet",
        evidenceUses: [],
        currentClaimRefs: [],
      },
      reason: "本次安静不表示完成",
    },
  };
}

function fixture(readBudgetBytes = 32_768, sourceCount = 1) {
  vi.useFakeTimers();
  const database = new Database(":memory:");
  database.exec(CURRENT_SCHEMA_SQL);
  const personaId = randomUUID();
  database
    .prepare(
      "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, at, at);
  const repository = new CognitionRepository(database, { readBudgetBytes });
  const sources = Array.from({ length: sourceCount }, (_, index) => {
    const id = randomUUID();
    return repository.ingest(
      {
        id,
        personaId,
        actor: "unknown",
        kind: "observation",
        source: { kind: "activity", id },
        observedAt: at,
        boundary: "content",
        object: {
          key: `fixture-${index}`,
          identity: "adapter",
          appName: "Notes",
        },
        text: `可见记录 ${index}：纸灯仍在室内，雨停以前不要搬到露台。`,
      },
      at,
    ).evidence;
  });
  const intent: CognitionIntent = {
    id: randomUUID(),
    personaId,
    revision: 1,
    owner: "character",
    basis: "character",
    status: "active",
    goal: "查看纸灯的实际位置",
    successCriteria: ["遵守雨天留在室内的条件"],
    evidenceIds: sources.map(({ id }) => id),
    effectEvidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "尚未执行",
    nextWakeAt: at,
    createdAt: at,
    updatedAt: at,
  };
  let now = at;
  const errors: unknown[] = [];
  const analyze = vi
    .fn<(_: CognitionAnalysisInput) => Promise<CognitionAnalysis>>()
    .mockResolvedValue(quiet());
  const dispatch = vi.fn((request: CognitionDispatchRequest) => {
    // Use the real selected-material SQL and resource error. No Run is bound
    // and no synthetic failed Attempt is inserted by the fixture.
    request.prepareContext({
      maxReadBytes: 1,
      signal: new AbortController().signal,
    });
    return Promise.reject(
      new Error("Expected the actual material read to fail"),
    );
  });
  const recall = vi.fn(() =>
    Promise.resolve({
      items: [],
      coverage: [],
      gaps: [],
      estimatedTokens: 0,
      truncated: false,
      incompleteReasons: [],
    }),
  );
  const service = new CognitionService({
    repository,
    driver: { analyze },
    memory: {
      recall,
      resolveEvidence: () => ({
        status: "resolved",
        items: [],
        readCost: { rawValueBytes: 0, rowCount: 0 },
      }),
      validateEvidenceReferences: () => [],
    },
    runtime: {
      availability: () => ({
        userEngaged: false,
        activeUserRunIds: [],
        chatRuns: [],
        activeVoice: false,
        sleeping: false,
        hasOutstandingBubble: false,
        mayInitiateConversation: true,
        mayActInTerritory: true,
        characterTools: [],
      }),
      dispatch,
      yieldCharacterRun: () => Promise.resolve(),
      reconcileRun: () => ({ terminal: false, evidence: [] }),
    },
    clock: { now: () => now },
    activePersonaId: () => personaId,
    analysisReadBudgetBytes: readBudgetBytes,
    analysisBudgetTokens: 100_000,
    batchWindowMs: 0,
    onError: (error) => errors.push(error),
  });
  closes.push(async () => {
    await service.shutdown();
    database.close();
  });
  service.saveCharacterIntent(intent);
  const output = quiet();
  output.decision.choices[0] = {
    ...output.decision.choices[0]!,
    kind: "continue_character",
    intentId: intent.id,
    evidenceIds: [sources[0]!.id],
    executionScope: "territory",
    instruction: "读取纸灯的真实状态后再决定行动。",
  };
  output.decision.selectedBasis.evidenceUses = [
    { evidenceId: sources[0]!.id, use: "history" },
  ];
  const fail = async (largeDecision = false) => {
    if (largeDecision)
      output.decision.reason = "逐项核对记录中已有条件与实际动作范围。".repeat(
        2500,
      );
    analyze.mockResolvedValueOnce(output);
    await service.runDue();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(CognitionMaterialResourceError);
    const attempt = repository.getAttempt(
      dispatch.mock.calls[0]![0].attemptId,
    )!;
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toContain(
      "Complete required material was not loaded",
    );
    expect(attempt.runId).toBeUndefined();
    return attempt;
  };
  return {
    database,
    repository,
    personaId,
    service,
    analyze,
    dispatch,
    recall,
    errors,
    sources,
    intent,
    fail,
    advance: (value: string) => {
      now = value;
    },
  };
}

describe("bounded Attempt lifecycle feedback", () => {
  it("supplies a real material failure on the next independently due consideration without replaying its large decision", async () => {
    const f = fixture();
    const future = { ...f.intent, id: randomUUID(), nextWakeAt: later };
    f.service.saveCharacterIntent(future);
    const failed = await f.fail(true);
    expect(bytes(failed)).toBeGreaterThan(32_768);
    expect(f.repository.getIntent(f.intent.id)?.nextWakeAt).toBe(at);
    expect(f.repository.getIntent(future.id)?.nextWakeAt).toBe(later);
    const evidenceCount = f.database
      .prepare("SELECT count(*) AS n FROM cognition_evidence")
      .get() as { n: number };
    await f.service.runDue();
    expect(f.analyze).toHaveBeenCalledOnce();
    expect(f.service.earliestNextRunAt()).toBe(later);

    f.advance(later);
    await f.service.runDue();

    expect(f.analyze).toHaveBeenCalledTimes(2);
    const supplied = f.analyze.mock.calls[1]![0];
    expect(supplied.snapshot.recentAttempts[0]).toMatchObject({
      id: failed.id,
      projection: "lifecycle",
      status: "failed",
      error: failed.error,
      throughSequence: failed.throughSequence,
    });
    expect(supplied.snapshot.recentAttempts[0]).not.toHaveProperty("decision");
    expect(supplied.snapshot.recentAttempts[0]).not.toHaveProperty(
      "dependencies",
    );
    expect(supplied.snapshot.intents.map(({ id }) => id)).toContain(
      f.intent.id,
    );
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(
      f.database.prepare("SELECT count(*) AS n FROM cognition_evidence").get(),
    ).toEqual(evidenceCount);
  });

  it("does not copy or falsify a large required dependency set to expose the failure", async () => {
    const f = fixture(1024 * 1024, 400);
    const failed = await f.fail();
    expect(failed.dependencies.evidenceIds).toHaveLength(400);
    expect(bytes(failed.dependencies)).toBeGreaterThan(8192);
    const read = f.repository.readSnapshot(f.personaId, later, 8192);
    expect(bytes(read)).toBeLessThanOrEqual(8192);
    expect(read.snapshot.recentAttempts[0]).toMatchObject({
      id: failed.id,
      projection: "lifecycle",
      error: failed.error,
    });
    expect(read.snapshot.recentAttempts[0]).not.toHaveProperty("dependencies");
    expect(read.snapshot.recentAttempts[0]).not.toHaveProperty("actionReadSet");
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
    expect(parseSchema(CognitionSnapshotSchema, read.snapshot)).toEqual(
      read.snapshot,
    );
    expect(() =>
      parseSchema(
        CognitionDecisionAttemptSchema,
        read.snapshot.recentAttempts[0],
      ),
    ).toThrow();
  });

  it("upgrades a small view to the complete unchanged prior Attempt", async () => {
    const f = fixture();
    const failed = await f.fail();
    const read = f.repository.readSnapshot(f.personaId, later);
    expect(read.snapshot.recentAttempts[0]).toEqual({
      ...failed,
      projection: "complete",
    });
    expect(parseSchema(CognitionSnapshotSchema, read.snapshot)).toEqual(
      read.snapshot,
    );
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
  });

  it("keeps failure feedback alongside an excerpt of a newer large user message", async () => {
    const f = fixture();
    const failed = await f.fail(true);
    const id = randomUUID();
    const message = "新条件：先不移动纸灯；我补充原说明。".repeat(5000);
    const incoming = f.repository.ingest(
      {
        id,
        personaId: f.personaId,
        kind: "utterance",
        actor: "user",
        source: { kind: "run", id: randomUUID(), fragment: randomUUID() },
        observedAt: later,
        text: message,
      },
      later,
    ).evidence;
    const read = f.repository.readSnapshot(f.personaId, later, 8192);
    expect(bytes(read)).toBeLessThanOrEqual(8192);
    expect(read.snapshot.recentAttempts[0]?.error).toBe(failed.error);
    expect(read.coverage.currentUserSource?.evidenceId).toBe(incoming.id);
    expect(read.coverage.excerptedEvidenceIds).toContain(incoming.id);
    expect(
      read.snapshot.evidence.find(
        ({ id: evidenceId }) => evidenceId === incoming.id,
      )?.text,
    ).toContain("新条件：先不移动纸灯");
    expect(
      f.database
        .prepare(
          "SELECT json_extract(payload_json, '$.text') AS text FROM cognition_evidence WHERE id=?",
        )
        .get(incoming.id),
    ).toEqual({ text: message });
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
  });

  it("preserves the same lifecycle feedback when Recall completion reallocates the snapshot", async () => {
    const f = fixture();
    const failed = await f.fail(true);
    const read = f.repository.readSnapshot(f.personaId, later);
    const full: CognitionSnapshot = {
      ...read.snapshot,
      recentAttempts: [{ ...failed, status: "ready", projection: "complete" }],
    };
    delete full.attention.committedIntentId;
    delete full.attention.currentSituationId;
    expect(projectCognitionContext(full, 8192, read).intentIds).toContain(
      f.intent.id,
    );
    const selected = selectAnalysisSnapshot(full, 8192);
    expect(bytes(selected)).toBeLessThan(8192);
    expect(selected.snapshot.recentAttempts[0]).toMatchObject({
      id: failed.id,
      projection: "lifecycle",
      error: failed.error,
    });
    expect(selected.coverage.omittedAttemptCount).toBe(0);
    // A lifecycle view has no authority to select an otherwise unrelated goal.
    expect(
      projectCognitionContext(selected.snapshot, 8192, {
        coverage: selected.coverage,
        receivedThroughSequence: full.attention.lastReceiptSequence,
      }).intentIds,
    ).toEqual([]);
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
  });

  it("carries actually supplied failure feedback through the real Service Recall re-read", async () => {
    const f = fixture();
    const future = { ...f.intent, id: randomUUID(), nextWakeAt: later };
    f.service.saveCharacterIntent(future);
    const failed = await f.fail(true);
    f.analyze.mockImplementation((input) => {
      const output = quiet();
      if (!input.evidencePack)
        output.recallPlan = {
          purpose: "initiative",
          query: "纸灯原来的条件",
          questions: [{ id: "condition", text: "原来需要等待什么条件？" }],
          contextBudget: { maxTokens: 1000 },
        };
      return Promise.resolve(output);
    });
    f.recall.mockImplementationOnce(() => {
      // This is the actual persisted awaiting-recall transition. The database
      // reader no longer returns the old terminal record on its own.
      const during = f.repository.readSnapshot(f.personaId, later);
      expect(during.snapshot.recentAttempts[0]?.status).toBe("awaiting_recall");
      expect(during.snapshot.recentAttempts.map(({ id }) => id)).not.toContain(
        failed.id,
      );
      expect(f.repository.getIntent(future.id)?.nextWakeAt).toBe(later);
      return Promise.resolve({
        items: [],
        coverage: [],
        gaps: [],
        estimatedTokens: 0,
        truncated: false,
        incompleteReasons: [],
      });
    });
    f.advance(later);
    await f.service.runDue();

    expect(f.analyze).toHaveBeenCalledTimes(3);
    expect(f.recall).toHaveBeenCalledOnce();
    const first = f.analyze.mock.calls[1]![0];
    const completion = f.analyze.mock.calls[2]![0];
    for (const input of [first, completion]) {
      expect(
        input.snapshot.recentAttempts.find(({ id }) => id === failed.id),
      ).toMatchObject({
        id: failed.id,
        projection: "lifecycle",
        status: "failed",
        error: failed.error,
      });
      expect(
        bytes({ snapshot: input.snapshot, coverage: input.coverage }),
      ).toBeLessThan(32_768);
    }
    expect(completion.snapshot.recentAttempts[0]?.id).toBe(first.attempt.id);
    expect(
      completion.snapshot.recentAttempts.find(({ id }) => id === failed.id),
    ).not.toHaveProperty("dependencies");
    expect(completion.attempt.id).toBe(first.attempt.id);
    expect(completion.attempt.dependencies.receivedThroughSequence).toBe(
      first.attempt.dependencies.receivedThroughSequence,
    );
    expect(completion.snapshot.attention.lastReceiptSequence).toBe(
      first.attempt.throughSequence,
    );
    expect(f.repository.getAttempt(first.attempt.id)?.status).toBe("settled");
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.errors).toHaveLength(1);
    await f.service.runDue();
    expect(f.analyze).toHaveBeenCalledTimes(3);
  });

  it("retains failure and current user words when a real database page is reallocated ahead of older unread content", async () => {
    const f = fixture();
    const failed = await f.fail(true);
    const insert = (kind: "observation" | "utterance", text: string) => {
      const id = randomUUID();
      return f.repository.ingest(
        {
          id,
          personaId: f.personaId,
          kind,
          actor: kind === "utterance" ? "user" : "unknown",
          source:
            kind === "utterance"
              ? { kind: "run", id: randomUUID(), fragment: randomUUID() }
              : { kind: "activity", id },
          observedAt: later,
          text,
        },
        later,
      ).evidence;
    };
    const oldest = insert(
      "observation",
      "旧窗口完整内容，仍未解释。".repeat(5000),
    );
    const middle = insert(
      "observation",
      "下一段旧内容，不可跳过。".repeat(5000),
    );
    const userText = "最新改口：先别搬纸灯，等雨停再说。".repeat(400);
    const user = insert("utterance", userText);
    // Retain an explicitly selected old original while reallocating the page;
    // unrelated middle versions remain only in the catalogue.
    const read = f.repository.readSnapshot(
      f.personaId,
      later,
      32_768,
      undefined,
      [oldest.id],
    );
    const oldestInput = read.snapshot.evidence.find(
      ({ id }) => id === oldest.id,
    );
    expect(oldestInput?.text?.length).toBeGreaterThan(500);
    expect(read.snapshot.evidence.find(({ id }) => id === user.id)?.text).toBe(
      userText,
    );
    const selected = selectAnalysisSnapshot(read.snapshot, 8192, read.coverage);
    const suppliedUser = selected.snapshot.evidence.filter(
      ({ id }) => id === user.id,
    );
    expect(suppliedUser).toHaveLength(1);
    expect(suppliedUser[0]?.text).toContain("最新改口：先别搬纸灯");
    expect(selected.coverage.currentUserSource).toMatchObject({
      evidenceId: user.id,
      status: "excerpted",
    });
    expect(selected.coverage.excerptedEvidenceIds).toContain(user.id);
    expect(
      selected.snapshot.recentAttempts.find(({ id }) => id === failed.id)
        ?.error,
    ).toBe(failed.error);
    expect(selected.snapshot.evidence.map(({ id }) => id)).toContain(oldest.id);
    expect(selected.snapshot.evidence.map(({ id }) => id)).not.toContain(
      middle.id,
    );
    expect(selected.snapshot.attention.lastReceiptSequence).toBe(
      oldest.receiptSequence,
    );
    expect(selected.snapshot.attention.lastReceiptSequence).toBeLessThan(
      user.receiptSequence,
    );
    expect(bytes(selected)).toBeLessThan(8192);
    expect(
      f.repository.getAttention(f.personaId, later).analyzedThroughSequence,
    ).toBe(failed.throughSequence);
    expect(f.repository.getAttempt(failed.id)).toEqual(failed);
    expect(
      f.database
        .prepare(
          "SELECT json_extract(payload_json, '$.text') AS text FROM cognition_evidence WHERE id=?",
        )
        .get(user.id),
    ).toEqual({ text: userText });
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.recall).not.toHaveBeenCalled();
    expect(f.errors).toHaveLength(1);
  });
});
