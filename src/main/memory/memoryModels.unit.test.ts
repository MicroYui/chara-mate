import { estimateInputBudget, fitsInputBudget } from "../providers/inputBudget";
import type { ModelRequest } from "../agent/modelProvider";
import { modelTimeContext } from "../agent/modelTimeContext";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import type { MemoryEvidenceItem } from "../../shared/contracts/memoryRecall";
import type { ModelProvider } from "../agent/modelProvider";
import {
  ModelMemoryFormation,
  ModelMemoryEvidenceSelector,
  type MemoryFormationInput,
} from "./memoryModels";

function operationFixture(operation: "create" | "revise" | "support") {
  const sourceId = randomUUID();
  const target: MemoryEvidenceItem = {
    memoryId: randomUUID(),
    revisionId: randomUUID(),
    type: "event",
    content: "用户已经买了相机。",
    entityIds: [],
    sourceRefs: [],
    recordedAt: "2026-09-14T12:00:00.000Z",
    current: true,
    historyStatus: "current",
    questionIds: [],
    relations: [],
  };
  const contentUnit = {
    operation,
    targetRevisionId: operation === "create" ? null : target.revisionId,
    ...(operation === "create" ? { type: "project" } : {}),
    ...(operation === "revise"
      ? {
          retainedCitations: [],
          priorDispositions: [
            {
              scope: "revision",
              revisionId: target.revisionId,
              disposition: "corrected",
              sourceId,
              quote: "我还没决定买哪台相机，先只比较。",
            },
          ],
        }
      : {}),
    content: "用户尚未决定相机型号；先前购买完成的表述不成立。",
    semantics: {
      kind: "claim",
      owner: "user",
      personaId: null,
      basis: "explicit_user_statement",
      occurredFrom: null,
      occurredTo: null,
      timePrecision: "unknown",
      validFrom: null,
      validTo: null,
      subjectEntityId: null,
      predicate: "camera_selection",
      objectEntityId: null,
      objectValue: null,
      qualifiers: [{ key: "selection", value: "undecided" }],
      commitmentState: null,
    },
    entityKeys: [],
    citations: [
      { sourceId, quote: "我还没决定买哪台相机，先只比较。", occurrence: null },
    ],
    links: [],
  };
  const unit =
    operation === "support"
      ? {
          operation,
          targetRevisionId: target.revisionId,
          citations: contentUnit.citations,
          links: contentUnit.links,
        }
      : contentUnit;
  const stream = vi.fn<ModelProvider["stream"]>(async function* () {
    await Promise.resolve();
    yield {
      type: "text.delta",
      delta: JSON.stringify({ entities: [], units: [unit] }),
    };
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
    {},
    undefined,
    () => modelTimeContext("2026-09-15T12:00:00.000Z", "Asia/Shanghai"),
  );
  const input: MemoryFormationInput = {
    episode: {
      id: randomUUID(),
      version: "1",
      recordedAt: "2026-09-15T12:00:00.000Z",
      sources: [
        {
          id: sourceId,
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: unit.citations[0]!.quote,
          occurredAt: "2026-09-15T12:00:00.000Z",
        },
      ],
      evidenceSourceIds: [sourceId],
    },
    existing: [target],
    entities: [],
  };
  return {
    model,
    stream,
    input,
    target,
    unit,
    form: () => model.prepare(input).form(new AbortController().signal),
  };
}

describe("Memory formation operation fields", () => {
  it("lets creation select its category and restores its nullable fields", async () => {
    const f = operationFixture("create");
    const result = await f.form();
    expect(result.units[0]).toMatchObject({
      operation: "create",
      type: "project",
      semantics: { qualifiers: { selection: "undecided" } },
    });
    expect(result.units[0]).not.toHaveProperty("targetRevisionId");
    expect(result.units[0]).not.toHaveProperty("semantics.personaId");
    expect(result.units[0]!.citations[0]).not.toHaveProperty("occurrence");
  });

  it.each(["revise"] as const)(
    "inherits only the supplied target category for %s and restores nullable fields",
    async (operation) => {
      const f = operationFixture(operation);
      const result = await f.form();
      expect(result.units[0]).toMatchObject({
        operation,
        targetRevisionId: f.target.revisionId,
        type: "event",
        content: "用户尚未决定相机型号；先前购买完成的表述不成立。",
        semantics: { kind: "claim", qualifiers: { selection: "undecided" } },
      });
      expect(result.units[0]).not.toHaveProperty("semantics.occurredFrom");
      expect(result.units[0]!.citations[0]).not.toHaveProperty("occurrence");
      const validate = new Ajv({ strict: false }).compile(
        f.stream.mock.calls[0]![0].structuredOutput!.schema,
      );
      expect(validate({ entities: [], units: [f.unit] })).toBe(true);
      expect(
        validate({
          entities: [],
          units: [{ ...f.unit, type: "event" }],
        }),
      ).toBe(false);
    },
  );

  it.each(["revise", "support"] as const)(
    "rejects the old %s output with a repeated type instead of overwriting it",
    async (operation) => {
      const f = operationFixture(operation);
      Object.assign(f.unit, { type: "project" });
      await expect(f.form()).rejects.toThrow("rejected value");
      expect(f.stream).toHaveBeenCalledOnce();
    },
  );

  it("decodes support as only a target plus new citations and links", async () => {
    const f = operationFixture("support");
    const result = await f.form();
    expect(result.units[0]).toEqual({
      operation: "support",
      targetRevisionId: f.target.revisionId,
      citations: [
        {
          sourceId: f.unit.citations[0]!.sourceId,
          quote: f.unit.citations[0]!.quote,
        },
      ],
      links: [],
    });
    const validate = new Ajv({ strict: false }).compile(
      f.stream.mock.calls[0]![0].structuredOutput!.schema,
    );
    expect(validate({ entities: [], units: [f.unit] })).toBe(true);
    for (const field of ["content", "type", "semantics", "entityKeys"])
      expect(
        validate({
          entities: [],
          units: [{ ...f.unit, [field]: "not an operation field" }],
        }),
      ).toBe(false);
  });

  it("requires an explicit retained-citation selection only on revise", async () => {
    const f = operationFixture("revise");
    Reflect.deleteProperty(f.unit, "retainedCitations");
    await expect(f.form()).rejects.toThrow("rejected value");
  });

  it.each(["create", "support"] as const)(
    "rejects prior source retention on %s",
    async (operation) => {
      const f = operationFixture(operation);
      Object.assign(f.unit, { retainedCitations: [] });
      await expect(f.form()).rejects.toThrow("rejected value");
    },
  );

  it("rejects an update target that was not supplied", async () => {
    const f = operationFixture("revise");
    f.unit.targetRevisionId = randomUUID();
    await expect(f.form()).rejects.toThrow("supplied target revision");
  });

  it("uses the category from the same request snapshot across generation", async () => {
    const f = operationFixture("revise");
    const result = f.form();
    f.input.existing[0]!.type = "project";
    expect((await result).units[0]).toHaveProperty("type", "event");
    const supplied = JSON.parse(
      (f.stream.mock.calls[0]![0].input[0] as { content: string }).content,
    ) as { existing: MemoryEvidenceItem[] };
    expect(supplied.existing[0]!.type).toBe("event");
  });
});

describe("fixed Memory model execution", () => {
  it("estimates, measures and generates the same complete prepared request and time snapshot", async () => {
    const usage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 };
    const stream = vi.fn<ModelProvider["stream"]>(async function* () {
      await Promise.resolve();
      yield {
        type: "text.delta",
        delta: '{"entities":[],"units":[]}',
      };
      yield {
        type: "response.completed",
        responseId: "r1",
        status: "completed",
        usage,
      };
    });
    const onUsage = vi.fn();
    const getTimeContext = vi
      .fn(() => modelTimeContext("2026-09-15T00:00:00.000Z", "Asia/Shanghai"))
      .mockReturnValueOnce(
        modelTimeContext("2026-09-14T00:00:00.000Z", "Asia/Shanghai"),
      );
    const estimateInput = vi.fn<ModelProvider["estimateInput"]>((request) =>
      estimateInputBudget(request, request.modelId),
    );
    const measureInput = vi.fn<ModelProvider["measureInput"]>(
      (request, signal) => {
        signal.throwIfAborted();
        return Promise.resolve({
          ...estimateInputBudget(request, request.modelId),
          exactInputTokens: 1200,
        });
      },
    );
    const model = new ModelMemoryFormation(
      {
        stream,
        measureInput,
        estimateInput,
        resolveContextLimits: () => Promise.resolve({}),
      },
      "fixed-model",
      {},
      onUsage,
      getTimeContext,
    );
    const sourceId = randomUUID();
    const input: MemoryFormationInput = {
      episode: {
        id: randomUUID(),
        version: "source-v1",
        recordedAt: "2026-09-15T12:00:00.000Z",
        sources: [
          {
            id: sourceId,
            referenceId: randomUUID(),
            type: "chat",
            speaker: "user",
            content: "今天聊了聊",
            occurredAt: "2026-08-15T12:00:00.000Z",
          },
        ],
        evidenceSourceIds: [sourceId],
      },
      existing: [],
      entities: [],
    };
    const originalInput = structuredClone(input);
    const signal = new AbortController().signal;
    const prepared = model.prepare(input);
    input.episode.sources[0]!.content = "准备之后调用者修改的内容";
    expect(prepared.estimateInput().budget).toBe(258000);
    const measured = await prepared.measureInput(signal);
    expect(measured.measurement.exactInputTokens).toBe(1200);
    expect(measured.budget).toBe(258000);
    expect(stream).not.toHaveBeenCalled();
    await expect(prepared.form(signal)).resolves.toEqual({
      entities: [],
      units: [],
    });
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]![0].modelId).toBe("fixed-model");
    expect(onUsage).toHaveBeenCalledWith(usage);
    const request = stream.mock.calls[0]![0];
    expect(estimateInput.mock.calls[0]![0]).toBe(request);
    expect(measureInput).toHaveBeenCalledExactlyOnceWith(request, signal, {
      requireExact: true,
    });
    expect(measureInput.mock.calls[0]![0]).toBe(request);
    expect(request.structuredOutput?.name).toBe("memory_formation");
    expect(request.structuredOutput?.schema).toHaveProperty("properties.units");
    expect(request.toolNamespaces).toEqual([]);
    expect(getTimeContext).toHaveBeenCalledOnce();
    const context: unknown = JSON.parse(
      (request.input[0] as { content: string }).content,
    );
    expect(context).toEqual({
      ...originalInput,
      timeContext: modelTimeContext(
        "2026-09-14T00:00:00.000Z",
        "Asia/Shanghai",
      ),
    });
    expect(request.instructions).toContain("never the later processing date");
    expect(request.instructions).toContain("null UTC bounds");
  });

  it("reports the lower Provider input allowance for the complete request", async () => {
    const f = operationFixture("create");
    const provider: ModelProvider = {
      stream: f.stream,
      estimateInput: (request) => estimateInputBudget(request, request.modelId),
      measureInput: (request) =>
        Promise.resolve({
          ...estimateInputBudget(request, request.modelId),
          exactInputTokens: 9001,
        }),
      resolveContextLimits: () => Promise.resolve({}),
    };
    const model = new ModelMemoryFormation(provider, "fixed-model", {
      effectiveInputTokens: 12000,
      maxPromptTokens: 11000,
      maxContextTokens: 10000,
      maxOutputTokens: 1000,
    });
    const prepared = model.prepare(f.input);
    expect(prepared.estimateInput().budget).toBe(9000);
    const measured = await prepared.measureInput(new AbortController().signal);
    expect(measured.budget).toBe(9000);
    expect(fitsInputBudget(measured.measurement, measured.budget)).toBe(false);
    expect(f.stream).not.toHaveBeenCalled();
  });

  it("does not publish a measurement or generate after cancellation", async () => {
    const f = operationFixture("create");
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const measureInput = vi.fn<ModelProvider["measureInput"]>(
      (request) =>
        new Promise((resolve) => {
          release = () =>
            resolve(estimateInputBudget(request, request.modelId));
        }),
    );
    const onUsage = vi.fn();
    const model = new ModelMemoryFormation(
      {
        stream: f.stream,
        estimateInput: (request) =>
          estimateInputBudget(request, request.modelId),
        measureInput,
        resolveContextLimits: () => Promise.resolve({}),
      },
      "fixed-model",
      {},
      onUsage,
    );
    const prepared = model.prepare(f.input);
    const pending = prepared.measureInput(controller.signal);
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(prepared.form(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.stream).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
  });
});

function formationFixture(
  entity: Record<string, unknown>,
  entities: MemoryFormationInput["entities"] = [],
) {
  const stream = vi.fn<ModelProvider["stream"]>(async function* () {
    await Promise.resolve();
    yield {
      type: "text.delta",
      delta: JSON.stringify({ entities: [entity], units: [] }),
    };
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
    {},
  );
  const sourceId = randomUUID();
  const input: MemoryFormationInput = {
    episode: {
      id: randomUUID(),
      version: "source-v1",
      personaId: randomUUID(),
      recordedAt: "2026-09-15T12:00:00.000Z",
      evidenceSourceIds: [sourceId],
      sources: [
        {
          id: sourceId,
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: "昨天你陪我找到了那家书店。",
          occurredAt: "2026-09-15T12:00:00.000Z",
        },
      ],
    },
    existing: [],
    entities,
  };
  return { model, stream, input };
}

const localEntity = {
  key: "companion",
  name: "同行陪伴者",
  kind: "character",
  aliases: ["你"],
};

describe("Memory formation entity references", () => {
  it("allows only null when no existing Memory entity was supplied", async () => {
    const { model, stream, input } = formationFixture({
      ...localEntity,
      existingEntityIndex: null,
    });
    await expect(
      model.prepare(input).form(new AbortController().signal),
    ).resolves.toEqual({ entities: [localEntity], units: [] });
    const schema = stream.mock.calls[0]![0].structuredOutput!.schema;
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(
      validate({
        entities: [{ ...localEntity, existingEntityIndex: null }],
        units: [],
      }),
    ).toBe(true);
    expect(
      validate({
        entities: [{ ...localEntity, existingEntityIndex: 0 }],
        units: [],
      }),
    ).toBe(false);
  });

  it.each([0, 2, null])(
    "decodes index %s against the exact request entity list",
    async (index) => {
      const entities = Array.from({ length: 3 }, (_, i) => ({
        id: randomUUID(),
        name: `同行者${i}`,
        kind: "character",
      }));
      const { model, stream, input } = formationFixture(
        { ...localEntity, existingEntityIndex: index },
        entities,
      );
      const result = await model
        .prepare(input)
        .form(new AbortController().signal);
      expect(result.entities).toEqual([
        {
          ...localEntity,
          ...(index === null ? {} : { existingId: entities[index]!.id }),
        },
      ]);
      const request = stream.mock.calls[0]![0];
      const supplied = JSON.parse(
        (request.input[0] as { content: string }).content,
      ) as { entities: unknown[] };
      expect(supplied.entities).toEqual(
        entities.map((entity, index) => ({ ...entity, index })),
      );
      const validate = new Ajv({ strict: false }).compile(
        request.structuredOutput!.schema,
      );
      expect(
        validate({
          entities: [{ ...localEntity, existingEntityIndex: -1 }],
          units: [],
        }),
      ).toBe(false);
      expect(
        validate({
          entities: [{ ...localEntity, existingEntityIndex: 3 }],
          units: [],
        }),
      ).toBe(false);
      expect(
        validate({
          entities: [{ ...localEntity, existingEntityIndex: index }],
          units: [],
        }),
      ).toBe(true);
    },
  );

  it.each([-1, 0.5, 1, "00000000-0000-4000-8000-000000000099"])(
    "rejects invalid reference %s before domain application",
    async (index) => {
      const { model, input } = formationFixture(
        { ...localEntity, existingEntityIndex: index },
        [{ id: randomUUID(), name: "同行者", kind: "character" }],
      );
      await expect(
        model.prepare(input).form(new AbortController().signal),
      ).rejects.toThrow();
    },
  );

  it("does not accept a Persona identity as an existing Memory entity", async () => {
    const { model, input } = formationFixture({
      ...localEntity,
      existingId: "persona-identity",
    });
    input.episode.personaId = "persona-identity";
    await expect(
      model.prepare(input).form(new AbortController().signal),
    ).rejects.toThrow();
  });

  it("keeps one entity mapping when the caller changes its array during generation", async () => {
    const entities = [
      { id: randomUUID(), name: "甲", kind: "person" },
      { id: randomUUID(), name: "乙", kind: "person" },
    ];
    const original = entities.map((entity) => ({ ...entity }));
    const { model, stream, input } = formationFixture(
      { ...localEntity, existingEntityIndex: 1 },
      entities,
    );
    const pending = model.prepare(input).form(new AbortController().signal);
    entities.reverse();
    entities[0]!.id = randomUUID();
    entities[0]!.name = "后来修改的名字";
    expect((await pending).entities[0]!.existingId).toBe(original[1]!.id);
    const request = stream.mock.calls[0]![0];
    const supplied = JSON.parse(
      (request.input[0] as { content: string }).content,
    ) as { entities: unknown[] };
    expect(supplied.entities).toEqual(
      original.map((entity, index) => ({ ...entity, index })),
    );
  });
});

it("passes an explicit unknown calendar through actual selection without inventing a date scope", async () => {
  const stream = vi.fn<ModelProvider["stream"]>(async function* () {
    await Promise.resolve();
    yield {
      type: "text.delta",
      delta:
        '{"selected":[],"coverage":[{"questionIndex":0,"status":"missing","candidateIndices":[]}]}',
    };
    yield {
      type: "response.completed",
      responseId: "offline",
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
  });
  const model = new ModelMemoryEvidenceSelector(
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
    "fixture",
    undefined,
    () => modelTimeContext("2026-09-15T00:00:00.000Z", null),
  );
  const input: Parameters<ModelMemoryEvidenceSelector["select"]>[0] = {
    plan: {
      purpose: "conversation",
      questions: [{ id: "q1", text: "今天说了什么" }],
      query: "今天说了什么",
      contextBudget: { maxTokens: 4000 },
    },
    candidates: [
      {
        memoryId: randomUUID(),
        revisionId: randomUUID(),
        type: "event",
        content: "Recorded event",
        entityIds: [],
        sourceRefs: [],
        recordedAt: "2026-09-15T00:00:00.000Z",
        current: true,
        historyStatus: "current",
        questionIds: [],
        relations: [],
      },
    ],
  };
  await model.select(input);
  const context: unknown = JSON.parse(
    (stream.mock.calls[0]![0].input[0] as { content: string }).content,
  );
  expect(context).toEqual({
    plan: {
      ...input.plan,
      questions: input.plan.questions.map((item, index) => ({
        ...item,
        index,
      })),
    },
    candidates: input.candidates.map((item, index) => ({ ...item, index })),
    timeContext: {
      now: "2026-09-15T00:00:00.000Z",
      timeZone: null,
      localDateTime: null,
    },
  });
});

describe("formation validation feedback request materialization", () => {
  it("distinguishes delivered conversational progress from another promise or claimed external completion", async () => {
    const f = operationFixture("revise");
    await f.form();
    const request = f.stream.mock.calls[0]![0];
    expect(f.stream).toHaveBeenCalledTimes(1);
    expect(f.model.version).toBe(
      "source-evidence-formation-v24-delivered-conversation:fixed-model",
    );
    expect(request.instructions).toContain(
      "local conversational progress on the same supplied active commitment",
    );
    expect(request.instructions).toContain(
      "preserve its character, subject, object, original commitment occurrence and active state",
    );
    expect(request.instructions).toContain(
      "a current primary quote containing the actual work",
    );
    expect(request.instructions).toContain(
      "Do not create another promise or use support for changed progress",
    );
    expect(request.instructions).toContain(
      "does not prove full-goal completion, a file edit, user reading or acceptance, or an external action",
    );
    expect(request.instructions).toContain(
      "Completed commitments still require actual execution/environment evidence",
    );
    expect(request.instructions).toContain(
      "a completed world activity of kind experience requires direct_observation supported by an actual current primary tool source",
    );
    expect(request.instructions).not.toContain(
      "directly establish only this current character making or withdrawing",
    );
    // These are delivered request-contract assertions, not model understanding.
    expect(request.toolNamespaces).toEqual([]);
    expect(request.input).toHaveLength(1);
  });

  it("keeps the ordinary prompt unchanged and supplies the full prior proposal and diagnoses only on replacement", async () => {
    const f = operationFixture("create");
    const signal = new AbortController().signal;
    const first = await f.model.prepare(f.input).form(signal);
    const initial = f.stream.mock.calls[0]![0];
    expect(initial.instructions).not.toContain(
      "If validationFeedback is present",
    );
    const validationFeedback = {
      proposal: first,
      issues: [
        {
          unitIndex: 0,
          field: "semantics.basis",
          message: "Explicit user memory requires an actual user source",
        },
      ],
    };
    await f.model.prepare({ ...f.input, validationFeedback }).form(signal);
    const replacement = f.stream.mock.calls[1]![0];
    expect(replacement.instructions).toContain("complete replacement proposal");
    const supplied = JSON.parse(
      (replacement.input[0] as { content: string }).content,
    ) as Record<string, unknown>;
    expect(supplied["validationFeedback"]).toEqual(validationFeedback);
    const firstMaterial = JSON.parse(
      (initial.input[0] as { content: string }).content,
    ) as Record<string, unknown>;
    delete supplied["validationFeedback"];
    expect(supplied).toEqual(firstMaterial);
    expect(replacement.structuredOutput).toEqual(initial.structuredOutput);
  });
});

describe("Selector supplied identities and same-call correction", () => {
  const originalIds = [
    "ce31dcc0-fd52-4c65-a410-7892303bbef8",
    "b5eb22d2-8b09-4c52-a06c-b0ea5d0ed73e",
    "c7d21176-6385-4fc3-a4a8-1b182ca82e8c",
  ];
  const invalidOriginal = {
    selected: [
      { revisionId: originalIds[0], questionIds: ["q0"] },
      { revisionId: originalIds[1], questionIds: ["q1"] },
      { revisionId: "c7d21176-6385-4fc3-a4a1-c9a44389edf3", questionIds: [] },
    ],
    coverage: [],
  };
  function fixture(outputs: unknown[]) {
    const requests: ModelRequest[] = [];
    const usage = vi.fn();
    let onRequest = () => {};
    const stream = vi.fn<ModelProvider["stream"]>(async function* (request) {
      await Promise.resolve();
      requests.push(structuredClone(request));
      onRequest();
      const value = outputs[requests.length - 1];
      if (value instanceof Error) throw value;
      yield {
        type: "text.delta",
        delta: typeof value === "string" ? value : JSON.stringify(value),
      };
      yield {
        type: "response.completed",
        responseId: `offline-${requests.length}`,
        status: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      };
    });
    const model = new ModelMemoryEvidenceSelector(
      {
        stream,
        estimateInput: (request) =>
          estimateInputBudget(request, request.modelId),
        measureInput(request, signal) {
          signal.throwIfAborted();
          return Promise.resolve(this.estimateInput(request));
        },
        resolveContextLimits: () =>
          Promise.resolve({ effectiveInputTokens: 258000 }),
      },
      "fixture",
      usage,
      () => modelTimeContext("2026-09-15T00:00:00.000Z", "Asia/Shanghai"),
    );
    const input: Parameters<ModelMemoryEvidenceSelector["select"]>[0] = {
      plan: {
        purpose: "recollection",
        query: "reminder",
        questions: originalIds.map((_, index) => ({
          id: `q${index}`,
          text: `Recorded statement ${index}`,
        })),
        contextBudget: { maxTokens: 8000 },
      },
      candidates: originalIds.map((revisionId, index) => ({
        memoryId: randomUUID(),
        revisionId,
        type: "event",
        content: `Recorded statement ${index}`,
        entityIds: [],
        sourceRefs: [],
        recordedAt: "2026-09-15T00:00:00.000Z",
        current: true,
        historyStatus: "current",
        questionIds: [],
        relations: [],
      })),
    };
    const corrected = {
      selected: originalIds.map((_, index) => ({
        candidateIndex: index,
        questionIndices: [index],
      })),
      coverage: originalIds.map((_, index) => ({
        questionIndex: index,
        status: "supported",
        candidateIndices: [index],
      })),
    };
    return {
      input,
      corrected,
      requests,
      model,
      stream,
      usage,
      onRequest: (callback: () => void) => {
        onRequest = callback;
      },
    };
  }
  it("corrects the mixed supplied-id failure and missing question coverage within one frozen selection", async () => {
    const f = fixture([]);
    const supplied = structuredClone(f.input);
    const outputs = [invalidOriginal, f.corrected];
    // Keep the observed failure shape, with short independent question IDs.
    f.stream.mockImplementation(async function* (request) {
      await Promise.resolve();
      f.requests.push(structuredClone(request));
      if (f.requests.length === 1)
        f.input.candidates[0]!.content = "caller changed after materialization";
      yield {
        type: "text.delta",
        delta: JSON.stringify(outputs[f.requests.length - 1]),
      };
      yield {
        type: "response.completed",
        responseId: `offline-${f.requests.length}`,
        status: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      };
    });
    const controller = new AbortController();
    const result = await f.model.select(f.input, controller.signal);
    expect(
      f.stream.mock.calls.every((call) => call[1] === controller.signal),
    ).toBe(true);
    expect(result).toEqual({
      selected: originalIds.map((revisionId, index) => ({
        revisionId,
        questionIds: [`q${index}`],
      })),
      coverage: originalIds.map((revisionId, index) => ({
        questionId: `q${index}`,
        status: "supported",
        revisionIds: [revisionId],
      })),
    });
    expect(result.coverage).toHaveLength(3);
    expect(f.stream).toHaveBeenCalledTimes(2);
    expect(f.usage).toHaveBeenCalledTimes(2);
    type SuppliedMaterial = {
      plan: unknown;
      candidates: MemoryEvidenceItem[];
      validationFeedback?: { proposal: unknown; issues: string[] };
    };
    const first = JSON.parse(
      (f.requests[0]!.input[0] as { content: string }).content,
    ) as SuppliedMaterial;
    const second = JSON.parse(
      (f.requests[1]!.input[0] as { content: string }).content,
    ) as SuppliedMaterial;
    expect(first.plan).toEqual({
      ...supplied.plan,
      questions: supplied.plan.questions.map((item, index) => ({
        ...item,
        index,
      })),
    });
    expect(first.candidates).toEqual(
      supplied.candidates.map((item, index) => ({ ...item, index })),
    );
    expect(second.validationFeedback!.proposal).toEqual(invalidOriginal);
    expect(second.validationFeedback!.issues.length).toBeGreaterThan(0);
    delete second.validationFeedback;
    expect(second).toEqual(first);
  });
  it("preserves shared-candidate question mapping and permits a relevant replacement in correction", async () => {
    const f = fixture([]);
    const answer = {
      selected: [{ candidateIndex: 2, questionIndices: [0, 1, 2] }],
      coverage: [0, 1, 2].map((questionIndex) => ({
        questionIndex,
        status: "partial",
        candidateIndices: [2],
      })),
    };
    let replies = 0;
    f.stream.mockImplementation(async function* () {
      await Promise.resolve();
      yield {
        type: "text.delta",
        delta: JSON.stringify(++replies === 1 ? invalidOriginal : answer),
      };
      yield {
        type: "response.completed",
        responseId: "offline",
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      };
    });
    const result = await f.model.select(f.input);
    expect(result.selected).toEqual([
      { revisionId: originalIds[2], questionIds: ["q0", "q1", "q2"] },
    ]);
    expect(result.coverage.every((c) => c.status === "partial")).toBe(true);
    expect(f.stream).toHaveBeenCalledTimes(2);
    const request = f.stream.mock.calls[0]![0];
    const validates = new Ajv({ strict: false }).compile(
      request.structuredOutput!.schema,
    );
    expect(validates(answer)).toBe(true);
    expect(
      validates({
        ...answer,
        selected: [{ candidateIndex: 3, questionIndices: [0] }],
      }),
    ).toBe(false);
    expect(
      validates({
        ...answer,
        selected: [{ candidateIndex: 0, questionIndices: [3] }],
      }),
    ).toBe(false);
  });
  it.each([
    "duplicate_candidate",
    "empty_mapping",
    "duplicate_question",
    "missing_coverage",
    "duplicate_coverage",
    "unselected_coverage",
    "out_of_range",
  ] as const)(
    "rejects a second %s without a third model request",
    async (kind) => {
      const f = fixture([]);
      const bad = structuredClone(f.corrected);
      if (kind === "duplicate_candidate") bad.selected.push(bad.selected[0]!);
      if (kind === "empty_mapping") bad.selected[0]!.questionIndices = [];
      if (kind === "duplicate_question")
        bad.selected[0]!.questionIndices = [0, 0];
      if (kind === "missing_coverage") bad.coverage.pop();
      if (kind === "duplicate_coverage") bad.coverage[1] = bad.coverage[0]!;
      if (kind === "unselected_coverage")
        bad.coverage[0]!.candidateIndices = [1];
      if (kind === "out_of_range") bad.selected[0]!.candidateIndex = 3;
      f.stream.mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: "text.delta", delta: JSON.stringify(bad) };
        yield {
          type: "response.completed",
          responseId: "offline",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        };
      });
      await expect(f.model.select(f.input)).rejects.toThrow();
      expect(f.stream).toHaveBeenCalledTimes(2);
    },
  );
  it("handles empty domains without a model or fabricated coverage", async () => {
    const f = fixture([]);
    f.input.candidates = [];
    expect(await f.model.select(f.input)).toEqual({
      selected: [],
      coverage: [0, 1, 2].map((i) => ({
        questionId: `q${i}`,
        status: "missing",
        revisionIds: [],
      })),
    });
    f.input.plan.questions = [];
    expect(await f.model.select(f.input)).toEqual({
      selected: [],
      coverage: [],
    });
    expect(f.stream).not.toHaveBeenCalled();
  });
  it("does not treat a Provider error or cancellation as a correctable selection", async () => {
    const error = new Error("Provider preflight or transport failed");
    const f = fixture([error]);
    await expect(f.model.select(f.input)).rejects.toBe(error);
    expect(f.stream).toHaveBeenCalledTimes(1);
    const cancelled = fixture([invalidOriginal]);
    const controller = new AbortController();
    cancelled.onRequest(() => controller.abort(error));
    await expect(
      cancelled.model.select(cancelled.input, controller.signal),
    ).rejects.toBe(error);
    expect(cancelled.stream).toHaveBeenCalledTimes(1);
  });
});
