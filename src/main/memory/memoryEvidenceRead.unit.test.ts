import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryDetail, MemorySource } from "../../shared/contracts/memory";
import type {
  MemoryEvidenceReference,
  MemoryEvidenceResolution,
  MemoryRevisionSemantics,
} from "../../shared/contracts/memoryRecall";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { MemoryEvidenceItemSchema } from "../../shared/schemas/memoryRecall";
import { parseSchema } from "../../shared/schemas/validation";
import { openApplicationDatabase } from "../db/database";
import { PersonaRepository } from "../persona/personaRepository";
import { MEMORY_CONSOLIDATION_VERSION } from "./memoryLearningRepository";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

const reference = (
  detail: MemoryDetail,
  use: MemoryEvidenceReference["use"] = "current",
): MemoryEvidenceReference => ({
  memoryId: detail.memory.id,
  revisionId: detail.memory.currentRevisionId,
  use,
});

function resolved(result: MemoryEvidenceResolution) {
  expect(result.status).toBe("resolved");
  if (result.status !== "resolved")
    throw new Error(`Unexpected ${result.status}`);
  return result;
}

/** Observe actual driver return values, independently of the cost SQL. */
function observeSqlRows(database: Database.Database) {
  const prepare = database.prepare.bind(database);
  const rows: Record<string, unknown>[] = [];
  const spy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    vi.spyOn(statement, "all").mockImplementation(
      (...parameters: unknown[]) => {
        const result = all(...parameters);
        rows.push(...(result as Record<string, unknown>[]));
        return result;
      },
    );
    vi.spyOn(statement, "get").mockImplementation(
      (...parameters: unknown[]) => {
        const result = get(...parameters);
        if (result !== undefined) rows.push(result as Record<string, unknown>);
        return result;
      },
    );
    return statement;
  });
  return { rows, stop: () => spy.mockRestore() };
}

function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "memory-evidence-read-"),
  );
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = "2026-09-15T12:00:00.000Z";
  const clock = { now: () => now };
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const personaId = personas.getLibrary().activePersonaId;
  const otherPersonaId = randomUUID();
  personas.insertCustom({
    createdAt: now,
    snapshot: {
      ...personas.getActiveSnapshot(),
      personaId: otherPersonaId,
    },
  });
  const repository = new MemoryRepository(database);
  const retrieval = { search: vi.fn(() => []) };
  // These public reads must work without model or embedding configuration.
  const service = new MemoryService(
    repository,
    retrieval,
    new CryptoIdGenerator(),
    clock,
  );
  const create = (
    content = "用户喜欢清淡的饭菜。",
    semantics: Partial<MemoryRevisionSemantics> = {},
    sources: MemorySource[] = [],
  ) => {
    const detail = repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content,
      type: "preference",
      confidence: 1,
      importance: 0.5,
      reason: "fixture",
      now,
      sources,
    });
    repository.recall.putSemantics(
      detail.memory.currentRevisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
        ...semantics,
      },
      [],
    );
    return detail;
  };
  const revise = (
    detail: MemoryDetail,
    semantics: Partial<MemoryRevisionSemantics> = {},
  ) => {
    const next = repository.revise({
      memoryId: detail.memory.id,
      predecessorRevisionId: repository.requireDetail(detail.memory.id).memory
        .currentRevisionId,
      priorDispositions: [
        {
          revisionId: repository.requireDetail(detail.memory.id).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: "用户现在喜欢温咖啡。",
      reason: "用户改口",
      now,
      sources: [],
    });
    repository.recall.putSemantics(
      next.memory.currentRevisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
        ...semantics,
      },
      [],
    );
    return next;
  };
  return {
    database,
    repository,
    service,
    retrieval,
    personaId,
    otherPersonaId,
    create,
    revise,
    clock,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe("exact Memory evidence reads", () => {
  it("checks the actual memory/revision pair and persona without a search or model", () => {
    const f = fixture();
    const global = f.create();
    const own = f.create("只对本角色的回应方式。", {
      owner: "character",
      personaId: f.personaId,
    });
    const foreign = f.create("另一个角色的回应方式。", {
      owner: "character",
      personaId: f.otherPersonaId,
    });
    const wrongPair = { ...reference(global), memoryId: own.memory.id };
    const refs = [
      reference(global),
      reference(own),
      reference(foreign),
      wrongPair,
    ];
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: refs,
      }),
    ).toEqual([refs[2], wrongPair]);
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    const result = f.service.resolveEvidence({
      personaId: f.personaId,
      references: refs,
      resourceBudget: { maxReadBytes: 4000 },
    });
    expect(result).toEqual({
      status: "unavailable",
      unavailable: [refs[2], wrongPair],
    });
    expect(evidence).not.toHaveBeenCalled();
    const complete = resolved(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: refs.slice(0, 2),
        resourceBudget: { maxReadBytes: 4000 },
      }),
    );
    expect(complete.items.map(({ revisionId }) => revisionId)).toEqual(
      refs.slice(0, 2).map(({ revisionId }) => revisionId),
    );
    expect(f.retrieval.search).not.toHaveBeenCalled();
  });

  it("keeps exact historical revisions while current references cannot use history flags to bypass revision freshness", () => {
    const f = fixture();
    const old = f.create("用户以前喜欢冰咖啡。", {
      validFrom: "2026-09-01T00:00:00.000Z",
    });
    f.setNow("2026-09-16T12:00:00.000Z");
    const next = f.revise(old);
    const currentOld = reference(old),
      historyOld = reference(old, "history");
    const request = {
      personaId: f.personaId,
      references: [currentOld, historyOld, reference(next)],
      retrieval: { timeScope: { includeSuperseded: true } },
    };
    expect(f.service.validateEvidenceReferences(request)).toEqual([currentOld]);
    expect(
      f.service.resolveEvidence({
        ...request,
        resourceBudget: { maxReadBytes: 4000 },
      }),
    ).toEqual({ status: "unavailable", unavailable: [currentOld] });
    const result = resolved(
      f.service.resolveEvidence({
        ...request,
        references: [historyOld, reference(next)],
        resourceBudget: { maxReadBytes: 4000 },
      }),
    );
    expect(
      result.items.map(({ revisionId, current }) => [revisionId, current]),
    ).toEqual([
      [historyOld.revisionId, false],
      [next.memory.currentRevisionId, true],
    ]);
    expect(
      f.service.validateEvidenceReferences({
        ...request,
        retrieval: { timeScope: { knownAt: "2026-09-15T18:00:00.000Z" } },
      }),
    ).toEqual([currentOld, reference(next)]);
  });

  it("intersects explicit historical validity with current validity at the real read time", () => {
    const f = fixture();
    const expired = f.create("那时的计划。", {
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-09-14T00:00:00.000Z",
    });
    const refs = [reference(expired), reference(expired, "history")];
    const request = {
      personaId: f.personaId,
      references: refs,
      retrieval: {
        timeScope: {
          validAt: "2026-09-10T00:00:00.000Z",
          includeSuperseded: true,
        },
      },
    };
    expect(f.service.validateEvidenceReferences(request)).toEqual([refs[0]]);
    expect(
      f.service.resolveEvidence({
        ...request,
        resourceBudget: { maxReadBytes: 3000 },
      }),
    ).toEqual({ status: "unavailable", unavailable: [refs[0]] });
    const result = resolved(
      f.service.resolveEvidence({
        ...request,
        references: [refs[1]!],
        resourceBudget: { maxReadBytes: 3000 },
      }),
    );
    expect(result.items[0]?.current).toBe(false);
    const future = f.create("未来才有效的规则。", {
      validFrom: "2026-09-20T00:00:00.000Z",
    });
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: [reference(future)],
        retrieval: { timeScope: { validAt: "2026-09-21T00:00:00.000Z" } },
      }),
    ).toEqual([reference(future)]);
  });

  it("respects occurrence ranges and does not let knownAt reveal a later revision", () => {
    const f = fixture();
    const item = f.create("五月的旅行。", {
      occurredFrom: "2026-05-01T00:00:00.000Z",
      occurredTo: "2026-05-03T00:00:00.000Z",
    });
    const request = {
      personaId: f.personaId,
      references: [reference(item, "history")],
    };
    expect(
      f.service.validateEvidenceReferences({
        ...request,
        retrieval: { timeScope: { occurredFrom: "2026-06-01T00:00:00.000Z" } },
      }),
    ).toEqual(request.references);
    expect(
      f.service.validateEvidenceReferences({
        ...request,
        retrieval: { timeScope: { occurredTo: "2026-05-02T00:00:00.000Z" } },
      }),
    ).toEqual([]);
    expect(
      f.service.validateEvidenceReferences({
        ...request,
        retrieval: { timeScope: { knownAt: "2026-09-14T00:00:00.000Z" } },
      }),
    ).toEqual(request.references);
  });

  it("does not restore archived or deleted records through explicit historical reads", () => {
    const f = fixture();
    const archived = f.create(),
      deleted = f.create(),
      purged = f.create();
    f.repository.archive(archived.memory.id, f.clock.now());
    f.repository.softDelete(deleted.memory.id, f.clock.now());
    f.repository.softDelete(purged.memory.id, f.clock.now());
    f.repository.purge(purged.memory.id);
    const refs = [archived, deleted, purged].flatMap((d) => [
      reference(d),
      reference(d, "history"),
    ]);
    const result = f.service.resolveEvidence({
      personaId: f.personaId,
      references: refs,
      retrieval: { timeScope: { includeSuperseded: true } },
      resourceBudget: { maxReadBytes: 4000 },
    });
    expect(result).toEqual({ status: "unavailable", unavailable: refs });
  });

  it("validates lifecycle using SQL metadata only, without text, semantic payload or provenance materialization", () => {
    const f = fixture();
    const detail = f.create("原文".repeat(20000), {
      qualifiers: { context: "语境".repeat(20000) },
    });
    const prepare = vi.spyOn(f.database, "prepare");
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: [reference(detail)],
      }),
    ).toEqual([]);
    expect(evidence).not.toHaveBeenCalled();
    // Derivation validity compares required source quotations inside SQLite.
    // Only reference metadata crosses the repository boundary into JS.
    for (const result of prepare.mock.results) {
      if (result.type !== "return") continue;
      expect(result.value.columns().map(({ name }) => name)).toEqual(
        expect.arrayContaining(["id"]),
      );
      expect(result.value.columns().map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/content|qualifiers|quote/u),
        ]),
      );
    }
  });

  it("refuses an oversized required set before reading bodies without substituting a later small statement", () => {
    const f = fixture();
    const bigText = f.create("长".repeat(200000));
    const bigSemantic = f.create("小陈述", {
      qualifiers: { context: "大".repeat(200000) },
    });
    const bigPredicate = f.create("另一陈述", { predicate: "p".repeat(5000) });
    const small = f.create("选餐不放辣椒。");
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    const refs = [bigText, bigSemantic, bigPredicate, small].map((d) =>
      reference(d),
    );
    const result = f.service.resolveEvidence({
      personaId: f.personaId,
      references: refs,
      resourceBudget: { maxReadBytes: 2000 },
    });
    expect(result.status).toBe("resource_limit");
    expect(evidence).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("items");
    const smallRead = resolved(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [reference(small)],
        resourceBudget: { maxReadBytes: 2000 },
      }),
    );
    expect(smallRead.items.map(({ content }) => content)).toEqual([
      "选餐不放辣椒。",
    ]);
  });

  it("bounds expanded entity metadata before materializing the item", () => {
    const f = fixture();
    const detail = f.create();
    for (let index = 0; index < 100; index += 1) {
      const id = randomUUID();
      f.repository.recall.putEntity(
        { id, name: `实体 ${index}`, kind: "topic", aliases: [] },
        f.clock.now(),
      );
      f.database
        .prepare(
          "INSERT INTO memory_revision_entities(revision_id,entity_id,role) VALUES(?,?,?)",
        )
        .run(detail.memory.currentRevisionId, id, "mentioned");
    }
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    const ref = reference(detail);
    const result = f.service.resolveEvidence({
      personaId: f.personaId,
      references: [ref],
      resourceBudget: { maxReadBytes: 2000 },
    });
    expect(result.status).toBe("resource_limit");
    expect(evidence).not.toHaveBeenCalled();
  });

  it("keeps exact source spans and semantics while avoiding unused editing reasons and source labels", () => {
    const f = fixture();
    const source: MemorySource = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat",
      createdAt: f.clock.now(),
      label: "大标签".repeat(100000),
    };
    const detail = f.create(
      "用户希望先听结论。",
      {
        predicate: "prefers",
        objectValue: "先听结论",
        qualifiers: { context: "仅限技术讨论" },
      },
      [source],
    );
    f.database
      .prepare("UPDATE memory_revisions SET reason=? WHERE id=?")
      .run("巨大编辑原因".repeat(100000), detail.memory.currentRevisionId);
    f.repository.recall.addSpan(
      detail.memory.currentRevisionId,
      source.id,
      5,
      10,
      "先听结论。",
    );
    const hits = vi.spyOn(f.repository, "hitsFor");
    const result = resolved(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [reference(detail)],
        resourceBudget: { maxReadBytes: 4000 },
      }),
    );
    expect(hits).not.toHaveBeenCalled();
    expect(result.items[0]?.semantics?.qualifiers).toEqual({
      context: "仅限技术讨论",
    });
    expect(result.items[0]?.sourceRefs).toEqual([
      {
        sourceId: source.id,
        referenceId: source.referenceId,
        type: "chat",
        spans: [{ start: 5, end: 10, quote: "先听结论。" }],
      },
    ]);
    expect(result.items[0]).toEqual(
      parseSchema(MemoryEvidenceItemSchema, result.items[0]),
    );
    expect(result.readCost.rawValueBytes).toBeLessThan(4000);
    f.database
      .prepare("UPDATE memory_sources SET label=NULL WHERE id=?")
      .run(source.id);
    f.database
      .prepare("UPDATE memory_revisions SET reason='short' WHERE id=?")
      .run(detail.memory.currentRevisionId);
    f.create("无关的未选全文".repeat(10000), {
      qualifiers: { unused: "x".repeat(10000) },
    });
    expect(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [reference(detail)],
        resourceBudget: { maxReadBytes: 4000 },
      }),
    ).toEqual(result);
  });

  it("reads every saved source and span or reports a resource limit without token fitting", () => {
    const f = fixture();
    const sources: MemorySource[] = Array.from({ length: 60 }, () => ({
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat",
      createdAt: f.clock.now(),
    }));
    const detail = f.create("这条完整偏好不能被截成半句话。", {}, sources);
    for (const source of sources)
      f.repository.recall.addSpan(
        detail.memory.currentRevisionId,
        source.id,
        0,
        60,
        "长引文".repeat(20),
      );
    const result = f.service.resolveEvidence({
      personaId: f.personaId,
      references: [reference(detail)],
      resourceBudget: { maxReadBytes: 1300 },
    });
    expect(result.status).toBe("resource_limit");
    if (result.status !== "resource_limit")
      throw new Error("Expected resource limit");
    const complete = resolved(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [reference(detail)],
        resourceBudget: { maxReadBytes: result.readCost.rawValueBytes },
      }),
    );
    expect(complete.items[0]?.content).toBe("这条完整偏好不能被截成半句话。");
    expect(complete.items[0]?.sourceCount).toBe(60);
    expect(complete.items[0]?.sourceRefs).toHaveLength(60);
    expect(
      complete.items[0]?.sourceRefs.every(
        (source) =>
          source.spans?.length === 1 &&
          source.spans[0]?.quote === "长引文".repeat(20),
      ),
    ).toBe(true);
    expect(complete.readCost).toEqual(result.readCost);
    expect(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [reference(detail)],
        resourceBudget: { maxReadBytes: result.readCost.rawValueBytes - 1 },
      }),
    ).toEqual(result);
  });

  it("distinguishes a read resource limit from unavailable references and rejects invalid resource values", () => {
    const f = fixture();
    const detail = f.create(),
      ref = reference(detail);
    expect(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [ref],
        resourceBudget: { maxReadBytes: 1 },
      }),
    ).toEqual({
      status: "resource_limit",
      readCost: f.repository.recall.evidenceReadCost(
        [ref.revisionId],
        f.clock.now(),
      ),
    });
    expect(() =>
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [ref],
        resourceBudget: { maxReadBytes: NaN },
      }),
    ).toThrow("positive integer");
  });

  it("preserves request order, deduplicates item projection, and does not record retrieval exposure for qualification reads", () => {
    const f = fixture();
    const a = f.create("第一项"),
      b = f.create("第二项");
    const refs = [reference(b), reference(a), reference(b, "history")];
    const result = resolved(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: refs,
        resourceBudget: { maxReadBytes: 4000 },
      }),
    );
    expect(result.items.map(({ memoryId }) => memoryId)).toEqual([
      b.memory.id,
      a.memory.id,
    ]);
    expect(f.repository.requireDetail(a.memory.id).usages).toEqual([]);
    expect(f.repository.requireDetail(b.memory.id).usages).toEqual([]);
  });

  it("revalidates an expired or corrected reference at a later allocation boundary", () => {
    const f = fixture();
    const detail = f.create("明天前有效。", {
      validTo: "2026-09-16T00:00:00.000Z",
    });
    const request = { personaId: f.personaId, references: [reference(detail)] };
    expect(f.service.validateEvidenceReferences(request)).toEqual([]);
    f.setNow("2026-09-16T00:00:00.000Z");
    expect(f.service.validateEvidenceReferences(request)).toEqual(
      request.references,
    );
    const updated = f.revise(detail);
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: [reference(updated)],
      }),
    ).toEqual([]);
    expect(f.service.validateEvidenceReferences(request)).toEqual(
      request.references,
    );
  });
  it("uses each revision's own scope for an old global preference and a later character-scoped revision", () => {
    const f = fixture();
    const global = f.create("原先对所有伙伴的一般偏好。");
    f.setNow("2026-09-16T12:00:00.000Z");
    const local = f.revise(global, {
      owner: "character",
      personaId: f.personaId,
    });
    const old = reference(global, "history"),
      current = reference(local);
    const request = { personaId: f.otherPersonaId, references: [old, current] };
    expect(f.service.validateEvidenceReferences(request)).toEqual([current]);
    const fullRequest = {
      ...request,
      retrieval: { timeScope: { knownAt: "2026-09-15T18:00:00.000Z" } },
      resourceBudget: { maxReadBytes: 3000 },
    };
    expect(f.service.resolveEvidence(fullRequest)).toEqual({
      status: "unavailable",
      unavailable: [current],
    });
    const result = resolved(
      f.service.resolveEvidence({ ...fullRequest, references: [old] }),
    );
    expect(result.items[0]).toMatchObject({
      revisionId: old.revisionId,
      owner: "user",
      current: false,
      content: "原先对所有伙伴的一般偏好。",
    });
  });

  it("returns an empty complete set without a query or any token-budget fields", () => {
    const f = fixture();
    const prepare = vi.spyOn(f.database, "prepare");
    expect(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [],
        resourceBudget: { maxReadBytes: 1 },
      }),
    ).toEqual({
      status: "resolved",
      items: [],
      readCost: { rawValueBytes: 0, rowCount: 0 },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps qualification, cost and complete materialization in the same synchronous transaction", () => {
    const f = fixture();
    const detail = f.create();
    const order: string[] = [];
    const owner = f.repository.recall;
    const validate = owner.validateEvidenceReferences.bind(owner);
    const cost = owner.evidenceReadCost.bind(owner);
    const read = owner.evidence.bind(owner);
    vi.spyOn(owner, "validateEvidenceReferences").mockImplementation(
      (request, now) => {
        expect(f.database.inTransaction).toBe(true);
        order.push("qualify");
        return validate(request, now);
      },
    );
    vi.spyOn(owner, "evidenceReadCost").mockImplementation((ids, now) => {
      expect(f.database.inTransaction).toBe(true);
      order.push("cost");
      return cost(ids, now);
    });
    vi.spyOn(owner, "evidence").mockImplementation((ids, now, projection) => {
      expect(f.database.inTransaction).toBe(true);
      expect(projection).toBeUndefined();
      order.push("read");
      return read(ids, now, projection);
    });
    f.database.transaction(() => {
      resolved(
        f.service.resolveEvidence({
          personaId: f.personaId,
          references: [reference(detail)],
          resourceBudget: { maxReadBytes: 4000 },
        }),
      );
    })();
    expect(order).toEqual(["qualify", "cost", "read"]);
    expect(f.database.inTransaction).toBe(false);
  });

  it("counts source rows and full quote/qualifier values in SQLite without copying them to JS before a limit", () => {
    const f = fixture();
    const source: MemorySource = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat",
      createdAt: f.clock.now(),
    };
    const quote = '来源标记🌧\n"'.repeat(10000);
    const qualifier = "语义标记\u0000é".repeat(10000);
    const detail = f.create(
      "这条短陈述也有很长的必要依据。",
      { qualifiers: { context: qualifier } },
      [source],
    );
    f.repository.recall.addSpan(
      detail.memory.currentRevisionId,
      source.id,
      0,
      quote.length,
      quote,
    );
    const read = vi.spyOn(f.repository.recall, "evidence");
    const observed = observeSqlRows(f.database);
    const result = f.service.resolveEvidence({
      personaId: f.personaId,
      references: [reference(detail)],
      resourceBudget: { maxReadBytes: 1000 },
    });
    observed.stop();
    expect(result.status).toBe("resource_limit");
    if (result.status !== "resource_limit")
      throw new Error("Expected resource limit");
    expect(result.readCost.rawValueBytes).toBeGreaterThan(
      Buffer.byteLength(quote, "utf8") + Buffer.byteLength(qualifier, "utf8"),
    );
    expect(read).not.toHaveBeenCalled();
    expect(observed.rows.length).toBeGreaterThan(0);
    for (const row of observed.rows) {
      expect(Object.values(row)).not.toContain(quote);
      expect(Object.values(row)).not.toContain(qualifier);
      expect(Object.keys(row)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/content|qualifiers|quote/u),
        ]),
      );
    }
  });

  it("measures every actual projected scalar and row, including complete derivation, relations and discontinuous spans", () => {
    const f = fixture();
    const sources: MemorySource[] = Array.from({ length: 2 }, () => ({
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat",
      createdAt: f.clock.now(),
    }));
    const parents = sources.map((source, index) =>
      f.create(`原事实 ${index}：下雨可以留在屋里。`, {}, [source]),
    );
    const entity = {
      id: randomUUID(),
      name: "只作界面显示的实体名称",
      kind: "topic",
      aliases: [],
    };
    f.repository.recall.putEntity(entity, f.clock.now());
    const summary = f.create(
      "两个场景都允许改变地点，具体原话仍可回看。",
      {
        kind: "reflection",
        basis: "inference",
        subjectEntityId: entity.id,
        predicate: "observed_across",
        objectValue: '场景\n"🙂',
        qualifiers: {
          consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
          consolidationDependencyCount: "2",
          preservedContext: "跨场景\u0000限定",
        },
      },
      sources,
    );
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!,
        parent = parents[index]!;
      for (const span of [
        { start: 0, quote: '前段🌧\n"' },
        { start: 40, quote: "后段é\u0000不可删" },
      ]) {
        for (const revisionId of [
          parent.memory.currentRevisionId,
          summary.memory.currentRevisionId,
        ])
          f.repository.recall.addSpan(
            revisionId,
            source.id,
            span.start,
            span.start + span.quote.length,
            span.quote,
          );
      }
      f.repository.recall.link(
        summary.memory.currentRevisionId,
        parent.memory.currentRevisionId,
        "derived_from",
        source.id,
        "history",
      );
    }
    const refs = [reference(summary), reference(parents[0]!, "history")];
    expect(
      f.service.validateEvidenceReferences({
        personaId: f.personaId,
        references: refs,
      }),
    ).toEqual([]);
    const ids = refs.map(({ revisionId }) => revisionId);
    const expectedCost = f.repository.recall.transaction(() =>
      f.repository.recall.evidenceReadCost(ids, f.clock.now()),
    );
    const observed = observeSqlRows(f.database);
    const items = f.repository.recall.transaction(() =>
      f.repository.recall.evidence(ids, f.clock.now()),
    );
    observed.stop();
    const actualCost = observed.rows.reduce<{
      rawValueBytes: number;
      rowCount: number;
    }>(
      (sum, row) => ({
        rawValueBytes:
          sum.rawValueBytes +
          Object.values(row).reduce<number>((bytes, value) => {
            if (value === null) return bytes;
            if (typeof value !== "string" && typeof value !== "number")
              throw new TypeError("Expected a scalar SQLite projection");
            return bytes + Buffer.byteLength(String(value), "utf8");
          }, 0),
        rowCount: sum.rowCount + 1,
      }),
      { rawValueBytes: 0, rowCount: 0 },
    );
    expect(expectedCost).toEqual(actualCost);
    expect(expectedCost.rowCount).toBeGreaterThan(items.length);
    expect(items[0]?.entityIds).toEqual([entity.id]);
    expect(items[0]?.relations).toHaveLength(2);
    expect(items[0]?.sourceRefs).toHaveLength(2);
    expect(items[0]?.sourceRefs.every(({ spans }) => spans?.length === 2)).toBe(
      true,
    );
    expect(items[0]?.derivation).toMatchObject({
      kind: "consolidation",
      sourceRevisionCount: 2,
    });
    expect(items[0]?.derivation?.dependencies).toEqual(
      expect.arrayContaining(
        parents.map((parent) => reference(parent, "history")),
      ),
    );
    const result = resolved(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: refs,
        resourceBudget: { maxReadBytes: expectedCost.rawValueBytes },
      }),
    );
    expect(result.items).toEqual(items);
    expect(result.readCost).toEqual(expectedCost);
    // Deleting a mandatory supporting source invalidates the unchanged summary;
    // a large read allowance must not convert it into a usable historical fact.
    f.database
      .prepare("DELETE FROM memory_sources WHERE id=?")
      .run(sources[0]!.id);
    const invalidRef = reference(summary, "history");
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    expect(
      f.service.resolveEvidence({
        personaId: f.personaId,
        references: [invalidRef],
        resourceBudget: { maxReadBytes: Number.MAX_SAFE_INTEGER },
      }),
    ).toEqual({ status: "unavailable", unavailable: [invalidRef] });
    expect(evidence).not.toHaveBeenCalled();
  });
});
