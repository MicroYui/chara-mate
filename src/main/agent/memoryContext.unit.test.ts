import { describe, expect, it } from "vitest";
import { suppliedMemoryReferences } from "./memorySuppliedReferences";

import type { EvidencePack } from "../../shared/contracts/memoryRecall";
import {
  createMemoryContextInput,
  materializeMemoryContextInput,
  memoryContextRevisionReferences,
} from "./memoryContext";
import {
  createCognitionContextInput,
  materializeCognitionContextInput,
} from "./cognitionContext";

const pack: EvidencePack = {
  items: [
    {
      memoryId: "10000000-0000-4000-8000-000000000001",
      revisionId: "20000000-0000-4000-8000-000000000001",
      type: "preference",
      content: "阿澄喜欢摄影；不是用户本人的爱好。",
      basis: "explicit_user_statement",
      entityIds: [],
      sourceRefs: [
        {
          sourceId: "30000000-0000-4000-8000-000000000001",
          referenceId: "40000000-0000-4000-8000-000000000001",
          type: "chat",
        },
      ],
      recordedAt: "2026-09-15T00:00:00.000Z",
      current: false,
      historyStatus: "retained_history",
      questionIds: ["q1"],
    },
  ],
  coverage: [
    {
      questionId: "q1",
      status: "partial",
      revisionIds: ["20000000-0000-4000-8000-000000000001"],
    },
  ],
  gaps: [{ questionId: "q1", reason: "当前用户偏好尚未确认" }],
  estimatedTokens: 180,
  truncated: false,
  incompleteReasons: [],
};

describe("selected companion evidence context", () => {
  it.each(["user", "character"] as const)(
    "does not turn %s visibility scope into the subject of a third-person fact",
    (owner) => {
      const scoped = {
        ...pack,
        items: pack.items.map((item) => ({ ...item, owner })),
      };
      const visible = JSON.stringify(
        materializeMemoryContextInput(createMemoryContextInput(scoped)),
      );
      expect(visible).toContain(`visibility scope: ${owner}`);
      expect(visible).not.toContain(`subject: ${owner}`);
      expect(visible).toContain("not its speaker or grammatical subject");
      expect(visible).toContain("阿澄喜欢摄影；不是用户本人的爱好。");
    },
  );

  it("distinguishes historical use from the Memory revision status at retrieval", () => {
    const currentPack = {
      ...pack,
      items: pack.items.map((item) => ({ ...item, current: true })),
    };
    const context = createCognitionContextInput({
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
      text: "Discuss the earlier preference.",
      evidencePack: currentPack,
      historicalMemoryRevisionIds: [currentPack.items[0]!.revisionId],
    });
    const visible = JSON.stringify(materializeCognitionContextInput(context));
    expect(visible).toContain("preference; current");
    expect(visible).toContain("Selected use: historical reference only");
    expect(visible).not.toContain(currentPack.items[0]!.revisionId);
    expect(currentPack.items[0]!.current).toBe(true);
    expect(suppliedMemoryReferences([context])).toEqual([
      {
        memoryId: pack.items[0]!.memoryId,
        revisionId: pack.items[0]!.revisionId,
        use: "history",
      },
    ]);
  });

  it("keeps provenance private while retaining historical scope and missing evidence", () => {
    const context = createMemoryContextInput(pack, {
      purpose: "conversation",
      query: "谁喜欢摄影",
      questions: [{ id: "q1", text: "用户本人现在的爱好" }],
      contextBudget: { maxTokens: 1000 },
    });
    const visible = JSON.stringify(materializeMemoryContextInput(context));
    expect(visible).toContain("historical or superseded");
    expect(visible).toContain("阿澄喜欢摄影；不是用户本人的爱好。");
    expect(visible).toContain("用户本人现在的爱好: partial");
    expect(visible).toContain("当前用户偏好尚未确认");
    for (const id of [
      pack.items[0]!.memoryId,
      pack.items[0]!.revisionId,
      pack.items[0]!.sourceRefs[0]!.sourceId,
    ])
      expect(visible).not.toContain(id);
    expect(memoryContextRevisionReferences(context)).toEqual([
      {
        memoryId: pack.items[0]!.memoryId,
        revisionId: pack.items[0]!.revisionId,
      },
    ]);
  });

  it("can prepare the current situation without retrieving a profile", () => {
    const context = createCognitionContextInput({
      situationIds: ["private-situation"],
      intentIds: [],
      evidenceIds: [],
      text: "The current question is a greeting; no historical evidence was requested.",
    });
    const visible = JSON.stringify(materializeCognitionContextInput(context));
    expect(visible).toContain("greeting");
    expect(visible).not.toContain("private-situation");
    expect(visible).not.toContain("Selected memory evidence");
    expect(visible).not.toContain("阿澄");
  });
});
