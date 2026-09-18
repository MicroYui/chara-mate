import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import {
  projectCognitionContext,
  resolveCognitionAnalysis,
} from "./cognitionProjection";
import {
  readEvidence,
  readEvidenceMetadata,
  readIntentView,
} from "./cognitionSnapshotReader";
import { decodeCognitionModelOutput } from "./cognitionModelOutput";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionDecisionAttempt,
  CognitionEvidence,
  CognitionEvidenceInput,
  CognitionIntent,
  CognitionSnapshot,
} from "./cognitionTypes";

const personaId = "11111111-1111-4111-8111-111111111111";
const otherPersonaId = "22222222-2222-4222-8222-222222222222";
const now = "2026-09-16T00:00:00.000Z";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
type Update = CognitionAnalysis["delta"]["updateIntents"][number];
type Allocation = NonNullable<CognitionDecisionAttempt["allocation"]>;
function valueOf(intent: CognitionIntent): Update["value"] {
  const value = { ...intent } as Record<string, unknown>;
  for (const key of ["id", "personaId", "revision", "createdAt", "updatedAt"])
    delete value[key];
  return value as Update["value"];
}
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
          rationale: "只记录结果",
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
      reason: "保留来源范围",
    },
  };
}
function fixture(textGoal = false) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(CURRENT_SCHEMA_SQL);
  for (const id of [personaId, otherPersonaId])
    db.prepare(
      "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES(?,'custom',1,?,?)",
    ).run(id, now, now);
  const repo = new CognitionRepository(db, { readBudgetBytes: 32_768 });
  const ingest = (input: Partial<CognitionEvidenceInput> = {}) =>
    repo.ingest(
      {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "utterance",
        source: { kind: "run", id: randomUUID(), revision: "completed" },
        observedAt: now,
        text: "请把清单保存到本地，尚未保存。",
        ...input,
      },
      now,
    ).evidence;
  const request = ingest(
    textGoal
      ? {
          text: "请把这句对白改为一行：阿禾对阿澄说，我会修好旧录音。不要真的处理录音。",
        }
      : {},
  );
  const effect = (
    outcome:
      "unknown" | "partial" | "not_performed" | "performed" = "performed",
    extra: Partial<CognitionEvidenceInput> = {},
  ) =>
    ingest({
      actor: "agent",
      kind: "effect",
      text: "保存成功。",
      effect: {
        runId: randomUUID(),
        outcome,
        description: "本地文件保存并读回",
        sourceRefs: [],
      },
      ...extra,
    });
  const intent: CognitionIntent = {
    id: randomUUID(),
    personaId,
    revision: 1,
    owner: "user",
    basis: "explicit_user",
    status: "active",
    goal: textGoal ? "重排为一行角色台词，不处理录音" : "本地保存清单",
    successCriteria: textGoal
      ? ["标明阿禾对阿澄", "保留修好旧录音的原台词"]
      : ["文件存在并读回"],
    evidenceIds: [request.id],
    effectEvidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "等待保存",
    createdAt: now,
    updatedAt: now,
  };
  repo.saveIntent(intent);
  const prepare = (
    supplied: CognitionEvidence[] = [request],
    allocation?: Allocation,
  ) => {
    const canonical = repo.getIntent(intent.id)!;
    const view = structuredClone(canonical);
    const alloc = allocation?.intents?.[0];
    if (alloc) {
      view.evidenceIds = alloc.evidenceIds;
      view.effectEvidenceIds = alloc.effectEvidenceIds;
      if (alloc.preservedFields.includes("completion")) delete view.completion;
      if (alloc.preservedFields.includes("goal"))
        view.goal = "[PARTIAL INTENT: canonical fields preserved]";
      if (alloc.preservedFields.includes("successCriteria"))
        view.successCriteria = [];
    }
    const snapshot: CognitionSnapshot = {
      attention: repo.getAttention(personaId, now),
      situations: [],
      intents: [view],
      evidence: supplied,
      recentAttempts: [],
    };
    const attempt = repo.saveAttempt({
      ...repo.createAttempt(
        {
          snapshot,
          receivedThroughSequence: snapshot.attention.lastReceiptSequence,
        },
        "semantic_change",
        now,
        allocation,
      ),
      status: "analyzing",
    });
    const output = quiet();
    output.delta.updateIntents = [
      {
        id: view.id,
        expectedRevision: view.revision,
        value: valueOf(view),
        completionOperation: "keep",
      },
    ];
    return {
      snapshot,
      attempt,
      output,
      update: output.delta.updateIntents[0]!,
      commit: () => repo.commitAnalysis(attempt.id, output, now, supplied),
    };
  };
  const partial = (
    fields: NonNullable<Allocation["intents"]>[number]["preservedFields"],
  ): Allocation => ({
    situations: [],
    intents: [
      {
        id: intent.id,
        evidenceIds: [],
        effectEvidenceIds: [],
        preservedFields: fields,
      },
    ],
  });
  return { db, repo, request, effect, ingest, intent, prepare, partial };
}
function complete(
  update: Update,
  evidenceId: string,
  basis:
    "performed_effect" | "user_report" | "completed_reply" = "performed_effect",
) {
  update.value.status = "fulfilled";
  update.completionOperation = "set";
  update.value.completion = { evidenceUses: [{ evidenceId, basis }] };
}
function markCanonical(
  f: ReturnType<typeof fixture>,
  source: CognitionEvidence,
  basis:
    "performed_effect" | "user_report" | "completed_reply" = "performed_effect",
) {
  const run = f.prepare([f.request, source]);
  complete(run.update, source.id, basis);
  const done = run.commit();
  f.repo.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
  return f.repo.getIntent(f.intent.id)!;
}
function rows(f: ReturnType<typeof fixture>) {
  return Object.fromEntries(
    [
      "cognition_intents",
      "cognition_state",
      "cognition_decision_attempts",
      "cognition_memory_handoffs",
    ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]),
  );
}

describe("independent Intent completion evidence", () => {
  it("rejects general user requests plus success prose with unknown outcome and rolls back atomically", () => {
    const f = fixture(),
      receipt = f.effect("unknown"),
      run = f.prepare([f.request, receipt]);
    run.update.value.status = "fulfilled";
    run.update.value.effectEvidenceIds = [receipt.id];
    const before = rows(f);
    expect(run.commit).toThrow("explicit completion set");
    expect(rows(f)).toEqual(before);
    expect(f.repo.getAttention(personaId, now).analyzedThroughSequence).toBe(0);
    expect(f.repo.getIntent(f.intent.id)?.status).toBe("active");
  });
  it.each(["unknown", "partial", "not_performed"] as const)(
    "rejects explicitly misclassified %s effects despite success prose",
    (outcome) => {
      const f = fixture(),
        receipt = f.effect(outcome),
        run = f.prepare([f.request, receipt]);
      complete(run.update, receipt.id);
      expect(run.commit).toThrow("Invalid completion use");
      expect(f.repo.getIntent(f.intent.id)?.revision).toBe(1);
    },
  );
  it.each([
    { kind: "utterance" as const, actor: "agent" as const },
    { kind: "observation" as const, actor: "system" as const },
    { personaId: otherPersonaId },
  ])("rejects non-effect or other-Persona completion sources %j", (patch) => {
    const f = fixture(),
      receipt =
        "kind" in patch ? f.ingest(patch) : f.effect("performed", patch),
      run = f.prepare([f.request, receipt]);
    complete(run.update, receipt.id);
    expect(run.commit).toThrow("completion");
  });
  it("rejects absent and unsupplied completion IDs even when general canonical references know them", () => {
    const f = fixture(),
      receipt = f.effect();
    f.repo.saveIntent({ ...f.intent, effectEvidenceIds: [receipt.id] });
    const run = f.prepare([f.request]);
    complete(run.update, receipt.id);
    expect(run.commit).toThrow("was not supplied");
    run.update.value.completion!.evidenceUses[0]!.evidenceId = randomUUID();
    expect(run.commit).toThrow("was not supplied");
  });
  it("does not reinterpret a supplied assistant utterance as a user report", () => {
    const f = fixture(),
      source = f.ingest({ actor: "agent", text: "我已做好了。" }),
      run = f.prepare([f.request, source]);
    complete(run.update, source.id, "user_report");
    expect(run.commit).toThrow("Invalid completion use");
  });
  it("does not convert a historical recollection into a new user completion report", () => {
    const f = fixture();
    const reading = f.prepare();
    const remembered = f.ingest({
      actor: "system",
      kind: "recollection",
      source: {
        kind: "memory",
        id: randomUUID(),
        revision: randomUUID(),
        fragment: reading.attempt.id,
      },
      text: "以前用户曾报告保存过清单",
      recollection: {
        historyStatus: "current",
        basis: "explicit_user_statement",
        type: "event",
        current: true,
        recordedAt: now,
      },
    });
    f.repo.saveAttempt({ ...reading.attempt, status: "superseded" });
    const run = f.prepare([f.request, remembered]);
    complete(run.update, remembered.id, "user_report");
    expect(run.commit).toThrow("Invalid completion use");
  });
  it("accepts performed completion independently of general request and effect arrays", () => {
    const f = fixture(),
      receipt = f.effect(),
      run = f.prepare([receipt], f.partial([]));
    complete(run.update, receipt.id);
    run.commit();
    expect(f.repo.getIntent(f.intent.id)).toMatchObject({
      status: "fulfilled",
      completion: {
        evidenceUses: [{ evidenceId: receipt.id, basis: "performed_effect" }],
      },
      evidenceIds: [f.request.id],
      effectEvidenceIds: [receipt.id],
    });
  });
  it("accepts a bounded receipt with complete typed outcome without claiming its omitted prose was seen", () => {
    const f = fixture(),
      receipt = f.effect("performed", {
        text: "本地保存清单并读回成功。" + "原始日志".repeat(10_000),
      });
    const loaded = readEvidence(f.db, receipt.id, 2000)!;
    expect(loaded.excerpted).toBe(true);
    expect(loaded.evidence.effect?.outcome).toBe("performed");
    const run = f.prepare([f.request, loaded.evidence]);
    complete(run.update, receipt.id);
    run.commit();
    expect(f.repo.getIntent(f.intent.id)?.status).toBe("fulfilled");
  });
  it("keeps user-report attribution in current ordinary and exact selected contexts", () => {
    const f = fixture(),
      report = f.ingest({ text: "我自己保存好了，也读回确认了。" });
    const run = f.prepare([f.request, report]);
    complete(run.update, report.id, "user_report");
    run.output.delta.attention.committedIntentId = f.intent.id;
    run.output.decision.choices[0]!.intentId = f.intent.id;
    run.output.decision.choices[0]!.evidenceIds = [report.id];
    run.output.decision.selectedBasis.evidenceUses = [
      { evidenceId: report.id, use: "history" },
    ];
    const done = run.commit();
    const read = f.repo.readSnapshot(personaId, now);
    expect(
      read.snapshot.intents.find(({ id }) => id === f.intent.id)?.completion
        ?.evidenceUses,
    ).toEqual([{ evidenceId: report.id, basis: "user_report" }]);
    expect(
      read.snapshot.evidence.find(({ id }) => id === report.id)?.text,
    ).toBe(report.text);
    const ordinary = projectCognitionContext(read.snapshot, 12_000, read);
    expect(ordinary.text).toContain('"basis":"user_report"');
    expect(ordinary.text).toContain("not independently verified");
    const selected = f.repo.readActionContext(done, 12_000, (value) => value);
    expect(selected.text).toContain(report.text);
    expect(selected.text).toContain('"basis":"user_report"');
    expect(selected.text).toContain("not independent verification");
  });
  it("preserves unseen canonical completion through a quiet partial keep without resupplying historical sources", () => {
    const f = fixture(),
      receipt = f.effect();
    const canonical = markCanonical(f, receipt);
    const run = f.prepare([], f.partial(["completion"]));
    run.update.value.progress = "保留已有结果";
    run.commit();
    expect(f.repo.getIntent(f.intent.id)?.completion).toEqual(
      canonical.completion,
    );
    expect(run.attempt.dependencies.evidenceIds).toEqual([]);
  });
  it.each(["goal", "successCriteria", "owner", "basis"] as const)(
    "does not bypass new completion when fulfilled %s changes",
    (field) => {
      const f = fixture(),
        receipt = f.effect();
      markCanonical(f, receipt);
      const run = f.prepare([f.request, receipt]);
      if (field === "goal") run.update.value.goal = "保存清单并发给对方";
      if (field === "successCriteria")
        run.update.value.successCriteria = ["对方已收到"];
      if (field === "owner" || field === "basis") {
        run.update.value.owner = "character";
        run.update.value.basis = "character";
      }
      expect(run.commit).toThrow("explicit completion set");
    },
  );
  it.each(["goal", "successCriteria"] as const)(
    "rejects new completion with hidden %s even if typed outcome is performed",
    (field) => {
      const f = fixture(),
        receipt = f.effect(),
        run = f.prepare([receipt], f.partial([field]));
      complete(run.update, receipt.id);
      expect(run.commit).toThrow("goal and success criteria must be visible");
    },
  );
  it("atomically replaces hidden completion without union and explicitly clears it on reactivation", () => {
    const f = fixture(),
      old = f.effect();
    markCanonical(f, old);
    const replacement = f.effect(),
      run = f.prepare([replacement], f.partial(["completion"]));
    complete(run.update, replacement.id);
    const done = run.commit();
    expect(f.repo.getIntent(f.intent.id)?.completion?.evidenceUses).toEqual([
      { evidenceId: replacement.id, basis: "performed_effect" },
    ]);
    f.repo.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
    const reset = f.prepare([], f.partial(["completion"]));
    reset.update.value.status = "suspended";
    expect(reset.commit).toThrow("explicit completion clear");
    reset.update.completionOperation = "clear";
    delete reset.update.value.completion;
    const resetDone = reset.commit();
    f.repo.saveAttempt({ ...resetDone, status: "settled", outcome: "quiet" });
    const stored = f.repo.getIntent(f.intent.id)!;
    expect(stored.completion).toBeUndefined();
    expect(stored.effectEvidenceIds).toEqual([old.id, replacement.id]);
    const retry = f.prepare([replacement], f.partial([]));
    retry.update.value.status = "fulfilled";
    expect(retry.commit).toThrow("explicit completion set");
  });
  it("rejects clear that retains fulfilled and set that retains a non-fulfilled status", () => {
    const f = fixture(),
      receipt = f.effect();
    markCanonical(f, receipt);
    const run = f.prepare([receipt], f.partial(["completion"]));
    run.update.completionOperation = "clear";
    expect(run.commit).toThrow("Clearing completion cannot preserve fulfilled");
    run.update.value.status = "active";
    complete(run.update, receipt.id);
    run.update.value.status = "active";
    expect(run.commit).toThrow(
      "non-fulfilled intent cannot retain current completion",
    );
  });
  it("does not invent completion for a retained pre-contract fulfilled record", () => {
    const f = fixture();
    f.repo.saveIntent({ ...f.intent, status: "fulfilled" });
    const run = f.prepare([f.request]);
    run.update.value.progress = "未重新证明的既存记录";
    run.commit();
    expect(f.repo.getIntent(f.intent.id)?.completion).toBeUndefined();
  });
  it("bounds a large completion as an atomic SQL field and marks preservation instead of loading the array", () => {
    const f = fixture();
    const uses = Array.from({ length: 5000 }, () => ({
      evidenceId: randomUUID(),
      basis: "performed_effect" as const,
    }));
    f.repo.saveIntent({
      ...f.intent,
      status: "fulfilled",
      completion: { evidenceUses: uses },
    });
    const view = readIntentView(f.db, f.intent.id, 2000, false)!;
    expect(view.value.completion).toBeUndefined();
    expect(view.allocation?.preservedFields).toContain("completion");
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(2000);
    expect(
      f.repo.getIntent(f.intent.id)?.completion?.evidenceUses,
    ).toHaveLength(5000);
  });
  it("retains only current completion as an additional original-source consumer, then releases after clear and abandonment", () => {
    const f = fixture(),
      receipt = f.effect();
    markCanonical(f, receipt);
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: f.intent.id,
    }));
    const candidate = [
      { candidateId: receipt.id, references: [receipt.source] },
    ];
    expect(f.repo.protectedCanonicalSources(candidate)).toEqual([
      { candidateId: receipt.id, reasons: ["intent"] },
    ]);
    const run = f.prepare([f.request, receipt]);
    run.update.value.status = "abandoned";
    run.update.completionOperation = "clear";
    delete run.update.value.completion;
    const done = run.commit();
    f.repo.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
    expect(f.repo.protectedCanonicalSources(candidate)).toEqual([]);
    expect(f.repo.getIntent(f.intent.id)?.effectEvidenceIds).toContain(
      receipt.id,
    );
  });
  it("releases an unselected past completion after focus changes but retains a real in-flight consumer", () => {
    const f = fixture(),
      receipt = f.effect();
    markCanonical(f, receipt);
    const candidates = [
      { candidateId: receipt.id, references: [receipt.source] },
    ];
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: f.intent.id,
    }));
    expect(f.repo.protectedCanonicalSources(candidates)).toEqual([
      { candidateId: receipt.id, reasons: ["intent"] },
    ]);
    const nextId = randomUUID();
    f.repo.saveIntent({ ...f.intent, id: nextId, goal: "另一项计划" });
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: nextId,
    }));
    expect(f.repo.protectedCanonicalSources(candidates)).toEqual([]);
    expect(
      f.repo.getIntent(f.intent.id)?.completion?.evidenceUses[0]?.evidenceId,
    ).toBe(receipt.id);
    const run = f.prepare([receipt]);
    expect(f.repo.protectedCanonicalSources(candidates)).toEqual([
      { candidateId: receipt.id, reasons: ["decision"] },
    ]);
    f.repo.saveAttempt({
      ...run.attempt,
      status: "superseded",
    });
    expect(f.repo.protectedCanonicalSources(candidates)).toEqual([]);
  });
  it("keeps revision conflicts atomic even with otherwise valid independent completion", () => {
    const f = fixture(),
      receipt = f.effect(),
      run = f.prepare([f.request, receipt]);
    complete(run.update, receipt.id);
    f.repo.saveIntent({ ...f.intent, revision: 2 });
    const before = rows(f);
    expect(run.commit).toThrow("Situation or intent changed");
    expect(rows(f)).toEqual(before);
  });
  it("does not read unrelated completed intents or their old sources into current ordinary context", () => {
    const f = fixture(),
      current = f.effect(),
      unused = f.ingest({ text: "另一项很久以前的完成报告" });
    markCanonical(f, current);
    f.repo.saveIntent({
      ...f.intent,
      id: randomUUID(),
      status: "fulfilled",
      completion: {
        evidenceUses: [{ evidenceId: unused.id, basis: "user_report" }],
      },
      evidenceIds: [unused.id],
    });
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: f.intent.id,
      analyzedThroughSequence: state.lastReceiptSequence,
    }));
    const read = f.repo.readSnapshot(personaId, now);
    expect(read.snapshot.intents.map(({ id }) => id)).toEqual([f.intent.id]);
    expect(read.snapshot.evidence.map(({ id }) => id)).not.toContain(unused.id);
    const context = projectCognitionContext(read.snapshot, 12_000, read);
    expect(context.text).toContain(current.id);
    expect(context.text).not.toContain(unused.text);
  });
  it("requires exact selected completion sources and rechecks their existence before action", () => {
    const f = fixture(),
      receipt = f.effect(),
      run = f.prepare([f.request, receipt]);
    complete(run.update, receipt.id);
    const choice = run.output.decision.choices[0]!;
    choice.kind = "respond";
    choice.intentId = f.intent.id;
    choice.executionScope = "conversation";
    choice.instruction = "按回执范围说明本地保存结果";
    expect(run.commit).toThrow("completion sources in selectedBasis");
    expect(f.repo.getIntent(f.intent.id)?.status).toBe("active");
    choice.evidenceIds = [receipt.id];
    run.output.decision.selectedBasis.evidenceUses = [
      { evidenceId: receipt.id, use: "history" },
    ];
    const done = run.commit();
    expect(
      f.repo.readActionContext(done, 12_000, (value) => value).text,
    ).toContain(receipt.text);
    expect(f.repo.actionFreshness(done, now).current).toBe(true);
    f.db.prepare("DELETE FROM cognition_evidence WHERE id = ?").run(receipt.id);
    expect(f.repo.actionFreshness(done, now)).toMatchObject({
      current: false,
      reason: "source_missing",
      referenceId: receipt.id,
    });
  });
  it("prevents a hidden current completion from silently accepting a changed completion under keep", () => {
    const f = fixture(),
      receipt = f.effect(),
      other = f.effect();
    markCanonical(f, receipt);
    const run = f.prepare([f.request, other]);
    run.update.value.completion = {
      evidenceUses: [{ evidenceId: other.id, basis: "performed_effect" }],
    };
    expect(run.commit).toThrow("explicit completion set");
  });
  it.each(
    (["keep", "clear", "set"] as const).flatMap((op) =>
      (["performed_effect", "completed_reply"] as const).map((basis) => ({
        op,
        basis,
      })),
    ),
  )(
    "preserves hidden completion $basis $op through the real wire decoder",
    ({ op, basis }) => {
      const f = fixture(basis === "completed_reply"),
        receipt =
          basis === "performed_effect"
            ? f.effect()
            : f.ingest({
                actor: "agent",
                chatId: randomUUID(),
                text: "阿禾（对阿澄）：我会修好旧录音。",
                source: {
                  kind: "run",
                  id: f.request.source.id,
                  fragment: randomUUID(),
                  revision: "completed",
                },
              });
      markCanonical(f, receipt, basis);
      const run = f.prepare([receipt], f.partial(["completion"]));
      const input: CognitionAnalysisInput = {
        attempt: run.attempt,
        snapshot: run.snapshot,
        availability: {
          userEngaged: false,
          activeUserRunIds: [],
          chatRuns: [],
          activeVoice: false,
          sleeping: false,
          hasOutstandingBubble: false,
          mayInitiateConversation: true,
          characterTools: [],
          mayActInTerritory: true,
        },
      };
      const changes = {
        owner: null,
        basis: null,
        status: op === "clear" ? "suspended" : null,
        goal: null,
        successCriteria: null,
        evidenceIds: null,
        effectEvidenceIds: null,
        blockers: null,
        resumeConditions: null,
        progress: null,
        situationId: { op: "keep" },
        journeyId: { op: "keep" },
        nextWakeAt: { op: "keep" },
        completion:
          op === "set"
            ? {
                op,
                value: {
                  evidenceUses: [{ evidenceId: receipt.id, basis }],
                },
              }
            : { op },
      };
      const model = {
        ...quiet(),
        delta: {
          ...quiet().delta,
          attention: {
            currentSituationId: { op: "keep" },
            committedIntentId: { op: "keep" },
          },
          updateIntents: [
            {
              id: f.intent.id,
              expectedRevision: run.update.expectedRevision,
              changes,
            },
          ],
        },
        recallPlan: null,
      };
      const decoded = decodeCognitionModelOutput(model, input);
      expect(decoded.delta.updateIntents[0]?.completionOperation).toBe(op);
      f.repo.commitAnalysis(
        run.attempt.id,
        decoded,
        now,
        run.snapshot.evidence,
      );
      expect(f.repo.getIntent(f.intent.id)?.completion === undefined).toBe(
        op === "clear",
      );
    },
  );
});

describe("completed replies as finite conversational completion", () => {
  function reply(
    f: ReturnType<typeof fixture>,
    patch: Partial<CognitionEvidenceInput> = {},
  ) {
    return f.ingest({
      actor: "agent",
      kind: "utterance",
      chatId: randomUUID(),
      source: {
        kind: "run",
        id: f.request.source.id,
        fragment: randomUUID(),
        revision: "completed",
      },
      text: "阿禾（对阿澄）：我会修好旧录音。",
      ...patch,
    });
  }
  it("commits the actual reply basis without reclassifying its quoted action as an effect", () => {
    const f = fixture(true),
      source = reply(f),
      run = f.prepare([f.request, source]);
    complete(run.update, source.id, "completed_reply");
    run.output.delta.attention.committedIntentId = f.intent.id;
    run.output.decision.choices[0] = {
      ...run.output.decision.choices[0]!,
      intentId: f.intent.id,
      kind: "respond",
      chatId: source.chatId!,
      instruction: "在这段已写出的台词基础上接话，不操作录音。",
      userImpact: "light",
      executionScope: "conversation",
      evidenceIds: [source.id],
    };
    run.output.decision.selectedBasis.evidenceUses = [
      { evidenceId: source.id, use: "history" },
    ];
    const done = run.commit();
    expect(f.repo.getIntent(f.intent.id)).toMatchObject({
      status: "fulfilled",
      effectEvidenceIds: [],
      completion: {
        evidenceUses: [{ evidenceId: source.id, basis: "completed_reply" }],
      },
    });
    expect(f.repo.actionFreshness(done, now).current).toBe(true);
    const read = f.repo.readSnapshot(personaId, now);
    expect(projectCognitionContext(read.snapshot, 12000, read).text).toContain(
      '"basis":"completed_reply"',
    );
    const context = f.repo.readActionContext(done, 12000, (value) => value);
    expect(context.text).toContain(source.text);
    expect(context.text).toContain("completed_reply");
    expect(context.text).toContain("surface delivery");
    f.db.prepare("DELETE FROM cognition_evidence WHERE id = ?").run(source.id);
    expect(f.repo.actionFreshness(done, now)).toMatchObject({
      current: false,
      reason: "source_missing",
    });
  });
  it.each(["metadata", "released", "empty_excerpt"] as const)(
    "rejects a new completion from actual %s supply even though its source metadata qualifies",
    (kind) => {
      const f = fixture(true),
        source = reply(f);
      if (kind === "released") {
        f.repo.updateAttention(personaId, now, (state) => ({
          ...state,
          analyzedThroughSequence: state.lastReceiptSequence,
        }));
        expect(f.repo.releaseEvidenceBody(source.id, now)).toBeDefined();
      }
      const visible =
        kind === "empty_excerpt"
          ? readEvidence(
              f.db,
              source.id,
              2000,
              Array.from(source.text!).length,
            )!.evidence
          : readEvidenceMetadata(f.db, source.id)!;
      if (kind !== "empty_excerpt") expect(visible.text).toBeUndefined();
      const run = f.prepare([f.request, visible]);
      complete(run.update, source.id, "completed_reply");
      const before = rows(f);
      expect(run.commit).toThrow("actual visible reply text");
      expect(rows(f)).toEqual(before);
    },
  );
  it("does not let a Repository caller substitute dependencies for an omitted actual supply argument", () => {
    const f = fixture(true),
      source = reply(f),
      run = f.prepare([f.request, source]);
    complete(run.update, source.id, "completed_reply");
    expect(() =>
      f.repo.commitAnalysis(run.attempt.id, run.output, now),
    ).toThrow("actual visible reply text");
    expect(f.repo.getIntent(f.intent.id)?.status).toBe("active");
  });
  it("uses real snapshot text for a direct resolver while rejecting metadata-only snapshots", () => {
    const f = fixture(true),
      source = reply(f),
      run = f.prepare([f.request, source]);
    complete(run.update, source.id, "completed_reply");
    expect(
      resolveCognitionAnalysis(run.snapshot, run.output, now).intents[0]
        ?.status,
    ).toBe("fulfilled");
    const metadata = {
      ...run.snapshot,
      evidence: [f.request, readEvidenceMetadata(f.db, source.id)!],
    };
    expect(() => resolveCognitionAnalysis(metadata, run.output, now)).toThrow(
      "actual visible reply text",
    );
  });
  it("accepts a real bounded excerpt containing the finite deliverable without asserting the omitted tail", () => {
    const f = fixture(true),
      source = reply(f, {
        text: "阿禾（对阿澄）：我会修好旧录音。\n" + "其它背景。".repeat(10000),
      });
    const loaded = readEvidence(f.db, source.id, 2000)!;
    expect(loaded.excerpted).toBe(true);
    expect(loaded.textRange!.endCharacter).toBeLessThan(
      loaded.textRange!.totalCharacters,
    );
    expect(loaded.evidence.text).toContain("阿禾（对阿澄）：我会修好旧录音。");
    expect(loaded.evidence.text).not.toBe(source.text);
    const run = f.prepare([f.request, loaded.evidence]);
    complete(run.update, source.id, "completed_reply");
    run.commit();
    expect(f.repo.getIntent(f.intent.id)?.status).toBe("fulfilled");
  });
  it.each<Partial<CognitionEvidenceInput>>([
    { actor: "user" as const },
    { kind: "observation" as const },
    {
      actor: "system" as const,
      kind: "recollection" as const,
      source: {
        kind: "memory" as const,
        id: randomUUID(),
        revision: randomUUID(),
        fragment: randomUUID(),
      },
      recollection: {
        historyStatus: "current" as const,
        basis: "explicit_user_statement" as const,
        type: "event" as const,
        current: true,
        recordedAt: now,
      },
    },
    {
      source: {
        kind: "activity" as const,
        id: randomUUID(),
        fragment: randomUUID(),
        revision: "completed",
      },
    },
    {
      source: { kind: "run" as const, id: randomUUID(), revision: "completed" },
    },
    {
      source: {
        kind: "run" as const,
        id: randomUUID(),
        fragment: randomUUID(),
        revision: "interrupted",
      },
    },
    {
      source: {
        kind: "run" as const,
        id: randomUUID(),
        fragment: "terminal",
        revision: "cancelled",
      },
    },
    { personaId: otherPersonaId },
  ])(
    "rejects a structurally ineligible reply without partial state writes: %j",
    (patch) => {
      const f = fixture(true);
      if (patch.kind === "recollection") {
        const reading = f.prepare();
        patch = {
          ...patch,
          source: { ...patch.source!, fragment: reading.attempt.id },
        };
        f.repo.saveAttempt({ ...reading.attempt, status: "superseded" });
      }
      const source = reply(f, patch),
        run = f.prepare([f.request, source]);
      complete(run.update, source.id, "completed_reply");
      const before = rows(f);
      expect(run.commit).toThrow(/completion|Completion/);
      expect(rows(f)).toEqual(before);
    },
  );
  it("rejects a completed-looking source without its actual Chat identity", () => {
    const f = fixture(true);
    const source = f.ingest({
      actor: "agent",
      text: "阿禾（对阿澄）：我会修好旧录音。",
      source: {
        kind: "run",
        id: f.request.source.id,
        fragment: randomUUID(),
        revision: "completed",
      },
    });
    const run = f.prepare([f.request, source]);
    complete(run.update, source.id, "completed_reply");
    expect(run.commit).toThrow("Invalid completion use");
  });
  it("does not promote an unsupplied canonical reply to a new completion", () => {
    const f = fixture(true),
      source = reply(f),
      run = f.prepare();
    complete(run.update, source.id, "completed_reply");
    expect(run.commit).toThrow("was not supplied");
  });
  it.each(["goal", "successCriteria"] as const)(
    "still requires the finite %s to be visible",
    (field) => {
      const f = fixture(true),
        source = reply(f),
        run = f.prepare([source], f.partial([field]));
      complete(run.update, source.id, "completed_reply");
      expect(run.commit).toThrow("goal and success criteria must be visible");
    },
  );
  it("keeps historical completion after its consumer and body retire, but cannot reuse it for a changed goal", () => {
    const f = fixture(true),
      source = reply(f);
    const original = markCanonical(f, source, "completed_reply");
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      analyzedThroughSequence: state.lastReceiptSequence,
    }));
    expect(f.repo.releaseEvidenceBody(source.id, now)).toBeDefined();
    const run = f.prepare([], f.partial(["completion"]));
    run.update.value.progress = "这行台词已写出；旧正文已不在当前供给。";
    const done = run.commit();
    f.repo.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
    expect(f.repo.getIntent(f.intent.id)?.completion).toEqual(
      original.completion,
    );
    const changed = f.prepare([f.request], f.partial(["completion"]));
    changed.update.value.goal = "重排台词并处理真实录音";
    expect(changed.commit).toThrow("explicit completion set");
  });
});
