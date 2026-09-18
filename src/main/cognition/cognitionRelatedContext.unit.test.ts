import { estimatedCognitionContextTokens } from "../agent/cognitionContext";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectCognitionContext } from "./cognitionProjection";
import type {
  CognitionDecisionAttempt,
  CognitionEvidence,
  CognitionSituation,
  CognitionSnapshot,
  CognitionIntent,
} from "./cognitionTypes";

const now = "2026-09-15T08:00:00.000Z";
const personaId = randomUUID();

function source(text: string, receiptSequence: number): CognitionEvidence {
  return {
    id: randomUUID(),
    personaId,
    actor: "user",
    kind: "utterance",
    source: { kind: "run", id: randomUUID() },
    observedAt: now,
    receivedAt: now,
    receiptSequence,
    text,
  };
}

function situation(
  title: string,
  evidence: CognitionEvidence,
  status: CognitionSituation["status"],
): CognitionSituation {
  return {
    id: randomUUID(),
    personaId,
    revision: 4,
    title,
    summary: title,
    status,
    objectRefs: [],
    episodes: [],
    claims: [
      {
        id: "known-detail",
        text: evidence.text!,
        basis: "reported",
        state: "supported",
        evidenceIds: [evidence.id],
        contradictingEvidenceIds: [],
      },
    ],
    unresolved: [],
    relatedSituationIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function selectedAttempt(evidenceId: string): CognitionDecisionAttempt {
  return {
    id: randomUUID(),
    personaId,
    status: "settled",
    trigger: "semantic_change",
    throughSequence: 3,
    dispatchKey: randomUUID(),
    dependencies: {
      personaId,
      userGeneration: 0,
      receivedThroughSequence: 3,
      focusRevision: 0,
      situations: [],
      intents: [],
      evidenceIds: [evidenceId],
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: [evidenceId],
          rationale: "继续安静陪伴",
          userImpact: "none",
          executionScope: "none",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
          instruction: "这条旧动作指令不能进入新用户回合",
        },
      ],
      selectedChoiceId: "quiet",
      selectedBasis: {
        choiceId: "quiet",
        evidenceUses: [{ evidenceId, use: "history" }],
        currentClaimRefs: [],
      },
      reason: "沿用已知限定",
    },
    feedbackEvidenceIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function fixture() {
  const currentSource = source("现在只查看照片，不修改已完成的相册。", 2);
  const priorSource = source("相册已经做好了，先留在本地。", 1);
  const current = situation("查看照片", currentSource, "current");
  const related = situation("已完成的相册", priorSource, "closed");
  current.relatedSituationIds = [related.id];
  related.relatedSituationIds = [current.id];
  const snapshot: CognitionSnapshot = {
    attention: {
      personaId,
      revision: 1,
      userGeneration: 0,
      focusRevision: 0,
      lastReceiptSequence: 2,
      analyzedThroughSequence: 2,
      currentSituationId: current.id,
      updatedAt: now,
    },
    situations: [related, current],
    intents: [],
    evidence: [priorSource, currentSource],
    recentAttempts: [],
  };
  return { current, related, currentSource, priorSource, snapshot };
}

describe("ordinary turn context and related experience", () => {
  it("leaves unrelated active and suspended tasks out even when the consumer has ample space", () => {
    const h = fixture();
    const otherSource = source("另一个项目有独立的未完成计划", 3);
    const otherSituation = situation(
      "未被本次注意选择的项目",
      otherSource,
      "current",
    );
    const intent = (
      situationId: string,
      status: "active" | "suspended",
      goal: string,
    ): CognitionIntent => ({
      id: randomUUID(),
      personaId,
      revision: 1,
      owner: "user",
      basis: "explicit_user",
      status,
      goal,
      situationId,
      successCriteria: [],
      evidenceIds: [otherSource.id],
      blockers: [],
      resumeConditions: [],
      progress: "尚待继续",
      effectEvidenceIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const anchored = intent(h.current.id, "active", "当前照片的实际目标");
    anchored.evidenceIds = [h.currentSource.id];
    const unrelated = intent(otherSituation.id, "active", "尚未相关的项目目标");
    const suspended = intent(otherSituation.id, "suspended", "未来的另一件事");
    h.snapshot.situations.push(otherSituation);
    h.snapshot.intents.push(unrelated, suspended, anchored);
    h.snapshot.evidence.push(otherSource);
    const before = structuredClone(h.snapshot);
    const context = projectCognitionContext(h.snapshot, 200_000);
    expect(context.intentIds).toEqual([anchored.id]);
    expect(context.situationIds).toEqual([h.current.id, h.related.id]);
    expect(context.text).not.toContain(otherSituation.title);
    expect(context.text).not.toContain(otherSource.text);
    expect(h.snapshot).toEqual(before);
    // An actual commitment changes relevance without deleting any other task.
    h.snapshot.attention.committedIntentId = suspended.id;
    expect(projectCognitionContext(h.snapshot, 200_000).intentIds).toEqual([
      suspended.id,
      anchored.id,
    ]);
  });

  it("keeps a completed related experience and its source without reopening it or traversing further history", () => {
    const h = fixture();
    const distantSource = source("与本次查看无关的旧日旅行细节", 3);
    const distant = situation("更远的经历", distantSource, "closed");
    h.related.relatedSituationIds.push(distant.id);
    const unrelatedSource = source("另一条独立的收纳计划", 4);
    const unrelated = situation("独立计划", unrelatedSource, "closed");
    h.snapshot.situations.push(distant, unrelated);
    h.snapshot.evidence.push(distantSource, unrelatedSource);
    const before = structuredClone(h.snapshot);

    const context = projectCognitionContext(h.snapshot, 8192);

    expect(context.situationIds).toEqual([h.current.id, h.related.id]);
    expect(context.evidenceIds).toEqual([h.currentSource.id, h.priorSource.id]);
    expect(context.text).toContain(h.priorSource.text);
    expect(context.text).toContain('"status":"closed"');
    expect(context.text).toContain('"revision":4');
    expect(context.text).not.toContain(distant.title);
    expect(context.text).not.toContain(unrelated.title);
    expect(h.snapshot).toEqual(before);
  });

  it("reserves current sources before a large related body and reports its omission within the original allocation", () => {
    const h = fixture();
    h.related.summary = "旧材料".repeat(5000);
    const context = projectCognitionContext(h.snapshot, 8192);
    expect(context.situationIds).toEqual([h.current.id]);
    expect(context.evidenceIds).toEqual([h.currentSource.id]);
    expect(context.text).toContain(h.currentSource.text);
    expect(context.text).toContain('"omittedForBudget":true');
    expect(Buffer.byteLength(context.text, "utf8")).toBeLessThan(8192);
  });

  it("prioritizes actually selected related support over older support without carrying the old action instruction", () => {
    const h = fixture();
    const latest = source(
      "相册的新增限定：" + "这些新说明都属于同一个实际来源。".repeat(12),
      3,
    );
    h.related.claims.push({
      ...h.related.claims[0]!,
      id: "latest-detail",
      text: "最新的相册限定",
      evidenceIds: [latest.id],
    });
    h.snapshot.recentAttempts = [
      { ...selectedAttempt(latest.id), projection: "complete" },
    ];
    // Measure enough allocation for current context and the actual selected
    // source. Reintroducing older support must not displace either of them.
    h.snapshot.evidence = [h.currentSource, latest];
    const minimal = projectCognitionContext(h.snapshot, 8192);
    const budget = estimatedCognitionContextTokens(minimal) + 4;
    h.snapshot.evidence = [h.priorSource, h.currentSource, latest];
    const context = projectCognitionContext(h.snapshot, budget);
    expect(context.evidenceIds).toContain(h.currentSource.id);
    expect(context.evidenceIds).toContain(latest.id);
    expect(context.evidenceIds).not.toContain(h.priorSource.id);
    expect(context.text).toContain('"omittedForBudget":true');
    expect(context.text).not.toContain("这条旧动作指令");
    expect(Buffer.byteLength(context.text, "utf8")).toBeLessThan(budget);
  });

  it("reports a missing direct parent or its support without guessing their contents", () => {
    const h = fixture();
    h.current.relatedSituationIds.push(randomUUID());
    h.snapshot.evidence = [h.currentSource];
    const context = projectCognitionContext(h.snapshot, 8192);
    expect(context.situationIds).toEqual([h.current.id, h.related.id]);
    expect(context.evidenceIds).toEqual([h.currentSource.id]);
    expect(context.text).toContain('"missing":true');
    expect(context.text).toContain('"omittedForBudget":false');
  });

  it("carries a current claim's opposing original statement instead of only its opaque reference", () => {
    const h = fixture();
    h.current.relatedSituationIds = [];
    h.currentSource.text = "我们这周末或许能见面。";
    const correction = source("刚确认过，这周末不能见面；其他周末还没定。", 3);
    h.current.claims[0] = {
      id: "weekend-plan",
      text: "本周末见面仍未确定。",
      basis: "reported",
      state: "disputed",
      evidenceIds: [h.currentSource.id],
      contradictingEvidenceIds: [correction.id],
    };
    h.snapshot.evidence.push(correction);
    const before = structuredClone(h.snapshot);

    const context = projectCognitionContext(h.snapshot, 8192);

    expect(context.evidenceIds).toContain(correction.id);
    expect(context.text).toContain(correction.text);
    expect(context.text).toContain(h.currentSource.text);
    expect(context.text).toContain('"state":"disputed"');
    expect(h.snapshot).toEqual(before);
  });

  it("does not bring closed history into a turn without a current root or active commitment", () => {
    const h = fixture();
    h.current.status = "closed";
    delete h.snapshot.attention.currentSituationId;
    h.snapshot.recentAttempts = [
      { ...selectedAttempt(h.priorSource.id), projection: "complete" },
    ];
    const context = projectCognitionContext(h.snapshot, 8192);
    expect(context.situationIds).toEqual([]);
    expect(context.evidenceIds).toEqual([]);
    expect(context.text).not.toContain(h.priorSource.text);
    expect(context.text).not.toContain("这条旧动作指令");
  });
});
