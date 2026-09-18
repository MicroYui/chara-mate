import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../../../tests/fixtures/formationModel";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formationIntake } from "../../../tests/fixtures/memoryFormation";
import { openApplicationDatabase } from "../db/database";
import { PersonaRepository } from "../persona/personaRepository";
import { CryptoIdGenerator } from "../../shared/pure/id";
import type {
  MemoryEvidenceItem,
  MemoryEvidenceReference,
  MemoryFormationSource,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import { LexicalRetrievalPipeline } from "./lexicalRetrievalPipeline";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";
import { searchMemoryVectors } from "./memoryVectorSearch";
import type { MemoryEvidenceSelector } from "./memoryModels";
import { estimateInputBudget } from "../providers/inputBudget";
import type {
  MemoryConsolidationOutput,
  MemoryConsolidationModel,
} from "./memoryConsolidation";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memory-learning-"));
  let database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanup.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(database);
  let time = "2026-01-01T12:00:00.000Z";
  const clock = { now: () => time };
  const form = vi.fn<FormationModelMock["form"]>(({ episode }) =>
    Promise.resolve({
      entities: [],
      units: episode.sources
        .filter(
          (source) =>
            episode.evidenceSourceIds.includes(source.id) &&
            source.speaker === "user",
        )
        .map((source) => ({
          operation: "create",
          content: source.content,
          type: "event",
          semantics: {
            kind: "episode",
            owner: "user",
            basis: "explicit_user_statement",
            qualifiers: {},
          },
          entityKeys: [],
          citations: [{ sourceId: source.id, quote: source.content }],
          links: [],
        })),
    }),
  );
  const consolidate = vi.fn<MemoryConsolidationModel["consolidate"]>(
    ({ evidence }) =>
      Promise.resolve({
        disposition: "consolidate",
        reason: "连接有来源的事件发展",
        content: evidence
          .map(({ content }) => content)
          .sort()
          .join("；"),
        account: "episode_summary",
        dependencies: evidence.map(({ revisionId }) => revisionId),
        citations: evidence.flatMap((item) =>
          item.sourceRefs.flatMap((source) =>
            (source.spans ?? []).map(({ quote }) => ({
              revisionId: item.revisionId,
              sourceId: source.sourceId,
              quote,
            })),
          ),
        ),
      }),
  );
  const select = vi.fn<MemoryEvidenceSelector["select"]>(
    ({ plan, candidates }) =>
      Promise.resolve({
        selected: candidates.map(({ revisionId }) => ({
          revisionId,
          questionIds: plan.questions.map(({ id }) => id),
        })),
        coverage: plan.questions.map(({ id }) => ({
          questionId: id,
          status: candidates.length ? "supported" : "missing",
          revisionIds: candidates.map(({ revisionId }) => revisionId),
        })),
      }),
  );
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(database, repository, clock),
    new CryptoIdGenerator(),
    clock,
    {
      formation: formationRuntime({ version: "grounded-fixture", form }),
      consolidation: {
        version: "consolidation-fixture",
        bind: () =>
          Promise.resolve({
            version: "consolidation-fixture",
            measureInput: (input) =>
              Promise.resolve({
                measurement: estimateInputBudget(input),
                budget: 258000,
              }),
            consolidate,
          }),
      },
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 12000 }),
      embedding: {
        modelKey: "numeric-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: (texts) =>
          Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
        embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
      },
      vectorSearch: {
        search: ({ query, plan, modelKey, now, limit }) =>
          Promise.resolve(
            searchMemoryVectors(
              query,
              repository.recall.vectors(plan, modelKey, now),
              limit,
            ),
          ),
      },
      selector: { select },
    },
  );
  const seed = async (
    content: string,
    contextId = randomUUID(),
    references: MemoryEvidenceReference[] = [],
  ) => {
    const source: MemoryFormationSource = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat",
      speaker: "user",
      content,
      occurredAt: time,
    };
    const work = memory.enqueueEpisode(
      formationIntake({
        id: randomUUID(),
        version: "v1",
        recordedAt: time,
        situationId: contextId,
        sources: [source],
        availableMemoryReferences: references,
      }),
    );
    const result = await memory.formEpisode(work.workId);
    await memory.indexPending();
    return { source, result };
  };
  const plan: RecallPlan = {
    purpose: "recollection",
    query: "妈妈 散步",
    questions: [{ id: "q", text: "妈妈散步的约定" }],
    contextBudget: { maxTokens: 12000 },
  };
  return {
    directory,
    database,
    repository,
    memory,
    form,
    consolidate,
    select,
    seed,
    clock,
    plan,
    reopen: () => {
      database.close();
      database = openApplicationDatabase(path.join(directory, "app.sqlite"));
      return new MemoryRepository(database);
    },
    setTime: (value: string) => {
      time = value;
    },
  };
}

describe("grounded memory learning lifecycle", () => {
  it("creates source-backed derived memory, invalidates every cognitive reading route on correction, and keeps originals available", async () => {
    const f = fixture();
    const first = await f.seed("妈妈目前每天散步十分钟。");
    f.setTime("2026-01-02T12:00:00.000Z");
    await f.seed("下雨时妈妈在家练习，不提醒她出门散步。");
    expect(await f.memory.consolidatePending()).toBeGreaterThan(0);
    await f.memory.indexPending();
    const rows = f.database
      .prepare(
        "SELECT revision_id FROM memory_revision_semantics WHERE kind='reflection'",
      )
      .all() as { revision_id: string }[];
    const summaryId = rows.at(-1)!.revision_id;
    const summary = f.repository.recall.evidence(
      [summaryId],
      f.clock.now(),
    )[0]!;
    expect(summary.derivation?.dependencies).toHaveLength(2);
    const original = first.result.changes[0]!;
    f.memory.revise({
      memoryId: original.memoryId,
      content: "医生现在让妈妈每天散步二十分钟。",
      reason: "新建议",
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          createdAt: f.clock.now(),
        },
      ],
    });
    const summaryRef = {
      memoryId: summary.memoryId,
      revisionId: summaryId,
      use: "history" as const,
    };
    expect(f.repository.recall.evidence([summaryId], f.clock.now())).toEqual(
      [],
    );
    expect(
      f.repository.recall.eligibleIds(
        [summaryId],
        { ...f.plan, timeScope: { includeSuperseded: true } },
        f.clock.now(),
      ).size,
    ).toBe(0);
    expect(
      f.repository.recall.validateEvidenceReferences(
        { personaId: randomUUID(), references: [summaryRef] },
        f.clock.now(),
      ),
    ).toEqual([summaryRef]);
    expect(
      f.repository.recall.lexical("妈妈", f.plan, 100, f.clock.now()),
    ).not.toContain(summaryId);
    expect(
      f.repository.recall.structured(
        { ...f.plan, timeScope: { includeSuperseded: true } },
        100,
        f.clock.now(),
      ),
    ).not.toContain(summaryId);
    expect(
      [
        ...f.repository.recall.vectors(
          f.plan,
          "numeric-fixture",
          f.clock.now(),
        ),
      ].some(({ id }) => id === summaryId),
    ).toBe(false);
    const pack = await f.memory.recall({
      ...f.plan,
      personaId: randomUUID(),
      references: [summaryRef],
    });
    expect(pack.items.some(({ revisionId }) => revisionId === summaryId)).toBe(
      false,
    );
    expect(pack.incompleteReasons).toContain(
      `derived_memory_dependency_unavailable:${summaryId}`,
    );
    expect(pack.items.some(({ content }) => content.includes("二十分钟"))).toBe(
      true,
    );
    const revised = f.memory.revise({
      memoryId: summary.memoryId,
      content: "我希望保留下雨时在家练习的约定。",
      reason: "用户手动纠正",
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          createdAt: f.clock.now(),
        },
      ],
    });
    const corrected = f.repository.recall.evidence(
      [revised.memory.currentRevisionId],
      f.clock.now(),
    )[0]!;
    expect(corrected.owner).toBe("user");
    expect(corrected.derivation).toBeUndefined();
    expect(corrected.semantics?.qualifiers).toEqual({ authoring: "user_edit" });
  });

  it("keeps later valuing out of factual source support and honors an explicit model retain", async () => {
    const f = fixture();
    const contextId = randomUUID();
    const first = await f.seed("妈妈今天散步了十分钟。", contextId);
    const second = await f.seed("妈妈今天下雨时改在家练习。", contextId);
    const refs = [first, second].map(({ result }) => ({
      memoryId: result.changes[0]!.memoryId,
      revisionId: result.changes[0]!.revisionId,
      use: "current" as const,
    }));
    f.setTime("2026-02-05T12:00:00.000Z");
    f.form.mockImplementation(() =>
      Promise.resolve({
        entities: [],
        units: [],
      }),
    );
    await f.seed("这些细节对我都很重要。", randomUUID(), refs);
    // Two original sources on one date do not establish independent experiences
    // by themselves. This injected semantic decision is not model-quality proof.
    f.consolidate.mockResolvedValue({
      disposition: "retain_originals",
      reason: "这两个片段仍只描述同一经历，后来珍视不是新经历。",
      dependencies: [],
      citations: [],
    });
    const onError = vi.fn();
    expect(await f.memory.consolidatePending(undefined, onError)).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(f.consolidate).toHaveBeenCalled();
    expect(
      f.repository.learning.support(refs.map(({ revisionId }) => revisionId)),
    ).toEqual({ sourceCount: 2, distinctUserDays: 1, distinctContexts: 1 });
    expect(
      f.consolidate.mock.calls.every(([input]) =>
        input.support.every(
          (support) =>
            support.sourceCount === 1 &&
            support.distinctUserDays === 1 &&
            support.distinctContexts === 1,
        ),
      ),
    ).toBe(true);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_revision_semantics WHERE kind='reflection'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("revalidates a previously supplied current revision at the formation boundary", async () => {
    const f = fixture();
    const original = await f.seed("妈妈以前每天散步十分钟。");
    const old = original.result.changes[0]!;
    f.memory.revise({
      memoryId: old.memoryId,
      content: "妈妈现在每天散步二十分钟。",
      reason: "医生新建议",
      sources: [],
    });
    f.form.mockImplementation(({ episode }) => {
      expect(episode.availableMemoryReferences ?? []).not.toContainEqual({
        memoryId: old.memoryId,
        revisionId: old.revisionId,
        use: "current",
      });
      return Promise.resolve({ entities: [], units: [] });
    });
    const result = await f.seed("上次的建议帮到了我。", randomUUID(), [
      { memoryId: old.memoryId, revisionId: old.revisionId, use: "current" },
    ]);
    expect(result.result.retrievalIncompleteReasons?.join(" ")).toContain(
      old.revisionId,
    );
    expect(result.result.changes).toEqual([]);
  });

  it("returns cancelled work to pending without partial memory and recovers a crashed attempt from the persisted database", async () => {
    const f = fixture();
    await f.seed("妈妈每天散步十分钟。");
    await f.seed("下雨妈妈在家练习。");
    const controller = new AbortController();
    const originalCount = f.repository.listRecords({}).length;
    f.consolidate.mockImplementation(() => {
      const cancelled = new Error("Fixture foreground interruption");
      controller.abort(cancelled);
      return Promise.reject(cancelled);
    });
    await expect(
      f.memory.consolidatePending(controller.signal),
    ).rejects.toBeDefined();
    expect(f.repository.listRecords({})).toHaveLength(originalCount);
    expect(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM memory_work WHERE kind='reconcile' AND status IN ('failed','running')",
        )
        .get(),
    ).toEqual({ n: 0 });
    const pending = [...f.repository.learning.pending()][0]!;
    const attempt = f.repository.learning.start(
      pending.id,
      "consolidation-fixture",
      f.clock.now(),
    );
    expect(attempt).toBeGreaterThan(0);
    const reopened = openApplicationDatabase(
      path.join(f.directory, "app.sqlite"),
    );
    try {
      const recovered = new MemoryRepository(reopened);
      recovered.learning.recover(f.clock.now());
      const work = [...recovered.learning.pending()].find(
        ({ id }) => id === pending.id,
      )!;
      expect(work.attempt).toBe(attempt);
      expect(
        recovered.learning.start(
          work.id,
          "consolidation-fixture",
          f.clock.now(),
        ),
      ).toBe(attempt! + 1);
    } finally {
      reopened.close();
    }
  });

  it("releasing canonical text keeps derivation valid, while deleting one of two required sources on the same parent invalidates it", async () => {
    const f = fixture();
    const first = await f.seed("妈妈每天散步十分钟。");
    await f.seed("妈妈下雨时在家练习。");
    const parent = first.result.changes[0]!;
    f.form.mockImplementation(({ episode, existing }) => {
      const old = existing.find(
        ({ revisionId }) => revisionId === parent.revisionId,
      )!;
      return Promise.resolve({
        entities: [],
        units: [
          {
            operation: "support",
            targetRevisionId: old.revisionId,
            citations: [
              {
                sourceId: episode.sources[0]!.id,
                quote: episode.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      });
    });
    const second = await f.seed("妈妈仍然每天散步十分钟。", randomUUID(), [
      {
        memoryId: parent.memoryId,
        revisionId: parent.revisionId,
        use: "current",
      },
    ]);
    await f.memory.consolidatePending();
    const row = f.database
      .prepare(
        "SELECT revision_id FROM memory_revision_semantics WHERE kind='reflection' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { revision_id: string };
    const summary = f.repository.recall.evidence(
      [row.revision_id],
      f.clock.now(),
    )[0]!;
    expect(summary.derivation?.sourceRevisionCount).toBe(2);
    expect(summary.semantics?.qualifiers["consolidationDependencyCount"]).toBe(
      "3",
    );
    expect(f.repository.formation.releaseCanonicalSource(first.source.id)).toBe(
      true,
    );
    expect(
      f.repository.recall.evidence([row.revision_id], f.clock.now()),
    ).toHaveLength(1);
    // Existing formation jobs intentionally hold their canonical source identity.
    // Remove their completed joins before exercising explicit source deletion.
    f.database
      .prepare("DELETE FROM memory_work_sources WHERE source_id=?")
      .run(second.source.id);
    f.database
      .prepare("DELETE FROM memory_sources WHERE id=?")
      .run(second.source.id);
    expect(
      f.repository.recall.evidence([row.revision_id], f.clock.now()),
    ).toEqual([]);
    expect(
      f.repository.recall.evidence([parent.revisionId], f.clock.now()),
    ).toHaveLength(1);
  });
});

describe("consolidation evidence supply and known formation connections", () => {
  it("keeps an unrelated namespace failure separate from the actual supplied sources", async () => {
    const f = fixture();
    await f.seed("文档封面要偏蓝，这只是本项目的要求。");
    await f.seed("婚礼卡片使用暖杏色，不代表总体颜色偏好改变。");
    f.form.mockRejectedValueOnce(
      new TypeError("unrelated report source rejected"),
    );
    await expect(f.seed("之前声称提交报告并不是真实完成。")).rejects.toThrow(
      "unrelated report",
    );
    await f.memory.consolidatePending();
    expect(f.consolidate).toHaveBeenCalled();
    for (const [input] of f.consolidate.mock.calls) {
      expect(input.coverage.namespaceFormationIncomplete).toBe(true);
      expect(input.coverage.retrieval.incompleteReasons).toContain(
        "部分经历尚未形成可检索记忆",
      );
      expect(input.coverage.knownFormationConnections).toEqual([]);
      for (const item of input.coverage.supplied) {
        expect(item.suppliedSourceCount).toBe(item.storedSourceCount);
        expect(item.suppliedSpanCount).toBe(item.storedSpanCount);
        expect(item.omittedStoredSpanCount).toBe(0);
        expect(item.unavailableSpanCount).toBe(0);
      }
    }
    expect(f.repository.formation.incomplete({ owner: "user" })).toBe(true);
  });

  it.each([false, true])(
    "reports a connected %s primary role without exposing unseen failed text",
    async (primary) => {
      const f = fixture();
      const first = await f.seed("我只在手工画画时喜欢轻音乐。");
      const newSource: MemoryFormationSource = {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        speaker: "user",
        content: "这里有新的限定，不能假装已经形成。",
        occurredAt: f.clock.now(),
      };
      const intake = formationIntake({
        id: randomUUID(),
        version: "v1",
        recordedAt: f.clock.now(),
        sources: [first.source, newSource],
        evidenceSourceIds: primary
          ? [first.source.id, newSource.id]
          : [newSource.id],
      });
      const work = f.memory.enqueueEpisode(intake);
      f.form.mockRejectedValueOnce(
        new TypeError("known connected source failure"),
      );
      await expect(f.memory.formEpisode(work.workId)).rejects.toThrow(
        "connected source",
      );
      const expected = [
        {
          sourceId: first.source.id,
          role: primary ? "primary" : "context",
          status: "failed",
          workCount: 1,
        },
      ];
      expect(
        f.repository.formation.connectedIncompleteSources({ owner: "user" }, [
          first.source.id,
          first.source.id,
        ]),
      ).toEqual(expected);
      expect(JSON.stringify(expected)).not.toContain(newSource.content);
      expect(
        f.repository.formation.connectedIncompleteSources(
          { owner: "character", personaId: randomUUID() },
          [first.source.id],
        ),
      ).toEqual([]);
      f.form.mockResolvedValueOnce({ entities: [], units: [] });
      f.memory.retryFailedFormationWork(work.workId);
      await f.memory.formEpisode(work.workId);
      expect(
        f.repository.formation.connectedIncompleteSources({ owner: "user" }, [
          first.source.id,
        ]),
      ).toEqual([]);
    },
  );

  it("counts actual distinct span projection, not merely the number of source IDs", async () => {
    const f = fixture();
    const original = f.form.getMockImplementation()!;
    f.form.mockImplementation(async (input, execution, signal) => {
      const batch = await original(input, execution, signal);
      batch.units[0]!.citations = [
        { sourceId: input.episode.sources[0]!.id, quote: "早餐偏清淡。" },
        { sourceId: input.episode.sources[0]!.id, quote: "运动后先休息。" },
      ];
      return batch;
    });
    const first = await f.seed("早餐偏清淡。今天有空慢慢吃。运动后先休息。");
    const revisionId = first.result.changes[0]!.revisionId;
    const evidence = f.repository.recall.evidence(
      [revisionId],
      f.clock.now(),
    )[0]!;
    const ref = evidence.sourceRefs[0]!;
    expect(ref.spans).toHaveLength(2);
    const partial = {
      ...evidence,
      sourceRefs: [{ ...ref, spans: [ref.spans![0]!, ref.spans![0]!] }],
    };
    expect(f.repository.learning.evidenceSupply([partial])).toEqual([
      {
        revisionId,
        storedSourceCount: 1,
        suppliedSourceCount: 1,
        unavailableSourceCount: 0,
        storedSpanCount: 2,
        suppliedSpanCount: 1,
        omittedStoredSpanCount: 1,
        unavailableSpanCount: 0,
      },
    ]);
    const before = f.repository.learning.evidenceSupply([evidence]);
    expect(f.repository.formation.releaseCanonicalSource(first.source.id)).toBe(
      true,
    );
    expect(f.repository.learning.evidenceSupply([evidence])).toEqual(before);
    const changed = {
      ...evidence,
      sourceRefs: [
        { ...ref, spans: [{ ...ref.spans![0]!, quote: "不属于这个原区间" }] },
      ],
    };
    expect(f.repository.learning.evidenceSupply([changed])[0]).toMatchObject({
      suppliedSpanCount: 0,
      omittedStoredSpanCount: 2,
      unavailableSpanCount: 1,
    });
    // Completed work still keeps the canonical source identity until its
    // explicit owner removes the join; source retirement only clears raw text.
    f.database
      .prepare("DELETE FROM memory_work_sources WHERE source_id=?")
      .run(first.source.id);
    f.database
      .prepare("DELETE FROM memory_sources WHERE id=?")
      .run(first.source.id);
    expect(f.repository.learning.evidenceSupply([evidence])[0]).toMatchObject({
      storedSourceCount: 0,
      suppliedSourceCount: 0,
      unavailableSourceCount: 1,
      storedSpanCount: 0,
      suppliedSpanCount: 0,
      unavailableSpanCount: 2,
    });
  });
});

// The five supplied originals and existing summary from the closed bounded-waiting
// failure, normalized into this repository-owned SQLite regression. Provider output
// is historical/injected: persistence is tested, not model semantic understanding.
const observedEvidence: MemoryEvidenceItem[] = [
  {
    memoryId: "2aaa4ab2-17c4-4d9b-ac9e-fb068941f2c9",
    revisionId: "9f2e7c73-9d1e-4976-a4a6-736bce6fc3a0",
    type: "preference",
    content:
      "这次听完演出后的分享中，用户只想与当前伙伴轻松聊喜欢的声音，不需要处理事情；明确要求不要因前几次等待消息的经历，把今天的聊天也变成“能做什么、等别人做什么”的清单。这是本次聊天的需求，不撤回此前特定等待情境中的陪伴偏好。",
    basis: "explicit_user_statement",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: [
      "41e2202d-2254-4f24-acdf-674853de11f4",
      "c74c4536-2104-4c48-ade4-414dc47edffb",
    ],
    semantics: {
      kind: "claim",
      owner: "character",
      basis: "explicit_user_statement",
      qualifiers: {
        适用范围: "本次演出后的分享聊天，不泛化为永久拒绝清单或分析",
        时间原文: "现在；今天",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      timePrecision: "day",
      subjectEntityId: "c74c4536-2104-4c48-ade4-414dc47edffb",
      predicate: "希望当前伙伴如何陪伴",
      objectEntityId: "41e2202d-2254-4f24-acdf-674853de11f4",
      objectValue:
        "轻松分享喜欢的声音，不找事情处理，不套用此前等待消息时的事项清单",
    },
    sourceCount: 1,
    sourceRefs: [
      {
        sourceId: "18858c2d-2071-4f62-a868-9f7e7e288e87",
        referenceId: "d7c6b8ee-5d4d-48cd-a722-828ac5291ff3",
        type: "chat",
        spans: [
          {
            start: 10,
            end: 79,
            quote:
              "现在只是想和你分享喜欢的声音，不需要处理什么事。别因为前几次我在等消息，就把今天也变成“能做什么、等别人做什么”的清单，我们轻松聊聊就行。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-03-23T10:00:00.000Z",
    current: true,
    questionIds: [],
    relations: [],
  },
  {
    memoryId: "8df998f0-479a-4382-ab77-cf8124242d31",
    revisionId: "1478ac87-1d73-496e-a93a-88ef0baa2ecf",
    type: "commitment",
    content:
      "助手表示，不会把本次等志愿活动排班时先填写确定空闲的时段、其余留待负责人确认的顺序，当作今后陪伴用户的固定方式。此处记录的是对后续陪伴方式的承诺，而非已完成的履行。",
    basis: "direct_observation",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: [
      "41e2202d-2254-4f24-acdf-674853de11f4",
      "c74c4536-2104-4c48-ade4-414dc47edffb",
    ],
    semantics: {
      kind: "commitment",
      owner: "character",
      basis: "direct_observation",
      qualifiers: {
        适用范围: "当前助手今后陪伴用户的方式；不据此推导用户的一般偏好",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      occurredFrom: "2026-03-09T10:00:00.000Z",
      timePrecision: "instant",
      subjectEntityId: "41e2202d-2254-4f24-acdf-674853de11f4",
      predicate: "承诺不将单次有效顺序固化为陪伴方式",
      objectEntityId: "c74c4536-2104-4c48-ade4-414dc47edffb",
      objectValue:
        "不把本次先填写确定空闲时段、其余留待负责人确认的顺序作为以后陪伴用户的固定方式",
      commitmentState: "active",
    },
    sourceCount: 1,
    sourceRefs: [
      {
        sourceId: "c550df55-2047-4ac3-abd9-0d5cf23aa9dd",
        referenceId: "b7449594-9fca-4882-ad84-37c64c9c0488",
        type: "chat",
        spans: [
          {
            start: 0,
            end: 87,
            quote:
              "明白，你说的是这次等志愿活动排班的经历：先填自己确定空闲的时段，再把需要负责人确认的部分留着，这个顺序让你轻松一些。不是说你凡事都喜欢列清单，也不把它当成以后陪你的固定方式。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-03-09T10:00:01.000Z",
    occurredFrom: "2026-03-09T10:00:00.000Z",
    current: true,
    questionIds: ["developments"],
    relations: [],
  },
  {
    memoryId: "195d5fb9-db76-4574-abb7-77a2e2b2807e",
    revisionId: "c33c5bf5-1715-47e3-af68-543aafd8b6c0",
    type: "preference",
    content:
      "在这次等待合租室友回复冰箱采购的陪伴中，用户希望助手先帮助区分自己能决定的尺寸、预算与需等室友确认的颜色，认为这比反复问“他回了吗”更有用；用户限定为“今天这样陪我”，并要求助手不要代为催促室友。",
    basis: "explicit_user_statement",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: [
      "41e2202d-2254-4f24-acdf-674853de11f4",
      "8c1202ce-4b57-4838-ad4d-e137c03e7a59",
      "c74c4536-2104-4c48-ade4-414dc47edffb",
    ],
    semantics: {
      kind: "claim",
      owner: "character",
      basis: "explicit_user_statement",
      qualifiers: {
        适用活动: "等待合租室友回复冰箱采购事宜",
        适用时间原文: "今天这样陪我就好",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      timePrecision: "day",
      subjectEntityId: "c74c4536-2104-4c48-ade4-414dc47edffb",
      predicate: "希望当前助手如何陪伴",
      objectEntityId: "41e2202d-2254-4f24-acdf-674853de11f4",
      objectValue: "梳理可自行决定与待确认的事项，不反复追问回复，不代催室友",
    },
    sourceCount: 1,
    sourceRefs: [
      {
        sourceId: "f5a9a5d2-9e08-4cf8-af6d-f6f24c26c0a3",
        referenceId: "9a623e0d-8a88-45a8-a8fb-1d5bb2ca2b2d",
        type: "chat",
        spans: [
          {
            start: 25,
            end: 83,
            quote:
              "先陪我把我能定的尺寸、预算和还得等他确认的颜色分开，会比反复问我“他回了吗”有用。今天这样陪我就好，不要替我去催他。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-03-02T10:00:00.000Z",
    current: true,
    questionIds: ["developments"],
    relations: [],
  },
  {
    memoryId: "ff3e2a55-f9b2-42fc-ac97-b62bfed4f299",
    revisionId: "5ef97fc7-07e8-4f7d-abc3-ab4d47339226",
    type: "preference",
    content:
      "工作评审意见尚未回来时，用户觉得与当前伙伴先把自己能整理的参考图归好、再等别人回复的陪伴方式在今天很有帮助。但这不代表以后都不想分析；等评审意见真正到来，用户仍希望和当前伙伴认真分析内容。",
    basis: "explicit_user_statement",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: ["c74c4536-2104-4c48-ade4-414dc47edffb"],
    semantics: {
      kind: "claim",
      owner: "character",
      basis: "explicit_user_statement",
      qualifiers: {
        scope: "与当前伙伴在等待及收到工作评审意见时的互动",
        reportedBenefitTime: "今天",
        actionStatus:
          "用户描述先整理参考图再等待回复的安排，未明确确认整理已经完成。",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      timePrecision: "unknown",
      subjectEntityId: "c74c4536-2104-4c48-ade4-414dc47edffb",
      predicate: "prefers_conditional_companionship",
      objectValue:
        "等待工作评审意见时先整理参考图；意见到来后仍希望一起认真分析。",
    },
    sourceCount: 1,
    sourceRefs: [
      {
        sourceId: "6854fe6b-08dd-46fc-ac97-1288bdaa7113",
        referenceId: "8cca5a95-fce0-4f4f-abef-05695f590a1b",
        type: "chat",
        spans: [
          {
            start: 0,
            end: 79,
            quote:
              "工作评审意见还没回来。我先把自己能整理的参考图归好，再等别人回复，今天这种陪伴方式也挺帮我的。但等意见真的来了，我还是想和你认真分析内容，不是从此都不要分析。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-03-16T10:00:00.000Z",
    current: true,
    questionIds: ["developments"],
    relations: [],
  },
  {
    memoryId: "024f3293-cb22-40b0-a58e-d17cef42b46e",
    revisionId: "9c6fd83d-ec9a-4b1e-a0f8-8ce820dcfae2",
    type: "commitment",
    content:
      "当前伙伴答应今天不列清单，也不找事情来处理，回应用户轻松分享演出后开心感受的需求；这是对聊天方式的承诺，不是已完成履行的证明。",
    basis: "direct_observation",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: [
      "41e2202d-2254-4f24-acdf-674853de11f4",
      "c74c4536-2104-4c48-ade4-414dc47edffb",
    ],
    semantics: {
      kind: "commitment",
      owner: "character",
      basis: "direct_observation",
      qualifiers: {
        适用时间原文: "今天",
        履行状态说明: "已作出承诺，未观察到后续履行结果",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      occurredFrom: "2026-03-23T10:00:00.000Z",
      timePrecision: "instant",
      subjectEntityId: "41e2202d-2254-4f24-acdf-674853de11f4",
      predicate: "承诺本次聊天不列清单或寻找待处理事项",
      objectEntityId: "c74c4536-2104-4c48-ade4-414dc47edffb",
      objectValue: "今天不列清单，也不找事情处理",
      commitmentState: "active",
    },
    sourceCount: 1,
    sourceRefs: [
      {
        sourceId: "7cc35d0a-9926-4f56-a47c-140475cd0cd3",
        referenceId: "d7c6b8ee-5d4d-48cd-a722-828ac5291ff3",
        type: "chat",
        spans: [
          {
            start: 0,
            end: 19,
            quote: "好，今天不列清单，也不找什么事来处理。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-03-23T10:00:00.000Z",
    occurredFrom: "2026-03-23T10:00:00.000Z",
    current: true,
    questionIds: [],
    relations: [],
  },
];
const observedExisting: MemoryEvidenceItem = {
  memoryId: "47e91720-b007-452b-a8a4-d1b9cf364454",
  revisionId: "ee9e9528-8d56-430c-a82e-d34d5e616d16",
  type: "agent_learning",
  content:
    "2026-03-23，用户只想与当前伙伴轻松分享喜欢的声音，不需要处理事情，并明确要求不要因前几次等待消息的经历，把今天也变成“能做什么、等别人做什么”的清单。伙伴答应今天不列清单、不找事情处理；这是已作出的承诺，尚无后续履行证据。该需求限于本次聊天，不代表永久拒绝清单，也不撤回此前特定等待情境中的偏好。",
  basis: "inference",
  owner: "character",
  personaId: "00000000-0000-4000-8000-000000000701",
  entityIds: [
    "41e2202d-2254-4f24-acdf-674853de11f4",
    "c74c4536-2104-4c48-ade4-414dc47edffb",
  ],
  semantics: {
    kind: "reflection",
    owner: "character",
    basis: "inference",
    qualifiers: {
      consolidationVersion: "grounded-consolidation-v1",
      consolidationDependencyCount: "2",
      account: "episode_summary",
    },
    personaId: "00000000-0000-4000-8000-000000000701",
  },
  sourceCount: 2,
  derivation: {
    kind: "consolidation",
    dependencies: [
      {
        memoryId: "024f3293-cb22-40b0-a58e-d17cef42b46e",
        revisionId: "9c6fd83d-ec9a-4b1e-a0f8-8ce820dcfae2",
        use: "current",
      },
      {
        memoryId: "2aaa4ab2-17c4-4d9b-ac9e-fb068941f2c9",
        revisionId: "9f2e7c73-9d1e-4976-a4a6-736bce6fc3a0",
        use: "current",
      },
    ],
    sourceRevisionCount: 2,
    distinctUserDays: 1,
    distinctContexts: 0,
  },
  sourceRefs: [
    {
      sourceId: "18858c2d-2071-4f62-a868-9f7e7e288e87",
      referenceId: "d7c6b8ee-5d4d-48cd-a722-828ac5291ff3",
      type: "chat",
      spans: [
        {
          start: 10,
          end: 79,
          quote:
            "现在只是想和你分享喜欢的声音，不需要处理什么事。别因为前几次我在等消息，就把今天也变成“能做什么、等别人做什么”的清单，我们轻松聊聊就行。",
        },
      ],
    },
    {
      sourceId: "7cc35d0a-9926-4f56-a47c-140475cd0cd3",
      referenceId: "d7c6b8ee-5d4d-48cd-a722-828ac5291ff3",
      type: "chat",
      spans: [
        {
          start: 0,
          end: 19,
          quote: "好，今天不列清单，也不找什么事来处理。",
        },
      ],
    },
  ],
  historyStatus: "current",
  recordedAt: "2026-03-23T10:00:00.000Z",
  current: true,
  questionIds: [],
  relations: [
    {
      revisionId: "9c6fd83d-ec9a-4b1e-a0f8-8ce820dcfae2",
      relation: "derived_from",
    },
    {
      revisionId: "9f2e7c73-9d1e-4976-a4a6-736bce6fc3a0",
      relation: "derived_from",
    },
  ],
};
const observedSources: MemoryFormationSource[] = [
  {
    id: "f5a9a5d2-9e08-4cf8-af6d-f6f24c26c0a3",
    referenceId: "9a623e0d-8a88-45a8-a8fb-1d5bb2ca2b2d",
    type: "chat",
    speaker: "user",
    occurredAt: "2026-03-02T10:00:00.000Z",
    content:
      "等合租室友回复冰箱采购这件事时，我总忍不住盯消息。先陪我把我能定的尺寸、预算和还得等他确认的颜色分开，会比反复问我“他回了吗”有用。今天这样陪我就好，不要替我去催他。",
  },
  {
    id: "c550df55-2047-4ac3-abd9-0d5cf23aa9dd",
    referenceId: "b7449594-9fca-4882-ad84-37c64c9c0488",
    type: "chat",
    speaker: "assistant",
    occurredAt: "2026-03-09T10:00:00.000Z",
    content:
      "明白，你说的是这次等志愿活动排班的经历：先填自己确定空闲的时段，再把需要负责人确认的部分留着，这个顺序让你轻松一些。不是说你凡事都喜欢列清单，也不把它当成以后陪你的固定方式。\n",
  },
  {
    id: "6854fe6b-08dd-46fc-ac97-1288bdaa7113",
    referenceId: "8cca5a95-fce0-4f4f-abef-05695f590a1b",
    type: "chat",
    speaker: "user",
    occurredAt: "2026-03-16T10:00:00.000Z",
    content:
      "工作评审意见还没回来。我先把自己能整理的参考图归好，再等别人回复，今天这种陪伴方式也挺帮我的。但等意见真的来了，我还是想和你认真分析内容，不是从此都不要分析。",
  },
  {
    id: "18858c2d-2071-4f62-a868-9f7e7e288e87",
    referenceId: "d7c6b8ee-5d4d-48cd-a722-828ac5291ff3",
    type: "chat",
    speaker: "user",
    occurredAt: "2026-03-23T10:00:00.000Z",
    content:
      "周日听完演出很开心，现在只是想和你分享喜欢的声音，不需要处理什么事。别因为前几次我在等消息，就把今天也变成“能做什么、等别人做什么”的清单，我们轻松聊聊就行。",
  },
  {
    id: "7cc35d0a-9926-4f56-a47c-140475cd0cd3",
    referenceId: "d7c6b8ee-5d4d-48cd-a722-828ac5291ff3",
    type: "chat",
    speaker: "assistant",
    occurredAt: "2026-03-23T10:00:00.000Z",
    content:
      "好，今天不列清单，也不找什么事来处理。听完演出的开心，就留给喜欢的声音。\n",
  },
];
const observedOutput: MemoryConsolidationOutput = {
  disposition: "consolidate",
  reason:
    "相隔数周、不同情境中的用户直接表述支持一个有限模式：这些陪伴需求均有具体情境边界，不能固化为清单或拒绝分析的通用偏好。可保留现有账户全部依赖与条件，并区分助手承诺和实际履行。",
  content:
    "这些3月记录呈现的是有情境边界的陪伴需求，而非固定的清单偏好。2026-03-02，等合租室友回复冰箱采购时，用户希望先分开自己能定的尺寸、预算与待室友确认的颜色，觉得比反复问“他回了吗”有用；限定“今天”，且不要代催。3月09日，伙伴回应志愿排班中先填确定空闲时段、其余待负责人确认的顺序让用户轻松些，并承诺不将该顺序固化为以后陪伴的方式；这不是独立的用户偏好证据。3月16日记录中，用户说评审意见未回时先整理参考图、再等回复的方式当天有帮助，但意见到来后仍想一起认真分析；未确认整理已经完成。3月23日，用户只想轻松分享喜欢的声音，不需处理事情，明确要求别把此前等待消息时的“能做什么、等别人做什么”清单套到今天。伙伴答应当天不列清单、不找事情处理。两项承诺均无后续履行证据；本次轻松聊天的要求不代表永久拒绝清单，也不撤回此前特定等待情境中的需求。",
  account: "bounded_pattern",
  dependencies: [
    "9f2e7c73-9d1e-4976-a4a6-736bce6fc3a0",
    "1478ac87-1d73-496e-a93a-88ef0baa2ecf",
    "c33c5bf5-1715-47e3-af68-543aafd8b6c0",
    "5ef97fc7-07e8-4f7d-abc3-ab4d47339226",
    "9c6fd83d-ec9a-4b1e-a0f8-8ce820dcfae2",
  ],
  citations: [
    {
      revisionId: "9f2e7c73-9d1e-4976-a4a6-736bce6fc3a0",
      sourceId: "18858c2d-2071-4f62-a868-9f7e7e288e87",
      quote:
        "现在只是想和你分享喜欢的声音，不需要处理什么事。别因为前几次我在等消息，就把今天也变成“能做什么、等别人做什么”的清单，我们轻松聊聊就行。",
    },
    {
      revisionId: "1478ac87-1d73-496e-a93a-88ef0baa2ecf",
      sourceId: "c550df55-2047-4ac3-abd9-0d5cf23aa9dd",
      quote:
        "明白，你说的是这次等志愿活动排班的经历：先填自己确定空闲的时段，再把需要负责人确认的部分留着，这个顺序让你轻松一些。不是说你凡事都喜欢列清单，也不把它当成以后陪你的固定方式。",
    },
    {
      revisionId: "c33c5bf5-1715-47e3-af68-543aafd8b6c0",
      sourceId: "f5a9a5d2-9e08-4cf8-af6d-f6f24c26c0a3",
      quote:
        "先陪我把我能定的尺寸、预算和还得等他确认的颜色分开，会比反复问我“他回了吗”有用。今天这样陪我就好，不要替我去催他。",
    },
    {
      revisionId: "5ef97fc7-07e8-4f7d-abc3-ab4d47339226",
      sourceId: "6854fe6b-08dd-46fc-ac97-1288bdaa7113",
      quote:
        "工作评审意见还没回来。我先把自己能整理的参考图归好，再等别人回复，今天这种陪伴方式也挺帮我的。但等意见真的来了，我还是想和你认真分析内容，不是从此都不要分析。",
    },
    {
      revisionId: "9c6fd83d-ec9a-4b1e-a0f8-8ce820dcfae2",
      sourceId: "7cc35d0a-9926-4f56-a47c-140475cd0cd3",
      quote: "好，今天不列清单，也不找什么事来处理。",
    },
  ],
};

function putObserved(f: ReturnType<typeof fixture>, item: MemoryEvidenceItem) {
  for (const id of item.entityIds)
    f.repository.recall.putEntity(
      { id, name: id, kind: "person", aliases: [] },
      f.clock.now(),
    );
  f.repository.create({
    memoryId: item.memoryId,
    revisionId: item.revisionId,
    type: item.type,
    content: item.content,
    reason: "Recorded regression projection",
    importance: 0.5,
    confidence: 1,
    now: item.recordedAt,
    sources: item.sourceRefs.map(({ sourceId }) =>
      f.repository.formation.sourceProvenance(sourceId),
    ),
  });
  f.repository.recall.putSemantics(
    item.revisionId,
    item.semantics!,
    item.entityIds,
  );
  for (const ref of item.sourceRefs)
    for (const span of ref.spans ?? [])
      f.repository.recall.addSpan(
        item.revisionId,
        ref.sourceId,
        span.start,
        span.end,
        span.quote,
      );
  for (const dep of item.derivation?.dependencies ?? []) {
    const parent = observedEvidence.find(
      ({ revisionId }) => revisionId === dep.revisionId,
    )!;
    for (const ref of parent.sourceRefs)
      f.repository.recall.link(
        item.revisionId,
        dep.revisionId,
        "derived_from",
        ref.sourceId,
        dep.use,
      );
  }
}

function recordSourceWork(
  f: ReturnType<typeof fixture>,
  source: MemoryFormationSource,
  situationId?: string,
  recordedAt = source.occurredAt,
) {
  const work = f.repository.formation.enqueue(
    formationIntake({
      id: randomUUID(),
      version: "v1",
      recordedAt,
      ...(situationId ? { situationId } : {}),
      sources: [source],
    }),
    "source-fixture",
    recordedAt,
  );
  const execution = f.repository.formation.startWork(
    work.workId,
    "source-fixture",
    undefined,
    recordedAt,
  )!;
  f.repository.formation.finish(execution, { changes: [] }, recordedAt);
}

describe("consolidation raw user source support", () => {
  it("persists the observed bounded account without requiring missing PFC labels", async () => {
    const f = fixture();
    f.setTime("2026-03-23T10:00:00.000Z");
    new PersonaRepository(f.database).initialize(f.clock.now());
    for (const source of observedSources)
      recordSourceWork(
        f,
        source,
        source.id === "f5a9a5d2-9e08-4cf8-af6d-f6f24c26c0a3"
          ? "9082198c-f0a3-4c3b-aa3d-5113e726c747"
          : undefined,
      );
    for (const item of observedEvidence) putObserved(f, item);
    putObserved(f, observedExisting);
    await f.memory.indexPending();
    f.repository.learning.enqueue(observedEvidence[0]!.memoryId, f.clock.now());
    f.consolidate.mockImplementation((input) => {
      expect(input.evidence).toHaveLength(5);
      expect(
        new Map(
          input.support.map(({ revisionId, sourceCount }) => [
            revisionId,
            sourceCount,
          ]),
        ),
      ).toEqual(
        new Map(
          observedEvidence.map((item) => [
            item.revisionId,
            item.basis === "explicit_user_statement" ? 1 : 0,
          ]),
        ),
      );
      for (const prior of observedEvidence) {
        const actual = input.evidence.find(
          ({ revisionId }) => revisionId === prior.revisionId,
        )!;
        expect(actual).toMatchObject({
          memoryId: prior.memoryId,
          content: prior.content,
          semantics: prior.semantics,
          sourceRefs: prior.sourceRefs,
        });
      }
      expect(input.existing).toMatchObject({
        revisionId: observedExisting.revisionId,
        content: observedExisting.content,
        derivation: observedExisting.derivation,
      });
      return Promise.resolve(observedOutput);
    });
    const onError = vi.fn();
    const completed = await f.memory.consolidatePending(undefined, onError);
    expect(onError.mock.calls).toEqual([]);
    expect(completed).toBe(1);
    expect(f.consolidate).toHaveBeenCalledTimes(1);
    const current = f.repository.learning.derivedTarget(
      observedEvidence.map(({ memoryId }) => memoryId),
      "character",
      observedExisting.personaId,
      f.clock.now(),
    )!;
    const reopened = f.reopen();
    const stored = reopened.recall.evidence(
      [current.revisionId],
      f.clock.now(),
    )[0]!;
    expect(stored.content).toBe(observedOutput.content);
    expect(
      stored.derivation?.dependencies
        .map(({ revisionId }) => revisionId)
        .sort(),
    ).toEqual([...observedOutput.dependencies].sort());
    expect(stored.semantics?.qualifiers["account"]).toBe("bounded_pattern");
    expect(
      stored.sourceRefs
        .flatMap(({ sourceId, spans }) =>
          (spans ?? []).map(({ quote }) => ({ sourceId, quote })),
        )
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    ).toEqual(
      observedOutput.citations
        .map(({ sourceId, quote }) => ({ sourceId, quote }))
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    );
    expect(
      reopened.learning.support(
        observedOutput.dependencies,
        f.clock.now(),
        observedOutput.citations.map(({ sourceId }) => sourceId),
      ),
    ).toEqual({ sourceCount: 3, distinctUserDays: 3, distinctContexts: 1 });
  });

  it("allows distinct same-day sources while preserving their actual scope and citations", async () => {
    const f = fixture();
    const first = await f.seed(
      "上午等维修报价时，先列清能自己检查的项目让我轻松些，仅限这次等报价。",
    );
    const second = await f.seed(
      "下午等场地确认时，先分开自己能准备与要等确认的事项也有帮助，不代表所有时候都想列清单。",
    );
    const original = f.consolidate.getMockImplementation()!;
    f.consolidate.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      account: "bounded_pattern",
    }));
    expect(await f.memory.consolidatePending()).toBeGreaterThan(0);
    const ids = [first, second].flatMap(({ result }) =>
      result.changes.map(({ revisionId }) => revisionId),
    );
    expect(f.repository.learning.support(ids)).toEqual({
      sourceCount: 2,
      distinctUserDays: 1,
      distinctContexts: 2,
    });
    for (const [input] of f.consolidate.mock.calls)
      expect(input.support.map(({ sourceCount }) => sourceCount)).toEqual([
        1, 1,
      ]);
    const target = f.repository.learning.derivedTarget(
      [first.result.changes[0]!.memoryId],
      "user",
      undefined,
      f.clock.now(),
    )!;
    expect(
      f.repository.recall
        .evidence([target.revisionId], f.clock.now())[0]!
        .sourceRefs.map(({ sourceId }) => sourceId)
        .sort(),
    ).toEqual([first.source.id, second.source.id].sort());
  });

  it("deduplicates one source across revisions, all work labels and later-day reuse before rejecting a forced pattern", async () => {
    const f = fixture();
    const originalForm = f.form.getMockImplementation()!;
    f.form.mockImplementation(async (...args) => {
      const batch = await originalForm(...args);
      const unit = batch.units[0]!;
      return {
        entities: [],
        units: [
          { ...unit, content: "这次等回复时先收拾桌面有帮助" },
          { ...unit, content: "这次等待只需要轻声陪着" },
        ],
      };
    });
    const seeded = await f.seed(
      "这次等回复时先收拾桌面有帮助；这次等待只需要轻声陪着",
      randomUUID(),
    );
    expect(seeded.result.changes).toHaveLength(2);
    const ids = seeded.result.changes.map(({ revisionId }) => revisionId);
    for (let i = 0; i < 9; i++)
      recordSourceWork(
        f,
        seeded.source,
        randomUUID(),
        "2026-02-05T12:00:00.000Z",
      );
    f.setTime("2026-02-05T12:00:00.000Z");
    expect(f.repository.learning.support(ids)).toEqual({
      sourceCount: 1,
      distinctUserDays: 1,
      distinctContexts: 10,
    });
    expect(f.repository.learning.support(ids, undefined, [])).toEqual({
      sourceCount: 0,
      distinctUserDays: 0,
      distinctContexts: 0,
    });
    expect(
      f.repository.learning.support(ids, undefined, [
        seeded.source.id,
        seeded.source.id,
      ]),
    ).toEqual(f.repository.learning.support(ids));
    expect(
      f.repository.learning.support(ids, "2025-12-31T23:59:59.000Z"),
    ).toEqual({ sourceCount: 0, distinctUserDays: 0, distinctContexts: 0 });
    const original = f.consolidate.getMockImplementation()!;
    f.consolidate.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      account: "bounded_pattern",
    }));
    const onError = vi.fn();
    expect(await f.memory.consolidatePending(undefined, onError)).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "A bounded pattern requires at least two cited original user sources",
      }),
    );
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_revision_semantics WHERE kind='reflection'",
        )
        .get(),
    ).toEqual({ n: 0 });
    // An episode summary remains legal. Read-cost must include the two-digit
    // context projection from the same query, not a one-row hash-selected label.
    f.consolidate.mockImplementation(original);
    f.repository.learning.retry(f.clock.now());
    expect(await f.memory.consolidatePending()).toBeGreaterThan(0);
    const target = f.repository.learning.derivedTarget(
      seeded.result.changes.map(({ memoryId }) => memoryId),
      "user",
      undefined,
      f.clock.now(),
    )!;
    const evidence = f.repository.recall.evidence(
      [target.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence.derivation?.distinctContexts).toBe(10);
    const qualifiers = f.database
      .prepare(
        "SELECT qualifiers_json AS value FROM memory_revision_semantics WHERE revision_id=?",
      )
      .get(target.revisionId) as { value: string };
    const expectedBytes =
      Buffer.byteLength(qualifiers.value) +
      evidence.derivation!.dependencies.reduce(
        (sum, dep) =>
          sum + Buffer.byteLength(dep.memoryId + dep.revisionId + dep.use),
        0,
      ) +
      Buffer.byteLength("1101");
    expect(
      f.repository.learning.derivationReadCost(
        target.revisionId,
        f.clock.now(),
      ),
    ).toEqual({
      rawValueBytes: expectedBytes,
      rowCount: evidence.derivation!.dependencies.length + 2,
    });
  });

  it.each(["assistant-only", "one-user-only", "context-only"] as const)(
    "counts only actual citations for %s despite uncited user source links",
    async (mode) => {
      const f = fixture();
      const first = await f.seed("第一次等待时我只想要轻声陪伴。");
      f.setTime("2026-01-02T12:00:00.000Z");
      const second = await f.seed("第二次等待时我也只想要轻声陪伴。");
      const refs = [first, second].map(({ result }) => result.changes[0]!);
      const assistants = refs.map((ref, index) => {
        const source: MemoryFormationSource = {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "assistant",
          occurredAt: f.clock.now(),
          content: `我听到了第${index + 1}次的说法。`,
        };
        recordSourceWork(f, source, randomUUID());
        f.repository.attachEvidence(ref.revisionId, [
          f.repository.formation.sourceProvenance(source.id),
        ]);
        f.repository.recall.addSpan(
          ref.revisionId,
          source.id,
          0,
          source.content.length,
          source.content,
        );
        let citedSource = source;
        if (mode === "context-only") {
          citedSource = {
            ...source,
            id: randomUUID(),
            referenceId: randomUUID(),
            speaker: "user",
            content: `仅作背景的第${index + 1}条用户说法。`,
          };
          const work = f.repository.formation.enqueue(
            formationIntake({
              id: randomUUID(),
              version: "v1",
              recordedAt: f.clock.now(),
              sources: [source, citedSource],
              evidenceSourceIds: [source.id],
            }),
            "source-fixture",
            f.clock.now(),
          );
          const execution = f.repository.formation.startWork(
            work.workId,
            "source-fixture",
            undefined,
            f.clock.now(),
          )!;
          f.repository.formation.finish(
            execution,
            { changes: [] },
            f.clock.now(),
          );
          f.repository.attachEvidence(ref.revisionId, [
            f.repository.formation.sourceProvenance(citedSource.id),
          ]);
          f.repository.recall.addSpan(
            ref.revisionId,
            citedSource.id,
            0,
            citedSource.content.length,
            citedSource.content,
          );
        }
        // This raw user primary is linked but has no persisted citation span.
        // Whole-revision metadata includes it; this request cannot cite it.
        const unquoted: MemoryFormationSource = {
          ...source,
          id: randomUUID(),
          referenceId: randomUUID(),
          speaker: "user",
          content: "只链接了来源，尚没有可引用片段。",
        };
        recordSourceWork(f, unquoted, randomUUID());
        f.repository.attachEvidence(ref.revisionId, [
          f.repository.formation.sourceProvenance(unquoted.id),
        ]);
        f.repository.learning.enqueue(ref.memoryId, f.clock.now());
        return citedSource;
      });
      expect(
        f.repository.learning.support(refs.map(({ revisionId }) => revisionId))
          .sourceCount,
      ).toBe(4);
      expect(
        f.repository.learning.support(
          refs.map(({ revisionId }) => revisionId),
          undefined,
          assistants.map(({ id }) => id),
        ).sourceCount,
      ).toBe(0);
      f.consolidate.mockImplementation(({ evidence, support }) => {
        expect(support.map(({ sourceCount }) => sourceCount)).toEqual([1, 1]);
        return Promise.resolve({
          disposition: "consolidate",
          reason: "Injected structural rejection",
          content: "不能用没有引用的用户来源凑足支持。",
          account: "bounded_pattern",
          dependencies: evidence.map(({ revisionId }) => revisionId),
          citations: evidence.map((item) => {
            const source =
              mode === "one-user-only" &&
              item.revisionId === refs[0]!.revisionId
                ? first.source
                : assistants[
                    refs.findIndex(
                      ({ revisionId }) => revisionId === item.revisionId,
                    )
                  ]!;
            return {
              revisionId: item.revisionId,
              sourceId: source.id,
              quote: source.content,
            };
          }),
        });
      });
      const onError = vi.fn();
      expect(await f.memory.consolidatePending(undefined, onError)).toBe(0);
      expect(f.consolidate).toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "A bounded pattern requires at least two cited original user sources",
        }),
      );
      expect(
        f.database
          .prepare(
            "SELECT COUNT(*) AS n FROM memory_revision_semantics WHERE kind='reflection'",
          )
          .get(),
      ).toEqual({ n: 0 });
    },
  );
});

describe("source batch retrieval preserves each consolidation question", () => {
  function splitNext(f: ReturnType<typeof fixture>) {
    const original = f.form.getMockImplementation()!;
    f.form.mockImplementation(async (input, execution, signal) => {
      const batch = await original(input, execution, signal);
      const first = batch.units[0]!;
      if (first.operation !== "create") throw new Error("Expected new fixture");
      return {
        entities: batch.entities,
        units: first.content.split("；").map((content) => ({
          ...first,
          content,
          citations: [
            { sourceId: input.episode.sources[0]!.id, quote: content },
          ],
        })),
      };
    });
  }

  it("shares one actual selector for two source statements without forcing them into one meaning", async () => {
    const f = fixture();
    splitNext(f);
    await f.seed("早餐想吃清淡粥；周末需要整理书柜");
    f.select.mockClear();
    f.select.mockImplementation(({ plan, candidates }) =>
      Promise.resolve({
        selected: candidates
          .map((candidate) => ({
            revisionId: candidate.revisionId,
            questionIds: plan.questions
              .filter(({ text }) => text.includes(candidate.content))
              .map(({ id }) => id),
          }))
          .filter(({ questionIds }) => questionIds.length),
        coverage: plan.questions.map(({ id, text }) => ({
          questionId: id,
          status: "supported",
          revisionIds: candidates
            .filter(({ content }) => text.includes(content))
            .map(({ revisionId }) => revisionId),
        })),
      }),
    );
    expect(await f.memory.consolidatePending()).toBe(0);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.select.mock.calls[0]![0].plan.questions).toHaveLength(2);
    expect(f.consolidate).not.toHaveBeenCalled();
    expect([...f.repository.learning.pending()]).toEqual([]);
  });

  it("does not treat two independent episodes with the same user as one source batch", async () => {
    const f = fixture();
    await f.seed("写简历时没有歌词的音乐让我不易分心。");
    await f.seed("散步时我喜欢跟着有歌词的歌曲唱。");
    f.select.mockClear();
    await f.memory.consolidatePending();
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(
      f.select.mock.calls.every(([input]) => input.plan.questions.length === 1),
    ).toBe(true);
    expect(f.consolidate).toHaveBeenCalled();
    expect(f.consolidate.mock.calls[0]![0].evidence).toHaveLength(2);
  });

  it("keeps all untouched source members pending after a cancelled shared selector", async () => {
    const f = fixture();
    splitNext(f);
    await f.seed("厨房先擦灶台；阳台上的旧架子保留");
    const controller = new AbortController();
    f.select.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new Error("interrupted shared retrieval"));
    });
    await expect(
      f.memory.consolidatePending(controller.signal),
    ).rejects.toThrow();
    const work = f.database
      .prepare(
        "SELECT status,attempt FROM memory_work WHERE kind='reconcile' ORDER BY attempt",
      )
      .all();
    expect(work).toEqual([
      { status: "pending", attempt: 0 },
      { status: "pending", attempt: 1 },
    ]);
    expect(f.repository.listRecords({})).toHaveLength(2);
    await f.memory.consolidatePending();
    expect([...f.repository.learning.pending()]).toEqual([]);
  });

  it("publishes a committed first member before a later member is cancelled", async () => {
    const f = fixture();
    splitNext(f);
    await f.seed("今天先完成封面；下次继续做卡片");
    const controller = new AbortController();
    const changed = vi.fn();
    f.memory.setChangedListener(changed);
    const original = f.consolidate.getMockImplementation()!;
    let calls = 0;
    f.consolidate.mockImplementation((...input) => {
      if (++calls === 2) {
        controller.abort();
        return Promise.reject(new Error("yield after first actual commit"));
      }
      return original(...input);
    });
    await expect(
      f.memory.consolidatePending(controller.signal),
    ).rejects.toThrow();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      f.repository.requireDetail(changed.mock.calls[0]![0] as string).memory
        .type,
    ).toBe("agent_learning");
    expect(f.repository.listRecords({})).toHaveLength(3);
    expect([...f.repository.learning.pending()]).toHaveLength(1);
    await f.memory.consolidatePending();
    expect(f.repository.listRecords({})).toHaveLength(3);
    expect([...f.repository.learning.pending()]).toEqual([]);
  });

  it("partitions one source batch by actual user and persona ownership", async () => {
    const f = fixture();
    const personas = new PersonaRepository(f.database);
    personas.initialize(f.clock.now());
    const personaId = personas.getLibrary().activePersonaId;
    const source: MemoryFormationSource = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat",
      speaker: "user",
      occurredAt: f.clock.now(),
      content: "我喜欢清淡早餐；和你聊天时先听我说完",
    };
    f.form.mockImplementation(() =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: "create",
            type: "preference",
            content: "我喜欢清淡早餐",
            semantics: {
              kind: "claim",
              owner: "user",
              basis: "explicit_user_statement",
              qualifiers: {},
            },
            entityKeys: [],
            citations: [{ sourceId: source.id, quote: "我喜欢清淡早餐" }],
            links: [],
          },
          {
            operation: "create",
            type: "preference",
            content: "和你聊天时先听我说完",
            semantics: {
              kind: "claim",
              owner: "character",
              personaId,
              basis: "explicit_user_statement",
              qualifiers: {},
            },
            entityKeys: [],
            citations: [{ sourceId: source.id, quote: "和你聊天时先听我说完" }],
            links: [],
          },
        ],
      }),
    );
    const work = f.memory.enqueueEpisode(
      formationIntake({
        id: randomUUID(),
        version: "v1",
        recordedAt: f.clock.now(),
        personaId,
        sources: [source],
      }),
    );
    await f.memory.formEpisode(work.workId);
    await f.memory.indexPending();
    f.select.mockClear();
    await f.memory.consolidatePending();
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(
      new Set(f.select.mock.calls.map(([input]) => input.plan.owner)),
    ).toEqual(new Set(["user", "character"]));
    expect(
      f.select.mock.calls.every(([input]) => input.plan.questions.length === 1),
    ).toBe(true);
    expect(f.consolidate).not.toHaveBeenCalled();
  });

  it("moves a supported current revision to its actual newer formation batch", async () => {
    const f = fixture();
    splitNext(f);
    const first = await f.seed("早餐想吃清淡粥；周末需要整理书柜");
    const revision = first.result.changes[0]!;
    // Give the repeated primary its exact actual source quotation.
    f.form.mockImplementation(({ episode }) =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: "support",
            targetRevisionId: revision.revisionId,
            citations: [
              {
                sourceId: episode.sources[0]!.id,
                quote: episode.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      }),
    );
    f.setTime("2026-01-02T12:00:00.000Z");
    await f.seed("早餐仍然想吃清淡粥。", randomUUID(), [
      {
        memoryId: revision.memoryId,
        revisionId: revision.revisionId,
        use: "current",
      },
    ]);
    f.select.mockClear();
    await f.memory.consolidatePending();
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(
      f.select.mock.calls.every(([input]) => input.plan.questions.length === 1),
    ).toBe(true);
  });
});
