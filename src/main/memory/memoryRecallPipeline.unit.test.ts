import { ModelMemoryEvidenceSelector } from "./memoryModels";
import type { ModelProvider, ModelRequest } from "../agent/modelProvider";
import {
  formationRuntime,
  formationResourceBudget,
} from "../../../tests/fixtures/formationModel";
import {
  formationIntake,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import { searchMemoryVectors } from "./memoryVectorSearch";
import type { MemoryVectorSearchPort } from "./memoryVectorSearchWorker";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EvidencePack,
  MemoryEvidenceItem,
  MemoryRevisionSemantics,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import type { MemoryDetail } from "../../shared/contracts/memory";
import { openApplicationDatabase } from "../db/database";
import { estimateInputBudget } from "../providers/inputBudget";
import {
  memoryCandidateCapacity,
  fitMemoryEvidence,
  MemoryRecallPipeline,
  type MemoryRecallDiagnostics,
} from "./memoryRecallPipeline";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";
import { MEMORY_CONSOLIDATION_VERSION } from "./memoryLearningRepository";
import { PersonaRepository } from "../persona/personaRepository";
import type {
  MemoryEmbeddingProvider,
  MemoryEvidenceSelector,
} from "./memoryModels";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "memory-recall-"));
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  cleanups.push(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(database);
  const clock = { now: () => "2026-09-15T12:00:00.000Z" };
  // Numeric vectors are adapter fixtures for SQL/fusion correctness. They make
  // no claims about language understanding; real embeddings are evaluated separately.
  const embedding: MemoryEmbeddingProvider = {
    modelKey: "numeric-fixture-v1",
    dimensions: 2,
    splitDocument: (text) => Promise.resolve([text]),
    embedDocuments: (texts) =>
      Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
    embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
  };
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
  const selector: MemoryEvidenceSelector = { select };
  const vectorSearch: MemoryVectorSearchPort = {
    search: ({ query, plan, modelKey, now, limit }, signal) =>
      Promise.resolve(
        searchMemoryVectors(
          query,
          repository.recall.vectors(plan, modelKey, now),
          limit,
          () => signal?.throwIfAborted(),
        ),
      ),
  };
  const pipeline = new MemoryRecallPipeline(
    repository.recall,
    { embedding, selector, vectorSearch },
    clock,
  );
  const create = (
    content: string,
    semantics?: Partial<MemoryRevisionSemantics>,
  ) => {
    const detail = repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content,
      type: "event",
      confidence: 1,
      importance: 0.5,
      now: clock.now(),
      reason: "fixture",
      sources: [],
    });
    if (semantics)
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
  const queueFormation = (personaId?: string) => {
    const episode: FormationFixture = {
      id: randomUUID(),
      version: "source-v1",
      ...(personaId ? { personaId } : {}),
      recordedAt: clock.now(),
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: "一段尚未形成记忆的真实来源。",
          occurredAt: clock.now(),
        },
      ],
    };
    return repository.formation.enqueue(
      formationIntake(episode),
      "fixture",
      clock.now(),
    );
  };
  const plan: RecallPlan = {
    purpose: "recollection",
    query: "回忆",
    questions: [{ id: "q1", text: "回忆" }],
    contextBudget: { maxTokens: 8000 },
  };
  return {
    database,
    repository,
    clock,
    embedding,
    selector,
    select,
    vectorSearch,
    pipeline,
    create,
    queueFormation,
    plan,
  };
}

describe("Memory evidence recall", () => {
  function entityRecord(
    f: ReturnType<typeof fixture>,
    content: string,
    entityId: string,
    semantics: Partial<MemoryRevisionSemantics> = {},
  ) {
    f.repository.recall.putEntity(
      { id: entityId, name: entityId, kind: "person", aliases: [] },
      f.clock.now(),
    );
    const detail = f.create(content);
    f.repository.recall.putSemantics(
      detail.memory.currentRevisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
        ...semantics,
      },
      [entityId],
    );
    return detail;
  }

  it("combines internal entity hints with lexical and vector candidates in one selection", async () => {
    const f = fixture();
    const hinted = randomUUID();
    const structural = entityRecord(f, "Suzhou residence", hinted);
    const lexical = entityRecord(f, "cocoa allergy", randomUUID());
    const semantic = entityRecord(
      f,
      "a paraphrase without word overlap",
      randomUUID(),
    );
    await f.pipeline.indexPending();
    const plan = {
      ...f.plan,
      query: "cocoa",
      questions: [{ id: "q1", text: "cocoa" }],
    };
    expect(
      f.repository.recall.lexical("cocoa", plan, 100, f.clock.now()),
    ).toEqual([lexical.memory.currentRevisionId]);
    const lexicalRead = vi.spyOn(f.repository.recall, "lexical");
    const vectorRead = vi.spyOn(f.vectorSearch, "search");
    const structuredRead = vi.spyOn(f.repository.recall, "structured");
    const pack = await f.pipeline.recall(
      plan,
      undefined,
      undefined,
      undefined,
      [hinted],
    );
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(
      new Set(
        f.select.mock.calls[0]![0].candidates.map(({ memoryId }) => memoryId),
      ),
    ).toEqual(
      new Set([structural.memory.id, lexical.memory.id, semantic.memory.id]),
    );
    expect(new Set(pack.items.map(({ memoryId }) => memoryId))).toEqual(
      new Set([structural.memory.id, lexical.memory.id, semantic.memory.id]),
    );
    expect(lexicalRead.mock.calls[0]![1].entityIds).toBeUndefined();
    expect(vectorRead.mock.calls[0]![0].plan.entityIds).toBeUndefined();
    expect(structuredRead.mock.calls[0]![3]).toEqual([hinted]);
    expect(structuredRead.mock.results[0]!.value).toEqual([
      structural.memory.currentRevisionId,
    ]);
  });

  it.each(["entityIds", "partialNames", "occurrence"] as const)(
    "preserves the original explicit structural scope with internal hints: %s",
    async (kind) => {
      const f = fixture();
      const firstEntity = randomUUID(),
        hintedEntity = randomUUID();
      const first = entityRecord(f, "camera first", firstEntity, {
        occurredFrom: "2026-09-12T00:00:00.000Z",
      });
      const second = entityRecord(f, "camera second", hintedEntity, {
        occurredFrom: "2026-09-12T00:00:00.000Z",
      });
      const outside = entityRecord(f, "camera outside", hintedEntity, {
        occurredFrom: "2026-09-16T00:00:00.000Z",
      });
      f.repository.recall.putEntity(
        { id: firstEntity, name: "Arlo", kind: "person", aliases: [] },
        f.clock.now(),
      );
      const plan: RecallPlan = {
        ...f.plan,
        query: "camera",
        questions: [{ id: "q1", text: "camera" }],
        ...(kind === "entityIds"
          ? { entityIds: [firstEntity] }
          : kind === "partialNames"
            ? { entityNames: ["Arlo", "Unresolved person"] }
            : {
                timeScope: {
                  occurredFrom: "2026-09-11T00:00:00.000Z",
                  occurredTo: "2026-09-14T00:00:00.000Z",
                },
              }),
      };
      const structured = vi.spyOn(f.repository.recall, "structured");
      const pack = await f.pipeline.recall(
        plan,
        undefined,
        undefined,
        undefined,
        [hintedEntity],
      );
      const expected = kind === "occurrence" ? [first, second] : [first];
      expect(new Set(pack.items.map(({ memoryId }) => memoryId))).toEqual(
        new Set(expected.map(({ memory }) => memory.id)),
      );
      expect(new Set(structured.mock.results[0]!.value as string[])).toEqual(
        new Set(expected.map(({ memory }) => memory.currentRevisionId)),
      );
      expect(
        pack.items.some(({ memoryId }) => memoryId === outside.memory.id),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    "does not turn absent or unknown internal hints into unbounded recent evidence: %s",
    async (unknown) => {
      const f = fixture();
      entityRecord(f, "A quiet lakeside visit", randomUUID());
      const plan = {
        ...f.plan,
        query: "telescope",
        questions: [{ id: "q1", text: "telescope" }],
        timeScope: { knownAt: f.clock.now() },
      };
      const hints = unknown ? [randomUUID()] : [];
      expect(
        f.repository.recall.structured(plan, 100, f.clock.now(), hints),
      ).toEqual([]);
      expect(
        (await f.pipeline.recall(plan, undefined, undefined, undefined, hints))
          .items,
      ).toEqual([]);
      expect(f.select).not.toHaveBeenCalled();
    },
  );

  it("keeps owner Persona and lifecycle eligibility on the internal structured lane", async () => {
    const f = fixture();
    const personas = new PersonaRepository(f.database);
    personas.initialize(f.clock.now());
    const own = personas.getActiveSnapshot().personaId,
      other = randomUUID();
    personas.insertCustom({
      createdAt: f.clock.now(),
      snapshot: { ...personas.getActiveSnapshot(), personaId: other },
    });
    const hinted = randomUUID();
    const ownRecord = entityRecord(f, "own promise", hinted, {
      owner: "character",
      personaId: own,
    });
    entityRecord(f, "other promise", hinted, {
      owner: "character",
      personaId: other,
    });
    entityRecord(f, "user fact", hinted);
    const archived = entityRecord(f, "archived promise", hinted, {
      owner: "character",
      personaId: own,
    });
    const deleted = entityRecord(f, "deleted promise", hinted, {
      owner: "character",
      personaId: own,
    });
    f.repository.archive(archived.memory.id, f.clock.now());
    f.repository.softDelete(deleted.memory.id, f.clock.now());
    const pack = await f.pipeline.recall(
      { ...f.plan, owner: "character", personaId: own },
      undefined,
      undefined,
      undefined,
      [hinted],
    );
    expect(pack.items.map(({ memoryId }) => memoryId)).toEqual([
      ownRecord.memory.id,
    ]);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it.each(["revise", "cancel"] as const)(
    "rechecks a hinted candidate after asynchronous selection: %s",
    async (change) => {
      const f = fixture();
      const entity = randomUUID();
      const detail = entityRecord(f, "Suzhou residence", entity);
      const controller = new AbortController();
      const cancelled = new Error("cancel actual selection");
      const original = f.select.getMockImplementation()!;
      f.select.mockImplementation(async (input, signal) => {
        await Promise.resolve();
        expect(f.database.inTransaction).toBe(false);
        if (change === "cancel") controller.abort(cancelled);
        else
          f.repository.revise({
            memoryId: detail.memory.id,
            predecessorRevisionId: detail.memory.currentRevisionId,
            priorDispositions: [
              {
                revisionId: detail.memory.currentRevisionId,
                disposition: "retained_history",
              },
            ],
            revisionId: randomUUID(),
            content: "Hangzhou residence",
            sources: [],
            reason: "actual change",
            now: f.clock.now(),
          });
        return original(input, signal);
      });
      const result = f.pipeline.recall(
        f.plan,
        controller.signal,
        undefined,
        undefined,
        [entity],
      );
      if (change === "cancel") await expect(result).rejects.toBe(cancelled);
      else expect((await result).items).toEqual([]);
      expect(f.select).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {},
    { validAt: "2026-09-15T12:00:00.000Z" },
    { knownAt: "2026-09-15T12:00:00.000Z" },
    { includeSuperseded: true },
  ])(
    "does not turn an eligibility-only time scope into unrelated recent evidence: %j",
    (timeScope) => {
      const f = fixture();
      const camera = f.create("The camera was returned.", {});
      f.create("A more recent discussion about an unrelated cafe.", {});
      const plan = { ...f.plan, query: "camera", timeScope };
      expect(f.repository.recall.structured(plan, 100, f.clock.now())).toEqual(
        [],
      );
      expect(
        f.repository.recall.lexical("camera", plan, 100, f.clock.now()),
      ).toEqual([camera.memory.currentRevisionId]);
    },
  );

  it("keeps validity filtering in both lexical and vector recall when no structured lane applies", async () => {
    const f = fixture();
    const prior = f.create("camera checkout", {
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-09-10T00:00:00.000Z",
    });
    const current = f.create("camera returned", {
      validFrom: "2026-09-10T00:00:00.000Z",
    });
    await f.pipeline.indexPending();
    for (const [validAt, expected] of [
      ["2026-09-05T00:00:00.000Z", prior.memory.currentRevisionId],
      [f.clock.now(), current.memory.currentRevisionId],
    ]) {
      const plan = { ...f.plan, timeScope: { validAt: validAt! } };
      expect(f.repository.recall.structured(plan, 100, f.clock.now())).toEqual(
        [],
      );
      expect(
        f.repository.recall.lexical("camera", plan, 100, f.clock.now()),
      ).toEqual([expected]);
      expect(
        [
          ...f.repository.recall.vectors(
            plan,
            f.embedding.modelKey,
            f.clock.now(),
          ),
        ].map(({ id }) => id),
      ).toEqual([expected]);
    }
  });

  it("retrieves event-interval and entity records independently of query wording while retaining validity", () => {
    const f = fixture();
    const entityId = randomUUID();
    f.repository.recall.putEntity(
      { id: entityId, name: "Arlo", kind: "person", aliases: [] },
      f.clock.now(),
    );
    const inside = f.create("The unnamed outing", {
      occurredFrom: "2026-09-12T00:00:00.000Z",
    });
    const outside = f.create("A separate meeting");
    f.repository.recall.putSemantics(
      outside.memory.currentRevisionId,
      {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
        occurredFrom: "2026-09-16T00:00:00.000Z",
      },
      [entityId],
    );
    const expired = f.create("An obsolete arrangement", {
      occurredFrom: "2026-09-12T00:00:00.000Z",
      validTo: "2026-09-14T00:00:00.000Z",
    });
    const intervalPlan = {
      ...f.plan,
      query: "events",
      timeScope: {
        occurredFrom: "2026-09-11T00:00:00.000Z",
        occurredTo: "2026-09-14T00:00:00.000Z",
        validAt: f.clock.now(),
      },
    };
    expect(
      f.repository.recall.structured(intervalPlan, 100, f.clock.now()),
    ).toEqual([inside.memory.currentRevisionId]);
    expect(
      f.repository.recall.structured(
        {
          ...f.plan,
          entityIds: [entityId],
          timeScope: { validAt: f.clock.now() },
        },
        100,
        f.clock.now(),
      ),
    ).toEqual([outside.memory.currentRevisionId]);
    expect(
      f.repository.recall.eligibleIds(
        [expired.memory.currentRevisionId],
        intervalPlan,
        f.clock.now(),
      ).size,
    ).toBe(0);
  });

  it("keeps a direct semantic result ahead of lower-ranked shared matches", async () => {
    const f = fixture();
    const select = vi.spyOn(f.selector, "select");
    const [
      lexicalFirst,
      semanticFirst,
      sharedFirst,
      sharedLater,
      lexicalLast,
      direct,
    ] = [
      "Workday notes",
      "Remembered anniversary",
      "Old planning notes",
      "Repeated work checklist",
      "Work archive",
      "Today I want company without being assigned more tasks",
    ].map((text) => f.create(text, {}).memory.currentRevisionId);
    await f.pipeline.indexPending();
    vi.spyOn(f.repository.recall, "lexical").mockReturnValue([
      lexicalFirst!,
      sharedFirst!,
      sharedLater!,
      lexicalLast!,
    ]);
    vi.spyOn(f.repository.recall, "structured").mockReturnValue([]);
    vi.spyOn(f.vectorSearch, "search").mockResolvedValue(
      [semanticFirst!, direct!, sharedFirst!, sharedLater!].map((id, rank) => ({
        id,
        similarity: 1 - rank / 10,
      })),
    );

    await f.pipeline.recall(f.plan);

    expect(
      select.mock.calls[0]?.[0].candidates.map(({ revisionId }) => revisionId),
    ).toEqual([
      lexicalFirst,
      semanticFirst,
      sharedFirst,
      direct,
      sharedLater,
      lexicalLast,
    ]);
  });

  it("preserves exact references and every question's first result before interleaving the remaining lanes", async () => {
    const f = fixture();
    const select = vi.spyOn(f.selector, "select");
    const detail = f.create("An explicitly requested source", {});
    const ids = Object.fromEntries(
      ["a", "b", "c", "d", "shared", "x", "y", "z", "w"].map((label) => [
        label,
        f.create(`Stored fact ${label}`, {}).memory.currentRevisionId,
      ]),
    );
    await f.pipeline.indexPending();
    vi.spyOn(f.repository.recall, "lexical").mockImplementation((query) =>
      query === "first question"
        ? [ids["a"]!, ids["shared"]!, ids["c"]!]
        : [ids["d"]!, ids["y"]!, ids["shared"]!],
    );
    vi.spyOn(f.repository.recall, "structured").mockReturnValue([
      ids["z"]!,
      ids["w"]!,
    ]);
    vi.spyOn(f.vectorSearch, "search")
      .mockResolvedValueOnce(
        [ids["b"]!, ids["x"]!, ids["shared"]!].map((id, rank) => ({
          id,
          similarity: 1 - rank / 10,
        })),
      )
      .mockResolvedValueOnce([]);

    await f.pipeline.recall({
      ...f.plan,
      personaId: randomUUID(),
      questions: [
        { id: "first", text: "first question" },
        { id: "second", text: "second question" },
      ],
      references: [
        {
          memoryId: detail.memory.id,
          revisionId: detail.memory.currentRevisionId,
          use: "current",
        },
      ],
    });

    expect(
      select.mock.calls[0]?.[0].candidates.map(({ revisionId }) => revisionId),
    ).toEqual([
      detail.memory.currentRevisionId,
      ids["a"],
      ids["b"],
      ids["d"],
      ids["z"],
      ids["shared"],
      ids["x"],
      ids["y"],
      ids["w"],
      ids["c"],
    ]);
  });

  it("reads a known future record without search filters or starting semantic retrieval", async () => {
    const f = fixture();
    const detail = f.create("Tomorrow's recital starts at ten.", {
      occurredFrom: "2026-09-16T10:00:00.000Z",
    });
    const reference = {
      memoryId: detail.memory.id,
      revisionId: detail.memory.currentRevisionId,
      use: "current" as const,
    };
    const lexical = vi.spyOn(f.repository.recall, "lexical");
    const structured = vi.spyOn(f.repository.recall, "structured");
    const embedding = vi.spyOn(f.embedding, "embedQuery");
    const result = await f.pipeline.recall({
      ...f.plan,
      personaId: randomUUID(),
      query: "",
      references: [reference],
      entityIds: [randomUUID()],
      timeScope: { occurredTo: f.clock.now() },
      questions: [
        {
          id: "known",
          text: "What does this exact record say about the recital?",
        },
      ],
    });
    expect(result.items.map(({ revisionId }) => revisionId)).toEqual([
      reference.revisionId,
    ]);
    expect(result.coverage).toEqual([
      {
        questionId: "known",
        status: "supported",
        revisionIds: [reference.revisionId],
      },
    ]);
    expect(lexical).not.toHaveBeenCalled();
    expect(structured).not.toHaveBeenCalled();
    expect(embedding).not.toHaveBeenCalled();
  });

  it("reports unavailable exact pairs and never replaces a changed current revision", async () => {
    const f = fixture();
    const select = vi.spyOn(f.selector, "select");
    const ownPersona = randomUUID(),
      otherPersona = randomUUID();
    const personas = new PersonaRepository(f.database);
    personas.initialize(f.clock.now());
    personas.insertCustom({
      createdAt: f.clock.now(),
      snapshot: { ...personas.getActiveSnapshot(), personaId: otherPersona },
    });
    const prior = f.create("The appointment was Monday.", {});
    const changed = f.repository.revise({
      memoryId: prior.memory.id,
      predecessorRevisionId: f.repository.requireDetail(prior.memory.id).memory
        .currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(prior.memory.id).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: "The appointment is now Wednesday.",
      reason: "Changed",
      now: f.clock.now(),
      sources: [],
    });
    f.repository.recall.putSemantics(
      changed.memory.currentRevisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    const foreign = f.create("Another companion's experience.", {
      owner: "character",
      personaId: otherPersona,
    });
    const references = [
      {
        memoryId: prior.memory.id,
        revisionId: prior.memory.currentRevisionId,
        use: "current" as const,
      },
      {
        memoryId: foreign.memory.id,
        revisionId: foreign.memory.currentRevisionId,
        use: "history" as const,
      },
      {
        memoryId: randomUUID(),
        revisionId: changed.memory.currentRevisionId,
        use: "current" as const,
      },
      {
        memoryId: randomUUID(),
        revisionId: randomUUID(),
        use: "history" as const,
      },
    ];
    const result = await f.pipeline.recall({
      ...f.plan,
      personaId: ownPersona,
      query: "",
      references,
    });
    expect(result.items).toEqual([]);
    for (const ref of references)
      expect(result.incompleteReasons.join("\n")).toContain(
        `${ref.memoryId}/${ref.revisionId}`,
      );
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps historical exact reads distinct from present truth", async () => {
    const f = fixture();
    const prior = f.create("The old arrangement.", {});
    f.repository.revise({
      memoryId: prior.memory.id,
      predecessorRevisionId: f.repository.requireDetail(prior.memory.id).memory
        .currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(prior.memory.id).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: "The new arrangement.",
      reason: "Changed",
      now: f.clock.now(),
      sources: [],
    });
    const result = await f.pipeline.recall({
      ...f.plan,
      personaId: randomUUID(),
      query: "",
      references: [
        {
          memoryId: prior.memory.id,
          revisionId: prior.memory.currentRevisionId,
          use: "history",
        },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      revisionId: prior.memory.currentRevisionId,
      content: "The old arrangement.",
      current: false,
    });
  });

  it("rechecks exact current eligibility after the selector yields", async () => {
    const f = fixture();
    const prior = f.create("An active promise.", {});
    vi.spyOn(f.selector, "select").mockImplementation(
      ({ candidates, plan }) => {
        f.repository.revise({
          memoryId: prior.memory.id,
          predecessorRevisionId: f.repository.requireDetail(prior.memory.id)
            .memory.currentRevisionId,
          priorDispositions: [
            {
              revisionId: f.repository.requireDetail(prior.memory.id).memory
                .currentRevisionId,
              disposition: "unresolved",
            },
          ],
          revisionId: randomUUID(),
          content: "The promise was withdrawn.",
          reason: "Changed",
          now: f.clock.now(),
          sources: [],
        });
        return Promise.resolve({
          selected: candidates.map(({ revisionId }) => ({
            revisionId,
            questionIds: ["q1"],
          })),
          coverage: plan.questions.map(({ id }) => ({
            questionId: id,
            status: "supported",
            revisionIds: candidates.map(({ revisionId }) => revisionId),
          })),
        });
      },
    );
    const result = await f.pipeline.recall({
      ...f.plan,
      personaId: randomUUID(),
      query: "",
      references: [
        {
          memoryId: prior.memory.id,
          revisionId: prior.memory.currentRevisionId,
          use: "current",
        },
      ],
    });
    expect(result.items).toEqual([]);
    expect(result.coverage[0]?.status).toBe("missing");
    expect(
      result.incompleteReasons.some((reason) => reason.includes("未替换")),
    ).toBe(true);
  });

  it("combines exact records with independently constrained related search", async () => {
    const f = fixture();
    const future = f.create("Known future appointment.", {
      occurredFrom: "2026-09-16T10:00:00.000Z",
    });
    const past = f.create("A prior appointment discussion.", {
      occurredFrom: "2026-09-14T10:00:00.000Z",
    });
    const unrelatedFuture = f.create("Another future appointment.", {
      occurredFrom: "2026-09-17T10:00:00.000Z",
    });
    const personaId = randomUUID();
    const reference = {
      memoryId: future.memory.id,
      revisionId: future.memory.currentRevisionId,
      use: "current" as const,
    };
    const plan: RecallPlan = {
      ...f.plan,
      personaId,
      query: "appointment",
      questions: [{ id: "q1", text: "appointment" }],
      references: [reference],
      timeScope: { occurredTo: f.clock.now() },
    };
    const result = await f.pipeline.recall(plan);
    expect(result.items.map(({ revisionId }) => revisionId)).toEqual(
      expect.arrayContaining([
        future.memory.currentRevisionId,
        past.memory.currentRevisionId,
      ]),
    );
    expect(
      result.items.some(
        ({ revisionId }) =>
          revisionId === unrelatedFuture.memory.currentRevisionId,
      ),
    ).toBe(false);
    expect(
      f.repository.recall.validateEvidenceReferences(
        { personaId, references: [reference], retrieval: plan },
        f.clock.now(),
      ),
    ).toEqual([]);
    expect(
      f.repository.recall.validateEvidenceReferences(
        {
          personaId,
          references: [reference],
          retrieval: { timeScope: plan.timeScope! },
        },
        f.clock.now(),
      ),
    ).toEqual([reference]);
  });

  it("bounds exact material before JS and preserves budget omission instead of claiming absence", async () => {
    const f = fixture();
    const large = f.create("x".repeat(50_000), {});
    const small = f.create("A short exact record.", {});
    const result = await f.pipeline.recall({
      ...f.plan,
      personaId: randomUUID(),
      query: "",
      contextBudget: { maxTokens: 1000 },
      references: [large, small].map((detail) => ({
        memoryId: detail.memory.id,
        revisionId: detail.memory.currentRevisionId,
        use: "current",
      })),
    });
    expect(result.items.map(({ revisionId }) => revisionId)).toEqual([
      small.memory.currentRevisionId,
    ]);
    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(1000);
    expect(
      result.incompleteReasons.some((reason) => reason.includes("读取预算")),
    ).toBe(true);
  });

  it("replaces unselected candidates in a full pool while retaining selected evidence", async () => {
    const f = fixture();
    const source = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat" as const,
      createdAt: f.clock.now(),
    };
    for (let index = 0; index < memoryCandidateCapacity(32_000); index += 1) {
      const detail = f.create("露营", {});
      const ownSource = {
        ...source,
        id: randomUUID(),
        referenceId: randomUUID(),
      };
      f.repository.attachEvidence(detail.memory.currentRevisionId, [ownSource]);
      f.repository.recall.addSpan(
        detail.memory.currentRevisionId,
        ownSource.id,
        0,
        2,
        "露营",
      );
    }
    const neighbor = f.create("改期的原因是周六暴雨", {});
    const target = neighbor.memory.currentRevisionId;
    f.repository.attachEvidence(target, [source]);
    const inputs: MemoryEvidenceItem[][] = [];
    const retainedId = f.repository.recall.lexical(
      "露营",
      f.plan,
      1,
      f.clock.now(),
    )[0]!;
    f.repository.recall.link(retainedId, target, "caused_by", source.id);
    f.selector.select = ({ candidates }) => {
      inputs.push(structuredClone(candidates));
      const found = candidates.some(({ revisionId }) => revisionId === target);
      const ids = found ? [retainedId, target] : [retainedId];
      return Promise.resolve({
        selected: ids.map((revisionId) => ({
          revisionId,
          questionIds: ["q1"],
        })),
        coverage: [
          {
            questionId: "q1",
            status: found ? "supported" : "partial",
            revisionIds: ids,
          },
        ],
      });
    };
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "q1", text: "露营" }],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.some(({ revisionId }) => revisionId === target)).toBe(
      false,
    );
    expect(inputs[1]!.some(({ revisionId }) => revisionId === target)).toBe(
      true,
    );
    expect(inputs[1]!.length).toBeLessThanOrEqual(inputs[0]!.length);
    expect(
      inputs[1]!.find(({ revisionId }) => revisionId === retainedId),
    ).toEqual(inputs[0]![0]);
    expect(pack.items.map(({ revisionId }) => revisionId)).toEqual([
      retainedId,
      target,
    ]);
    expect(pack.coverage[0]?.status).toBe("supported");
    expect(pack.truncated).toBe(true);
    expect(pack.incompleteReasons).toContain(
      "关联扩展候选已按上下文预算节选，尚未穷尽相关证据",
    );
  });

  it("keeps selected source spans intact when fitting new competing evidence", () => {
    const f = fixture();
    const one = f.create("已经选择的事实", {});
    const two = f.create("新增事实", {});
    const [retained, neighbor] = f.repository.recall.evidence(
      [one.memory.currentRevisionId, two.memory.currentRevisionId],
      f.clock.now(),
    );
    retained!.sourceRefs = [
      {
        sourceId: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        spans: [{ start: 0, end: 4, quote: "实际原文" }],
      },
    ];
    retained!.sourceCount = 1;
    const before = structuredClone(retained!);
    const budget = estimateInputBudget([retained, neighbor]).estimatedTokens;
    const result = fitMemoryEvidence([neighbor!], budget, [retained!]);
    expect(result[0]).toEqual(before);
    expect(result).toHaveLength(2);
    expect(retained).toEqual(before);
    expect(() => fitMemoryEvidence([], 1, [retained!])).toThrow("exceeds");
  });

  it("does not spend a second selection when no new evidence fits", async () => {
    const f = fixture();
    const a = f.create("露营安排已改", {});
    const source = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat" as const,
      createdAt: f.clock.now(),
    };
    const b = f.create("无法在这个请求预算完整容纳的原文。".repeat(1000), {});
    for (const item of [a, b])
      f.repository.attachEvidence(item.memory.currentRevisionId, [source]);
    const select = vi.fn<MemoryEvidenceSelector["select"]>(({ candidates }) =>
      Promise.resolve({
        selected: [
          { revisionId: candidates[0]!.revisionId, questionIds: ["q1"] },
        ],
        coverage: [
          {
            questionId: "q1",
            status: "partial",
            revisionIds: [candidates[0]!.revisionId],
          },
        ],
      }),
    );
    f.selector.select = select;
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "q1", text: "露营" }],
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(pack.coverage[0]?.status).toBe("partial");
    expect(pack.items.map(({ revisionId }) => revisionId)).toEqual([
      a.memory.currentRevisionId,
    ]);
    expect(pack.truncated).toBe(true);
  });

  it("keeps the original pool when oversized neighbors displace count slots but none fit", async () => {
    const f = fixture();
    const candidateBudget = 4000;
    const capacity = memoryCandidateCapacity(candidateBudget);
    for (let index = 0; index < capacity; index += 1) f.create("露营");
    const retainedId = f.repository.recall.lexical(
      "露营",
      f.plan,
      1,
      f.clock.now(),
    )[0]!;
    const source = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat" as const,
      createdAt: f.clock.now(),
    };
    for (let index = 0; index < capacity; index += 1) {
      const neighbor = f.create("z".repeat(candidateBudget + 1));
      const revisionId = neighbor.memory.currentRevisionId;
      f.repository.attachEvidence(revisionId, [source]);
      // Incoming neighbors keep the retained record itself concise even when
      // all outgoing typed relationships are now included in evidence metadata.
      f.repository.recall.link(revisionId, retainedId, "caused_by", source.id);
    }
    const inputs: MemoryEvidenceItem[][] = [];
    f.selector.select = ({ candidates }) => {
      inputs.push(structuredClone(candidates));
      return Promise.resolve({
        selected: [{ revisionId: retainedId, questionIds: ["q1"] }],
        coverage: [
          {
            questionId: "q1",
            status: "partial",
            revisionIds: [retainedId],
          },
        ],
      });
    };
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "q1", text: "露营" }],
      contextBudget: { maxTokens: candidateBudget / 4 },
    });
    // The count slice can hold fewer old candidates than the original pool
    // when the alternating new lane fills its slots with unfit whole records.
    expect(inputs[0]!.length).toBeGreaterThan(
      1 + Math.floor((capacity - 1) / 2),
    );
    expect(inputs).toHaveLength(1);
    expect(pack.items.map(({ revisionId }) => revisionId)).toEqual([
      retainedId,
    ]);
    expect(pack.coverage[0]?.status).toBe("partial");
    expect(pack.truncated).toBe(true);
    expect(pack.incompleteReasons).toContain(
      "关联扩展候选已按上下文预算节选，尚未穷尽相关证据",
    );
  });

  it("rejects unavailable first-round selected evidence before expansion", async () => {
    const f = fixture();
    f.create("回忆", {});
    const linked = vi.spyOn(f.repository.recall, "linked");
    f.selector.select = () =>
      Promise.resolve({
        selected: [{ revisionId: randomUUID(), questionIds: ["q1"] }],
        coverage: [{ questionId: "q1", status: "partial", revisionIds: [] }],
      });
    await expect(f.pipeline.recall(f.plan)).rejects.toThrow("unavailable");
    expect(linked).not.toHaveBeenCalled();
  });

  it("gives a long revision one semantic candidate slot across all its chunks", async () => {
    const f = fixture();
    const long = f.create("很长的一段经历", {});
    const other = f.create("另一段独立的经历", {});
    const longId = long.memory.currentRevisionId;
    const otherId = other.memory.currentRevisionId;
    const capacity = memoryCandidateCapacity(32_000);
    await f.repository.recall.scheduleIndex(
      f.embedding.modelKey,
      f.clock.now(),
    );
    for (const work of f.repository.recall.indexWork(f.embedding.modelKey)) {
      const isLong = work.subject_id === longId;
      const chunks = Array.from(
        { length: isLong ? capacity : 1 },
        (_, index) => `正文${index}`,
      );
      expect(
        f.repository.recall.finishIndex(
          work,
          chunks,
          chunks.map(() => new Float32Array(isLong ? [1, 0] : [0.8, 0.6])),
          f.embedding.modelKey,
          2,
          f.clock.now(),
        ),
      ).toBe(true);
    }
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "q1", text: "zzzz_no_lexical_overlap" }],
    });
    expect(pack.items.map(({ revisionId }) => revisionId)).toEqual([
      longId,
      otherId,
    ]);
  });

  it("does not start an encoder or selector for an empty eligible vector pool", async () => {
    const f = fixture();
    const embed = vi
      .spyOn(f.embedding, "embedQuery")
      .mockRejectedValue(new Error("encoder must remain cold"));
    const scan = vi.spyOn(f.vectorSearch, "search");
    const pack = await f.pipeline.recall(f.plan);
    expect(pack.items).toEqual([]);
    expect(pack.coverage).toEqual([
      { questionId: "q1", status: "missing", revisionIds: [] },
    ]);
    expect(pack.incompleteReasons).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(vi.mocked(f.selector).select.mock.calls).toHaveLength(0);
  });

  it.each(["pending", "running", "failed", "suspended"] as const)(
    "reports %s formation work as a coverage gap even with no memory rows",
    async (status) => {
      const f = fixture();
      const work = f.queueFormation();
      const execution =
        status !== "pending"
          ? f.repository.formation.startWork(
              work.workId,
              "test",
              undefined,
              f.clock.now(),
            )
          : undefined;
      if (status === "failed")
        f.repository.formation.fail(
          execution!,
          "formation_failed",
          f.clock.now(),
        );
      if (status === "suspended")
        f.repository.formation.suspend(execution!, f.clock.now());
      const pack = await f.pipeline.recall(f.plan);
      expect(pack.items).toEqual([]);
      expect(pack.coverage).toEqual([
        { questionId: "q1", status: "missing", revisionIds: [] },
      ]);
      expect(pack.incompleteReasons).toEqual(["部分经历尚未形成可检索记忆"]);
    },
  );
  it("counts any unfinished persona source for shared user facts but scopes character-only gaps", async () => {
    const f = fixture();
    const personaId = randomUUID();
    f.queueFormation(randomUUID());
    for (const scope of [
      { personaId },
      { owner: "user" as const },
      { owner: "user" as const, personaId },
    ])
      expect(
        (await f.pipeline.recall({ ...f.plan, ...scope })).incompleteReasons,
      ).toEqual(["部分经历尚未形成可检索记忆"]);
    expect(
      (await f.pipeline.recall({ ...f.plan, personaId, owner: "character" }))
        .incompleteReasons,
    ).toEqual([]);
    f.queueFormation();
    expect(
      (await f.pipeline.recall({ ...f.plan, personaId, owner: "character" }))
        .incompleteReasons,
    ).toEqual([]);
    f.queueFormation(personaId);
    expect(
      (await f.pipeline.recall({ ...f.plan, personaId, owner: "character" }))
        .incompleteReasons,
    ).toEqual(["部分经历尚未形成可检索记忆"]);
  });

  it("keeps manually archived memory out of relation expansion and historical recall", async () => {
    const f = fixture();
    const a = f.create("橘子旅行的路线已确认", {});
    const b = f.create("蓝色书签是旅行的纪念", {});
    const source = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat" as const,
      label: "路线和书签来自同一原始消息",
      createdAt: f.clock.now(),
    };
    f.repository.attachEvidence(a.memory.currentRevisionId, [source]);
    f.repository.attachEvidence(b.memory.currentRevisionId, [source]);
    f.repository.archive(b.memory.id, f.clock.now());
    const inspected: string[][] = [];
    f.selector.select = ({ plan, candidates }) => {
      inspected.push(candidates.map(({ memoryId }) => memoryId));
      return Promise.resolve({
        selected: candidates.map(({ revisionId }) => ({
          revisionId,
          questionIds: ["q1"],
        })),
        coverage: plan.questions.map(({ id }) => ({
          questionId: id,
          status: "partial",
          revisionIds: candidates.map(({ revisionId }) => revisionId),
        })),
      });
    };
    for (const timeScope of [
      undefined,
      { includeSuperseded: true },
      { knownAt: f.clock.now() },
    ]) {
      const pack = await f.pipeline.recall({
        ...f.plan,
        purpose: "conversation",
        query: "橘子",
        questions: [{ id: "q1", text: "橘子" }],
        ...(timeScope ? { timeScope } : {}),
      });
      expect(pack.items.map(({ memoryId }) => memoryId)).toEqual([a.memory.id]);
    }
    expect(inspected.flat()).not.toContain(b.memory.id);
    expect(
      f.repository.recall.linked(
        [a.memory.currentRevisionId],
        f.plan,
        10,
        f.clock.now(),
      ),
    ).toEqual([]);
  });
  it.each(["appears", "completes"] as const)(
    "preserves a formation coverage gap when work %s during the awaited selector",
    async (transition) => {
      const f = fixture();
      f.create("已保存的陶艺经历", {});
      await f.pipeline.indexPending();
      const work = transition === "completes" ? f.queueFormation() : undefined;
      const execution = work
        ? f.repository.formation.startWork(
            work.workId,
            "test",
            undefined,
            f.clock.now(),
          )
        : undefined;
      const select = f.selector.select.bind(f.selector);
      f.selector.select = async (input, signal) => {
        await Promise.resolve();
        if (execution)
          f.repository.formation.finish(execution, {}, f.clock.now());
        else f.queueFormation();
        return select(input, signal);
      };
      const pack = await f.pipeline.recall(f.plan);
      expect(pack.items).toHaveLength(1);
      expect(pack.incompleteReasons).toContain("部分经历尚未形成可检索记忆");
    },
  );

  it("reads an unindexed committed fact through lexical evidence with explicit incomplete coverage", async () => {
    const f = fixture();
    const created = f.create("用户现在喜欢乌龙茶。", {});
    const embed = vi
      .spyOn(f.embedding, "embedQuery")
      .mockRejectedValue(new Error("encoder must remain cold"));
    const pack = await f.pipeline.recall({
      ...f.plan,
      owner: "user",
      questions: [{ id: "q1", text: "乌龙茶" }],
    });
    expect(pack.items.map((item) => item.memoryId)).toEqual([
      created.memory.id,
    ]);
    expect(pack.incompleteReasons.join(" ")).toContain("语义索引尚未完成");
    expect(embed).not.toHaveBeenCalled();
  });

  it("does not encode when all indexed rows are excluded by the requested scope", async () => {
    const f = fixture();
    const created = f.create("乌龙茶", {});
    await f.pipeline.indexPending();
    const embed = vi.spyOn(f.embedding, "embedQuery");
    const pack = await f.pipeline.recall({
      ...f.plan,
      excludeRevisionIds: [created.memory.currentRevisionId],
    });
    expect(pack.items).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it("fences a pending-index revision changed during the awaited selector", async () => {
    const f = fixture();
    const created = f.create("旧住处在杭州", {});
    f.selector.select = async ({ plan, candidates }) => {
      await Promise.resolve();
      f.repository.revise({
        memoryId: created.memory.id,
        predecessorRevisionId: f.repository.requireDetail(created.memory.id)
          .memory.currentRevisionId,
        priorDispositions: [
          {
            revisionId: f.repository.requireDetail(created.memory.id).memory
              .currentRevisionId,
            disposition: "unresolved",
          },
        ],
        revisionId: randomUUID(),
        content: "现在住南京",
        sources: [],
        reason: "改口",
        now: f.clock.now(),
      });
      return {
        selected: candidates.map((item) => ({
          revisionId: item.revisionId,
          questionIds: ["q1"],
        })),
        coverage: plan.questions.map((q) => ({
          questionId: q.id,
          status: "supported",
          revisionIds: candidates.map((item) => item.revisionId),
        })),
      };
    };
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "q1", text: "杭州" }],
    });
    expect(pack.items).toEqual([]);
    expect(pack.incompleteReasons.join(" ")).toContain("语义索引尚未完成");
  });

  it("finds a genuine vector-lane candidate even when SQL FTS has no overlap", async () => {
    const f = fixture();
    const created = f.create("山中露营时大家一起看了流星。", {});
    await f.pipeline.indexPending();
    expect(
      f.repository.recall.lexical("天文观察", f.plan, 10, f.clock.now()),
    ).toEqual([]);
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "sky", text: "天文观察" }],
    });
    expect(pack.items.map(({ memoryId }) => memoryId)).toEqual([
      created.memory.id,
    ]);
    expect(pack.coverage[0]?.status).toBe("supported");
  });

  it("keeps missing classifications explicit and never injects all stable profiles", async () => {
    const f = fixture();
    f.create("用户曾读到冰川", undefined);
    const pack = await f.pipeline.recall({
      ...f.plan,
      questions: [{ id: "q1", text: "冰川" }],
    });
    expect(pack.items[0]?.basis).toBeUndefined();
    expect(pack.incompleteReasons.join(" ")).toContain("旧记录");
    expect(pack.incompleteReasons.join(" ")).toContain("语义索引");
    expect(
      (await f.pipeline.recall({ ...f.plan, query: "", questions: [] })).items,
    ).toEqual([]);
  });

  it("keeps changed facts historical and excludes a deletion during awaited selection", async () => {
    const f = fixture();
    const old = f.create("旧住处在杭州", {});
    await f.pipeline.indexPending();
    f.selector.select = ({ plan, candidates }) => {
      f.repository.revise({
        memoryId: old.memory.id,
        predecessorRevisionId: f.repository.requireDetail(old.memory.id).memory
          .currentRevisionId,
        priorDispositions: [
          {
            revisionId: f.repository.requireDetail(old.memory.id).memory
              .currentRevisionId,
            disposition: "unresolved",
          },
        ],
        revisionId: randomUUID(),
        content: "现在住南京",
        sources: [],
        reason: "改口",
        now: "2026-09-16T12:00:00.000Z",
      });
      return Promise.resolve({
        selected: candidates.map(({ revisionId }) => ({
          revisionId,
          questionIds: ["q1"],
        })),
        coverage: plan.questions.map(({ id }) => ({
          questionId: id,
          status: "supported",
          revisionIds: candidates.map(({ revisionId }) => revisionId),
        })),
      });
    };
    expect((await f.pipeline.recall(f.plan)).items).toEqual([]);
    f.selector.select = ({ candidates }) => {
      f.repository.softDelete(old.memory.id, f.clock.now());
      return Promise.resolve({
        selected: candidates.map(({ revisionId }) => ({
          revisionId,
          questionIds: ["q1"],
        })),
        coverage: [
          {
            questionId: "q1",
            status: "supported",
            revisionIds: candidates.map(({ revisionId }) => revisionId),
          },
        ],
      });
    };
    expect(
      (
        await f.pipeline.recall({
          ...f.plan,
          timeScope: { includeSuperseded: true },
        })
      ).items,
    ).toEqual([]);
  });

  it("handles time overlap, explicit historical revision and entity aliases without merging names", async () => {
    const f = fixture();
    const a = randomUUID();
    const b = randomUUID();
    f.repository.recall.putEntity(
      { id: a, name: "小林", kind: "person", aliases: [] },
      f.clock.now(),
    );
    f.repository.recall.putEntity(
      { id: b, name: "小林", kind: "person", aliases: [] },
      f.clock.now(),
    );
    expect(f.repository.recall.resolveEntityNames(["小林"])).toHaveLength(2);
    const detail = f.create("小林参加了周末聚会", {
      occurredFrom: "2026-08-01T00:00:00.000Z",
      occurredTo: "2026-08-03T00:00:00.000Z",
    });
    await f.pipeline.indexPending();
    expect(
      (
        await f.pipeline.recall({
          ...f.plan,
          timeScope: {
            occurredFrom: "2026-08-02T00:00:00.000Z",
            occurredTo: "2026-08-04T00:00:00.000Z",
          },
        })
      ).items[0]?.memoryId,
    ).toBe(detail.memory.id);
    expect(
      (
        await f.pipeline.recall({
          ...f.plan,
          timeScope: { occurredFrom: "2026-09-01T00:00:00.000Z" },
        })
      ).items,
    ).toEqual([]);
    f.repository.revise({
      memoryId: detail.memory.id,
      predecessorRevisionId: f.repository.requireDetail(detail.memory.id).memory
        .currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(detail.memory.id).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: "小林没有参加聚会",
      sources: [],
      reason: "纠正",
      now: "2026-09-16T00:00:00.000Z",
    });
    const pack = await f.pipeline.recall({
      ...f.plan,
      timeScope: { knownAt: "2026-09-15T12:00:00.000Z" },
    });
    expect(pack.items[0]?.revisionId).toBe(detail.memory.currentRevisionId);
    expect(pack.items[0]?.current).toBe(false);
  });

  it("rejects invented selection IDs and marks evidence removed by a small budget", async () => {
    const f = fixture();
    f.create("露营时看到了星空", {});
    await f.pipeline.indexPending();
    f.selector.select = () =>
      Promise.resolve({
        selected: [{ revisionId: randomUUID(), questionIds: ["q1"] }],
        coverage: [{ questionId: "q1", status: "supported", revisionIds: [] }],
      });
    await expect(f.pipeline.recall(f.plan)).rejects.toThrow("unavailable");
    const pack = await f.pipeline.recall({
      ...f.plan,
      contextBudget: { maxTokens: 1 },
    });
    expect(pack.items).toEqual([]);
    expect(pack.truncated).toBe(true);
  });

  it("commits embeddings atomically and does not resurrect deleted rows or reuse changed chunks", async () => {
    const f = fixture();
    const detail = f.create("first second", {});
    await f.pipeline.indexPending();
    const newer = {
      ...f.embedding,
      modelKey: "numeric-fixture-v2",
      splitDocument: () => Promise.resolve(["first", "second"]),
    };
    await new MemoryRecallPipeline(
      f.repository.recall,
      { embedding: newer, selector: f.selector, vectorSearch: f.vectorSearch },
      f.clock,
    ).indexPending();
    expect(
      (
        f.database
          .prepare(
            "SELECT COUNT(*) n FROM memory_chunk_embeddings WHERE model_key=?",
          )
          .get(f.embedding.modelKey) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        f.database
          .prepare(
            "SELECT COUNT(*) n FROM memory_chunk_embeddings WHERE model_key=?",
          )
          .get(newer.modelKey) as { n: number }
      ).n,
    ).toBe(2);
    f.repository.softDelete(detail.memory.id, f.clock.now());
    expect([
      ...f.repository.recall.vectors(
        { ...f.plan, timeScope: { includeSuperseded: true } },
        newer.modelKey,
        f.clock.now(),
      ),
    ]).toEqual([]);
  });
  it("expands a cited causal neighbor across entities without relaxing owner or deletion scopes", async () => {
    const f = fixture();
    const sister = randomUUID();
    const apartment = randomUUID();
    for (const [id, name] of [
      [sister, "姐姐"],
      [apartment, "公寓"],
    ])
      f.repository.recall.putEntity(
        { id: id!, name: name!, kind: "entity", aliases: [] },
        f.clock.now(),
      );
    const gift = f.create("姐姐的礼物计划改为无需烤箱的手作套装。");
    const cause = f.create("公寓没有烤箱，空间也很小。");
    const semantics: MemoryRevisionSemantics = {
      kind: "claim",
      owner: "user",
      basis: "explicit_user_statement",
      qualifiers: {},
    };
    f.repository.recall.putSemantics(gift.memory.currentRevisionId, semantics, [
      sister,
    ]);
    f.repository.recall.putSemantics(
      cause.memory.currentRevisionId,
      semantics,
      [apartment],
    );
    const sourceId = randomUUID();
    f.repository.attachEvidence(gift.memory.currentRevisionId, [
      {
        id: sourceId,
        type: "chat",
        referenceId: randomUUID(),
        createdAt: f.clock.now(),
      },
    ]);
    f.repository.recall.link(
      gift.memory.currentRevisionId,
      cause.memory.currentRevisionId,
      "caused_by",
      sourceId,
    );
    await f.pipeline.indexPending();
    const seen: string[][] = [];
    f.selector.select = ({ candidates }) => {
      seen.push(candidates.map((item) => item.memoryId));
      return Promise.resolve({
        selected: candidates.map(({ revisionId }) => ({
          revisionId,
          questionIds: ["q1"],
        })),
        coverage: [
          {
            questionId: "q1",
            status: candidates.length === 1 ? "partial" : "supported",
            revisionIds: candidates.map(({ revisionId }) => revisionId),
          },
        ],
      });
    };
    const pack = await f.pipeline.recall({
      ...f.plan,
      entityIds: [sister],
      owner: "user",
    });
    expect(seen).toEqual([[gift.memory.id], [gift.memory.id, cause.memory.id]]);
    expect(pack.items.map((item) => item.memoryId)).toContain(cause.memory.id);
    expect(pack.coverage[0]?.status).toBe("supported");
  });

  it("derives row capacity from serialized evidence and reports bounded channel materialization", async () => {
    const f = fixture();
    const budget = 2200;
    const capacity = memoryCandidateCapacity(budget * 4);
    for (let i = 0; i < capacity + 10; i += 1)
      f.create(`露营经历 ${String(i)}`, {});
    await f.pipeline.indexPending();
    const diagnostics: MemoryRecallDiagnostics[] = [];
    const lexical = vi.spyOn(f.repository.recall, "lexical");
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    const pipeline = new MemoryRecallPipeline(
      f.repository.recall,
      {
        embedding: f.embedding,
        selector: f.selector,
        vectorSearch: f.vectorSearch,
        onRecallDiagnostics: (value) => diagnostics.push(value),
      },
      f.clock,
    );
    await pipeline.recall({
      ...f.plan,
      query: "露营",
      questions: [{ id: "q1", text: "露营" }],
      contextBudget: { maxTokens: budget },
    });
    expect(lexical.mock.calls[0]?.[2]).toBe(capacity);
    expect(capacity).toBeLessThan(budget);
    expect(evidence.mock.calls.every(([ids]) => ids.length <= capacity)).toBe(
      true,
    );
    expect(
      diagnostics[0]?.channels.every(({ returned }) => returned <= capacity),
    ).toBe(true);
    expect(diagnostics[0]?.selectorInputs[0]?.estimatedTokens).toBeGreaterThan(
      0,
    );
    expect(diagnostics[0]?.candidateCount).toBeLessThanOrEqual(capacity);
  });
});

describe("consumer-measured Memory delivery", () => {
  function exactPlan(
    f: ReturnType<typeof fixture>,
    details: readonly MemoryDetail[],
  ): RecallPlan {
    return {
      ...f.plan,
      query: "",
      personaId: randomUUID(),
      references: details.map((detail) => ({
        memoryId: detail.memory.id,
        revisionId: detail.memory.currentRevisionId,
        use: "current",
      })),
    };
  }

  it("uses the consumer's complete-pack decision while retaining the original candidate workload", async () => {
    const f = fixture();
    const detail = f.create("乌龙茶偏好及适用条件。".repeat(90), {});
    const plan = { ...exactPlan(f, [detail]), contextBudget: { maxTokens: 1 } };
    const measured: string[] = [];
    const pack = await f.pipeline.recall(plan, undefined, undefined, {
      candidateBudgetTokens: 32_000,
      fits: (proposal) => {
        expect(f.database.inTransaction).toBe(false);
        measured.push(JSON.stringify(proposal));
        return Promise.resolve(true);
      },
    });
    expect(pack.items[0]?.content).toBe(detail.revisions[0]?.content);
    expect(pack.estimatedTokens).toBeGreaterThan(plan.contextBudget.maxTokens);
    expect(measured).toEqual([JSON.stringify(pack)]);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect((await f.pipeline.recall(plan)).items).toEqual([]);
    // Non-Tool consumers keep their small numeric candidate and delivery path.
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("fits full wrappers, preserves statement priority and measures all final gap fields", async () => {
    const f = fixture();
    const first = f.create("乌龙茶用于白天。", {});
    const second = f.create("夜间改用温水。", {});
    for (const detail of [first, second])
      f.repository.attachEvidence(detail.memory.currentRevisionId, [
        {
          id: randomUUID(),
          type: "chat",
          referenceId: randomUUID(),
          createdAt: f.clock.now(),
          label: "实际来源",
        },
      ]);
    const measured: EvidencePack[] = [];
    const serialized: string[] = [];
    const pack = await f.pipeline.recall(
      exactPlan(f, [first, second]),
      undefined,
      undefined,
      {
        candidateBudgetTokens: 32_000,
        fits: (proposal) => {
          expect(f.database.inTransaction).toBe(false);
          measured.push(proposal);
          serialized.push(JSON.stringify(proposal));
          return Promise.resolve(proposal.items.length <= 1);
        },
      },
    );
    expect(measured[0]?.items).toHaveLength(2);
    expect(pack.items.map(({ memoryId }) => memoryId)).toEqual([
      first.memory.id,
    ]);
    expect(pack.coverage[0]?.status).toBe("partial");
    expect(pack.gaps[0]?.reason).toContain("全部要点");
    expect(pack.incompleteReasons.join(" ")).toContain("已检索");
    expect(pack.truncated).toBe(true);
    expect(measured.map((proposal) => JSON.stringify(proposal))).toEqual(
      serialized,
    );
    expect(serialized.at(-1)).toBe(JSON.stringify(pack));
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    "delete",
    "archive",
    "revise",
    "expires",
    "owner",
    "source",
    "history",
  ] as const)(
    "rechecks actual selected revisions after an awaited count without reselecting: %s",
    async (change) => {
      const f = fixture();
      const detail = f.create(
        "待核对的承诺。",
        change === "owner"
          ? undefined
          : change === "expires"
            ? { validTo: "2026-09-16T12:00:00.000Z" }
            : {},
      );
      const plan = exactPlan(f, [detail]);
      if (change === "history") plan.references![0]!.use = "history";
      const sourceId = randomUUID();
      const measured: EvidencePack[] = [];
      const pack = await f.pipeline.recall(plan, undefined, undefined, {
        candidateBudgetTokens: 32_000,
        fits: async (proposal) => {
          expect(f.database.inTransaction).toBe(false);
          measured.push(proposal);
          await Promise.resolve();
          if (measured.length === 1) {
            if (change === "delete")
              f.repository.softDelete(detail.memory.id, f.clock.now());
            else if (change === "archive")
              f.repository.archive(detail.memory.id, f.clock.now());
            else if (change === "revise" || change === "history")
              f.repository.revise({
                memoryId: detail.memory.id,
                predecessorRevisionId: detail.memory.currentRevisionId,
                priorDispositions: [
                  {
                    revisionId: detail.memory.currentRevisionId,
                    disposition: "unresolved",
                  },
                ],
                revisionId: randomUUID(),
                content: "当前承诺已经修改。",
                reason: "用户更改",
                now: f.clock.now(),
                sources: [],
              });
            else if (change === "owner") {
              const personas = new PersonaRepository(f.database);
              personas.initialize(f.clock.now());
              f.repository.recall.putSemantics(
                detail.memory.currentRevisionId,
                {
                  kind: "episode",
                  owner: "character",
                  basis: "direct_observation",
                  qualifiers: {},
                  personaId: personas.getActiveSnapshot().personaId,
                },
                [],
              );
            } else if (change === "expires")
              f.clock.now = () => "2026-09-17T12:00:00.000Z";
            else
              f.repository.attachEvidence(detail.memory.currentRevisionId, [
                {
                  id: sourceId,
                  type: "chat",
                  referenceId: randomUUID(),
                  createdAt: f.clock.now(),
                  label: "新增实际来源",
                },
              ]);
          }
          return true;
        },
      });
      expect(f.select).toHaveBeenCalledTimes(1);
      expect(measured.length).toBeGreaterThan(1);
      expect(measured.at(-1)).toEqual(pack);
      if (change === "source") {
        expect(pack.items).toHaveLength(1);
        expect(
          pack.items[0]?.sourceRefs.map(({ sourceId }) => sourceId),
        ).toContain(sourceId);
      } else if (change === "history") {
        expect(pack.items).toHaveLength(1);
        expect(pack.items[0]).toMatchObject({
          revisionId: detail.memory.currentRevisionId,
          current: false,
        });
        expect(pack.items[0]?.historyStatus).not.toBe(
          measured[0]?.items[0]?.historyStatus,
        );
      } else {
        expect(pack.items).toEqual([]);
        expect(pack.coverage[0]?.status).toBe("missing");
      }
      expect(f.database.inTransaction).toBe(false);
    },
  );

  it("drops a derived selection whose actual source dependency disappears during measurement", async () => {
    const f = fixture();
    const parents = [
      f.create("雨天留在室内。", {}),
      f.create("周五先确认。", {}),
    ];
    const child = f.create("雨天先室内准备，周五确认后进行。", {
      kind: "reflection",
      basis: "inference",
      qualifiers: {
        consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
        consolidationDependencyCount: "2",
      },
    });
    for (const parent of parents) {
      const source = {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat" as const,
        createdAt: f.clock.now(),
      };
      const quote = parent.revisions[0]!.content;
      for (const revisionId of [
        parent.memory.currentRevisionId,
        child.memory.currentRevisionId,
      ]) {
        f.repository.attachEvidence(revisionId, [source]);
        f.repository.recall.addSpan(
          revisionId,
          source.id,
          0,
          quote.length,
          quote,
        );
      }
      f.repository.recall.link(
        child.memory.currentRevisionId,
        parent.memory.currentRevisionId,
        "derived_from",
        source.id,
        "current",
      );
    }
    const measured: EvidencePack[] = [];
    const pack = await f.pipeline.recall(
      exactPlan(f, [child]),
      undefined,
      undefined,
      {
        candidateBudgetTokens: 32_000,
        fits: async (proposal) => {
          expect(f.database.inTransaction).toBe(false);
          measured.push(proposal);
          await Promise.resolve();
          if (measured.length === 1)
            f.repository.softDelete(parents[0]!.memory.id, f.clock.now());
          return true;
        },
      },
    );
    expect(measured[0]?.items.map(({ revisionId }) => revisionId)).toEqual([
      child.memory.currentRevisionId,
    ]);
    expect(pack.items).toEqual([]);
    expect(measured.at(-1)).toEqual(pack);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("remeasures empty receipts when formation coverage changes during the await", async () => {
    const f = fixture();
    const measured: EvidencePack[] = [];
    const pack = await f.pipeline.recall(f.plan, undefined, undefined, {
      candidateBudgetTokens: 32_000,
      fits: async (proposal) => {
        expect(f.database.inTransaction).toBe(false);
        measured.push(proposal);
        await Promise.resolve();
        if (measured.length === 1) f.queueFormation();
        return true;
      },
    });
    expect(pack.items).toEqual([]);
    expect(measured).toHaveLength(2);
    expect(measured[0]?.incompleteReasons).not.toContain(
      "部分经历尚未形成可检索记忆",
    );
    expect(pack.incompleteReasons).toContain("部分经历尚未形成可检索记忆");
    expect(measured[1]).toEqual(pack);
    expect(f.select).not.toHaveBeenCalled();
  });

  it("does not return a formerly accepted subset after a later trial observes tighter space", async () => {
    const f = fixture();
    const detail = f.create("白天用乌龙茶。", {});
    f.repository.attachEvidence(detail.memory.currentRevisionId, [
      {
        id: randomUUID(),
        type: "chat",
        referenceId: randomUUID(),
        createdAt: f.clock.now(),
        label: "来源正文说明",
      },
    ]);
    let compactSeen = false;
    let spaceGone = false;
    const pack = await f.pipeline.recall(
      exactPlan(f, [detail]),
      undefined,
      undefined,
      {
        candidateBudgetTokens: 32_000,
        fits: (proposal) => {
          if (proposal.items.length === 0) return Promise.resolve(true);
          const hasSourceBody = proposal.items[0]?.sourceRefs.some(
            (source) => source.spans !== undefined,
          );
          if (hasSourceBody) {
            if (compactSeen) spaceGone = true;
            return Promise.resolve(false);
          }
          compactSeen = true;
          return Promise.resolve(!spaceGone);
        },
      },
    );
    expect(compactSeen).toBe(true);
    expect(spaceGone).toBe(true);
    expect(pack.items).toEqual([]);
    expect(pack.incompleteReasons.join(" ")).toContain("已检索");
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("rejects an unfit minimal wrapper and preserves the actual measurement failure", async () => {
    const f = fixture();
    const detail = f.create("日间偏好。", {});
    const plan = exactPlan(f, [detail]);
    await expect(
      f.pipeline.recall(plan, undefined, undefined, {
        candidateBudgetTokens: 32_000,
        fits: () => Promise.resolve(false),
      }),
    ).rejects.toThrow("缺口说明");
    const failure = new Error("count service rejected the actual request");
    await expect(
      f.pipeline.recall(plan, undefined, undefined, {
        candidateBudgetTokens: 32_000,
        fits: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(f.database.inTransaction).toBe(false);
  });

  it.each([false, true])(
    "records only final delivered usages, cancelled=%s",
    async (cancelled) => {
      const f = fixture();
      const first = f.create("白天乌龙茶。", {});
      const second = f.create("夜间温水。", {});
      const memory = new MemoryService(
        f.repository,
        { search: () => [] },
        { generate: randomUUID },
        f.clock,
        {
          embedding: f.embedding,
          selector: f.selector,
          vectorSearch: f.vectorSearch,
          formation: formationRuntime({
            version: "unused-fixture",
            form: () => Promise.reject(new Error("No formation expected")),
          }),
          formationResourceBudget,
          formationContextBudget: () => f.plan.contextBudget,
        },
      );
      const usages = vi.spyOn(f.repository, "recordUsages");
      const abort = new AbortController();
      const run = memory.recall(
        exactPlan(f, [first, second]),
        abort.signal,
        "tool",
        {
          candidateBudgetTokens: 32_000,
          fits: async (proposal) => {
            await Promise.resolve();
            if (cancelled) abort.abort();
            return proposal.items.length <= 1;
          },
        },
      );
      if (cancelled) {
        await expect(run).rejects.toMatchObject({ name: "AbortError" });
        expect(usages).not.toHaveBeenCalled();
      } else {
        const pack = await run;
        expect(pack.items).toHaveLength(1);
        expect(usages).toHaveBeenCalledTimes(1);
        expect(
          usages.mock.calls[0]?.[0].map(({ revisionId }) => revisionId),
        ).toEqual(pack.items.map(({ revisionId }) => revisionId));
        expect(usages.mock.calls[0]?.[0][0]?.consumer).toBe("tool");
      }
      const row = f.database
        .prepare("SELECT COUNT(*) AS n FROM memory_usage")
        .get();
      expect(row).toEqual({ n: cancelled ? 0 : 1 });
      expect(f.database.inTransaction).toBe(false);
    },
  );
});

it("repairs one Selector structure on the same SQLite recall candidates without another read or encode", async () => {
  const f = fixture();
  const originals = [0, 1, 2].map((index) =>
    f.create(`reminder record ${index}`, {
      kind: "episode",
      owner: "user",
      basis: "explicit_user_statement",
    }),
  );
  await f.pipeline.indexPending();
  const embed = vi.spyOn(f.embedding, "embedQuery");
  const read = vi.spyOn(f.repository.recall, "evidence");
  const requests: ModelRequest[] = [];
  const counts: { reads: number; embeds: number }[] = [];
  const provider: ModelProvider = {
    estimateInput: (request) => estimateInputBudget(request, request.modelId),
    measureInput(request, signal) {
      signal.throwIfAborted();
      return Promise.resolve(this.estimateInput(request));
    },
    resolveContextLimits: () =>
      Promise.resolve({ effectiveInputTokens: 258000 }),
    async *stream(request) {
      await Promise.resolve();
      requests.push(structuredClone(request));
      counts.push({
        reads: read.mock.calls.length,
        embeds: embed.mock.calls.length,
      });
      const input = JSON.parse(
        (request.input[0] as { content: string }).content,
      ) as { candidates: MemoryEvidenceItem[]; plan: RecallPlan };
      expect(input.candidates).toHaveLength(3);
      const answer =
        requests.length === 1
          ? {
              selected: [
                {
                  revisionId: input.candidates[0]!.revisionId,
                  questionIds: ["q0"],
                },
                {
                  revisionId: input.candidates[1]!.revisionId,
                  questionIds: ["q1"],
                },
                {
                  revisionId: "c7d21176-6385-4fc3-a4a1-c9a44389edf3",
                  questionIds: [],
                },
              ],
              coverage: [],
            }
          : {
              selected: input.candidates.map((_, index) => ({
                candidateIndex: index,
                questionIndices: [index],
              })),
              coverage: input.plan.questions.map((_, index) => ({
                questionIndex: index,
                status: "supported",
                candidateIndices: [index],
              })),
            };
      yield { type: "text.delta", delta: JSON.stringify(answer) };
      yield {
        type: "response.completed",
        responseId: `offline-${requests.length}`,
        status: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      };
    },
  };
  const selector = new ModelMemoryEvidenceSelector(provider, "fixture");
  const pipeline = new MemoryRecallPipeline(
    f.repository.recall,
    { embedding: f.embedding, selector, vectorSearch: f.vectorSearch },
    f.clock,
  );
  const plan = {
    ...f.plan,
    query: "reminder",
    questions: [0, 1, 2].map((i) => ({
      id: `q${i}`,
      text: `reminder record ${i}`,
    })),
  };
  const pack = await pipeline.recall(plan);
  expect(requests).toHaveLength(2);
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[0]!.embeds).toBeGreaterThan(0);
  expect(pack.items.map((item) => item.revisionId).sort()).toEqual(
    originals.map((item) => item.memory.currentRevisionId).sort(),
  );
  expect(pack.coverage).toHaveLength(3);
  expect(pack.coverage.every((item) => item.status === "supported")).toBe(true);
  const first = JSON.parse(
    (requests[0]!.input[0] as { content: string }).content,
  ) as unknown;
  const repaired = JSON.parse(
    (requests[1]!.input[0] as { content: string }).content,
  ) as Record<string, unknown>;
  delete repaired["validationFeedback"];
  expect(repaired).toEqual(first);
  for (const detail of originals)
    expect(
      f.repository.getDetail(detail.memory.id)?.memory.currentRevisionId,
    ).toBe(detail.memory.currentRevisionId);
});

it("joins index scheduling cancellation before invoking the encoder and resumes durable work", async () => {
  const f = fixture();
  f.create("第一条");
  f.create("第二条");
  f.create("第三条");
  const split = vi.spyOn(f.embedding, "splitDocument");
  const embed = vi.spyOn(f.embedding, "embedDocuments");
  const controller = new AbortController();
  const operation = f.pipeline.indexPending(controller.signal);
  expect(f.pipeline.indexPending()).toBe(operation);
  controller.abort();
  await expect(operation).rejects.toThrow();
  expect(split).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
  expect(f.database.inTransaction).toBe(false);
  expect(
    f.database
      .prepare(
        "SELECT COUNT(*) count FROM memory_work WHERE processor_version='pending-model'",
      )
      .get(),
  ).toEqual({ count: 2 });
  expect(await f.pipeline.indexPending()).toBe(3);
  expect(f.pipeline.indexIncomplete()).toBe(false);
});
