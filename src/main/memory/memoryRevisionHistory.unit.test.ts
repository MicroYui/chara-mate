import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  MemoryDetail,
  MemoryHistoricalDisposition,
  MemoryPriorDisposition,
} from "../../shared/contracts/memory";
import type { MemoryEvidenceReference } from "../../shared/contracts/memoryRecall";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { createMemoryContextInput } from "../agent/memoryContext";
import { openApplicationDatabase } from "../db/database";
import { PersonaRepository } from "../persona/personaRepository";
import { estimateInputBudget } from "../providers/inputBudget";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";
import { MEMORY_CONSOLIDATION_VERSION } from "./memoryLearningRepository";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "revision-history-"));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanup.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = "2026-09-16T06:00:00.000Z";
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const personaId = personas.getActiveSnapshot().personaId;
  const repository = new MemoryRepository(database);
  const service = new MemoryService(
    repository,
    { search: () => [] },
    new CryptoIdGenerator(),
    { now: () => now },
  );
  const create = (content = "以前周五和爸爸在河边做纸灯。") =>
    repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      type: "event",
      content,
      now,
      reason: "真实来源陈述",
      confidence: 1,
      importance: 0.5,
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          createdAt: now,
        },
      ],
    });
  const reference = (detail: MemoryDetail): MemoryEvidenceReference => ({
    memoryId: detail.memory.id,
    revisionId: detail.memory.currentRevisionId,
    use: "history",
  });
  const revise = (
    detail: MemoryDetail,
    content: string,
    disposition: MemoryHistoricalDisposition,
    earlier: MemoryPriorDisposition[] = [],
  ) =>
    repository.revise({
      memoryId: detail.memory.id,
      revisionId: randomUUID(),
      predecessorRevisionId: detail.memory.currentRevisionId,
      priorDispositions: [
        { revisionId: detail.memory.currentRevisionId, disposition },
        ...earlier,
      ],
      content,
      now,
      reason: "按明确原文修订",
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          createdAt: now,
        },
      ],
    });
  const read = (detail: MemoryDetail) => {
    const result = service.resolveEvidence({
      personaId,
      references: [reference(detail)],
      resourceBudget: { maxReadBytes: 3000 },
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved")
      throw new Error(`Unexpected ${result.status}`);
    return result;
  };
  const grounding = (detail: MemoryDetail) =>
    service.validateEvidenceReferences({
      personaId,
      references: [reference(detail)],
      usage: "grounding",
    });
  return {
    database,
    repository,
    service,
    personaId,
    create,
    revise,
    read,
    grounding,
    reference,
    now,
  };
}

describe("intrinsic revision history", () => {
  it("keeps mixed-memory current reads separate from an unlinked old revision later explicitly retained", () => {
    const f = fixture();
    const first = f.create("以前确实约好一起做小册子。");
    const next = f.revise(first, "这次换到室内做。", "retained_history");
    const other = f.create("另一个独立项目的当前约定。");
    // Released old records may have no reliable predecessor chain. Do not use
    // their equal timestamps or a different Memory's current state as proof.
    f.database
      .prepare(
        "UPDATE memory_revisions SET predecessor_revision_id=NULL,prior_dispositions_json='[]' WHERE id=?",
      )
      .run(next.memory.currentRevisionId);
    const references = [
      f.reference(first),
      { ...f.reference(next), use: "current" as const },
      { ...f.reference(other), use: "current" as const },
    ];
    const before = f.service.resolveEvidence({
      personaId: f.personaId,
      references,
      resourceBudget: { maxReadBytes: 8192 },
    });
    expect(before.status).toBe("resolved");
    if (before.status !== "resolved")
      throw new Error(`Unexpected ${before.status}`);
    expect(before.items.map((item) => item.historyStatus)).toEqual([
      "unresolved",
      "current",
      "current",
    ]);
    const confirmed = f.revise(
      next,
      "旧约定曾经是真的，现在改在室内。",
      "retained_history",
      [
        {
          revisionId: first.memory.currentRevisionId,
          disposition: "retained_history",
        },
      ],
    );
    const after = f.service.resolveEvidence({
      personaId: f.personaId,
      references: [f.reference(first), f.reference(other)],
      resourceBudget: { maxReadBytes: 8192 },
    });
    expect(after.status).toBe("resolved");
    if (after.status !== "resolved")
      throw new Error(`Unexpected ${after.status}`);
    expect(after.items[0]).toMatchObject({
      historyStatus: "retained_history",
      historyStatusRevisionId: confirmed.memory.currentRevisionId,
    });
    expect(after.items[1]).toMatchObject({ historyStatus: "current" });
    expect(after.items[1]?.historyStatusRevisionId).toBeUndefined();
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: [f.reference(first), f.reference(other)],
        usage: "grounding",
      }),
    ).toEqual([]);
  });

  it("invalidates a captured history qualification while allowing a newly qualified report of a corrected record", () => {
    const f = fixture();
    const original = f.create();
    const reference = f.reference(original);
    const request = () => ({
      personaId: f.personaId,
      references: [reference],
      expectedHistory: f.read(original).items.map((item) => ({
        memoryId: item.memoryId,
        revisionId: item.revisionId,
        historyStatus: item.historyStatus,
        ...(item.historyStatusRevisionId
          ? { historyStatusRevisionId: item.historyStatusRevisionId }
          : {}),
      })),
    });
    const initiallyCurrent = request();
    expect(f.service.validateEvidenceReferences(initiallyCurrent)).toEqual([]);
    const changed = f.revise(
      original,
      "现在改在家做纸灯。",
      "retained_history",
    );
    expect(f.service.validateEvidenceReferences(initiallyCurrent)).toEqual([
      reference,
    ]);
    const retained = request();
    expect(f.service.validateEvidenceReferences(retained)).toEqual([]);
    const corrected = f.revise(
      changed,
      "更正：以前是在河边和妈妈做纸灯。",
      "corrected",
      [{ revisionId: reference.revisionId, disposition: "corrected" }],
    );
    expect(f.service.validateEvidenceReferences(retained)).toEqual([reference]);
    const report = request();
    expect(report.expectedHistory[0]).toMatchObject({
      historyStatus: "corrected",
      historyStatusRevisionId: corrected.memory.currentRevisionId,
    });
    expect(f.service.validateEvidenceReferences(report)).toEqual([]);
    expect(
      f.service.validateEvidenceReferences({ ...report, usage: "grounding" }),
    ).toEqual([reference]);
    f.revise(
      corrected,
      "补充更正缘由：旧记录把妈妈写成爸爸。",
      "retained_history",
      [{ revisionId: reference.revisionId, disposition: "corrected" }],
    );
    expect(f.service.validateEvidenceReferences(report)).toEqual([reference]);
    expect(f.read(original).status).toBe("resolved");
  });

  it("keeps an explicitly expired latest fact as past evidence while rejecting current grounding", () => {
    const f = fixture();
    const validFrom = "2026-09-01T00:00:00.000Z";
    const validTo = "2026-09-08T00:00:00.000Z";
    const detail = f.repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      type: "commitment",
      content: "九月第一周答应每晚先等用户讲完再回应。",
      now: f.now,
      reason: "明确适用区间的真实约定",
      confidence: 1,
      importance: 0.5,
      validFrom,
      validTo,
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          createdAt: validFrom,
        },
      ],
    });
    const history = f.reference(detail);
    const current = { ...history, use: "current" as const };
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: [current],
        usage: "grounding",
      }),
    ).toEqual([current]);
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: [history],
        usage: "grounding",
      }),
    ).toEqual([]);
    const read = f.read(detail);
    expect(read.status).toBe("resolved");
    expect(read.items[0]).toMatchObject({
      historyStatus: "current",
      current: false,
      validFrom,
      validTo,
    });
    const context = createMemoryContextInput({
      items: read.items,
      coverage: [],
      gaps: [],
      truncated: false,
      incompleteReasons: [],
      estimatedTokens: estimateInputBudget(read.items).estimatedTokens,
    });
    expect(JSON.stringify(context)).toContain(validTo);
    expect(JSON.stringify(context)).toContain("not that it applies now");
  });

  it.each([
    ["retained_history", "现在改在家里和爸爸做纸灯。", true],
    ["corrected", "刚才记错了，我从没和爸爸做过纸灯。", false],
    ["unresolved", "这条记录需要重新整理。", false],
  ] as const)(
    "separates annotated read from %s grounding",
    (disposition, content, allowed) => {
      const f = fixture(),
        old = f.create();
      const next = f.revise(old, content, disposition);
      const read = f.read(old);
      expect(read.status).toBe("resolved");
      expect(read.items[0]).toMatchObject({
        content: old.revisions[0]!.content,
        historyStatus: disposition,
        historyStatusRevisionId: next.memory.currentRevisionId,
        current: false,
      });
      expect(f.grounding(old)).toEqual(allowed ? [] : [f.reference(old)]);
      expect(
        f.repository
          .requireDetail(old.memory.id)
          .revisions.find(({ id }) => id === old.memory.currentRevisionId),
      ).toMatchObject({
        historyStatus: disposition,
        historyStatusRevisionId: next.memory.currentRevisionId,
      });
      expect(
        f.repository.hitsFor([f.reference(old)])[0]!.revision,
      ).toMatchObject({ historyStatus: disposition });
      const context = createMemoryContextInput({
        items: read.items,
        coverage: [],
        gaps: [],
        truncated: false,
        incompleteReasons: [],
        estimatedTokens: estimateInputBudget(read.items).estimatedTokens,
      });
      expect(JSON.stringify(context)).toContain(disposition);
      expect(JSON.stringify(context)).toContain(next.memory.currentRevisionId);
      expect(f.read(next).items[0]?.historyStatus).toBe("current");
    },
  );

  it("corrects all explicitly targeted generations at identical timestamps without reviving them", () => {
    const f = fixture(),
      r0 = f.create();
    const r1 = f.revise(r0, "现在改在家里和爸爸做纸灯。", "retained_history");
    const r2 = f.revise(
      r1,
      "前面这些都错，我从没和爸爸做过纸灯。",
      "corrected",
      [{ revisionId: r0.memory.currentRevisionId, disposition: "corrected" }],
    );
    for (const old of [r0, r1]) {
      expect(f.grounding(old)).toEqual([f.reference(old)]);
      expect(f.read(old).items[0]).toMatchObject({
        historyStatus: "corrected",
        historyStatusRevisionId: r2.memory.currentRevisionId,
      });
    }
    const r3 = f.revise(
      r2,
      "我又核对了照片，确实有和爸爸做过纸灯。",
      "corrected",
      [
        {
          revisionId: r0.memory.currentRevisionId,
          disposition: "retained_history",
        },
      ],
    );
    expect(f.grounding(r3)).toEqual([]);
    expect(f.read(r0).items[0]).toMatchObject({
      historyStatus: "corrected",
      historyStatusRevisionId: r2.memory.currentRevisionId,
    });
    // Removing a correction's Source cascades generic links, not intrinsic truth.
    f.repository.recall.link(
      r2.memory.currentRevisionId,
      r0.memory.currentRevisionId,
      "contradicts",
      r2.sources.at(-1)!.id,
    );
    f.database
      .prepare("DELETE FROM memory_sources WHERE id=?")
      .run(r2.sources.at(-1)!.id);
    expect(f.grounding(r0)).toEqual([f.reference(r0)]);
    expect(f.read(r0).items[0]?.historyStatusRevisionId).toBe(
      r2.memory.currentRevisionId,
    );
  });

  it("can later resolve an unknown old record using explicit historical evidence", () => {
    const f = fixture(),
      r0 = f.create();
    const r1 = f.revise(r0, "这条记录先整理一下。", "unresolved");
    expect(f.grounding(r0)).toEqual([f.reference(r0)]);
    const r2 = f.revise(
      r1,
      "核对旧照片后确认当时确实和爸爸做纸灯。",
      "unresolved",
      [
        {
          revisionId: r0.memory.currentRevisionId,
          disposition: "retained_history",
        },
      ],
    );
    expect(f.grounding(r0)).toEqual([]);
    expect(f.read(r0).items[0]?.historyStatusRevisionId).toBe(
      r2.memory.currentRevisionId,
    );
  });

  it("manual edit is unresolved and a stale or foreign-target transaction changes nothing", () => {
    const f = fixture(),
      old = f.create(),
      other = f.create("另一件事。");
    f.service.revise({
      memoryId: old.memory.id,
      content: "整理后的记录。",
      reason: "用户在 Memory 页面编辑",
      sources: [],
    });
    expect(f.read(old).items[0]?.historyStatus).toBe("unresolved");
    const current = f.repository.requireDetail(old.memory.id);
    const count = current.revisions.length;
    expect(() => f.revise(old, "陈旧写入", "corrected")).toThrow(/改变/);
    expect(() =>
      f.revise(current, "跨 Memory 误改", "corrected", [
        {
          revisionId: other.memory.currentRevisionId,
          disposition: "corrected",
        },
      ]),
    ).toThrow(/same Memory/);
    expect(f.repository.requireDetail(old.memory.id).revisions).toHaveLength(
      count,
    );
    expect(f.grounding(other)).toEqual([]);
  });

  it("preserves typed graph relationships without treating another Memory's contradiction as retraction", () => {
    const f = fixture(),
      a = f.create(),
      b = f.create("观察中出现另一种说法。");
    for (const relation of ["contradicts", "supersedes"])
      f.repository.recall.link(
        b.memory.currentRevisionId,
        a.memory.currentRevisionId,
        relation,
        b.sources[0]!.id,
      );
    expect(f.read(b).items[0]?.relations).toEqual([
      { revisionId: a.memory.currentRevisionId, relation: "contradicts" },
      { revisionId: a.memory.currentRevisionId, relation: "supersedes" },
    ]);
    expect(f.grounding(a)).toEqual([]);
  });

  it("does not grant history grounding to the final revision of a retired Memory", () => {
    const f = fixture(),
      old = f.create();
    f.repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content: "新候选记录。",
      type: "event",
      reason: "候选替换",
      now: f.now,
      confidence: 1,
      importance: 0.5,
      sources: [],
      supersedesMemoryId: old.memory.id,
    });
    expect(f.read(old).items[0]).toMatchObject({
      historyStatus: "unresolved",
      current: false,
    });
    expect(f.grounding(old)).toEqual([f.reference(old)]);
  });

  it("invalidates an unchanged derived summary even when its corrected parent was a history dependency", () => {
    const f = fixture(),
      parent = f.create(),
      other = f.create("当时也计划下次和爸爸一起做纸灯。");
    const summary = f.create("做纸灯联系着过去的相处和下次相聚的期待。");
    for (const item of [parent, other]) {
      f.repository.recall.putSemantics(
        item.memory.currentRevisionId,
        {
          kind: "episode",
          owner: "user",
          basis: "explicit_user_statement",
          qualifiers: {},
        },
        [],
      );
      const source = item.sources[0]!,
        content = item.revisions[0]!.content;
      f.repository.attachEvidence(summary.memory.currentRevisionId, [source]);
      for (const revision of [
        item.memory.currentRevisionId,
        summary.memory.currentRevisionId,
      ])
        f.repository.recall.addSpan(
          revision,
          source.id,
          0,
          content.length,
          content,
        );
      f.repository.recall.link(
        summary.memory.currentRevisionId,
        item.memory.currentRevisionId,
        "derived_from",
        source.id,
        "history",
      );
    }
    f.repository.recall.putSemantics(
      summary.memory.currentRevisionId,
      {
        kind: "reflection",
        owner: "user",
        basis: "inference",
        qualifiers: {
          consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
          consolidationDependencyCount: "2",
        },
      },
      [],
    );
    expect(f.grounding(summary)).toEqual([]);
    const changed = f.revise(
      parent,
      "现在改在家里做纸灯。",
      "retained_history",
    );
    expect(f.grounding(summary)).toEqual([]);
    f.revise(changed, "此前关于做纸灯的说法都错了，从没发生过。", "corrected", [
      { revisionId: parent.memory.currentRevisionId, disposition: "corrected" },
    ]);
    expect(
      f.repository.requireDetail(summary.memory.id).memory.currentRevisionId,
    ).toBe(summary.memory.currentRevisionId);
    expect(f.grounding(summary)).toEqual([f.reference(summary)]);
    expect(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [f.reference(summary)],
        resourceBudget: { maxReadBytes: 3000 },
      }),
    ).toEqual({ status: "unavailable", unavailable: [f.reference(summary)] });
    expect(
      f.repository.recall.evidence([summary.memory.currentRevisionId], f.now),
    ).toEqual([]);
  });
});
