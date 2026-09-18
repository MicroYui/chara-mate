import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySource } from "../../shared/contracts/memory";
import type {
  MemoryEvidenceReference,
  MemoryRevisionSemantics,
} from "../../shared/contracts/memoryRecall";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { openApplicationDatabase } from "../db/database";
import { PersonaRepository } from "../persona/personaRepository";
import { MEMORY_CONSOLIDATION_VERSION } from "./memoryLearningRepository";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((close) => close());
});

function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "memory-derived-spans-"),
  );
  const file = path.join(directory, "app.sqlite");
  let database = openApplicationDatabase(file);
  let now = "2026-09-17T12:00:00.000Z";
  const clock = { now: () => now };
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const personaId = personas.getActiveSnapshot().personaId;
  let repository = new MemoryRepository(database);
  const createService = () =>
    new MemoryService(
      repository,
      { search: () => [] },
      new CryptoIdGenerator(),
      clock,
    );
  let service = createService();
  cleanup.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const sources: MemorySource[] = [0, 1].map(() => ({
    id: randomUUID(),
    referenceId: randomUUID(),
    type: "chat",
    createdAt: now,
  }));
  const firstSource = sources[0]!,
    secondSource = sources[1]!;
  const create = (
    content: string,
    inputSources: MemorySource[],
    semantics: Partial<MemoryRevisionSemantics> = {},
  ) => {
    const detail = repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      type: "event",
      content,
      confidence: 1,
      importance: 0.5,
      reason: "source coverage fixture",
      now,
      sources: inputSources,
    });
    repository.recall.putSemantics(
      detail.memory.currentRevisionId,
      {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
        ...semantics,
      },
      [],
    );
    return detail;
  };
  const first = create("雨天留在室内；标签保留 café。", [firstSource]);
  const second = create("周五先确认。", [secondSource]);
  const child = create("雨天在室内准备，周五确认后再处理标签 café。", sources, {
    kind: "reflection",
    basis: "inference",
    qualifiers: {
      consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
      consolidationDependencyCount: "2",
    },
  });
  const firstId = first.memory.currentRevisionId,
    secondId = second.memory.currentRevisionId;
  const childId = child.memory.currentRevisionId;
  const firstSpans = [
    { start: 0, end: 7, quote: "雨天留在室内。" },
    { start: 20, end: 24, quote: "café" },
  ];
  const secondSpan = { start: 0, end: 6, quote: "周五先确认。" };
  for (const span of firstSpans)
    for (const revisionId of [firstId, childId])
      repository.recall.addSpan(
        revisionId,
        firstSource.id,
        span.start,
        span.end,
        span.quote,
      );
  for (const revisionId of [secondId, childId])
    repository.recall.addSpan(
      revisionId,
      secondSource.id,
      secondSpan.start,
      secondSpan.end,
      secondSpan.quote,
    );
  // Extra original evidence is allowed. A child need not claim every parent span.
  repository.recall.addSpan(firstId, firstSource.id, 40, 44, "保留草稿");
  repository.recall.link(
    childId,
    firstId,
    "derived_from",
    firstSource.id,
    "current",
  );
  repository.recall.link(
    childId,
    secondId,
    "derived_from",
    secondSource.id,
    "current",
  );
  const ref: MemoryEvidenceReference = {
    memoryId: child.memory.id,
    revisionId: childId,
    use: "current",
  };
  const request = { personaId, references: [ref] };
  const read = (maxReadBytes = 100_000) =>
    service.resolveEvidence({ ...request, resourceBudget: { maxReadBytes } });
  const reviseFirst = (
    disposition: "retained_history" | "corrected" | "unresolved",
  ) => {
    const previous = repository.requireDetail(first.memory.id).memory
      .currentRevisionId;
    const next = repository.revise({
      memoryId: first.memory.id,
      revisionId: randomUUID(),
      predecessorRevisionId: previous,
      priorDispositions: [{ revisionId: firstId, disposition }],
      content: "后来更换安排。",
      reason: "actual revision fixture",
      now,
      sources: [],
    });
    repository.recall.putSemantics(
      next.memory.currentRevisionId,
      {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    return next;
  };
  const unavailable = () => {
    expect(service.validateEvidenceReferences(request)).toEqual([ref]);
    expect(read()).toEqual({ status: "unavailable", unavailable: [ref] });
    expect(repository.recall.evidence([childId], now)).toEqual([]);
  };
  return {
    get database() {
      return database;
    },
    get repository() {
      return repository;
    },
    get service() {
      return service;
    },
    first,
    second,
    child,
    firstId,
    secondId,
    childId,
    firstSource,
    secondSource,
    firstSpans,
    ref,
    request,
    read,
    unavailable,
    reviseFirst,
    setNow(value: string) {
      now = value;
    },
    clock,
    reopen() {
      database.close();
      database = openApplicationDatabase(file);
      repository = new MemoryRepository(database);
      service = createService();
    },
  };
}

describe("derived Memory exact source-span coverage", () => {
  it("keeps disjoint exact spans, extra parent evidence and full resource cost after disk reopen", () => {
    const f = fixture();
    const first = f.read();
    expect(first.status).toBe("resolved");
    if (first.status !== "resolved")
      throw new Error("Expected full derived record");
    expect(first.items).toHaveLength(1);
    expect(
      first.items[0]?.sourceRefs.flatMap((source) => source.spans ?? []),
    ).toHaveLength(3);
    expect(f.read(first.readCost.rawValueBytes - 1)).toEqual({
      status: "resource_limit",
      readCost: first.readCost,
    });
    f.reopen();
    expect(f.read(first.readCost.rawValueBytes)).toEqual(first);
    expect(f.database.inTransaction).toBe(false);
  });

  it("accepts duplicate matching support from two actually linked parents without requiring all their spans", () => {
    const f = fixture();
    for (const span of f.firstSpans)
      f.repository.recall.addSpan(
        f.secondId,
        f.firstSource.id,
        span.start,
        span.end,
        span.quote,
      );
    f.repository.recall.link(
      f.childId,
      f.secondId,
      "derived_from",
      f.firstSource.id,
      "current",
    );
    f.database
      .prepare(
        `UPDATE memory_revision_semantics SET qualifiers_json=json_set(qualifiers_json,
      '$.consolidationDependencyCount','3') WHERE revision_id=?`,
      )
      .run(f.childId);
    expect(f.read().status).toBe("resolved");
  });

  it.each(["Café", "cafe\u0301", "café "])(
    "rejects a changed quote %j even when another span still supports that link",
    (quote) => {
      const f = fixture();
      f.database
        .prepare(
          "UPDATE memory_revision_source_spans SET quote=? WHERE revision_id=? AND source_id=? AND span_start=20",
        )
        .run(quote, f.childId, f.firstSource.id);
      f.unavailable();
    },
  );

  it.each(["range", "source"] as const)(
    "does not match the same text through the wrong %s",
    (kind) => {
      const f = fixture();
      if (kind === "range")
        f.database
          .prepare(
            `UPDATE memory_revision_source_spans SET span_start=21,span_end=25
      WHERE revision_id=? AND source_id=? AND span_start=20`,
          )
          .run(f.childId, f.firstSource.id);
      else
        f.database
          .prepare(
            `UPDATE memory_revision_source_spans SET source_id=?
      WHERE revision_id=? AND source_id=? AND span_start=20`,
          )
          .run(f.secondSource.id, f.childId, f.firstSource.id);
      f.unavailable();
    },
  );

  it.each(["link", "source", "parent"] as const)(
    "does not revive a derivation after deleting a required %s",
    (kind) => {
      const f = fixture();
      if (kind === "link")
        f.database
          .prepare(
            "DELETE FROM memory_revision_links WHERE from_revision_id=? AND to_revision_id=?",
          )
          .run(f.childId, f.firstId);
      else if (kind === "source")
        f.database
          .prepare("DELETE FROM memory_sources WHERE id=?")
          .run(f.firstSource.id);
      else {
        f.repository.softDelete(f.first.memory.id, f.clock.now());
        f.unavailable();
        f.repository.purge(f.first.memory.id);
      }
      f.unavailable();
      f.reopen();
      f.unavailable();
    },
  );

  it("requires every link to supply a matching span even when other links cover all child evidence", () => {
    const f = fixture();
    f.repository.recall.link(
      f.childId,
      f.firstId,
      "derived_from",
      f.secondSource.id,
      "current",
    );
    f.database
      .prepare(
        `UPDATE memory_revision_semantics SET qualifiers_json=json_set(qualifiers_json,
      '$.consolidationDependencyCount','3') WHERE revision_id=?`,
      )
      .run(f.childId);
    f.unavailable();
  });

  it("keeps parent owner scope and rejects loss of one exact span while that link still has other support", () => {
    const f = fixture();
    f.database
      .prepare(
        "UPDATE memory_revision_semantics SET owner='character',persona_id=? WHERE revision_id=?",
      )
      .run(f.request.personaId, f.firstId);
    f.unavailable();
    f.database
      .prepare(
        "UPDATE memory_revision_semantics SET owner='user',persona_id=NULL WHERE revision_id=?",
      )
      .run(f.firstId);
    expect(f.read().status).toBe("resolved");
    f.database
      .prepare(
        "DELETE FROM memory_revision_source_spans WHERE revision_id=? AND source_id=? AND span_start=20",
      )
      .run(f.firstId, f.firstSource.id);
    f.unavailable();
  });

  it("does not use unresolved past revisions as factual derivation support", () => {
    const f = fixture();
    f.reviseFirst("unresolved");
    f.database
      .prepare(
        "UPDATE memory_revision_links SET dependency_use='history' WHERE from_revision_id=? AND to_revision_id=?",
      )
      .run(f.childId, f.firstId);
    f.unavailable();
  });

  it("separates retained historical support from current dependency use and later correction", () => {
    const f = fixture();
    f.reviseFirst("retained_history");
    f.unavailable();
    f.database
      .prepare(
        "UPDATE memory_revision_links SET dependency_use='history' WHERE from_revision_id=? AND to_revision_id=?",
      )
      .run(f.childId, f.firstId);
    expect(f.read().status).toBe("resolved");
    const previous = f.repository.requireDetail(f.first.memory.id).memory
      .currentRevisionId;
    const next = f.repository.revise({
      memoryId: f.first.memory.id,
      revisionId: randomUUID(),
      predecessorRevisionId: previous,
      priorDispositions: [
        { revisionId: previous, disposition: "unresolved" },
        { revisionId: f.firstId, disposition: "corrected" },
      ],
      content: "前面的记录其实记错了。",
      reason: "explicit correction fixture",
      now: f.clock.now(),
      sources: [],
    });
    f.repository.recall.putSemantics(
      next.memory.currentRevisionId,
      {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    f.unavailable();
  });

  it("keeps current temporal bounds while allowing the same valid record as past support", () => {
    const f = fixture();
    f.database
      .prepare(
        "UPDATE memory_revision_semantics SET valid_from=?,valid_to=? WHERE revision_id=?",
      )
      .run("2026-09-17T11:00:00.000Z", "2026-09-17T13:00:00.000Z", f.firstId);
    expect(f.read().status).toBe("resolved");
    f.setNow("2026-09-17T10:59:59.000Z");
    f.unavailable();
    f.setNow("2026-09-17T13:00:00.000Z");
    f.unavailable();
    f.database
      .prepare(
        "UPDATE memory_revision_links SET dependency_use='history' WHERE from_revision_id=? AND to_revision_id=?",
      )
      .run(f.childId, f.firstId);
    expect(f.read().status).toBe("resolved");
  });

  it("qualifies, costs and projects in one real transaction and leaves it closed on return", () => {
    const f = fixture();
    const owner = f.repository.recall;
    const qualify = owner.validateEvidenceReferences.bind(owner);
    const cost = owner.evidenceReadCost.bind(owner);
    const evidence = owner.evidence.bind(owner);
    const phases: string[] = [];
    vi.spyOn(owner, "validateEvidenceReferences").mockImplementation(
      (...args) => {
        expect(f.database.inTransaction).toBe(true);
        phases.push("qualify");
        return qualify(...args);
      },
    );
    vi.spyOn(owner, "evidenceReadCost").mockImplementation((...args) => {
      expect(f.database.inTransaction).toBe(true);
      phases.push("cost");
      return cost(...args);
    });
    vi.spyOn(owner, "evidence").mockImplementation((...args) => {
      expect(f.database.inTransaction).toBe(true);
      phases.push("read");
      return evidence(...args);
    });
    expect(f.read().status).toBe("resolved");
    expect(phases).toEqual(["qualify", "cost", "read"]);
    expect(f.database.inTransaction).toBe(false);
  });
});
