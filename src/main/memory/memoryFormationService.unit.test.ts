import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../../../tests/fixtures/formationModel";
import type { ModelRequest } from "../agent/modelProvider";
import type {
  MemoryEvidenceItem,
  MemoryFormationSource,
} from "../../shared/contracts/memoryRecall";
import { searchMemoryVectors } from "./memoryVectorSearch";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formationIntake,
  collectFormationSegments,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { openApplicationDatabase } from "../db/database";
import { ProviderError } from "../providers/providerError";
import { PersonaRepository } from "../persona/personaRepository";
import { MemoryFormationService } from "./memoryFormationService";
import { estimateInputBudget, fitsInputBudget } from "../providers/inputBudget";
import type { ModelProvider } from "../agent/modelProvider";
import { ModelMemoryFormation } from "./memoryModels";
import type { MemoryFormationBatch } from "./memoryModels";
import {
  fitMemoryEvidence,
  MemoryRecallPipeline,
} from "./memoryRecallPipeline";
import { MemoryRepository } from "./memoryRepository";

type ContentUnit = Exclude<
  MemoryFormationBatch["units"][number],
  { operation: "support" }
>;
function contentUnit(batch: MemoryFormationBatch, index = 0): ContentUnit {
  const unit = batch.units[index]!;
  if (unit.operation === "support")
    throw new Error("Expected a content-authoring fixture unit");
  return unit;
}
function supportUnit(unit: MemoryFormationBatch["units"][number]) {
  if (!unit.targetRevisionId)
    throw new Error("Support fixture requires its supplied target");
  return {
    operation: "support" as const,
    targetRevisionId: unit.targetRevisionId,
    citations: unit.citations,
    links: unit.links,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(budget = 8000) {
  const root = mkdtempSync(path.join(os.tmpdir(), "memory-formation-"));
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  cleanups.push(() => {
    if (database.open) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(database);
  const clock = { now: () => "2026-09-15T12:00:00.000Z" };
  const personas = new PersonaRepository(database);
  personas.initialize(clock.now());
  const personaId = personas.getLibrary().activePersonaId;
  const recall = new MemoryRecallPipeline(
    repository.recall,
    {
      embedding: {
        modelKey: "numeric-adapter-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: (texts) =>
          Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
        embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
      },
      vectorSearch: {
        search: ({ query, plan, modelKey, now, limit }, signal) =>
          Promise.resolve(
            searchMemoryVectors(
              query,
              repository.recall.vectors(plan, modelKey, now),
              limit,
              () => signal?.throwIfAborted(),
            ),
          ),
      },
      selector: {
        select: ({ plan, candidates }) =>
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
      },
    },
    clock,
  );
  const model: FormationModelMock = {
    version: "formation-test-v1",
    form: vi.fn<FormationModelMock["form"]>(({ episode, existing }) =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: existing.length ? "revise" : "create",
            ...(existing.length
              ? {
                  targetRevisionId: existing[0]!.revisionId,
                  retainedCitations: [],
                  priorDispositions: [
                    {
                      scope: "revision",
                      revisionId: existing[0]!.revisionId,
                      disposition: "unresolved",
                      sourceId: episode.sources[0]!.id,
                      quote: episode.sources[0]!.content,
                    },
                  ],
                }
              : {}),
            content: episode.sources[0]!.content,
            type: "preference",
            semantics: {
              kind: "claim",
              owner: "user",
              basis: "explicit_user_statement",
              qualifiers: {},
            },
            entityKeys: [],
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
    ),
  };
  const measuredRequests: ModelRequest[] = [];
  const service = new MemoryFormationService(
    repository,
    recall,
    formationRuntime(model, {
      onRequest: (request) => measuredRequests.push(request),
    }),
    new CryptoIdGenerator(),
    clock,
    () => ({ maxTokens: budget }),
    formationResourceBudget,
  );
  const episode = (
    content: string,
    speaker: "user" | "assistant" | "environment" = "user",
  ): FormationFixture => ({
    id: randomUUID(),
    version: "1",
    recordedAt: clock.now(),
    sources: [
      {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        content,
        speaker,
        occurredAt: clock.now(),
      },
    ],
  });
  return {
    database,
    measuredRequests,
    repository,
    clock,
    recall,
    model,
    service,
    enqueue: (input: FormationFixture) =>
      service.enqueue(formationIntake(input)),
    form: (input: FormationFixture, signal?: AbortSignal) =>
      service.form(service.enqueue(formationIntake(input)).workId, signal),
    episode,
    personaId,
  };
}

function modelAdapterFixture() {
  const f = fixture();
  type Input = Parameters<FormationModelMock["form"]>[0];
  const controls: {
    transform: (
      unit: Record<string, unknown>,
      input: Input,
    ) => Record<string, unknown>;
    beforeComplete: () => Promise<void>;
    wire: (unit: Record<string, unknown>) => Record<string, unknown>;
  } = {
    transform: (unit) => unit,
    beforeComplete: () => Promise.resolve(),
    wire: (unit) => unit,
  };
  const stream = vi.fn<ModelProvider["stream"]>(async function* (request) {
    const input = JSON.parse(
      (request.input[0] as { content: string }).content,
    ) as Input;
    const primary = input.episode.sources.find(({ id }) =>
      input.episode.evidenceSourceIds?.includes(id),
    )!;
    const target = input.existing[0];
    let unit = controls.transform(
      {
        operation: target ? "revise" : "create",
        targetRevisionId: target?.revisionId ?? null,
        ...(target
          ? {
              retainedCitations: [],
              priorDispositions: [
                {
                  scope: "revision",
                  revisionId: target.revisionId,
                  disposition: "unresolved",
                  sourceId: primary.id,
                  quote: primary.content,
                },
              ],
            }
          : {}),
        ...(target ? {} : { type: "event" }),
        content: primary.content,
        semantics: {
          kind: target ? "claim" : "episode",
          owner: "user",
          personaId: null,
          basis: "explicit_user_statement",
          occurredFrom: null,
          occurredTo: null,
          timePrecision: "unknown",
          validFrom: null,
          validTo: null,
          subjectEntityId: null,
          predicate: target ? "camera_selection" : "camera_purchase",
          objectEntityId: null,
          objectValue: null,
          qualifiers: [],
          commitmentState: null,
        },
        entityKeys: [],
        citations: [
          { sourceId: primary.id, quote: primary.content, occurrence: null },
        ],
        links: [],
      },
      input,
    );
    if (unit["operation"] === "support") {
      unit = {
        operation: "support",
        targetRevisionId: unit["targetRevisionId"],
        citations: unit["citations"],
        links: unit["links"],
      };
    }
    if (unit["operation"] !== "revise") {
      delete unit["priorDispositions"];
      delete unit["retainedCitations"];
    }
    yield {
      type: "text.delta",
      delta: JSON.stringify({ entities: [], units: [controls.wire(unit)] }),
    };
    await controls.beforeComplete();
    yield {
      type: "response.completed",
      responseId: "offline",
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
  });
  const model = new ModelMemoryFormation(
    {
      stream,
      measureInput(request: ModelRequest, signal: AbortSignal) {
        signal.throwIfAborted();
        return Promise.resolve(this.estimateInput(request));
      },
      estimateInput: (request: ModelRequest) =>
        estimateInputBudget(request, request.modelId),
      resolveContextLimits: () => Promise.resolve({}),
    },
    "fixed-model",
    { effectiveInputTokens: 258_000 },
  );
  const service = new MemoryFormationService(
    f.repository,
    f.recall,
    formationRuntime(model),
    new CryptoIdGenerator(),
    f.clock,
    () => ({ maxTokens: 8000 }),
    formationResourceBudget,
  );
  const initial = f.episode("我已经借到相机了。");
  const correction = () => {
    const next = f.episode("更正一下，相机还没借到，型号也没有定。");
    next.evidenceSourceIds = [next.sources[0]!.id];
    next.sources.push(initial.sources[0]!);
    return next;
  };
  return {
    ...f,
    controls,
    stream,
    initial,
    correction,
    form: (input: FormationFixture, signal?: AbortSignal) =>
      service.form(service.enqueue(formationIntake(input)).workId, signal),
  };
}

describe("Formation operation adapter with persisted targets", () => {
  it("revises a reported event into a corrected current claim without recategorizing its history", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    const correction = f.correction();
    const revised = (await f.form(correction)).changes[0]!;
    expect(revised).toMatchObject({
      operation: "revised",
      memoryId: first.memoryId,
    });
    expect(revised.revisionId).not.toBe(first.revisionId);
    const detail = f.repository.requireDetail(first.memoryId);
    expect(detail.memory.type).toBe("event");
    expect(detail.memory.currentRevisionId).toBe(revised.revisionId);
    expect(detail.revisions).toHaveLength(2);
    expect(
      detail.revisions.find(({ id }) => id === first.revisionId)?.content,
    ).toBe(f.initial.sources[0]!.content);
    const evidence = f.repository.recall.evidence(
      [revised.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence).toMatchObject({
      type: "event",
      content: correction.sources[0]!.content,
      semantics: {
        kind: "claim",
        basis: "explicit_user_statement",
        predicate: "camera_selection",
      },
    });
    expect(
      evidence.sourceRefs.flatMap(({ spans }) =>
        (spans ?? []).map(({ quote }) => quote),
      ),
    ).toContain(correction.sources[0]!.content);
    expect(
      f.repository.recall.evidence([first.revisionId], f.clock.now())[0]!
        .sourceRefs[0]!.sourceId,
    ).toBe(f.initial.sources[0]!.id);
  });

  it("supports the supplied statement without creating a revision or changing its category", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    f.controls.transform = (unit, input) => ({
      ...unit,
      operation: "support",
      content: input.existing[0]!.content,
      semantics: {
        ...(unit["semantics"] as Record<string, unknown>),
        kind: "episode",
        predicate: "camera_purchase",
      },
    });
    const next = f.correction();
    next.sources[0]!.content = "对，相机确实借到了。";
    expect((await f.form(next)).changes[0]).toMatchObject({
      ...first,
      operation: "supported",
    });
    const detail = f.repository.requireDetail(first.memoryId);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.memory.type).toBe("event");
    expect(detail.sources.map(({ id }) => id)).toContain(next.sources[0]!.id);
  });

  it.each(["type", "source", "support"] as const)(
    "rejects an invalid %s without overwriting the saved statement",
    async (failure) => {
      const f = modelAdapterFixture();
      const first = (await f.form(f.initial)).changes[0]!;
      f.controls.transform = (unit) => ({
        ...unit,
        ...(failure === "type" ? { type: "project" } : {}),
        ...(failure === "source"
          ? {
              citations: [
                {
                  sourceId: randomUUID(),
                  quote: "not supplied",
                  occurrence: null,
                },
              ],
            }
          : {}),
        ...(failure === "support" ? { operation: "support" } : {}),
      });
      if (failure === "support")
        f.controls.wire = (unit) => ({
          ...unit,
          content: "尝试通过 support 改写旧事实",
        });
      await expect(f.form(f.correction())).rejects.toThrow(
        failure === "source" ? "outside the current segment" : "rejected value",
      );
      const detail = f.repository.requireDetail(first.memoryId);
      expect(detail.revisions).toHaveLength(1);
      expect(detail.memory.currentRevisionId).toBe(first.revisionId);
    },
  );

  it.each(["cancel", "archive", "delete", "revision"] as const)(
    "does not bypass %s while generation is pending",
    async (mutation) => {
      const f = modelAdapterFixture();
      const first = (await f.form(f.initial)).changes[0]!;
      const entered = deferred();
      const release = deferred();
      f.controls.beforeComplete = () => {
        entered.resolve();
        return release.promise;
      };
      const controller = new AbortController();
      const pending = f.form(f.correction(), controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      if (mutation === "cancel") controller.abort();
      if (mutation === "archive")
        f.repository.archive(first.memoryId, f.clock.now());
      if (mutation === "delete")
        f.repository.softDelete(first.memoryId, f.clock.now());
      if (mutation === "revision")
        f.repository.revise({
          memoryId: first.memoryId,
          predecessorRevisionId: f.repository.requireDetail(first.memoryId)
            .memory.currentRevisionId,
          priorDispositions: [
            {
              revisionId: f.repository.requireDetail(first.memoryId).memory
                .currentRevisionId,
              disposition: "unresolved",
            },
          ],
          revisionId: randomUUID(),
          content: "用户手动更正后的当前内容",
          reason: "用户编辑",
          sources: [],
          now: f.clock.now(),
        });
      release.resolve();
      await rejected;
      const detail = f.repository.requireDetail(first.memoryId);
      expect(detail.revisions).toHaveLength(mutation === "revision" ? 2 : 1);
      expect(
        detail.revisions.some(
          ({ content }) => content === "更正一下，相机还没借到，型号也没有定。",
        ),
      ).toBe(false);
    },
  );
});

describe("Source-backed memory formation", () => {
  it("replays a completed source without claiming purged revisions are still saved", async () => {
    const f = fixture();
    const form = vi.spyOn(f.model, "form");
    const input = f.episode("我喜欢乌龙茶");
    const first = await f.form(input);
    const change = first.changes[0]!;
    f.repository.softDelete(change.memoryId, f.clock.now());
    expect(await f.form(input)).toMatchObject({
      changes: [],
      unavailableChanges: [change],
      replayed: true,
    });
    f.repository.purge(change.memoryId);
    expect(await f.form(input)).toMatchObject({
      changes: [],
      unavailableChanges: [change],
      replayed: true,
    });
    expect(form).toHaveBeenCalledTimes(1);
    expect(f.repository.getDetail(change.memoryId)).toBeUndefined();
    const work = f.repository.formation.work(f.enqueue(input).workId);
    expect(work.status).toBe("complete");
    expect(work.result).toEqual(first);
  });

  it("does not present an old formation revision as a later user's correction", async () => {
    const f = fixture();
    const form = vi.spyOn(f.model, "form");
    const input = f.episode("我喜欢乌龙茶");
    const first = await f.form(input);
    const change = first.changes[0]!;
    const corrected = f.repository.revise({
      memoryId: change.memoryId,
      predecessorRevisionId: f.repository.requireDetail(change.memoryId).memory
        .currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(change.memoryId).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: "用户纠正：喜欢的是红茶",
      reason: "User correction",
      sources: [],
      now: f.clock.now(),
    });
    expect(await f.form(input)).toMatchObject({
      changes: [],
      unavailableChanges: [change],
      replayed: true,
    });
    expect(
      f.repository.requireDetail(change.memoryId).memory.currentRevisionId,
    ).toBe(corrected.memory.currentRevisionId);
    expect(form).toHaveBeenCalledTimes(1);
  });

  it("reflects explicit archive and restore without repeating formation", async () => {
    const f = fixture();
    const form = vi.spyOn(f.model, "form");
    const input = f.episode("我喜欢乌龙茶");
    const first = await f.form(input);
    const change = first.changes[0]!;
    f.repository.archive(change.memoryId, f.clock.now());
    expect(await f.form(input)).toMatchObject({
      changes: [],
      unavailableChanges: [change],
      replayed: true,
    });
    f.repository.restore(change.memoryId, f.clock.now());
    expect(await f.form(input)).toEqual({ ...first, replayed: true });
    expect(form).toHaveBeenCalledTimes(1);
  });

  it("keeps still-current changes when another result in the same episode is deleted", async () => {
    const f = fixture();
    const base = f.model.form.bind(f.model);
    const form = vi.fn(async (...args: Parameters<typeof base>) => {
      const batch = await base(...args);
      batch.units.push({
        ...contentUnit(batch),
        content: "第二个来源支持的合成事实",
      });
      return batch;
    });
    f.model.form = form;
    const input = f.episode("我喜欢乌龙茶，也喜欢热饮。");
    const first = await f.form(input);
    expect(first.changes).toHaveLength(2);
    const [deleted, retained] = first.changes;
    f.repository.softDelete(deleted!.memoryId, f.clock.now());
    expect(await f.form(input)).toMatchObject({
      changes: [retained],
      unavailableChanges: [deleted],
      replayed: true,
    });
    expect(form).toHaveBeenCalledTimes(1);
  });

  it("forms shared user facts and persona-specific promises from the same user source", async () => {
    const f = fixture();
    const input = f.episode(
      "我喜欢乌龙茶。你可以继续做自己的灯塔。我们约好了。",
    );
    input.personaId = f.personaId;
    const base = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(
      async (value, execution, signal) => {
        const batch = await base(value, execution, signal);
        const user = contentUnit(batch);
        user.content = "用户喜欢乌龙茶";
        user.citations[0]!.quote = "我喜欢乌龙茶。";
        const character: MemoryFormationBatch["units"][number] = {
          ...user,
          content: "用户同意当前角色继续制作它的灯塔",
          type: "event",
          semantics: {
            kind: "commitment",
            owner: "character",
            personaId: input.personaId!,
            basis: "explicit_user_statement",
            qualifiers: {},
            commitmentState: "active",
          },
          citations: [
            {
              sourceId: input.sources[0]!.id,
              quote: "你可以继续做自己的灯塔。我们约好了。",
            },
          ],
        };
        return { entities: [], units: [user, character] };
      },
    );
    f.model.form = form;
    const result = await f.form(input);
    const evidence = f.repository.recall.evidence(
      result.changes.map(({ revisionId }) => revisionId),
      f.clock.now(),
    );
    expect(
      evidence.map(({ owner, personaId }) => ({ owner, personaId })),
    ).toEqual(
      expect.arrayContaining([
        { owner: "user", personaId: undefined },
        { owner: "character", personaId: input.personaId },
      ]),
    );
    const plan = {
      purpose: "conversation" as const,
      query: "灯塔",
      questions: [{ id: "q1", text: "灯塔" }],
      personaId: randomUUID(),
      contextBudget: { maxTokens: 8000 },
    };
    expect(
      (await f.recall.recall(plan)).items.some(
        ({ owner }) => owner === "character",
      ),
    ).toBe(false);
    expect(form).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "different", "user-with-persona"] as const)(
    "rejects %s persona scope without changing the source speaker",
    async (scope) => {
      const f = fixture();
      const input = f.episode("你可以继续做自己的灯塔。");
      if (scope !== "missing") input.personaId = randomUUID();
      const base = f.model.form.bind(f.model);
      f.model.form = async (value, execution, signal) => {
        const batch = await base(value, execution, signal);
        contentUnit(batch).semantics = {
          kind: "commitment",
          basis: "explicit_user_statement",
          owner: scope === "user-with-persona" ? "user" : "character",
          personaId: randomUUID(),
          qualifiers: {},
        };
        return batch;
      };
      await expect(f.form(input)).rejects.toThrow(
        "current user or persona scope",
      );
      expect(f.repository.listRecords({})).toEqual([]);
    },
  );

  it("requires actual primary tool evidence for a completed character experience", async () => {
    const f = fixture();
    const personaId = f.personaId;
    const base = f.model.form.bind(f.model);
    f.model.form = async (value, execution, signal) => {
      const batch = await base(value, execution, signal);
      contentUnit(batch).type = "event";
      contentUnit(batch).semantics = {
        kind: "experience",
        owner: "character",
        personaId,
        basis:
          value.episode.sources[0]!.speaker === "tool"
            ? "direct_observation"
            : "explicit_user_statement",
        qualifiers: {},
      };
      return batch;
    };
    await expect(
      f.form({ ...f.episode("你已经做好灯塔了吧"), personaId }),
    ).rejects.toThrow("actual tool source");
    const actual = { ...f.episode("成功创建了灯塔物件"), personaId };
    actual.sources[0]!.type = "tool";
    actual.sources[0]!.speaker = "tool";
    expect((await f.form(actual)).changes).toHaveLength(1);
  });

  it("accepts exact contextual citations but refuses context-only formation or confirmation", async () => {
    const f = fixture();
    const primary = f.episode("今天可以继续自己的生活。");
    const context = f.episode("昨天你本来想做的灯塔弄成了吗？").sources[0]!;
    primary.sources.push(context);
    primary.evidenceSourceIds = [primary.sources[0]!.id];
    const base = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(
      async (value, execution, signal) => {
        const batch = await base(value, execution, signal);
        batch.units[0]!.citations.push({
          sourceId: context.id,
          quote: context.content,
        });
        return batch;
      },
    );
    f.model.form = form;
    const result = await f.form(primary);
    expect(
      f.repository.recall.evidence(
        result.changes.map(({ revisionId }) => revisionId),
        f.clock.now(),
      )[0]!.sourceRefs,
    ).toHaveLength(2);
    expect(form.mock.calls[0]![0].sourceCoverage).toMatchObject({
      contextSourceCount: 1,
      includedContextSourceCount: 1,
      omittedContextSourceCount: 0,
    });
    const next = { ...primary, id: randomUUID() };
    f.model.form = async (value, execution, signal) => {
      const batch = await base(value, execution, signal);
      batch.units[0]!.citations = [
        { sourceId: context.id, quote: context.content },
      ];
      return batch;
    };
    await expect(f.form(next)).rejects.toThrow(
      "this segment's primary sources",
    );
    const invalid = {
      ...primary,
      id: randomUUID(),
      evidenceSourceIds: [randomUUID()],
    };
    expect(() => f.enqueue(invalid)).toThrow("primary");
  });

  it("rejects a primary source that belongs to a different segment even within the same episode", async () => {
    const f = fixture(1800);
    const input = f.episode("第一条有完整句义的来源。".repeat(200));
    const later = f.episode("第二条来源包含另一件新事实。").sources[0]!;
    input.sources.push(later);
    input.evidenceSourceIds = input.sources.map(({ id }) => id);
    const base = f.model.form.bind(f.model);
    f.model.form = async (value, execution, signal) => {
      expect(value.episode.evidenceSourceIds).not.toContain(later.id);
      const batch = await base(value, execution, signal);
      batch.units[0]!.citations = [
        { sourceId: later.id, quote: later.content },
      ];
      return batch;
    };
    await expect(f.form(input)).rejects.toThrow("outside the current segment");
    expect(f.repository.listRecords({})).toEqual([]);
  });

  it("does not use a context speaker as new confirmation", async () => {
    const f = fixture(1800);
    const primary = f.episode("那件事可以继续。");
    const contextual = f.episode("之前用户说过喜欢茶。").sources[0]!;
    primary.sources.push(contextual);
    primary.evidenceSourceIds = [primary.sources[0]!.id];
    primary.sources[0]!.speaker = "assistant";
    const base = f.model.form.bind(f.model);
    f.model.form = async (value, execution, signal) => {
      const batch = await base(value, execution, signal);
      batch.units[0]!.citations.push({
        sourceId: contextual.id,
        quote: contextual.content,
      });
      return batch;
    };
    await expect(f.form(primary)).rejects.toThrow("actual user source");
  });

  it("keeps one proposal when another episode only adds a processing gap during formation", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    const original = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(
      async (input, execution, signal) => {
        entered.resolve();
        await release.promise;
        return original(input, execution, signal);
      },
    );
    f.model.form = form;
    const operation = f.form(f.episode("我现在喜欢乌龙茶。"));
    await entered.promise;
    f.enqueue(f.episode("另一个场景的原始经历，等待后续处理。"));
    release.resolve();
    const result = await operation;
    expect(form).toHaveBeenCalledTimes(1);
    expect(form.mock.calls[0]![0].retrievalIncompleteReasons).toEqual([]);
    expect(result.retrievalIncompleteReasons).toContain(
      "部分经历尚未形成可检索记忆",
    );
    expect(result.changes).toHaveLength(1);
    expect(f.repository.listRecords({})).toHaveLength(1);
  });

  it("compares a real fact added while the first proposal was awaiting the model", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    const original = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(
      async (input, execution, signal) => {
        if (!input.existing.length) {
          entered.resolve();
          await release.promise;
        }
        return original(input, execution, signal);
      },
    );
    f.model.form = form;
    const operation = f.form(f.episode("我现在喜欢乌龙茶。"));
    await entered.promise;
    const prior = f.repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      type: "preference",
      content: "我以前不喜欢乌龙茶。",
      confidence: 1,
      importance: 0.5,
      now: f.clock.now(),
      reason: "用户同时保存旧偏好",
      sources: [],
    });
    f.repository.recall.putSemantics(
      prior.memory.currentRevisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    release.resolve();
    const result = await operation;
    expect(form).toHaveBeenCalledTimes(2);
    expect(form.mock.calls[1]![0].existing[0]!.revisionId).toBe(
      prior.memory.currentRevisionId,
    );
    expect(result.changes[0]).toMatchObject({
      operation: "revised",
      memoryId: prior.memory.id,
    });
    expect(f.repository.listRecords({})).toHaveLength(1);
    expect(f.repository.requireDetail(prior.memory.id).revisions).toHaveLength(
      2,
    );
  });

  it("recompares new source support on the same revision but ignores question-local labels", async () => {
    const f = fixture();
    const episode = f.episode("我现在喜欢乌龙茶。");
    const first = await f.form(episode);
    const revisionId = first.changes[0]!.revisionId;
    const entered = deferred();
    const release = deferred();
    const original = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(
      async (input, execution, signal) => {
        const batch = await original(input, execution, signal);
        batch.units[0] = supportUnit(batch.units[0]!);
        if (form.mock.calls.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return batch;
      },
    );
    f.model.form = form;
    const operation = f.form({ ...episode, id: randomUUID() });
    await entered.promise;
    f.repository.attachEvidence(revisionId, [
      {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        createdAt: f.clock.now(),
      },
    ]);
    release.resolve();
    expect((await operation).changes[0]!.operation).toBe("supported");
    expect(form).toHaveBeenCalledTimes(2);
    expect(form.mock.calls[0]![0].existing[0]!.sourceCount).toBe(1);
    expect(form.mock.calls[1]![0].existing[0]!.sourceCount).toBe(2);
    form.mockClear();
    await f.form({ ...episode, id: randomUUID() });
    expect(form).toHaveBeenCalledTimes(1);
    expect(
      f.repository.requireDetail(first.changes[0]!.memoryId).revisions,
    ).toHaveLength(1);
  });

  it.each(["delete", "archive"] as const)(
    "rejects a target %s during the second model pass without committing its proposal",
    async (change) => {
      const f = fixture();
      const first = await f.form(f.episode("我喜欢咖啡。"));
      const target = first.changes[0]!;
      const entered = deferred();
      const release = deferred();
      const original = f.model.form.bind(f.model);
      const form = vi.fn<FormationModelMock["form"]>(
        async (input, execution, signal) => {
          if (input.existing.length) {
            entered.resolve();
            await release.promise;
          }
          return original(input, execution, signal);
        },
      );
      f.model.form = form;
      const operation = f.form(f.episode("我现在不喜欢咖啡。"));
      await entered.promise;
      if (change === "delete")
        f.repository.softDelete(target.memoryId, f.clock.now());
      else f.repository.archive(target.memoryId, f.clock.now());
      const before = f.repository.requireDetail(target.memoryId);
      release.resolve();
      await expect(operation).rejects.toThrow(
        "Memory revision changed while formation was running",
      );
      expect(form).toHaveBeenCalledTimes(2);
      expect(f.repository.requireDetail(target.memoryId)).toEqual(before);
    },
  );

  it.each(["second", "both"] as const)(
    "rereads %s unindexed current targets in the same attempt before any batch writes",
    async (changed) => {
      const f = fixture();
      const first = (await f.form(f.episode("我喜欢咖啡。"))).changes[0]!;
      const second = { memoryId: randomUUID(), revisionId: randomUUID() };
      f.repository.create({
        ...second,
        type: "preference",
        content: "我喜欢茶。",
        confidence: 1,
        importance: 0.5,
        sources: [],
        reason: "Independent actual target",
        now: f.clock.now(),
      });
      f.repository.recall.putSemantics(
        second.revisionId,
        {
          kind: "claim",
          owner: "user",
          basis: "explicit_user_statement",
          qualifiers: {},
        },
        [],
      );
      expect(first.memoryId).not.toBe(second.memoryId);
      const targets = [first, second];
      const input = {
        ...f.episode("这两项偏好仍然成立。"),
        availableMemoryReferences: targets.map((target) => ({
          memoryId: target.memoryId,
          revisionId: target.revisionId,
          use: "current" as const,
        })),
      };
      const entered = deferred(),
        release = deferred();
      const inputs: Parameters<FormationModelMock["form"]>[0][] = [];
      f.model.form = vi.fn<FormationModelMock["form"]>(async (value) => {
        inputs.push(value);
        if (inputs.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return {
          entities: [],
          units: targets.map(({ memoryId }) => ({
            operation: "support" as const,
            targetRevisionId: value.existing.find(
              (item) => item.memoryId === memoryId,
            )!.revisionId,
            citations: [
              {
                sourceId: value.episode.sources[0]!.id,
                quote: value.episode.sources[0]!.content,
              },
            ],
            links: [],
          })),
        };
      });
      const work = f.enqueue(input);
      const pending = f.service.form(work.workId);
      await entered.promise;
      expect(f.service.form(work.workId)).toBe(pending);
      const replacements = new Map<string, string>();
      for (const target of changed === "both" ? targets : [second]) {
        const old = f.repository.recall.evidence(
          [target.revisionId],
          f.clock.now(),
        )[0]!;
        const revisionId = randomUUID();
        f.repository.revise({
          memoryId: target.memoryId,
          predecessorRevisionId: target.revisionId,
          priorDispositions: [
            { revisionId: target.revisionId, disposition: "retained_history" },
          ],
          revisionId,
          content: `${old.content}这是另一条已确认的修订。`,
          sources: [],
          reason: "Concurrent actual repository revision",
          now: f.clock.now(),
        });
        f.repository.recall.putSemantics(
          revisionId,
          old.semantics!,
          old.entityIds,
        );
        replacements.set(target.memoryId, revisionId);
        expect(
          f.repository
            .requireDetail(target.memoryId)
            .revisions.find((row) => row.id === revisionId)!.sourceIds,
        ).toEqual([]);
      }
      expect(
        f.database.prepare("SELECT count(*) n FROM memory_search_chunks").get(),
      ).toEqual({ n: 0 });
      const writes = vi.spyOn(f.repository, "attachEvidence");
      release.resolve();
      const result = await pending;
      expect(inputs).toHaveLength(2);
      expect(
        inputs.every(
          ({ validationFeedback }) => validationFeedback === undefined,
        ),
      ).toBe(true);
      expect(inputs[0]!.existing.map(({ revisionId }) => revisionId)).toEqual(
        targets.map(({ revisionId }) => revisionId),
      );
      expect(
        inputs
          .slice(1)
          .some(({ existing }) =>
            [...replacements].every(([memoryId, revisionId]) =>
              existing.some(
                (item) =>
                  item.memoryId === memoryId && item.revisionId === revisionId,
              ),
            ),
          ),
      ).toBe(true);
      expect(writes).toHaveBeenCalledTimes(2);
      expect(result.changes.map(({ revisionId }) => revisionId)).toEqual(
        targets.map(
          (target) => replacements.get(target.memoryId) ?? target.revisionId,
        ),
      );
      for (const [memoryId, revisionId] of replacements)
        expect(inputs.at(-1)!.existing).toContainEqual(
          expect.objectContaining({ memoryId, revisionId }),
        );
      expect(f.repository.formation.work(work.workId)).toMatchObject({
        status: "complete",
        attempt: 1,
      });
      const calls = inputs.length;
      expect((await f.service.form(work.workId)).replayed).toBe(true);
      expect(inputs).toHaveLength(calls);
    },
  );

  it("retains both rebound targets despite the old second real Recall fit omission", async () => {
    const f = fixture();
    const targets = ["我偏好早晨喝咖啡。", "我偏好饭后去散步。"].map(
      (content) => {
        const detail = f.repository.create({
          memoryId: randomUUID(),
          revisionId: randomUUID(),
          type: "preference",
          content,
          confidence: 1,
          importance: 0.5,
          now: f.clock.now(),
          reason: "Actual comparison input",
          sources: [],
        });
        f.repository.recall.putSemantics(
          detail.memory.currentRevisionId,
          {
            kind: "claim",
            owner: "user",
            basis: "explicit_user_statement",
            qualifiers: {},
          },
          [],
        );
        return {
          memoryId: detail.memory.id,
          revisionId: detail.memory.currentRevisionId,
        };
      },
    );
    const prior = f.repository.recall.evidence(
      targets.map(({ revisionId }) => revisionId),
      f.clock.now(),
    );
    // The fixture boundary is derived from actual projected rows. Question
    // attribution is the only payload growth; no product budget is changed.
    const budget = estimateInputBudget(prior).estimatedTokens;
    expect(fitMemoryEvidence(prior, budget)).toHaveLength(2);
    const service = new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime(f.model),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: budget }),
      formationResourceBudget,
    );
    const input = {
      ...f.episode("这两项偏好都仍然成立。"),
      availableMemoryReferences: targets.map((target) => ({
        ...target,
        use: "current" as const,
      })),
    };
    const entered = deferred(),
      release = deferred();
    const inputs: Parameters<FormationModelMock["form"]>[0][] = [];
    const recalls: Awaited<ReturnType<MemoryRecallPipeline["recall"]>>[] = [];
    const originalRecall = f.recall.recall.bind(f.recall);
    vi.spyOn(f.recall, "recall").mockImplementation(async (...args) => {
      const result = await originalRecall(...args);
      recalls.push(result);
      return result;
    });
    f.model.form = vi.fn<FormationModelMock["form"]>(async (value) => {
      inputs.push(value);
      if (inputs.length === 1) {
        entered.resolve();
        await release.promise;
      } else if (inputs.length === 2) {
        // Index only after the actual successor reread. This uses the real
        // pipeline and its numeric fixture adapter, not a mocked fit/Pack.
        await f.recall.indexPending();
      } else return { entities: [], units: [] };
      return {
        entities: [],
        units: targets.map(({ memoryId }) => ({
          operation: "support" as const,
          targetRevisionId: value.existing.find(
            (item) => item.memoryId === memoryId,
          )!.revisionId,
          citations: [
            {
              sourceId: value.episode.sources[0]!.id,
              quote: value.episode.sources[0]!.content,
            },
          ],
          links: [],
        })),
      };
    });
    const work = service.enqueue(formationIntake(input));
    const pending = service.form(work.workId);
    await entered.promise;
    const successorIds = targets.map((target, position) => {
      const revisionId = randomUUID();
      f.repository.revise({
        ...target,
        predecessorRevisionId: target.revisionId,
        revisionId,
        priorDispositions: [
          { revisionId: target.revisionId, disposition: "retained_history" },
        ],
        content: position === 0 ? "我偏好中午喝咖啡。" : "我偏好午后去散步。",
        sources: [],
        reason: "Concurrent current revision",
        now: f.clock.now(),
      });
      f.repository.recall.putSemantics(
        revisionId,
        prior[position]!.semantics!,
        [],
      );
      return revisionId;
    });
    const successors = f.repository.recall.evidence(
      successorIds,
      f.clock.now(),
    );
    expect(fitMemoryEvidence(successors, budget)).toHaveLength(2);
    const writes = vi.spyOn(f.repository, "attachEvidence");
    release.resolve();
    const result = await pending;
    expect(result.changes.map((item) => item.revisionId)).toEqual(successorIds);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.existing.map(({ revisionId }) => revisionId)).toEqual(
      successorIds,
    );
    const pack = recalls.at(-1)!;
    expect(pack.items.length).toBeGreaterThan(0);
    expect(
      pack.items.every(({ questionIds }) => questionIds.length === 2),
    ).toBe(true);
    const compared = [
      ...new Map(
        [...inputs[1]!.existing, ...pack.items].map((item) => [
          item.revisionId,
          item,
        ]),
      ).values(),
    ];
    expect(fitMemoryEvidence(compared, budget)).toHaveLength(1);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(f.repository.listRecords({})).toHaveLength(2);
    expect(f.repository.formation.work(work.workId)).toMatchObject({
      status: "complete",
      attempt: 1,
    });
  });

  it("retains the actual F1 active baseline when a revision changes during Recall before F2", async () => {
    const f = fixture();
    const target = (await f.form(f.episode("我喜欢咖啡。"))).changes[0]!;
    const other = { memoryId: randomUUID(), revisionId: randomUUID() };
    f.repository.create({
      ...other,
      type: "preference",
      content: "我还喜欢散步。",
      confidence: 1,
      importance: 0.5,
      sources: [],
      reason: "Independent Recall target",
      now: f.clock.now(),
    });
    f.repository.recall.putSemantics(
      other.revisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    const input = {
      ...f.episode("现在再确认这项饮品偏好。"),
      availableMemoryReferences: [
        {
          memoryId: target.memoryId,
          revisionId: target.revisionId,
          use: "current" as const,
        },
      ],
    };
    const entered = deferred(),
      release = deferred();
    const originalRecall = f.recall.recall.bind(f.recall);
    vi.spyOn(f.recall, "recall").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      const result = await originalRecall(...args);
      // A different real, current record makes the supplied comparison change.
      // This is a held Recall boundary test, not a retrieval-quality fixture.
      return {
        ...result,
        items: f.repository.recall.evidence([other.revisionId], f.clock.now()),
      };
    });
    const form = vi.fn<FormationModelMock["form"]>(
      ({ episode: value, existing }) =>
        Promise.resolve({
          entities: [],
          units: [
            {
              operation: "support",
              targetRevisionId: existing.find(
                ({ memoryId }) => memoryId === target.memoryId,
              )!.revisionId,
              citations: [
                {
                  sourceId: value.sources[0]!.id,
                  quote: value.sources[0]!.content,
                },
              ],
              links: [],
            },
          ],
        }),
    );
    f.model.form = form;
    const work = f.enqueue(input);
    const pending = f.service.form(work.workId);
    await entered.promise;
    const old = f.repository.recall.evidence(
      [target.revisionId],
      f.clock.now(),
    )[0]!;
    const replacementId = randomUUID();
    f.repository.revise({
      memoryId: target.memoryId,
      predecessorRevisionId: target.revisionId,
      priorDispositions: [
        { revisionId: target.revisionId, disposition: "retained_history" },
      ],
      revisionId: replacementId,
      content: "现在我选择低因咖啡。",
      sources: [],
      reason: "Concurrent update during Recall",
      now: f.clock.now(),
    });
    f.repository.recall.putSemantics(
      replacementId,
      old.semantics!,
      old.entityIds,
    );
    const writes = vi.spyOn(f.repository, "attachEvidence");
    release.resolve();
    const result = await pending;
    expect(form).toHaveBeenCalledTimes(2);
    // The old actual F1 baseline is rejected after Recall, before obsolete F2.
    expect(form.mock.calls[1]![0].existing).toContainEqual(
      expect.objectContaining({ revisionId: replacementId }),
    );
    expect(writes).toHaveBeenCalledOnce();
    expect(result.changes).toEqual([
      {
        memoryId: target.memoryId,
        revisionId: replacementId,
        operation: "supported",
      },
    ]);
    expect(f.repository.formation.work(work.workId)).toMatchObject({
      status: "complete",
      attempt: 1,
    });
  });

  it.each(["revise", "support"] as const)(
    "does not classify a repeated revise plus %s proposal as an external revision change",
    async (operation) => {
      const f = fixture();
      const target = (await f.form(f.episode("我喜欢咖啡。"))).changes[0]!;
      const input = {
        ...f.episode("我改成只在早上喝咖啡。"),
        availableMemoryReferences: [
          {
            memoryId: target.memoryId,
            revisionId: target.revisionId,
            use: "current" as const,
          },
        ],
      };
      const original = f.model.form.bind(f.model);
      const form = vi.fn<FormationModelMock["form"]>(async (...args) => {
        const batch = await original(...args);
        batch.units.push(
          operation === "support"
            ? supportUnit(batch.units[0]!)
            : structuredClone(batch.units[0]!),
        );
        return batch;
      });
      f.model.form = form;
      const before = f.repository.requireDetail(target.memoryId);
      const work = f.enqueue(input);
      await expect(f.service.form(work.workId)).rejects.toThrow(
        "only update to its Memory",
      );
      expect(form).toHaveBeenCalledTimes(2);
      expect(form.mock.calls[1]![0].validationFeedback).toBeDefined();
      expect(f.repository.requireDetail(target.memoryId)).toEqual(before);
      expect(f.repository.formation.work(work.workId)).toMatchObject({
        status: "failed",
        attempt: 1,
      });
    },
  );

  it("keeps repeated pure support legal without creating another revision", async () => {
    const f = fixture();
    const target = (await f.form(f.episode("我喜欢咖啡。"))).changes[0]!;
    const original = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(async (...args) => {
      const batch = await original(...args);
      const unit = supportUnit(batch.units[0]!);
      return { entities: batch.entities, units: [unit, structuredClone(unit)] };
    });
    f.model.form = form;
    const result = await f.form({
      ...f.episode("我仍然喜欢咖啡。"),
      availableMemoryReferences: [
        {
          memoryId: target.memoryId,
          revisionId: target.revisionId,
          use: "current",
        },
      ],
    });
    expect(form).toHaveBeenCalledOnce();
    expect(result.changes).toHaveLength(2);
    expect(
      result.changes.every(
        (item) =>
          item.revisionId === target.revisionId &&
          item.operation === "supported",
      ),
    ).toBe(true);
    expect(f.repository.requireDetail(target.memoryId).revisions).toHaveLength(
      1,
    );
  });

  it("does not repeatedly reprepare an already historical target with no new version change", async () => {
    const f = fixture();
    const target = (await f.form(f.episode("以前我喜欢咖啡。"))).changes[0]!;
    const old = f.repository.recall.evidence(
      [target.revisionId],
      f.clock.now(),
    )[0]!;
    const revisionId = randomUUID();
    f.repository.revise({
      memoryId: target.memoryId,
      predecessorRevisionId: target.revisionId,
      priorDispositions: [
        { revisionId: target.revisionId, disposition: "retained_history" },
      ],
      revisionId,
      content: "现在我更喜欢茶。",
      sources: [],
      reason: "Earlier completed update",
      now: f.clock.now(),
    });
    f.repository.recall.putSemantics(revisionId, old.semantics!, old.entityIds);
    const form = vi.fn<FormationModelMock["form"]>(({ episode: value }) =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: "support",
            targetRevisionId: target.revisionId,
            citations: [
              {
                sourceId: value.sources[0]!.id,
                quote: value.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      }),
    );
    f.model.form = form;
    const input = {
      ...f.episode("回顾过去，我确实喜欢过咖啡。"),
      availableMemoryReferences: [
        {
          memoryId: target.memoryId,
          revisionId: target.revisionId,
          use: "history" as const,
        },
      ],
    };
    const work = f.enqueue(input);
    const before = f.repository.requireDetail(target.memoryId);
    await expect(f.service.form(work.workId)).rejects.toThrow(
      "active current revision in this model input",
    );
    expect(form).toHaveBeenCalledTimes(3);
    expect(
      form.mock.calls.map(([value]) => Boolean(value.validationFeedback)),
    ).toEqual([false, false, true]);
    expect(
      form.mock.calls.every(([value]) =>
        value.existing.some(
          (item) =>
            item.revisionId === target.revisionId && item.current === false,
        ),
      ),
    ).toBe(true);
    expect(
      form.mock.calls.at(-1)![0].validationFeedback!.proposal.units[0]!
        .targetRevisionId,
    ).toBe(target.revisionId);
    expect(f.repository.requireDetail(target.memoryId)).toEqual(before);
    expect(f.repository.formation.work(work.workId)).toMatchObject({
      status: "failed",
      attempt: 1,
    });
  });

  it("retains raw ActivityEvent identity and exact observation spans through formation and recall", async () => {
    const f = fixture();
    const original = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await original(input, execution, signal);
      contentUnit(batch).type = "event";
      contentUnit(batch).semantics.kind = "episode";
      contentUnit(batch).semantics.basis = "direct_observation";
      return batch;
    };
    const episode = f.episode("浏览器显示茶叶介绍页面。", "environment");
    const source = episode.sources[0]!;
    source.type = "activity_event";
    source.referenceId = source.id;
    const result = await f.form(episode);
    const detail = f.repository.requireDetail(result.changes[0]!.memoryId);
    expect(detail.revisions[0]!.sourceType).toBe("activity_event");
    expect(detail.sources).toEqual([
      {
        id: source.id,
        referenceId: source.id,
        type: "activity_event",
        createdAt: source.occurredAt,
      },
    ]);
    const pack = await f.recall.recall({
      purpose: "conversation",
      query: "茶叶介绍页面",
      questions: [{ id: "page", text: "浏览器显示了什么？" }],
      owner: "user",
      contextBudget: { maxTokens: 8000 },
    });
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]!.sourceRefs).toEqual([
      {
        sourceId: source.id,
        referenceId: source.id,
        type: "activity_event",
        spans: [
          { start: 0, end: source.content.length, quote: source.content },
        ],
      },
    ]);
    expect(pack.items[0]!.basis).toBe("direct_observation");
  });

  it("compares prior source-backed claims before extraction without discarding other facts from the same source", async () => {
    const f = fixture();
    const episode = f.episode("我喜欢手冲咖啡，也会弹钢琴。");
    const source = episode.sources[0]!;
    const unit = (
      content: string,
      predicate: string,
      quote: string,
    ): ContentUnit => ({
      operation: "create",
      content,
      type: "profile",
      semantics: {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        predicate,
        qualifiers: {},
      },
      entityKeys: [],
      citations: [{ sourceId: source.id, quote }],
      links: [],
    });
    const coffee = unit("用户偏好手冲饮品。", "prefers", "我喜欢手冲咖啡");
    const piano = unit("用户能够演奏键盘乐器钢琴。", "can_play", "会弹钢琴");
    f.model.form = () => Promise.resolve({ entities: [], units: [coffee] });
    const first = await f.form(episode);
    const form = vi.fn<FormationModelMock["form"]>(({ existing }) => {
      const units = [coffee, piano].map((proposal) => {
        const target = existing.find(
          (item) => item.semantics?.predicate === proposal.semantics.predicate,
        );
        return target
          ? {
              operation: "support" as const,
              targetRevisionId: target.revisionId,
              citations: proposal.citations,
              links: proposal.links,
            }
          : proposal;
      });
      return Promise.resolve({ entities: [], units });
    });
    f.model.form = form;
    const second = await f.form({ ...episode, id: randomUUID() });
    expect(
      form.mock.calls[0]![0].existing.map(({ revisionId }) => revisionId),
    ).toEqual([first.changes[0]!.revisionId]);
    expect(second.changes.map(({ operation }) => operation)).toEqual([
      "supported",
      "created",
    ]);
    form.mockClear();
    const closure = await f.form({ ...episode, id: randomUUID() });
    expect(form.mock.calls[0]![0].existing).toHaveLength(2);
    expect(closure.changes.map(({ operation }) => operation)).toEqual([
      "supported",
      "supported",
    ]);
    expect(f.repository.listRecords({})).toHaveLength(2);
    for (const record of f.repository.listRecords({})) {
      const detail = f.repository.requireDetail(record.id);
      expect(detail.revisions).toHaveLength(1);
      expect(detail.sources).toHaveLength(1);
    }
    expect(
      f.database
        .prepare("SELECT COUNT(*) n FROM memory_revision_source_spans")
        .get(),
    ).toMatchObject({ n: 2 });
    expect(f.repository.recall.indexIncomplete("numeric-adapter-fixture")).toBe(
      true,
    );
  });

  it("locates the corrected current revision when an old episode reuses its original source", async () => {
    const f = fixture();
    const original = f.episode("我喜欢咖啡。");
    const first = await f.form(original);
    const correction = await f.form(f.episode("我现在喜欢茶，不再喜欢咖啡。"));
    expect(correction.changes[0]!.memoryId).toBe(first.changes[0]!.memoryId);
    const form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [] }),
    );
    f.model.form = form;
    await f.form({ ...original, id: randomUUID() });
    expect(
      form.mock.calls[0]![0].existing.map(({ revisionId }) => revisionId),
    ).toEqual([correction.changes[0]!.revisionId]);
    expect(form.mock.calls[0]![0].existing[0]!.content).toBe(
      "我现在喜欢茶，不再喜欢咖啡。",
    );
  });

  it("retains complete necessary source comparisons beyond the original segment allocation", async () => {
    const f = fixture(1600);
    const episode = f.episode("我有几件长期重要的事情想记录。");
    const original = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await original(input, execution, signal);
      batch.units = Array.from({ length: 8 }, (_, index) => ({
        ...contentUnit(batch),
        content: `${String(index)}：${"原始事情的完整背景。".repeat(20)}`,
      }));
      return batch;
    };
    await f.form(episode);
    const form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [] }),
    );
    f.model.form = form;
    const result = await f.form({ ...episode, id: randomUUID() });
    const comparison = form.mock.calls[0]![0];
    expect(comparison.existing).toHaveLength(8);
    expect(
      estimateInputBudget(comparison.existing).estimatedTokens,
    ).toBeGreaterThan(1600);
    expect(comparison.retrievalIncompleteReasons).not.toContain(
      "部分同来源记忆未能放入本次形成比较预算",
    );
    expect(result.retrievalIncompleteReasons).not.toContain(
      "部分同来源记忆未能放入本次形成比较预算",
    );
    expect(
      f.measuredRequests.every((request) =>
        fitsInputBudget(estimateInputBudget(request), 258_000),
      ),
    ).toBe(true);
  });

  it("creates and revises mixed-source memories while retaining each exact provenance", async () => {
    const f = fixture();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      batch.units[0]!.citations = input.episode.sources.map((source) => ({
        sourceId: source.id,
        quote: source.content,
      }));
      return batch;
    };
    const episode = f.episode("我想把这次查到的凉菜成分记清楚。");
    episode.sources.push({
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "tool",
      speaker: "tool",
      content: "查询回执：凉菜含花生，未订位。",
      occurredAt: f.clock.now(),
    });
    const first = await f.form(episode);
    const initial = f.repository.requireDetail(first.changes[0]!.memoryId);
    expect(initial.revisions[0]!.sourceType).toBe("distillation");
    expect(initial.sources.map(({ type }) => type).sort()).toEqual([
      "chat",
      "tool",
    ]);
    expect(initial.sources.map(({ id }) => id).sort()).toEqual(
      episode.sources.map(({ id }) => id).sort(),
    );
    const next = {
      ...episode,
      id: randomUUID(),
      sources: episode.sources.map((source) => ({
        ...source,
        id: randomUUID(),
        referenceId: randomUUID(),
      })),
    };
    const revised = await f.form(next);
    expect(revised.changes[0]!.memoryId).toBe(initial.memory.id);
    const detail = f.repository.requireDetail(initial.memory.id);
    expect(detail.revisions).toHaveLength(2);
    expect(detail.revisions.map(({ sourceType }) => sourceType)).toEqual([
      "distillation",
      "distillation",
    ]);
    expect(detail.sources).toHaveLength(4);
    expect(
      f.database
        .prepare("SELECT COUNT(*) n FROM memory_revision_source_spans")
        .get(),
    ).toMatchObject({ n: 4 });
  });
  it("accepts corroboration from another channel without relabeling the original sources", async () => {
    const f = fixture();
    const episode = f.episode("我喜欢咖啡。");
    const first = await f.form(episode);
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      if (input.existing.length) batch.units[0] = supportUnit(batch.units[0]!);
      return batch;
    };
    const next = f.episode("我喜欢咖啡。");
    next.sources[0]!.type = "voice";
    const result = await f.form(next);
    expect(result.changes[0]!.revisionId).toBe(first.changes[0]!.revisionId);
    const detail = f.repository.requireDetail(first.changes[0]!.memoryId);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]!.sourceType).toBe("distillation");
    expect(detail.sources.map(({ type }) => type).sort()).toEqual([
      "chat",
      "voice",
    ]);
  });

  it.each(["type", "referenceId", "occurredAt"] as const)(
    "rejects explicit changed %s registration for an attached source ID",
    async (field) => {
      const f = fixture();
      const episode = f.episode("我喜欢咖啡。");
      const first = await f.form(episode);
      const original = f.model.form.bind(f.model);
      f.model.form = async (input, execution, signal) => {
        const batch = await original(input, execution, signal);
        if (input.existing.length)
          batch.units[0] = supportUnit(batch.units[0]!);
        return batch;
      };
      const source = { ...episode.sources[0]! };
      if (field === "type") source.type = "voice";
      else if (field === "referenceId") source.referenceId = randomUUID();
      else source.occurredAt = "2026-09-16T12:00:00.000Z";
      expect(() => f.repository.formation.registerSource(source)).toThrow(
        "reused",
      );
      const detail = f.repository.requireDetail(first.changes[0]!.memoryId);
      expect(detail.revisions).toHaveLength(1);
      expect(detail.sources).toHaveLength(1);
      expect(detail.sources[0]!).toMatchObject({
        type: "chat",
        referenceId: episode.sources[0]!.referenceId,
        createdAt: episode.sources[0]!.occurredAt,
      });
    },
  );
  it("commits segmented recording without draining any historical vector work", async () => {
    const f = fixture(1600);
    await f.form(f.episode("历史记录仍等待索引。"));
    const index = vi
      .spyOn(f.recall, "indexPending")
      .mockRejectedValue(new Error("record must not drain the global queue"));
    const result = await f.form(
      f.episode("这是一段新的原始经历。\n".repeat(200)),
    );
    expect(
      result.changes.length + (result.unavailableChanges?.length ?? 0),
    ).toBeGreaterThan(1);
    expect(result.changes).toHaveLength(1);
    expect(result.unavailableChanges?.length).toBeGreaterThan(0);
    expect(index).not.toHaveBeenCalled();
    expect(f.repository.recall.indexIncomplete("numeric-adapter-fixture")).toBe(
      true,
    );
    expect(result.retrievalIncompleteReasons?.join(" ")).toContain(
      "语义索引尚未完成",
    );
  });

  it("keeps proposed entities as candidates without filtering another named person's comparison", async () => {
    const f = fixture();
    let phase: "user" | "sister" | "visit" = "user";
    const visitInputs: Parameters<FormationModelMock["form"]>[0][] = [];
    f.model.form = (input) => {
      if (phase === "visit") visitInputs.push(structuredClone(input));
      const user = input.entities.find(({ name }) => name === "用户");
      const sister = input.entities.find(({ name }) => name === "陈晴");
      const entities: MemoryFormationBatch["entities"] =
        phase === "user"
          ? [{ key: "self", name: "用户", kind: "person", aliases: [] }]
          : phase === "sister"
            ? [{ key: "sister", name: "陈晴", kind: "person", aliases: [] }]
            : [
                {
                  key: "self",
                  name: "用户",
                  kind: "person",
                  aliases: [],
                  ...(user ? { existingId: user.id } : {}),
                },
                {
                  key: "sister",
                  name: sister ? "陈晴" : "用户的妹妹",
                  kind: "person",
                  aliases: ["妹妹"],
                  ...(sister ? { existingId: sister.id } : {}),
                },
              ];
      return Promise.resolve({
        entities,
        units: [
          {
            operation: "create",
            type: phase === "visit" ? "event" : "profile",
            content:
              phase === "user"
                ? "苏州住所"
                : phase === "sister"
                  ? "陈晴对乳制品过敏，黄油也不能吃。"
                  : "妹妹周末来访，下午茶要避开黄油。",
            entityKeys: entities.map(({ key }) => key),
            citations: [
              {
                sourceId: input.episode.sources[0]!.id,
                quote: input.episode.sources[0]!.content,
              },
            ],
            links: [],
            semantics: {
              kind: phase === "visit" ? "episode" : "claim",
              owner: "user",
              basis: "explicit_user_statement",
              qualifiers: {},
              subjectEntityId: phase === "sister" ? "sister" : "self",
              predicate:
                phase === "user"
                  ? "residence"
                  : phase === "sister"
                    ? "food_allergy"
                    : "plans_visit",
              ...(phase === "visit" ? { objectEntityId: "sister" } : {}),
            },
          },
        ],
      });
    };
    const residence = await f.form(f.episode("我目前住在苏州。"));
    phase = "sister";
    const allergy = await f.form(
      f.episode("我的妹妹陈晴对乳制品过敏，黄油也不能吃。"),
    );
    const userId = f.repository.recall.resolveEntityNames(["用户"])[0]!;
    const sisterId = f.repository.recall.resolveEntityNames(["陈晴"])[0]!;
    expect(userId).not.toBe(sisterId);
    expect(f.repository.recall.resolveEntityNames(["用户的妹妹"])).toEqual([]);
    expect(
      f.database.prepare("SELECT count(*) n FROM memory_search_chunks").get(),
    ).toEqual({ n: 0 });
    const question: Parameters<MemoryRecallPipeline["recall"]>[0] = {
      purpose: "formation",
      query: "",
      questions: [{ id: "q", text: "下午茶要避开黄油" }],
      contextBudget: { maxTokens: 8000 },
    };
    expect(
      f.repository.recall.lexical("黄油", question, 10, f.clock.now()),
    ).toContain(allergy.changes[0]!.revisionId);
    const recall = vi.spyOn(f.recall, "recall");
    phase = "visit";
    const result = await f.form(f.episode("妹妹周末来访，下午茶要避开黄油。"));
    const final = visitInputs.at(-1)!;
    // Both persisted facts must reach the same F2, including the structural
    // residence candidate despite absent lexical overlap and pending vectors.
    expect(final.existing.map(({ revisionId }) => revisionId)).toEqual(
      expect.arrayContaining([
        residence.changes[0]!.revisionId,
        allergy.changes[0]!.revisionId,
      ]),
    );
    expect(visitInputs).toHaveLength(2);
    expect(visitInputs[0]!.existing).toEqual([]);
    expect(final.entities).toContainEqual(
      expect.objectContaining({ id: sisterId, name: "陈晴" }),
    );
    expect(recall).toHaveBeenCalledTimes(1);
    const detail = f.repository.requireDetail(result.changes[0]!.memoryId);
    expect(
      f.repository.recall.evidence(
        [detail.memory.currentRevisionId],
        f.clock.now(),
      )[0]!.semantics!.objectEntityId,
    ).toBe(sisterId);
    expect(f.repository.recall.resolveEntityNames(["用户的妹妹"])).toEqual([]);
    expect(f.repository.recall.resolveEntityNames(["妹妹"])).toEqual([
      sisterId,
    ]);
    expect(result.retrievalIncompleteReasons?.join(" ")).toContain(
      "语义索引尚未完成",
    );
  });

  it("uses pending entity metadata to revise the same field without lexical overlap or duplicate creation", async () => {
    const f = fixture();
    const inputs: Parameters<FormationModelMock["form"]>[0][] = [];
    f.model.form = (input) => {
      inputs.push(input);
      const changed = input.episode.sources[0]!.content.includes("杭州");
      const prior = input.existing[0];
      const existingEntity = input.entities.find(
        (entity) => entity.name === "用户",
      );
      return Promise.resolve({
        entities: [
          {
            key: "self",
            name: "用户",
            kind: "person",
            aliases: [],
            ...(existingEntity ? { existingId: existingEntity.id } : {}),
          },
        ],
        units: [
          {
            operation: prior ? "revise" : "create",
            ...(prior
              ? {
                  targetRevisionId: prior.revisionId,
                  retainedCitations: [],
                  priorDispositions: [
                    {
                      scope: "revision",
                      revisionId: prior.revisionId,
                      disposition: "retained_history",
                      sourceId: input.episode.sources[0]!.id,
                      quote: input.episode.sources[0]!.content,
                    },
                  ],
                }
              : {}),
            content: changed ? "杭州现居" : "苏州住所",
            type: "profile",
            semantics: {
              kind: "claim",
              owner: "user",
              basis: "explicit_user_statement",
              subjectEntityId: "self",
              predicate: "residence",
              objectValue: changed ? "杭州" : "苏州",
              qualifiers: {},
            },
            entityKeys: ["self"],
            citations: [
              {
                sourceId: input.episode.sources[0]!.id,
                quote: input.episode.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      });
    };
    const first = await f.form(f.episode("我当前居住在苏州。"));
    expect(
      f.repository.recall.lexical(
        "杭州现居",
        {
          purpose: "formation",
          query: "",
          questions: [],
          contextBudget: { maxTokens: 8000 },
        },
        10,
        f.clock.now(),
      ),
    ).toEqual([]);
    const changed = await f.form(f.episode("我改成住杭州了。"));
    expect(changed.changes[0]).toMatchObject({
      operation: "revised",
      memoryId: first.changes[0]!.memoryId,
    });
    expect(f.repository.listRecords({})).toHaveLength(1);
    expect(inputs.at(-1)?.existing[0]?.content).toBe("苏州住所");
    expect(inputs.at(-1)?.retrievalIncompleteReasons?.join(" ")).toContain(
      "语义索引尚未完成",
    );
    expect(changed.retrievalIncompleteReasons?.join(" ")).toContain(
      "语义索引尚未完成",
    );
  });

  it("refuses an exact duplicate create when the existing fact is already supplied", async () => {
    const f = fixture();
    await f.form(f.episode("我喜欢咖啡。"));
    const original = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await original(input, execution, signal);
      batch.units[0]!.operation = "create";
      delete batch.units[0]!.targetRevisionId;
      delete contentUnit(batch).priorDispositions;
      delete contentUnit(batch).retainedCitations;
      return batch;
    };
    await expect(f.form(f.episode("我喜欢咖啡。"))).rejects.toThrow(
      "requires support instead of duplicate",
    );
    expect(f.repository.listRecords({})).toHaveLength(1);
  });

  it("persists source spans, semantic classification, FTS and pending vectors together and replays idempotently", async () => {
    const f = fixture();
    const episode = f.episode("我现在喜欢乌龙茶。");
    const result = await f.form(episode);
    expect(result.changes).toHaveLength(1);
    expect(result.retrievalIncompleteReasons).toEqual([]);
    expect((await f.form(episode)).changes).toEqual(result.changes);
    expect(vi.mocked(f.model).form.mock.calls).toHaveLength(1);
    const evidence = f.repository.recall.evidence(
      [result.changes[0]!.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence.basis).toBe("explicit_user_statement");
    expect(evidence.sourceRefs[0]?.spans).toEqual([
      {
        start: 0,
        end: episode.sources[0]!.content.length,
        quote: episode.sources[0]!.content,
      },
    ]);
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='embed'")
        .get(),
    ).toMatchObject({ status: "pending" });
    expect(
      f.database.prepare("SELECT COUNT(*) n FROM memory_fts").get(),
    ).toMatchObject({ n: 1 });
  });

  it("compares real prior evidence and creates a revision instead of conflicting active facts", async () => {
    const f = fixture();
    const first = await f.form(f.episode("我喜欢咖啡。"));
    await f.recall.indexPending();
    const changed = await f.form(f.episode("我现在改喝乌龙茶，不喝咖啡了。"));
    expect(changed.changes[0]?.operation).toBe("revised");
    expect(changed.changes[0]?.memoryId).toBe(first.changes[0]?.memoryId);
    expect(
      f.repository.requireDetail(first.changes[0]!.memoryId).revisions,
    ).toHaveLength(2);
    expect(
      f.database
        .prepare(
          "SELECT predecessor_revision_id,prior_dispositions_json FROM memory_revisions WHERE id=?",
        )
        .get(changed.changes[0]!.revisionId),
    ).toEqual({
      predecessor_revision_id: first.changes[0]!.revisionId,
      prior_dispositions_json: JSON.stringify([
        { revisionId: first.changes[0]!.revisionId, disposition: "unresolved" },
      ]),
    });
    expect(
      f.repository.recall.evidence(
        [first.changes[0]!.revisionId],
        f.clock.now(),
      )[0]?.current,
    ).toBe(false);
  });

  it("refuses assistant repetition as user evidence and observed activity as a confirmed preference", async () => {
    const f = fixture();
    await expect(f.form(f.episode("你喜欢茶", "assistant"))).rejects.toThrow(
      "actual user source",
    );
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      contentUnit(batch).semantics.basis = "direct_observation";
      return batch;
    };
    for (const type of ["activity", "activity_event"] as const) {
      const observation = f.episode("打开了一页茶叶介绍", "environment");
      observation.sources[0]!.type = type;
      await expect(f.form(observation)).rejects.toThrow("cannot establish");
    }
    expect(
      f.database.prepare("SELECT COUNT(*) n FROM memories").get(),
    ).toMatchObject({ n: 0 });
  });

  it("keeps inferred reflections distinct and cannot overwrite explicit facts", async () => {
    const f = fixture();
    const first = await f.form(f.episode("我喜欢咖啡。"));
    await f.recall.indexPending();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      contentUnit(batch).semantics = {
        kind: "reflection",
        basis: "inference",
        owner: "user",
        qualifiers: {},
      };
      return batch;
    };
    await expect(
      f.form(f.episode("看起来也许不太喜欢咖啡", "assistant")),
    ).rejects.toThrow("cannot overwrite");
    expect(
      f.repository.requireDetail(first.changes[0]!.memoryId).revisions,
    ).toHaveLength(1);
    f.model.form = ({ episode }) =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: "create",
            content: "我猜他可能对试新口味有兴趣",
            type: "event",
            semantics: {
              kind: "reflection",
              basis: "inference",
              owner: "user",
              qualifiers: {},
            },
            entityKeys: [],
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
    const reflected = await f.form(f.episode("也许下次试试新口味"));
    expect(
      f.repository.recall.evidence(
        [reflected.changes[0]!.revisionId],
        f.clock.now(),
      )[0]?.basis,
    ).toBe("inference");
  });

  it("enriches a reported event with actual observed content while preserving both original sources", async () => {
    const f = fixture();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      const unit = contentUnit(batch);
      unit.type = "event";
      unit.semantics.kind = "episode";
      if (input.existing.length) {
        unit.content = "用户此前报告收到通知；现在屏幕呈现申请未通过的正文。";
        unit.semantics.basis = "direct_observation";
        unit.semantics.qualifiers = {
          evidence_scope: "收到通知由用户报告；通知正文来自当前实际观察",
        };
        unit.citations = input.episode.sources.map((source) => ({
          sourceId: source.id,
          quote: source.content,
        }));
      }
      return batch;
    };
    const report = f.episode("我刚收到一封通知。");
    const first = await f.form(report);
    const observation = f.episode("通知正文：申请未通过。", "environment");
    observation.sources[0]!.type = "activity_event";
    observation.evidenceSourceIds = [observation.sources[0]!.id];
    observation.sources.push(report.sources[0]!);
    const updated = await f.form(observation);
    expect(updated.changes).toHaveLength(1);
    expect(updated.changes[0]).toMatchObject({
      memoryId: first.changes[0]!.memoryId,
      operation: "revised",
    });
    const detail = f.repository.requireDetail(first.changes[0]!.memoryId);
    expect(detail.revisions).toHaveLength(2);
    const evidence = f.repository.recall.evidence(
      [updated.changes[0]!.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence.basis).toBe("direct_observation");
    expect(evidence.sourceRefs.map(({ sourceId }) => sourceId).sort()).toEqual(
      observation.sources.map(({ id }) => id).sort(),
    );
    expect(
      f.repository.recall.evidence(
        [first.changes[0]!.revisionId],
        f.clock.now(),
      )[0]?.basis,
    ).toBe("explicit_user_statement");
  });

  it("does not use a later interpretation to replace a directly observed event", async () => {
    const f = fixture();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      const unit = contentUnit(batch);
      unit.type = "event";
      unit.semantics.kind = input.existing.length ? "reflection" : "episode";
      unit.semantics.basis = input.existing.length
        ? "inference"
        : "direct_observation";
      return batch;
    };
    const observation = f.episode("工具报告纸灯笼已放置。", "environment");
    const first = await f.form(observation);
    const interpretation = f.episode("也许纸灯笼并没有放置。", "assistant");
    interpretation.evidenceSourceIds = [interpretation.sources[0]!.id];
    interpretation.sources.push(observation.sources[0]!);
    await expect(f.form(interpretation)).rejects.toThrow("cannot overwrite");
    expect(
      f.repository.requireDetail(first.changes[0]!.memoryId).revisions,
    ).toHaveLength(1);
  });

  it("keeps a manual user correction ahead of later observation-based revision", async () => {
    const f = fixture();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      contentUnit(batch).type = "event";
      contentUnit(batch).semantics.kind = "episode";
      if (input.existing.length)
        contentUnit(batch).semantics.basis = "direct_observation";
      return batch;
    };
    const report = f.episode("通知不属于我。");
    const first = await f.form(report);
    const manualRevisionId = randomUUID();
    f.repository.revise({
      memoryId: first.changes[0]!.memoryId,
      predecessorRevisionId: f.repository.requireDetail(
        first.changes[0]!.memoryId,
      ).memory.currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(first.changes[0]!.memoryId)
            .memory.currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: manualRevisionId,
      content: "用户手动纠正：这封通知属于别人。",
      reason: "User correction",
      sources: [],
      now: f.clock.now(),
    });
    f.repository.recall.putSemantics(
      manualRevisionId,
      {
        kind: "claim",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: { authoring: "user_edit" },
      },
      [],
    );
    const observation = f.episode("屏幕上有申请未通过的通知。", "environment");
    observation.evidenceSourceIds = [observation.sources[0]!.id];
    observation.sources.push(report.sources[0]!);
    await expect(f.form(observation)).rejects.toThrow("manual user correction");
    expect(
      f.repository.requireDetail(first.changes[0]!.memoryId).revisions,
    ).toHaveLength(2);
  });

  it("resolves a unique exact quote even when a redundant occurrence was supplied", async () => {
    const f = fixture();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      batch.units[0]!.citations[0] = {
        sourceId: input.episode.sources[0]!.id,
        quote: "我通关了",
        occurrence: 1,
      };
      return batch;
    };
    const result = await f.form(f.episode("今天我通关了，可以聊结局。"));
    const evidence = f.repository.recall.evidence(
      [result.changes[0]!.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence.sourceRefs[0]!.spans).toEqual([
      { start: 2, end: 6, quote: "我通关了" },
    ]);
  });
  it.each([
    { occurrence: undefined, start: undefined, error: "explicit occurrence" },
    { occurrence: 0, start: 0, error: undefined },
    { occurrence: 1, start: 5, error: undefined },
    { occurrence: 2, start: undefined, error: "outside its source" },
  ])(
    "disambiguates repeated quotes with zero-based occurrence $occurrence",
    async ({ occurrence, start, error }) => {
      const f = fixture();
      const base = f.model.form.bind(f.model);
      f.model.form = async (input, execution, signal) => {
        const batch = await base(input, execution, signal);
        batch.units[0]!.citations[0] = {
          sourceId: input.episode.sources[0]!.id,
          quote: "我喜欢茶。",
          ...(occurrence === undefined ? {} : { occurrence }),
        };
        return batch;
      };
      const action = f.form(f.episode("我喜欢茶。我喜欢茶。"));
      if (error) {
        await expect(action).rejects.toThrow(error);
        expect(f.repository.listRecords({})).toHaveLength(0);
      } else {
        const result = await action;
        const evidence = f.repository.recall.evidence(
          [result.changes[0]!.revisionId],
          f.clock.now(),
        )[0]!;
        expect(evidence.sourceRefs[0]!.spans).toEqual([
          { start, end: start! + 5, quote: "我喜欢茶。" },
        ]);
      }
    },
  );
  it("restores the original source offset for unique quotes inside budgeted fragments", async () => {
    const f = fixture(1600);
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      batch.units[0]!.citations[0]!.occurrence = 1;
      return batch;
    };
    const episode = f.episode("这一次来源段落内容。\n".repeat(180));
    const segments = await collectFormationSegments(
      f.repository.formation,
      f.enqueue(episode).workId,
      1600,
    );
    expect(segments.length).toBeGreaterThan(1);
    await f.form(episode);
    const spans = f.database
      .prepare(
        "SELECT span_start,span_end,quote FROM memory_revision_source_spans ORDER BY span_start",
      )
      .all() as { span_start: number; span_end: number; quote: string }[];
    expect(spans).toHaveLength(segments.length);
    expect(spans[1]!.span_start).toBeGreaterThan(0);
    expect(spans.map(({ quote }) => quote).join("")).toBe(
      episode.sources[0]!.content,
    );
    for (const span of spans)
      expect(
        episode.sources[0]!.content.slice(span.span_start, span.span_end),
      ).toBe(span.quote);
  });

  it("rejects unsupported quotes atomically and requires a new version for changed episode data", async () => {
    const f = fixture();
    const episode = f.episode("我只说了咖啡");
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      batch.units.push({
        ...contentUnit(batch),
        citations: [
          { sourceId: episode.sources[0]!.id, quote: "不存在的原文" },
        ],
      });
      return batch;
    };
    await expect(f.form(episode)).rejects.toThrow("absent");
    expect(
      f.database.prepare("SELECT COUNT(*) n FROM memories").get(),
    ).toMatchObject({ n: 0 });
    expect(() =>
      f.repository.formation.registerSource({
        ...episode.sources[0]!,
        content: "改了原文",
      }),
    ).toThrow("reused");
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "failed" });
  });

  it("adds real corroborating sources without creating a revision or increasing a retrieval score", async () => {
    const f = fixture();
    const first = await f.form(f.episode("我喜欢咖啡。"));
    await f.recall.indexPending();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch: MemoryFormationBatch = await base(input, execution, signal);
      if (input.existing.length) batch.units[0] = supportUnit(batch.units[0]!);
      return batch;
    };
    const result = await f.form(f.episode("我喜欢咖啡。"));
    expect(result.changes[0]?.operation).toBe("supported");
    const detail = f.repository.requireDetail(first.changes[0]!.memoryId);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.sources).toHaveLength(2);
    expect(detail.usages).toEqual([]);
  });
  it("resumes committed source segments after a failure without repeating a model call or losing global citation offsets", async () => {
    const f = fixture(1600);
    const episode = f.episode("我记得那一天的经历。\n".repeat(250));
    const segments = await collectFormationSegments(
      f.repository.formation,
      f.enqueue(episode).workId,
      1600,
    );
    let failOnce = true;
    const calledStarts: number[] = [];
    f.model.form = ({ episode: slice, sourceWindows }) => {
      calledStarts.push(sourceWindows![0]!.start);
      if (sourceWindows![0]!.start > 0 && failOnce) {
        failOnce = false;
        return Promise.reject(new Error("temporary model failure"));
      }
      const quote = slice.sources[0]!.content;
      return Promise.resolve({
        entities: [],
        units: [
          {
            operation: "create",
            type: "event",
            content: `来源片段 ${String(sourceWindows![0]!.start)} 的经历`,
            semantics: {
              kind: "episode",
              basis: "explicit_user_statement",
              owner: "user",
              qualifiers: {},
            },
            entityKeys: [],
            citations: [{ sourceId: slice.sources[0]!.id, quote }],
            links: [],
          },
        ],
      });
    };
    await expect(f.form(episode)).rejects.toThrow("temporary model failure");
    const progress = f.database
      .prepare("SELECT result_json FROM memory_work WHERE kind='form'")
      .get() as { result_json: string };
    expect(JSON.parse(progress.result_json)).toMatchObject({
      cursor: segments[0]!.nextCursor,
    });
    expect(
      f.database.prepare("SELECT COUNT(*) n FROM memories").get(),
    ).toMatchObject({ n: 1 });
    f.repository.formation.retryFailed(f.clock.now());
    const result = await f.form(episode);
    expect(result.changes).toHaveLength(segments.length);
    expect(calledStarts.filter((start) => start === 0)).toHaveLength(1);
    expect(calledStarts.length).toBeGreaterThan(segments.length);
    const spans = f.database
      .prepare(
        "SELECT span_start,span_end,quote FROM memory_revision_source_spans ORDER BY span_start",
      )
      .all() as { span_start: number; span_end: number; quote: string }[];
    expect(spans).toHaveLength(segments.length);
    expect(spans.map(({ quote }) => quote).join("")).toBe(
      episode.sources[0]!.content,
    );
    for (const span of spans)
      expect(
        episode.sources[0]!.content.slice(span.span_start, span.span_end),
      ).toBe(span.quote);
  });
  it("requires a revision when corroboration changes validity or commitment semantics", async () => {
    const f = fixture();
    const first = await f.form(f.episode("我喜欢咖啡。"));
    await f.recall.indexPending();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      const batch = await base(input, execution, signal);
      if (input.existing.length) {
        batch.units[0] = supportUnit(batch.units[0]!);
        Object.assign(batch.units[0], {
          semantics: { validFrom: "2026-09-20T00:00:00.000Z" },
        });
      }
      return batch;
    };
    await expect(f.form(f.episode("我喜欢咖啡。"))).rejects.toThrow(
      "semantics",
    );
    const detail = f.repository.requireDetail(first.changes[0]!.memoryId);
    expect(detail.sources).toHaveLength(1);
    expect(detail.revisions).toHaveLength(1);
  });
  it("keeps the original completed receipt but binds never-started work to the current processor", async () => {
    const f = fixture();
    const completeEpisode = f.episode("我喜欢咖啡。");
    await f.form(completeEpisode);
    const pendingEpisode = f.episode("我准备学陶艺。");
    const pending = f.enqueue(pendingEpisode);
    const form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [] }),
    );
    const next = new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime({ version: "formation-test-v2", form }),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: 8000 }),
      formationResourceBudget,
    );
    expect(
      (await next.form(f.enqueue(completeEpisode).workId)).processorVersion,
    ).toBe("formation-test-v1");
    const result = await next.form(pending.workId);
    expect(result.processorVersion).toBe("formation-test-v2");
    expect(result.processorTransitions).toBeUndefined();
    expect(form).toHaveBeenCalledOnce();
    expect(form.mock.calls[0]![1]).toEqual({
      expectedProcessorVersion: "formation-test-v2",
    });
    expect(f.repository.formation.work(pending.workId)).toMatchObject({
      status: "complete",
      attempt: 1,
      processorVersion: "formation-test-v2",
    });
  });
  it("continues a known cursor on a new processor without resurrecting a deleted committed prefix", async () => {
    const f = fixture(1600);
    const episode = f.episode("那天我们沿着海边走了一会儿。\n".repeat(90));
    const ref = f.enqueue(episode);
    const segmentBatch: FormationModelMock["form"] = ({
      episode: part,
      sourceWindows,
    }) =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: "create",
            type: "event",
            content: `海边经历片段 ${String(sourceWindows![0]!.start)}`,
            semantics: {
              kind: "episode",
              owner: "user",
              basis: "explicit_user_statement",
              qualifiers: {},
            },
            entityKeys: [],
            citations: [
              {
                sourceId: part.sources[0]!.id,
                quote: part.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      });
    f.model.form = (input, execution, signal) =>
      input.sourceWindows![0]!.start > 0
        ? Promise.reject(new Error("old processor failed"))
        : segmentBatch(input, execution, signal);
    await expect(f.service.form(ref.workId)).rejects.toThrow(
      "old processor failed",
    );
    const failed = f.repository.formation.work(ref.workId);
    const original = failed.result as {
      cursor: { ordinal: number; start: number };
      changes: { memoryId: string; revisionId: string }[];
    };
    expect(original.cursor.start).toBeGreaterThan(0);
    const prefix = original.changes[0]!;
    f.repository.softDelete(prefix.memoryId, f.clock.now());
    f.repository.purge(prefix.memoryId);
    f.repository.formation.retryFailed(f.clock.now());
    const form = vi.fn<FormationModelMock["form"]>(segmentBatch);
    const next = new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime({ version: "formation-test-v2", form }),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: 9000 }),
      formationResourceBudget,
    );
    const result = await next.form(ref.workId);
    expect(
      form.mock.calls.every(
        ([input, binding]) =>
          input.sourceWindows![0]!.start >= original.cursor.start &&
          binding.expectedProcessorVersion === "formation-test-v2",
      ),
    ).toBe(true);
    expect(result.processorTransitions).toEqual([
      {
        fromProcessorVersion: "formation-test-v1",
        toProcessorVersion: "formation-test-v2",
        atCursor: original.cursor,
        priorAttempt: 1,
        priorErrorCode: "formation_failed",
        recordedAt: f.clock.now(),
      },
    ]);
    expect(result.unavailableChanges).toContainEqual({
      ...prefix,
      operation: "created",
    });
    expect(f.repository.getDetail(prefix.memoryId)).toBeUndefined();
    const spans = f.database
      .prepare(
        "SELECT span_start,span_end,quote FROM memory_revision_source_spans ORDER BY span_start",
      )
      .all() as { span_start: number; span_end: number; quote: string }[];
    expect(spans[0]!.span_start).toBe(original.cursor.start);
    for (const span of spans)
      expect(
        episode.sources[0]!.content.slice(span.span_start, span.span_end),
      ).toBe(span.quote);
    expect((await next.form(ref.workId)).processorTransitions).toEqual(
      result.processorTransitions,
    );
  });

  it("retains unknown progress without rebinding, dropping its error or making a model request", () => {
    const f = fixture();
    const ref = f.enqueue(f.episode("我准备去海边。"));
    const unknown = {
      version: "unknown-cursor-v99",
      cursor: { block: 7 },
      changes: [{ opaque: "original" }],
    };
    f.database
      .prepare(
        "UPDATE memory_work SET result_json=?,attempt=1,status='failed',error_code='original_error' WHERE id=?",
      )
      .run(JSON.stringify(unknown), ref.workId);
    f.repository.formation.retryFailed(f.clock.now());
    const form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [] }),
    );
    const next = new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime({ version: "formation-test-v2", form }),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: 8000 }),
      formationResourceBudget,
    );
    expect(() => next.form(ref.workId)).toThrow(
      "Unsupported Memory formation progress",
    );
    expect(form).not.toHaveBeenCalled();
    expect(f.repository.formation.work(ref.workId)).toMatchObject({
      status: "failed",
      processorVersion: "formation-test-v1",
      attempt: 1,
      errorCode: "original_error",
      result: unknown,
    });
    f.repository.formation.recover(f.clock.now());
    expect([...f.repository.formation.pendingWork()]).toEqual([]);
  });

  it("rebinds an interrupted known progress only after startup recovery and records the actual prior attempt", async () => {
    const f = fixture();
    const ref = f.enqueue(f.episode("我明天想读书。"));
    const progress = {
      version: "source-windows-v1",
      segmentBudget: 8000,
      cursor: { ordinal: 0, start: 0 },
      changes: [],
      lastRevisionIds: [],
      retrievalIncompleteReasons: [],
    };
    f.repository.formation.startWork(
      ref.workId,
      "formation-test-v1",
      progress,
      f.clock.now(),
    );
    const form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [] }),
    );
    const next = new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime({ version: "formation-test-v2", form }),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: 8000 }),
      formationResourceBudget,
    );
    expect(() => next.form(ref.workId)).toThrow("already running");
    expect(form).not.toHaveBeenCalled();
    f.repository.formation.recover(f.clock.now());
    const result = await next.form(ref.workId);
    expect(result.processorTransitions).toEqual([
      {
        fromProcessorVersion: "formation-test-v1",
        toProcessorVersion: "formation-test-v2",
        atCursor: { ordinal: 0, start: 0 },
        priorAttempt: 1,
        recordedAt: f.clock.now(),
      },
    ]);
    expect(f.repository.formation.work(ref.workId).attempt).toBe(2);
  });

  it("refuses a stale returned proposal without changing the newer work owner", async () => {
    const f = fixture();
    const entered = deferred(),
      release = deferred();
    const base = f.model.form.bind(f.model);
    f.model.form = async (input, execution, signal) => {
      entered.resolve();
      await release.promise;
      return base(input, execution, signal);
    };
    const ref = f.enqueue(f.episode("我喜欢清淡的茶。"));
    const forming = f.service.form(ref.workId);
    const rejected = expect(forming).rejects.toThrow("no longer owns");
    await entered.promise;
    const prior = f.repository.formation.work(ref.workId);
    const owner = {
      workId: ref.workId,
      processorVersion: prior.processorVersion,
      attempt: prior.attempt,
    };
    f.repository.formation.suspend(owner, f.clock.now());
    const newer = f.repository.formation.startWork(
      ref.workId,
      "other-processor",
      prior.result,
      f.clock.now(),
    )!;
    release.resolve();
    await rejected;
    expect(f.repository.formation.work(ref.workId)).toMatchObject({
      status: "running",
      processorVersion: newer.processorVersion,
      attempt: newer.attempt,
    });
    expect(f.database.prepare("SELECT count(*) n FROM memories").get()).toEqual(
      { n: 0 },
    );
  });

  it("does not make a second formation request after the configured processor changes during comparison", async () => {
    const f = fixture();
    await f.form(f.episode("我喜欢咖啡。"));
    await f.recall.indexPending();
    let version = "formation-test-v1";
    Object.defineProperty(f.model, "version", { get: () => version });
    const base = f.model.form.bind(f.model);
    const form = vi.fn<FormationModelMock["form"]>(
      async (input, execution, signal) => {
        const batch = await base(input, execution, signal);
        version = "formation-test-v2";
        return batch;
      },
    );
    f.model.form = form;
    const next = f.enqueue(f.episode("我现在改喝乌龙茶。"));
    await expect(f.service.form(next.workId)).rejects.toThrow(
      "processor changed",
    );
    expect(form).toHaveBeenCalledOnce();
    expect(form.mock.calls[0]![1]).toEqual({
      expectedProcessorVersion: "formation-test-v1",
    });
    expect(f.repository.formation.work(next.workId)).toMatchObject({
      status: "failed",
      processorVersion: "formation-test-v1",
    });
    expect(f.database.prepare("SELECT count(*) n FROM memories").get()).toEqual(
      { n: 1 },
    );
  });
  it("rejects a known-format cursor pointing inside a context-only source before generation", () => {
    const f = fixture();
    const episode = f.episode("我明天读书。");
    const context = { ...f.episode("这只是前文").sources[0]! };
    episode.sources.push(context);
    episode.evidenceSourceIds = [episode.sources[0]!.id];
    const ref = f.enqueue(episode);
    const progress = {
      version: "source-windows-v1",
      segmentBudget: 8000,
      cursor: { ordinal: 1, start: 1 },
      changes: [],
      lastRevisionIds: [],
      retrievalIncompleteReasons: [],
    };
    f.database
      .prepare("UPDATE memory_work SET result_json=?,attempt=1 WHERE id=?")
      .run(JSON.stringify(progress), ref.workId);
    const form = vi.spyOn(f.model, "form");
    expect(() => f.service.form(ref.workId)).toThrow(
      "Unsupported Memory formation progress",
    );
    expect(form).not.toHaveBeenCalled();
    expect(f.repository.formation.work(ref.workId)).toMatchObject({
      status: "failed",
      attempt: 1,
      result: progress,
    });
  });
});

describe("explicit preference applicability revisions", () => {
  async function scopeFixture(
    owner: "user" | "character" = "character",
    type: "preference" | "profile" = "preference",
    knownSubject = true,
  ) {
    const f = fixture();
    let now = "2026-09-01T12:00:00.000Z";
    f.clock.now = () => now;
    const first = {
      ...f.episode("我是林舟。我希望 Mika 在我们的约定有进展时再提醒我。"),
      personaId: f.personaId,
    };
    f.model.form = () =>
      Promise.resolve({
        entities: knownSubject
          ? [{ key: "self", name: "林舟", kind: "person", aliases: [] }]
          : [],
        units: [
          {
            operation: "create",
            content: "林舟希望 Mika 在共同约定有进展时再提醒。",
            type,
            semantics: {
              kind: "claim",
              owner,
              ...(owner === "character" ? { personaId: f.personaId } : {}),
              basis: "explicit_user_statement",
              ...(knownSubject ? { subjectEntityId: "self" } : {}),
              predicate: "follow_up_preference",
              qualifiers: {
                scope: owner === "character" ? "Mika" : "一般偏好",
              },
            },
            entityKeys: knownSubject ? ["self"] : [],
            citations: [
              {
                sourceId: first.sources[0]!.id,
                quote: first.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      });
    const initial = (await f.form(first)).changes[0]!;
    const old = f.repository.recall.evidence([initial.revisionId], now)[0]!;
    now = "2026-09-15T12:00:00.000Z";
    const fresh = f.episode(
      owner === "character"
        ? "这不只针对 Mika，我希望所有陪伴都在约定有进展时再提醒我。"
        : "我收回一般要求，只请 Mika 在我们约定有进展时再提醒，其他陪伴不用照此做。",
    );
    const update: FormationFixture = {
      ...fresh,
      personaId: f.personaId,
      sources: [...first.sources, ...fresh.sources],
      evidenceSourceIds: [fresh.sources[0]!.id],
    };
    const nextOwner = owner === "character" ? "user" : "character";
    f.model.form = ({ episode, entities }) => {
      const primary = episode.sources.find(({ id }) =>
        episode.evidenceSourceIds.includes(id),
      )!;
      return Promise.resolve({
        entities: knownSubject
          ? [
              {
                key: "self",
                name: "林舟",
                kind: "person",
                aliases: [],
                ...(entities.some(
                  ({ id }) => id === old.semantics!.subjectEntityId,
                )
                  ? { existingId: old.semantics!.subjectEntityId! }
                  : {}),
              },
            ]
          : [],
        units: [
          {
            operation: "revise",
            retainedCitations: [],
            targetRevisionId: initial.revisionId,
            priorDispositions: [
              {
                scope: "revision",
                revisionId: initial.revisionId,
                disposition: "retained_history",
                sourceId: primary.id,
                quote: primary.content,
              },
            ],
            content: primary.content,
            type,
            semantics: {
              kind: "claim",
              owner: nextOwner,
              ...(nextOwner === "character" ? { personaId: f.personaId } : {}),
              basis: "explicit_user_statement",
              ...(knownSubject ? { subjectEntityId: "self" } : {}),
              predicate: "follow_up_preference",
              qualifiers: {
                scope: nextOwner === "character" ? "Mika" : "所有陪伴",
              },
            },
            entityKeys: knownSubject ? ["self"] : [],
            citations: [{ sourceId: primary.id, quote: primary.content }],
            links: [],
          },
        ],
      });
    };
    return { ...f, first, update, initial, old, nextOwner };
  }

  it.each(["character", "user"] as const)(
    "revises %s applicability from a new primary user statement while retaining exact historical scope",
    async (owner) => {
      const f = await scopeFixture(owner);
      const result = await f.form(f.update);
      expect(result.changes[0]).toMatchObject({
        memoryId: f.initial.memoryId,
        operation: "revised",
      });
      const nextId = result.changes[0]!.revisionId;
      expect(nextId).not.toBe(f.initial.revisionId);
      expect(f.repository.listRecords({})).toHaveLength(1);
      const [old, next] = f.repository.recall.evidence(
        [f.initial.revisionId, nextId],
        f.clock.now(),
      );
      expect(old!.semantics).toEqual(f.old.semantics);
      expect(old!.sourceRefs).toEqual(f.old.sourceRefs);
      expect(old!.content).toBe(f.old.content);
      expect(next).toMatchObject({
        owner: f.nextOwner,
        current: true,
        semantics: { subjectEntityId: f.old.semantics!.subjectEntityId },
      });
      expect(next!.sourceRefs[0]!.spans?.[0]?.quote).toBe(
        f.update.sources[1]!.content,
      );
      const otherPersonaId = randomUUID();
      const current = {
        memoryId: f.initial.memoryId,
        revisionId: nextId,
        use: "current" as const,
      };
      expect(
        f.repository.recall.validateEvidenceReferences(
          {
            personaId: otherPersonaId,
            references: [current],
          },
          f.clock.now(),
        ),
      ).toEqual(f.nextOwner === "user" ? [] : [current]);
      const history = {
        memoryId: f.initial.memoryId,
        revisionId: f.initial.revisionId,
        use: "history" as const,
      };
      const earlier = {
        personaId: otherPersonaId,
        references: [history],
        timeScope: { knownAt: "2026-09-02T12:00:00.000Z" },
      };
      expect(
        f.repository.recall.validateEvidenceReferences(earlier, f.clock.now()),
      ).toEqual(owner === "user" ? [] : [history]);
      expect(
        f.repository.recall.validateEvidenceReferences(
          {
            ...earlier,
            personaId: f.personaId,
          },
          f.clock.now(),
        ),
      ).toEqual([]);
    },
  );

  it.each(["unknown", "changed"] as const)(
    "does not change scope with an %s subject",
    async (subject) => {
      const f = await scopeFixture(
        "character",
        "preference",
        subject !== "unknown",
      );
      if (subject === "changed") {
        const original = f.model.form.bind(f.model);
        f.model.form = async (...args) => {
          const batch = await original(...args);
          batch.entities = [
            { key: "other", name: "另一人", kind: "person", aliases: [] },
          ];
          contentUnit(batch).semantics.subjectEntityId = "other";
          contentUnit(batch).entityKeys = ["other"];
          return batch;
        };
      }
      await expect(f.form(f.update)).rejects.toThrow(
        "same known preference subject",
      );
      expect(
        f.repository.requireDetail(f.initial.memoryId).revisions,
      ).toHaveLength(1);
    },
  );

  it("keeps this applicability exception limited to preferences", async () => {
    const f = await scopeFixture("character", "profile");
    await expect(f.form(f.update)).rejects.toThrow(
      "same known preference subject",
    );
  });

  it.each(["assistant", "tool", "inference", "context-only"] as const)(
    "does not let %s evidence alone change applicability",
    async (basis) => {
      const f = await scopeFixture();
      const original = f.model.form.bind(f.model);
      if (basis === "assistant") f.update.sources[1]!.speaker = "assistant";
      if (basis === "tool") {
        f.update.sources[1]!.speaker = "tool";
        f.update.sources[1]!.type = "tool";
      }
      f.model.form = async (...args) => {
        const batch = await original(...args);
        const unit = contentUnit(batch);
        if (basis === "inference") unit.semantics.basis = "inference";
        if (basis === "tool") unit.semantics.basis = "direct_observation";
        if (basis === "context-only")
          unit.citations = [
            {
              sourceId: f.first.sources[0]!.id,
              quote: f.first.sources[0]!.content,
            },
          ];
        return batch;
      };
      const before = f.repository.requireDetail(f.initial.memoryId);
      await expect(f.form(f.update)).rejects.toThrow();
      expect(f.repository.requireDetail(f.initial.memoryId)).toEqual(before);
    },
  );

  it("does not move preferences between characters or without a current persona", async () => {
    const f = await scopeFixture();
    const original = f.model.form.bind(f.model);
    f.model.form = async (...args) => {
      const batch = await original(...args);
      contentUnit(batch).semantics.owner = "character";
      contentUnit(batch).semantics.personaId = randomUUID();
      return batch;
    };
    await expect(f.form(f.update)).rejects.toThrow(
      "current user or persona scope",
    );
    f.model.form = original;
    delete f.update.personaId;
    f.update.id = randomUUID();
    await expect(f.form(f.update)).rejects.toThrow();
    expect(
      f.repository.requireDetail(f.initial.memoryId).revisions,
    ).toHaveLength(1);
  });

  it("requires a genuinely new source even when the budget excerpt omits an already attached source", async () => {
    const f = await scopeFixture();
    const source = f.update.sources[1]!;
    f.repository.attachEvidence(f.initial.revisionId, [
      {
        id: source.id,
        type: source.type,
        referenceId: source.referenceId,
        createdAt: source.occurredAt,
      },
    ]);
    const original = f.repository.recall.evidence.bind(f.repository.recall);
    vi.spyOn(f.repository.recall, "evidence").mockImplementation((...args) =>
      original(...args).map((item) => ({
        ...item,
        sourceRefs: item.sourceRefs.filter(
          ({ sourceId }) => sourceId !== source.id,
        ),
        sourceExcerpted: true,
      })),
    );
    await expect(f.form(f.update)).rejects.toThrow(
      "new primary user statement",
    );
    expect(f.repository.hasMemorySource(f.initial.memoryId, source.id)).toBe(
      true,
    );
    expect(
      f.repository.requireDetail(f.initial.memoryId).revisions,
    ).toHaveLength(1);
  });

  it("does not treat an earlier revision's original source as a new scope instruction", async () => {
    const f = await scopeFixture();
    const next = f.repository.revise({
      memoryId: f.initial.memoryId,
      predecessorRevisionId: f.repository.requireDetail(f.initial.memoryId)
        .memory.currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(f.initial.memoryId).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: f.old.content,
      reason: "A later revision retains the applicability",
      sources: [],
      now: f.clock.now(),
    });
    f.repository.recall.putSemantics(
      next.memory.currentRevisionId,
      f.old.semantics!,
      f.old.entityIds,
    );
    f.initial.revisionId = next.memory.currentRevisionId;
    f.update.sources = f.first.sources;
    f.update.evidenceSourceIds = [f.first.sources[0]!.id];
    await expect(f.form(f.update)).rejects.toThrow(
      "new primary user statement",
    );
    expect(
      f.repository.requireDetail(f.initial.memoryId).revisions,
    ).toHaveLength(2);
  });

  it("does not exclude a new instruction merely because another fact already used that source", async () => {
    const f = await scopeFixture();
    const source = f.update.sources[1]!;
    f.repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content: "这个来源同时提到了别的事实。",
      type: "event",
      confidence: 1,
      importance: 0.5,
      reason: "Separate fact",
      sources: [
        {
          id: source.id,
          referenceId: source.referenceId,
          type: source.type,
          createdAt: source.occurredAt,
        },
      ],
      now: f.clock.now(),
    });
    expect((await f.form(f.update)).changes[0]!.operation).toBe("revised");
  });

  it("does not invent a scope for a legacy revision with unknown semantics", async () => {
    const f = await scopeFixture();
    const legacy = f.repository.revise({
      memoryId: f.initial.memoryId,
      predecessorRevisionId: f.repository.requireDetail(f.initial.memoryId)
        .memory.currentRevisionId,
      priorDispositions: [
        {
          revisionId: f.repository.requireDetail(f.initial.memoryId).memory
            .currentRevisionId,
          disposition: "unresolved",
        },
      ],
      revisionId: randomUUID(),
      content: f.old.content,
      reason: "Fixture for a revision without semantic metadata",
      sources: [],
      now: f.clock.now(),
    });
    f.initial.revisionId = legacy.memory.currentRevisionId;
    await expect(f.form(f.update)).rejects.toThrow(
      "same known preference subject",
    );
    expect(
      f.repository.requireDetail(f.initial.memoryId).revisions,
    ).toHaveLength(2);
  });

  it("does not change scope through support", async () => {
    const f = await scopeFixture();
    const original = f.model.form.bind(f.model);
    f.model.form = async (...args) => {
      const batch = await original(...args);
      const changedScope = contentUnit(batch).semantics;
      batch.units[0] = supportUnit(batch.units[0]!);
      Object.assign(batch.units[0], { semantics: changedScope });
      return batch;
    };
    await expect(f.form(f.update)).rejects.toThrow("rejected value");
  });

  it.each(["delete", "archive"] as const)(
    "rejects a scope proposal when the target is %s during the model await",
    async (change) => {
      const f = await scopeFixture();
      const entered = deferred(),
        release = deferred();
      const original = f.model.form.bind(f.model);
      f.model.form = async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      };
      const pending = f.form(f.update);
      await entered.promise;
      if (change === "delete")
        f.repository.softDelete(f.initial.memoryId, f.clock.now());
      else f.repository.archive(f.initial.memoryId, f.clock.now());
      const before = f.repository.requireDetail(f.initial.memoryId);
      release.resolve();
      await expect(pending).rejects.toThrow(
        "Memory revision changed while formation was running",
      );
      expect(f.repository.requireDetail(f.initial.memoryId)).toEqual(before);
    },
  );
});

describe("formation history disposition boundary", () => {
  it("persists an actual wire all-prior user correction as exact same-Memory targets", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    const second = (await f.form(f.correction())).changes[0]!;
    f.controls.transform = (unit, input) => {
      const primary = input.episode.sources.find(({ id }) =>
        input.episode.evidenceSourceIds.includes(id),
      )!;
      return {
        ...unit,
        priorDispositions: [
          {
            scope: "all_prior",
            revisionId: null,
            disposition: "corrected",
            sourceId: primary.id,
            quote: primary.content,
          },
        ],
      };
    };
    const correction = f.correction();
    correction.sources[0]!.content =
      "前面关于我已借到或买到相机的说法全部都错了，我从没拿到相机。";
    const result = (await f.form(correction)).changes[0]!;
    const detail = f.repository.requireDetail(first.memoryId);
    const latest = detail.revisions.find(({ id }) => id === result.revisionId)!;
    expect(latest.predecessorRevisionId).toBe(second.revisionId);
    expect(
      latest.priorDispositions.map(({ revisionId }) => revisionId).sort(),
    ).toEqual([first.revisionId, second.revisionId].sort());
    for (const revision of detail.revisions.filter(
      ({ id }) => id !== result.revisionId,
    ))
      expect(revision).toMatchObject({
        historyStatus: "corrected",
        historyStatusRevisionId: result.revisionId,
      });
    expect(detail.memory.id).toBe(first.memoryId);
  });

  it("does not accept an observation as a blanket user retraction", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    f.controls.transform = (unit, input) => {
      const primary = input.episode.sources.find(({ id }) =>
        input.episode.evidenceSourceIds.includes(id),
      )!;
      return {
        ...unit,
        semantics: {
          ...(unit["semantics"] as Record<string, unknown>),
          basis: "direct_observation",
        },
        priorDispositions: [
          {
            scope: "all_prior",
            revisionId: null,
            disposition: "corrected",
            sourceId: primary.id,
            quote: primary.content,
          },
        ],
      };
    };
    const observed = f.correction();
    observed.sources[0]!.speaker = "environment";
    await expect(f.form(observed)).rejects.toThrow(/requires a user statement/);
    expect(f.repository.requireDetail(first.memoryId).revisions).toHaveLength(
      1,
    );
  });
});

describe("persisted conversational contributions without an old promise", () => {
  // A reduced projection of the original if01 delivered reply. The controlled
  // proposal tests persistence, not whether a model decides it is worth keeping.
  const reply =
    "我会写得朴素一点，像给那个下午留个名字：\n\n> **牵着风**\n> 我和爷爷一起做的蓝色风筝。\n> 留着它，也留着我们一起玩的那个下午。\n\n如果标签很小，就用这一句：\n\n> **牵着风——我和爷爷一起玩的那个下午。**\n\n我更偏爱短的这版，轻轻一句，不用再替那天下午讲什么道理。";
  function contribution() {
    const f = fixture();
    const episode = f.episode(reply, "assistant");
    episode.personaId = f.personaId;
    episode.sources.push(
      f.episode("我想给“牵着风”写个小标签，写什么比较像我们那天下午？")
        .sources[0]!,
    );
    episode.evidenceSourceIds = [episode.sources[0]!.id];
    const unit: ContentUnit = {
      operation: "create",
      type: "event",
      content:
        "当前伙伴给出两版风筝标签：长版“牵着风／我和爷爷一起做的蓝色风筝。留着它，也留着我们一起玩的那个下午。”；短版“牵着风——我和爷爷一起玩的那个下午。”。这是已给出的稿件，用户尚未选择或制作标签。",
      entityKeys: [],
      links: [],
      citations: [{ sourceId: episode.sources[0]!.id, quote: reply }],
      semantics: {
        kind: "episode",
        owner: "character",
        personaId: f.personaId,
        basis: "direct_observation",
        predicate: "delivered_conversation",
        occurredFrom: episode.sources[0]!.occurredAt,
        qualifiers: { scope: "已交付两版稿件；未确认用户采用或实体制作" },
      },
    };
    f.model.form = () => Promise.resolve({ entities: [], units: [unit] });
    return { ...f, input: episode, unit };
  }

  it.each(["chat", "voice"] as const)(
    "persists and reopens the exact %s contribution without a prior commitment or user adoption",
    async (sourceType) => {
      const f = contribution();
      f.input.sources[0]!.type = sourceType;
      expect(f.repository.listRecords({})).toEqual([]);
      const work = f.enqueue(f.input);
      const result = await f.service.form(work.workId);
      expect(result.changes).toHaveLength(1);
      const change = result.changes[0]!;
      const current = f.repository.recall.evidence(
        [change.revisionId],
        f.clock.now(),
      )[0]!;
      expect(current).toMatchObject({
        type: "event",
        owner: "character",
        personaId: f.personaId,
        content: f.unit.content,
        semantics: f.unit.semantics,
      });
      expect(current.semantics?.commitmentState).toBeUndefined();
      expect(current.sourceRefs).toHaveLength(1);
      expect(current.sourceRefs[0]).toMatchObject({
        sourceId: f.input.sources[0]!.id,
        type: sourceType,
        spans: [{ start: 0, end: reply.length, quote: reply }],
      });
      expect(f.repository.listRecords({})).toHaveLength(1);
      expect(f.repository.formation.work(work.workId).status).toBe("complete");
      const databasePath = f.database.name;
      f.database.close();
      const reopened = openApplicationDatabase(databasePath);
      try {
        expect(
          new MemoryRepository(reopened).recall.evidence(
            [change.revisionId],
            f.clock.now(),
          ),
        ).toEqual([current]);
      } finally {
        reopened.close();
      }
    },
  );

  it.each(["support", "revise-contribution", "revise-observation"] as const)(
    "does not use a new reply to authorize %s of an existing event",
    async (operation) => {
      const f = contribution();
      if (operation === "revise-observation") {
        f.input.sources[0]!.speaker = "environment";
        f.input.sources[0]!.content = "桌上放着蓝色风筝。";
        f.unit.content = "当前角色观察到桌上放着蓝色风筝。";
        f.unit.citations[0]!.quote = f.input.sources[0]!.content;
        f.unit.semantics.predicate = "observed_on_desk";
      }
      const first = (await f.form(f.input)).changes[0]!;
      await f.recall.indexPending();
      const before = f.repository.recall.evidence(
        [first.revisionId],
        f.clock.now(),
      );
      const next = f.episode(
        "这里还有一版新的标签稿：牵着风的下午。",
        "assistant",
      );
      next.personaId = f.personaId;
      next.availableMemoryReferences = [
        {
          memoryId: first.memoryId,
          revisionId: first.revisionId,
          use: "current",
        },
      ];
      const citations = [
        { sourceId: next.sources[0]!.id, quote: next.sources[0]!.content },
      ];
      f.model.form = ({ existing }) => {
        expect(
          existing.some(({ revisionId }) => revisionId === first.revisionId),
        ).toBe(true);
        return Promise.resolve({
          entities: [],
          units: [
            operation === "support"
              ? {
                  operation: "support",
                  targetRevisionId: first.revisionId,
                  citations,
                  links: [],
                }
              : {
                  ...f.unit,
                  operation: "revise",
                  targetRevisionId: first.revisionId,
                  content: "当前伙伴给出另一版标签稿，用户是否采用未知。",
                  citations,
                  semantics: {
                    ...f.unit.semantics,
                    predicate: "delivered_conversation",
                  },
                  retainedCitations: [],
                  priorDispositions: [
                    {
                      scope: "revision",
                      revisionId: first.revisionId,
                      disposition: "unresolved",
                      sourceId: next.sources[0]!.id,
                      quote: next.sources[0]!.content,
                    },
                  ],
                },
          ],
        });
      };
      await expect(f.form(next)).rejects.toThrow("Direct observation requires");
      expect(
        f.repository.recall.evidence([first.revisionId], f.clock.now()),
      ).toEqual(before);
      expect(f.repository.requireDetail(first.memoryId).revisions).toHaveLength(
        1,
      );
    },
  );

  it.each([
    "unrelated-predicate",
    "user-scope",
    "external-experience",
    "context-only",
    "derived-assistant-source",
  ] as const)("does not extend conversational evidence to %s", async (kind) => {
    const f = contribution();
    if (kind === "unrelated-predicate")
      f.unit.semantics.predicate = "finished_external_work";
    if (kind === "user-scope") {
      f.unit.semantics.owner = "user";
      delete f.unit.semantics.personaId;
    }
    if (kind === "external-experience") f.unit.semantics.kind = "experience";
    if (kind === "context-only") {
      f.input.evidenceSourceIds = [f.input.sources[1]!.id];
      f.unit.citations.push({
        sourceId: f.input.sources[1]!.id,
        quote: f.input.sources[1]!.content,
      });
    }
    if (kind === "derived-assistant-source")
      f.input.sources[0]!.type = "activity";
    await expect(f.form(f.input)).rejects.toThrow();
    expect(f.repository.listRecords({})).toEqual([]);
  });
});

describe("observed current-character speech commitments", () => {
  it.each(["chat", "voice"] as const)(
    "keeps the actual %s wire target type through create, withdrawal and rejected claimed completion",
    async (sourceType) => {
      const f = modelAdapterFixture();
      f.initial.personaId = f.personaId;
      f.initial.sources[0]!.speaker = "assistant";
      f.initial.sources[0]!.type = sourceType;
      f.initial.sources[0]!.content = "我答应等你讲完再回应，不插话。";
      let state: "active" | "cancelled" | "completed" = "active";
      f.controls.transform = (unit) => ({
        ...unit,
        ...(unit["operation"] === "create" ? { type: "commitment" } : {}),
        semantics: {
          ...(unit["semantics"] as Record<string, unknown>),
          kind: "commitment",
          owner: "character",
          personaId: f.personaId,
          basis: "direct_observation",
          commitmentState: state,
        },
        ...(unit["operation"] === "revise"
          ? {
              priorDispositions: (
                unit["priorDispositions"] as Record<string, unknown>[]
              ).map((value) => ({ ...value, disposition: "retained_history" })),
            }
          : {}),
      });
      const first = (await f.form(f.initial)).changes[0]!;
      const next = (content: string) => {
        const episode = f.episode(content, "assistant");
        episode.personaId = f.personaId;
        episode.sources[0]!.type = sourceType;
        return episode;
      };
      state = "cancelled";
      const withdrawal = await f.form(
        next("我撤回刚才等你讲完再回应的承诺，暂时不能保证。"),
      );
      expect(withdrawal.changes[0]).toMatchObject({
        operation: "revised",
        memoryId: first.memoryId,
      });
      const current = f.repository.recall.evidence(
        [withdrawal.changes[0]!.revisionId],
        f.clock.now(),
      )[0]!;
      expect(current).toMatchObject({
        type: "commitment",
        semantics: { commitmentState: "cancelled" },
      });
      expect(
        f.repository
          .requireDetail(first.memoryId)
          .revisions.find(({ id }) => id === first.revisionId)?.historyStatus,
      ).toBe("retained_history");
      const before = f.repository.requireDetail(first.memoryId);
      state = "completed";
      await expect(
        f.form(next("我已经兑现了刚才等你讲完再回应的承诺。")),
      ).rejects.toThrow("Direct observation requires");
      expect(f.repository.requireDetail(first.memoryId)).toEqual(before);
    },
  );

  it.each(["chat", "voice"] as const)(
    "persists a %s promise as a speech act without claiming its fulfillment",
    async (sourceType) => {
      const f = fixture();
      const episode = f.episode(
        "我答应等你讲完再回应，中间不插话。",
        "assistant",
      );
      episode.personaId = f.personaId;
      episode.sources[0]!.type = sourceType;
      f.model.form = ({ episode: input }) =>
        Promise.resolve({
          entities: [],
          units: [
            {
              operation: "create",
              type: "commitment",
              content: "当前伙伴答应先听完再回应，尚未有履行完成的依据。",
              entityKeys: [],
              links: [],
              semantics: {
                kind: "commitment",
                owner: "character",
                personaId: f.personaId,
                basis: "direct_observation",
                commitmentState: "active",
                qualifiers: { evidenceAct: "实际对话中作出承诺，未证明履行" },
              },
              citations: [
                {
                  sourceId: input.sources[0]!.id,
                  quote: input.sources[0]!.content,
                },
              ],
            },
          ],
        });
      const result = await f.form(episode);
      const item = f.repository.recall.evidence(
        [result.changes[0]!.revisionId],
        f.clock.now(),
      )[0]!;
      expect(item.semantics).toMatchObject({
        kind: "commitment",
        owner: "character",
        personaId: f.personaId,
        basis: "direct_observation",
        commitmentState: "active",
      });
      expect(item.content).toContain("尚未有履行完成");
      expect(item.sourceRefs[0]?.type).toBe(sourceType);
    },
  );

  it.each([
    "completed",
    "experience",
    "preference",
    "other-persona",
    "user-owned",
    "derived-source",
    "context-only",
  ] as const)(
    "does not extend a reply's observation eligibility to %s",
    async (caseName) => {
      const f = fixture();
      const episode = f.episode("我答应稍后一起看这封信。", "assistant");
      episode.personaId = f.personaId;
      if (caseName === "derived-source") episode.sources[0]!.type = "activity";
      if (caseName === "context-only") {
        episode.sources.push({
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: "我先去找文件。",
          occurredAt: f.clock.now(),
        });
        episode.evidenceSourceIds = [episode.sources[1]!.id];
      }
      f.model.form = ({ episode: input }) =>
        Promise.resolve({
          entities: [],
          units: [
            {
              operation: "create",
              type: caseName === "preference" ? "preference" : "commitment",
              content: "本例不应被助手原话扩展成已观察事实。",
              entityKeys: [],
              links: [],
              semantics: {
                kind:
                  caseName === "experience"
                    ? "experience"
                    : caseName === "preference"
                      ? "claim"
                      : "commitment",
                owner: caseName === "user-owned" ? "user" : "character",
                ...(caseName === "user-owned"
                  ? {}
                  : {
                      personaId:
                        caseName === "other-persona"
                          ? randomUUID()
                          : f.personaId,
                    }),
                basis: "direct_observation",
                ...(caseName === "experience" || caseName === "preference"
                  ? {}
                  : {
                      commitmentState:
                        caseName === "completed" ? "completed" : "active",
                    }),
                qualifiers: {},
              },
              citations: input.sources.map((source) => ({
                sourceId: source.id,
                quote: source.content,
              })),
            },
          ],
        });
      await expect(f.form(episode)).rejects.toThrow();
      expect(f.repository.listRecords({})).toEqual([]);
    },
  );
});

describe("retained character commitment date revisions", () => {
  async function commitmentFixture() {
    const f = fixture();
    const original = f.episode(
      "我答应下周末和你一起整理三张植物卡片。",
      "assistant",
    );
    original.personaId = f.personaId;
    const initialSemantics = {
      kind: "commitment" as const,
      owner: "character" as const,
      personaId: f.personaId,
      basis: "direct_observation" as const,
      occurredFrom: original.sources[0]!.occurredAt,
      timePrecision: "instant" as const,
      subjectEntityId: "self",
      predicate: "help_arrange",
      objectEntityId: "cards",
      objectValue: "三张植物卡片",
      commitmentState: "active" as const,
      qualifiers: { plannedDate: "下周末", evidenceAct: "实际承诺，尚未履行" },
    };
    f.model.form = () =>
      Promise.resolve({
        entities: [
          { key: "self", name: "当前伙伴", kind: "person", aliases: [] },
          { key: "cards", name: "植物卡片", kind: "project", aliases: [] },
        ],
        units: [
          {
            operation: "create",
            type: "commitment",
            content: "当前伙伴承诺下周末一起整理三张植物卡片，尚未履行。",
            semantics: initialSemantics,
            entityKeys: ["self", "cards"],
            links: [],
            citations: [
              {
                sourceId: original.sources[0]!.id,
                quote: original.sources[0]!.content,
              },
            ],
          },
        ],
      });
    const first = (await f.form(original)).changes[0]!;
    const before = f.repository.requireDetail(first.memoryId);
    const old = f.repository.recall.evidence(
      [first.revisionId],
      f.clock.now(),
    )[0]!;
    expect(old.semantics).toMatchObject({
      owner: "character",
      basis: "direct_observation",
      commitmentState: "active",
    });
    f.clock.now = () => "2026-09-16T12:00:00.000Z";
    const update = f.episode(
      "我说的下周末是九月十九日至二十日，还是那三张植物卡片，其余约定不变。",
    );
    update.personaId = f.personaId;
    update.availableMemoryReferences = [
      {
        memoryId: first.memoryId,
        revisionId: first.revisionId,
        use: "current",
      },
    ];
    const controls: { alter: (unit: ContentUnit) => void } = {
      alter: () => undefined,
    };
    const calls: Parameters<FormationModelMock["form"]>[0][] = [];
    f.model.form = (input) => {
      calls.push(input);
      const target = input.existing.find(
        ({ revisionId }) => revisionId === first.revisionId,
      )!;
      expect(target).toBeDefined();
      expect(input.episode.evidenceSourceIds).toEqual([update.sources[0]!.id]);
      expect(input.episode.sources.map(({ id }) => id)).not.toContain(
        original.sources[0]!.id,
      );
      const sourceIndex = target.sourceRefs.findIndex(
        ({ sourceId }) => sourceId === original.sources[0]!.id,
      );
      expect(target.sourceRefs[sourceIndex]?.spans?.[0]?.quote).toBe(
        original.sources[0]!.content,
      );
      const unit: ContentUnit = {
        operation: "revise",
        targetRevisionId: target.revisionId,
        type: "commitment",
        content:
          "当前伙伴此前承诺一起整理三张植物卡片；用户现澄清下周末指九月十九日至二十日，尚未履行。",
        semantics: {
          ...target.semantics!,
          subjectEntityId: "self",
          objectEntityId: "cards",
          qualifiers: {
            ...target.semantics!.qualifiers,
            plannedDate: "九月十九日至二十日",
            plannedDateBasis: "explicit_user_statement",
          },
        },
        entityKeys: ["self", "cards"],
        links: [],
        citations: [
          {
            sourceId: update.sources[0]!.id,
            quote: update.sources[0]!.content,
          },
        ],
        retainedCitations: [
          { sourceIndex, spanIndex: 0, quote: original.sources[0]!.content },
        ],
        priorDispositions: [
          {
            scope: "revision",
            revisionId: target.revisionId,
            disposition: "retained_history",
            sourceId: update.sources[0]!.id,
            quote: update.sources[0]!.content,
          },
        ],
      };
      controls.alter(unit);
      return Promise.resolve({
        entities: [
          {
            key: "self",
            existingId: target.semantics!.subjectEntityId!,
            name: "当前伙伴",
            kind: "person",
            aliases: [],
          },
          {
            key: "cards",
            existingId: target.semantics!.objectEntityId!,
            name: "植物卡片",
            kind: "project",
            aliases: [],
          },
        ],
        units: [
          {
            operation: "create",
            type: "event",
            content: update.sources[0]!.content,
            semantics: {
              kind: "episode",
              owner: "user",
              basis: "explicit_user_statement",
              qualifiers: { date: "九月十九日至二十日" },
            },
            entityKeys: [],
            links: [],
            citations: [
              {
                sourceId: update.sources[0]!.id,
                quote: update.sources[0]!.content,
              },
            ],
          },
          unit,
        ],
      });
    };
    return { ...f, original, first, old, before, update, controls, calls };
  }

  it.each([false, true])(
    "revises the same retained promise with a user's date and commits its companion event (raw released: %s)",
    async (releaseRaw) => {
      const f = await commitmentFixture();
      const source = f.original.sources[0]!;
      if (releaseRaw)
        expect(f.repository.formation.releaseCanonicalSource(source.id)).toBe(
          true,
        );
      const metadata = f.repository.formation.getSourceMetadata(source.id);
      expect(metadata).toMatchObject({
        speaker: "assistant",
        type: "chat",
        occurredAt: source.occurredAt,
      });
      const result = await f.form(f.update);
      expect(f.calls).toHaveLength(1);
      expect(result.changes).toHaveLength(2);
      const revised = result.changes.find(
        ({ operation }) => operation === "revised",
      )!;
      expect(revised.memoryId).toBe(f.first.memoryId);
      const detail = f.repository.requireDetail(f.first.memoryId);
      expect(detail.revisions).toHaveLength(2);
      expect(detail.memory.currentRevisionId).toBe(revised.revisionId);
      const latest = f.repository.recall.evidence(
        [revised.revisionId],
        f.clock.now(),
      )[0]!;
      expect(latest.semantics).toEqual({
        ...f.old.semantics!,
        qualifiers: {
          ...f.old.semantics!.qualifiers,
          plannedDate: "九月十九日至二十日",
          plannedDateBasis: "explicit_user_statement",
        },
      });
      expect(latest.sourceRefs).toHaveLength(2);
      for (const expected of [source, f.update.sources[0]!]) {
        const ref = latest.sourceRefs.find(
          ({ sourceId }) => sourceId === expected.id,
        )!;
        expect(ref.spans).toEqual([
          { start: 0, end: expected.content.length, quote: expected.content },
        ]);
      }
      expect(
        f.repository.recall.evidence([f.first.revisionId], f.clock.now())[0],
      ).toMatchObject({
        historyStatus: "retained_history",
        semantics: f.old.semantics,
      });
      expect(f.repository.formation.getSourceMetadata(source.id)).toEqual(
        metadata,
      );
      expect(f.repository.listRecords({})).toHaveLength(2);
    },
  );

  it.each([
    "completed",
    "cancelled",
    "predicate",
    "object",
    "subject",
    "occurrence",
  ] as const)(
    "does not use old speech to authorize changed %s",
    async (change) => {
      const f = await commitmentFixture();
      f.controls.alter = (unit) => {
        if (change === "completed" || change === "cancelled")
          unit.semantics.commitmentState = change;
        if (change === "predicate") unit.semantics.predicate = "deliver";
        if (change === "object") unit.semantics.objectValue = "另一项寄送任务";
        if (change === "subject") unit.semantics.subjectEntityId = "cards";
        if (change === "occurrence")
          unit.semantics.occurredFrom = f.clock.now();
      };
      await expect(f.form(f.update)).rejects.toThrow(
        "Direct observation requires",
      );
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1]!.validationFeedback?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ unitIndex: 1, field: "semantics.basis" }),
        ]),
      );
      expect(f.repository.requireDetail(f.first.memoryId)).toEqual(f.before);
      expect(f.repository.listRecords({})).toHaveLength(1);
    },
  );

  it("rejects a changed retained span before either the date or commitment is committed", async () => {
    const f = await commitmentFixture();
    const metadata = f.repository.formation.getSourceMetadata.bind(
      f.repository.formation,
    );
    vi.spyOn(f.repository.formation, "getSourceMetadata").mockImplementation(
      (sourceId) => {
        const result = metadata(sourceId);
        if (sourceId === f.original.sources[0]!.id)
          f.database
            .prepare(
              "DELETE FROM memory_revision_source_spans WHERE revision_id=? AND source_id=?",
            )
            .run(f.first.revisionId, sourceId);
        return result;
      },
    );
    const writes = vi.spyOn(f.repository, "attachEvidence");
    await expect(f.form(f.update)).rejects.toThrow(
      "Retained citation source span changed",
    );
    expect(f.calls).toHaveLength(1);
    expect(
      f.repository.requireDetail(f.first.memoryId).memory.currentRevisionId,
    ).toBe(f.first.revisionId);
    expect(f.repository.listRecords({})).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe("partial revision original citations", () => {
  async function retainedFixture() {
    const f = modelAdapterFixture();
    f.initial.sources[0]!.content =
      "南堤拍照日期是二十五号。同行的是妹妹。只打印两张留念，不出售照片。留念，留念。";
    const first = (await f.form(f.initial)).changes[0]!;
    const correction = f.episode(
      "更正南堤拍照的同行者，从一开始就是表妹小禾，我把称呼说混了；其余安排没有变。",
    );
    f.controls.transform = (unit, input) => {
      const target = input.existing.find(
        ({ revisionId }) => revisionId === first.revisionId,
      );
      if (!target) return unit;
      const sourceIndex = target.sourceRefs.findIndex(
        ({ sourceId }) => sourceId === f.initial.sources[0]!.id,
      );
      return {
        ...unit,
        content:
          "南堤拍照的同行者是表妹小禾，日期二十五号；只打印两张留念，不出售。",
        retainedCitations: [
          {
            sourceIndex,
            spanIndex: 0,
            quote: "南堤拍照日期是二十五号。",
            occurrence: null,
          },
          {
            sourceIndex,
            spanIndex: 0,
            quote: "只打印两张留念，不出售照片。",
            occurrence: null,
          },
        ],
        priorDispositions: [
          {
            scope: "revision",
            revisionId: target.revisionId,
            disposition: "corrected",
            sourceId: correction.sources[0]!.id,
            quote: correction.sources[0]!.content,
          },
        ],
      };
    };
    return { ...f, first, correction };
  }

  it("persists only selected disjoint old clauses with the new primary quote and original offsets", async () => {
    const f = await retainedFixture();
    const sourceCreatedAt = f.clock.now();
    f.clock.now = () => "2026-09-20T12:00:00.000Z";
    f.correction.recordedAt = f.clock.now();
    f.correction.sources[0]!.occurredAt = f.clock.now();
    const result = await f.form(f.correction);
    const revised = result.changes.find(
      ({ operation }) => operation === "revised",
    )!;
    const evidence = f.repository.recall.evidence(
      [revised.revisionId],
      f.clock.now(),
    )[0]!;
    const original = f.initial.sources[0]!;
    const retained = evidence.sourceRefs.find(
      ({ sourceId }) => sourceId === original.id,
    )!;
    expect(retained.spans).toEqual(
      [
        { start: 0, end: 13, quote: "南堤拍照日期是二十五号。" },
        {
          start: original.content.indexOf("只打印"),
          end: original.content.length,
          quote: "只打印两张留念，不出售照片。",
        },
      ].map((span) => ({ ...span, end: span.start + span.quote.length })),
    );
    expect(retained.spans!.some(({ quote }) => quote.includes("妹妹"))).toBe(
      false,
    );
    expect(evidence.sourceRefs.map(({ sourceId }) => sourceId)).toEqual(
      expect.arrayContaining([original.id, f.correction.sources[0]!.id]),
    );
    expect(evidence.sourceCount).toBe(2);
    expect(
      f.repository
        .requireDetail(f.first.memoryId)
        .sources.filter(({ id }) => id === original.id),
    ).toHaveLength(1);
    const old = f.repository.recall.evidence(
      [f.first.revisionId],
      f.clock.now(),
    )[0]!;
    expect(old.historyStatus).toBe("corrected");
    expect(old.sourceRefs[0]!.spans![0]!.quote).toBe(original.content);
    expect(f.repository.formation.sourceProvenance(original.id).createdAt).toBe(
      sourceCreatedAt,
    );
    expect(
      f.stream.mock.calls.some(([request]) => {
        const input = JSON.parse(
          (request.input[0] as { content: string }).content,
        ) as Parameters<FormationModelMock["form"]>[0];
        return (
          input.existing.some(
            ({ revisionId, sourceRefs }) =>
              revisionId === f.first.revisionId &&
              sourceRefs.some(({ sourceId }) => sourceId === original.id),
          ) && !input.episode.sources.some(({ id }) => id === original.id)
        );
      }),
    ).toBe(true);
  });

  async function correctionReportFixture(completeReports: boolean) {
    const f = modelAdapterFixture();
    const original = f.initial.sources[0]!;
    original.content = "去年生日我给姐姐做了一只蓝色布鲸鱼，想起那天还挺开心。";
    const sourceTime = "2026-08-05T10:00:00.000Z";
    f.clock.now = () => sourceTime;
    f.initial.recordedAt = sourceTime;
    original.occurredAt = sourceTime;
    f.controls.transform = (unit) => ({
      ...unit,
      semantics: {
        ...(unit["semantics"] as Record<string, unknown>),
        kind: "episode",
        predicate: "gift_report",
      },
    });
    const first = (await f.form(f.initial)).changes[0]!;
    f.clock.now = () => "2026-08-06T11:00:00.000Z";
    const correction = f.episode(
      "等一下，我把两件事混在一起了。鲸鱼是做给表弟的；送姐姐的是一个针织杯垫。",
    );
    correction.evidenceSourceIds = [correction.sources[0]!.id];
    correction.sources.push(original);
    const report =
      "原报告为‘去年生日’和‘想起那天还挺开心’，未明确这些情境对应哪件事，也未说明是谁的生日。";
    const content = completeReports
      ? `蓝色布鲸鱼是给表弟的，不是给姐姐；给姐姐的是针织杯垫。${report}`
      : "蓝色布鲸鱼是给表弟的，不是给姐姐；此前生日及开心回忆对应哪件事未知。";
    const quotes = completeReports
      ? ["去年生日", "一只蓝色布鲸鱼", "想起那天还挺开心"]
      : ["一只蓝色布鲸鱼"];
    const transform = f.controls.transform;
    f.controls.transform = (unit, input) => {
      const target = input.existing.find(
        ({ revisionId }) => revisionId === first.revisionId,
      );
      expect(target).toBeDefined();
      const sourceIndex = target!.sourceRefs.findIndex(
        ({ sourceId }) => sourceId === original.id,
      );
      expect(target!.sourceRefs[sourceIndex]!.spans![0]!.quote).toBe(
        original.content,
      );
      const normalized = transform(unit, input);
      return {
        ...normalized,
        content,
        semantics: {
          ...(normalized["semantics"] as Record<string, unknown>),
          qualifiers: [
            {
              key: "eventContextUncertainty",
              value: completeReports ? report : "生日及开心回忆归属未知",
            },
          ],
        },
        retainedCitations: quotes.map((quote) => ({
          sourceIndex,
          spanIndex: 0,
          quote,
          occurrence: null,
        })),
        priorDispositions: [
          {
            scope: "revision",
            revisionId: first.revisionId,
            disposition: "corrected",
            sourceId: correction.sources[0]!.id,
            quote: correction.sources[0]!.content,
          },
        ],
      };
    };
    const result = await f.form(correction);
    const revised = result.changes.find(
      ({ operation }) => operation === "revised",
    )!;
    expect(revised.memoryId).toBe(first.memoryId);
    const evidence = f.repository.recall.evidence(
      [revised.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence.content).toBe(content);
    expect(evidence.sourceCount).toBe(2);
    expect(
      evidence.sourceRefs.find(({ sourceId }) => sourceId === original.id)!
        .spans,
    ).toEqual(
      quotes.map((quote) => ({
        quote,
        start: original.content.indexOf(quote),
        end: original.content.indexOf(quote) + quote.length,
      })),
    );
    expect(
      evidence.sourceRefs.find(
        ({ sourceId }) => sourceId === correction.sources[0]!.id,
      )!.spans,
    ).toEqual([{ start: 0, end: 36, quote: correction.sources[0]!.content }]);
    return { ...f, first, revised, evidence, original, sourceTime, report };
  }

  it("does not invent unselected report citations from a controlled partial correction", async () => {
    // This controlled output reproduces the old selection gap; the host is not
    // a semantic selector, and a new instruction cannot repair it after output.
    const f = await correctionReportFixture(false);
    expect(
      f.evidence.sourceRefs.flatMap(({ spans }) => spans ?? []),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quote: "去年生日" }),
        expect.objectContaining({ quote: "想起那天还挺开心" }),
      ]),
    );
    const old = f.repository.recall.evidence(
      [f.first.revisionId],
      f.clock.now(),
    )[0]!;
    expect(old.historyStatus).toBe("corrected");
    expect(old.sourceRefs[0]!.spans![0]!.quote).toBe(f.original.content);
  });

  it("persists selected uncertain prior reports across reopen without restoring corrected grounding", async () => {
    // The injected proposal uses the existing wire contract; this proves
    // persistence/qualification, not that a real model will select these clauses.
    const f = await correctionReportFixture(true);
    expect(f.evidence.semantics).toMatchObject({
      kind: "episode",
      basis: "explicit_user_statement",
      timePrecision: "unknown",
      qualifiers: { eventContextUncertainty: f.report },
    });
    expect(f.evidence.semantics!.occurredFrom).toBeUndefined();
    expect(f.evidence.semantics!.occurredTo).toBeUndefined();
    const filename = f.database.name;
    f.database.close();
    const reopened = openApplicationDatabase(filename);
    try {
      const repository = new MemoryRepository(reopened);
      expect(
        repository.requireDetail(f.first.memoryId).memory.currentRevisionId,
      ).toBe(f.revised.revisionId);
      expect(
        repository.recall.evidence([f.revised.revisionId], f.clock.now()),
      ).toEqual([f.evidence]);
      expect(
        repository.formation.sourceProvenance(f.original.id).createdAt,
      ).toBe(f.sourceTime);
      const old = {
        memoryId: f.first.memoryId,
        revisionId: f.first.revisionId,
        use: "history" as const,
      };
      const current = {
        memoryId: f.first.memoryId,
        revisionId: f.revised.revisionId,
        use: "current" as const,
      };
      expect(
        repository.recall.validateEvidenceReferences(
          {
            personaId: f.personaId,
            references: [old, current],
            usage: "grounding",
          },
          f.clock.now(),
        ),
      ).toEqual([old]);
      const history = repository.recall.evidence(
        [old.revisionId],
        f.clock.now(),
      )[0]!;
      expect(history.historyStatus).toBe("corrected");
      expect(history.sourceRefs[0]!.spans![0]!.quote).toBe(f.original.content);
    } finally {
      reopened.close();
    }
  });

  it("whole retraction keeps an empty selection and does not copy every old source", async () => {
    const f = await retainedFixture();
    f.correction.sources[0]!.content =
      "更正：前面说的南堤拍照从未安排过，日期、同行者和打印计划全部是我说错了。";
    const original = f.controls.transform;
    f.controls.transform = (unit, input) => ({
      ...original(unit, input),
      ...(input.existing.length
        ? { content: f.correction.sources[0]!.content, retainedCitations: [] }
        : {}),
    });
    const result = await f.form(f.correction);
    const revised = result.changes.find(
      ({ operation }) => operation === "revised",
    )!;
    const evidence = f.repository.recall.evidence(
      [revised.revisionId],
      f.clock.now(),
    )[0]!;
    expect(evidence.sourceRefs.map(({ sourceId }) => sourceId)).toEqual([
      f.correction.sources[0]!.id,
    ]);
  });

  it("does not recover a quote omitted by the actual evidence projection", async () => {
    const f = await retainedFixture();
    const evidence = f.repository.recall.evidence.bind(f.repository.recall);
    vi.spyOn(f.repository.recall, "evidence").mockImplementation(
      (ids, now, projection) =>
        evidence(ids, now, {
          ...projection,
          sourceLimit: 10,
          quoteBytes: 0,
        }),
    );
    await expect(f.form(f.correction)).rejects.toThrow(
      "actually supplied target source span",
    );
    const last = f.stream.mock.calls.at(-1)![0];
    const supplied = JSON.parse(
      (last.input[0] as { content: string }).content,
    ) as Parameters<FormationModelMock["form"]>[0];
    const prior = supplied.existing.find(
      ({ revisionId }) => revisionId === f.first.revisionId,
    )!;
    expect(prior.content).toBe(f.initial.sources[0]!.content);
    expect(prior.sourceCount).toBe(1);
    expect(prior.sourceRefs[0]!.spans).toEqual([]);
    expect(
      f.repository.requireDetail(f.first.memoryId).memory.currentRevisionId,
    ).toBe(f.first.revisionId);
  });

  it("selects a repeated subquote by its occurrence within the actual old span", async () => {
    const f = await retainedFixture();
    const original = f.controls.transform;
    f.controls.transform = (unit, input) => {
      const selected = original(unit, input);
      return input.existing.length
        ? {
            ...selected,
            retainedCitations: [
              { sourceIndex: 0, spanIndex: 0, quote: "留念", occurrence: 2 },
            ],
          }
        : selected;
    };
    const result = await f.form(f.correction);
    const revision = result.changes.find(
      ({ operation }) => operation === "revised",
    )!;
    const oldSource = f.repository.recall
      .evidence([revision.revisionId], f.clock.now())[0]!
      .sourceRefs.find(
        ({ sourceId }) => sourceId === f.initial.sources[0]!.id,
      )!;
    const start = f.initial.sources[0]!.content.lastIndexOf("留念");
    expect(oldSource.spans).toEqual([{ start, end: start + 2, quote: "留念" }]);
  });

  it.each([
    "missing_source",
    "missing_span",
    "absent_quote",
    "ambiguous_quote",
  ] as const)(
    "rejects %s without pretending omitted source text was supplied",
    async (kind) => {
      const f = await retainedFixture();
      const original = f.controls.transform;
      f.controls.transform = (unit, input) => {
        const selected = original(unit, input);
        if (!input.existing.length) return selected;
        const sourceIndex = input.existing[0]!.sourceRefs.findIndex(
          ({ sourceId }) => sourceId === f.initial.sources[0]!.id,
        );
        return {
          ...selected,
          retainedCitations: [
            {
              sourceIndex: kind === "missing_source" ? 900 : sourceIndex,
              spanIndex: kind === "missing_span" ? 900 : 0,
              quote:
                kind === "absent_quote"
                  ? "从未供应的句子"
                  : kind === "ambiguous_quote"
                    ? "留念"
                    : "南堤拍照日期是二十五号。",
              occurrence: null,
            },
          ],
        };
      };
      await expect(f.form(f.correction)).rejects.toThrow(
        kind.startsWith("missing")
          ? "actually supplied"
          : kind === "ambiguous_quote"
            ? "explicit occurrence"
            : "absent",
      );
      expect(
        f.repository.requireDetail(f.first.memoryId).memory.currentRevisionId,
      ).toBe(f.first.revisionId);
    },
  );

  it.each([
    "span_deleted",
    "source_deleted",
    "revision_changed",
    "raw_released",
  ] as const)(
    "rechecks %s at the actual model completion boundary",
    async (kind) => {
      const f = await retainedFixture();
      const original = f.controls.transform;
      let changed = false;
      let replacementId: string | undefined;
      const writes = vi.spyOn(f.repository, "attachEvidence");
      f.controls.transform = (unit, input) => {
        const selected = original(unit, input);
        if (input.existing.length && !changed) {
          changed = true;
          f.controls.beforeComplete = () => {
            const sourceId = f.initial.sources[0]!.id;
            if (kind === "span_deleted")
              f.database
                .prepare(
                  "DELETE FROM memory_revision_source_spans WHERE revision_id=? AND source_id=?",
                )
                .run(f.first.revisionId, sourceId);
            if (kind === "source_deleted") {
              f.database
                .prepare("DELETE FROM memory_work_sources WHERE source_id=?")
                .run(sourceId);
              f.database
                .prepare(
                  "DELETE FROM memory_revision_sources WHERE source_id=?",
                )
                .run(sourceId);
              f.database
                .prepare("DELETE FROM memory_sources WHERE id=?")
                .run(sourceId);
            }
            if (kind === "raw_released")
              expect(
                f.repository.formation.releaseCanonicalSource(sourceId),
              ).toBe(true);
            if (kind === "revision_changed") {
              replacementId = randomUUID();
              f.repository.revise({
                memoryId: f.first.memoryId,
                revisionId: replacementId,
                predecessorRevisionId: f.first.revisionId,
                priorDispositions: [
                  { revisionId: f.first.revisionId, disposition: "unresolved" },
                ],
                content: "另一条实际编辑",
                sources: [],
                reason: "并发编辑",
                now: f.clock.now(),
              });
            }
            f.controls.beforeComplete = () => Promise.resolve();
            return Promise.resolve();
          };
        }
        return selected;
      };
      if (kind === "raw_released") {
        const result = await f.form(f.correction);
        const revised = result.changes.find(
          ({ operation }) => operation === "revised",
        )!;
        expect(
          f.repository.recall.evidence([revised.revisionId], f.clock.now())[0]!
            .sourceCount,
        ).toBe(2);
      } else {
        await expect(f.form(f.correction)).rejects.toThrow(
          kind === "revision_changed"
            ? "same known preference subject"
            : "source span changed",
        );
        expect(
          f.repository.requireDetail(f.first.memoryId).revisions,
        ).toHaveLength(kind === "revision_changed" ? 2 : 1);
        expect(writes).not.toHaveBeenCalled();
        if (replacementId) {
          const actualInputs = f.stream.mock.calls.map(
            ([request]) =>
              JSON.parse(
                (request.input[0] as { content: string }).content,
              ) as Parameters<FormationModelMock["form"]>[0],
          );
          expect(
            actualInputs.some(({ existing }) =>
              existing.some((item) => item.revisionId === replacementId),
            ),
          ).toBe(true);
          expect(
            f.repository.requireDetail(f.first.memoryId).memory
              .currentRevisionId,
          ).toBe(replacementId);
          expect(
            f.repository.recall.evidence([replacementId], f.clock.now())[0]!
              .sourceRefs,
          ).toEqual([]);
        }
      }
    },
  );
});

describe("support as an evidence-only operation", () => {
  function selectSupport(f: ReturnType<typeof modelAdapterFixture>) {
    f.controls.transform = (unit, input) => {
      const target = input.existing[0];
      if (!target) return unit;
      const primary = input.episode.sources.find(({ id }) =>
        input.episode.evidenceSourceIds.includes(id),
      )!;
      return {
        operation: "support",
        targetRevisionId: target.revisionId,
        citations: [
          { sourceId: primary.id, quote: primary.content, occurrence: null },
        ],
        links: [],
      };
    };
  }

  it("keeps canonical subject and entity IDs without asking the model to redeclare or remap them", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    const subject = randomUUID();
    f.repository.recall.putEntity(
      { id: subject, name: "用户", kind: "person", aliases: [] },
      f.clock.now(),
    );
    const original = f.repository.recall.evidence(
      [first.revisionId],
      f.clock.now(),
    )[0]!;
    f.database
      .prepare("DELETE FROM memory_revision_semantics WHERE revision_id=?")
      .run(first.revisionId);
    f.repository.recall.putSemantics(
      first.revisionId,
      { ...original.semantics!, subjectEntityId: subject },
      [subject],
    );
    const before = f.repository.recall.evidence(
      [first.revisionId],
      f.clock.now(),
    )[0]!;
    selectSupport(f);
    const next = f.correction();
    next.sources[0]!.content = "对，相机已经借到了，这件事没变。";
    const result = await f.form(next);
    expect(result.changes).toEqual([{ ...first, operation: "supported" }]);
    const after = f.repository.recall.evidence(
      [first.revisionId],
      f.clock.now(),
    )[0]!;
    expect(after.content).toBe(before.content);
    expect(after.type).toBe(before.type);
    expect(after.semantics).toEqual(before.semantics);
    expect(after.entityIds).toEqual([subject]);
    expect(after.sourceCount).toBe(before.sourceCount! + 1);
    expect(f.repository.requireDetail(first.memoryId).revisions).toHaveLength(
      1,
    );
    const request = f.stream.mock.calls.at(-1)![0];
    expect(request.structuredOutput!.schema).toBeDefined();
    expect(request.instructions).toContain("canonical entity IDs");
  });

  it("attaches a user source to an untyped manual record without inventing semantics", async () => {
    const f = modelAdapterFixture();
    const memoryId = randomUUID(),
      revisionId = randomUUID();
    f.repository.create({
      memoryId,
      revisionId,
      content: "我已经借到相机了。",
      type: "event",
      sources: [],
      now: f.clock.now(),
      reason: "手动记录",
      confidence: 1,
      importance: 0.5,
    });
    await f.recall.indexPending();
    selectSupport(f);
    const next = f.episode("我确实已经借到相机了。");
    next.personaId = f.personaId;
    const result = await f.form(next);
    expect(result.changes).toEqual([
      { memoryId, revisionId, operation: "supported" },
    ]);
    const after = f.repository.recall.evidence([revisionId], f.clock.now())[0]!;
    expect(after.semantics).toBeUndefined();
    expect(after.sourceCount).toBe(1);
    expect(f.repository.requireDetail(memoryId).revisions).toHaveLength(1);
  });

  it("does not treat an assistant repetition as new user corroboration", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    selectSupport(f);
    const next = f.correction();
    next.sources[0]!.speaker = "assistant";
    next.sources[0]!.content = "你已经借到相机了。";
    await expect(f.form(next)).rejects.toThrow("actual user source");
    expect(f.repository.requireDetail(first.memoryId).sources).toHaveLength(1);
  });

  it("rereads the changed revision before attaching source evidence during its response", async () => {
    const f = modelAdapterFixture();
    const first = (await f.form(f.initial)).changes[0]!;
    selectSupport(f);
    const transform = f.controls.transform;
    let changed = false;
    const replacementId = randomUUID();
    f.controls.transform = (unit, input) => {
      const result = transform(unit, input);
      if (input.existing.length && !changed) {
        changed = true;
        f.controls.beforeComplete = () => {
          f.repository.revise({
            memoryId: first.memoryId,
            revisionId: replacementId,
            predecessorRevisionId: first.revisionId,
            priorDispositions: [
              { revisionId: first.revisionId, disposition: "unresolved" },
            ],
            content: "新的手动编辑",
            sources: [],
            now: f.clock.now(),
            reason: "编辑",
          });
          f.controls.beforeComplete = () => Promise.resolve();
          return Promise.resolve();
        };
      }
      return result;
    };
    const next = f.correction();
    next.sources[0]!.content = "对，相机已经借到了。";
    const result = await f.form(next);
    expect(result.changes).toEqual([
      {
        memoryId: first.memoryId,
        revisionId: replacementId,
        operation: "supported",
      },
    ]);
    const old = f.repository.recall.evidence(
      [first.revisionId],
      f.clock.now(),
    )[0]!;
    expect(old.sourceCount).toBe(1);
    const replacement = f.repository.recall.evidence(
      [replacementId],
      f.clock.now(),
    )[0]!;
    expect(replacement.sourceCount).toBe(1);
    expect(replacement.sourceRefs[0]!.sourceId).toBe(next.sources[0]!.id);
    expect(f.repository.requireDetail(first.memoryId).revisions).toHaveLength(
      2,
    );
  });
});

describe("historical disposition evidence inside actual primary citation ranges", () => {
  it.each([
    {
      kind: "prefix",
      text: "现在恢复画画。今天我出去办事。",
      quote: "现在恢复画画。今天我出去办事。",
      disposition: "现在恢复画画。",
      accepted: true,
    },
    {
      kind: "suffix",
      text: "今天我出去办事。现在恢复画画。",
      quote: "今天我出去办事。现在恢复画画。",
      disposition: "现在恢复画画。",
      accepted: true,
    },
    {
      kind: "repeated_outside_citation",
      text: "现在恢复画画。先前有人这么说。现在恢复画画。",
      quote: "现在恢复画画。",
      occurrence: 1,
      disposition: "现在恢复画画。",
      accepted: true,
    },
    {
      kind: "repeated_inside_citation",
      text: "现在恢复画画。现在恢复画画。",
      quote: "现在恢复画画。现在恢复画画。",
      disposition: "现在恢复画画。",
      accepted: false,
    },
    {
      kind: "outside_own_citation",
      text: "今天我出去办事。现在恢复画画。",
      quote: "今天我出去办事。",
      disposition: "现在恢复画画。",
      accepted: false,
    },
    {
      kind: "cross_boundary",
      text: "今天我出去办事。现在恢复画画。",
      quote: "现在恢复画画。",
      disposition: "办事。现在恢复",
      accepted: false,
    },
    {
      kind: "different_source",
      text: "现在恢复画画。",
      quote: "现在恢复画画。",
      disposition: "现在恢复画画。",
      accepted: false,
    },
    {
      kind: "other_unit",
      text: "今天我出去办事。现在恢复画画。",
      quote: "今天我出去办事。",
      disposition: "现在恢复画画。",
      accepted: false,
    },
    {
      kind: "two_occurrences_in_separate_citations",
      text: "现在恢复画画。现在恢复画画。",
      quote: "现在恢复画画。",
      occurrence: 0,
      disposition: "现在恢复画画。",
      accepted: false,
    },
  ])(
    "validates $kind against only this unit's verified primary ranges",
    async (test) => {
      const f = fixture();
      const initial = f.episode("今天先暂停画画，安静待会儿。");
      const first = (await f.form(initial)).changes[0]!;
      const next = f.episode(test.text);
      const other = f.episode(test.text).sources[0]!;
      next.sources.push(other);
      next.evidenceSourceIds = [next.sources[0]!.id];
      const form = f.model.form.bind(f.model);
      f.model.form = vi.fn<FormationModelMock["form"]>(
        async (input, execution, signal) => {
          const batch = await form(input, execution, signal);
          const unit = contentUnit(batch);
          if (unit.operation !== "revise") return batch;
          const source = input.episode.sources[0]!;
          unit.citations = [
            {
              sourceId: source.id,
              quote: test.quote,
              ...(test.occurrence !== undefined
                ? { occurrence: test.occurrence }
                : {}),
            },
          ];
          if (test.kind === "two_occurrences_in_separate_citations")
            unit.citations.push({
              sourceId: source.id,
              quote: test.quote,
              occurrence: 1,
            });
          unit.priorDispositions = [
            {
              scope: "revision",
              revisionId: first.revisionId,
              disposition: "retained_history",
              sourceId: test.kind === "different_source" ? other.id : source.id,
              quote: test.disposition,
            },
          ];
          if (test.kind === "other_unit") {
            const extra: ContentUnit = {
              ...unit,
              operation: "create",
              content: "用户说可以恢复画画",
              citations: [{ sourceId: source.id, quote: test.disposition }],
            };
            delete extra.targetRevisionId;
            delete extra.priorDispositions;
            delete extra.retainedCitations;
            batch.units.push(extra);
          }
          return batch;
        },
      );
      if (test.accepted) {
        const result = await f.form(next);
        expect(result.changes).toHaveLength(1);
        expect(
          f.repository.recall.evidence([first.revisionId], f.clock.now())[0]!
            .historyStatus,
        ).toBe("retained_history");
        const span = f.database
          .prepare(
            "SELECT span_start,span_end,quote FROM memory_revision_source_spans WHERE revision_id=? AND source_id=?",
          )
          .get(result.changes[0]!.revisionId, next.sources[0]!.id);
        const expectedStart =
          test.occurrence === 1
            ? test.text.lastIndexOf(test.quote)
            : test.text.indexOf(test.quote);
        expect(span).toEqual({
          span_start: expectedStart,
          span_end: expectedStart + test.quote.length,
          quote: test.quote,
        });
      } else {
        await expect(f.form(next)).rejects.toThrow(
          "Historical disposition requires exact primary evidence",
        );
        expect(
          f.repository.requireDetail(first.memoryId).revisions,
        ).toHaveLength(1);
      }
    },
  );

  it("uses original UTF-16 offsets for a disposition within a later source segment", async () => {
    const f = fixture(1600);
    const first = (await f.form(f.episode("现在先暂停画画。"))).changes[0]!;
    const clause = "现在恢复画画。";
    const text = `${"🌙路灯亮了，我经过街口。\n".repeat(250)}${clause}今天我出去办事。`;
    const next = f.episode(text);
    const form = f.model.form.bind(f.model);
    let citedStart = -1;
    let citedEnd = -1;
    f.model.form = vi.fn<FormationModelMock["form"]>(
      async (input, execution, signal) => {
        const source = input.episode.sources[0]!;
        if (!source.content.includes(clause))
          return { entities: [], units: [] };
        const batch = await form(input, execution, signal);
        const unit = contentUnit(batch);
        if (unit.operation === "revise") {
          citedStart = input.sourceWindows![0]!.start;
          citedEnd = input.sourceWindows![0]!.end;
          unit.priorDispositions = [
            {
              scope: "revision",
              revisionId: first.revisionId,
              disposition: "retained_history",
              sourceId: source.id,
              quote: clause,
            },
          ];
        }
        return batch;
      },
    );
    const result = await f.form(next);
    expect(citedStart).toBeGreaterThan(0);
    expect(result.changes).toHaveLength(1);
    expect(
      f.repository.recall.evidence([first.revisionId], f.clock.now())[0]!
        .historyStatus,
    ).toBe("retained_history");
    const span = f.database
      .prepare(
        "SELECT span_start,span_end,quote FROM memory_revision_source_spans WHERE revision_id=? AND source_id=?",
      )
      .get(result.changes[0]!.revisionId, next.sources[0]!.id);
    expect(span).toEqual({
      span_start: citedStart,
      span_end: citedEnd,
      quote: text.slice(citedStart, citedEnd),
    });
    expect(text.slice(citedStart, citedEnd)).toContain(clause);
  });

  it.each(["corrected", "all_prior"] as const)(
    "keeps the actual user-source requirement for %s",
    async (kind) => {
      const f = fixture();
      const first = (await f.form(f.episode("现在先暂停画画。"))).changes[0]!;
      const next = f.episode("现在可以继续画画。", "assistant");
      const form = f.model.form.bind(f.model);
      f.model.form = vi.fn<FormationModelMock["form"]>(
        async (input, execution, signal) => {
          const batch = await form(input, execution, signal);
          const unit = contentUnit(batch);
          if (unit.operation !== "revise") return batch;
          unit.type = "preference";
          // The basis check must first accept the independently supported user fact;
          // the historical disposition still cannot cite this assistant source.
          unit.citations = input.episode.sources.map((source) => ({
            sourceId: source.id,
            quote: source.content,
          }));
          unit.priorDispositions = [
            {
              scope: kind === "all_prior" ? "all_prior" : "revision",
              ...(kind === "all_prior" ? {} : { revisionId: first.revisionId }),
              disposition:
                kind === "corrected" ? "corrected" : "retained_history",
              sourceId: next.sources[0]!.id,
              quote: "现在可以继续画画。",
            },
          ];
          return batch;
        },
      );
      next.sources.push(f.episode("我同意恢复画画。").sources[0]!);
      await expect(f.form(next)).rejects.toThrow(
        "Historical disposition requires exact primary evidence",
      );
      expect(f.repository.requireDetail(first.memoryId).revisions).toHaveLength(
        1,
      );
    },
  );
});

describe("complete segment proposals after explicit semantic validation feedback", () => {
  function eventUnit(
    source: FormationFixture["sources"][number],
    content = source.content,
  ): ContentUnit {
    return {
      operation: "create",
      type: "event",
      content,
      semantics: {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      entityKeys: [],
      citations: [{ sourceId: source.id, quote: source.content }],
      links: [],
    };
  }

  it("prepares all units without writes, reports separate faults, and commits every valid replacement once", async () => {
    const f = fixture();
    const source = f.episode("我把蓝杯收进柜子。小禾今天送我一本书。");
    const valid = eventUnit(source.sources[0]!, "小禾今天送给用户一本书。");
    const wrongBasis = eventUnit(source.sources[0]!, "用户把蓝杯收进柜子。");
    wrongBasis.semantics.basis = "direct_observation";
    const wrongQuote = eventUnit(source.sources[0]!, "杯子去了柜子里。");
    wrongQuote.citations[0]!.quote = "没有实际出现的句子";
    const original: MemoryFormationBatch = {
      entities: [],
      units: [wrongBasis, valid, wrongQuote],
    };
    const form = vi.fn<FormationModelMock["form"]>((input) => {
      if (!input.validationFeedback) return Promise.resolve(original);
      expect(
        f.database.prepare("SELECT count(*) n FROM memories").get(),
      ).toEqual({ n: 0 });
      expect(
        f.database
          .prepare("SELECT count(*) n FROM memory_revision_source_spans")
          .get(),
      ).toEqual({ n: 0 });
      expect(input.validationFeedback.proposal).toEqual(original);
      expect(
        input.validationFeedback.issues.map(({ unitIndex }) => unitIndex),
      ).toEqual([0, 2]);
      expect(input.validationFeedback.issues.map(({ field }) => field)).toEqual(
        ["semantics.basis", "citations"],
      );
      expect(input.episode.evidenceSourceIds).toEqual([source.sources[0]!.id]);
      return Promise.resolve({
        entities: [],
        units: [
          {
            ...wrongBasis,
            semantics: {
              ...wrongBasis.semantics,
              basis: "explicit_user_statement",
            },
          },
          valid,
        ],
      });
    });
    f.model.form = form;
    const ref = f.enqueue(source);
    const result = await f.service.form(ref.workId);
    expect(result.changes).toHaveLength(2);
    expect(f.database.prepare("SELECT count(*) n FROM memories").get()).toEqual(
      { n: 2 },
    );
    const count = form.mock.calls.length;
    const replay = await f.service.form(ref.workId);
    expect(replay.replayed).toBe(true);
    expect(form).toHaveBeenCalledTimes(count);
    expect(
      form.mock.calls.filter(([input]) => input.validationFeedback),
    ).toHaveLength(1);
  });

  it("does not turn a primary user reminder or a context-only Voice into a new observed promise", async () => {
    const f = fixture();
    const first = f.episode(
      "我会先听你讲到愿意停的地方，不替你补写空白。",
      "assistant",
    );
    first.personaId = f.personaId;
    first.sources[0]!.type = "voice";
    f.model.form = vi.fn(() =>
      Promise.resolve({
        entities: [],
        units: [
          {
            ...eventUnit(first.sources[0]!),
            type: "commitment" as const,
            semantics: {
              kind: "commitment" as const,
              owner: "character" as const,
              personaId: f.personaId,
              basis: "direct_observation" as const,
              commitmentState: "active" as const,
              qualifiers: {},
            },
          },
        ],
      }),
    );
    const saved = (await f.form(first)).changes[0]!;
    const next = f.episode("仍按这个约定就好。");
    next.personaId = f.personaId;
    next.sources.push(first.sources[0]!);
    next.evidenceSourceIds = [next.sources[0]!.id];
    const form = vi.fn<FormationModelMock["form"]>((input) => {
      if (input.validationFeedback) {
        expect(input.validationFeedback.issues[0]).toMatchObject({
          unitIndex: 0,
          field: "citations.basis",
        });
        expect(input.episode.evidenceSourceIds).toEqual([next.sources[0]!.id]);
        return Promise.resolve({ entities: [], units: [] });
      }
      return Promise.resolve({
        entities: [],
        units: [
          {
            operation: "support",
            targetRevisionId: saved.revisionId,
            citations: [
              {
                sourceId: next.sources[0]!.id,
                quote: next.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      });
    });
    f.model.form = form;
    const result = await f.form(next);
    expect(result.changes).toEqual([]);
    expect(f.repository.requireDetail(saved.memoryId).sources).toHaveLength(1);
    expect(
      f.repository.recall.evidence([saved.revisionId], f.clock.now())[0]!.basis,
    ).toBe("direct_observation");
  });

  it("repairs exact historical disposition evidence within the same supplied primary and target set", async () => {
    const f = fixture();
    const first = (await f.form(f.episode("我之前更喜欢小杯。"))).changes[0]!;
    const next = f.episode("现在换成大杯；之前喜欢小杯也是真的。");
    const context = f.episode("之前喜欢小杯也是真的。", "assistant")
      .sources[0]!;
    next.sources.push(context);
    next.evidenceSourceIds = [next.sources[0]!.id];
    const form = vi.fn<FormationModelMock["form"]>((input) => {
      const target = input.existing.find(
        ({ revisionId }) => revisionId === first.revisionId,
      );
      if (!target)
        return Promise.resolve({
          entities: [],
          units: [eventUnit(next.sources[0]!)],
        });
      const repair = !!input.validationFeedback;
      const cite = next.sources[0]!;
      if (repair)
        expect(input.validationFeedback!.issues[0]!.field).toBe(
          "priorDispositions",
        );
      return Promise.resolve({
        entities: [],
        units: [
          {
            ...eventUnit(cite),
            operation: "revise",
            type: "preference",
            targetRevisionId: target.revisionId,
            retainedCitations: [],
            priorDispositions: [
              {
                scope: "revision",
                revisionId: target.revisionId,
                disposition: "retained_history",
                sourceId: repair ? cite.id : context.id,
                quote: repair ? cite.content : context.content,
              },
            ],
          },
        ],
      });
    });
    f.model.form = form;
    const result = await f.form(next);
    expect(result.changes[0]!.operation).toBe("revised");
    expect(
      f.repository.recall.evidence([first.revisionId], f.clock.now())[0]!
        .historyStatus,
    ).toBe("retained_history");
    expect(
      form.mock.calls.filter(([input]) => input.validationFeedback),
    ).toHaveLength(1);
  });

  it("retains failed work and the untouched cursor if the one replacement is still invalid", async () => {
    const f = fixture();
    const source = f.episode("我把蓝杯收进柜子。");
    const invalid = eventUnit(source.sources[0]!);
    invalid.citations[0]!.quote = "不在原文中";
    const form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [invalid] }),
    );
    f.model.form = form;
    const ref = f.enqueue(source);
    await expect(f.service.form(ref.workId)).rejects.toThrow("absent");
    expect(
      form.mock.calls.filter(([input]) => input.validationFeedback),
    ).toHaveLength(1);
    const failed = f.repository.formation.work(ref.workId);
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({
      cursor: { ordinal: 0, start: 0 },
      changes: [],
    });
    expect(f.database.prepare("SELECT count(*) n FROM memories").get()).toEqual(
      { n: 0 },
    );
    const count = form.mock.calls.length;
    expect(() => f.service.form(ref.workId)).toThrow("previously failed");
    expect(form).toHaveBeenCalledTimes(count);
  });

  it("resumes after cancellation during replacement without committing a valid companion unit prematurely", async () => {
    const f = fixture();
    const source = f.episode("我今天把蓝杯收进柜子了。");
    const valid = eventUnit(source.sources[0]!);
    const wrong = {
      ...valid,
      content: "错误的解释",
      citations: [{ sourceId: source.sources[0]!.id, quote: "未出现" }],
    };
    const gate = deferred();
    f.model.form = vi.fn<FormationModelMock["form"]>(
      (input, _execution, signal) => {
        if (!input.validationFeedback)
          return Promise.resolve({ entities: [], units: [valid, wrong] });
        gate.resolve();
        return new Promise((_resolve, reject) =>
          signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      },
    );
    const ref = f.enqueue(source);
    const controller = new AbortController();
    const pending = f.service.form(ref.workId, controller.signal);
    await gate.promise;
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(f.repository.formation.work(ref.workId).status).toBe("pending");
    expect(f.database.prepare("SELECT count(*) n FROM memories").get()).toEqual(
      { n: 0 },
    );
    f.model.form = vi.fn(() =>
      Promise.resolve({ entities: [], units: [valid] }),
    );
    const restarted = new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime(f.model),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: 8000 }),
      formationResourceBudget,
    );
    const result = await restarted.form(ref.workId);
    expect(result.changes).toHaveLength(1);
    expect(f.database.prepare("SELECT count(*) n FROM memories").get()).toEqual(
      { n: 1 },
    );
  });

  it.each(["provider", "storage"] as const)(
    "does not route %s failures through semantic proposal repair",
    async (kind) => {
      const f = fixture();
      const source = f.episode("小禾送我一本书。");
      const form = vi.fn<FormationModelMock["form"]>(() =>
        kind === "provider"
          ? Promise.reject(
              new ProviderError(
                "PROVIDER.TIMEOUT",
                "actual Provider timeout",
                true,
              ),
            )
          : Promise.resolve({
              entities: [],
              units: [eventUnit(source.sources[0]!)],
            }),
      );
      f.model.form = form;
      if (kind === "storage")
        vi.spyOn(f.repository, "create").mockImplementation(() => {
          throw new Error("actual storage failed");
        });
      await expect(f.form(source)).rejects.toThrow(
        kind === "provider"
          ? "actual Provider timeout"
          : "actual storage failed",
      );
      expect(
        form.mock.calls.filter(([input]) => input.validationFeedback),
      ).toHaveLength(0);
    },
  );
});

// Regression projection from the closed im02 Formation inputs at lines 11/13.
// This preserves the original active target, exact source bodies and use; the
// other four memories and unobserved alias rows are not reconstructed.
const deliveredReviewFixture = {
  target: {
    memoryId: "af1b5176-f26f-49c0-a27c-13c056c634c5",
    revisionId: "ad06dd47-ed18-4ae0-a167-0e2332adb2bc",
    type: "commitment",
    content:
      "用户请求文稿打开时帮忙看姐姐婚礼上的祝词，当前助手已答应届时审阅，并请用户打开后叫自己一声。助手承诺不提姐姐以前的婚姻、不比较前后两个人，围绕用户想对姐姐说的话保持真诚、自然、不刻意煽情；进一步明确会检查是否有无意带出比较的措辞，以及是否像用户平时会说的话。该承诺仍待执行，尚无文稿已打开或审阅已完成的证据。",
    basis: "direct_observation",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: [
      "178af981-5ddd-4042-a5ea-39ea9c6d629d",
      "6f597e3c-d865-407b-a853-e358fa12f29c",
      "77b8e70a-9335-489d-ad9b-560bebf9db8a",
      "8550af3e-5f9d-48ed-a121-1ef496c3a6ad",
    ],
    semantics: {
      kind: "commitment",
      owner: "character",
      basis: "direct_observation",
      qualifiers: {
        condition: "等用户打开文稿后再帮忙看；助手请用户打开后叫自己一声",
        reviewConstraints:
          "不提姐姐以前的婚姻，不比较前后两个人；围绕用户想对姐姐说的话，真诚、自然、不刻意煽情",
        reviewChecks: "检查无意带出比较的措辞，以及是否像用户平时会说的话",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      occurredFrom: "2026-02-03T09:00:00.000Z",
      timePrecision: "instant",
      subjectEntityId: "6f597e3c-d865-407b-a853-e358fa12f29c",
      predicate: "agreed_to_review",
      objectEntityId: "178af981-5ddd-4042-a5ea-39ea9c6d629d",
      commitmentState: "active",
    },
    sourceCount: 3,
    sourceRefs: [
      {
        sourceId: "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
        referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
        type: "chat",
        spans: [
          {
            start: 47,
            end: 58,
            quote: "等文稿打开时帮我看看。",
          },
        ],
      },
      {
        sourceId: "b13c6512-cb8b-4adb-af87-98b7c21fa80f",
        referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
        type: "chat",
        spans: [
          {
            start: 0,
            end: 43,
            quote:
              "打开后叫我一声就好，我会留意有没有无意带出比较的措辞，也帮你读读是否像你平时会说的话。",
          },
        ],
      },
      {
        sourceId: "c0836a46-0220-4501-a248-e27e4935eff3",
        referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
        type: "chat",
        spans: [
          {
            start: 0,
            end: 61,
            quote:
              "好，等你打开文稿时我再帮你看。不提她以前那段婚姻，也不拿前后两个人作比较；就围绕你想对姐姐说的话，真诚、自然，不刻意煽情。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-02-03T09:00:01.000Z",
    occurredFrom: "2026-02-03T09:00:00.000Z",
    current: true,
    questionIds: [],
    relations: [],
  },
  sources: [
    {
      id: "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
      referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
      type: "chat",
      speaker: "user",
      occurredAt: "2026-02-03T09:00:00.000Z",
      content:
        "我在写姐姐婚礼上的祝词。她不想提以前那段婚姻，也不想拿前后两个人作比较；我想真诚一点，不煽情。等文稿打开时帮我看看。",
    },
    {
      id: "e94fde5c-bf45-4792-a8fd-be0987b2d717",
      referenceId: "e94fde5c-bf45-4792-a8fd-be0987b2d717",
      type: "activity_event",
      speaker: "environment",
      occurredAt: "2026-02-03T09:05:00.000Z",
      content:
        '{"id":"e94fde5c-bf45-4792-a8fd-be0987b2d717","actor":"unknown","startedAt":"2026-02-03T09:05:00.000Z","details":{"boundary":"content","content":{"source":"accessibility","scope":"viewport","text":"现在的你终于告别错误的人，找到了真正配得上你的伴侣。希望你往后每天都有轻松的小事。"},"contentStatus":"available","surface":{"id":"toast-a","epoch":"mock-desktop-1","displayId":"mock-display","windowId":"toast-a","processId":42,"appName":"TextEdit","windowTitle":"姐姐的婚礼祝词","bounds":{"x":0,"y":0,"width":1280,"height":800},"scaleFactor":1,"clipped":false},"appName":"TextEdit","source":"active_app","windowTitle":"姐姐的婚礼祝词"}}',
    },
    {
      id: "480b2304-c618-4e9e-aeb2-9483b76fec82",
      referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
      type: "chat",
      speaker: "assistant",
      occurredAt: "2026-02-03T09:05:01.000Z",
      content:
        "这两句里，“终于告别错误的人”仍在评价过去，“真正配得上”也带出了前后比较，建议一起删换。第二句“希望你往后每天都有轻松的小事”很朴素，可以保留。\n\n比如改成：\n> 姐姐，今天很开心能在这里祝福你们。希望你往后每天都有轻松的小事，也祝你们一起把日子过得自在、开心。",
    },
    {
      id: "b13c6512-cb8b-4adb-af87-98b7c21fa80f",
      referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
      type: "chat",
      speaker: "assistant",
      occurredAt: "2026-02-03T09:00:00.000Z",
      content:
        "打开后叫我一声就好，我会留意有没有无意带出比较的措辞，也帮你读读是否像你平时会说的话。",
    },
    {
      id: "c0836a46-0220-4501-a248-e27e4935eff3",
      referenceId: "9ded1525-5733-4d6a-a576-9e10df286ffb",
      type: "chat",
      speaker: "assistant",
      occurredAt: "2026-02-03T09:00:00.000Z",
      content:
        "好，等你打开文稿时我再帮你看。不提她以前那段婚姻，也不拿前后两个人作比较；就围绕你想对姐姐说的话，真诚、自然，不刻意煽情。",
    },
  ],
  entities: [
    {
      id: "178af981-5ddd-4042-a5ea-39ea9c6d629d",
      name: "姐姐婚礼上的祝词",
      kind: "project",
    },
    {
      id: "6f597e3c-d865-407b-a853-e358fa12f29c",
      name: "当前助手",
      kind: "character",
    },
    {
      id: "77b8e70a-9335-489d-ad9b-560bebf9db8a",
      name: "用户",
      kind: "person",
    },
    {
      id: "8550af3e-5f9d-48ed-a121-1ef496c3a6ad",
      name: "用户的姐姐",
      kind: "person",
    },
  ],
  episodes: [
    {
      line: 11,
      episode: {
        id: "752b52cb-6f17-5032-ad3a-430ab887c0fa",
        version:
          "04b8d8ec1de9981660c7f03a1cfc7ee2513cf6bf3c95e49816914bf847c3f006",
        personaId: "00000000-0000-4000-8000-000000000701",
        situationId: "70199817-b39c-4b78-9831-44a19e828063",
        recordedAt: "2026-02-03T09:05:01.000Z",
        evidenceSourceIds: [
          "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
          "e94fde5c-bf45-4792-a8fd-be0987b2d717",
          "480b2304-c618-4e9e-aeb2-9483b76fec82",
        ],
        availableMemoryReferences: [],
      },
      sourceIds: [
        "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
        "e94fde5c-bf45-4792-a8fd-be0987b2d717",
        "480b2304-c618-4e9e-aeb2-9483b76fec82",
        "b13c6512-cb8b-4adb-af87-98b7c21fa80f",
        "c0836a46-0220-4501-a248-e27e4935eff3",
      ],
      sourceWindows: [
        {
          sourceId: "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
          start: 0,
          end: 58,
          totalLength: 58,
        },
        {
          sourceId: "e94fde5c-bf45-4792-a8fd-be0987b2d717",
          start: 0,
          end: 578,
          totalLength: 578,
        },
        {
          sourceId: "480b2304-c618-4e9e-aeb2-9483b76fec82",
          start: 0,
          end: 132,
          totalLength: 132,
        },
        {
          sourceId: "b13c6512-cb8b-4adb-af87-98b7c21fa80f",
          start: 0,
          end: 43,
          totalLength: 43,
        },
        {
          sourceId: "c0836a46-0220-4501-a248-e27e4935eff3",
          start: 0,
          end: 61,
          totalLength: 61,
        },
      ],
      sourceCoverage: {
        primarySourceCount: 3,
        contextSourceCount: 2,
        includedContextSourceCount: 2,
        omittedContextSourceCount: 0,
        truncatedContextSourceCount: 0,
      },
    },
    {
      line: 13,
      episode: {
        id: "f1cf1d8f-e375-5cd3-a821-6eae11d6c0e2",
        version:
          "0dec905d90f76e4ec8ee684e53623e36103ecab40fa280f1b684ad16b092e8f1",
        personaId: "00000000-0000-4000-8000-000000000701",
        situationId: "70199817-b39c-4b78-9831-44a19e828063",
        recordedAt: "2026-02-03T09:05:01.000Z",
        evidenceSourceIds: ["480b2304-c618-4e9e-aeb2-9483b76fec82"],
        availableMemoryReferences: [],
      },
      sourceIds: [
        "480b2304-c618-4e9e-aeb2-9483b76fec82",
        "e94fde5c-bf45-4792-a8fd-be0987b2d717",
        "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
      ],
      sourceWindows: [
        {
          sourceId: "480b2304-c618-4e9e-aeb2-9483b76fec82",
          start: 0,
          end: 132,
          totalLength: 132,
        },
        {
          sourceId: "e94fde5c-bf45-4792-a8fd-be0987b2d717",
          start: 0,
          end: 578,
          totalLength: 578,
        },
        {
          sourceId: "5147f6bd-b1b9-43d8-aaf3-bc93c154f22c",
          start: 0,
          end: 58,
          totalLength: 58,
        },
      ],
      sourceCoverage: {
        primarySourceCount: 1,
        contextSourceCount: 2,
        includedContextSourceCount: 2,
        omittedContextSourceCount: 0,
        truncatedContextSourceCount: 0,
      },
    },
  ],
} satisfies {
  target: MemoryEvidenceItem;
  sources: MemoryFormationSource[];
  entities: { id: string; name: string; kind: string }[];
  episodes: {
    line: number;
    episode: Omit<FormationFixture, "sources">;
    sourceIds: string[];
    sourceWindows: NonNullable<
      Parameters<FormationModelMock["form"]>[0]["sourceWindows"]
    >;
    sourceCoverage: NonNullable<
      Parameters<FormationModelMock["form"]>[0]["sourceCoverage"]
    >;
  }[];
};

describe("delivered review progress on an existing active commitment", () => {
  it.each(deliveredReviewFixture.episodes)(
    "persists the original line $line primary/context projection without completing or duplicating the promise",
    async (original) => {
      const f = fixture();
      const { target, sources, entities } = deliveredReviewFixture;
      expect(f.personaId).toBe(target.personaId);
      f.clock.now = () => "2026-02-03T09:05:02.000Z";
      for (const source of sources)
        f.repository.formation.registerSource(source);
      for (const entity of entities)
        f.repository.recall.putEntity(
          { ...entity, aliases: [] },
          target.recordedAt,
        );
      f.repository.create({
        memoryId: target.memoryId,
        revisionId: target.revisionId,
        type: target.type,
        content: target.content,
        sources: target.sourceRefs.map(({ sourceId }) =>
          f.repository.formation.sourceProvenance(sourceId),
        ),
        now: target.recordedAt,
        confidence: 1,
        importance: 0.5,
        reason: "Original active promise fixture projection",
      });
      f.repository.recall.putSemantics(
        target.revisionId,
        target.semantics,
        target.entityIds,
      );
      for (const source of target.sourceRefs)
        for (const span of source.spans)
          f.repository.recall.addSpan(
            target.revisionId,
            source.sourceId,
            span.start,
            span.end,
            span.quote,
          );
      const before = f.repository.requireDetail(target.memoryId);
      const beforeEvidence = f.repository.recall.evidence(
        [target.revisionId],
        f.clock.now(),
      )[0]!;
      expect(beforeEvidence).toEqual(target);
      expect(before.memory.currentRevisionId).toBe(
        "ad06dd47-ed18-4ae0-a167-0e2332adb2bc",
      );
      const episode: FormationFixture = {
        ...original.episode,
        sources: original.sourceIds.map((id) =>
          sources.find((s) => s.id === id)!,
        ),
      };
      const delivered = sources.find(
        ({ id }) => id === "480b2304-c618-4e9e-aeb2-9483b76fec82",
      )!;
      const progress = {
        deliveredAt: delivered.occurredAt,
        deliveredReview:
          "指出两处评价和前后比较措辞，建议删换；保留轻松小事一句，并给出局部改写。",
        remainingUnverified:
          "未验证全文审完、文稿文件修改、用户阅读或采纳，不声称整项履行完成。",
      };
      const calls: Parameters<FormationModelMock["form"]>[0][] = [];
      f.model.form = (input) => {
        calls.push(input);
        expect(input.episode).toEqual(episode);
        expect(input.sourceWindows).toEqual(original.sourceWindows);
        expect(input.sourceCoverage).toEqual(original.sourceCoverage);
        const actual = input.existing.find(
          ({ revisionId }) => revisionId === target.revisionId,
        )!;
        expect(actual).toBeDefined();
        expect(actual.content).toBe(target.content);
        expect(actual.semantics).toEqual(target.semantics);
        expect(actual.sourceRefs).toEqual(target.sourceRefs);
        expect(input.validationFeedback).toBeUndefined();
        const keys = new Map(input.entities.map(({ id }, i) => [id, `e${i}`]));
        return Promise.resolve({
          entities: input.entities.map((entity) => ({
            key: keys.get(entity.id)!,
            existingId: entity.id,
            name: entity.name,
            kind: entity.kind,
            aliases: [],
          })),
          units: [
            {
              operation: "revise",
              type: "commitment",
              targetRevisionId: actual.revisionId,
              content:
                "当前伙伴原答应在文稿打开后帮看姐姐婚礼祝词，保留不提旧婚姻、不比较和真诚自然的条件。2026年2月3日09:05:01 UTC 已实际给出针对可见两句的审阅及局部改写。整项承诺仍为 active；全文审完、文件修改和用户阅读采纳未验证。",
              semantics: {
                ...target.semantics,
                subjectEntityId: keys.get(target.semantics.subjectEntityId)!,
                objectEntityId: keys.get(target.semantics.objectEntityId)!,
                qualifiers: { ...target.semantics.qualifiers, ...progress },
              },
              entityKeys: actual.entityIds.map((id) => keys.get(id)!),
              citations: [{ sourceId: delivered.id, quote: delivered.content }],
              retainedCitations: actual.sourceRefs.flatMap(
                (source, sourceIndex) =>
                  (source.spans ?? []).map((span, spanIndex) => ({
                    sourceIndex,
                    spanIndex,
                    quote: span.quote,
                  })),
              ),
              priorDispositions: [
                {
                  scope: "revision",
                  revisionId: actual.revisionId,
                  disposition: "retained_history",
                  sourceId: delivered.id,
                  quote: delivered.content,
                },
              ],
              links: [],
            },
          ],
        });
      };
      const work = f.enqueue(episode);
      const result = await f.service.form(work.workId);
      expect(calls.length).toBeGreaterThan(0);
      expect(result.changes).toHaveLength(1);
      const change = result.changes[0]!;
      expect(change).toMatchObject({
        operation: "revised",
        memoryId: target.memoryId,
      });
      expect(change.revisionId).not.toBe(target.revisionId);
      expect(f.repository.listRecords({})).toHaveLength(1);
      expect(f.repository.formation.work(work.workId).status).toBe("complete");
      const current = f.repository.recall.evidence(
        [change.revisionId],
        f.clock.now(),
      )[0]!;
      expect(current.semantics).toEqual({
        ...target.semantics,
        qualifiers: { ...target.semantics.qualifiers, ...progress },
      });
      expect(current.sourceRefs).toHaveLength(4);
      expect(
        current.sourceRefs.find(({ sourceId }) => sourceId === delivered.id),
      ).toMatchObject({
        type: "chat",
        spans: [{ start: 0, end: 132, quote: delivered.content }],
      });
      for (const originalSource of target.sourceRefs)
        expect(
          current.sourceRefs.find(
            ({ sourceId }) => sourceId === originalSource.sourceId,
          ),
        ).toEqual(originalSource);
      const old = f.repository.recall.evidence(
        [target.revisionId],
        f.clock.now(),
      )[0]!;
      expect(old).toMatchObject({
        content: target.content,
        semantics: target.semantics,
        sourceRefs: target.sourceRefs,
        historyStatus: "retained_history",
        current: false,
      });
      expect(f.repository.formation.getSourceMetadata(delivered.id)).toEqual({
        id: delivered.id,
        referenceId: delivered.referenceId,
        type: delivered.type,
        speaker: delivered.speaker,
        occurredAt: delivered.occurredAt,
      });
      const detail = f.repository.requireDetail(target.memoryId);
      expect(detail.revisions).toHaveLength(2);
      const databasePath = f.database.name;
      f.database.close();
      const reopened = openApplicationDatabase(databasePath);
      try {
        const repository = new MemoryRepository(reopened);
        expect(repository.requireDetail(target.memoryId)).toEqual(detail);
        expect(
          repository.recall.evidence([change.revisionId], f.clock.now())[0],
        ).toEqual(current);
        expect(repository.formation.work(work.workId).status).toBe("complete");
      } finally {
        reopened.close();
      }
    },
  );
});

describe("required formation comparison context", () => {
  function requestInput(request: ModelRequest) {
    return JSON.parse(
      (request.input[0] as { content: string }).content,
    ) as Parameters<FormationModelMock["form"]>[0] & { timeContext: unknown };
  }
  it("keeps necessary targets while fitting an original-order optional prefix with fewer counts than rows", async () => {
    const f = fixture(16_384);
    const original = f.episode("我想继续聊那次散步。");
    original.sources.push(f.episode("之前提到过几段相关经历。").sources[0]!);
    original.evidenceSourceIds = [original.sources[0]!.id];
    f.enqueue(original);
    const targets = Array.from({ length: 17 }, (_, index) => {
      const source = original.sources[index === 0 ? 0 : 1]!;
      const target = { memoryId: randomUUID(), revisionId: randomUUID() };
      f.repository.create({
        ...target,
        type: "event",
        content: `真实散步记录 ${index}`,
        confidence: 1,
        importance: 0.5,
        reason: "Source comparison fixture",
        now: new Date(Date.parse(f.clock.now()) + index).toISOString(),
        sources: [
          {
            id: source.id,
            referenceId: source.referenceId,
            type: "chat",
            createdAt: f.clock.now(),
          },
        ],
      });
      f.repository.recall.putSemantics(
        target.revisionId,
        {
          kind: "episode",
          owner: "user",
          basis: "explicit_user_statement",
          qualifiers: {},
        },
        [],
      );
      return target;
    });
    const counts: ModelRequest[] = [];
    const service = serviceWith(f, {
      measureInput: (request) => {
        counts.push(request);
        const value = JSON.parse(
          (request.input[0] as { content: string }).content,
        ) as { existing: { revisionId: string }[] };
        return Promise.resolve({
          ...estimateInputBudget(request),
          exactInputTokens: value.existing.length > 3 ? 258_001 : 1000,
        });
      },
    });
    f.model.form = vi.fn(() => Promise.resolve({ entities: [], units: [] }));
    const work = service.enqueue(
      formationIntake({ ...original, id: randomUUID() }),
    );
    await service.form(work.workId);
    const supplied = vi.mocked(f.model.form).mock.calls[0]![0];
    const expected = f.repository.recall.currentRevisionsForSources(
      [original.sources[1]!.id],
      { owner: "user" },
      16,
      f.clock.now(),
    );
    expect(supplied.existing.map((item) => item.revisionId)).toEqual([
      targets[0]!.revisionId,
      ...expected.slice(0, 2),
    ]);
    expect(supplied.retrievalIncompleteReasons).toContain(
      "部分可选记忆未能放入本次完整形成请求",
    );
    expect(counts.length).toBeLessThan(16);
    expect(requestInput(counts.at(-1)!).existing).toEqual(supplied.existing);
    expect(f.repository.listRecords({})).toHaveLength(17);
  });

  it("rejects an oversized complete correction request without trimming the prior proposal or committing", async () => {
    const f = fixture(16_384);
    const original = f.episode("我今天去桥边散步。");
    f.model.form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({
        entities: [],
        units: [
          {
            operation: "create",
            type: "event",
            content: "实际模型返回的过长内容。".repeat(30_000),
            semantics: {
              kind: "episode",
              owner: "user",
              basis: "direct_observation",
              qualifiers: {},
            },
            entityKeys: [],
            citations: [
              {
                sourceId: original.sources[0]!.id,
                quote: original.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      }),
    );
    const work = f.enqueue(original);
    await expect(f.service.form(work.workId)).rejects.toMatchObject({
      code: "formation_input_limit",
    });
    const correction = f.measuredRequests.filter(
      (request) => requestInput(request).validationFeedback,
    );
    expect(correction).toHaveLength(1);
    const value = requestInput(correction[0]!);
    expect(contentUnit(value.validationFeedback!.proposal).content).toBe(
      "实际模型返回的过长内容。".repeat(30_000),
    );
    expect(fitsInputBudget(estimateInputBudget(correction[0]), 258_000)).toBe(
      false,
    );
    expect(
      vi
        .mocked(f.model.form)
        .mock.calls.every(([input]) => !input.validationFeedback),
    ).toBe(true);
    expect(f.repository.listRecords({})).toHaveLength(0);
    expect(f.repository.formation.work(work.workId)).toMatchObject({
      status: "failed",
      errorCode: "formation_input_limit",
      result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
    });
  });

  it.each(["current", "history", "primary"] as const)(
    "preserves the original %s reference qualification across a held count",
    async (use) => {
      const f = fixture(16_384);
      const original = f.episode("我这周想喝茶。");
      f.enqueue(original);
      const target = { memoryId: randomUUID(), revisionId: randomUUID() };
      f.repository.create({
        ...target,
        type: "preference",
        content: original.sources[0]!.content,
        confidence: 1,
        importance: 0.5,
        reason: "Actual dated preference",
        now: f.clock.now(),
        sources: [
          {
            id: original.sources[0]!.id,
            referenceId: original.sources[0]!.referenceId,
            type: "chat",
            createdAt: f.clock.now(),
          },
        ],
      });
      f.repository.recall.putSemantics(
        target.revisionId,
        {
          kind: "claim",
          owner: "user",
          basis: "explicit_user_statement",
          qualifiers: {},
          validTo: "2026-09-15T12:01:00.000Z",
        },
        [],
      );
      const gate = deferred(),
        release = deferred();
      const requests: ModelRequest[] = [];
      const service = serviceWith(f, {
        measureInput: async (request) => {
          requests.push(request);
          gate.resolve();
          await release.promise;
          return estimateInputBudget(request);
        },
      });
      f.model.form = vi.fn(() => Promise.resolve({ entities: [], units: [] }));
      const input =
        use === "primary"
          ? { ...original, id: randomUUID() }
          : {
              ...f.episode("请再检查之前那项约定。"),
              availableMemoryReferences: [{ ...target, use }],
            };
      const work = service.enqueue(formationIntake(input));
      const pending = service.form(work.workId);
      await gate.promise;
      const supplied = requestInput(requests[0]!);
      expect(
        supplied.existing.map(
          (item: { revisionId: string }) => item.revisionId,
        ),
      ).toContain(target.revisionId);
      f.clock.now = () => "2026-09-15T12:02:00.000Z";
      release.resolve();
      if (use === "current") {
        await expect(pending).rejects.toThrow(
          "Supplied formation comparison evidence changed",
        );
        expect(f.model.form).not.toHaveBeenCalled();
        expect(f.repository.formation.work(work.workId)).toMatchObject({
          status: "failed",
          result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
        });
      } else {
        await pending;
        expect(f.model.form).toHaveBeenCalledOnce();
        expect(f.repository.formation.work(work.workId).status).toBe(
          "complete",
        );
      }
      expect(f.repository.listRecords({})).toHaveLength(1);
    },
  );

  function serviceWith(
    f: ReturnType<typeof fixture>,
    options: Parameters<typeof formationRuntime>[1] = {},
    resource = formationResourceBudget,
  ) {
    return new MemoryFormationService(
      f.repository,
      f.recall,
      formationRuntime(f.model, options),
      new CryptoIdGenerator(),
      f.clock,
      () => ({ maxTokens: 16_384 }),
      resource,
    );
  }

  it.each(["identity", "body"] as const)(
    "fails before body/generation when complete necessary %s exceeds raw resources",
    async (kind) => {
      const f = fixture(16_384);
      const input = f.episode("我保存那次山路旅行的完整经历。");
      const prior = (await f.form(input)).changes[0]!;
      const cost = f.repository.recall.evidenceReadCost(
        [prior.revisionId],
        f.clock.now(),
      );
      const identityBytes =
        Buffer.byteLength(prior.memoryId) + Buffer.byteLength(prior.revisionId);
      const entityCost = f.repository.recall.formationComparisonEntityReadCost([
        prior.revisionId,
      ]);
      const maxReadBytes =
        kind === "identity"
          ? identityBytes - 1
          : identityBytes + entityCost.rawValueBytes + cost.rawValueBytes - 1;
      const body = vi.spyOn(f.repository.recall, "evidence");
      const measure = vi.fn<ModelProvider["measureInput"]>((request) =>
        Promise.resolve(estimateInputBudget(request)),
      );
      f.model.form = vi.fn(() => Promise.resolve({ entities: [], units: [] }));
      const service = serviceWith(
        f,
        { measureInput: measure },
        { maxReadBytes },
      );
      const work = service.enqueue(
        formationIntake({ ...input, id: randomUUID() }),
      );
      await expect(service.form(work.workId)).rejects.toMatchObject({
        code: "formation_resource_limit",
      });
      expect(body).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
      expect(f.model.form).not.toHaveBeenCalled();
      expect(f.repository.formation.work(work.workId)).toMatchObject({
        status: "failed",
        errorCode: "formation_resource_limit",
        result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
      });
      expect(f.repository.listRecords({})).toHaveLength(1);
    },
  );

  it("fails an unfit necessary full request without advancing or empty completion, then permits an independent work", async () => {
    const f = fixture(16_384);
    const input = f.episode("我那次旅行的全部细节。".repeat(300));
    await f.form(input);
    f.model.form = vi.fn(() => Promise.resolve({ entities: [], units: [] }));
    const requests: ModelRequest[] = [];
    const service = serviceWith(f, {
      limits: { maxContextTokens: 32_000, maxOutputTokens: 16_000 },
      onRequest: (request) => requests.push(request),
    });
    const work = service.enqueue(
      formationIntake({ ...input, id: randomUUID() }),
    );
    await expect(service.form(work.workId)).rejects.toMatchObject({
      code: "formation_input_limit",
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(
      requests.every(
        (request) => !fitsInputBudget(estimateInputBudget(request), 16_000),
      ),
    ).toBe(true);
    expect(f.model.form).not.toHaveBeenCalled();
    expect(f.repository.formation.work(work.workId)).toMatchObject({
      status: "failed",
      errorCode: "formation_input_limit",
      result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
    });
    const next = serviceWith(f).enqueue(
      formationIntake(f.episode("下一件短小的独立事情。")),
    );
    await serviceWith(f).form(next.workId);
    expect(f.repository.formation.work(next.workId).status).toBe("complete");
    expect(f.repository.formation.work(work.workId).status).toBe("failed");
  });

  it.each(["cancel", "revision"] as const)(
    "rechecks a held complete request count after %s without generating from the old request",
    async (kind) => {
      const f = fixture(16_384);
      const input = f.episode("我现在喜欢早晨喝茶。");
      const prior = (await f.form(input)).changes[0]!;
      const before = f.repository.recall.evidence(
        [prior.revisionId],
        f.clock.now(),
      )[0]!;
      const controller = new AbortController();
      const gate = deferred(),
        release = deferred();
      const requests: ModelRequest[] = [];
      const service = serviceWith(f, {
        measureInput: async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            gate.resolve();
            await release.promise;
          }
          return estimateInputBudget(request);
        },
      });
      f.model.form = vi.fn(() => Promise.resolve({ entities: [], units: [] }));
      const work = service.enqueue(
        formationIntake({ ...input, id: randomUUID() }),
      );
      const pending = service.form(work.workId, controller.signal);
      await gate.promise;
      expect(service.form(work.workId, controller.signal)).toBe(pending);
      const successor = randomUUID();
      if (kind === "cancel")
        controller.abort(new Error("count owner cancelled"));
      else {
        f.repository.revise({
          memoryId: prior.memoryId,
          predecessorRevisionId: prior.revisionId,
          revisionId: successor,
          priorDispositions: [
            { revisionId: prior.revisionId, disposition: "retained_history" },
          ],
          content: "我现在改在午后喝茶。",
          sources: [],
          reason: "Actual concurrent correction",
          now: f.clock.now(),
        });
        f.repository.recall.putSemantics(
          successor,
          before.semantics!,
          before.entityIds,
        );
      }
      release.resolve();
      if (kind === "cancel") {
        await expect(pending).rejects.toBe(controller.signal.reason);
        expect(f.model.form).not.toHaveBeenCalled();
        expect(f.repository.formation.work(work.workId)).toMatchObject({
          status: "pending",
          result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
        });
      } else {
        await pending;
        expect(requests).toHaveLength(2);
        const values = requests.map(
          (request) =>
            JSON.parse(
              (request.input[0] as { content: string }).content,
            ) as Parameters<FormationModelMock["form"]>[0],
        );
        expect(values[0]!.existing.map((item) => item.revisionId)).toContain(
          prior.revisionId,
        );
        expect(values[1]!.existing.map((item) => item.revisionId)).toEqual([
          successor,
        ]);
        expect(f.model.form).toHaveBeenCalledOnce();
        expect(
          vi.mocked(f.model.form).mock.calls[0]![0].existing[0]!.revisionId,
        ).toBe(successor);
        expect(f.repository.formation.work(work.workId)).toMatchObject({
          status: "complete",
          attempt: 1,
        });
      }
    },
  );

  it.each([
    { count: 70, width: 1, boundary: "discovery count" },
    { count: 8, width: 80, boundary: "sequential bytes" },
  ])(
    "retains the real primary tail target past the old $boundary allocation",
    async ({ count, width, boundary }) => {
      const f = fixture(16_384);
      const statements = Array.from(
        { length: count },
        (_, index) =>
          `第${String(index)}次出游，我在车站记录了蓝伞的归还经过。` +
          "当时同伴先核对标签，再把伞放回架子。".repeat(width),
      );
      const input = f.episode(statements.join("\n"));
      const primary = input.sources[0]!;
      const work = f.enqueue(input);
      const targets = statements.map((content, index) => {
        const detail = f.repository.create({
          memoryId: randomUUID(),
          revisionId: randomUUID(),
          type: "event",
          content,
          confidence: 1,
          importance: 0.5,
          reason: "Original source-backed travel event",
          now: new Date(Date.parse(f.clock.now()) + index).toISOString(),
          sources: [
            {
              id: primary.id,
              referenceId: primary.referenceId,
              type: "chat",
              createdAt: f.clock.now(),
            },
          ],
        });
        const revisionId = detail.memory.currentRevisionId;
        f.repository.recall.putSemantics(
          revisionId,
          {
            kind: "episode",
            owner: "user",
            basis: "explicit_user_statement",
            qualifiers: {},
          },
          [],
        );
        const start = primary.content.indexOf(content);
        f.repository.recall.addSpan(
          revisionId,
          primary.id,
          start,
          start + content.length,
          content,
        );
        return { memoryId: detail.memory.id, revisionId };
      });
      const target = targets[0]!;
      const discovered = f.repository.recall.currentRevisionsForSources(
        [primary.id],
        { owner: "user" },
        count,
        f.clock.now(),
      );
      expect(discovered).toHaveLength(count);
      expect(discovered.at(-1)).toBe(target.revisionId);
      expect(f.repository.currentRevisionIds(discovered).size).toBe(count);
      const originalEvidence = f.repository.recall.evidence(
        discovered,
        f.clock.now(),
      );
      expect(
        originalEvidence.every((item) =>
          item.sourceRefs.some((source) => source.sourceId === primary.id),
        ),
      ).toBe(true);
      expect(
        estimateInputBudget(originalEvidence).estimatedTokens,
      ).toBeLessThan(258_000 * 0.9);
      const seen: string[][] = [];
      const quote = "第0次出游，我在车站记录了蓝伞的归还经过。";
      f.model.form = vi.fn<FormationModelMock["form"]>((value) => {
        seen.push(value.existing.map((item) => item.revisionId));
        const source = value.episode.sources.find((item) =>
          item.content.includes(quote),
        );
        if (!source) return Promise.resolve({ entities: [], units: [] });
        const existing = value.existing.find(
          (item) => item.memoryId === target.memoryId,
        );
        return Promise.resolve({
          entities: [],
          units: [
            existing
              ? {
                  operation: "support",
                  targetRevisionId: existing.revisionId,
                  citations: [{ sourceId: source.id, quote }],
                  links: [],
                }
              : {
                  operation: "create",
                  type: "event",
                  content: statements[0]!,
                  semantics: {
                    kind: "episode",
                    owner: "user",
                    basis: "explicit_user_statement",
                    qualifiers: {},
                  },
                  entityKeys: [],
                  citations: [{ sourceId: source.id, quote }],
                  links: [],
                },
          ],
        });
      });
      const result = await f.service.form(work.workId);
      console.info(
        JSON.stringify({
          boundary,
          originalCount: count,
          firstInputCount: seen[0]!.length,
          targetSupplied: seen[0]!.includes(target.revisionId),
          finalCount: f.repository.listRecords({}).length,
          changes: result.changes,
          workStatus: f.repository.formation.work(work.workId).status,
          fullRequests: f.measuredRequests.map((request) => ({
            ...estimateInputBudget(request),
            actualInputFits: fitsInputBudget(
              estimateInputBudget(request),
              258_000,
            ),
          })),
        }),
      );
      // Both assertions describe actual product input and committed identity;
      // the injected model chooses only from the exact material it receives.
      expect.soft(seen[0]).toContain(target.revisionId);
      expect(seen.every((ids) => ids.length === count)).toBe(true);
      expect(f.measuredRequests.length).toBeGreaterThan(0);
      for (const request of f.measuredRequests) {
        expect(request.instructions).toContain(
          "Form durable companion memories",
        );
        expect(request.structuredOutput?.name).toBe("memory_formation");
        expect(request.input).toHaveLength(1);
        const value = requestInput(request);
        expect(value.timeContext).toBeDefined();
        expect(value.episode.sources.length).toBeGreaterThan(0);
        expect(fitsInputBudget(estimateInputBudget(request), 258_000)).toBe(
          true,
        );
      }

      expect.soft(f.repository.listRecords({})).toHaveLength(count);
      expect(f.repository.formation.work(work.workId).status).toBe("complete");
    },
  );
});

// Necessary projection of closed im05 L9 and contemporaneous Conso L1.
// Exact source/Memory identities and quote tuples; not a replayed model or full DB.
const derivedComparisonFixture = {
  episode: {
    id: "4db06bc4-c815-5bbf-a2bd-a11f1b1e6293",
    version: "dd3141183454ec3fd4dbebb5aa03ba075def72a189a2ffbac7b32566c55b1266",
    personaId: "00000000-0000-4000-8000-000000000701",
    situationId: "0632de8f-4704-46a7-a75c-cd700ec4d085",
    recordedAt: "2026-05-11T07:06:01.000Z",
    sources: [
      {
        id: "29ad6014-fdfe-49ac-a343-f04a2dd5b78a",
        referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
        type: "chat",
        speaker: "assistant",
        occurredAt: "2026-05-11T07:06:01.000Z",
        content:
          "清单里这三个，我更看好**双人陶艺体验**：重点是你们一起动手、一起度过一段时间，更贴近许野说的“一起经历的小事”。不过可以留意成品大小，别最后又给他添了占地方的东西。\n\n桌面陶瓷山可能还是撞上了“不想要摆件”这点；纪念笔偏实用，可以先留作备选。你们最近方便约个时间一起去吗？",
      },
      {
        id: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
        referenceId: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
        type: "activity_event",
        speaker: "environment",
        occurredAt: "2026-05-11T07:06:00.000Z",
        content:
          '{"id":"44c185fd-c12c-4cb9-abc4-56071bfe5dd8","actor":"unknown","startedAt":"2026-05-11T07:06:00.000Z","details":{"boundary":"content","content":{"source":"accessibility","scope":"viewport","text":"备选：桌面陶瓷山、双人陶艺体验、纪念笔。"},"contentStatus":"available","surface":{"id":"gifts-one","epoch":"mock-desktop-1","displayId":"mock-display","windowId":"gifts-one","processId":42,"appName":"Notes","windowTitle":"毕业礼物","bounds":{"x":0,"y":0,"width":1280,"height":800},"scaleFactor":1,"clipped":false},"appName":"Notes","source":"active_app","windowTitle":"毕业礼物"}}',
      },
    ],
    evidenceSourceIds: ["29ad6014-fdfe-49ac-a343-f04a2dd5b78a"],
    availableMemoryReferences: [],
  },
  sources: [
    {
      id: "0f329603-59d9-4223-a7ae-8966eac7ee11",
      referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
      type: "chat",
      speaker: "assistant",
      occurredAt: "2026-05-11T07:00:00.000Z",
      content: "好，等你打开清单，我们再一起看，先不急着选。\n",
    },
    {
      id: "1def5ea3-12e9-4efd-a46b-81bad4b1a04b",
      referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
      type: "chat",
      speaker: "user",
      occurredAt: "2026-05-11T07:00:00.000Z",
      content:
        "我在给朋友许野挑毕业礼物。他说过不想要摆件，宿舍太小，更喜欢可以一起经历的小事。等我打开清单，我们一起想。",
    },
    {
      id: "29ad6014-fdfe-49ac-a343-f04a2dd5b78a",
      referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
      type: "chat",
      speaker: "assistant",
      occurredAt: "2026-05-11T07:06:01.000Z",
      content:
        "清单里这三个，我更看好**双人陶艺体验**：重点是你们一起动手、一起度过一段时间，更贴近许野说的“一起经历的小事”。不过可以留意成品大小，别最后又给他添了占地方的东西。\n\n桌面陶瓷山可能还是撞上了“不想要摆件”这点；纪念笔偏实用，可以先留作备选。你们最近方便约个时间一起去吗？",
    },
    {
      id: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
      referenceId: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
      type: "activity_event",
      speaker: "environment",
      occurredAt: "2026-05-11T07:06:00.000Z",
      content:
        '{"id":"44c185fd-c12c-4cb9-abc4-56071bfe5dd8","actor":"unknown","startedAt":"2026-05-11T07:06:00.000Z","details":{"boundary":"content","content":{"source":"accessibility","scope":"viewport","text":"备选：桌面陶瓷山、双人陶艺体验、纪念笔。"},"contentStatus":"available","surface":{"id":"gifts-one","epoch":"mock-desktop-1","displayId":"mock-display","windowId":"gifts-one","processId":42,"appName":"Notes","windowTitle":"毕业礼物","bounds":{"x":0,"y":0,"width":1280,"height":800},"scaleFactor":1,"clipped":false},"appName":"Notes","source":"active_app","windowTitle":"毕业礼物"}}',
    },
  ],
  existing: [
    {
      memoryId: "bbf43c7f-cf05-4e7f-a97b-b0bf3cd51553",
      revisionId: "1a958266-cd3d-406e-ae9c-f905c76982c8",
      type: "event",
      content:
        "观察到 Notes 的“毕业礼物”窗口中列出备选：桌面陶瓷山、双人陶艺体验、纪念笔。该环境事件的操作者未知；这只证明清单内容可见，不证明用户打开或阅读了清单，也不证明已共同讨论或选定礼物。",
      basis: "direct_observation",
      owner: "character",
      personaId: "00000000-0000-4000-8000-000000000701",
      entityIds: ["4461da9c-0394-4ab9-ab0d-d6b0829a07f4"],
      semantics: {
        kind: "episode",
        owner: "character",
        basis: "direct_observation",
        qualifiers: {
          actor: "unknown",
          observationScope:
            "原始 ActivityEvent 的 accessibility viewport 可见内容；不代表用户操作、阅读、偏好或共同挑选完成",
        },
        personaId: "00000000-0000-4000-8000-000000000701",
        occurredFrom: "2026-05-11T07:06:00.000Z",
        timePrecision: "instant",
        subjectEntityId: "4461da9c-0394-4ab9-ab0d-d6b0829a07f4",
        predicate: "visible_candidates",
        objectValue: "桌面陶瓷山、双人陶艺体验、纪念笔",
      },
      sourceCount: 1,
      sourceRefs: [
        {
          sourceId: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
          referenceId: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
          type: "activity_event",
          spans: [
            {
              start: 45,
              end: 62,
              quote: '"actor":"unknown"',
            },
            {
              start: 197,
              end: 217,
              quote: "备选：桌面陶瓷山、双人陶艺体验、纪念笔。",
            },
            {
              start: 487,
              end: 547,
              quote:
                '"appName":"Notes","source":"active_app","windowTitle":"毕业礼物"',
            },
          ],
        },
      ],
      historyStatus: "current",
      recordedAt: "2026-05-11T07:06:01.000Z",
      occurredFrom: "2026-05-11T07:06:00.000Z",
      current: true,
      questionIds: [],
      relations: [],
    },
    {
      memoryId: "a83aaf3b-c157-4a16-a51c-9fa2aa94cf57",
      revisionId: "45e2e705-a9d7-4826-ace2-b09c3fe1508b",
      type: "agent_learning",
      content:
        "2026-05-11 07:00 UTC，用户提出等自己打开毕业礼物清单后一起想，助手答应届时一起看，先不急着选。07:06 UTC，观察到 Notes 的“毕业礼物”窗口中可见备选：桌面陶瓷山、双人陶艺体验、纪念笔；操作者未知。这只说明清单内容可见，不证明用户已打开或阅读清单、表达偏好，也不证明双方已共同讨论或选定礼物；一起看的承诺尚未观察到履行。",
      basis: "inference",
      owner: "character",
      personaId: "00000000-0000-4000-8000-000000000701",
      entityIds: [
        "0369b80a-cf75-43a7-ad8e-6191a0e791f4",
        "039c2b57-f457-44a4-aa40-289af3b35d68",
        "4461da9c-0394-4ab9-ab0d-d6b0829a07f4",
        "7652dfb8-571e-41c9-ae8e-7f819cad1b82",
      ],
      semantics: {
        kind: "reflection",
        owner: "character",
        basis: "inference",
        qualifiers: {
          consolidationVersion: "grounded-consolidation-v1",
          consolidationDependencyCount: "3",
          account: "episode_summary",
        },
        personaId: "00000000-0000-4000-8000-000000000701",
      },
      sourceCount: 3,
      derivation: {
        kind: "consolidation",
        dependencies: [
          {
            memoryId: "bbf43c7f-cf05-4e7f-a97b-b0bf3cd51553",
            revisionId: "1a958266-cd3d-406e-ae9c-f905c76982c8",
            use: "current",
          },
          {
            memoryId: "1f0fc25f-7c2d-4ae2-a63f-aabdcd7d18e8",
            revisionId: "7d0092fa-a1a0-4775-a474-571547cb456b",
            use: "current",
          },
        ],
        sourceRevisionCount: 2,
        distinctUserDays: 1,
        distinctContexts: 0,
      },
      sourceRefs: [
        {
          sourceId: "0f329603-59d9-4223-a7ae-8966eac7ee11",
          referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
          type: "chat",
          spans: [
            {
              start: 0,
              end: 22,
              quote: "好，等你打开清单，我们再一起看，先不急着选。",
            },
          ],
        },
        {
          sourceId: "1def5ea3-12e9-4efd-a46b-81bad4b1a04b",
          referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
          type: "chat",
          spans: [
            {
              start: 40,
              end: 53,
              quote: "等我打开清单，我们一起想。",
            },
          ],
        },
        {
          sourceId: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
          referenceId: "44c185fd-c12c-4cb9-abc4-56071bfe5dd8",
          type: "activity_event",
          spans: [
            {
              start: 45,
              end: 62,
              quote: '"actor":"unknown"',
            },
            {
              start: 197,
              end: 217,
              quote: "备选：桌面陶瓷山、双人陶艺体验、纪念笔。",
            },
            {
              start: 487,
              end: 547,
              quote:
                '"appName":"Notes","source":"active_app","windowTitle":"毕业礼物"',
            },
          ],
        },
      ],
      historyStatus: "current",
      recordedAt: "2026-05-11T07:06:01.000Z",
      current: true,
      questionIds: [],
      relations: [
        {
          revisionId: "1a958266-cd3d-406e-ae9c-f905c76982c8",
          relation: "derived_from",
        },
        {
          revisionId: "7d0092fa-a1a0-4775-a474-571547cb456b",
          relation: "derived_from",
        },
      ],
    },
  ],
  parent: {
    memoryId: "1f0fc25f-7c2d-4ae2-a63f-aabdcd7d18e8",
    revisionId: "7d0092fa-a1a0-4775-a474-571547cb456b",
    type: "commitment",
    content:
      "助手答应等用户打开毕业礼物清单后，再一起看、一起想，暂不急着选择；尚无打开清单或完成挑选的证据。",
    basis: "direct_observation",
    owner: "character",
    personaId: "00000000-0000-4000-8000-000000000701",
    entityIds: [
      "0369b80a-cf75-43a7-ad8e-6191a0e791f4",
      "039c2b57-f457-44a4-aa40-289af3b35d68",
      "7652dfb8-571e-41c9-ae8e-7f819cad1b82",
    ],
    semantics: {
      kind: "commitment",
      owner: "character",
      basis: "direct_observation",
      qualifiers: {
        condition: "用户打开清单后",
        fulfillment: "尚未观察到履行",
      },
      personaId: "00000000-0000-4000-8000-000000000701",
      occurredFrom: "2026-05-11T07:00:00.000Z",
      timePrecision: "instant",
      subjectEntityId: "7652dfb8-571e-41c9-ae8e-7f819cad1b82",
      predicate: "agreed_to_review_gift_list_with",
      objectEntityId: "039c2b57-f457-44a4-aa40-289af3b35d68",
      objectValue: "等用户打开清单后一起看，先不急着选",
      commitmentState: "active",
    },
    sourceCount: 2,
    sourceRefs: [
      {
        sourceId: "0f329603-59d9-4223-a7ae-8966eac7ee11",
        referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
        type: "chat",
        spans: [
          {
            start: 0,
            end: 22,
            quote: "好，等你打开清单，我们再一起看，先不急着选。",
          },
        ],
      },
      {
        sourceId: "1def5ea3-12e9-4efd-a46b-81bad4b1a04b",
        referenceId: "58a81457-17b7-467b-a6b3-fb4784ec61fd",
        type: "chat",
        spans: [
          {
            start: 40,
            end: 53,
            quote: "等我打开清单，我们一起想。",
          },
        ],
      },
    ],
    historyStatus: "current",
    recordedAt: "2026-05-11T07:00:00.000Z",
    occurredFrom: "2026-05-11T07:00:00.000Z",
    current: true,
    questionIds: [],
    relations: [],
  },
  entities: [
    {
      id: "0369b80a-cf75-43a7-ad8e-6191a0e791f4",
      name: "许野",
      kind: "person",
    },
    {
      id: "039c2b57-f457-44a4-aa40-289af3b35d68",
      name: "用户",
      kind: "person",
    },
    {
      id: "4461da9c-0394-4ab9-ab0d-d6b0829a07f4",
      name: "毕业礼物清单",
      kind: "document",
    },
    {
      id: "7652dfb8-571e-41c9-ae8e-7f819cad1b82",
      name: "当前陪伴助手",
      kind: "character",
    },
  ],
} satisfies DerivedComparisonFixture;

type DerivedComparisonFixture = {
  episode: FormationFixture;
  sources: MemoryFormationSource[];
  existing: MemoryEvidenceItem[];
  parent: MemoryEvidenceItem;
  entities: { id: string; name: string; kind: string }[];
};

describe("complete adopted derived formation comparisons", () => {
  function setup() {
    const f = fixture(16_384);
    const data: DerivedComparisonFixture = structuredClone(
      derivedComparisonFixture,
    );
    f.clock.now = () => "2026-05-11T07:06:02.000Z";
    expect(f.personaId).toBe(data.parent.personaId);
    for (const source of data.sources)
      f.repository.formation.registerSource(source);
    for (const entity of data.entities)
      f.repository.recall.putEntity({ ...entity, aliases: [] }, f.clock.now());
    const insert = (item: MemoryEvidenceItem) => {
      f.repository.create({
        memoryId: item.memoryId,
        revisionId: item.revisionId,
        type: item.type,
        content: item.content,
        confidence: 1,
        importance: 0.5,
        reason: "Actual comparison projection",
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
      for (const source of item.sourceRefs)
        for (const span of source.spans ?? [])
          f.repository.recall.addSpan(
            item.revisionId,
            source.sourceId,
            span.start,
            span.end,
            span.quote,
          );
      if (item.derivation) {
        for (const source of item.sourceRefs) {
          const parent = [data.parent, ...data.existing].find(
            (candidate) =>
              !candidate.derivation &&
              candidate.sourceRefs.some(
                (ref) => ref.sourceId === source.sourceId,
              ),
          )!;
          f.repository.recall.link(
            item.revisionId,
            parent.revisionId,
            "derived_from",
            source.sourceId,
            item.derivation.dependencies.find(
              (dep) => dep.revisionId === parent.revisionId,
            )!.use,
          );
        }
      }
    };
    insert(data.parent);
    for (const item of data.existing) insert(item);
    const summary = data.existing.find((item) => item.derivation)!;
    expect(
      f.repository.recall
        .eligibleIds(
          [summary.revisionId],
          {
            purpose: "formation",
            personaId: f.personaId,
            contextBudget: { maxTokens: 16_384 },
            questions: [],
            query: "",
          },
          f.clock.now(),
        )
        .has(summary.revisionId),
    ).toBe(true);
    const initial = f.repository.recall.currentRevisionsForSources(
      data.episode.sources.map((source) => source.id),
      { personaId: f.personaId },
      59,
      f.clock.now(),
    );
    expect(initial).not.toContain(data.parent.revisionId);
    expect(new Set(initial)).toEqual(
      new Set(data.existing.map((item) => item.revisionId)),
    );
    f.model.form = vi.fn<FormationModelMock["form"]>(() =>
      Promise.resolve({ entities: [], units: [] }),
    );
    const service = (
      options: Parameters<typeof formationRuntime>[1] = {},
      resource = formationResourceBudget,
    ) =>
      new MemoryFormationService(
        f.repository,
        f.recall,
        formationRuntime(f.model, options),
        new CryptoIdGenerator(),
        f.clock,
        () => ({ maxTokens: 16_384 }),
        resource,
      );
    return { ...f, data, summary, insert, makeService: service };
  }

  function progressBatch(
    input: Parameters<FormationModelMock["form"]>[0],
    f: ReturnType<typeof setup>,
  ): MemoryFormationBatch {
    const target = input.existing.find(
      (item) => item.revisionId === f.data.parent.revisionId,
    );
    // The old observed empty proposal remains the control when the target is absent.
    if (!target) return { entities: [], units: [] };
    const delivered = input.episode.sources.find(
      (source) => source.id === f.data.episode.evidenceSourceIds![0],
    )!;
    const keys = new Map(
      input.entities.map((entity, index) => [entity.id, `e${index}`]),
    );
    return {
      entities: input.entities.map((entity) => ({
        name: entity.name,
        kind: entity.kind,
        key: keys.get(entity.id)!,
        existingId: entity.id,
        aliases: [],
      })),
      units: [
        {
          operation: "revise",
          type: "commitment",
          targetRevisionId: target.revisionId,
          content:
            "助手原答应等清单后一起看；已在5月11日07:06 UTC给出三个选项的具体比较，尚未选定、预约或获知用户采纳，承诺仍active。",
          semantics: {
            ...target.semantics!,
            subjectEntityId: keys.get(target.semantics!.subjectEntityId!)!,
            objectEntityId: keys.get(target.semantics!.objectEntityId!)!,
            qualifiers: {
              ...target.semantics!.qualifiers,
              deliveredAt: delivered.occurredAt,
              progress:
                "已比较清单，推荐体验并提醒成品占地；选定、预约、用户采纳未知",
            },
          },
          entityKeys: target.entityIds.map((id) => keys.get(id)!),
          citations: [{ sourceId: delivered.id, quote: delivered.content }],
          retainedCitations: target.sourceRefs.flatMap((source, sourceIndex) =>
            (source.spans ?? []).map((span, spanIndex) => ({
              sourceIndex,
              spanIndex,
              quote: span.quote,
            })),
          ),
          priorDispositions: [
            {
              scope: "revision",
              revisionId: target.revisionId,
              disposition: "retained_history",
              sourceId: delivered.id,
              quote: delivered.content,
            },
          ],
          links: [],
        },
      ],
    };
  }

  it("supplies the original im05 commitment before an empty first proposal and persists bounded progress across reopen", async () => {
    const f = setup();
    f.model.form = vi.fn<FormationModelMock["form"]>((input) =>
      Promise.resolve(progressBatch(input, f)),
    );
    const work = f.enqueue(f.data.episode);
    const result = await f.service.form(work.workId);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      operation: "revised",
      memoryId: f.data.parent.memoryId,
    });
    const input = vi.mocked(f.model.form).mock.calls[0]![0];
    expect(input.episode).toEqual(f.data.episode);
    expect(
      input.existing.find(
        (item) => item.revisionId === f.data.parent.revisionId,
      ),
    ).toMatchObject({
      content: f.data.parent.content,
      semantics: f.data.parent.semantics,
      sourceRefs: f.data.parent.sourceRefs,
    });
    const measured = f.measuredRequests.map(
      (r) =>
        JSON.parse((r.input[0] as { content: string }).content) as {
          existing: MemoryEvidenceItem[];
        },
    );
    expect(
      measured.some((r) =>
        r.existing.some((item) => item.revisionId === f.data.parent.revisionId),
      ),
    ).toBe(true);
    expect(f.repository.listRecords({})).toHaveLength(3);
    const detail = f.repository.requireDetail(f.data.parent.memoryId);
    expect(detail.revisions).toHaveLength(2);
    const current = f.repository.recall.evidence(
      [detail.memory.currentRevisionId],
      f.clock.now(),
    )[0]!;
    expect(current.semantics).toMatchObject({
      commitmentState: "active",
      occurredFrom: f.data.parent.semantics!.occurredFrom,
    });
    expect(current.sourceRefs).toHaveLength(3);
    for (const original of f.data.parent.sourceRefs)
      expect(
        current.sourceRefs.find((s) => s.sourceId === original.sourceId),
      ).toEqual(original);
    expect(
      current.sourceRefs.find(
        (s) => s.sourceId === f.data.episode.evidenceSourceIds![0],
      )?.spans?.[0]?.quote,
    ).toBe(f.data.episode.sources[0]!.content);
    const filename = f.database.name;
    f.database.close();
    const reopened = openApplicationDatabase(filename);
    try {
      const repo = new MemoryRepository(reopened);
      expect(repo.requireDetail(f.data.parent.memoryId)).toEqual(detail);
      expect(
        repo.recall.evidence(
          [detail.memory.currentRevisionId],
          f.clock.now(),
        )[0],
      ).toEqual(current);
      expect(repo.formation.work(work.workId).status).toBe("complete");
    } finally {
      reopened.close();
    }
  });
  it("completes F2-only summaries with shared original parents exactly once in one raw budget", async () => {
    const f = setup();
    const second = {
      ...f.summary,
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content: f.summary.content + " 保留原约定条件。",
    };
    f.insert(second);
    const summaries = f.repository.recall.evidence(
      [f.summary.revisionId, second.revisionId],
      f.clock.now(),
    );
    const input = { ...f.data.episode, sources: [f.data.episode.sources[0]!] };
    const recall = vi.spyOn(f.recall, "recall").mockImplementation((plan) =>
      Promise.resolve({
        items: summaries,
        truncated: false,
        incompleteReasons: [],
        gaps: [],
        estimatedTokens: estimateInputBudget(summaries).estimatedTokens,
        coverage: plan.questions.map((q) => ({
          questionId: q.id,
          status: "supported" as const,
          revisionIds: summaries.map((i) => i.revisionId),
        })),
      }),
    );
    f.model.form = vi.fn<FormationModelMock["form"]>((value) => {
      if (value.existing.length)
        return Promise.resolve(progressBatch(value, f));
      return Promise.resolve({
        entities: [],
        units: [
          {
            operation: "create" as const,
            type: "commitment" as const,
            content: "已就毕业礼物清单给出具体比较，保留余下选择。",
            entityKeys: [],
            links: [],
            citations: [
              {
                sourceId: input.sources[0]!.id,
                quote: input.sources[0]!.content,
              },
            ],
            semantics: {
              kind: "commitment" as const,
              owner: "character" as const,
              personaId: f.personaId,
              basis: "direct_observation" as const,
              commitmentState: "active" as const,
              qualifiers: {},
            },
          },
        ],
      });
    });
    const ids = [
      f.summary.revisionId,
      second.revisionId,
      f.data.parent.revisionId,
      f.data.existing[0]!.revisionId,
    ];
    const cost =
      f.repository.recall.evidenceReadCost(ids, f.clock.now()).rawValueBytes +
      f.repository.recall.formationComparisonEntityReadCost(ids).rawValueBytes;
    const reads = vi.spyOn(f.repository.recall, "evidenceReadCost");
    const service = f.makeService({}, { maxReadBytes: cost });
    const work = service.enqueue(formationIntake(input));
    const result = await service.form(work.workId);
    expect(result.changes[0]).toMatchObject({
      operation: "revised",
      memoryId: f.data.parent.memoryId,
    });
    expect(recall).toHaveBeenCalledOnce();
    const calls = vi.mocked(f.model.form).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].existing).toEqual([]);
    expect(new Set(calls[1]![0].existing.map((i) => i.revisionId))).toEqual(
      new Set(ids),
    );
    expect(calls[1]![0].existing).toHaveLength(4);
    expect(
      reads.mock.calls.some(
        ([values]) => values.length === 4 && new Set(values).size === 4,
      ),
    ).toBe(true);
    expect(
      calls[1]![0].existing.find(
        (i) => i.revisionId === f.data.parent.revisionId,
      )?.sourceRefs,
    ).toEqual(f.data.parent.sourceRefs);
  });

  it("keeps a superseded history dependency as history instead of updating it as an active promise", async () => {
    const f = setup();
    f.database
      .prepare(
        "UPDATE memory_revision_links SET dependency_use='history' WHERE from_revision_id=? AND to_revision_id=?",
      )
      .run(f.summary.revisionId, f.data.parent.revisionId);
    const successor = randomUUID();
    f.repository.revise({
      memoryId: f.data.parent.memoryId,
      predecessorRevisionId: f.data.parent.revisionId,
      revisionId: successor,
      content: "后来这项约定已撤下。",
      sources: [],
      reason: "Actual later revision",
      now: f.clock.now(),
      priorDispositions: [
        {
          revisionId: f.data.parent.revisionId,
          disposition: "retained_history",
        },
      ],
    });
    f.repository.recall.putSemantics(
      successor,
      { ...f.data.parent.semantics!, commitmentState: "cancelled" },
      f.data.parent.entityIds,
    );
    f.model.form = vi.fn<FormationModelMock["form"]>((input) => {
      const old = input.existing.find(
        (item) => item.revisionId === f.data.parent.revisionId,
      );
      expect(old).toMatchObject({
        current: false,
        historyStatus: "retained_history",
        sourceRefs: f.data.parent.sourceRefs,
      });
      expect(
        input.existing.find((item) => item.revisionId === f.summary.revisionId)
          ?.derivation?.dependencies,
      ).toContainEqual({
        memoryId: f.data.parent.memoryId,
        revisionId: f.data.parent.revisionId,
        use: "history",
      });
      return Promise.resolve(
        input.validationFeedback
          ? { entities: [], units: [] }
          : progressBatch(input, f),
      );
    });
    const work = f.enqueue(f.data.episode);
    expect((await f.service.form(work.workId)).changes).toEqual([]);
    const calls = vi.mocked(f.model.form).mock.calls;
    // Real Recall performs F2 before structural feedback. Both proposals name
    // the same historical revision; neither gains current-target eligibility.
    expect(calls).toHaveLength(3);
    expect(
      calls.slice(0, 2).every(([input]) => !input.validationFeedback),
    ).toBe(true);
    expect(
      calls[2]![0].validationFeedback?.issues.some((issue) =>
        issue.message.includes("active current revision"),
      ),
    ).toBe(true);
    expect(
      f.repository.requireDetail(f.data.parent.memoryId).memory
        .currentRevisionId,
    ).toBe(successor);
    expect(
      f.repository.requireDetail(f.data.parent.memoryId).revisions,
    ).toHaveLength(2);
  });

  it("does not read the parent of a summary excluded by the original allocation", async () => {
    const f = setup();
    const reads = vi.spyOn(f.repository.recall, "evidenceReadCost");
    const service = f.makeService({
      measureInput: (request) => {
        const input = JSON.parse(
          (request.input[0] as { content: string }).content,
        ) as { existing: MemoryEvidenceItem[] };
        return Promise.resolve({
          ...estimateInputBudget(request),
          exactInputTokens: input.existing.some(
            (i) => i.revisionId === f.summary.revisionId,
          )
            ? 258_001
            : 1000,
        });
      },
    });
    const work = service.enqueue(formationIntake(f.data.episode));
    await service.form(work.workId);
    expect(
      vi
        .mocked(f.model.form)
        .mock.calls[0]![0].existing.every((i) => !i.derivation),
    ).toBe(true);
    expect(
      reads.mock.calls.every(
        ([ids]) => !ids.includes(f.data.parent.revisionId),
      ),
    ).toBe(true);
    expect(
      f.repository.requireDetail(f.data.parent.memoryId).revisions,
    ).toHaveLength(1);
  });

  it.each(["raw", "input"] as const)(
    "retains an uncommitted work when the adopted complete group exceeds the shared %s budget",
    async (kind) => {
      const f = setup();
      const ids = [
        f.data.parent.revisionId,
        ...f.data.existing.map((i) => i.revisionId),
      ];
      const bytes =
        f.repository.recall.evidenceReadCost(ids, f.clock.now()).rawValueBytes +
        f.repository.recall.formationComparisonEntityReadCost(ids)
          .rawValueBytes;
      const requests: ModelRequest[] = [];
      const service = f.makeService(
        {
          measureInput: (request) => {
            requests.push(request);
            const input = JSON.parse(
              (request.input[0] as { content: string }).content,
            ) as { existing: MemoryEvidenceItem[] };
            return Promise.resolve({
              ...estimateInputBudget(request),
              exactInputTokens:
                kind === "input" &&
                input.existing.some(
                  (i) => i.revisionId === f.data.parent.revisionId,
                )
                  ? 258_001
                  : 1000,
            });
          },
        },
        kind === "raw" ? { maxReadBytes: bytes - 1 } : formationResourceBudget,
      );
      const work = service.enqueue(formationIntake(f.data.episode));
      await expect(service.form(work.workId)).rejects.toMatchObject({
        code: `formation_${kind === "raw" ? "resource" : "input"}_limit`,
      });
      expect(f.model.form).not.toHaveBeenCalled();
      expect(f.repository.formation.work(work.workId)).toMatchObject({
        status: "failed",
        result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
      });
      expect(f.repository.listRecords({})).toHaveLength(3);
      if (kind === "input") {
        const final = JSON.parse(
          (requests.at(-1)!.input[0] as { content: string }).content,
        ) as { existing: MemoryEvidenceItem[] };
        expect(new Set(final.existing.map((i) => i.revisionId))).toEqual(
          new Set(ids),
        );
      }
    },
  );

  it.each(["cancel", "revision", "span", "current_expiry"] as const)(
    "rechecks the complete parent during a held count after %s",
    async (kind) => {
      const f = setup();
      if (kind === "current_expiry")
        f.database
          .prepare(
            "UPDATE memory_revision_semantics SET valid_to=? WHERE revision_id=?",
          )
          .run("2026-05-11T07:07:00.000Z", f.data.parent.revisionId);
      const gate = deferred(),
        release = deferred(),
        controller = new AbortController();
      let held = false;
      const service = f.makeService({
        measureInput: async (request) => {
          const input = JSON.parse(
            (request.input[0] as { content: string }).content,
          ) as { existing: MemoryEvidenceItem[] };
          if (
            !held &&
            input.existing.some(
              (i) => i.revisionId === f.data.parent.revisionId,
            )
          ) {
            held = true;
            gate.resolve();
            await release.promise;
          }
          return estimateInputBudget(request);
        },
      });
      const work = service.enqueue(formationIntake(f.data.episode));
      const pending = service.form(work.workId, controller.signal);
      await gate.promise;
      const successor = randomUUID();
      if (kind === "cancel")
        controller.abort(new Error("stop before complete comparison count"));
      else if (kind === "span") {
        // Remove a real supporting tuple; the dependent summary becomes invalid too.
        const source = f.data.parent.sourceRefs[0]!;
        f.database
          .prepare(
            "DELETE FROM memory_revision_source_spans WHERE revision_id=? AND source_id=?",
          )
          .run(f.data.parent.revisionId, source.sourceId);
      } else if (kind === "current_expiry")
        f.clock.now = () => "2026-05-11T07:08:00.000Z";
      else {
        f.repository.revise({
          memoryId: f.data.parent.memoryId,
          predecessorRevisionId: f.data.parent.revisionId,
          revisionId: successor,
          content: "当前更新后的同一约定。",
          sources: [],
          reason: "Actual concurrent revision",
          now: f.clock.now(),
          priorDispositions: [
            {
              revisionId: f.data.parent.revisionId,
              disposition: "retained_history",
            },
          ],
        });
        f.repository.recall.putSemantics(
          successor,
          f.data.parent.semantics!,
          f.data.parent.entityIds,
        );
      }
      release.resolve();
      if (kind === "revision") {
        await pending;
        expect(f.model.form).toHaveBeenCalledOnce();
        const supplied = vi.mocked(f.model.form).mock.calls[0]![0].existing;
        expect(supplied.some((i) => i.revisionId === successor)).toBe(true);
        expect(
          supplied.some(
            (i) =>
              i.revisionId === f.data.parent.revisionId ||
              i.revisionId === f.summary.revisionId,
          ),
        ).toBe(false);
        expect(f.repository.formation.work(work.workId)).toMatchObject({
          status: "complete",
          attempt: 1,
        });
      } else {
        await expect(pending).rejects.toThrow();
        expect(f.model.form).not.toHaveBeenCalled();
        expect(f.repository.formation.work(work.workId)).toMatchObject({
          status: kind === "cancel" ? "pending" : "failed",
          result: { cursor: { ordinal: 0, start: 0 }, changes: [] },
        });
      }
    },
  );
});
