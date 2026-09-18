import { CognitionInputBudgetError } from "./cognitionTypes";
import { modelTimeContext } from "../agent/modelTimeContext";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import { defaultPersonaSnapshot } from "../persona/personaPresets";
import {
  estimateInputBudget,
  INPUT_BUDGET_ESTIMATE_RATIO,
  fitsInputBudget,
} from "../providers/inputBudget";
import {
  ModelCognitionDriver,
  type ModelCognitionDriverOptions,
} from "./cognitionDriver";
import type {
  CognitionAnalysisInput,
  CognitionEvidence,
  CognitionSelectedBasis,
} from "./cognitionTypes";
import {
  CognitionReferenceError,
  resolveCognitionAnalysis,
} from "./cognitionProjection";
import { decodeCognitionModelOutput } from "./cognitionModelOutput";

const now = "2026-09-15T01:00:00.000Z";
function fixture(options: Partial<ModelCognitionDriverOptions> = {}) {
  let persona = defaultPersonaSnapshot(now);
  const attention = {
    personaId: persona.personaId,
    revision: 0,
    userGeneration: 0,
    focusRevision: 0,
    lastReceiptSequence: 0,
    analyzedThroughSequence: 0,
    updatedAt: now,
  };
  const input: CognitionAnalysisInput = {
    attempt: {
      id: randomUUID(),
      personaId: persona.personaId,
      status: "analyzing",
      trigger: "semantic_change",
      throughSequence: 0,
      dependencies: {
        personaId: persona.personaId,
        userGeneration: 0,
        receivedThroughSequence: 0,
        focusRevision: 0,
        situations: [],
        intents: [],
        evidenceIds: [],
      },
      dispatchKey: "synthetic:request",
      feedbackEvidenceIds: [],
      createdAt: now,
      updatedAt: now,
    },
    snapshot: {
      attention,
      situations: [],
      intents: [],
      evidence: [],
      recentAttempts: [],
    },
    availability: {
      userEngaged: false,
      activeUserRunIds: [],
      chatRuns: [],
      activeVoice: false,
      sleeping: false,
      hasOutstandingBubble: false,
      mayInitiateConversation: true,
      characterTools: [],
      mayActInTerritory: true,
    },
  };
  const answer = {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: {
        currentSituationId: { op: "clear" },
        committedIntentId: { op: "keep" },
      },
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          intentId: null,
          situationId: null,
          instruction: null,
          evidenceIds: [],
          rationale: "目前没有需要打断的事",
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
      reason: "证据不足",
    },
    recallPlan: null,
  };
  const requests: ModelRequest[] = [];
  let budget = 258_000;
  let onStream = (): void => {};
  let responseText: string | undefined;
  const provider: ModelProvider = {
    measureInput(request: ModelRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      return Promise.resolve(this.estimateInput(request));
    },
    estimateInput: (request) => estimateInputBudget(request, request.modelId),
    resolveContextLimits: () =>
      Promise.resolve({ effectiveInputTokens: budget }),
    stream: async function* (request): AsyncIterable<ModelEvent> {
      requests.push(request);
      onStream();
      await Promise.resolve();
      yield {
        type: "text.delta",
        delta: responseText ?? JSON.stringify(answer),
      };
      yield {
        type: "response.completed",
        responseId: "offline",
        status: "completed",
        usage: { cachedInputTokens: 0, inputTokens: 200, outputTokens: 100 },
      };
    },
  };
  const usage = vi.fn();
  const driver = new ModelCognitionDriver({
    getTimeContext: () => modelTimeContext(now, "Asia/Shanghai"),
    getPersona: () => persona,
    createRuntime: () => Promise.resolve({ provider, modelId: "gpt-6-astra" }),
    onUsage: usage,
    ...options,
  });
  return {
    input,
    driver,
    provider,
    requests,
    usage,
    getAnswer: () => structuredClone(answer),
    setResponseText: (value: string) => {
      responseText = value;
    },
    setBasis: (basis: CognitionSelectedBasis) => {
      answer.decision.selectedBasis =
        basis as typeof answer.decision.selectedBasis;
      answer.decision.choices[0]!.evidenceIds = basis.evidenceUses.map(
        ({ evidenceId }) => evidenceId,
      ) as never[];
    },
    setAttention: (value: unknown) => {
      answer.delta.attention = value as typeof answer.delta.attention;
    },
    setBudget: (value: number) => {
      budget = value;
    },
    setPersona: (value: typeof persona) => {
      persona = value;
    },
    getPersona: () => persona,
    onStream: (callback: () => void) => {
      onStream = callback;
    },
  };
}

function supplySourceCoverage(
  h: ReturnType<typeof fixture>,
  completionPending = false,
) {
  const source = h.input.snapshot.evidence[0] ?? suppliedRead(h);
  if (!h.input.snapshot.evidence.length) h.input.snapshot.evidence.push(source);
  if (typeof source.text !== "string")
    throw new Error("Fixture needs source text");
  const textRange = {
    startCharacter: 0,
    endCharacter: Array.from(source.text).length,
    totalCharacters: Array.from(source.text).length,
  };
  const catalogueId = "source:1";
  const sourceCoverage: NonNullable<
    CognitionAnalysisInput["attempt"]["sourceCoverage"]
  > = {
    fromSequence: source.receiptSequence - 1,
    throughSequence: source.receiptSequence,
    receivedThroughSequence: source.receiptSequence,
    eventCount: 1,
    entries: [
      {
        id: catalogueId,
        fromSequence: source.receiptSequence,
        throughSequence: source.receiptSequence,
        firstEvidenceId: source.id,
        latestEvidenceId: source.id,
        actor: source.actor,
        kind: source.kind,
        sourceKind: source.source.kind,
        firstAt: source.observedAt,
        lastAt: source.observedAt,
        eventCount: 1,
        requiresBody: true,
        textBytes: Buffer.byteLength(source.text),
        visualCount: 0,
        changes: [],
        omittedChangeCount: 0,
      },
    ],
    supplied: [
      {
        evidenceId: source.id,
        receiptSequence: source.receiptSequence,
        textRange,
        status: "complete",
      },
    ],
    unopenedCount: 0,
    omittedEventCount: 0,
    completionPending,
    ...(completionPending
      ? {
          readPlan: {
            requests: [
              {
                catalogueId,
                evidenceId: source.id,
                question: "原文说了什么？",
              },
            ],
          },
          readResults: [
            { evidenceId: source.id, textRange, status: "complete" as const },
          ],
        }
      : {}),
  };
  h.input.attempt.sourceCoverage = structuredClone(sourceCoverage);
  h.input.coverage = {
    excerptedEvidenceIds: [],
    omittedSituationCount: 0,
    omittedIntentCount: 0,
    omittedAttemptCount: 0,
    note: "本次实际供给的来源目录。",
    sourceCoverage,
  };
  return sourceCoverage;
}

function expectSingleSourceCoverage(
  request: ModelRequest,
  sourceCoverage: ReturnType<typeof supplySourceCoverage>,
) {
  const context = JSON.parse(
    (request.input[0] as { content: string }).content,
  ) as CognitionAnalysisInput;
  expect(context.attempt).not.toHaveProperty("sourceCoverage");
  expect(context.coverage?.sourceCoverage).toEqual(sourceCoverage);
}

describe("read-only model cognition driver", () => {
  it("preserves distinct source catalogues rather than discarding different material", async () => {
    const h = fixture();
    const sourceCoverage = supplySourceCoverage(h, true);
    sourceCoverage.readResults = [
      {
        evidenceId: sourceCoverage.supplied[0]!.evidenceId,
        status: "released",
      },
    ];
    const inputBefore = structuredClone(h.input);
    await h.driver.analyze(h.input, new AbortController().signal);
    const context = JSON.parse(
      (h.requests[0]!.input[0] as { content: string }).content,
    ) as CognitionAnalysisInput;
    expect(context.attempt.sourceCoverage).toEqual(
      inputBefore.attempt.sourceCoverage,
    );
    expect(context.coverage).toEqual(inputBefore.coverage);
    expect(context.attempt.sourceCoverage).not.toEqual(
      context.coverage?.sourceCoverage,
    );
    expect(h.input).toEqual(inputBefore);
  });

  it("keeps an attempt-only source catalogue in the model coverage without changing host input", async () => {
    const h = fixture();
    const sourceCoverage = supplySourceCoverage(h, true);
    delete h.input.coverage;
    const inputBefore = structuredClone(h.input);
    await h.driver.analyze(h.input, new AbortController().signal);
    expectSingleSourceCoverage(h.requests[0]!, sourceCoverage);
    expect(h.input).toEqual(inputBefore);
  });

  it.each([false, true])(
    "sends one unchanged source catalogue while preserving host input (completionPending=%s)",
    async (completionPending) => {
      const h = fixture();
      const sourceCoverage = supplySourceCoverage(h, completionPending);
      const inputBefore = structuredClone(h.input);
      const expected = decodeCognitionModelOutput(h.getAnswer(), h.input);
      await expect(
        h.driver.analyze(h.input, new AbortController().signal),
      ).resolves.toEqual(expected);
      expect(h.requests).toHaveLength(1);
      expectSingleSourceCoverage(h.requests[0]!, sourceCoverage);
      expect(h.input).toEqual(inputBefore);
    },
  );

  it("preserves the complete Persona when exact input fits despite its estimate", async () => {
    const h = fixture();
    h.setBudget(1_000);
    h.provider.measureInput = (request, signal) => {
      signal.throwIfAborted();
      return Promise.resolve({
        ...h.provider.estimateInput(request),
        exactInputTokens: 1_000,
      });
    };
    await h.driver.analyze(h.input, new AbortController().signal);
    expect(h.requests).toHaveLength(1);
    const body = JSON.stringify(h.requests[0]!.input);
    expect(body).not.toContain("personaCoverage");
    expect(body).toContain(h.getPersona().displayName);
  });

  it("does not generate after cancellation during preflight measurement", async () => {
    const h = fixture();
    const controller = new AbortController();
    const reason = new Error("Analysis preparation cancelled");
    h.provider.measureInput = (request, signal) => {
      signal.throwIfAborted();
      controller.abort(reason);
      return Promise.resolve({
        ...h.provider.estimateInput(request),
        exactInputTokens: 100,
      });
    };
    await expect(h.driver.analyze(h.input, controller.signal)).rejects.toBe(
      reason,
    );
    expect(h.requests).toHaveLength(0);
  });
  it("uses the real current Persona, strict schema and no Tools while restoring optional nulls", async () => {
    const h = fixture();
    h.input.availability.characterTools = [
      {
        name: "territory.act",
        summary: "Move in the current home",
        description: "Use current target affordances",
        effect: "write",
      },
    ];
    const result = await h.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(result.recallPlan).toBeUndefined();
    expect(result.delta.attention.currentSituationId).toBeNull();
    expect(result.delta.attention).not.toHaveProperty("committedIntentId");
    expect(result.decision.choices[0]?.intentId).toBeUndefined();
    const request = h.requests[0]!;
    expect(request.toolNamespaces).toEqual([]);
    const supplied = JSON.parse(
      (request.input[0] as { content: string }).content,
    ) as { availability: { characterTools: unknown } };
    expect(supplied.availability.characterTools).toEqual(
      h.input.availability.characterTools,
    );
    expect(request.structuredOutput?.name).toBe(
      "charamate_cognition_analysis_v8",
    );
    expect(request.structuredOutput?.schema["additionalProperties"]).toBe(
      false,
    );
    expect(JSON.stringify(request.input)).toContain(h.getPersona().displayName);
    expect(h.usage).toHaveBeenCalledWith(
      { cachedInputTokens: 0, inputTokens: 200, outputTokens: 100 },
      h.input.attempt.id,
    );
  });

  it("preserves omitted current entities with keep instead of resubmitting them as a selection", async () => {
    const h = fixture();
    const currentSituationId = randomUUID(),
      committedIntentId = randomUUID();
    Object.assign(h.input.snapshot.attention, {
      currentSituationId,
      committedIntentId,
    });
    h.setAttention({
      currentSituationId: { op: "keep" },
      committedIntentId: { op: "keep" },
    });
    const result = await h.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(result.delta.attention).toEqual({});
    expect(() =>
      resolveCognitionAnalysis(h.input.snapshot, result, now),
    ).not.toThrow();
    expect(h.input.snapshot.attention).toMatchObject({
      currentSituationId,
      committedIntentId,
    });
    h.setAttention({
      currentSituationId: { op: "set", id: currentSituationId },
      committedIntentId: { op: "keep" },
    });
    const beforeInvalid = h.requests.length;
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toBeInstanceOf(CognitionReferenceError);
    expect(h.requests).toHaveLength(beforeInvalid + 2);
  });

  it("maps each independent keep, clear and set operation before domain validation", async () => {
    const h = fixture();
    const id = randomUUID();
    h.setAttention({
      currentSituationId: { op: "keep" },
      committedIntentId: { op: "set", id },
    });
    expect(
      decodeCognitionModelOutput(h.getAnswer(), h.input).delta.attention,
    ).toEqual({ committedIntentId: id });
    h.setAttention({
      currentSituationId: { op: "set", id: "new:current" },
      committedIntentId: { op: "clear" },
    });
    expect(
      decodeCognitionModelOutput(h.getAnswer(), h.input).delta.attention,
    ).toEqual({ currentSituationId: "new:current", committedIntentId: null });
    h.setAttention({
      currentSituationId: { op: "set", id: "not-an-entity-reference" },
      committedIntentId: { op: "keep" },
    });
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow("Schema");
  });

  it.each([
    {},
    { currentSituationId: null, committedIntentId: null },
    {
      currentSituationId: { op: "unknown" },
      committedIntentId: { op: "keep" },
    },
    { currentSituationId: { op: "set" }, committedIntentId: { op: "keep" } },
    {
      currentSituationId: { op: "keep", id: "new:surplus" },
      committedIntentId: { op: "keep" },
    },
  ])(
    "rejects an ambiguous or invalid wire attention operation %j",
    async (attention) => {
      const h = fixture();
      h.setAttention(attention);
      await expect(
        h.driver.analyze(h.input, new AbortController().signal),
      ).rejects.toThrow("Schema");
    },
  );

  it("rejects Persona revision changes and cancellation after a model result", async () => {
    const h = fixture();
    h.onStream(() =>
      h.setPersona({
        ...h.getPersona(),
        revision: h.getPersona().revision + 1,
      }),
    );
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow("Persona revision changed");
    const cancelled = fixture();
    const abort = new AbortController();
    cancelled.onStream(() => abort.abort());
    await expect(
      cancelled.driver.analyze(cancelled.input, abort.signal),
    ).rejects.toThrow();
  });

  it("reads the current clock again for completion without rewriting evidence timestamps", async () => {
    let current = "2026-09-14T23:40:00.000Z";
    const h = fixture({
      getTimeContext: () => modelTimeContext(current, "Asia/Shanghai"),
    });
    await h.driver.analyze(h.input, new AbortController().signal);
    current = "2026-09-15T00:00:00.000Z";
    await h.driver.analyze(h.input, new AbortController().signal);
    const contexts = h.requests.map(
      (request): unknown =>
        JSON.parse(
          (request.input[0] as { content: string }).content,
        ) as unknown,
    );
    expect(contexts[0]).toMatchObject({
      timeContext: { localDateTime: "2026-09-15T07:40:00.000" },
      attempt: { createdAt: now },
    });
    expect(contexts[1]).toMatchObject({
      timeContext: { localDateTime: "2026-09-15T08:00:00.000" },
      attempt: { createdAt: now },
    });
  });

  it("budgets system instructions and output schema before sending a request", async () => {
    const h = fixture();
    h.setBudget(1_000);
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toBeInstanceOf(CognitionInputBudgetError);
    expect(h.requests).toEqual([]);
  });

  it("marks Persona field excerpts when the complete request cannot fit a full Persona", async () => {
    const h = fixture();
    const sourceCoverage = supplySourceCoverage(h, true);
    const inputBefore = structuredClone(h.input);
    h.setPersona({
      ...h.getPersona(),
      background: "背景".repeat(1000),
      identity: "身份".repeat(1000),
      motivations: "动机".repeat(1000),
      values: "价值".repeat(1000),
      speechStyle: "表达".repeat(1000),
      initiativeStyle: "主动".repeat(1000),
      addressStyle: "称呼".repeat(1000),
      knowledgeBoundary: "边界".repeat(1000),
    });
    await h.driver.analyze(h.input, new AbortController().signal);
    const full = h.requests[0]!;
    const budget = estimateInputBudget(full).estimatedTokens;
    h.setBudget(budget);
    await h.driver.analyze(h.input, new AbortController().signal);
    const partial = h.requests[1]!;
    expect(JSON.stringify(partial.input)).toContain("personaCoverage");
    expect(JSON.stringify(partial.input)).toContain("2026-09-15T09:00:00.000");
    expect(JSON.stringify(partial.input)).toContain("Asia/Shanghai");
    expect(fitsInputBudget(estimateInputBudget(partial), budget)).toBe(true);
    expectSingleSourceCoverage(full, sourceCoverage);
    expectSingleSourceCoverage(partial, sourceCoverage);
    expect(h.input).toEqual(inputBefore);
  });
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
  "base64",
);
function visualEvidence(
  h: ReturnType<typeof fixture>,
  revision: string,
  sequence: number,
) {
  const id = randomUUID();
  return {
    id,
    personaId: h.input.attempt.personaId,
    actor: "user" as const,
    source: { kind: "activity" as const, id },
    kind: "observation" as const,
    object: { key: "surface:test:epoch", identity: "adapter" as const },
    observedAt: now,
    receivedAt: now,
    receiptSequence: sequence,
    visual: {
      eventId: id,
      artifactId: randomUUID(),
      contentRevision: revision,
      capturedAt: now,
      width: 1,
      height: 1,
      trigger: "frame" as const,
      surface: {
        id: "test",
        epoch: "epoch",
        displayId: "1",
        windowId: "1",
        processId: 1,
        appName: "Synthetic",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        scaleFactor: 1,
        clipped: false,
      },
    },
  };
}

describe("Cognition actual image inputs", () => {
  it("resolves the latest supplied frame of a surface and sends real input_image blocks with source labels", async () => {
    const resolve = vi.fn<
      NonNullable<ModelCognitionDriverOptions["resolveVisual"]>
    >(() =>
      Promise.resolve({
        status: "available" as const,
        bytes: png,
        mediaType: "image/png" as const,
      }),
    );
    const h = fixture({ resolveVisual: resolve });
    const old = visualEvidence(h, "old", 1),
      latest = visualEvidence(h, "latest", 2);
    h.input.snapshot.evidence = [old, latest];
    h.input.snapshot.attention.foregroundObject = latest.object;
    await h.driver.analyze(h.input, new AbortController().signal);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0]).toEqual(latest.visual);
    const req = h.requests[0]!;
    const message = req.input[1] as {
      content: { type: string; image_url?: string; text?: string }[];
    };
    expect(message.content[0]?.text).toContain(latest.id);
    expect(message.content[1]).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${png.toString("base64")}`,
      detail: "auto",
    });
    expect(JSON.stringify(req.input[0])).not.toContain(png.toString("base64"));
    expect(estimateInputBudget(req, "gpt-6-astra").unknownKinds).toEqual([]);
    expect(
      estimateInputBudget(req, "gpt-6-astra").estimatedTokens,
    ).toBeGreaterThan(36000);
  });

  it("marks unavailable pixels and image-budget omissions without pretending a reference is visible", async () => {
    const h = fixture({
      resolveVisual: () =>
        Promise.resolve({
          status: "unavailable",
          reason: "The original frame asset is unavailable.",
        }),
    });
    h.input.snapshot.evidence = [visualEvidence(h, "missing", 1)];
    await h.driver.analyze(h.input, new AbortController().signal);
    expect(h.requests[0]!.input).toHaveLength(1);
    expect(JSON.stringify(h.requests[0]!.input)).toContain(
      "frame asset is unavailable",
    );
    const limited = fixture({
      resolveVisual: () =>
        Promise.resolve({
          status: "available",
          bytes: png,
          mediaType: "image/png",
        }),
    });
    await limited.driver.analyze(limited.input, new AbortController().signal);
    const textCost = estimateInputBudget(
      limited.requests[0]!,
      "gpt-6-astra",
    ).estimatedTokens;
    limited.setBudget(Math.ceil(textCost / 0.9) + 5000);
    limited.input.snapshot.evidence = [visualEvidence(limited, "budget", 1)];
    await limited.driver.analyze(limited.input, new AbortController().signal);
    expect(limited.requests[1]!.input).toHaveLength(1);
    expect(JSON.stringify(limited.requests[1]!.input)).toContain("omitted");
    expect(
      fitsInputBudget(
        estimateInputBudget(limited.requests[1]!, "gpt-6-astra"),
        Math.ceil(textCost / 0.9) + 5000,
      ),
    ).toBe(true);
  });
});

describe("v5 recollection wire semantics", () => {
  it("carries the actual reading metadata and decodes current recollection usage without inventing a user utterance", async () => {
    const h = fixture();
    const evidenceId = randomUUID();
    h.input.snapshot.evidence.push({
      id: evidenceId,
      personaId: h.input.attempt.personaId,
      actor: "system",
      kind: "recollection",
      text: "用户此前说喜欢晚饭后散步",
      source: {
        kind: "memory",
        id: randomUUID(),
        revision: randomUUID(),
        fragment: h.input.attempt.id,
      },
      observedAt: now,
      receivedAt: now,
      receiptSequence: 1,
      recollection: {
        historyStatus: "current",
        type: "preference",
        current: true,
        basis: "explicit_user_statement",
        owner: "user",
        recordedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    h.input.attempt.dependencies.evidenceIds = [evidenceId];
    h.setBasis({
      choiceId: "quiet",
      evidenceUses: [{ evidenceId, use: "current_recollection" }],
      currentClaimRefs: [],
    });
    const result = await h.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(result.decision.selectedBasis.evidenceUses).toEqual([
      { evidenceId, use: "current_recollection" },
    ]);
    expect(() =>
      resolveCognitionAnalysis(h.input.snapshot, result, now),
    ).not.toThrow();
    const wire = h.requests[0]!;
    expect(wire.structuredOutput?.name).toBe("charamate_cognition_analysis_v8");
    const supplied = JSON.stringify(wire.input);
    expect(supplied).toContain('\\"kind\\":\\"recollection\\"');
    expect(supplied).toContain('\\"actor\\":\\"system\\"');
    expect(wire.instructions).toContain("owner is not its speaker");
    expect(wire.instructions).toContain("23:59");
    expect(wire.instructions).toContain(
      "supporting and contradicting evidence ID",
    );
  });
});

function suppliedRead(h: ReturnType<typeof fixture>): CognitionEvidence {
  return {
    id: randomUUID(),
    personaId: h.input.attempt.personaId,
    actor: "agent",
    kind: "effect",
    source: { kind: "run", id: randomUUID() },
    observedAt: now,
    receivedAt: now,
    receiptSequence: 1,
    text: "territory.observe 返回圆凳 reachable=true，读取成功；尚未坐下。",
    effect: {
      runId: randomUUID(),
      description: "房间读取成功，未改变世界",
      sourceRefs: [],
      callId: "read-current-room",
      outcome: "performed",
      worldChange: "unchanged",
    },
  };
}

function selectRead(
  h: ReturnType<typeof fixture>,
  source: CognitionEvidence,
  use: "history" | "current_object",
) {
  h.setBasis({
    choiceId: "quiet",
    evidenceUses: [{ evidenceId: source.id, use }],
    currentClaimRefs: [],
  });
}

describe("supplied source-use correction", () => {
  it("returns a complete model correction with the same source/image/schema prefix and records both usages", async () => {
    const resolveVisual = vi.fn(() =>
      Promise.resolve({
        status: "available" as const,
        bytes: png,
        mediaType: "image/png" as const,
      }),
    );
    const h = fixture({ resolveVisual });
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source, visualEvidence(h, "room", 1)];
    const sourceCoverage = supplySourceCoverage(h, true);
    selectRead(h, source, "current_object");
    const original = h.getAnswer();
    const inputBefore = structuredClone(h.input);
    h.onStream(() => {
      if (h.requests.length === 2) selectRead(h, source, "history");
    });
    const result = await h.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(result.decision.selectedBasis.evidenceUses).toEqual([
      { evidenceId: source.id, use: "history" },
    ]);
    expect(result.delta).toEqual({
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: { currentSituationId: null },
    });
    expect(h.requests).toHaveLength(2);
    const [first, second] = h.requests;
    expect(second!.input.slice(0, -1)).toEqual(first!.input);
    expect(second!.structuredOutput).toEqual(first!.structuredOutput);
    expect(second!.instructions).toBe(first!.instructions);
    expectSingleSourceCoverage(first!, sourceCoverage);
    expectSingleSourceCoverage(second!, sourceCoverage);
    const feedback = JSON.parse(
      (second!.input.at(-1) as { content: string }).content,
    ) as { validationFeedback: { proposal: unknown; issues: unknown[] } };
    expect(feedback.validationFeedback.proposal).toEqual(original);
    expect(feedback.validationFeedback.issues).toMatchObject([
      {
        evidenceId: source.id,
        actualKind: "effect",
        hasObject: false,
        typeEligibleUses: ["history"],
      },
    ]);
    expect(h.usage).toHaveBeenCalledTimes(2);
    expect(resolveVisual).toHaveBeenCalledTimes(1);
    expect(h.input).toEqual(inputBefore);
  });

  it("keeps independently supported claims and their selected current dependencies in the full replacement", async () => {
    const h = fixture();
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source];
    selectRead(h, source, "current_object");
    const first = h.getAnswer();
    const wire = {
      ...first,
      delta: {
        ...first.delta,
        createSituations: [
          {
            localId: "new:room",
            value: {
              status: "current",
              title: "刚读取的房间",
              summary: "看到可坐的圆凳，未执行坐下",
              objectRefs: [],
              episodes: [],
              claims: [
                {
                  id: "read-result",
                  text: "本次读取返回圆凳可达可坐",
                  basis: "observed",
                  state: "supported",
                  evidenceIds: [source.id],
                  contradictingEvidenceIds: [],
                },
              ],
              unresolved: [],
              relatedSituationIds: [],
            },
          },
        ],
      },
      decision: {
        ...first.decision,
        selectedBasis: {
          ...first.decision.selectedBasis,
          currentClaimRefs: [
            { situationId: "new:room", claimId: "read-result" },
          ],
        },
      },
    };
    h.setResponseText(JSON.stringify(wire));
    h.onStream(() => {
      if (h.requests.length === 2)
        h.setResponseText(
          JSON.stringify({
            ...wire,
            decision: {
              ...wire.decision,
              selectedBasis: {
                ...wire.decision.selectedBasis,
                evidenceUses: [{ evidenceId: source.id, use: "history" }],
              },
            },
          }),
        );
    });
    const result = await h.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(result.delta.createSituations).toEqual(wire.delta.createSituations);
    expect(result.decision.selectedBasis.currentClaimRefs).toEqual(
      wire.decision.selectedBasis.currentClaimRefs,
    );
    expect(() =>
      resolveCognitionAnalysis(h.input.snapshot, result, now),
    ).not.toThrow();
  });

  it("does not rewrite an invalid proposal or call a third time", async () => {
    const h = fixture();
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source];
    selectRead(h, source, "current_object");
    const before = h.getAnswer();
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow(`kind=effect, object=absent`);
    expect(h.requests).toHaveLength(2);
    expect(h.usage).toHaveBeenCalledTimes(2);
    expect(h.getAnswer()).toEqual(before);
  });

  it("reports unknown source IDs without guessing and shares the one correction limit", async () => {
    const h = fixture();
    const absent = suppliedRead(h);
    selectRead(h, absent, "current_object");
    const before = h.getAnswer();
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow("Reference not supplied");
    expect(h.requests).toHaveLength(2);
    expect(h.usage).toHaveBeenCalledTimes(2);
    expect(h.getAnswer()).toEqual(before);
    const feedback = JSON.parse(
      (h.requests[1]!.input.at(-1) as { content: string }).content,
    ) as { validationFeedback: { proposal: unknown; issues: unknown[] } };
    expect(feedback.validationFeedback.proposal).toEqual(before);
    expect(feedback.validationFeedback.issues).toContainEqual(
      expect.objectContaining({
        kind: "reference_not_supplied",
        field: "decision.selectedBasis.evidenceUses[0].evidenceId",
        evidenceId: absent.id,
        scope: "actual_evidence",
        suppliedPaths: ["snapshot.evidence[].id"],
      }),
    );
  });

  it("does not grant a second correction when a reference repair still has an invalid source use", async () => {
    const h = fixture();
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source];
    selectRead(h, suppliedRead(h), "current_object");
    h.onStream(() => {
      if (h.requests.length === 2) selectRead(h, source, "current_object");
    });
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow("kind=effect, object=absent");
    expect(h.requests).toHaveLength(2);
    expect(h.usage).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "json", "schema"])(
    "does not repeat a %s failure",
    async (kind) => {
      const h = fixture();
      const source = suppliedRead(h);
      h.input.snapshot.evidence = [source];
      selectRead(h, source, "current_object");
      if (kind === "network")
        h.onStream(() => {
          throw new Error("network fixture");
        });
      if (kind === "json") h.setResponseText("{invalid-json");
      if (kind === "schema") h.setResponseText("{}");
      await expect(
        h.driver.analyze(h.input, new AbortController().signal),
      ).rejects.toThrow();
      expect(h.requests).toHaveLength(1);
    },
  );

  it.each([1, 2])("stops cancellation at actual generation %i", async (at) => {
    const h = fixture();
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source];
    selectRead(h, source, "current_object");
    const abort = new AbortController();
    h.onStream(() => {
      if (h.requests.length === at) abort.abort();
    });
    await expect(h.driver.analyze(h.input, abort.signal)).rejects.toThrow();
    expect(h.requests).toHaveLength(at);
  });

  it("rejects a Persona revision change during the correction", async () => {
    const h = fixture();
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source];
    selectRead(h, source, "current_object");
    h.onStream(() => {
      if (h.requests.length === 2) {
        selectRead(h, source, "history");
        h.setPersona({
          ...h.getPersona(),
          revision: h.getPersona().revision + 1,
        });
      }
    });
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow("Persona revision changed");
    expect(h.requests).toHaveLength(2);
  });

  it("does not send a correction when the complete added proposal exceeds input space", async () => {
    const h = fixture();
    const source = suppliedRead(h);
    h.input.snapshot.evidence = [source];
    selectRead(h, source, "history");
    await h.driver.analyze(h.input, new AbortController().signal);
    h.setBudget(
      Math.ceil(
        (estimateInputBudget(h.requests[0]!).estimatedTokens + 50) /
          INPUT_BUDGET_ESTIMATE_RATIO,
      ),
    );
    selectRead(h, source, "current_object");
    await expect(
      h.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toThrow(
      "proposal correction exceeds the complete model input budget",
    );
    expect(h.requests).toHaveLength(2); // One earlier calibration and only the next initial generation.
    expect(h.requests[1]!.input).toHaveLength(h.requests[0]!.input.length);
  });
});
