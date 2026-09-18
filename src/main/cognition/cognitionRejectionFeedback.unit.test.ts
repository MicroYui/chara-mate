import { describe, expect, it } from "vitest";

import { resolveCognitionAnalysis } from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionEvidence,
  CognitionIntent,
  CognitionSnapshot,
} from "./cognitionTypes";

const now = "2026-09-16T00:00:00.000Z";
const personaId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const generatedId = "55555555-5555-4555-8555-555555555555";

function fixture(
  outcome: "performed" | "unknown" | "partial" | "not_performed",
) {
  const evidence: CognitionEvidence = {
    id: evidenceId,
    personaId,
    actor: "agent",
    kind: "effect",
    source: { kind: "run", id: runId },
    observedAt: now,
    receivedAt: now,
    receiptSequence: 1,
    text: "成功：操作已完成。",
    effect: {
      runId,
      outcome,
      description: "成功：操作已完成。",
      sourceRefs: [{ kind: "run", id: runId }],
    },
  };
  const intent: CognitionIntent = {
    id: intentId,
    personaId,
    revision: 1,
    owner: "character",
    basis: "character",
    status: "active",
    goal: "完成已经开始的操作",
    successCriteria: [],
    evidenceIds: [],
    effectEvidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "",
    createdAt: now,
    updatedAt: now,
  };
  const snapshot: CognitionSnapshot = {
    attention: {
      personaId,
      revision: 0,
      userGeneration: 0,
      focusRevision: 0,
      lastReceiptSequence: 1,
      analyzedThroughSequence: 0,
      updatedAt: now,
    },
    situations: [],
    intents: [intent],
    evidence: [evidence],
    recentAttempts: [],
  };
  const analysis: CognitionAnalysis = {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [
        {
          id: intentId,
          expectedRevision: 1,
          completionOperation: "set",
          value: {
            owner: intent.owner,
            basis: intent.basis,
            goal: intent.goal,
            successCriteria: intent.successCriteria,
            evidenceIds: intent.evidenceIds,
            blockers: intent.blockers,
            resumeConditions: intent.resumeConditions,
            progress: intent.progress,
            status: "fulfilled",
            completion: {
              evidenceUses: [{ evidenceId, basis: "performed_effect" }],
            },
            effectEvidenceIds: [evidenceId],
          },
        },
      ],
      attention: {},
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: [],
          rationale: "保留实际状态",
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
      reason: "完成状态核对",
    },
  };
  return { snapshot, analysis, evidence };
}

function rejectedMessage(
  snapshot: CognitionSnapshot,
  analysis: CognitionAnalysis,
): string {
  try {
    resolveCognitionAnalysis(snapshot, analysis, now, () => generatedId);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected the unsupported completion to be rejected");
}

describe("Intent completion rejection feedback", () => {
  it.each(["unknown", "partial", "not_performed"] as const)(
    "identifies the actual target and %s receipt even when its prose claims success",
    (outcome) => {
      const { snapshot, analysis } = fixture(outcome);
      const before = structuredClone({ snapshot, analysis });
      const message = rejectedMessage(snapshot, analysis);
      expect(message).toContain(
        "Intent completion requires a performed effect, user report or completed reply",
      );
      expect(message).toContain(`Intent "${intentId}": active -> fulfilled`);
      expect(message).toContain(
        JSON.stringify({ evidenceId, kind: "effect", outcome }),
      );
      expect(message).toContain("kind=effect does not mean outcome=performed");
      expect(message).toContain("unknown does not mean failure");
      expect({ snapshot, analysis }).toEqual(before);
    },
  );

  it("reports a missing typed outcome without inventing performed or failure", () => {
    const { snapshot, analysis, evidence } = fixture("unknown");
    delete evidence.effect;
    const message = rejectedMessage(snapshot, analysis);
    expect(message).toContain(
      JSON.stringify({ evidenceId, kind: "effect", outcome: null }),
    );
  });

  it("uses the original local reference instead of an uncommitted generated ID", () => {
    const { snapshot, analysis } = fixture("unknown");
    const value = analysis.delta.updateIntents[0]!.value;
    analysis.delta.updateIntents = [];
    analysis.delta.createIntents = [{ localId: "new:operation", value }];
    const message = rejectedMessage(snapshot, analysis);
    expect(message).toContain('Intent "new:operation": new -> fulfilled');
    expect(message).not.toContain(generatedId);
  });

  it("preserves acceptance of an actual performed receipt", () => {
    const { snapshot, analysis } = fixture("performed");
    const result = resolveCognitionAnalysis(snapshot, analysis, now);
    expect(result.intents[0]?.status).toBe("fulfilled");
  });

  it("preserves acceptance of an actual user completion report", () => {
    const { snapshot, analysis, evidence } = fixture("unknown");
    evidence.actor = "user";
    evidence.kind = "utterance";
    evidence.text = "我已经完成这次操作了。";
    delete evidence.effect;
    analysis.delta.updateIntents[0]!.value.effectEvidenceIds = [];
    analysis.delta.updateIntents[0]!.value.evidenceIds = [evidenceId];
    analysis.delta.updateIntents[0]!.value.completion = {
      evidenceUses: [{ evidenceId, basis: "user_report" }],
    };
    expect(
      resolveCognitionAnalysis(snapshot, analysis, now).intents[0]?.status,
    ).toBe("fulfilled");
  });
});
