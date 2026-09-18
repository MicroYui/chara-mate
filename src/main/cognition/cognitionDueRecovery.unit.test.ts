import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { AutomationScheduler } from "../automations/automationScheduler";
import { CognitionRepository } from "./cognitionRepository";
import {
  CognitionService,
  type CognitionServiceOptions,
} from "./cognitionService";
import { CognitionConflictError } from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionIntent,
} from "./cognitionTypes";

const personaId = "11111111-1111-4111-8111-111111111111";
const at = "2026-09-16T08:00:00.000Z";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
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
          rationale: "本次暂歇",
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
      reason: "明确选择安静",
    },
  };
}
function intent(id = randomUUID(), nextWakeAt = at): CognitionIntent {
  return {
    id,
    personaId,
    revision: 1,
    owner: "character",
    basis: "character",
    status: "active",
    goal: "看看住处",
    successCriteria: [],
    evidenceIds: [],
    effectEvidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "尚未开始",
    nextWakeAt,
    createdAt: at,
    updatedAt: at,
  };
}
function fixture(overrides: Partial<CognitionServiceOptions> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "cm-cognition-due-"));
  const databasePath = path.join(directory, "app.sqlite");
  let database = new Database(databasePath);
  database.exec(CURRENT_SCHEMA_SQL);
  database
    .prepare(
      "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, at, at);
  let repository = new CognitionRepository(database, {
    readBudgetBytes: 32768,
  });
  let now = at;
  const clock = { now: () => now };
  const driver = {
    analyze: vi
      .fn<(_: CognitionAnalysisInput) => Promise<CognitionAnalysis>>()
      .mockResolvedValue(quiet()),
  };
  const dispatch = vi.fn<CognitionServiceOptions["runtime"]["dispatch"]>(
    (request) => {
      const runId = randomUUID();
      database.transaction(() =>
        repository.bindDispatched(request.dispatchKey, runId, clock.now()),
      )();
      return Promise.resolve({ runId });
    },
  );
  const errors: unknown[] = [];
  const build = () =>
    new CognitionService({
      repository,
      driver,
      memory: {
        recall: () =>
          Promise.resolve({
            items: [],
            coverage: [],
            gaps: [],
            estimatedTokens: 0,
            truncated: false,
            incompleteReasons: [],
          }),
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
          characterTools: [],
          mayActInTerritory: true,
        }),
        dispatch,
        yieldCharacterRun: async () => {},
        reconcileRun: () => ({ terminal: false, evidence: [] }),
      },
      clock,
      activePersonaId: () => personaId,
      analysisReadBudgetBytes: 32768,
      analysisBudgetTokens: 100000,
      batchWindowMs: 0,
      onError: (e) => errors.push(e),
      ...overrides,
    });
  let service = build();
  cleanup.push(async () => {
    await service.shutdown();
    database.close();
    rmSync(directory, { recursive: true });
  });
  return {
    driver,
    dispatch,
    errors,
    clock,
    get service() {
      return service;
    },
    get repository() {
      return repository;
    },
    get database() {
      return database;
    },
    advance(value: string) {
      now = value;
    },
    async reopen() {
      await service.shutdown();
      database.close();
      database = new Database(databasePath);
      repository = new CognitionRepository(database, {
        readBudgetBytes: 32768,
      });
      service = build();
      service.initialize();
    },
  };
}

describe("durable due consideration", () => {
  it("retains an unconsumed wake on analysis failure and retries once after an actual disk reopen", async () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    f.driver.analyze.mockRejectedValueOnce(
      new CognitionConflictError("Invalid source use"),
    );
    await f.service.runDue();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    expect(f.service.earliestNextRunAt()).toBeUndefined();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledTimes(1);
    f.advance("2026-10-16T08:00:00.000Z");
    await f.reopen();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledTimes(2);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
  });
  it("does not lose due work when the input refresh fails before an attempt exists", async () => {
    const beforeAnalysis = vi
      .fn()
      .mockRejectedValueOnce(new Error("Refresh unavailable"))
      .mockResolvedValue(undefined);
    const f = fixture({ beforeAnalysis });
    const value = intent();
    f.service.saveCharacterIntent(value);
    await f.service.runDue();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    expect(f.driver.analyze).not.toHaveBeenCalled();
    await f.reopen();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledOnce();
  });
  it("retains the original due time when the actual state commit rolls back", async () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    f.driver.analyze.mockImplementationOnce(() => {
      f.database.exec(
        "CREATE TEMP TRIGGER fail_due_commit BEFORE UPDATE ON cognition_state BEGIN SELECT RAISE(ABORT,'state commit failed'); END",
      );
      return Promise.resolve(quiet());
    });
    await f.service.runDue();
    expect(f.errors).toHaveLength(1);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    f.database.exec("DROP TRIGGER fail_due_commit");
    f.service.retryAfterConfigurationChange();
    await f.service.runDue();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
  });
});

function continuing(id: string): CognitionAnalysis {
  const value = quiet();
  value.decision.choices[0] = {
    ...value.decision.choices[0]!,
    kind: "continue_character",
    intentId: id,
    executionScope: "territory",
    reversibility: "undoable",
    instruction: "按真实领地能力选择下一步",
  };
  return value;
}
function commit(
  f: ReturnType<typeof fixture>,
  output: CognitionAnalysis,
  selectedIds?: string[],
) {
  const snapshotRead = f.repository.readSnapshot(personaId, f.clock.now());
  const snapshot = snapshotRead.snapshot;
  if (selectedIds)
    snapshot.intents = snapshot.intents.filter(({ id }) =>
      selectedIds.includes(id),
    );
  let attempt = f.repository.createAttempt(
    snapshotRead,
    "character_due",
    f.clock.now(),
  );
  attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
  return f.repository.commitAnalysis(attempt.id, output, f.clock.now());
}

describe("due work ownership and retry events", () => {
  it("does not consider a supplied due time new after the input refresh crosses its deadline", async () => {
    const start = "2026-09-16T08:59:00.000Z";
    const secondAt = "2026-09-16T09:00:00.000Z";
    const snapshotAt = "2026-09-16T09:01:00.000Z";
    const thirdAt = "2026-09-16T10:00:00.000Z";
    const f = fixture({
      beforeAnalysis: () => {
        f.advance(snapshotAt);
        return Promise.resolve();
      },
    });
    f.advance(start);
    const first = intent(randomUUID(), start);
    const second = intent(randomUUID(), secondAt);
    const third = intent(randomUUID(), thirdAt);
    for (const value of [first, second, third])
      f.service.saveCharacterIntent(value);
    f.driver.analyze.mockRejectedValue(new Error("Unavailable"));
    await f.service.runDue();
    const supplied = f.driver.analyze.mock.calls[0]![0];
    expect(supplied.snapshot.intents.map(({ id }) => id)).toContain(second.id);
    expect(supplied.attempt.createdAt).toBe(start);
    expect(f.service.earliestNextRunAt()).toBe(thirdAt);
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledOnce();
    expect(f.repository.getIntent(second.id)?.nextWakeAt).toBe(secondAt);
  });

  it("consumes every due item actually supplied after refresh while preserving attempt start time", async () => {
    const start = "2026-09-16T08:59:00.000Z";
    const secondAt = "2026-09-16T09:00:00.000Z";
    const snapshotAt = "2026-09-16T09:01:00.000Z";
    const f = fixture({
      beforeAnalysis: () => {
        f.advance(snapshotAt);
        return Promise.resolve();
      },
    });
    f.advance(start);
    const first = intent(randomUUID(), start);
    const second = intent(randomUUID(), secondAt);
    for (const value of [first, second]) f.service.saveCharacterIntent(value);
    await f.service.runDue();
    expect(f.errors).toEqual([]);
    const supplied = f.driver.analyze.mock.calls[0]![0];
    expect(supplied.snapshot.intents.map(({ id }) => id)).toContain(second.id);
    expect(supplied.attempt.createdAt).toBe(start);
    expect(supplied.attempt.wakeSources?.intents.map(({ id }) => id)).toContain(
      second.id,
    );
    expect(f.repository.getIntent(first.id)?.nextWakeAt).toBeUndefined();
    expect(f.repository.getIntent(second.id)?.nextWakeAt).toBeUndefined();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledOnce();
  });

  it("lets an independently scheduled later consideration run once without retrying the same failed due", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const secondAt = "2026-09-16T09:00:00.000Z";
    const thirdAt = "2026-09-16T10:00:00.000Z";
    const first = intent(),
      second = intent(randomUUID(), secondAt),
      third = intent(randomUUID(), thirdAt);
    for (const value of [first, second, third])
      f.service.saveCharacterIntent(value);
    f.driver.analyze.mockRejectedValue(new Error("Unavailable"));
    const scheduler = new AutomationScheduler(f.service, f.clock);
    cleanup.push(() => scheduler.stop());
    scheduler.start();
    await f.service.runDue();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.driver.analyze).toHaveBeenCalledOnce();
    expect(f.service.earliestNextRunAt()).toBe(secondAt);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.driver.analyze).toHaveBeenCalledOnce();
    f.advance(secondAt);
    await vi.advanceTimersByTimeAsync(3_540_000);
    expect(f.driver.analyze).toHaveBeenCalledTimes(2);
    expect(f.service.earliestNextRunAt()).toBe(thirdAt);
    for (let i = 0; i < 5; i++) scheduler.refresh();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledTimes(2);
    expect(f.repository.getIntent(first.id)?.nextWakeAt).toBe(at);
    expect(f.repository.getIntent(second.id)?.nextWakeAt).toBe(secondAt);
    f.driver.analyze.mockResolvedValue(quiet());
    f.advance(thirdAt);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.driver.analyze).toHaveBeenCalledTimes(3);
    for (const value of [first, second, third])
      expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
    expect(f.service.earliestNextRunAt()).toBeUndefined();
  });

  it("does not spin the actual scheduler or release a failure on counts and repeated refreshes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.driver.analyze.mockRejectedValue(new Error("Unavailable"));
    const value = intent();
    f.service.saveCharacterIntent(value);
    const scheduler = new AutomationScheduler(f.service, f.clock);
    cleanup.push(() => scheduler.stop());
    scheduler.start();
    await f.service.runDue();
    for (let i = 0; i < 20; i++) {
      f.service.ingest({
        id: randomUUID(),
        personaId,
        actor: "unknown",
        kind: "observation",
        boundary: "interaction",
        source: { kind: "activity", id: randomUUID() },
        observedAt: at,
        interaction: { keystrokes: 1, clicks: 0, scrolls: 0 },
      });
      scheduler.refresh();
    }
    await f.service.prepareTurn({
      personaId,
      chatId: randomUUID(),
      currentInput: "hello",
      contextBudget: { maxTokens: 2000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.driver.analyze).toHaveBeenCalledOnce();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    expect(f.service.earliestNextRunAt()).toBeUndefined();
    f.driver.analyze.mockResolvedValue(quiet());
    f.service.ingest({
      id: randomUUID(),
      personaId,
      actor: "user",
      kind: "utterance",
      source: { kind: "message", id: randomUUID() },
      text: "现在继续看看",
      observedAt: at,
    });
    scheduler.refresh();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
  it("does not consume a due intention omitted from the actual snapshot", () => {
    const f = fixture();
    const first = intent(),
      second = intent();
    f.service.saveCharacterIntent(first);
    f.service.saveCharacterIntent(second);
    const ready = commit(f, quiet(), [first.id]);
    expect(ready.wakeSources?.intents.map((v) => v.id)).toEqual([first.id]);
    expect(f.repository.getIntent(first.id)?.nextWakeAt).toBeUndefined();
    expect(f.repository.getIntent(second.id)?.nextWakeAt).toBe(at);
  });
  it("preserves a new future plan and does not restore over its revision", () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    const ready = commit(f, continuing(value.id));
    const current = f.repository.getIntent(value.id)!;
    const future = "2026-09-18T08:00:00.000Z";
    f.service.saveCharacterIntent(
      { ...current, revision: current.revision + 1, nextWakeAt: future },
      current.revision,
    );
    f.repository.restoreAttemptWakes(ready, at);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(future);
  });
  it("does not restore a stage paused by the user after a final decision", () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    const ready = commit(f, continuing(value.id));
    const current = f.repository.getIntent(value.id)!;
    f.service.saveCharacterIntent(
      {
        ...current,
        revision: current.revision + 1,
        status: "suspended",
        blockers: ["autonomous_life_paused"],
      },
      current.revision,
    );
    f.repository.restoreAttemptWakes(ready, at);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
  });
  it("leaves due work pending through recall and final-completion failure", async () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    f.driver.analyze
      .mockImplementationOnce(() => {
        const result = quiet();
        result.recallPlan = {
          purpose: "conversation",
          query: "原来的目标",
          questions: [{ id: "goal", text: "此前进行到了哪里" }],
          contextBudget: { maxTokens: 1000 },
        };
        return Promise.resolve(result);
      })
      .mockImplementationOnce(() => {
        expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
        return Promise.reject(new Error("Completion unavailable"));
      });
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledTimes(2);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    expect(f.service.earliestNextRunAt()).toBeUndefined();
    await f.reopen();
    await f.service.runDue();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
  });
  it("restores a final ready decision after closing and reopening the actual database", async () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    const ready = commit(f, continuing(value.id));
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
    await f.reopen();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    expect(f.repository.getAttempt(ready.id)?.status).toBe("superseded");
    f.driver.analyze.mockResolvedValue(continuing(value.id));
    await f.service.runDue();
    expect(f.dispatch).toHaveBeenCalledOnce();
    const dispatchedView = f.repository
      .getSnapshot(personaId, at)
      .recentAttempts.find((v) => v.runId)!;
    const dispatched = f.repository.getAttempt(dispatchedView.id)!;
    expect(f.repository.actionFreshness(dispatched, at).current).toBe(true);
    await f.reopen();
    await f.service.runDue();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("restores consideration when dispatch fails before allocating a Run", async () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    f.driver.analyze.mockResolvedValue(continuing(value.id));
    f.dispatch.mockRejectedValueOnce(new Error("Before Run allocation"));
    await f.service.runDue();
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
    expect(f.service.earliestNextRunAt()).toBeUndefined();
    f.service.retryAfterConfigurationChange();
    await f.service.runDue();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBeUndefined();
  });
  it("does not retry the model after a visual refresh returned unchanged input", async () => {
    const beforeAnalysis = vi.fn().mockResolvedValue(undefined);
    const f = fixture({ beforeAnalysis });
    f.service.saveCharacterIntent(intent());
    f.driver.analyze.mockRejectedValue(new Error("Unavailable"));
    await f.service.runDue();
    f.service.notifyVisualChange();
    await f.service.runDue();
    expect(beforeAnalysis).toHaveBeenCalledTimes(2);
    expect(f.driver.analyze).toHaveBeenCalledOnce();
    expect(f.service.earliestNextRunAt()).toBeUndefined();
  });
  it("does not treat an actual new message arriving during failure as the failed context", async () => {
    const f = fixture();
    f.service.saveCharacterIntent(intent());
    let reject!: (e: Error) => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.driver.analyze.mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
          started();
        }),
    );
    const pending = f.service.runDue();
    await begun;
    f.service.ingest({
      id: randomUUID(),
      personaId,
      actor: "user",
      kind: "utterance",
      source: { kind: "message", id: randomUUID() },
      text: "刚才的条件改了",
      observedAt: at,
    });
    reject(new Error("In-flight failure"));
    await pending;
    expect(f.service.earliestNextRunAt()).toBeDefined();
    await f.service.runDue();
    expect(f.driver.analyze).toHaveBeenCalledTimes(2);
  });
});

describe("due allocation and final model plans", () => {
  it("acknowledges the old due consideration without clearing its explicit new future plan", async () => {
    const f = fixture();
    const value = intent();
    f.service.saveCharacterIntent(value);
    const future = "2026-10-01T08:00:00.000Z";
    f.driver.analyze.mockImplementationOnce(() => {
      const result = quiet();
      result.delta.updateIntents = [
        {
          id: value.id,
          expectedRevision: value.revision,
          value: {
            owner: "character",
            basis: "character",
            status: "active",
            goal: value.goal,
            successCriteria: [],
            evidenceIds: [],
            effectEvidenceIds: [],
            blockers: [],
            resumeConditions: [
              { kind: "time", after: future, description: "下次再考虑" },
            ],
            progress: "本次选择休息",
            nextWakeAt: future,
          },
        },
      ];
      return Promise.resolve(result);
    });
    await f.service.runDue();
    expect(f.errors).toEqual([]);
    expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(future);
    expect(f.service.earliestNextRunAt()).toBe(future);
  });
  it("supplies the oldest due work before future plans and leaves bounded omissions pending", () => {
    const f = fixture();
    const first = intent(undefined, "2026-09-01T08:00:00.000Z");
    f.service.saveCharacterIntent(first);
    const others = Array.from({ length: 24 }, () => intent());
    for (const value of others)
      f.service.saveCharacterIntent({
        ...value,
        progress: "有依据的日常细节".repeat(500),
      });
    f.service.saveCharacterIntent(
      intent(undefined, "2026-10-01T08:00:00.000Z"),
    );
    const read = f.repository.readSnapshot(personaId, at, 5000);
    expect(read.snapshot.intents.map((v) => v.id)).toContain(first.id);
    expect(read.snapshot.intents.length).toBeLessThan(26);
    let attempt = f.repository.createAttempt(
      read,
      "character_due",
      at,
      read.coverage.allocation,
    );
    attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    f.repository.commitAnalysis(attempt.id, quiet(), at);
    expect(f.repository.getIntent(first.id)?.nextWakeAt).toBeUndefined();
    for (const value of others.filter(
      (v) => !read.snapshot.intents.some((s) => s.id === v.id),
    ))
      expect(f.repository.getIntent(value.id)?.nextWakeAt).toBe(at);
  });
});
