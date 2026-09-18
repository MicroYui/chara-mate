import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  EvidencePack,
  MemoryEvidenceReference,
  MemoryEvidenceReferenceRequest,
  MemoryEvidenceResolution,
  MemoryRecall,
} from "../../shared/contracts/memoryRecall";
import type {
  CognitionDecisionAttempt,
  CognitionPreparedContext,
} from "./cognitionTypes";
import { attachSelectedRecollections } from "./cognitionActionContext";
import {
  createCognitionContextInput,
  materializeCognitionContextInput,
} from "../agent/cognitionContext";
import { estimateInputBudget } from "../providers/inputBudget";

const now = "2026-09-15T08:00:00.000Z";
function fixture() {
  const personaId = randomUUID();
  const item: EvidencePack["items"][number] = {
    memoryId: randomUUID(),
    revisionId: randomUUID(),
    type: "preference",
    content: "用户最近愿意尝试少量香菜",
    historyStatus: "current",
    current: true,
    recordedAt: now,
    basis: "explicit_user_statement",
    owner: "user",
    entityIds: [],
    sourceRefs: [
      {
        sourceId: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
      },
    ],
    questionIds: [],
  };
  const omitted = randomUUID();
  const attempt: CognitionDecisionAttempt = {
    id: randomUUID(),
    personaId,
    status: "ready",
    trigger: "semantic_change",
    throughSequence: 1,
    dispatchKey: randomUUID(),
    dependencies: {
      personaId,
      userGeneration: 0,
      receivedThroughSequence: 1,
      focusRevision: 0,
      situations: [],
      intents: [],
      evidenceIds: [],
    },
    feedbackEvidenceIds: [],
    createdAt: now,
    updatedAt: now,
    recallPlan: {
      purpose: "initiative",
      query: "饮食偏好",
      questions: [{ id: "food", text: "现在可以放什么配菜" }],
      contextBudget: { maxTokens: 4096 },
    },
    recallSummary: {
      coverage: [
        {
          questionId: "food",
          status: "supported",
          revisionIds: [item.revisionId, omitted],
        },
      ],
      gaps: [],
      truncated: false,
      incompleteReasons: [],
    },
  };
  const context: CognitionPreparedContext = {
    text: "只包含这次选中的话语",
    situationIds: [],
    intentIds: [],
    evidenceIds: [],
    decisionAttemptId: attempt.id,
    recallPlan: attempt.recallPlan!,
  };
  const reference: MemoryEvidenceReference = {
    memoryId: item.memoryId,
    revisionId: item.revisionId,
    use: "current",
  };
  let resolution: MemoryEvidenceResolution = {
    items: [item],
    status: "resolved",
    readCost: { rawValueBytes: 100, rowCount: 1 },
  };
  const memory = {
    recall: vi.fn(),
    validateEvidenceReferences: vi.fn(() => []),
    resolveEvidence: vi.fn(() => resolution),
  } satisfies MemoryRecall;
  return {
    item,
    omitted,
    attempt,
    context,
    reference,
    memory,
    request(
      references: MemoryEvidenceReference[],
    ): MemoryEvidenceReferenceRequest {
      return {
        personaId,
        references,
        retrieval: attempt.recallPlan!,
        expectedHistory: references.map(({ memoryId, revisionId }) => ({
          memoryId,
          revisionId,
          historyStatus: item.historyStatus,
        })),
      };
    },
    setResolution(value: MemoryEvidenceResolution) {
      resolution = value;
    },
  };
}

describe("selected recollection material", () => {
  it("preserves exact typed Memory sources and downgrades only the original coverage whose support was excluded", () => {
    const h = fixture();
    const result = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([h.reference]),
      10_000,
    );
    expect(h.memory.recall).not.toHaveBeenCalled();
    expect(h.memory.resolveEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: h.attempt.personaId,
        references: [h.reference],
      }),
    );
    expect(result.evidencePack?.items[0]).toMatchObject({
      ...h.item,
      questionIds: ["food"],
    });
    expect(result.evidencePack?.coverage).toEqual([
      {
        questionId: "food",
        status: "partial",
        revisionIds: [h.item.revisionId],
      },
    ]);
    expect(result.evidencePack?.gaps).toHaveLength(1);
    expect(result.text).not.toContain(h.item.content);
    const actual = createCognitionContextInput(result) as { content: string };
    expect(actual.content.split(h.item.content)).toHaveLength(2);
    expect(actual.content).not.toContain(h.omitted);
  });

  it("distinguishes historical use from actual current status and keeps the stronger mixed-use qualification", () => {
    const h = fixture();
    const historical: MemoryEvidenceReference = {
      ...h.reference,
      use: "history",
    };
    const result = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([historical]),
      10_000,
    );
    expect(result.evidencePack?.items[0]?.current).toBe(true);
    expect(result.historicalMemoryRevisionIds).toEqual([h.item.revisionId]);
    expect(JSON.stringify(createCognitionContextInput(result))).toContain(
      "historical reference only",
    );
    const mixed = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([historical, h.reference]),
      10_000,
    );
    expect(mixed.historicalMemoryRevisionIds).toBeUndefined();
  });

  it.each([
    "unavailable",
    "budget",
    "missing",
    "wrong_pair",
    "not_current",
    "unselected",
  ] as const)(
    "stops the same instruction when required memory is %s",
    (failure) => {
      const h = fixture();
      let result: MemoryEvidenceResolution = {
        items: [h.item],
        status: "resolved",
        readCost: { rawValueBytes: 100, rowCount: 1 },
      };
      if (failure === "unavailable")
        result = { status: "unavailable", unavailable: [h.reference] };
      if (failure === "budget")
        result = {
          status: "resource_limit",
          readCost: { rawValueBytes: 20_000, rowCount: 1 },
        };
      if (failure === "missing" && result.status === "resolved")
        result = { ...result, items: [] };
      if (failure === "wrong_pair" && result.status === "resolved")
        result = { ...result, items: [{ ...h.item, memoryId: randomUUID() }] };
      if (failure === "not_current" && result.status === "resolved")
        result = { ...result, items: [{ ...h.item, current: false }] };
      if (failure === "unselected" && result.status === "resolved")
        result.items.push({
          ...h.item,
          memoryId: randomUUID(),
          revisionId: randomUUID(),
        });
      h.setResolution(result);
      expect(() =>
        attachSelectedRecollections(
          h.context,
          h.attempt,
          h.memory,
          h.request([h.reference]),
          10_000,
        ),
      ).toThrow(/memory|Memory/);
      expect(h.memory.recall).not.toHaveBeenCalled();
    },
  );

  it("keeps the complete resolved Memory and leaves final wire judgment to the Runtime", () => {
    const h = fixture();
    const content = "Complete qualified statement ".repeat(800);
    h.setResolution({
      status: "resolved",
      items: [{ ...h.item, content }],
      readCost: { rawValueBytes: 30_000, rowCount: 2 },
    });
    const result = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([h.reference]),
      30_000,
    );
    expect(result.evidencePack?.items[0]?.content).toBe(content);
    expect(result.evidencePack?.estimatedTokens).toBeGreaterThan(0);
    expect(h.memory.resolveEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceBudget: { maxReadBytes: 30_000 },
      }),
    );
    expect(
      JSON.stringify(
        materializeCognitionContextInput(createCognitionContextInput(result)),
      ),
    ).toContain(content);
  });

  it("forwards the remaining read allowance unchanged, without mixing in context tokens", () => {
    const h = fixture();
    const result = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([h.reference]),
      8192,
    );
    expect(h.memory.resolveEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceBudget: { maxReadBytes: 8192 },
      }),
    );
    expect(result.evidencePack?.estimatedTokens).toBe(
      estimateInputBudget(result.evidencePack!.items).estimatedTokens,
    );
    expect(() =>
      attachSelectedRecollections(
        h.context,
        h.attempt,
        h.memory,
        h.request([h.reference]),
        0,
      ),
    ).toThrow("no remaining read allocation");
  });

  it("cannot retain a supported label with no actual loaded supporting revision", () => {
    const h = fixture();
    h.attempt.recallSummary!.coverage[0]!.revisionIds = [];
    const result = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([]),
      10_000,
    );
    expect(result.evidencePack?.coverage[0]?.status).toBe("missing");
    expect(result.evidencePack?.gaps).toHaveLength(1);
  });

  it("keeps unresolved original questions when no recollection was selected and never invokes replacement retrieval", () => {
    const h = fixture();
    const result = attachSelectedRecollections(
      h.context,
      h.attempt,
      h.memory,
      h.request([]),
      10_000,
    );
    expect(result.evidencePack?.items).toEqual([]);
    expect(result.evidencePack?.coverage[0]?.status).toBe("missing");
    expect(result.recallPlan).toEqual(h.attempt.recallPlan);
    expect(result.decisionAttemptId).toBe(h.attempt.id);
    expect(h.memory.resolveEvidence).not.toHaveBeenCalled();
  });
});
