import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import {
  createCognitionContextInput,
  materializeCognitionContextInput,
} from "../agent/cognitionContext";
import { CognitionRepository } from "./cognitionRepository";
import { readEvidence } from "./cognitionSnapshotReader";
import {
  CognitionService,
  type CognitionServiceOptions,
} from "./cognitionService";
import { CHARACTER_LIFE_PAUSED_BLOCKER } from "./cognitionTypes";
import { ModelCognitionDriver } from "./cognitionDriver";
import { defaultPersonaSnapshot } from "../persona/personaPresets";
import { modelTimeContext } from "../agent/modelTimeContext";
import type {
  ModelProvider,
  ModelRequest,
  ModelEvent,
} from "../agent/modelProvider";
import { estimateInputBudget, fitsInputBudget } from "../providers/inputBudget";
import {
  choiceBlockReason,
  projectCognitionContext,
  selectAnalysisSnapshot,
  opportunityIsCurrent,
} from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionDispatchRequest,
  CognitionChoice,
  CognitionDriver,
  CognitionEvidenceInput,
  CognitionEvidence,
  CognitionIntent,
  CognitionPreparedContext,
  CognitionRuntimeAvailability,
  CognitionRuntimePort,
  CognitionSituation,
} from "./cognitionTypes";
import type {
  EvidencePack,
  MemoryEvidenceResolution,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";

const now = "2026-09-15T08:00:00.000Z";
const personaId = "11111111-1111-4111-8111-111111111111";
const databases: Database.Database[] = [];
const services: CognitionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  databases.splice(0).forEach((database) => database.close());
});

function fixture(readBudgetBytes = 32_768) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  database
    .prepare(
      "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, now, now);
  const repository = new CognitionRepository(database, {
    readBudgetBytes,
  });
  return { database, repository };
}

function observation(
  text = "面试材料 A",
  extra: Partial<CognitionEvidenceInput> = {},
): CognitionEvidenceInput {
  const id = randomUUID();
  return {
    id,
    personaId,
    actor: "user",
    source: { kind: "activity", id },
    observedAt: now,
    kind: "observation",
    boundary: "content",
    object: {
      key: "editor:document-a",
      identity: "adapter",
      appName: "Editor",
      title: "A",
    },
    visibility: {
      status: "available",
      source: "accessibility",
      scope: "focused_element",
    },
    text,
    ...extra,
  };
}

function quiet(evidenceIds: string[] = []): CognitionChoice {
  return {
    id: "quiet",
    kind: "remain_quiet",
    evidenceIds,
    rationale: "证据尚不足以打断",
    userImpact: "none",
    executionScope: "none",
    reversibility: "read_only",
    timing: "now",
    resumeConditions: [],
  };
}

function analysis(evidenceIds: string[] = []): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: {},
    },
    decision: {
      choices: [quiet(evidenceIds)],
      selectedChoiceId: "quiet",
      selectedBasis: {
        choiceId: "quiet",
        evidenceUses: evidenceIds.map((evidenceId) => ({
          evidenceId,
          use: "history" as const,
        })),
        currentClaimRefs: [],
      },
      reason: "继续观察真实情境",
    },
  };
}

function newSituation(
  evidenceId: string,
  localId = "new:materials",
  title = "准备材料",
) {
  const value: Omit<
    CognitionSituation,
    "id" | "personaId" | "revision" | "createdAt" | "updatedAt"
  > = {
    status: "current",
    title,
    summary: "材料还在修改，尚未投递",
    objectRefs: [],
    episodes: [
      {
        id: "episode-draft",
        label: "修改材料",
        state: "open",
        startedAt: now,
        evidenceIds: [evidenceId],
        objectKeys: ["editor:document-a"],
        boundaryReason: "开始处理材料",
      },
    ],
    claims: [
      {
        id: "visible-material",
        text: "材料页面可见",
        basis: "observed",
        state: "supported",
        evidenceIds: [evidenceId],
        contradictingEvidenceIds: [],
      },
    ],
    unresolved: ["材料是否属于用户尚未确认"],
    relatedSituationIds: [],
  };
  return { localId, value };
}

function runAnalysis(
  repository: CognitionRepository,
  output: CognitionAnalysis,
) {
  // These repository contract fixtures explicitly supply their chosen originals;
  // automatic selection is exercised through the actual Service tests.
  const read = repository.readSnapshot(
    personaId,
    now,
    undefined,
    undefined,
    output.decision.choices.flatMap((choice) => choice.evidenceIds),
  );
  let attempt = repository.createAttempt(
    read,
    "semantic_change",
    now,
    read.coverage.allocation,
    undefined,
    read.coverage.sourceCoverage,
  );
  attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
  return repository.commitAnalysis(attempt.id, output, now);
}

function availability(): CognitionRuntimeAvailability {
  return {
    userEngaged: false,
    activeUserRunIds: [],
    chatRuns: [],
    activeVoice: false,
    sleeping: false,
    hasOutstandingBubble: false,
    mayInitiateConversation: true,
    characterTools: [],
    mayActInTerritory: true,
  };
}

function serviceFixture(
  driver: CognitionDriver,
  pack?: EvidencePack,
  overrides: Partial<CognitionServiceOptions> = {},
) {
  const { database, repository } = fixture();
  let active = availability();
  const runtime = {
    availability: () => active,
    dispatch: vi.fn((request: CognitionDispatchRequest) => {
      request.prepareContext({
        maxReadBytes: 10_000,
        signal: new AbortController().signal,
      });
      const runId = randomUUID();
      database.transaction(() =>
        repository.bindDispatched(request.dispatchKey, runId, now),
      )();
      active = { ...active, activeCharacterRunId: runId };
      return Promise.resolve({ runId });
    }),
    yieldCharacterRun: vi.fn(() => {
      active = availability();
      return Promise.resolve();
    }),
    reconcileRun: () => ({ terminal: false, evidence: [] }),
  } satisfies CognitionRuntimePort;
  const memory = {
    validateEvidenceReferences: vi.fn(() => []),
    resolveEvidence: vi.fn((): MemoryEvidenceResolution => ({
      status: "resolved",
      items: pack?.items ?? [],
      readCost: { rawValueBytes: 100, rowCount: 1 },
    })),
    recall: vi
      .fn<(plan: RecallPlan, signal?: AbortSignal) => Promise<EvidencePack>>()
      .mockResolvedValue(
        pack ?? {
          items: [],
          coverage: [],
          gaps: [],
          estimatedTokens: 0,
          truncated: false,
          incompleteReasons: [],
        },
      ),
  };
  const errors: unknown[] = [];
  const service = new CognitionService({
    repository,
    driver,
    memory,
    runtime,
    clock: { now: () => now },
    activePersonaId: () => personaId,
    analysisReadBudgetBytes: 32_768,
    analysisBudgetTokens: 100_000,

    batchWindowMs: 10_000,
    onError: (error) => errors.push(error),
    ...overrides,
  });
  services.push(service);
  return {
    service,
    repository,
    database,
    runtime,
    memory,
    errors,
    setAvailability: (value: CognitionRuntimeAvailability) => {
      active = value;
    },
  };
}

describe("analysis byte allocation", () => {
  it("supplies only canonical source costs without inventing a pre-choice execution quota", async () => {
    const driver = {
      analyze: vi.fn((input: CognitionAnalysisInput) =>
        Promise.resolve(analysis(input.snapshot.evidence.map(({ id }) => id))),
      ),
    };
    const { service, database } = serviceFixture(driver, undefined, {});
    service.ingest(observation('第一段\n"引用"😀'));
    await service.runDue("2026-09-15T08:01:00.000Z");
    const input = driver.analyze.mock.calls[0]![0];
    expect(input.executionMaterial).not.toHaveProperty("maxEstimatedTokens");
    expect(
      input.executionMaterial?.sources.map(({ evidenceId }) => evidenceId),
    ).toEqual(input.snapshot.evidence.map(({ id }) => id));
    const source = input.executionMaterial!.sources[0]!;
    const row = database
      .prepare("SELECT payload_json FROM cognition_evidence WHERE id = ?")
      .get(source.evidenceId) as { payload_json: string };
    expect(source).toEqual({
      evidenceId: source.evidenceId,
      resolution: "evidence",
      fullPayloadBytes: Buffer.byteLength(row.payload_json, "utf8"),
    });
  });

  it("cost metadata does not load a large body, reveal another persona or invent missing-source cost", () => {
    const { repository, database } = fixture();
    const receipt = repository.ingest(
      observation("完整记录".repeat(10000)),
      now,
    ).evidence;
    const absent = randomUUID();
    const allocation = repository.actionMaterialSources(personaId, [
      receipt.id,
      receipt.id,
      absent,
    ]);
    const row = database
      .prepare(
        "SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM cognition_evidence WHERE id = ?",
      )
      .get(receipt.id) as { bytes: number };
    expect(allocation.sources).toEqual([
      {
        evidenceId: receipt.id,
        fullPayloadBytes: row.bytes,
        resolution: "evidence",
      },
      { evidenceId: absent, resolution: "unavailable" },
    ]);
    expect(
      repository.actionMaterialSources(randomUUID(), [receipt.id]).sources,
    ).toEqual([{ evidenceId: receipt.id, resolution: "unavailable" }]);
    expect(JSON.stringify(allocation)).not.toContain("完整记录");
  });

  it("honors an explicit read allocation without changing the default snapshot", () => {
    const { repository } = fixture();
    for (let index = 0; index < 70; index += 1)
      repository.ingest(
        observation(`${index}: ${"界面草稿，尚未发送。".repeat(40)}`, {
          object: { key: `document-${index}`, identity: "adapter" },
        }),
        now,
      );
    const ordinary = repository.readSnapshot(personaId, now);
    const enlarged = repository.readSnapshot(personaId, now, 131_072);
    expect(enlarged.snapshot.evidence.length).toBeGreaterThan(
      ordinary.snapshot.evidence.length,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          snapshot: enlarged.snapshot,
          coverage: enlarged.coverage,
        }),
      ),
    ).toBeGreaterThan(32_768);
    expect(repository.readSnapshot(personaId, now)).toEqual(ordinary);
  });

  it("keeps Recall tokens independent through the actual completion path", async () => {
    const supplied: CognitionAnalysisInput[] = [];
    const references = vi.fn(() => ({
      situationIds: [],
      intentIds: [],
      missingReferenceCount: 0,
      truncated: false,
    }));
    const f = serviceFixture(
      {
        analyze: (input) => {
          supplied.push(input);
          const output = analysis();
          if (!input.evidencePack)
            output.recallPlan = {
              purpose: "conversation",
              query: "此前约定",
              questions: [{ id: "q1", text: "此前约定是什么？" }],
              entityIds: [],
              contextBudget: { maxTokens: 90_000 },
            };
          return Promise.resolve(output);
        },
      },
      undefined,
      {
        analysisReadBudgetBytes: 131_072,
        analysisBudgetTokens: 4_096,
        resolveMemoryStateReferences: references,
      },
    );
    for (let index = 0; index < 70; index += 1)
      f.service.ingest(
        observation(`${index}: ${"界面草稿，尚未发送。".repeat(40)}`, {
          object: { key: `document-${index}`, identity: "adapter" },
        }),
      );
    await f.service.runDue("2026-09-15T08:00:10.000Z");
    expect(f.errors).toEqual([]);
    expect(supplied).toHaveLength(2);
    expect(f.memory.recall.mock.calls[0]![0].contextBudget.maxTokens).toBe(
      4_096,
    );
    expect(references).toHaveBeenCalledWith(personaId, [], 131_072);
    for (const input of supplied) {
      const bytes = Buffer.byteLength(
        JSON.stringify({ snapshot: input.snapshot, coverage: input.coverage }),
      );
      expect(bytes).toBeGreaterThan(32_768);
      expect(bytes).toBeLessThanOrEqual(131_072);
    }
  });
});

describe("complete PFC request reallocation", () => {
  function actualDriver(
    completeAfterRecall = false,
    invalidOversizedProposal = false,
  ) {
    const requests: ModelRequest[] = [];
    const supplied: CognitionAnalysisInput[] = [];
    const measurements: { request: ModelRequest; fits: boolean }[] = [];
    const persona = { ...defaultPersonaSnapshot(now), personaId };
    const provider: ModelProvider = {
      resolveContextLimits: () =>
        Promise.resolve({ effectiveInputTokens: 180_000 }),
      estimateInput: (request) => estimateInputBudget(request, request.modelId),
      measureInput(request, signal) {
        signal.throwIfAborted();
        const result = this.estimateInput(request);
        measurements.push({
          request: structuredClone(request),
          fits: fitsInputBudget(result, 180_000),
        });
        return Promise.resolve(result);
      },
      stream: async function* (request): AsyncIterable<ModelEvent> {
        requests.push(structuredClone(request));
        const context = JSON.parse(
          (request.input[0] as { content: string }).content,
        ) as CognitionAnalysisInput;
        const result = analysis();
        const wire = {
          ...result,
          delta: {
            ...result.delta,
            attention: {
              currentSituationId: invalidOversizedProposal
                ? { op: "set", id: randomUUID() }
                : { op: "keep" },
              committedIntentId: { op: "keep" },
            },
          },
          decision: {
            ...result.decision,
            ...(invalidOversizedProposal
              ? { reason: "Unsupplied target. ".repeat(10_000) }
              : {}),
            choices: result.decision.choices.map((value) => ({
              ...value,
              intentId: null,
              situationId: null,
              instruction: null,
            })),
          },
          sourceReadPlan:
            completeAfterRecall && !context.evidencePack
              ? {
                  requests: [
                    {
                      catalogueId:
                        context.coverage!.sourceCoverage!.entries.at(-1)!.id,
                      evidenceId:
                        context.coverage!.sourceCoverage!.entries.at(-1)!
                          .latestEvidenceId,
                      question: "What part of the actual layout is visible?",
                      startCharacter: 0,
                    },
                  ],
                }
              : null,
          recallPlan:
            completeAfterRecall && !context.evidencePack
              ? {
                  purpose: "conversation",
                  query: "prior work",
                  questions: [{ id: "q1", text: "What was agreed?" }],
                  entityIds: [],
                  contextBudget: { maxTokens: 4096 },
                }
              : null,
        };
        await Promise.resolve();
        yield { type: "text.delta", delta: JSON.stringify(wire) };
        yield {
          type: "response.completed",
          status: "completed",
          responseId: "offline",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        };
      },
    };
    const model = new ModelCognitionDriver({
      createRuntime: () =>
        Promise.resolve({ provider, modelId: "gpt-6-astra" }),
      getPersona: () => persona,
      getTimeContext: () => modelTimeContext(now, "UTC"),
    });
    const driver: CognitionDriver = {
      analyze(input, signal) {
        supplied.push(structuredClone(input));
        return model.analyze(input, signal);
      },
    };
    return { driver, provider, supplied, measurements, requests };
  }

  it.each([false, true])(
    "recompiles actual SQLite supply before generation without replaying Recall (completion=%s)",
    async (completion) => {
      const m = actualDriver(completion);
      const pack: EvidencePack = {
        items: [],
        coverage: [],
        gaps: [
          {
            questionId: "q1",
            reason: "No exact prior source was found.".repeat(200),
          },
        ],
        estimatedTokens: 0,
        truncated: false,
        incompleteReasons: [],
      };
      const f = serviceFixture(m.driver, pack, {
        analysisReadBudgetBytes: 131_072,
        batchWindowMs: 0,
      });
      const prior = f.repository.createAttempt(
        f.repository.readSnapshot(personaId, now),
        "resume",
        "2026-09-15T07:59:00.000Z",
      );
      f.repository.saveAttempt({
        ...prior,
        status: "failed",
        error:
          "Previous action lacked the exact target; inspect the current receipt.",
      });
      f.service.ingest(
        observation("Current question", {
          actor: "user",
          kind: "utterance",
          source: { kind: "run", id: randomUUID(), fragment: randomUUID() },
        }),
      );
      const large = observation("Actual layout receipt: ".repeat(15000), {
        actor: "agent",
        object: { key: "territory:layout", identity: "adapter" },
      });
      f.service.ingest(large);
      const canonical = () =>
        f.database
          .prepare("SELECT payload_json FROM cognition_evidence WHERE id = ?")
          .get(large.id);
      const original = canonical();
      let lateId: string | undefined;
      const measure = m.provider.measureInput.bind(m.provider);
      m.provider.measureInput = (request, signal) => {
        if (!lateId) {
          const late = observation("Later ordinary window observation", {
            object: { key: "other:new", identity: "adapter" },
          });
          lateId = f.repository.ingest(late, now).evidence.id;
        }
        return measure(request, signal);
      };
      await f.service.runDue(now);
      expect(f.errors).toEqual([]);
      expect(m.measurements.some((value) => !value.fits)).toBe(true);
      expect(m.requests).toHaveLength(completion ? 2 : 1);
      expect(f.memory.recall).toHaveBeenCalledTimes(completion ? 1 : 0);
      const first = m.supplied[0]!;
      expect(new Set(m.supplied.map((value) => value.attempt.id)).size).toBe(1);
      for (const request of m.requests)
        expect(
          fitsInputBudget(m.provider.estimateInput(request), 180_000),
        ).toBe(true);
      const final = m.supplied.at(-1)!;
      for (const input of m.supplied) {
        expect(input.attempt.dependencies.receivedThroughSequence).toBe(
          first.attempt.dependencies.receivedThroughSequence,
        );
        expect(input.attempt.throughSequence).toBeLessThanOrEqual(
          first.attempt.throughSequence,
        );
        expect(input.snapshot.evidence.some(({ id }) => id === lateId)).toBe(
          false,
        );
        expect(
          input.snapshot.recentAttempts.some(
            ({ id, error }) =>
              id === prior.id &&
              error ===
                "Previous action lacked the exact target; inspect the current receipt.",
          ),
        ).toBe(true);
      }

      expect(final.attempt.dependencies.evidenceIds).toEqual(
        final.snapshot.evidence.map(({ id }) => id),
      );
      expect(final.attempt.allocation).toEqual(final.coverage?.allocation);
      expect(final.attempt.sourceCoverage).toEqual(
        final.coverage?.sourceCoverage,
      );
      expect(
        final.executionMaterial?.sources.map(({ evidenceId }) => evidenceId),
      ).toEqual(final.snapshot.evidence.map(({ id }) => id));
      expect(
        final.snapshot.evidence.find(({ id }) => id === large.id)?.text,
      ).toContain("INCOMPLETE EXCERPT");
      expect(canonical()).toEqual(original);
      const saved = f.repository.getAttempt(first.attempt.id)!;
      expect(saved.status).not.toBe("failed");
      expect(saved.dependencies.evidenceIds).toEqual(
        final.attempt.dependencies.evidenceIds,
      );
      expect(
        f.repository.getAttention(personaId, now).analyzedThroughSequence,
      ).toBe(saved.throughSequence);
      if (completion) {
        expect(
          m.supplied.filter((value) => value.evidencePack).length,
        ).toBeGreaterThan(1);
        expect(final.evidencePack).toEqual(pack);
        expect(final.coverage?.sourceCoverage?.completionPending).toBe(true);
        const firstCompletion = m.supplied.find((value) => value.evidencePack)!;
        expect(final.coverage?.sourceCoverage?.readPlan).toEqual(
          firstCompletion.coverage?.sourceCoverage?.readPlan,
        );
        expect(
          final.coverage?.sourceCoverage?.readResults?.find(
            (value) => value.evidenceId === large.id,
          ),
        ).toMatchObject({
          status: "excerpted",
          textRange: {
            startCharacter: 0,
            totalCharacters: [...large.text!].length,
          },
        });

        expect(final.attempt.dependencies.receivedThroughSequence).toBe(
          first.attempt.dependencies.receivedThroughSequence,
        );
      }
    },
  );
  it("does not recompile or regenerate an already generated invalid proposal whose correction cannot fit", async () => {
    const m = actualDriver(false, true);
    const f = serviceFixture(m.driver, undefined, {
      analysisReadBudgetBytes: 131_072,
      batchWindowMs: 0,
    });
    f.service.ingest(observation("A small current receipt."));
    await f.service.runDue(now);
    expect(m.requests).toHaveLength(1);
    expect(m.supplied).toHaveLength(1);
    expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain(
      "proposal correction exceeds the complete model input budget",
    );
    expect(f.repository.getAttempt(m.supplied[0]!.attempt.id)?.status).toBe(
      "failed",
    );
    expect(f.memory.recall).not.toHaveBeenCalled();
  });

  it("cancels a held pre-generation measurement when actual user control changes", async () => {
    const m = actualDriver();
    const f = serviceFixture(m.driver, undefined, {
      analysisReadBudgetBytes: 131_072,
      batchWindowMs: 0,
    });
    f.service.ingest(observation("Large current receipt. ".repeat(15_000)));
    const measure = m.provider.measureInput.bind(m.provider);
    let supplied: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      supplied = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    m.provider.measureInput = async (request, signal) => {
      supplied!();
      await gate;
      return measure(request, signal);
    };
    const running = f.service.runDue(now);
    await held;
    f.service.ingest(
      observation("stop", { kind: "control", control: "user_stop" }),
    );
    release!();
    await running;
    expect(m.requests).toHaveLength(0);
    expect(m.supplied).toHaveLength(1);
    expect(f.repository.getAttempt(m.supplied[0]!.attempt.id)?.status).toBe(
      "superseded",
    );
    expect(f.memory.recall).not.toHaveBeenCalled();
  });
});

describe("Cognition state and evidence", () => {
  it("deduplicates source receipts and preserves capture-time actors", () => {
    const { repository } = fixture();
    const value = observation();
    const first = repository.ingest(value, now);
    const duplicate = repository.ingest({ ...value, id: randomUUID() }, now);
    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ evidence: first.evidence, inserted: false });
    expect(() => repository.ingest({ ...value, actor: "agent" }, now)).toThrow(
      "actor",
    );
    expect(repository.getSnapshot(personaId, now).evidence).toHaveLength(1);
  });

  it("does not persist protected text or promote an agent object to user focus", () => {
    const { repository } = fixture();
    expect(() =>
      repository.ingest(
        observation("password", { visibility: { status: "protected" } }),
        now,
      ),
    ).toThrow("Protected");
    repository.ingest(observation("角色正在布置", { actor: "agent" }), now);
    expect(
      repository.getSnapshot(personaId, now).attention.foregroundObject,
    ).toBeUndefined();
  });

  it("stores two situations in the same application and links a cross-app continuation", () => {
    const { repository } = fixture();
    const first = repository.ingest(observation(), now).evidence;
    const second = repository.ingest(
      observation("朋友的论文", {
        object: { key: "editor:paper", identity: "adapter", appName: "Editor" },
      }),
      now,
    ).evidence;
    const output = analysis([first.id, second.id]);
    output.delta.createSituations = [
      newSituation(first.id),
      newSituation(second.id, "new:paper", "朋友的论文"),
    ];
    output.delta.attention.currentSituationId = "new:paper";
    const attempt = runAnalysis(repository, output);
    repository.saveAttempt({ ...attempt, status: "settled", outcome: "quiet" });
    const situations = repository.getSnapshot(personaId, now).situations;
    expect(situations.map(({ title }) => title).sort()).toEqual([
      "准备材料",
      "朋友的论文",
    ]);
    const original = situations.find(({ title }) => title === "准备材料")!;
    const browser = repository.ingest(
      observation("材料提交要求", {
        object: {
          key: "browser:requirements",
          identity: "adapter",
          appName: "Browser",
        },
      }),
      now,
    ).evidence;
    const followup = analysis([browser.id]);
    const { id, revision } = original;
    const value = newSituation(first.id).value;
    followup.delta.updateSituations = [
      {
        id,
        expectedRevision: revision,
        value: {
          ...value,
          objectRefs: [
            {
              key: "browser:requirements",
              identity: "adapter",
              appName: "Browser",
            },
          ],
          episodes: [
            ...value.episodes,
            {
              id: "requirements",
              label: "查看要求",
              state: "open",
              startedAt: now,
              evidenceIds: [browser.id],
              objectKeys: ["browser:requirements"],
              boundaryReason: "同一材料的要求",
            },
          ],
        },
      },
    ];
    followup.delta.attention.currentSituationId = id;
    runAnalysis(repository, followup);
    expect(repository.getSituation(id)?.episodes).toHaveLength(2);
    expect(repository.getSnapshot(personaId, now).situations).toHaveLength(2);
  });

  it("rolls back all entity changes when a claim cites missing evidence", () => {
    const { repository } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const output = analysis([evidence.id]);
    output.delta.createSituations = [newSituation(randomUUID())];
    expect(() => runAnalysis(repository, output)).toThrow("Unknown evidence");
    expect(repository.getSnapshot(personaId, now).situations).toEqual([]);
    expect(
      repository.getAttention(personaId, now).analyzedThroughSequence,
    ).toBe(0);
  });

  it("rejects observed claims sourced only from assistant narration", () => {
    const { repository } = fixture();
    const evidence = repository.ingest(
      observation("我已经做好了", {
        actor: "agent",
        kind: "utterance",
        source: { kind: "message", id: randomUUID() },
      }),
      now,
    ).evidence;
    const output = analysis([evidence.id]);
    output.delta.createSituations = [newSituation(evidence.id)];
    expect(() => runAnalysis(repository, output)).toThrow(
      "Observed claim contains non-observation evidence",
    );
  });

  it("rejects adopted inferred user goals and character completion without an effect", () => {
    const { repository } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const output = analysis([evidence.id]);
    output.delta.createIntents = [
      {
        localId: "new:submit",
        value: {
          owner: "user",
          basis: "inferred_user",
          status: "active",
          goal: "提交材料",
          successCriteria: ["已提交"],
          evidenceIds: [evidence.id],
          blockers: [],
          resumeConditions: [],
          progress: "尚未提交",
          effectEvidenceIds: [],
        },
      },
    ];
    expect(() => runAnalysis(repository, output)).toThrow("cannot become");
    const pendingId = repository.getSnapshot(personaId, now).recentAttempts[0]!
      .id;
    const pending = repository.getAttempt(pendingId)!;
    repository.saveAttempt({ ...pending, status: "failed" });
    output.delta.createIntents[0]!.value = {
      ...output.delta.createIntents[0]!.value,
      owner: "character",
      basis: "character",
      status: "fulfilled",
    };
    expect(() => runAnalysis(repository, output)).toThrow(
      "completion requires",
    );
  });

  it("rejects stale user-generation analysis but keeps count-only updates compatible", () => {
    const { repository } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    let attempt = repository.createAttempt(
      repository.readSnapshot(personaId, now),
      "semantic_change",
      now,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    repository.ingest(
      observation("", {
        boundary: "interaction",
        interaction: { clicks: 1, keystrokes: 4, scrolls: 0 },
      }),
      now,
    );
    expect(repository.getAttention(personaId, now).userGeneration).toBe(
      attempt.dependencies.userGeneration,
    );
    repository.ingest(
      observation("这是朋友的材料", {
        kind: "control",
        control: "user_correction",
      }),
      now,
    );
    expect(() =>
      repository.commitAnalysis(attempt.id, analysis([evidence.id]), now),
    ).toThrow("User control changed");
  });

  it("retains history after a focus change while invalidating the proposed interruption", () => {
    const { repository } = fixture();
    const first = repository.ingest(observation(), now).evidence;
    let attempt = repository.createAttempt(
      repository.readSnapshot(personaId, now),
      "semantic_change",
      now,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    repository.ingest(
      observation("消息", { object: { key: "messages", identity: "adapter" } }),
      now,
    );
    const output = analysis([first.id]);
    output.decision.selectedBasis.evidenceUses[0]!.use = "current_foreground";
    output.delta.createSituations = [newSituation(first.id)];
    output.delta.attention.currentSituationId = "new:materials";
    const ready = repository.commitAnalysis(attempt.id, output, now);
    const state = repository.getSnapshot(personaId, now);
    expect(state.situations).toHaveLength(1);
    expect(state.attention.currentSituationId).toBeUndefined();
    expect(state.attention.foregroundObject?.key).toBe("messages");
    expect(repository.actionFreshness(ready, now).current).toBe(false);
  });

  it("clears attention on explicit null without discarding the situation history", () => {
    const { repository } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const output = analysis([evidence.id]);
    output.delta.createSituations = [newSituation(evidence.id)];
    output.delta.attention.currentSituationId = "new:materials";
    const first = runAnalysis(repository, output);
    repository.saveAttempt({ ...first, status: "settled" });
    const clear = analysis([evidence.id]);
    clear.delta.attention.currentSituationId = null;
    runAnalysis(repository, clear);
    expect(
      repository.getSnapshot(personaId, now).attention.currentSituationId,
    ).toBeUndefined();
    expect(repository.getSnapshot(personaId, now).situations).toHaveLength(1);
  });

  it("binds dispatch only in the Run allocation transaction and preserves restart idempotency", () => {
    const { repository, database } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const ready = runAnalysis(repository, analysis([evidence.id]));
    const runId = randomUUID();
    expect(() =>
      repository.bindDispatched(ready.dispatchKey, runId, now),
    ).toThrow("transaction");
    database.transaction(() =>
      repository.bindDispatched(ready.dispatchKey, runId, now),
    )();
    const restarted = new CognitionRepository(database, {
      readBudgetBytes: 32_768,
    });
    expect(restarted.getAttemptByDispatchKey(ready.dispatchKey)?.runId).toBe(
      runId,
    );
    expect(
      database.transaction(() =>
        restarted.bindDispatched(ready.dispatchKey, runId, now),
      )().runId,
    ).toBe(runId);
    expect(() =>
      database.transaction(() =>
        restarted.bindDispatched(ready.dispatchKey, randomUUID(), now),
      )(),
    ).toThrow("another Run");
  });
});

describe("consumer-allocated action read resources", () => {
  it.each(["before_read", "after_read"] as const)(
    "does not allocate an action cancelled %s during preparation",
    async (phase) => {
      const source = observation(
        "Use this whole source for the pending clarification",
        {
          chatId: randomUUID(),
        },
      );
      const driver: CognitionDriver = {
        analyze: () => {
          const output = analysis([source.id]);
          output.decision.choices[0] = {
            ...output.decision.choices[0]!,
            kind: "clarify",
            chatId: source.chatId!,
            executionScope: "conversation",
            instruction: "Ask the unresolved source question",
          };
          return Promise.resolve(output);
        },
      };
      const h = serviceFixture(driver);
      const controller = new AbortController();
      const original = h.repository.readActionContext.bind(h.repository);
      const read = vi
        .spyOn(h.repository, "readActionContext")
        .mockImplementation((...args) => {
          const context = original(...args);
          if (phase === "after_read") controller.abort();
          return context;
        });
      h.runtime.dispatch.mockImplementation((request) => {
        if (phase === "before_read") controller.abort();
        request.prepareContext({
          maxReadBytes: 10_000,
          signal: controller.signal,
        });
        throw new Error("Cancelled preparation unexpectedly returned material");
      });
      h.service.ingest(source);
      await h.service.runDue("2026-09-15T08:01:00.000Z");
      expect(h.runtime.dispatch).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(phase === "before_read" ? 0 : 1);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatchObject({ name: "AbortError" });
      expect(h.database.inTransaction).toBe(false);
      const request = h.runtime.dispatch.mock.calls[0]![0];
      expect(h.repository.getAttempt(request.attemptId)?.runId).toBeUndefined();
    },
  );

  it.each([12_000, 96_000])(
    "uses the actual %i allocation and never falls back to a fixed prepared quota",
    async (maxReadBytes) => {
      const text = Array.from(
        { length: 400 },
        (_, index) =>
          `Object ${index}: material, position and observed completion belong to this exact receipt.`,
      ).join("\n");
      const source = observation(text);
      const driver: CognitionDriver = {
        analyze: () => {
          const output = analysis([source.id]);
          output.delta.createIntents = [
            {
              localId: "new:inspection",
              value: {
                owner: "character",
                basis: "character",
                status: "active",
                goal: "Continue the documented object study",
                successCriteria: [],
                evidenceIds: [source.id],
                blockers: [],
                resumeConditions: [],
                progress: "Current complete receipt is required",
                effectEvidenceIds: [],
              },
            },
          ];
          const choice: CognitionChoice = {
            ...quiet([source.id]),
            id: "inspect",
            kind: "continue_character",
            intentId: "new:inspection",
            executionScope: "territory",
            instruction:
              "Continue using the complete receipt and its actual object constraints",
          };
          output.decision.choices = [choice];
          output.decision.selectedChoiceId = choice.id;
          output.decision.selectedBasis.choiceId = choice.id;
          return Promise.resolve(output);
        },
      };
      const h = serviceFixture(driver, undefined, {
        analysisReadBudgetBytes: 131_072,
      });
      const read = vi.spyOn(h.repository, "readActionContext");
      const prepared: string[] = [];
      h.runtime.dispatch.mockImplementation((request) => {
        // Nothing is materialized before the consumer requests the selected set.
        expect(read).not.toHaveBeenCalled();
        const context = request.prepareContext({
          maxReadBytes,
          signal: new AbortController().signal,
        });
        prepared.push(context.text);
        const runId = randomUUID();
        h.database.transaction(() =>
          h.repository.bindDispatched(request.dispatchKey, runId, now),
        )();
        return Promise.resolve({ runId });
      });
      h.service.ingest(source);
      await h.service.runDue("2026-09-15T08:01:00.000Z");
      expect(h.runtime.dispatch).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]?.[1]).toBe(maxReadBytes);
      if (maxReadBytes === 12_000) {
        expect(prepared).toEqual([]);
        expect(h.errors).toHaveLength(1);
        expect(
          h.repository.getAttempt(
            h.runtime.dispatch.mock.calls[0]![0].attemptId,
          )?.runId,
        ).toBeUndefined();
      } else {
        expect(h.errors).toEqual([]);
        expect(prepared[0]).toContain(JSON.stringify(text).slice(1, -1));
        expect(Buffer.byteLength(prepared[0]!, "utf8")).toBeGreaterThan(32_768);
        expect(
          h.repository.getAttempt(
            h.runtime.dispatch.mock.calls[0]![0].attemptId,
          )?.runId,
        ).toBeDefined();
      }
    },
  );

  it("uses the ordinary consumer budget without clamping it to the former action quota", async () => {
    const h = serviceFixture({ analyze: () => Promise.resolve(analysis()) });
    const receipt = h.repository.ingest(
      observation(
        "The current task has substantial source detail.".repeat(260),
      ),
      now,
    ).evidence;
    const output = analysis([receipt.id]);
    output.delta.createSituations = [newSituation(receipt.id)];
    output.delta.attention.currentSituationId = "new:materials";
    runAnalysis(h.repository, output);
    const input = {
      personaId,
      chatId: randomUUID(),
      currentInput: "继续刚才的材料",
      signal: new AbortController().signal,
    };
    const low = await h.service.prepareTurn({
      ...input,
      contextBudget: { maxTokens: 2000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
    });
    const high = await h.service.prepareTurn({
      ...input,
      contextBudget: { maxTokens: 24_000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
    });
    expect(low.evidenceIds).not.toContain(receipt.id);
    expect(high.evidenceIds).toContain(receipt.id);
    expect(high.text).toContain(receipt.text);
    expect(Buffer.byteLength(high.text, "utf8")).toBeGreaterThan(10_000);
  });
});

describe("Cognition preparation and background lifecycle", () => {
  it("prepares a greeting without invoking a planner or an automatic recall", async () => {
    const driver = { analyze: vi.fn(() => Promise.resolve(analysis())) };
    const { service, memory, repository } = serviceFixture(driver);
    await service.prepareTurn({
      personaId,
      chatId: randomUUID(),
      currentInput: "早上好",
      contextBudget: { maxTokens: 10_000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
      signal: new AbortController().signal,
    });
    expect(driver.analyze).not.toHaveBeenCalled();
    expect(memory.recall).not.toHaveBeenCalled();
    expect(repository.listPersonaIds()).toEqual([]);
  });

  it("aggregates an input flood without scheduling per-keystroke model work", async () => {
    const driver = { analyze: vi.fn(() => Promise.resolve(analysis())) };
    const { service, repository } = serviceFixture(driver);
    for (let index = 0; index < 1000; index += 1)
      service.ingest(
        observation("", {
          boundary: "interaction",
          interaction: { clicks: 0, keystrokes: 1, scrolls: 0 },
        }),
      );
    await service.prepareTurn({
      personaId,
      chatId: randomUUID(),
      currentInput: "你好",
      contextBudget: { maxTokens: 10_000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
      signal: new AbortController().signal,
    });
    expect(repository.listPersonaIds()).toEqual([]);
    expect(service.earliestNextRunAt()).toBeUndefined();
    // A semantic arrival is an existing flush boundary; preparation is not.
    const next = observation("后来真的出现了新的材料");
    service.ingest(next);
    const read = repository.readSnapshot(personaId, now);
    expect(read.snapshot.evidence.map(({ id }) => id)).toEqual([next.id]);
    expect(read.snapshot.attention.analyzedThroughSequence).toBe(1);
    expect(read.snapshot.attention.lastReceiptSequence).toBe(2);
    expect(read.coverage.passiveSpans?.[0]?.interaction.keystrokes).toBe(1000);
    expect(driver.analyze).not.toHaveBeenCalled();
    const before = repository.getAttention(personaId, now);
    await service.prepareTurn({
      personaId,
      chatId: randomUUID(),
      currentInput: "新材料说明什么？",
      contextBudget: { maxTokens: 10_000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
      signal: new AbortController().signal,
    });
    expect(repository.getAttention(personaId, now)).toEqual(before);
  });

  it("flushes a never-initialized counts-only Persona at shutdown without inventing a due analysis", async () => {
    const driver = { analyze: vi.fn(() => Promise.resolve(analysis())) };
    const { service, repository, database } = serviceFixture(driver);
    for (let index = 0; index < 1000; index++)
      service.ingest(
        observation("", {
          boundary: "interaction",
          interaction: { clicks: 0, keystrokes: 1, scrolls: 0 },
        }),
      );
    expect(repository.listPersonaIds()).toEqual([]);
    expect(service.earliestNextRunAt()).toBeUndefined();
    await service.shutdown();
    // A new owner over the persisted database sees the aggregated exact receipt.
    const reopened = new CognitionRepository(database, {
      readBudgetBytes: 32_768,
    });
    const read = reopened.readSnapshot(personaId, now);
    expect(read.snapshot.attention.lastReceiptSequence).toBe(1);
    expect(read.snapshot.attention.analyzedThroughSequence).toBe(1);
    expect(read.coverage.passiveSpans?.[0]?.interaction.keystrokes).toBe(1000);
    expect(read.snapshot.evidence).toEqual([]);
    expect(reopened.earliestNextRunAt(personaId)).toBeUndefined();
    expect(driver.analyze).not.toHaveBeenCalled();
  });

  it("merges identical snapshots but analyzes changed content in the same app", async () => {
    const driver = {
      analyze: vi.fn((input: CognitionAnalysisInput) =>
        Promise.resolve(analysis(input.snapshot.evidence.map(({ id }) => id))),
      ),
    };
    const { service, repository } = serviceFixture(driver);
    service.ingest(observation("材料A"));
    service.ingest(observation("材料A"));
    service.ingest(observation("材料B"));
    const read = repository.readSnapshot(personaId, now);
    expect(read.coverage.sourceCoverage?.eventCount).toBe(2);
    expect(read.snapshot.evidence).toHaveLength(1);
    await service.runDue("2026-09-15T08:01:00.000Z");
    expect(driver.analyze).toHaveBeenCalledTimes(1);
    expect(
      driver.analyze.mock.calls[0]?.[0].snapshot.evidence.map(
        ({ text }) => text,
      ),
    ).toEqual(["材料B"]);
    expect(
      driver.analyze.mock.calls[0]?.[0].coverage?.sourceCoverage?.entries[0]
        ?.changes[0]?.excerpt,
    ).toContain("材料A");
  });

  describe("continuous observation receipts", () => {
    describe("coalesced source clock", () => {
      it.each([false, true])(
        "retains the latest physical observation when its body is merged (equal time: %s)",
        (equalTime) => {
          const { service, repository, database } = serviceFixture({
            analyze: () => Promise.resolve(analysis()),
          });
          const time = (second: number) =>
            equalTime
              ? now
              : `2026-09-15T08:00:${String(second).padStart(2, "0")}.000Z`;
          const first = observation("未变化的真实内容", {
            observedAt: time(10),
            sourceEpoch: "session",
            sourceSequence: 10,
          });
          service.ingest(first);
          const initial = repository.getSnapshot(personaId, now);
          service.ingest(
            observation(first.text, {
              observedAt: time(20),
              sourceEpoch: "session",
              sourceSequence: 20,
            }),
          );
          const merged = repository.getSnapshot(personaId, now);
          expect(merged.evidence).toEqual(initial.evidence);
          expect(merged.attention.lastReceiptSequence).toBe(
            initial.attention.lastReceiptSequence,
          );
          expect(merged.attention.focusRevision).toBe(
            initial.attention.focusRevision,
          );
          expect(merged.attention.foregroundObservationClock).toEqual({
            observedAt: time(20),
            sourceKind: "activity",
            sourceEpoch: "session",
            sourceSequence: 20,
          });
          const restoredDatabase = new Database(database.serialize());
          databases.push(restoredDatabase);
          const restored = new CognitionRepository(restoredDatabase, {
            readBudgetBytes: 32_768,
          });
          restored.ingest(
            observation("迟到的旧页面", {
              observedAt: time(15),
              sourceEpoch: "session",
              sourceSequence: 15,
              object: { key: "old-page", identity: "adapter" },
            }),
            now,
          );
          const snapshot = restored.getSnapshot(personaId, now);
          expect(snapshot.evidence).toHaveLength(2);
          expect(snapshot.attention.foregroundObject).toEqual(first.object);
          expect(snapshot.attention.foregroundObservationClock).toEqual(
            merged.attention.foregroundObservationClock,
          );
          expect(snapshot.attention.focusRevision).toBe(
            initial.attention.focusRevision,
          );
        },
      );

      it.each([
        { sourceKind: "system" as const, sourceEpoch: "first" },
        { sourceKind: "activity" as const, sourceEpoch: "next" },
      ])(
        "does not compare sequence counters across sources %j",
        ({ sourceKind, sourceEpoch }) => {
          const { service, repository } = serviceFixture({
            analyze: () => Promise.resolve(analysis()),
          });
          service.ingest(
            observation("第一来源", {
              sourceEpoch: "first",
              sourceSequence: 800,
            }),
          );
          service.ingest(
            observation("第一来源", {
              sourceEpoch: "first",
              sourceSequence: 900,
            }),
          );
          const second = observation("新来源的实际焦点", {
            source: { kind: sourceKind, id: randomUUID() },
            sourceEpoch,
            sourceSequence: 1,
            object: { key: "new-source-object", identity: "adapter" },
          });
          service.ingest(second);
          expect(
            repository.getAttention(personaId, now).foregroundObject,
          ).toEqual(second.object);
          expect(
            repository.getAttention(personaId, now).foregroundObservationClock
              ?.sourceSequence,
          ).toBe(1);
        },
      );

      it("preserves the merged clock through an in-flight analysis commit", async () => {
        let resolveAnalysis!: (value: CognitionAnalysis) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const driver = {
          analyze: vi.fn(
            () =>
              new Promise<CognitionAnalysis>((resolve) => {
                resolveAnalysis = resolve;
                entered();
              }),
          ),
        };
        const { service, repository } = serviceFixture(driver);
        const first = observation("同一内容", {
          sourceEpoch: "session",
          sourceSequence: 10,
        });
        service.ingest(first);
        const pending = service.runDue("2026-09-15T08:01:00.000Z");
        await started;
        service.ingest(
          observation(first.text, {
            sourceEpoch: "session",
            sourceSequence: 20,
          }),
        );
        resolveAnalysis(analysis([first.id]));
        await pending;
        const snapshotRead = repository.readSnapshot(personaId, now);
        const snapshot = snapshotRead.snapshot;
        expect(driver.analyze).toHaveBeenCalledTimes(1);
        expect(
          snapshot.attention.foregroundObservationClock?.sourceSequence,
        ).toBe(20);
        expect(snapshot.attention.focusRevision).toBe(1);
        expect(snapshot.attention.analyzedThroughSequence).toBe(1);
      });
    });

    it.each(["user", "unknown"] as const)(
      "supplies the real return to an unchanged page after another object (%s)",
      async (actor) => {
        const driver = {
          analyze: vi.fn((input: CognitionAnalysisInput) =>
            Promise.resolve(
              analysis(input.snapshot.evidence.map(({ id }) => id)),
            ),
          ),
        };
        const { service, repository } = serviceFixture(driver);
        const first = observation("海边酒店每晚1080", { actor });
        const other = observation("出差酒店报销上限650", {
          actor,
          object: { key: "spreadsheet:budget", identity: "provisional" },
        });
        const returned = observation(first.text, { actor });
        [first, other, returned].forEach((item) => service.ingest(item));
        const snapshotRead = repository.readSnapshot(personaId, now);
        const snapshot = snapshotRead.snapshot;
        expect(snapshot.evidence.map(({ id }) => id)).toEqual([
          first.id,
          other.id,
          returned.id,
        ]);
        expect(snapshot.attention.foregroundObject).toEqual(returned.object);
        expect(snapshot.attention.focusRevision).toBe(3);
        await service.runDue("2026-09-15T08:01:00.000Z");
        expect(driver.analyze).toHaveBeenCalledTimes(1);
        expect(driver.analyze.mock.calls[0]![0].snapshot.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: returned.id }),
          ]),
        );
      },
    );

    it.each(["user", "unknown"] as const)(
      "does not let a late identical receipt suppress the next actual return (%s)",
      (actor) => {
        const { service, repository } = serviceFixture({
          analyze: () => Promise.resolve(analysis()),
        });
        const atSequence = (sourceSequence: number) =>
          observation("同一页面正文", {
            actor,
            sourceEpoch: "desktop-session",
            sourceSequence,
          });
        service.ingest(atSequence(10));
        service.ingest({
          ...atSequence(20),
          object: { key: "other-window", identity: "adapter" },
        });
        const beforeLate = repository.getAttention(personaId, now);
        service.ingest(atSequence(15));
        expect(
          repository.getAttention(personaId, now).foregroundObject?.key,
        ).toBe("other-window");
        expect(repository.getAttention(personaId, now).focusRevision).toBe(
          beforeLate.focusRevision,
        );
        const actualReturn = atSequence(21);
        service.ingest(actualReturn);
        const snapshot = repository.getSnapshot(personaId, now);
        expect(
          repository.getAttention(personaId, now).lastReceiptSequence,
        ).toBe(4);
        expect(
          repository.hasEvidence(personaId, actualReturn.source, "observation"),
        ).toBe(true);
        expect(snapshot.evidence.some(({ id }) => id === actualReturn.id)).toBe(
          true,
        );
        expect(snapshot.attention.foregroundObject).toEqual(
          actualReturn.object,
        );
        expect(snapshot.attention.focusRevision).toBe(
          beforeLate.focusRevision + 1,
        );
      },
    );

    it.each([
      { sourceEpoch: "next-capture-session" },
      { boundary: "window" as const },
    ])("retains a new observation boundary %j", (extra) => {
      const { service, repository } = serviceFixture({
        analyze: () => Promise.resolve(analysis()),
      });
      service.ingest(observation());
      const next = observation(undefined, extra);
      service.ingest(next);
      expect(repository.getSnapshot(personaId, now).evidence).toHaveLength(2);
      expect(
        repository.hasEvidence(personaId, next.source, "observation"),
      ).toBe(true);
    });

    it("retains an unchanged page after an idle boundary", () => {
      const { service, repository } = serviceFixture({
        analyze: () => Promise.resolve(analysis()),
      });
      service.ingest(observation());
      service.ingest(observation("用户暂时离开", { boundary: "idle" }));
      const resumed = observation();
      service.ingest(resumed);
      expect(
        repository.hasEvidence(personaId, resumed.source, "observation"),
      ).toBe(true);
    });

    it.each([
      { interaction: { clicks: 1, keystrokes: 0, scrolls: 0 } },
      { control: "user_correction" as const },
    ])("preserves non-text evidence on an unchanged page %j", (extra) => {
      const { service, repository, database } = serviceFixture({
        analyze: () => Promise.resolve(analysis()),
      });
      service.ingest(observation());
      const first = observation(undefined, extra);
      const second = observation(undefined, extra);
      service.ingest(first);
      service.ingest(second);
      const read = repository.readSnapshot(personaId, now);
      expect(read.coverage.sourceCoverage?.eventCount).toBe(3);
      for (const source of [first, second])
        expect(
          readEvidence(database, source.id, 32_768)?.evidence,
        ).toMatchObject({ id: source.id, ...extra });
      if ("interaction" in extra)
        expect(read.coverage.sourceCoverage?.entries[0]?.interaction).toEqual({
          clicks: 2,
          keystrokes: 0,
          scrolls: 0,
        });
      else expect(read.snapshot.evidence).toHaveLength(3);
    });

    it("keeps agent revisits separate from the user's physical focus", () => {
      const { service, repository } = serviceFixture({
        analyze: () => Promise.resolve(analysis()),
      });
      const user = observation();
      service.ingest(user);
      const agent = observation("角色观察到的页面", {
        actor: "agent",
        object: { key: "agent-window", identity: "adapter" },
      });
      service.ingest(agent);
      service.ingest(observation("角色的另一个页面", { actor: "agent" }));
      const returned = {
        ...agent,
        id: randomUUID(),
        source: { kind: "activity" as const, id: randomUUID() },
      };
      service.ingest(returned);
      const snapshotRead = repository.readSnapshot(personaId, now);
      const snapshot = snapshotRead.snapshot;
      expect(snapshot.evidence).toHaveLength(4);
      expect(snapshot.attention.foregroundObject).toEqual(user.object);
      expect(
        repository.hasEvidence(personaId, returned.source, "observation"),
      ).toBe(true);
    });
  });

  it("runs complete recall then evidence-based analysis without dispatching the preliminary choice", async () => {
    const memoryId = randomUUID();
    const revisionId = randomUUID();
    const pack: EvidencePack = {
      items: [
        {
          memoryId,
          revisionId,
          type: "event",
          content: "用户说材料属于朋友",
          historyStatus: "current",
          basis: "explicit_user_statement",
          entityIds: [],
          sourceRefs: [],
          recordedAt: now,
          current: true,
          questionIds: ["owner"],
        },
      ],
      coverage: [
        { questionId: "owner", status: "supported", revisionIds: [revisionId] },
      ],
      gaps: [],
      estimatedTokens: 100,
      truncated: false,
      incompleteReasons: [],
    };
    const driver = {
      analyze: vi.fn((input: CognitionAnalysisInput) => {
        const output = analysis(input.snapshot.evidence.map(({ id }) => id));
        if (!input.evidencePack) {
          output.delta.createSituations = [
            newSituation(input.snapshot.evidence[0]!.id),
          ];
          output.recallPlan = {
            purpose: "initiative",
            query: "材料是谁的",
            questions: [{ id: "owner", text: "这份材料属于谁？" }],
            situationId: "new:materials",
            contextBudget: { maxTokens: 1000 },
          };
        }
        return Promise.resolve(output);
      }),
    };
    const { service, memory, runtime, repository, errors } = serviceFixture(
      driver,
      pack,
    );
    service.ingest(observation());
    await service.runDue("2026-09-15T08:01:00.000Z");
    expect(errors).toEqual([]);
    expect(driver.analyze).toHaveBeenCalledTimes(2);
    expect(memory.recall).toHaveBeenCalledTimes(1);
    expect(memory.recall.mock.calls[0]?.[0]).toMatchObject({ personaId });
    expect(memory.recall.mock.calls[0]?.[0].situationId).not.toMatch(/^new:/);
    expect(runtime.dispatch).not.toHaveBeenCalled();
    const completed = repository.getSnapshot(personaId, now).recentAttempts[0]!;
    expect(completed.status).toBe("settled");
    expect(completed.projection).toBe("complete");
    if (completed.projection !== "complete")
      throw new Error("Expected the complete recalled Attempt view");
    expect(completed.recallSummary).toEqual({
      coverage: pack.coverage,
      gaps: [],
      truncated: false,
      incompleteReasons: [],
    });
    const reading = driver.analyze.mock.calls[1]![0].snapshot.evidence.find(
      (item) => item.kind === "recollection",
    )!;
    expect(reading).toMatchObject({
      actor: "system",
      kind: "recollection",
      text: pack.items[0]!.content,
      observedAt: now,
      source: {
        kind: "memory",
        id: memoryId,
        revision: revisionId,
        fragment: completed.id,
      },
      recollection: { basis: "explicit_user_statement", current: true },
    });
    expect(reading.object).toBeUndefined();
    expect(reading.effect).toBeUndefined();
  });

  it("waits for character cancellation and rejects a stale model completion", async () => {
    let finish: ((value: CognitionAnalysis) => void) | undefined;
    let started: (() => void) | undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const driver = {
      analyze: vi.fn(async () => {
        started?.();
        return new Promise<CognitionAnalysis>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const { service, runtime, repository } = serviceFixture(driver);
    service.ingest(observation());
    const pending = service.runDue("2026-09-15T08:01:00.000Z");
    await begun;
    await service.yieldToUser(personaId);
    finish?.(analysis());
    await pending;
    expect(runtime.yieldCharacterRun).toHaveBeenCalledTimes(1);
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(
      repository.getSnapshot(personaId, now).recentAttempts[0]?.status,
    ).toBe("superseded");
  });

  it("dispatches a character intent once and consumes its due time", async () => {
    const id = randomUUID();
    const intent: CognitionIntent = {
      id,
      personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "布置一处小景",
      successCriteria: ["物件实际放入领地"],
      evidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "尚未开始",
      effectEvidenceIds: [],
      nextWakeAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const driver = {
      analyze: vi.fn(() => {
        const output = analysis();
        const choice: CognitionChoice = {
          ...quiet(),
          id: "continue",
          kind: "continue_character",
          intentId: id,
          rationale: "继续角色自己的可撤销小景",
          executionScope: "territory",
          reversibility: "undoable",
          instruction: "查看领地并布置小景",
        };
        output.decision = {
          choices: [quiet(), choice],
          selectedChoiceId: choice.id,
          selectedBasis: {
            choiceId: choice.id,
            evidenceUses: choice.evidenceIds.map((evidenceId) => ({
              evidenceId,
              use: "history" as const,
            })),
            currentClaimRefs: [],
          },
          reason: "角色当前有未完成目标",
        };
        return Promise.resolve(output);
      }),
    };
    const { service, runtime, repository, errors } = serviceFixture(driver);
    service.saveCharacterIntent(intent);
    await service.runDue(now);
    expect(errors).toEqual([]);
    expect(runtime.dispatch).toHaveBeenCalledTimes(1);
    expect(repository.getIntent(id)?.nextWakeAt).toBeUndefined();
    await service.runDue("2026-09-15T08:01:00.000Z");
    expect(runtime.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps unopened versions behind the body cursor while their catalogue competes within the allocation", () => {
    const { repository } = fixture();
    for (let index = 0; index < 8; index += 1)
      repository.ingest(observation(`${index}: ${"内容".repeat(500)}`), now);
    const read = repository.readSnapshot(personaId, now);
    const { snapshot, coverage } = read;
    const { snapshot: selected } = selectAnalysisSnapshot(
      snapshot,
      12_000,
      coverage,
    );
    expect(selected.evidence.length).toBeGreaterThan(0);
    expect(selected.evidence.length).toBeLessThan(8);
    expect(selected.attention.lastReceiptSequence).toBe(0);
    expect(coverage.sourceCoverage?.throughSequence).toBe(8);
    expect(coverage.sourceCoverage?.unopenedCount).toBeGreaterThan(0);
  });

  it("checks user attention and explicit intent separately from proposed impact labels", () => {
    const { repository } = fixture();
    const snapshotRead = repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    const choice: CognitionChoice = {
      ...quiet(),
      kind: "start_conversation",
      executionScope: "conversation",
    };
    expect(
      choiceBlockReason(choice, snapshot, {
        ...availability(),
        activeVoice: true,
      }),
    ).toBe("user_has_attention");
    expect(
      choiceBlockReason(
        { ...choice, executionScope: "external", reversibility: "undoable" },
        snapshot,
        availability(),
      ),
    ).toBe("external_action_requires_explicit_intent");
    expect(
      projectCognitionContext(snapshot, 10_000, snapshotRead).recallPlan,
    ).toBeUndefined();
  });
  it("updates dependency revisions for its own delta and rejects a later Life edit before atomic dispatch", () => {
    const { repository, database } = fixture();
    const value = analysis();
    value.delta.createIntents = [
      {
        localId: "new:life",
        value: {
          owner: "character",
          basis: "character",
          status: "active",
          goal: "整理住处",
          successCriteria: [],
          evidenceIds: [],
          effectEvidenceIds: [],
          blockers: [],
          resumeConditions: [],
          progress: "尚未开始",
        },
      },
    ];
    value.decision.choices[0]!.intentId = "new:life";
    const ready = runAnalysis(repository, value);
    expect(repository.actionFreshness(ready, now).current).toBe(true);
    const intent = repository.getSnapshot(personaId, now).intents[0]!;
    repository.saveIntent(
      { ...intent, revision: intent.revision + 1, status: "suspended" },
      intent.revision,
    );
    expect(repository.actionFreshness(ready, now).current).toBe(false);
    expect(() =>
      database.transaction(() =>
        repository.bindDispatched(ready.dispatchKey, randomUUID(), now),
      )(),
    ).toThrow("dependencies changed");
  });

  it("keeps an action current when only an unrelated situation detail changes", () => {
    const { repository, database } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const value = analysis([evidence.id]);
    value.delta.createSituations = [newSituation(evidence.id)];
    value.decision.choices[0]!.situationId = "new:materials";
    const ready = runAnalysis(repository, value);
    const snapshotRead = repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    expect(repository.actionFreshness(ready, now).current).toBe(true);
    const situation = snapshot.situations[0]!;
    const changed = {
      ...situation,
      revision: situation.revision + 1,
      summary: "另一条无关进度",
    };
    database
      .prepare(
        "UPDATE cognition_situations SET revision=?,payload_json=? WHERE id=?",
      )
      .run(changed.revision, JSON.stringify(changed), changed.id);
    expect(repository.actionFreshness(ready, now).current).toBe(true);
  });

  it("prevents analysis from undoing the product pause on autonomous life", () => {
    const { repository } = fixture();
    const value = {
      owner: "character" as const,
      basis: "character" as const,
      status: "suspended" as const,
      goal: "休息",
      successCriteria: [],
      evidenceIds: [],
      effectEvidenceIds: [],
      blockers: [CHARACTER_LIFE_PAUSED_BLOCKER],
      resumeConditions: [],
      progress: "已暂停",
    };
    const intent = repository.saveIntent({
      ...value,
      id: randomUUID(),
      personaId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const output = analysis();
    output.delta.updateIntents = [
      {
        id: intent.id,
        expectedRevision: intent.revision,
        value: { ...value, status: "active", blockers: [] },
      },
    ];
    expect(() => runAnalysis(repository, output)).toThrow(
      "cannot override a paused",
    );
    expect(repository.getIntent(intent.id)?.status).toBe("suspended");
  });

  it("makes progress past one oversized Tool receipt using an explicit excerpt without changing its original", () => {
    const { repository, database } = fixture();
    const receipt = repository.ingest(
      observation("原始真实结果".repeat(30_000), {
        actor: "agent",
        kind: "effect",
        effect: {
          runId: randomUUID(),
          outcome: "performed",
          description: "放置完成",
          sourceRefs: [],
        },
      }),
      now,
    ).evidence;
    repository.ingest(observation("随后用户回来"), now);
    const read = repository.readSnapshot(personaId, now);
    const selection = selectAnalysisSnapshot(read.snapshot, 6_000);
    expect(Buffer.byteLength(JSON.stringify(selection))).toBeLessThan(6_000);
    expect(selection.coverage.excerptedEvidenceIds).toEqual([receipt.id]);
    expect(selection.snapshot.evidence[0]?.text).toContain(
      "INCOMPLETE EXCERPT",
    );
    expect(selection.snapshot.attention.lastReceiptSequence).toBe(
      receipt.receiptSequence,
    );
    let attempt = repository.createAttempt(
      { ...selection, receivedThroughSequence: read.receivedThroughSequence },
      "feedback",
      now,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const completed = repository.commitAnalysis(
      attempt.id,
      analysis([receipt.id]),
      now,
    );
    repository.saveAttempt({ ...completed, status: "settled" });
    const original = database
      .prepare(
        "SELECT json_extract(payload_json,'$.text') AS text FROM cognition_evidence WHERE id = ?",
      )
      .get(receipt.id) as { text: string };
    expect(original.text === receipt.text).toBe(true);
    const next = selectAnalysisSnapshot(
      repository.getSnapshot(personaId, now),
      6_000,
    );
    expect(next.snapshot.attention.lastReceiptSequence).toBe(2);
  });

  it("updates a partial situation by visible child ID while preserving unseen history and oversized scalar text", () => {
    const { repository, database } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const output = analysis([evidence.id]);
    const created = newSituation(evidence.id);
    created.value.summary = "大情境".repeat(20_000);
    created.value.episodes = Array.from({ length: 120 }, (_, index) => ({
      ...created.value.episodes[0]!,
      id: `episode-${index}`,
    }));
    output.delta.createSituations = [created];
    const ready = runAnalysis(repository, output);
    repository.saveAttempt({ ...ready, status: "settled" });
    const id = ready.dependencies.situations[0]!.id;
    const selection = repository.readSnapshot(personaId, now, 6_000);
    const situation = selection.snapshot.situations.find(
      (value) => value.id === id,
    )!;
    const allocation = selection.coverage.allocation!.situations.find(
      (value) => value.id === id,
    )!;
    expect(Buffer.byteLength(JSON.stringify(selection))).toBeLessThanOrEqual(
      6_000,
    );
    expect(allocation.preservedFields).toContain("summary");
    expect(situation.episodes.length).toBeLessThan(120);
    expect(situation.episodes.length).toBeGreaterThan(0);
    let next = repository.createAttempt(
      selection,
      "resume",
      now,
      selection.coverage.allocation,
    );
    next = repository.saveAttempt({ ...next, status: "analyzing" });
    const update = analysis();
    const visible = situation.episodes[0]!;
    const projectedValue = { ...situation } as Record<string, unknown>;
    for (const key of ["id", "personaId", "revision", "createdAt", "updatedAt"])
      delete projectedValue[key];
    update.delta.updateSituations = [
      {
        id,
        expectedRevision: situation.revision,
        value: {
          ...(projectedValue as typeof created.value),
          summary: "truncated overwrite must be ignored",
          episodes: [{ ...visible, state: "closed", endedAt: now }],
        },
      },
    ];
    const hidden = created.value.episodes.find(
      (episode) => !allocation.episodeIds.includes(episode.id),
    )!;
    const hiddenUpdate = structuredClone(update);
    hiddenUpdate.delta.updateSituations[0]!.value.episodes = [
      { ...hidden, state: "closed", endedAt: now },
    ];
    expect(() => repository.commitAnalysis(next.id, hiddenUpdate, now)).toThrow(
      "Cannot update an unseen situation child",
    );
    repository.commitAnalysis(next.id, update, now);
    const canonical = repository.getSituation(id)!;
    expect(canonical.summary === created.value.summary).toBe(true);
    expect(canonical.episodes).toHaveLength(120);
    expect(
      canonical.episodes.find((value) => value.id === visible.id)?.state,
    ).toBe("closed");
    expect(
      canonical.episodes
        .filter((value) => value.id !== visible.id)
        .every((value) => value.state === "open"),
    ).toBe(true);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM cognition_episode_evidence WHERE situation_id = ?",
        )
        .get(id),
    ).toEqual({ count: 120 });
  });

  it("persists closure handoff in the state transaction and recovers only pending sources", () => {
    const { repository, database } = fixture();
    const evidence = repository.ingest(observation(), now).evidence;
    const closed = newSituation(evidence.id);
    closed.value.status = "closed";
    closed.value.episodes[0]!.state = "closed";
    const output = analysis([evidence.id]);
    output.delta.createSituations = [closed];
    runAnalysis(repository, output);
    expect(repository.getSnapshot(personaId, now).situations).toHaveLength(0);
    // Grounded claim and closure refer to exactly the same material: one pending item.
    expect([...repository.pendingMemoryHandoffs()]).toHaveLength(1);
    for (const handoff of repository.pendingMemoryHandoffs()) {
      expect(handoff.personaId).toBe(personaId);
      expect(handoff.primaryEvidenceIds).toEqual([evidence.id]);
      const sources = [
        ...repository.memoryHandoffEvidence(
          handoff,
          handoff.primaryEvidenceIds,
        ),
      ];
      expect(sources[0]?.source).toEqual(evidence.source);
      expect(sources[0]?.text).toBeUndefined();
      database.transaction(() =>
        repository.acknowledgeMemoryHandoff(handoff.id),
      )();
    }
    expect(database.inTransaction).toBe(false);
    expect([...repository.pendingMemoryHandoffs()]).toEqual([]);
  });

  it("notifies pending handoffs after commit and preserves them if the consumer fails", async () => {
    const listener = vi.fn(() => {
      expect(database.inTransaction).toBe(false);
      expect([...repository.pendingMemoryHandoffs()]).toHaveLength(1);
      throw new Error("intake unavailable");
    });
    const { repository, database, service, errors } = serviceFixture(
      {
        analyze: ({ snapshot }) => {
          const output = analysis();
          output.delta.createSituations = [
            newSituation(snapshot.evidence[0]!.id),
          ];
          return Promise.resolve(output);
        },
      },
      undefined,
      { onMemoryHandoffPending: listener },
    );
    service.ingest(observation());
    await service.runDue("2026-09-15T08:00:20.000Z");
    expect(listener).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect([...repository.pendingMemoryHandoffs()]).toHaveLength(1);
    expect(repository.getSnapshot(personaId, now).situations).toHaveLength(1);
  });

  it("consumes a quiet wake and does not refresh the scheduler from an empty runDue", async () => {
    const scheduleChanged = vi.fn();
    const driver = { analyze: vi.fn(() => Promise.resolve(analysis())) };
    const { service, repository } = serviceFixture(driver, undefined, {
      onScheduleChanged: scheduleChanged,
    });
    service.saveCharacterIntent({
      id: randomUUID(),
      personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "看看住处",
      successCriteria: [],
      evidenceIds: [],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "尚未开始",
      nextWakeAt: now,
      createdAt: now,
      updatedAt: now,
    });
    scheduleChanged.mockClear();
    await service.runDue(now);
    await service.runDue(now);
    expect(driver.analyze).toHaveBeenCalledTimes(1);
    expect(service.earliestNextRunAt()).toBeUndefined();
    expect(scheduleChanged).not.toHaveBeenCalled();
    expect(repository.getSnapshot(personaId, now).intents[0]?.status).toBe(
      "active",
    );
  });

  it("deduplicates the actual bubble delivery receipt by source revision and kind", () => {
    const { repository } = fixture();
    const source = {
      kind: "run" as const,
      id: randomUUID(),
      revision: "surface:offered",
    };
    expect(repository.hasEvidence(personaId, source, "observation")).toBe(
      false,
    );
    repository.ingest(
      observation("提示已显示", { source, actor: "agent" }),
      now,
    );
    expect(repository.hasEvidence(personaId, source, "observation")).toBe(true);
    expect(repository.hasEvidence(personaId, source, "effect")).toBe(false);
  });
  it("preserves late source-epoch history without moving focus or invalidating a newer decision", () => {
    const { repository } = fixture();
    const current = repository.ingest(
      observation("当前内容", {
        sourceEpoch: "native-batch-1",
        sourceSequence: 20,
      }),
      now,
    ).evidence;
    const ready = runAnalysis(repository, analysis([current.id]));
    repository.ingest(
      observation("迟到的旧窗口", {
        sourceEpoch: "native-batch-1",
        sourceSequence: 19,
        object: { key: "old-window", identity: "adapter" },
      }),
      now,
    );
    repository.ingest(
      observation("迟到的旧正文", {
        sourceEpoch: "native-batch-1",
        sourceSequence: 18,
      }),
      now,
    );
    const snapshotRead = repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    expect(snapshot.attention.foregroundObject?.key).toBe(current.object?.key);
    expect(snapshot.evidence).toHaveLength(3);
    expect(repository.actionFreshness(ready, now).current).toBe(true);
  });
});

function opportunityEvidence(
  extra: Partial<CognitionEvidenceInput> = {},
): CognitionEvidenceInput {
  const id = randomUUID();
  return {
    id,
    personaId,
    actor: "system",
    kind: "observation",
    observedAt: now,
    source: {
      kind: "memory",
      id: randomUUID(),
      revision: randomUUID(),
      fragment: "due",
    },
    chatId: "22222222-2222-4222-8222-222222222222",
    opportunity: {
      id: randomUUID(),
      targetChatId: "22222222-2222-4222-8222-222222222222",
      evaluateAt: now,
      occursAt: "2026-09-15T08:30:00.000Z",
      status: "due",
    },
    text: "已保存的用户陈述：八点半有演示。到考虑窗口了，不是新消息。",
    ...extra,
  };
}

function opener(item: CognitionEvidenceInput): CognitionAnalysis {
  const result = analysis([item.id]);
  result.decision.choices.push({
    ...quiet([item.id]),
    id: "offer",
    kind: "start_conversation",
    executionScope: "conversation",
    userImpact: "light",
    chatId: item.opportunity!.targetChatId,
    instruction: "延续这个重要时刻的同一段对话。",
  });
  result.decision.selectedChoiceId = "offer";
  result.decision.selectedBasis = {
    choiceId: "offer",
    evidenceUses: [{ evidenceId: item.id, use: "history" }],
    currentClaimRefs: [],
  };
  return result;
}

describe("Cognition important-moment source lifecycle", () => {
  it("schedules a due source immediately, while ordinary retrieved memory does not start analysis", async () => {
    const analyze = vi.fn((input: CognitionAnalysisInput) =>
      Promise.resolve(analysis(input.snapshot.evidence.map(({ id }) => id))),
    );
    const h = serviceFixture({ analyze });
    // A real host retrieval reading, not a fabricated user observation.
    const reading = recalledSource(h.repository);
    const {
      receiptSequence: _sequence,
      receivedAt: _received,
      ...recalled
    } = reading;
    void _sequence;
    void _received;
    h.service.ingest(recalled);
    expect(h.service.earliestNextRunAt()).toBeUndefined();
    const item = opportunityEvidence();
    h.service.ingest(item);
    expect(h.service.earliestNextRunAt()).toBe(now);
    await h.service.runDue(now);
    expect(analyze).toHaveBeenCalledOnce();
    expect(h.repository.hasPendingOpportunity(personaId, now)).toBe(false);
    expect(h.service.earliestNextRunAt()).toBeUndefined();
    h.service.initialize();
    expect(h.service.earliestNextRunAt()).toBeUndefined();
  });

  it("requires a sourced Chat and the exact important-moment target", () => {
    const { repository } = fixture();
    const item = opportunityEvidence();
    repository.ingest(item, now);
    const invented = opener(item);
    invented.decision.choices[1]!.chatId = randomUUID();
    expect(() => runAnalysis(repository, invented)).toThrow(/Chat/);
    const failedId = repository.getSnapshot(personaId, now).recentAttempts[0]!
      .id;
    const failed = repository.getAttempt(failedId)!;
    repository.saveAttempt({ ...failed, status: "failed", outcome: "failed" });
    const ready = runAnalysis(repository, opener(item));
    expect(ready.status).toBe("ready");
    repository.saveAttempt({ ...ready, status: "settled", outcome: "quiet" });
    const normal = observation("已回答", {
      kind: "utterance",
      actor: "agent",
      chatId: randomUUID(),
    });
    repository.ingest(normal, now);
    const associated = opener(item);
    // The prior cue was handled; both current candidates use the supplied Chat source.
    associated.decision.choices[0]!.evidenceIds = [normal.id];
    associated.decision.choices[1]!.evidenceIds = [normal.id];
    associated.decision.selectedBasis.evidenceUses = [
      { evidenceId: normal.id, use: "history" },
    ];
    associated.decision.choices[1]!.chatId = normal.chatId!;
    expect(runAnalysis(repository, associated).status).toBe("ready");
  });

  it("invalidates a decision when its source is cancelled, and keeps cancellation after cursor advancement", () => {
    const { repository } = fixture();
    const item = opportunityEvidence();
    repository.ingest(item, now);
    const attempt = runAnalysis(repository, opener(item));
    const cancelled = {
      ...item,
      id: randomUUID(),
      source: { ...item.source, fragment: "cancelled" },
      opportunity: { ...item.opportunity!, status: "cancelled" as const },
    };
    repository.ingest(cancelled, now);
    expect(repository.actionFreshness(attempt, now).current).toBe(false);
    repository.saveAttempt({
      ...attempt,
      status: "dispatched",
      runId: randomUUID(),
    });
    runAnalysis(repository, analysis([cancelled.id]));
    expect(
      repository.getSnapshot(personaId, now).evidence.map(({ id }) => id),
    ).toContain(cancelled.id);
    expect(repository.actionFreshness(attempt, now).current).toBe(false);
  });

  it("rechecks real time after a slow model completion", () => {
    const { repository } = fixture();
    const item = opportunityEvidence();
    repository.ingest(item, now);
    const attempt = runAnalysis(repository, opener(item));
    expect(repository.actionFreshness(attempt, now).current).toBe(true);
    expect(
      repository.actionFreshness(attempt, item.opportunity!.occursAt).current,
    ).toBe(false);
  });

  it("preserves a pending-completion cue without claiming the supplied body was understood", async () => {
    const h = serviceFixture({
      analyze: () => Promise.reject(new Error("Synthetic model failure")),
    });
    const item = opportunityEvidence();
    h.service.ingest(item);
    // Simulate the actual state phase: it must retain its wake until evidence completion.
    const statePhase = opener(item);
    statePhase.recallPlan = {
      purpose: "conversation",
      query: "原约定",
      questions: [{ id: "q", text: "原约定的内容是什么？" }],
      contextBudget: { maxTokens: 1000 },
    };
    const ready = runAnalysis(h.repository, statePhase);
    h.repository.saveAttempt({
      ...ready,
      status: "failed",
      outcome: "failed",
      error: "completion failed",
    });
    expect(ready.throughSequence).toBeGreaterThan(0);
    expect(h.repository.getAttention(personaId, now)).toMatchObject({
      analyzedThroughSequence: 0,
      catalogueReviewedThroughSequence: 0,
    });
    expect(h.repository.hasPendingOpportunity(personaId, now)).toBe(true);
    await h.service.runDue(now);
    expect(h.errors).toHaveLength(1);
    expect(h.service.earliestNextRunAt()).toBeUndefined();
    h.service.initialize();
    expect(h.service.earliestNextRunAt()).toBe(now);
    expect(
      h.repository.getSnapshot(personaId, now).evidence.map(({ id }) => id),
    ).toContain(item.id);
  });

  it("keeps a user-busy cue available for a later real event, with no repeated due wake", async () => {
    const item = opportunityEvidence();
    const h = serviceFixture({ analyze: () => Promise.resolve(opener(item)) });
    h.setAvailability({ ...availability(), userEngaged: true });
    h.service.ingest(item);
    await h.service.runDue(now);
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect(h.repository.hasPendingOpportunity(personaId, now)).toBe(true);
    expect(h.service.earliestNextRunAt()).toBeUndefined();
  });

  it("cancels the relevant unified Run and propagates invalidation to a prior persona", async () => {
    const item = opportunityEvidence();
    const h = serviceFixture({ analyze: () => Promise.resolve(opener(item)) });
    h.service.ingest(item);
    await h.service.runDue(now);
    expect(h.runtime.dispatch).toHaveBeenCalledOnce();
    const secondPersona = randomUUID();
    h.database
      .prepare(
        "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      )
      .run(secondPersona, now, now);
    const cancelled = {
      ...item,
      id: randomUUID(),
      personaId: secondPersona,
      source: { ...item.source, fragment: "cancelled" },
      opportunity: { ...item.opportunity!, status: "cancelled" as const },
    };
    h.service.ingest(cancelled);
    expect(h.runtime.yieldCharacterRun).toHaveBeenCalledWith(personaId);
    const snapshotRead = h.repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    expect(
      snapshot.evidence.some(
        (evidence) => evidence.opportunity?.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      opportunityIsCurrent(
        snapshot.evidence.find(({ id }) => id === item.id)!,
        snapshot,
        now,
      ),
    ).toBe(false);
  });
});

describe("Cognition observations without a focused object", () => {
  it("persists a legal user observation or idle receipt without NaN focus revision", () => {
    const { repository } = fixture();
    const screenshot = observation("局部截图摘要，不提供对象身份");
    delete screenshot.object;
    repository.ingest(screenshot, now);
    const idle = observation("用户空闲", { boundary: "idle" });
    delete idle.object;
    repository.ingest(idle, now);
    expect(repository.getAttention(personaId, now)).toMatchObject({
      focusRevision: 0,
      lastReceiptSequence: 2,
    });
    repository.ingest(observation(), now);
    expect(repository.getAttention(personaId, now).focusRevision).toBe(1);
  });
});

describe("Cognition character Run history", () => {
  it("yields only actually bound selected character Runs, newest first, and stops with its consumer", () => {
    const { repository, database } = fixture();
    const runs: string[] = [];
    for (const [index, kind] of [
      "continue_character",
      "start_conversation",
      "continue_character",
    ].entries()) {
      const output = analysis();
      output.decision.choices[0]!.kind = kind as CognitionChoice["kind"];
      output.decision.choices.push({
        ...quiet(),
        id: "unchosen-character",
        kind: "continue_character",
      });
      const attempt = runAnalysis(repository, output);
      const runId = randomUUID();
      runs.push(runId);
      database.transaction(() =>
        repository.bindDispatched(attempt.dispatchKey, runId, now),
      )();
      repository.saveAttempt({
        ...repository.getAttempt(attempt.id)!,
        status: "settled",
        updatedAt: `2026-09-15T08:00:0${index}.000Z`,
      });
    }
    const unbound = runAnalysis(repository, analysis());
    repository.saveAttempt({ ...unbound, status: "settled" });
    expect([...repository.characterRunIds(personaId)]).toEqual([
      runs[2],
      runs[0],
    ]);
    expect([...repository.characterRunIds(randomUUID())]).toEqual([]);
    for (const id of repository.characterRunIds(personaId)) {
      expect(id).toBe(runs[2]);
      break;
    }
    // Breaking the outer generator releases the SQLite iterator; normal writes remain available.
    expect(() =>
      repository.updateAttention(personaId, now, (state) => state),
    ).not.toThrow();
  });
});

describe("Cognition bounded journal recovery", () => {
  it("reviews bounded catalogues across pages without pretending unopened original versions were consumed", () => {
    const { repository, database } = fixture(6_000);
    const expected: string[] = [];
    for (let index = 0; index < 80; index++)
      expected.push(
        repository.ingest(
          observation(`实际页面内容 ${index} ${"内容".repeat(100)}`, {
            sourceEpoch: "replay",
            sourceSequence: index,
          }),
          now,
        ).evidence.id,
      );
    const reviewed: number[] = [];
    let pages = 0;
    while (repository.hasReviewableInput(personaId)) {
      const read = repository.readSnapshot(personaId, now);
      expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(
        6_000,
      );
      const baseline = read.coverage.sourceCoverage!.fromSequence;
      const through = read.coverage.sourceCoverage!.throughSequence;
      expect(through).toBeGreaterThan(baseline);
      reviewed.push(
        ...Array.from(
          { length: through - baseline },
          (_, i) => baseline + i + 1,
        ),
      );
      let attempt = repository.createAttempt(
        read,
        "resume",
        now,
        read.coverage.allocation,
        undefined,
        read.coverage.sourceCoverage,
      );
      attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
      const committed = repository.commitAnalysis(attempt.id, analysis(), now);
      repository.saveAttempt({ ...committed, status: "settled" });
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(reviewed).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    for (const id of expected)
      expect(
        repository.hasEvidence(
          personaId,
          readEvidence(database, id, 6000)!.evidence.source,
          "observation",
        ),
      ).toBe(true);
    expect(
      repository.getAttention(personaId, now).catalogueReviewedThroughSequence,
    ).toBe(80);
    expect(
      repository.getAttention(personaId, now).analyzedThroughSequence,
    ).toBeLessThan(80);
  });

  it("keeps a later due cue in context without advancing over older unread sources, and guards cancellation outside the page", () => {
    const { repository } = fixture(6_000);
    for (let index = 0; index < 30; index++)
      repository.ingest(
        observation("长页面".repeat(400), { actor: "system" }),
        now,
      );
    const due = repository.ingest(opportunityEvidence(), now).evidence;
    const read = repository.readSnapshot(personaId, now);
    expect(read.snapshot.evidence.some((item) => item.id === due.id)).toBe(
      true,
    );
    expect(read.snapshot.attention.lastReceiptSequence).toBeLessThan(
      due.receiptSequence,
    );
    const output = analysis([due.id]);
    let attempt = repository.createAttempt(
      read,
      "resume",
      now,
      read.coverage.allocation,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const ready = repository.commitAnalysis(attempt.id, output, now);
    expect(repository.actionFreshness(ready, now).current).toBe(true);
    const cancel = {
      ...opportunityEvidence(),
      source: { ...due.source, fragment: "cancel-after-page" },
      opportunity: { ...due.opportunity!, status: "cancelled" as const },
    };
    repository.ingest(cancel, now);
    expect(repository.actionFreshness(ready, now).current).toBe(false);
    repository.updateAttention(personaId, now, (state) => ({
      ...state,
      analyzedThroughSequence: state.lastReceiptSequence,
    }));
    expect(repository.actionFreshness(ready, now).current).toBe(false);
    expect(repository.opportunityIsCurrent(due, now)).toBe(false);
  });

  it("does not mistake a supplied user utterance beyond the old page for a newly received message", () => {
    const { repository } = fixture(6_000);
    for (let index = 0; index < 20; index++)
      repository.ingest(observation("当前任务".repeat(400)), now);
    const user = repository.ingest(
      observation("先不用了", {
        kind: "utterance",
        actor: "user",
        source: { kind: "message", id: randomUUID() },
      }),
      now,
    ).evidence;
    const read = repository.readSnapshot(personaId, now);
    expect(read.snapshot.evidence.some(({ id }) => id === user.id)).toBe(true);
    expect(read.snapshot.attention.lastReceiptSequence).toBeLessThan(
      user.receiptSequence,
    );
    expect(read.receivedThroughSequence).toBe(user.receiptSequence);
    let attempt = repository.createAttempt(
      read,
      "resume",
      now,
      read.coverage.allocation,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const ready = repository.commitAnalysis(attempt.id, analysis(), now);
    expect(repository.actionFreshness(ready, now).current).toBe(true);
    repository.ingest(
      observation("新收到的更正", {
        kind: "utterance",
        actor: "user",
        source: { kind: "message", id: randomUUID() },
      }),
      now,
    );
    expect(repository.actionFreshness(ready, now).current).toBe(false);
  });

  it("recovers after Provider configuration without making a locked host awake or looping on a repeat failure", async () => {
    const error = new Error("No configured Provider");
    const driver = { analyze: vi.fn(() => Promise.reject(error)) };
    const harness = serviceFixture(driver, undefined, { batchWindowMs: 0 });
    harness.service.ingest(observation());
    await harness.service.runDue(now);
    expect(driver.analyze).toHaveBeenCalledTimes(1);
    expect(harness.service.earliestNextRunAt()).toBeUndefined();
    harness.service.retryAfterConfigurationChange();
    await harness.service.runDue(now);
    expect(driver.analyze).toHaveBeenCalledTimes(2);
    expect(harness.service.earliestNextRunAt()).toBeUndefined();
    harness.setAvailability({ ...availability(), sleeping: true });
    harness.service.retryAfterConfigurationChange();
    await harness.service.runDue(now);
    expect(driver.analyze).toHaveBeenCalledTimes(2);
    expect(
      harness.repository
        .getSnapshot(personaId, now)
        .evidence.some((item) => item.control === "wake"),
    ).toBe(false);
  });
});

describe("Cognition partial intent and visual evidence boundaries", () => {
  it("preserves unseen intent references and oversized progress while applying a visible lifecycle update", () => {
    const { repository } = fixture(6_000);
    const ids = Array.from(
      { length: 120 },
      () => repository.ingest(observation(), now).evidence.id,
    );
    repository.updateAttention(personaId, now, (state) => ({
      ...state,
      analyzedThroughSequence: state.lastReceiptSequence,
    }));
    const intent: CognitionIntent = {
      id: randomUUID(),
      personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "整理花架",
      successCriteria: [],
      evidenceIds: ids,
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "真实进展".repeat(20_000),
      createdAt: now,
      updatedAt: now,
    };
    repository.saveIntent(intent);
    repository.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: intent.id,
    }));
    const read = repository.readSnapshot(personaId, now);
    const view = read.snapshot.intents[0]!;
    const allocation = read.coverage.allocation!.intents![0]!;
    expect(allocation.preservedFields).toContain("progress");
    expect(view.evidenceIds.length).toBeLessThan(ids.length);
    let attempt = repository.createAttempt(
      read,
      "resume",
      now,
      read.coverage.allocation,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const output = analysis();
    const value = { ...view } as Record<string, unknown>;
    for (const key of ["id", "personaId", "revision", "createdAt", "updatedAt"])
      delete value[key];
    output.delta.updateIntents = [
      {
        id: intent.id,
        expectedRevision: 1,
        value: {
          ...(value as CognitionAnalysis["delta"]["updateIntents"][number]["value"]),
          status: "suspended",
          progress: "do not replace original",
          evidenceIds: [],
        },
      },
    ];
    repository.commitAnalysis(attempt.id, output, now);
    const canonical = repository.getIntent(intent.id)!;
    expect(canonical.status).toBe("suspended");
    expect(canonical.progress === intent.progress).toBe(true);
    expect(canonical.evidenceIds).toEqual(ids);
  });

  it("does not deduplicate equal text with a changed picture, while a frame alone does not schedule reasoning", () => {
    const { service, repository } = serviceFixture(
      { analyze: () => Promise.resolve(analysis()) },
      undefined,
      { batchWindowMs: 0 },
    );
    const visual: NonNullable<CognitionEvidenceInput["visual"]> = {
      eventId: randomUUID(),
      artifactId: randomUUID(),
      contentRevision: "image-1",
      capturedAt: now,
      width: 100,
      height: 100,
      trigger: "frame",
      surface: {
        id: "synthetic",
        epoch: "test",
        displayId: "1",
        windowId: "1",
        processId: 1,
        appName: "Synthetic",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        scaleFactor: 1,
        clipped: false,
      },
    };
    service.ingest(observation("同一句局部文字", { visual }));
    service.ingest(
      observation("同一句局部文字", {
        visual: {
          ...visual,
          eventId: randomUUID(),
          artifactId: randomUUID(),
          contentRevision: "image-2",
        },
      }),
    );
    const firstRead = repository.readSnapshot(personaId, now);
    expect(firstRead.coverage.sourceCoverage?.eventCount).toBe(2);
    expect(firstRead.coverage.sourceCoverage?.entries[0]?.visualCount).toBe(2);
    expect(firstRead.snapshot.evidence).toHaveLength(1);
    expect(service.earliestNextRunAt()).toBeUndefined();
    expect(repository.hasUnanalyzedMeaning(personaId)).toBe(false);
    service.ingest(
      observation("同一句局部文字", {
        visual: {
          ...visual,
          eventId: randomUUID(),
          artifactId: randomUUID(),
          contentRevision: "image-3",
          trigger: "content",
        },
      }),
    );
    const changedRead = repository.readSnapshot(personaId, now);
    expect(changedRead.coverage.sourceCoverage?.eventCount).toBe(3);
    expect(changedRead.snapshot.evidence).toHaveLength(1);
    expect(service.earliestNextRunAt()).toBe(now);
  });
});

describe("Cognition on-demand input refresh and final intent gates", () => {
  it("refreshes only before due analysis and includes newly ingested input in that analysis", async () => {
    const fresh = observation("当前合成画面的新内容");
    const analyze = vi.fn((input: CognitionAnalysisInput) =>
      Promise.resolve(analysis(input.snapshot.evidence.map(({ id }) => id))),
    );
    const refresh = vi.fn(() => {
      h.service.ingest(fresh);
      return Promise.resolve();
    });
    const h = serviceFixture({ analyze }, undefined, {
      beforeAnalysis: refresh,
      batchWindowMs: 0,
    });
    await h.service.prepareTurn({
      personaId,
      chatId: randomUUID(),
      currentInput: "早上好",
      contextBudget: { maxTokens: 10_000 },
      resourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
      signal: new AbortController().signal,
    });
    await h.service.runDue(now);
    expect(refresh).not.toHaveBeenCalled();
    h.service.ingest(observation("原先内容"));
    await h.service.runDue(now);
    expect(refresh).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledOnce();
    expect(
      analyze.mock.calls[0]![0].snapshot.evidence.some(
        ({ id }) => id === fresh.id,
      ),
    ).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("does not start analysis after the user takes attention while input refresh is awaiting", async () => {
    const analyze = vi.fn(() => Promise.resolve(analysis()));
    const h = serviceFixture({ analyze }, undefined, {
      beforeAnalysis: () => h.service.yieldToUser(personaId),
      batchWindowMs: 0,
    });
    h.service.ingest(observation());
    await h.service.runDue(now);
    expect(analyze).not.toHaveBeenCalled();
    expect(h.repository.getSnapshot(personaId, now).recentAttempts).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("checks an omitted chosen intent from scalar persistent state without loading its huge progress", () => {
    const { repository } = fixture(6_000);
    const intent: CognitionIntent = {
      id: randomUUID(),
      personaId,
      revision: 1,
      owner: "user",
      basis: "explicit_user",
      status: "active",
      goal: "继续已确认的整理任务",
      successCriteria: [],
      evidenceIds: [],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "真实进展".repeat(20_000),
      createdAt: now,
      updatedAt: now,
    };
    repository.saveIntent(intent);
    for (let i = 1; i < 20; i++)
      repository.saveIntent({
        ...intent,
        id: randomUUID(),
        progress: "其他近期任务".repeat(100),
        updatedAt: `2026-09-15T08:00:${String(i).padStart(2, "0")}.000Z`,
      });
    const choice: CognitionChoice = {
      ...quiet(),
      kind: "continue_shared",
      intentId: intent.id,
      executionScope: "conversation",
    };
    const snapshotRead = repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    expect(snapshot.intents.some(({ id }) => id === intent.id)).toBe(false);
    expect(choiceBlockReason(choice, snapshot, availability())).toBe(
      "intent_not_active",
    );
    expect(
      repository.choiceBlockReason(choice, personaId, availability()),
    ).toBeUndefined();
    expect(
      repository.choiceBlockReason(choice, randomUUID(), availability()),
    ).toBe("intent_not_active");
    repository.saveIntent({ ...intent, revision: 2, status: "suspended" }, 1);
    expect(
      repository.choiceBlockReason(choice, personaId, availability()),
    ).toBe("intent_not_active");
  });
});

describe("Cognition grounded open claims", () => {
  it("publishes grounded material changes after commit with original and contradicting sources while the episode stays open", () => {
    const { repository, database } = fixture();
    const oldSource = repository.ingest(
      observation("我不吃香菜", {
        kind: "utterance",
        source: { kind: "run", id: randomUUID(), fragment: "item:user-one" },
      }),
      now,
    ).evidence;
    const output = analysis([oldSource.id]);
    const created = newSituation(oldSource.id);
    created.value.claims[0]!.basis = "reported";
    created.value.claims[0]!.text = "用户报告不吃香菜";
    created.value.claims.push({
      ...created.value.claims[0]!,
      id: "hypothesis",
      basis: "inferred",
      state: "uncertain",
      text: "用户可能只是今天不吃",
    });
    output.delta.createSituations = [created];
    const commit = (value: CognitionAnalysis) => {
      let attempt = repository.createAttempt(
        repository.readSnapshot(personaId, now),
        "semantic_change",
        now,
      );
      attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
      const result = repository.commitAnalysis(attempt.id, value, now);
      repository.saveAttempt({
        ...result,
        status: "settled",
        outcome: "quiet",
      });
      return result;
    };
    const ready = commit(output);
    expect([...repository.pendingMemoryHandoffs()]).toHaveLength(1);
    const situationId = ready.dependencies.situations[0]!.id;
    expect(
      repository
        .getSituation(situationId)!
        .episodes.every((episode) => episode.state === "open"),
    ).toBe(true);
    const current = repository.getSituation(situationId)!;
    const value = { ...current } as Record<string, unknown>;
    for (const key of ["id", "personaId", "revision", "createdAt", "updatedAt"])
      delete value[key];
    const unchanged = analysis();
    unchanged.delta.updateSituations = [
      {
        id: situationId,
        expectedRevision: current.revision,
        value: value as typeof created.value,
      },
    ];
    commit(unchanged);
    expect([...repository.pendingMemoryHandoffs()]).toHaveLength(1);
    const correction = repository.ingest(
      observation("现在我已经接受香菜了，上次那个偏好改了", {
        kind: "utterance",
        source: {
          kind: "run",
          id: randomUUID(),
          fragment: "item:user-correction",
        },
      }),
      now,
    ).evidence;
    const next = repository.getSituation(situationId)!;
    const corrected = analysis([correction.id]);
    corrected.delta.updateSituations = [
      {
        id: situationId,
        expectedRevision: next.revision,
        value: {
          ...(value as typeof created.value),
          claims: [
            {
              ...next.claims[0]!,
              state: "superseded",
              contradictingEvidenceIds: [correction.id],
            },
            {
              ...next.claims[0]!,
              id: "accepts-cilantro",
              text: "用户报告现在已接受香菜",
              evidenceIds: [correction.id],
            },
          ],
        },
      },
    ];
    commit(corrected);
    const pending = [...repository.pendingMemoryHandoffs()];
    expect(pending).toHaveLength(3);
    const retirement = pending.find(
      (item) => item.primaryEvidenceIds.length === 2,
    )!;
    expect(repository.getSituation(situationId)!.claims[0]!.state).toBe(
      "superseded",
    );
    expect(
      [
        ...repository.memoryHandoffEvidence(
          retirement,
          retirement.primaryEvidenceIds,
        ),
      ].map((e) => e.source.fragment),
    ).toEqual(["item:user-one", "item:user-correction"]);
    expect(
      repository
        .getSituation(situationId)!
        .episodes.every((episode) => episode.state === "open"),
    ).toBe(true);
    const recovered = new CognitionRepository(database, {
      readBudgetBytes: 32_768,
    });
    expect([...recovered.pendingMemoryHandoffs()]).toEqual(pending);
    for (const item of recovered.pendingMemoryHandoffs()) {
      database.transaction(() => recovered.acknowledgeMemoryHandoff(item.id))();
    }
    expect([...recovered.pendingMemoryHandoffs()]).toEqual([]);
  });

  it("requires separate observed and reported claims for a mixed desktop observation and a user invitation", () => {
    const { repository } = fixture();
    const desktop = repository.ingest(
      observation("小说自动保存", { actor: "system" }),
      now,
    ).evidence;
    const user = repository.ingest(
      observation("今天先不写了，陪我喝咖啡", { kind: "utterance" }),
      now,
    ).evidence;
    const output = analysis([desktop.id, user.id]);
    const created = newSituation(desktop.id);
    created.value.claims[0]!.evidenceIds = [desktop.id, user.id];
    created.value.claims[0]!.text = "编辑器仍开着，用户现在邀请喝咖啡";
    output.delta.createSituations = [created];
    expect(() => runAnalysis(repository, output)).toThrow(
      "Observed claim contains non-observation evidence",
    );
    const failedId = repository.getSnapshot(personaId, now).recentAttempts[0]!
      .id;
    const failed = repository.getAttempt(failedId)!;
    repository.saveAttempt({ ...failed, status: "failed", outcome: "failed" });
    created.value.claims = [
      {
        ...created.value.claims[0]!,
        text: "编辑器出现自动保存",
        evidenceIds: [desktop.id],
      },
      {
        ...created.value.claims[0]!,
        id: "coffee-invitation",
        basis: "reported",
        text: "用户邀请喝咖啡",
        evidenceIds: [user.id],
      },
    ];
    expect(runAnalysis(repository, output).status).toBe("ready");
  });
});

describe("Cognition local passive source runs", () => {
  it("preserves exact cumulative counts across bounded catalogue pages without opening every event", () => {
    const { repository } = fixture();
    const first = repository.ingest(
      observation("第一处真实内容"),
      now,
    ).evidence;
    const sources: CognitionEvidence[] = [];
    for (let i = 0; i < 1800; i++)
      sources.push(
        repository.ingest(
          observation("", {
            boundary: "interaction",
            interaction: { clicks: 1, keystrokes: 8, scrolls: 2 },
            observedAt: new Date(Date.parse(now) + i * 1000).toISOString(),
          }),
          now,
        ).evidence,
      );
    const last = repository.ingest(
      observation("最后一处真实内容"),
      now,
    ).evidence;
    let interactions = { clicks: 0, keystrokes: 0, scrolls: 0 };
    let pages = 0;
    while (repository.hasReviewableInput(personaId)) {
      const read = repository.readSnapshot(personaId, now);
      for (const entry of read.coverage.sourceCoverage!.entries) {
        const counts = entry.interaction;
        if (counts)
          interactions = {
            clicks: interactions.clicks + counts.clicks,
            keystrokes: interactions.keystrokes + counts.keystrokes,
            scrolls: interactions.scrolls + counts.scrolls,
          };
      }
      expect(read.snapshot.evidence.map((e) => e.id)).toContain(last.id);
      expect(read.snapshot.evidence.length).toBeLessThan(6);
      expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(
        32768,
      );
      const attempt = repository.createAttempt(
        read,
        "semantic_change",
        now,
        read.coverage.allocation,
        undefined,
        read.coverage.sourceCoverage,
      );
      repository.saveAttempt({ ...attempt, status: "analyzing" });
      const committed = repository.commitAnalysis(attempt.id, analysis(), now);
      repository.saveAttempt({
        ...committed,
        status: "settled",
        outcome: "quiet",
      });
      pages++;
    }
    expect(interactions).toEqual({
      clicks: 1800,
      keystrokes: 14400,
      scrolls: 3600,
    });
    expect(pages).toBeGreaterThan(1);
    expect(repository.hasEvidence(personaId, first.source, "observation")).toBe(
      true,
    );
    repository.consumePassivePrefix(personaId, now);
    expect(
      repository.getAttention(personaId, now).analyzedThroughSequence,
    ).toBe(0);
  });

  it("consumes only a pure prefix locally, stops at text or real visuals, and splits ownership and source epochs", () => {
    const { repository } = fixture();
    const count = (extra: Partial<CognitionEvidenceInput> = {}) =>
      observation("", {
        boundary: "interaction",
        interaction: { clicks: 0, keystrokes: 3, scrolls: 0 },
        sourceEpoch: "one",
        ...extra,
      });
    repository.ingest(count(), now);
    repository.ingest(count({ actor: "agent" }), now);
    repository.ingest(count({ actor: "agent", sourceEpoch: "two" }), now);
    const content = repository.ingest(
      count({ text: "这里有真正变化的可见内容" }),
      now,
    ).evidence;
    repository.ingest(count(), now);
    const before = repository.readSnapshot(personaId, now);
    expect(
      before.coverage.sourceCoverage?.entries.map((s) => [
        s.actor,
        s.sourceEpoch,
        s.eventCount,
      ]),
    ).toEqual([
      ["user", "one", 1],
      ["agent", "one", 1],
      ["agent", "two", 1],
      ["user", "one", 2],
    ]);
    repository.consumePassivePrefix(personaId, now);
    const attention = repository.getAttention(personaId, now);
    expect(attention.analyzedThroughSequence).toBe(content.receiptSequence - 1);
    expect(attention.lastReceiptSequence).toBe(5);
    const after = repository.readSnapshot(personaId, now);
    expect(after.snapshot.evidence.some((e) => e.id === content.id)).toBe(true);
    expect(
      after.coverage.passiveSpans?.some(
        (s) => s.actor === "agent" && s.sourceEpoch === "two",
      ),
    ).toBe(true);
  });
});

describe("Cognition interaction content is still semantic evidence", () => {
  it("does not lose a changed AX text merely because the native trigger was an interaction", async () => {
    const analyze = vi.fn((input: CognitionAnalysisInput) =>
      Promise.resolve(analysis(input.snapshot.evidence.map((e) => e.id))),
    );
    const h = serviceFixture({ analyze }, undefined, { batchWindowMs: 0 });
    const content = observation("滚动后实际可见的新段落", {
      boundary: "interaction",
      interaction: { clicks: 0, keystrokes: 0, scrolls: 2 },
    });
    h.service.ingest(content);
    expect(h.repository.hasUnanalyzedMeaning(personaId)).toBe(true);
    h.repository.consumePassivePrefix(personaId, now);
    expect(
      h.repository.getAttention(personaId, now).analyzedThroughSequence,
    ).toBe(0);
    await h.service.runDue(now);
    expect(analyze).toHaveBeenCalledOnce();
    expect(
      analyze.mock.calls[0]![0].snapshot.evidence.some(
        (e) => e.id === content.id,
      ),
    ).toBe(true);
    expect(h.errors).toEqual([]);
  });
});

describe("Cognition durable claim provenance and visual wake", () => {
  it("keeps displaced support as neutral source history so live publication and restart have the same raw evidence set", () => {
    const { repository, database } = fixture();
    const original = repository.ingest(
      observation("以前不吃香菜", { kind: "utterance" }),
      now,
    ).evidence;
    const create = analysis([original.id]);
    const created = newSituation(original.id);
    created.value.claims[0]!.basis = "reported";
    created.value.claims[0]!.historyEvidenceIds = [randomUUID()];
    create.delta.createSituations = [created];
    const first = runAnalysis(repository, create);
    repository.saveAttempt({ ...first, status: "settled" });
    const situationId = first.dependencies.situations[0]!.id;
    const old = repository.getSituation(situationId)!;
    expect(old.claims[0]!.historyEvidenceIds).toBeUndefined();
    const correction = repository.ingest(
      observation("现在喜欢吃香菜了", { kind: "utterance" }),
      now,
    ).evidence;
    const value = { ...old } as Record<string, unknown>;
    for (const key of ["id", "personaId", "revision", "createdAt", "updatedAt"])
      delete value[key];
    const update = analysis([correction.id]);
    update.delta.updateSituations = [
      {
        id: situationId,
        expectedRevision: old.revision,
        value: {
          ...(value as typeof created.value),
          claims: [
            {
              ...old.claims[0]!,
              text: "现在喜欢香菜",
              evidenceIds: [correction.id],
              contradictingEvidenceIds: [],
            },
          ],
        },
      },
    ];
    let attempt = repository.createAttempt(
      repository.readSnapshot(personaId, now),
      "semantic_change",
      now,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    repository.commitAnalysis(attempt.id, update, now);
    const live = [...repository.pendingMemoryHandoffs()];
    const claim = repository.getSituation(situationId)!.claims[0]!;
    expect(claim.evidenceIds).toEqual([correction.id]);
    expect(claim.contradictingEvidenceIds).toEqual([]);
    expect(claim.historyEvidenceIds).toEqual([original.id]);
    expect(
      repository.protectedActivitySourceIds([
        original.source.id,
        correction.source.id,
      ]),
    ).toEqual(new Set([original.source.id, correction.source.id]));
    const recovered = new CognitionRepository(database, {
      readBudgetBytes: 32_768,
    });
    expect([...recovered.pendingMemoryHandoffs()]).toEqual(live);
    const changed = live.find((item) => item.historyEvidenceIds.length)!;
    expect(changed.primaryEvidenceIds).toEqual([correction.id]);
    expect(changed.historyEvidenceIds).toEqual([original.id]);
  });

  it("coalesces visual change signals to one wake without inventing evidence or waking during sleep", () => {
    const h = serviceFixture({ analyze: () => Promise.resolve(analysis()) });
    for (let i = 0; i < 1000; i++) h.service.notifyVisualChange();
    const state = h.repository.getAttention(personaId, now);
    expect(state.revision).toBe(1);
    expect(state.lastReceiptSequence).toBe(0);
    expect(h.service.earliestNextRunAt()).toBe("2026-09-15T08:00:10.000Z");
    h.setAvailability({ ...availability(), sleeping: true });
    h.service.notifyVisualChange();
    expect(h.repository.getAttention(personaId, now).revision).toBe(1);
  });
});

describe("Cognition latest current view and historical cursor", () => {
  it("reserves the actual latest focused source without jumping over omitted historical sources", () => {
    const { repository } = fixture(6000);
    const sources: CognitionEvidence[] = [];
    for (let i = 0; i < 80; i++)
      sources.push(
        repository.ingest(
          observation(`可见版本${i}：${"合成正文".repeat(50)}`),
          now,
        ).evidence,
      );
    const read = repository.readSnapshot(personaId, now);
    expect(read.coverage.currentViewEvidenceId).toBe(sources.at(-1)!.id);
    expect(
      read.snapshot.evidence.some((e) => e.id === sources.at(-1)!.id),
    ).toBe(true);
    expect(read.snapshot.attention.lastReceiptSequence).toBeLessThan(
      sources.at(-1)!.receiptSequence,
    );
    expect(read.coverage.moreEvidencePending).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(6000);
  });
});

describe("Cognition Activity source ownership", () => {
  it("protects only candidate sources while unread, in active claims/episodes, or in unfinished decisions", () => {
    const { repository, database } = fixture();
    const items = ["情节证据", "断言证据", "独立已处理证据"].map(
      (text) =>
        repository.ingest(observation(text, { actor: "agent" }), now).evidence,
    );
    const ids = items.map((item) => item.source.id);
    expect(repository.protectedActivitySourceIds(ids)).toEqual(new Set(ids));
    expect(repository.protectedActivitySourceIds(ids, new Set(ids))).toEqual(
      new Set(ids),
    );
    const output = analysis(items.map((item) => item.id));
    const created = newSituation(items[0]!.id);
    created.value.claims[0]!.evidenceIds = [items[1]!.id];
    output.delta.createSituations = [created];
    const first = runAnalysis(repository, output);
    expect(repository.protectedActivitySourceIds(ids)).toEqual(new Set(ids));
    expect(repository.protectedActivitySourceIds(ids, new Set(ids))).toEqual(
      new Set(ids),
    );
    repository.saveAttempt({ ...first, status: "settled" });
    expect(repository.protectedActivitySourceIds(ids)).toEqual(
      new Set(ids.slice(0, 2)),
    );
    // A complete Memory snapshot alone cannot acknowledge an untransferred handoff.
    expect(repository.protectedActivitySourceIds(ids, new Set(ids))).toEqual(
      new Set([ids[1]!]),
    );
    for (const item of repository.pendingMemoryHandoffs())
      database.transaction(() =>
        repository.acknowledgeMemoryHandoff(item.id),
      )();
    expect(repository.protectedActivitySourceIds(ids, new Set(ids))).toEqual(
      new Set(),
    );
    expect(
      repository.protectedActivitySourceIds([ids[1]!, randomUUID()]),
    ).toEqual(new Set([ids[1]!]));
    const situation = repository.getSituation(
      first.dependencies.situations[0]!.id,
    )!;
    const close = analysis();
    close.delta.updateSituations = [
      {
        id: situation.id,
        expectedRevision: situation.revision,
        value: {
          ...created.value,
          status: "closed",
          episodes: [
            { ...situation.episodes[0]!, state: "closed", endedAt: now },
          ],
          claims: [{ ...situation.claims[0]!, state: "superseded" }],
        },
      },
    ];
    const completed = runAnalysis(repository, close);
    repository.saveAttempt({ ...completed, status: "settled" });
    for (const item of repository.pendingMemoryHandoffs())
      database.transaction(() =>
        repository.acknowledgeMemoryHandoff(item.id),
      )();
    expect(repository.protectedActivitySourceIds(ids)).toEqual(new Set());
    expect(repository.protectedActivitySourceIds([])).toEqual(new Set());
  });

  it("projects only actual selected visual source metadata without loading source text", () => {
    const { repository } = fixture();
    const visual: NonNullable<CognitionEvidenceInput["visual"]> = {
      eventId: randomUUID(),
      artifactId: randomUUID(),
      contentRevision: "actual-frame",
      surface: {
        id: "fixture",
        epoch: "first",
        displayId: "display",
        windowId: "window",
        processId: 123,
        appName: "Fixture",
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        scaleFactor: 1,
        clipped: false,
      },
      capturedAt: now,
      width: 400,
      height: 300,
      trigger: "content",
    };
    const frame = repository.ingest(
      observation("很多实际原文".repeat(10000), { visual }),
      now,
    ).evidence;
    const text = repository.ingest(observation("普通来源"), now).evidence;
    const sources = [frame.source.id, text.source.id];
    expect(
      repository.protectedActivitySourceIds(sources, new Set(sources)),
    ).toEqual(new Set(sources));
    // The next decision may reuse an actual selected frame, not every old exposure.
    const analyzed = runAnalysis(repository, analysis([frame.id]));
    repository.saveAttempt({ ...analyzed, status: "settled" });
    // A canonical text snapshot cannot release pixels still used as the current view.
    expect(
      repository.protectedActivitySourceIds(sources, new Set(sources)),
    ).toEqual(new Set([frame.source.id]));
    const selected = analysis([frame.id, text.id]);
    selected.decision.selectedBasis.evidenceUses[0]!.use = "current_object";
    const attempt = runAnalysis(repository, selected);
    const rows = [...repository.actionVisualEvidence(attempt)];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: frame.id,
      actor: "user",
      object: { key: frame.object!.key },
      visual,
    });
    expect(rows[0]?.text).toBeUndefined();
    expect([
      ...repository.actionVisualEvidence({
        ...attempt,
        actionReadSet: { ...attempt.actionReadSet!, currentObjects: [] },
      }),
    ]).toEqual([]);
  });
});

describe("Cognition historical relation preservation", () => {
  it("preserves a supplied situation's existing link to omitted closed history without allowing new links or focus", () => {
    const { repository } = fixture();
    const item = repository.ingest(observation(), now).evidence;
    const closed = newSituation(item.id, "new:history");
    closed.value.status = "closed";
    closed.value.episodes[0]!.state = "closed";
    closed.value.episodes[0]!.endedAt = now;
    const current = newSituation(item.id, "new:current");
    current.value.relatedSituationIds = ["new:history"];
    const create = analysis([item.id]);
    create.delta.createSituations = [closed, current];
    create.delta.attention.currentSituationId = "new:current";
    const ready = runAnalysis(repository, create);
    repository.saveAttempt({ ...ready, status: "settled" });
    const snapshotRead = repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    const visible = snapshot.situations[0]!;
    expect(snapshot.situations).toHaveLength(1);
    const historicalId = visible.relatedSituationIds[0]!;
    expect(repository.getSituation(historicalId)!.status).toBe("closed");
    let attempt = repository.createAttempt(snapshotRead, "resume", now);
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const update = analysis();
    update.delta.updateSituations = [
      {
        id: visible.id,
        expectedRevision: visible.revision,
        value: {
          ...current.value,
          summary: "新进展，原有历史联系保留",
          relatedSituationIds: [historicalId],
        },
      },
    ];
    const invented = structuredClone(update);
    invented.delta.updateSituations[0]!.value.relatedSituationIds = [
      randomUUID(),
    ];
    expect(() => repository.commitAnalysis(attempt.id, invented, now)).toThrow(
      "Unknown related situation",
    );
    const illegalFocus = structuredClone(update);
    illegalFocus.delta.attention.currentSituationId = historicalId;
    expect(() =>
      repository.commitAnalysis(attempt.id, illegalFocus, now),
    ).toThrow();
    const illegalSupersession = structuredClone(update);
    illegalSupersession.delta.updateSituations[0]!.value.supersededBy =
      historicalId;
    expect(() =>
      repository.commitAnalysis(attempt.id, illegalSupersession, now),
    ).toThrow("Unknown related situation");
    repository.commitAnalysis(attempt.id, update, now);
    expect(repository.getSituation(visible.id)!.relatedSituationIds).toEqual([
      historicalId,
    ]);
  });
});

describe("Cognition formation context", () => {
  it("returns unique one-hop original evidence in receipt order, excluding anchors, future receipts and other personas", () => {
    const { repository, database } = fixture();
    const raw = [
      "不相关的更早经历",
      "今天只想安静坐会儿",
      "昨天你本来想做的那东西弄成了吗？",
      "今天可以继续自己的生活，不用一直围着拒信转。",
      "后来才完成的新事情",
    ].map((text) => repository.ingest(observation(text), now).evidence);
    const output = analysis(raw.map(({ id }) => id));
    const created = newSituation(raw[1]!.id);
    created.value.claims = [];
    created.value.episodes = [
      {
        ...created.value.episodes[0]!,
        id: "quiet",
        state: "closed",
        evidenceIds: [raw[1]!.id, raw[3]!.id],
      },
      {
        ...created.value.episodes[0]!,
        id: "resumption",
        evidenceIds: [raw[2]!.id, raw[3]!.id, raw[4]!.id],
      },
      // The earlier source shares only newly found context, not a primary anchor.
      {
        ...created.value.episodes[0]!,
        id: "second-hop",
        evidenceIds: [raw[0]!.id, raw[2]!.id],
      },
      {
        ...created.value.episodes[0]!,
        id: "duplicate-context",
        evidenceIds: [raw[2]!.id, raw[3]!.id],
      },
    ];
    output.delta.createSituations = [created];
    const ready = runAnalysis(repository, output);
    repository.saveAttempt({ ...ready, status: "settled" });
    const otherPersona = randomUUID();
    database
      .prepare(
        "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      )
      .run(otherPersona, now, now);
    const other = repository.ingest(
      observation("另一个角色的经历", { personaId: otherPersona }),
      now,
    ).evidence;
    const otherOutput = analysis([other.id]);
    otherOutput.delta.createSituations = [newSituation(other.id)];
    let otherAttempt = repository.createAttempt(
      repository.readSnapshot(otherPersona, now),
      "semantic_change",
      now,
    );
    otherAttempt = repository.saveAttempt({
      ...otherAttempt,
      status: "analyzing",
    });
    repository.commitAnalysis(otherAttempt.id, otherOutput, now);
    const anchors = [raw[3]!.id, raw[3]!.id];
    const expected = [raw[1]!.id, raw[2]!.id];
    const ids = [];
    for (const item of repository.formationContext(personaId, anchors)) {
      ids.push(item.id);
      expect(item.text).toBe(raw.find(({ id }) => id === item.id)!.text);
      expect(database.inTransaction).toBe(false);
      database.transaction(() =>
        repository.updateAttention(personaId, now, (state) => state),
      )();
    }
    expect(ids).toEqual(expected);
    expect(
      [...repository.formationContext(personaId, [raw[1]!.id, raw[3]!.id])].map(
        ({ id }) => id,
      ),
    ).toEqual([raw[2]!.id]);
    expect([...repository.formationContext(personaId, [other.id])]).toEqual([]);
    expect([...repository.formationContext(otherPersona, anchors)]).toEqual([]);
    expect([...repository.formationContext(personaId, [])]).toEqual([]);
    const restarted = new Database(database.serialize());
    databases.push(restarted);
    const recovered = new CognitionRepository(restarted, {
      readBudgetBytes: 32_768,
    });
    expect(
      [...recovered.formationContext(personaId, anchors)].map(({ id }) => id),
    ).toEqual(expected);
  });

  it("updates only visible episode source references atomically and preserves unseen episode references", () => {
    const { repository, database } = fixture();
    const old = repository.ingest(observation("旧原文"), now).evidence;
    const anchor = repository.ingest(observation("共享锚点"), now).evidence;
    const output = analysis([old.id, anchor.id]);
    const created = newSituation(old.id);
    created.value.summary = "历史情节".repeat(20_000);
    created.value.claims = [];
    created.value.episodes = Array.from({ length: 120 }, (_, index) => ({
      ...created.value.episodes[0]!,
      id: `episode-${index}`,
      evidenceIds: [old.id, anchor.id],
    }));
    output.delta.createSituations = [created];
    const ready = runAnalysis(repository, output);
    repository.saveAttempt({ ...ready, status: "settled" });
    const id = ready.dependencies.situations[0]!.id;
    const replacement = repository.ingest(
      observation("替换后的实际原文"),
      now,
    ).evidence;
    const selection = repository.readSnapshot(personaId, now, 8_000);
    const situation = selection.snapshot.situations.find(
      (value) => value.id === id,
    )!;
    const allocation = selection.coverage.allocation!.situations.find(
      (value) => value.id === id,
    )!;
    expect(allocation.episodeIds.length).toBeGreaterThan(0);
    expect(allocation.episodeIds.length).toBeLessThan(120);
    let attempt = repository.createAttempt(
      selection,
      "semantic_change",
      now,
      selection.coverage.allocation,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const visible = situation.episodes[0]!;
    const update = analysis([replacement.id]);
    update.delta.updateSituations = [
      {
        id,
        expectedRevision: situation.revision,
        value: {
          ...created.value,
          episodes: [
            {
              ...visible,
              state: "closed",
              endedAt: now,
              evidenceIds: [anchor.id, replacement.id],
            },
          ],
        },
      },
    ];
    const refs = () =>
      database
        .prepare(
          "SELECT episode_id,evidence_id FROM cognition_episode_evidence WHERE situation_id = ? ORDER BY episode_id,evidence_id",
        )
        .all(id);
    const before = refs();
    database.exec(
      "CREATE TEMP TRIGGER fail_context_commit BEFORE UPDATE ON cognition_state BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END",
    );
    expect(() => repository.commitAnalysis(attempt.id, update, now)).toThrow(
      "synthetic commit failure",
    );
    expect(refs()).toEqual(before);
    expect([...repository.pendingMemoryHandoffs()]).toEqual([]);
    expect(repository.getSituation(id)!.revision).toBe(1);
    database.exec("DROP TRIGGER fail_context_commit");
    repository.commitAnalysis(attempt.id, update, now);
    const pending = [...repository.pendingMemoryHandoffs()];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.primaryEvidenceIds).toEqual(
      [anchor.id, replacement.id].sort(),
    );
    // The newly closed visible Episode uses final refs; an accepted replacement
    // must not pull the unrelated old source from an unseen sibling Episode.
    expect(
      [...repository.memoryHandoffContext(pending[0]!, [replacement.id])].map(
        ({ id }) => id,
      ),
    ).toEqual([anchor.id]);

    expect(
      database
        .prepare(
          "SELECT evidence_id FROM cognition_episode_evidence WHERE situation_id = ? AND episode_id = ? ORDER BY evidence_id",
        )
        .all(id, visible.id),
    ).toEqual(
      [anchor.id, replacement.id]
        .sort()
        .map((evidence_id) => ({ evidence_id })),
    );
    const hidden = created.value.episodes.find(
      (episode) => !allocation.episodeIds.includes(episode.id),
    )!;
    expect(
      database
        .prepare(
          "SELECT evidence_id FROM cognition_episode_evidence WHERE situation_id = ? AND episode_id = ? ORDER BY evidence_id",
        )
        .all(id, hidden.id),
    ).toEqual(
      [old.id, anchor.id].sort().map((evidence_id) => ({ evidence_id })),
    );
    expect(
      [...repository.formationContext(personaId, [replacement.id])].map(
        ({ id: sourceId }) => sourceId,
      ),
    ).toEqual([anchor.id]);
  });

  it("removes full-replacement episode references and cascades deleted situation or evidence rows", () => {
    const { repository, database } = fixture();
    database.pragma("foreign_keys = ON");
    const first = repository.ingest(observation("第一段原文"), now).evidence;
    const anchor = repository.ingest(observation("原文锚点"), now).evidence;
    const output = analysis([first.id, anchor.id]);
    const created = newSituation(first.id);
    created.value.claims = [];
    created.value.episodes.push({
      ...created.value.episodes[0]!,
      id: "removed-episode",
      evidenceIds: [first.id, anchor.id],
    });
    output.delta.createSituations = [created];
    const ready = runAnalysis(repository, output);
    repository.saveAttempt({ ...ready, status: "settled" });
    const id = ready.dependencies.situations[0]!.id;
    const update = analysis();
    update.delta.updateSituations = [
      {
        id,
        expectedRevision: 1,
        value: { ...created.value, episodes: [created.value.episodes[0]!] },
      },
    ];
    runAnalysis(repository, update);
    expect(
      database
        .prepare(
          "SELECT episode_id FROM cognition_episode_evidence WHERE situation_id = ?",
        )
        .all(id),
    ).toEqual([{ episode_id: "episode-draft" }]);
    expect([...repository.formationContext(personaId, [anchor.id])]).toEqual(
      [],
    );
    database
      .prepare("DELETE FROM cognition_evidence WHERE id = ?")
      .run(first.id);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM cognition_episode_evidence")
        .get(),
    ).toEqual({ count: 0 });
    database
      .prepare("INSERT INTO cognition_episode_evidence VALUES (?,?,?)")
      .run(id, "episode-draft", anchor.id);
    database.prepare("DELETE FROM cognition_situations WHERE id = ?").run(id);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM cognition_episode_evidence")
        .get(),
    ).toEqual({ count: 0 });
  });
});

function recalledSource(
  repository: CognitionRepository,
  extra: Partial<CognitionEvidenceInput> = {},
) {
  const reading = repository.createAttempt(
    repository.readSnapshot(personaId, now),
    "semantic_change",
    now,
  );
  repository.saveAttempt({ ...reading, status: "settled", outcome: "quiet" });
  return repository.ingest(
    {
      id: randomUUID(),
      personaId,
      actor: "system",
      kind: "recollection",
      text: "用户曾说这份材料属于朋友",
      observedAt: now,
      recollection: {
        historyStatus: "current",
        type: "event",
        basis: "explicit_user_statement",
        owner: "user",
        current: true,
        recordedAt: "2026-08-01T00:00:00.000Z",
      },
      ...extra,
      source: {
        kind: "memory",
        id: extra.source?.id ?? randomUUID(),
        revision: extra.source?.revision ?? randomUUID(),
        fragment: reading.id,
      },
    },
    now,
  ).evidence;
}

describe("recollection source and selected execution material", () => {
  it.each(["user", "agent", "system"] as const)(
    "preserves an actual %s utterance as a report without treating it as an observed effect",
    (actor) => {
      const { repository } = fixture();
      const source = repository.ingest(
        observation("我之前说过明天准备花圃，并没有说已经完成", {
          actor,
          kind: "utterance",
        }),
        now,
      ).evidence;
      const output = analysis([source.id]);
      const created = newSituation(source.id);
      created.value.claims[0]!.basis = "reported";
      output.delta.createSituations = [created];
      const committed = runAnalysis(repository, output);
      expect(committed.status).toBe("ready");
      expect(
        repository.readActionContext(committed, 10_000, (value) => value).text,
      ).toContain(`"actor":"${actor}"`);
      repository.saveAttempt({
        ...committed,
        status: "settled",
        outcome: "quiet",
      });
      const observed = analysis([source.id]);
      observed.delta.createSituations = [newSituation(source.id, "new:effect")];
      expect(() => runAnalysis(repository, observed)).toThrow(
        "non-observation",
      );
    },
  );

  it.each([
    ["explicit_user_statement", "reported", true],
    ["direct_observation", "observed", true],
    ["inference", "inferred", true],
    [undefined, "inferred", true],
    ["inference", "reported", false],
    [undefined, "reported", false],
    ["explicit_user_statement", "observed", false],
    ["direct_observation", "reported", false],
  ] as const)(
    "retains %s recollection scope for %s claims (allowed=%s)",
    (basis, claimBasis, allowed) => {
      const { repository } = fixture();
      const source = recalledSource(repository, {
        recollection: {
          historyStatus: "current",
          type: "event",
          current: true,
          recordedAt: now,
          ...(basis ? { basis } : {}),
        },
      });
      const output = analysis([source.id]);
      const created = newSituation(source.id);
      created.value.claims[0]!.basis = claimBasis;
      created.value.episodes[0]!.state = "closed";
      created.value.episodes[0]!.endedAt = now;
      output.delta.createSituations = [created];
      if (!allowed) {
        expect(() => runAnalysis(repository, output)).toThrow();
        return;
      }
      expect(runAnalysis(repository, output).status).toBe("ready");
      expect([...repository.pendingMemoryHandoffs()]).toEqual([]);
    },
  );

  it.each(["explicit_user", "fulfilled"] as const)(
    "does not use recalled reports as new %s authorization or completion",
    (kind) => {
      const { repository } = fixture();
      const source = recalledSource(repository);
      const output = analysis([source.id]);
      output.delta.createIntents = [
        {
          localId: "new:work",
          value: {
            owner: kind === "explicit_user" ? "user" : "character",
            basis: kind === "explicit_user" ? "explicit_user" : "character",
            status: kind === "explicit_user" ? "active" : "fulfilled",
            goal: "布置花圃",
            successCriteria: [],
            evidenceIds: [source.id],
            blockers: [],
            resumeConditions: [],
            progress: "",
            effectEvidenceIds: [],
          },
        },
      ];
      expect(() => runAnalysis(repository, output)).toThrow(
        kind === "explicit_user"
          ? "user utterance"
          : "performed effect, user report or completed reply",
      );
    },
  );

  it.each([
    ["current", true],
    ["retained_history", true],
    ["corrected", false],
    ["unresolved", false],
  ] as const)(
    "keeps %s history qualification when an old observation is used as a world fact",
    (historyStatus, allowed) => {
      const { repository } = fixture();
      const source = recalledSource(repository, {
        recollection: {
          type: "event",
          basis: "direct_observation",
          current: historyStatus === "current",
          historyStatus,
          recordedAt: now,
        },
      });
      const output = analysis([source.id]);
      const created = newSituation(source.id);
      created.value.claims[0]!.basis = "observed";
      output.delta.createSituations = [created];
      if (allowed) expect(runAnalysis(repository, output).status).toBe("ready");
      else
        expect(() => runAnalysis(repository, output)).toThrow(
          "non-observation",
        );
    },
  );

  it("keeps separate retrieval-time readings while replaying one attempt idempotently", () => {
    const { repository } = fixture();
    const first = recalledSource(repository);
    const {
      receiptSequence: _sequence,
      receivedAt: _received,
      ...firstInput
    } = first;
    void _sequence;
    void _received;
    const duplicate = repository.ingest(
      { ...firstInput, id: randomUUID() },
      now,
    );
    expect(duplicate.evidence.id).toBe(first.id);
    const later = recalledSource(repository, {
      source: { ...first.source, fragment: randomUUID() },
      recollection: { ...first.recollection!, current: false },
    });
    expect(later.id).not.toBe(first.id);
    expect(later.recollection?.current).toBe(false);
    expect(first.recollection?.recordedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(later.observedAt).toBe(now);
    expect(repository.getAttention(personaId, now).userGeneration).toBe(0);
  });

  it.each([
    "object",
    "actor",
    "missing_metadata",
    "wrong_kind",
    "unknown_attempt",
  ] as const)(
    "rejects inconsistent recollection %s without creating a world event",
    (invalid) => {
      const { repository } = fixture();
      const source = recalledSource(repository);
      const {
        receiptSequence: _sequence,
        receivedAt: _received,
        ...input
      } = source;
      void _sequence;
      void _received;
      const changed: CognitionEvidenceInput = { ...input, id: randomUUID() };
      if (invalid === "object")
        changed.object = { key: "screen", identity: "adapter" };
      if (invalid === "actor") changed.actor = "user";
      if (invalid === "missing_metadata") delete changed.recollection;
      if (invalid === "wrong_kind") changed.kind = "utterance";
      if (invalid === "unknown_attempt")
        changed.source = { ...changed.source, fragment: randomUUID() };
      expect(() => repository.ingest(changed, now)).toThrow(
        /Recollection|recollection/,
      );
    },
  );

  it.each(["history", "current_recollection"] as const)(
    "binds exact %s memory pairs and rejects a missing reading",
    (use) => {
      const { repository, database } = fixture();
      const source = recalledSource(repository);
      const output = analysis([source.id]);
      output.decision.selectedBasis.evidenceUses = [
        { evidenceId: source.id, use },
      ];
      const attempt = runAnalysis(repository, output);
      expect(attempt.actionReadSet?.currentObjects).toEqual([]);
      expect(repository.actionRecollectionRequest(attempt).references).toEqual([
        {
          memoryId: source.source.id,
          revisionId: source.source.revision,
          use: use === "history" ? "history" : "current",
        },
      ]);
      expect(repository.actionFreshness(attempt, now)).toEqual({
        current: true,
      });
      database
        .prepare("DELETE FROM cognition_evidence WHERE id = ?")
        .run(source.id);
      expect(repository.actionFreshness(attempt, now)).toEqual({
        current: false,
        reason: "source_missing",
        referenceId: source.id,
      });
    },
  );

  it("rejects current recollection declarations for an explicitly historical reading", () => {
    const { repository } = fixture();
    const source = recalledSource(repository, {
      recollection: {
        type: "event",
        current: false,
        historyStatus: "retained_history",
        recordedAt: now,
      },
    });
    const output = analysis([source.id]);
    output.decision.selectedBasis.evidenceUses = [
      { evidenceId: source.id, use: "current_recollection" },
    ];
    expect(() => runAnalysis(repository, output)).toThrow(
      "current memory reading",
    );
  });

  it("requires the selected current claim's actual support and contradiction without adding historical lineage", () => {
    const { repository } = fixture();
    const source = repository.ingest(observation("材料A"), now).evidence;
    const correction = repository.ingest(
      observation("其实是材料B"),
      now,
    ).evidence;
    const output = analysis([source.id]);
    const created = newSituation(source.id);
    created.value.claims[0]!.contradictingEvidenceIds = [correction.id];
    output.delta.createSituations = [created];
    output.decision.selectedBasis.currentClaimRefs = [
      { situationId: created.localId, claimId: "visible-material" },
    ];
    expect(() => runAnalysis(repository, output)).toThrow(
      "all support and contradiction",
    );
    const failedId = repository.getSnapshot(personaId, now).recentAttempts[0]!
      .id;
    const failed = repository.getAttempt(failedId)!;
    repository.saveAttempt({ ...failed, status: "failed", outcome: "failed" });
    output.decision.choices[0]!.evidenceIds.push(correction.id);
    output.decision.selectedBasis.evidenceUses.push({
      evidenceId: correction.id,
      use: "history",
    });
    const attempt = runAnalysis(repository, output);
    expect(
      repository.readActionContext(attempt, 10_000, (value) => value).text,
    ).toContain("材料B");
  });

  it("projects only declared material even when the same current situation contains unrelated claims and a large source", () => {
    const { repository } = fixture(200_000);
    const selected = repository.ingest(observation("所选原文"), now).evidence;
    const background = repository.ingest(
      observation("不应进入执行材料"),
      now,
    ).evidence;
    const output = analysis([selected.id]);
    const created = newSituation(selected.id);
    created.value.title = "未绑定情境标题";
    created.value.summary = "未绑定情境摘要";
    created.value.claims.push({
      ...created.value.claims[0]!,
      id: "background",
      text: "未选择的用户画像",
      evidenceIds: [background.id],
    });
    output.delta.createSituations = [created];
    output.decision.choices[0]!.situationId = created.localId;
    output.decision.selectedBasis.currentClaimRefs = [
      { situationId: created.localId, claimId: "visible-material" },
    ];
    const attempt = runAnalysis(repository, output);
    const context = repository.readActionContext(
      attempt,
      10_000,
      (value) => value,
    );
    expect(context.decisionAttemptId).toBe(attempt.id);
    expect(context.evidenceIds).toEqual([selected.id]);
    expect(context.text).toContain("所选原文");
    for (const hidden of [
      "未绑定情境标题",
      "未绑定情境摘要",
      "未选择的用户画像",
      "不应进入执行材料",
    ])
      expect(context.text).not.toContain(hidden);
    expect(() =>
      repository.readActionContext(attempt, 100, (value) => value),
    ).toThrow(/allocation/);
  });

  it("keeps the complete Memory-resolution callback inside the same read transaction", () => {
    const { repository, database } = fixture();
    const source = repository.ingest(
      observation("selected transaction source"),
      now,
    ).evidence;
    const attempt = runAnalysis(repository, analysis([source.id]));
    const complete = vi.fn(
      (context: CognitionPreparedContext, remainingReadBytes: number) => {
        expect(database.inTransaction).toBe(true);
        expect(context.evidenceIds).toEqual([source.id]);
        expect(remainingReadBytes).toBeGreaterThan(0);
        expect(remainingReadBytes).toBeLessThan(10_000);
        throw new Error("Required Memory revision became unavailable");
      },
    );
    expect(() =>
      repository.readActionContext(attempt, 10_000, complete),
    ).toThrow("Required Memory revision became unavailable");
    expect(complete).toHaveBeenCalledOnce();
    expect(database.inTransaction).toBe(false);
    expect(repository.getAttempt(attempt.id)?.runId).toBeUndefined();
  });

  it.each([
    "plain ASCII words",
    "中文，保留限定",
    "emoji 👩🏽‍💻",
    'quote " and \n newline',
    "lone \ud800 surrogate",
  ])(
    "preserves the complete selected payload at its read-byte boundary: %s",
    (text) => {
      const { repository, database } = fixture();
      const source = repository.ingest(
        observation(text.repeat(12)),
        now,
      ).evidence;
      const attempt = runAnalysis(repository, analysis([source.id]));
      const full = repository.readActionContext(
        attempt,
        8192,
        (value) => value,
      );
      const materialized = materializeCognitionContextInput(
        createCognitionContextInput(full),
      );
      const budget = (
        database
          .prepare(
            "SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM cognition_evidence WHERE id=?",
          )
          .get(source.id) as { bytes: number }
      ).bytes;
      expect(
        repository.readActionContext(attempt, budget, (value) => value),
      ).toEqual(full);
      expect(() =>
        repository.readActionContext(attempt, budget - 1, (value) => value),
      ).toThrow("read allocation");
      expect(
        Buffer.byteLength(JSON.stringify(materialized), "utf8"),
      ).toBeGreaterThan(budget);
    },
  );

  it("rejects a previously selected original after actual review and body reclamation", () => {
    const { repository } = fixture();
    const source = repository.ingest(
      observation("此前选中的旧稿"),
      now,
    ).evidence;
    const original = runAnalysis(repository, analysis([source.id]));
    repository.saveAttempt({
      ...original,
      status: "settled",
      outcome: "quiet",
    });
    repository.ingest(observation("当前已经替换为新稿"), now);
    const reviewed = runAnalysis(repository, analysis());
    repository.saveAttempt({
      ...reviewed,
      status: "settled",
      outcome: "quiet",
    });
    expect(repository.releaseEvidenceBody(source.id, now)).toBeDefined();
    expect(repository.evidenceBodyStatus(personaId, source.id)).toBe(
      "released",
    );
    const complete = vi.fn((context: CognitionPreparedContext) => context);
    expect(() =>
      repository.readActionContext(original, 10_000, complete),
    ).toThrow("Required selected evidence body was released");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not materialize an oversized selected source or execute from its excerpt", () => {
    const { repository, database } = fixture();
    const source = repository.ingest(observation("原始短句"), now).evidence;
    const attempt = runAnalysis(repository, analysis([source.id]));
    // A large source is placed directly in this SQL fixture after the bounded model step.
    database
      .prepare(
        "UPDATE cognition_evidence SET payload_json=json_set(payload_json,'$.text',?) WHERE id=?",
      )
      .run("完整源".repeat(500_000), source.id);
    expect(() =>
      repository.readActionContext(attempt, 4096, (value) => value),
    ).toThrow(/Complete required material was not loaded/);
  });
});

describe("selected context through the real Cognition service", () => {
  it.each([false, true])(
    "dispatches only the selected Memory Pack and attempt identity (required source unavailable=%s)",
    (unavailable) => {
      const memoryId = randomUUID();
      const item: EvidencePack["items"][number] = {
        memoryId,
        revisionId: randomUUID(),
        type: "event",
        content: "这份材料属于朋友",
        historyStatus: "current",
        basis: "explicit_user_statement",
        owner: "user",
        recordedAt: "2026-08-01T00:00:00.000Z",
        current: true,
        entityIds: [],
        sourceRefs: [],
        questionIds: ["owner"],
      };
      const pack: EvidencePack = {
        items: [item],
        coverage: [
          {
            questionId: "owner",
            status: "supported",
            revisionIds: [item.revisionId],
          },
        ],
        gaps: [],
        estimatedTokens: 100,
        truncated: false,
        incompleteReasons: [],
      };
      const actual = observation("帮我看看这里", { chatId: randomUUID() });
      const driver = {
        analyze: vi.fn((input: CognitionAnalysisInput) => {
          const reading = input.snapshot.evidence.find(
            (source) => source.kind === "recollection",
          );
          const output = analysis(
            reading ? [actual.id, reading.id] : [actual.id],
          );
          if (!reading)
            output.recallPlan = {
              purpose: "initiative",
              query: "材料归属",
              questions: [{ id: "owner", text: "材料是谁的" }],
              contextBudget: { maxTokens: 1000 },
            };
          else {
            output.decision.choices[0] = {
              ...output.decision.choices[0]!,
              kind: "clarify",
              chatId: actual.chatId!,
              executionScope: "conversation",
              instruction: "根据材料归属问一个具体问题",
            };
            output.decision.selectedBasis.evidenceUses = [
              { evidenceId: actual.id, use: "history" },
              { evidenceId: reading.id, use: "current_recollection" },
            ];
          }
          return Promise.resolve(output);
        }),
      };
      const h = serviceFixture(driver, pack);
      if (unavailable)
        h.memory.resolveEvidence.mockReturnValue({
          status: "unavailable",
          unavailable: [
            { memoryId, revisionId: item.revisionId, use: "current" },
          ],
        });
      h.service.ingest(actual);
      return h.service.runDue("2026-09-15T08:01:00.000Z").then(async () => {
        expect(driver.analyze).toHaveBeenCalledTimes(2);
        if (unavailable) {
          // Dispatch asks for the actual allocation before allocating any Run.
          expect(h.runtime.dispatch).toHaveBeenCalledOnce();
          expect(h.errors).toHaveLength(1);
          expect(
            h.repository.getSnapshot(personaId, now).recentAttempts[0]?.status,
          ).toBe("failed");
          await h.service.runDue("2026-09-15T09:00:00.000Z");
          expect(driver.analyze).toHaveBeenCalledTimes(2);
          return;
        }
        expect(h.errors).toEqual([]);
        expect(h.runtime.dispatch).toHaveBeenCalledOnce();
        const request = h.runtime.dispatch.mock.calls[0]![0];
        const context = request.prepareContext({
          maxReadBytes: 10_000,
          signal: new AbortController().signal,
        });
        expect(context.decisionAttemptId).toBe(request.attemptId);
        expect(context.evidencePack?.items).toEqual(pack.items);
        expect(context.evidencePack?.coverage).toEqual(pack.coverage);
        expect(context.text).toContain(actual.text);
        expect(context.text).not.toContain(item.content);
        expect(context.recallPlan?.questions).toEqual([
          { id: "owner", text: "材料是谁的" },
        ]);
        expect(h.memory.recall).toHaveBeenCalledOnce();
      });
    },
  );
});

describe("selected Intent body allocation", () => {
  it.each(["missing", "oversized"] as const)(
    "loads only the selected Intent and fails if it becomes %s",
    (failure) => {
      const { database, repository } = fixture();
      const chosen = repository.ingest(
        observation("这次选择的来源"),
        now,
      ).evidence;
      const old = repository.ingest(
        observation("未选中的角色旧经历正文"),
        now,
      ).evidence;
      const makeIntent = (goal: string): CognitionIntent => ({
        id: randomUUID(),
        personaId,
        revision: 1,
        owner: "character",
        basis: "character",
        status: "active",
        goal,
        evidenceIds: [old.id],
        successCriteria: [],
        blockers: [],
        resumeConditions: [],
        progress: "尚未开始",
        effectEvidenceIds: [],
        createdAt: now,
        updatedAt: now,
      });
      const selected = makeIntent("这次布置花圃");
      repository.saveIntent(selected);
      repository.saveIntent(makeIntent("未选择的观星计划"));
      const output = analysis([chosen.id]);
      output.decision.choices[0]!.intentId = selected.id;
      const attempt = runAnalysis(repository, output);
      const context = repository.readActionContext(
        attempt,
        10_000,
        (value) => value,
      );
      expect(context.intentIds).toEqual([selected.id]);
      expect(context.text).toContain("这次布置花圃");
      expect(context.text).not.toContain("未选择的观星计划");
      expect(context.text).not.toContain("未选中的角色旧经历正文");
      if (failure === "missing")
        database
          .prepare("DELETE FROM cognition_intents WHERE id = ?")
          .run(selected.id);
      else
        database
          .prepare(
            "UPDATE cognition_intents SET payload_json=json_set(payload_json,'$.progress',?) WHERE id=?",
          )
          .run("长篇角色经历".repeat(400_000), selected.id);
      expect(() =>
        repository.readActionContext(attempt, 10_000, (value) => value),
      ).toThrow(/Selected action|selected intent/);
    },
  );
});

describe("Life planning completion boundary", () => {
  it("cannot manufacture fulfilled status or completion through the direct planning port", () => {
    const { service, repository } = serviceFixture({
      analyze: () => Promise.resolve(analysis([])),
    });
    const intent: CognitionIntent = {
      id: randomUUID(),
      personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "照看花园",
      successCriteria: [],
      evidenceIds: [],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "计划",
      createdAt: now,
      updatedAt: now,
    };
    expect(() =>
      service.saveCharacterIntent({ ...intent, status: "fulfilled" }),
    ).toThrow("Life planning does not create completion receipts");
    expect(() =>
      service.saveCharacterIntent({
        ...intent,
        completion: {
          evidenceUses: [
            { evidenceId: randomUUID(), basis: "performed_effect" },
          ],
        },
      }),
    ).toThrow("Life planning does not create completion receipts");
    expect(repository.getIntent(intent.id)).toBeUndefined();
    expect(service.saveCharacterIntent(intent).status).toBe("active");
  });
});
