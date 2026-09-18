import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { readEvidence } from "./cognitionSnapshotReader";
import { CognitionRepository } from "./cognitionRepository";
import { CognitionService } from "./cognitionService";
import { projectCognitionContext } from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionDriver,
  CognitionEvidenceInput,
} from "./cognitionTypes";
import type { EvidencePack } from "../../shared/contracts/memoryRecall";

const personaId = "11111111-1111-4111-8111-111111111111";
const databases: Database.Database[] = [];
const services: CognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  databases.splice(0).forEach((database) => database.close());
});
const emptyPack: EvidencePack = {
  items: [],
  coverage: [],
  gaps: [],
  estimatedTokens: 0,
  truncated: false,
  incompleteReasons: [],
};
function quiet(ids: string[] = []): CognitionAnalysis {
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
          evidenceIds: ids,
          rationale: "继续观察",
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
        evidenceUses: ids.map((evidenceId) => ({ evidenceId, use: "history" })),
        currentClaimRefs: [],
      },
      reason: "仅使用明确关联的来源",
    },
  };
}
function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 15, 8, 0, tick++)).toISOString();
  database
    .prepare(
      "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, now(), now());
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const input = (text: string): CognitionEvidenceInput => ({
    id: randomUUID(),
    personaId,
    actor: "user",
    kind: "observation",
    source: { kind: "activity", id: randomUUID() },
    observedAt: now(),
    text,
  });
  const source = (text: string) =>
    repository.ingest(input(text), now()).evidence;
  const commit = (output: CognitionAnalysis) => {
    const read = repository.readSnapshot(personaId, now());
    let attempt = repository.createAttempt(
      read,
      "semantic_change",
      now(),
      read.coverage.allocation,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const ready = repository.commitAnalysis(attempt.id, output, now());
    return repository.saveAttempt({
      ...ready,
      status: "settled",
      outcome: "quiet",
      updatedAt: now(),
    });
  };
  const service = (
    driver: CognitionDriver,
    recall = () => Promise.resolve(emptyPack),
  ) => {
    const errors: unknown[] = [];
    const value = new CognitionService({
      repository,
      driver,
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
          characterTools: [],
          mayActInTerritory: true,
        }),
        dispatch: () => Promise.reject(new Error("No action expected")),
        yieldCharacterRun: () => Promise.resolve(),
        reconcileRun: () => ({ terminal: false, evidence: [] }),
      },
      clock: { now },
      activePersonaId: () => personaId,
      analysisReadBudgetBytes: 32_768,
      analysisBudgetTokens: 32_768,

      batchWindowMs: 0,
      onError: (error) => errors.push(error),
    });
    services.push(value);
    return { service: value, errors };
  };
  return { database, repository, input, source, commit, now, service };
}

describe("Cognition recent source use", () => {
  it.each(["settled", "failed"] as const)(
    "does not replay exposure-only sources from a %s attempt, while preserving its CAS read-set and canonical text",
    (status) => {
      const f = fixture();
      const background = f.source("先前窗口中的未选用背景");
      const old = f.commit(quiet());
      f.repository.saveAttempt({ ...old, status });
      const fresh = f.source("另一个窗口的新内容");
      const read = f.repository.readSnapshot(personaId, f.now());
      expect(read.snapshot.evidence.map(({ id }) => id)).toContain(fresh.id);
      expect(read.snapshot.evidence.map(({ id }) => id)).not.toContain(
        background.id,
      );
      expect(
        f.repository.getAttempt(old.id)?.dependencies.evidenceIds,
      ).toContain(background.id);
      const view = read.snapshot.recentAttempts.find(({ id }) => id === old.id);
      expect(view?.projection).toBe("complete");
      if (view?.projection !== "complete")
        throw new Error("Expected the complete small Attempt view");
      expect(view.dependencies).toEqual(old.dependencies);
      expect(readEvidence(f.database, background.id, 8192)?.evidence.text).toBe(
        background.text,
      );
    },
  );

  it("retains actual selected source uses, then releases residency when the next decision stops using them", () => {
    const f = fixture();
    const selected = f.source("实际选用的旧依据");
    const background = f.source("同页曝光但没有采用");
    const first = f.commit(quiet([selected.id]));
    const fresh = f.source("本轮新窗口");
    const read = f.repository.readSnapshot(personaId, f.now());
    expect(read.snapshot.evidence.map(({ id }) => id)).toEqual([
      selected.id,
      fresh.id,
    ]);
    expect(
      f.repository.readActionContext(first, 8192, (value) => value).text,
    ).toContain(selected.text);
    expect(
      f.repository.readActionContext(first, 8192, (value) => value).text,
    ).not.toContain(background.text);
    const second = f.commit(quiet());
    expect(second.dependencies.evidenceIds).toContain(selected.id);
    f.source("下一轮的新内容");
    expect(
      f.repository.getSnapshot(personaId, f.now()).evidence.map(({ id }) => id),
    ).not.toContain(selected.id);
    expect(f.repository.getAttempt(second.id)?.dependencies).toEqual(
      second.dependencies,
    );
  });

  it("retains current claim support and contradiction and the selected intent's actual effect after restart supersedes an awaiting recall", () => {
    const f = fixture();
    const support = f.repository.ingest(
      {
        ...f.input("九月账本读回1260，请帮我核对月份"),
        kind: "utterance",
        source: { kind: "run", id: randomUUID(), fragment: randomUUID() },
      },
      f.now(),
    ).evidence;
    const contradiction = f.source("另一画面显示1190，需确认是八月版");
    const effectInput: CognitionEvidenceInput = {
      id: randomUUID(),
      personaId,
      actor: "agent",
      kind: "effect",
      source: { kind: "run", id: randomUUID(), fragment: randomUUID() },
      observedAt: f.now(),
      effect: {
        runId: randomUUID(),
        outcome: "performed",
        description: "文件读取工具返回1260",
        sourceRefs: [],
      },
    };
    const effect = f.repository.ingest(effectInput, f.now()).evidence;
    const background = f.source("没有采用的其他文章");
    const output = quiet([support.id, contradiction.id, effect.id]);
    output.delta.createSituations = [
      {
        localId: "new:ledger",
        value: {
          status: "current",
          title: "九月账本",
          summary: "需要核对月份",
          objectRefs: [],
          episodes: [],
          claims: [
            {
              id: "amount",
              text: "九月账本读回1260，1190的月份未确认",
              basis: "reported",
              state: "disputed",
              evidenceIds: [support.id],
              contradictingEvidenceIds: [contradiction.id],
            },
          ],
          unresolved: [],
          relatedSituationIds: [],
        },
      },
    ];
    output.delta.createIntents = [
      {
        localId: "new:check",
        value: {
          situationId: "new:ledger",
          owner: "user",
          basis: "explicit_user",
          status: "active",
          goal: "核对账本月份",
          successCriteria: [],
          evidenceIds: [support.id],
          effectEvidenceIds: [effect.id],
          blockers: [],
          resumeConditions: [],
          progress: "已读取金额，月份待确认",
        },
      },
    ];
    // This fixture owns the actual current attention, not every status=current row.
    output.delta.attention.currentSituationId = "new:ledger";
    output.decision.choices[0]!.situationId = "new:ledger";
    output.decision.choices[0]!.intentId = "new:check";
    output.decision.selectedBasis.currentClaimRefs = [
      { situationId: "new:ledger", claimId: "amount" },
    ];
    const done = f.commit(output);
    f.repository.saveAttempt({
      ...done,
      status: "awaiting_recall",
      recallPlan: {
        purpose: "initiative",
        query: "账本月份",
        questions: [],
        contextBudget: { maxTokens: 1000 },
      },
    });
    const analyze = vi.fn(() => Promise.resolve(quiet()));
    const h = f.service({ analyze });
    h.service.initialize();
    expect(f.repository.getAttempt(done.id)?.status).toBe("superseded");
    expect(analyze).not.toHaveBeenCalled();
    const read = f.repository.readSnapshot(personaId, f.now());
    const snapshot = read.snapshot;
    expect(snapshot.evidence.map(({ id }) => id)).toEqual([
      support.id,
      contradiction.id,
      effect.id,
    ]);
    expect(snapshot.evidence.map(({ id }) => id)).not.toContain(background.id);
    expect(projectCognitionContext(snapshot, 8192, read).text).toContain(
      "核对账本月份",
    );
    expect(
      f.repository.readActionContext(done, 8192, (value) => value).text,
    ).toContain(effect.effect!.description);
    expect(f.repository.getAttempt(done.id)?.dependencies).toEqual(
      done.dependencies,
    );
  });

  it("preserves the actual first-stage inputs through live recall despite a new journal page, without relying on exposure replay", async () => {
    const f = fixture();
    const old = Array.from({ length: 3 }, (_, index) =>
      f.source(`原始待分析来源${index}`),
    );
    const inputs: CognitionAnalysisInput[] = [];
    const driver: CognitionDriver = {
      analyze: (input) => {
        inputs.push(input);
        const output = quiet();
        if (!input.evidencePack)
          output.recallPlan = {
            purpose: "initiative",
            query: "上次账本",
            questions: [],
            contextBudget: { maxTokens: 1000 },
          };
        return Promise.resolve(output);
      },
    };
    const h = f.service(driver, () => {
      for (let index = 0; index < 70; index++)
        f.source(`后台新页${index}：${"另一份文档内容".repeat(80)}`);
      return Promise.resolve(emptyPack);
    });
    h.service.initialize();
    await h.service.runDue("2026-09-16T08:00:00.000Z");
    expect(h.errors).toEqual([]);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.snapshot.evidence.map(({ id }) => id)).toEqual(
      old.map(({ id }) => id),
    );
    for (const source of old)
      expect(
        inputs[1]!.snapshot.evidence.find(({ id }) => id === source.id)?.text,
      ).toBe(source.text);
    expect(inputs[1]!.attempt.dependencies.evidenceIds).toEqual(
      old.map(({ id }) => id),
    );
    expect(inputs[1]!.attempt.throughSequence).toBe(
      old.at(-1)!.receiptSequence,
    );
    expect(
      f.repository.getAttention(personaId, f.now()).analyzedThroughSequence,
    ).toBe(old.at(-1)!.receiptSequence);
    expect(f.repository.hasUnanalyzedMeaning(personaId)).toBe(true);
  });

  it("retains actual Run feedback on an unfinished dispatched attempt after the feedback journal was analyzed", () => {
    const f = fixture();
    const selected = f.source("本次选择的真实依据");
    const old = f.commit(quiet([selected.id]));
    const runId = randomUUID();
    f.repository.saveAttempt({ ...old, status: "ready" });
    const dispatched = f.database.transaction(() =>
      f.repository.bindDispatched(old.dispatchKey, runId, f.now()),
    )();
    const h = f.service({ analyze: () => Promise.resolve(quiet()) });
    const feedback: CognitionEvidenceInput = {
      id: randomUUID(),
      personaId,
      actor: "agent",
      kind: "observation",
      source: { kind: "run", id: runId, revision: "surface:offered" },
      observedAt: f.now(),
      text: "实际表面已接受这个结果",
    };
    h.service.observeFeedback(feedback);
    const next = f.commit(quiet());
    const persisted = f.repository.getAttempt(dispatched.id)!;
    expect(persisted.feedbackEvidenceIds).toEqual([feedback.id]);
    expect(next.dependencies.evidenceIds).toContain(feedback.id);
    const read = f.repository.readSnapshot(personaId, f.now());
    expect(read.snapshot.evidence.map(({ id }) => id)).toContain(feedback.id);
    expect(
      read.snapshot.evidence.find(({ id }) => id === feedback.id)?.text,
    ).toBe(feedback.text);
  });
  it("keeps the latest cancellation for an unfinished attempt's selected cue after a quiet page consumes it", () => {
    const f = fixture();
    const at = f.now();
    const chatId = randomUUID();
    const due: CognitionEvidenceInput = {
      id: randomUUID(),
      personaId,
      actor: "system",
      kind: "observation",
      observedAt: at,
      source: {
        kind: "memory",
        id: randomUUID(),
        revision: randomUUID(),
        fragment: "due",
      },
      chatId,
      text: "八点半演示进入考虑窗口",
      opportunity: {
        id: randomUUID(),
        targetChatId: chatId,
        evaluateAt: at,
        occursAt: "2026-09-15T09:00:00.000Z",
        status: "due",
      },
    };
    f.repository.ingest(due, f.now());
    const old = f.commit(quiet([due.id]));
    f.repository.saveAttempt({ ...old, status: "ready" });
    const dispatched = f.database.transaction(() =>
      f.repository.bindDispatched(old.dispatchKey, randomUUID(), f.now()),
    )();
    const cancelled: CognitionEvidenceInput = {
      ...due,
      id: randomUUID(),
      observedAt: f.now(),
      source: { ...due.source, fragment: "cancelled" },
      opportunity: { ...due.opportunity!, status: "cancelled" },
      text: "实际已取消演示",
    };
    f.repository.ingest(cancelled, f.now());
    f.commit(quiet());
    const read = f.repository.readSnapshot(personaId, f.now());
    expect(read.snapshot.evidence.map(({ id }) => id)).toContain(cancelled.id);
    expect(f.repository.actionFreshness(dispatched, f.now()).current).toBe(
      false,
    );
    const view = read.snapshot.recentAttempts.find(
      ({ id }) => id === dispatched.id,
    );
    expect(view?.projection).toBe("complete");
    if (view?.projection !== "complete")
      throw new Error("Expected the complete dispatched Attempt view");
    expect(view.feedbackEvidenceIds).toEqual([]);
  });
});
