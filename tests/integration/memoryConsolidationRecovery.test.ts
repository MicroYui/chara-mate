import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formationIntake } from "../fixtures/memoryFormation";
import { chatFixture, runFixture } from "../fixtures/foundationContracts";
import { memoryConsolidationProcessorVersion } from "../../src/main/app/memoryConsolidationRuntime";
import { memoryModelRecovery } from "../../src/main/app/memoryFormationRuntime";
import { RunRepository } from "../../src/main/agent/runRepository";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import {
  ModelMemoryConsolidation,
  type MemoryConsolidationModel,
  type MemoryConsolidationRuntime,
} from "../../src/main/memory/memoryConsolidation";
import { fitMemoryEvidence } from "../../src/main/memory/memoryRecallPipeline";
import type { ModelProvider } from "../../src/main/agent/modelProvider";
import {
  estimateInputBudget,
  INPUT_BUDGET_ESTIMATE_RATIO,
} from "../../src/main/providers/inputBudget";
import { MEMORY_CONSOLIDATION_VERSION } from "../../src/main/memory/memoryLearningRepository";
import { MemoryMaintenance } from "../../src/main/memory/memoryMaintenance";
import type { MemoryEvidenceSelector } from "../../src/main/memory/memoryModels";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import {
  MemoryService,
  type MemoryProviderRecovery,
} from "../../src/main/memory/memoryService";
import { searchMemoryVectors } from "../../src/main/memory/memoryVectorSearch";
import {
  ProviderError,
  type ProviderErrorCode,
  type ProviderRequestIdentity,
} from "../../src/main/providers/providerError";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const identity: ProviderRequestIdentity = {
  profileId: "profile-a",
  apiStyle: "openai-compatible",
  modelId: "model-a",
};
const version = "processing-v2:profile-a:openai-compatible:model-a";
const clock = { now: () => "2026-09-16T11:00:00.000Z" };
const retain = () =>
  Promise.resolve({
    disposition: "retain_originals" as const,
    reason: "保留各段原始事件，无需改写",
    dependencies: [],
    citations: [],
  });
function recovery(
  consolidationProcessorVersion = version,
  requestIdentity = identity,
): MemoryProviderRecovery {
  return {
    formationProcessorVersion: "formation-fixture",
    consolidationProcessorVersion,
    requestIdentity,
  };
}
function disk() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "consolidation-recovery-"),
  );
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "app.sqlite");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function open(file: string, processorVersion = version) {
  const database = openApplicationDatabase(file);
  cleanups.push(() => {
    if (database.open) database.close();
  });
  const repository = new MemoryRepository(database);
  const consolidate = vi.fn<MemoryConsolidationModel["consolidate"]>(retain);
  const measureInput = vi.fn<MemoryConsolidationModel["measureInput"]>(
    (input) =>
      Promise.resolve({
        measurement: estimateInputBudget(input),
        budget: 258000,
      }),
  );
  const boundModel: MemoryConsolidationModel = {
    version: processorVersion,
    measureInput,
    consolidate,
  };
  const bind = vi.fn<MemoryConsolidationRuntime["bind"]>(() =>
    Promise.resolve(boundModel),
  );
  const model: MemoryConsolidationRuntime = { version: processorVersion, bind };
  const select = vi.fn<MemoryEvidenceSelector["select"]>(
    ({ plan, candidates }) =>
      Promise.resolve({
        selected: candidates.map(({ revisionId }) => ({
          revisionId,
          questionIds: plan.questions.map(({ id }) => id),
        })),
        coverage: plan.questions.map(({ id }) => ({
          questionId: id,
          status: "supported",
          revisionIds: candidates.map(({ revisionId }) => revisionId),
        })),
      }),
  );
  const recallBudget = { maxTokens: 12000 };
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(database, repository, clock),
    new CryptoIdGenerator(),
    clock,
    {
      formation: formationRuntime({
        version: "formation-fixture",
        form: ({ episode }) =>
          Promise.resolve({
            entities: [],
            units: episode.sources
              .filter((source) => episode.evidenceSourceIds.includes(source.id))
              .flatMap((source) =>
                source.content.split("；").map((content) => ({
                  operation: "create",
                  content,
                  type: "event",
                  entityKeys: [],
                  links: [],
                  semantics: {
                    kind: "episode",
                    owner: "user",
                    basis: "explicit_user_statement",
                    qualifiers: {},
                  },
                  citations: [{ sourceId: source.id, quote: content }],
                })),
              ),
          }),
      }),
      consolidation: model,
      formationResourceBudget,
      formationContextBudget: () => recallBudget,
      embedding: {
        modelKey: "recovery-numeric-fixture",
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
  const onError = vi.fn();
  const maintenance = new MemoryMaintenance(memory, { onError });
  const seed = async (content = "周末想整理照片；那张照片仍夹在蓝色相册里") => {
    const intake = formationIntake({
      id: randomUUID(),
      version: "v1",
      recordedAt: clock.now(),
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content,
          occurredAt: clock.now(),
        },
      ],
    });
    const work = memory.enqueueEpisode(intake);
    const result = await memory.formEpisode(work.workId);
    await memory.indexPending();
    return result;
  };
  const rows = () =>
    database
      .prepare(
        "SELECT id,subject_id AS subjectId,source_version AS sourceVersion,processor_version AS processorVersion,status,attempt,error_code AS errorCode,result_json AS result FROM memory_work WHERE kind='reconcile' ORDER BY id",
      )
      .all() as {
      id: string;
      subjectId: string;
      sourceVersion: string;
      processorVersion: string;
      status: string;
      attempt: number;
      errorCode: string | null;
      result: string | null;
    }[];
  return {
    database,
    repository,
    model,
    memory,
    maintenance,
    consolidate,
    measureInput,
    bind,
    boundModel,
    recallBudget,
    onError,
    select,
    seed,
    rows,
  };
}

describe("durable consolidation recovery", () => {
  it("recovers reconcile work through an actual committed Run response and does not replay its event", async () => {
    const actualIdentity: ProviderRequestIdentity = {
      profileId: runFixture.provider.profileId,
      apiStyle: runFixture.provider.apiStyle,
      modelId: runFixture.provider.modelId,
    };
    const f = open(
      disk(),
      memoryConsolidationProcessorVersion(runFixture.provider),
    );
    await f.seed();
    f.consolidate.mockRejectedValue(
      new ProviderError(
        "PROVIDER.UNREACHABLE",
        "actual attempt offline",
        true,
        actualIdentity,
      ),
    );
    await f.memory.consolidatePending(undefined, vi.fn());
    f.maintenance.start();
    await f.maintenance.idle();
    expect(f.consolidate).toHaveBeenCalledTimes(2);
    expect(f.rows().every(({ status }) => status === "failed")).toBe(true);
    f.consolidate.mockImplementation(retain);
    const runs = new RunRepository(f.database);
    new ChatRepository(f.database).insertChat(chatFixture);
    const recovered: MemoryProviderRecovery[] = [];
    const events = new RunEventService(runs, {
      publish(envelope) {
        const event = memoryModelRecovery(envelope, runs, false);
        if (event) {
          recovered.push(event);
          f.maintenance.recoverProviderFailures(event);
        }
      },
    });
    const writer = new RunEventWriter(
      runs,
      events,
      new CryptoIdGenerator(),
      clock,
    );
    const run = { ...runFixture, id: randomUUID() };
    writer.startRun(run);
    const item = writer.startItem(run.id, "assistant_message");
    writer.completeItem(item.id, {
      status: "completed",
      output: { responseId: "actual-test-model-response" },
    });
    await f.maintenance.idle();
    expect(recovered).toHaveLength(1);
    expect(
      f
        .rows()
        .every(({ status, attempt }) => status === "complete" && attempt === 2),
    ).toBe(true);
    expect(f.consolidate).toHaveBeenCalledTimes(4);
    events.replay({ streamId: run.id, afterSequence: 0 });
    const later = writer.startItem(run.id, "assistant_message");
    writer.completeItem(later.id, {
      status: "completed",
      output: { responseId: "later-test-model-response" },
    });
    await f.maintenance.idle();
    expect(recovered).toHaveLength(1);
    expect(f.consolidate).toHaveBeenCalledTimes(4);
    expect(f.repository.listRecords({})).toHaveLength(2);
    await f.maintenance.shutdown();
  });

  it("accepts the persisted pre-recovery failure shape through version readiness without guessing its message", async () => {
    const file = disk();
    const prior = open(file);
    await prior.seed();
    prior.select.mockRejectedValue(new Error("Provider 连接失败"));
    await prior.memory.consolidatePending(undefined, vi.fn());
    // v14 stored only the human message in error_code and left result_json null.
    // Reproduce that persisted shape; this is not a rerun of its old model.
    prior.database
      .prepare(
        "UPDATE memory_work SET processor_version=?,error_code=?,result_json=NULL WHERE kind='reconcile' AND status='failed'",
      )
      .run(
        MEMORY_CONSOLIDATION_VERSION,
        "Provider 连接失败 sk-1234567890abcdef",
      );
    const oldRows = prior.rows();
    prior.database.close();
    const current = open(file);
    expect(current.memory.recoverProviderFailures(recovery())).toBe(0);
    expect(current.rows()).toEqual(oldRows);
    current.memory.recoverInterruptedWork();
    await current.memory.consolidatePending();
    for (const row of current.rows()) {
      expect(row).toMatchObject({
        status: "complete",
        attempt: 2,
        processorVersion: version,
      });
      expect(row.result).not.toContain("sk-1234567890abcdef");
      expect(JSON.parse(row.result!)).toMatchObject({
        processorTransitions: [
          {
            fromProcessorVersion: MEMORY_CONSOLIDATION_VERSION,
            toProcessorVersion: version,
            priorAttempt: 1,
            priorErrorCode: "Provider 连接失败 [REDACTED]",
          },
        ],
      });
    }
    expect(current.repository.listRecords({})).toHaveLength(2);
  });

  it("reopens failed work under a new actual processor once and preserves its failure and transition", async () => {
    const file = disk();
    const prior = open(file, "old-processor");
    await prior.seed();
    prior.consolidate.mockRejectedValue(
      new TypeError("dependency quote is missing"),
    );
    await prior.memory.consolidatePending(undefined, vi.fn());
    const oldRows = prior.rows();
    expect(oldRows.every((row) => row.status === "failed")).toBe(true);
    prior.database.close();

    const current = open(file);
    current.memory.recoverInterruptedWork();
    expect(
      current.rows().map(({ id, attempt, errorCode, status }) => ({
        id,
        attempt,
        errorCode,
        status,
      })),
    ).toEqual(
      oldRows.map(({ id, attempt, errorCode }) => ({
        id,
        attempt,
        errorCode,
        status: "pending",
      })),
    );
    current.consolidate.mockRejectedValue(new TypeError("still unsupported"));
    await current.memory.consolidatePending(undefined, vi.fn());
    for (const row of current.rows()) {
      expect(row).toMatchObject({
        processorVersion: version,
        attempt: 2,
        status: "failed",
        errorCode: "consolidation_validation_failed",
      });
      expect(JSON.parse(row.result!)).toMatchObject({
        processorTransitions: [
          {
            fromProcessorVersion: "old-processor",
            toProcessorVersion: version,
            priorAttempt: 1,
            priorErrorCode: "consolidation_validation_failed",
          },
        ],
        lastFailure: { message: "still unsupported", attempt: 2 },
      });
    }
    current.database.close();
    const restarted = open(file);
    restarted.maintenance.start();
    await restarted.maintenance.idle();
    expect(restarted.consolidate).not.toHaveBeenCalled();
    expect(
      restarted.rows().map(({ attempt, status }) => ({ attempt, status })),
    ).toEqual([
      { attempt: 2, status: "failed" },
      { attempt: 2, status: "failed" },
    ]);
    await restarted.maintenance.shutdown();
    restarted.database.close();
    const upgradedAgain = open(file, "processing-v3");
    upgradedAgain.memory.recoverInterruptedWork();
    await upgradedAgain.memory.consolidatePending();
    for (const row of upgradedAgain.rows()) {
      expect(row).toMatchObject({
        processorVersion: "processing-v3",
        attempt: 3,
        status: "complete",
        errorCode: null,
      });
      const result = JSON.parse(row.result!) as {
        processorTransitions: unknown[];
        lastFailure: unknown;
      };
      expect(result.processorTransitions).toHaveLength(2);
      expect(result.processorTransitions[1]).toMatchObject({
        fromProcessorVersion: version,
        toProcessorVersion: "processing-v3",
        priorAttempt: 2,
        priorErrorCode: "consolidation_validation_failed",
      });
      expect(result.lastFailure).toMatchObject({
        attempt: 2,
        message: "still unsupported",
      });
    }
  });

  it("checks the actual model execution version before any request and preserves a Provider failure", async () => {
    const f = open(disk());
    await f.seed();
    await f.memory.consolidatePending();
    const input = f.consolidate.mock.calls[0]![0];
    const failure = new ProviderError(
      "PROVIDER.TIMEOUT",
      "actual model failed",
      true,
      identity,
    );
    const stream = vi.fn<ModelProvider["stream"]>(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    }));
    const provider: ModelProvider = {
      stream,
      measureInput(
        request: Parameters<ModelProvider["estimateInput"]>[0],
        signal: AbortSignal,
      ) {
        signal.throwIfAborted();
        return Promise.resolve(this.estimateInput(request));
      },
      estimateInput: (request) => estimateInputBudget(request, request.modelId),
      resolveContextLimits: () => Promise.resolve({}),
    };
    const model = new ModelMemoryConsolidation(provider, identity.modelId, {});
    await expect(
      model.consolidate(
        input,
        {
          expectedProcessorVersion: "wrong-runtime",
          assertInputCurrent: () => undefined,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("expected processor");
    expect(stream).not.toHaveBeenCalled();
    await expect(
      model.consolidate(
        input,
        {
          expectedProcessorVersion: model.version,
          assertInputCurrent: () => undefined,
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]![0].modelId).toBe(identity.modelId);
  });

  it.each([
    ["PROVIDER.TIMEOUT", true],
    ["PROVIDER.UNREACHABLE", true],
    ["PROVIDER.RATE_LIMITED", true],
    ["PROVIDER.UNAVAILABLE", true],
    ["PROVIDER.AUTHENTICATION_FAILED", false],
    ["PROVIDER.CONTEXT_LIMIT_EXCEEDED", false],
    ["PROVIDER.REQUEST_FAILED", false],
  ] satisfies [ProviderErrorCode, boolean][])(
    "preserves %s and only consumes the event for matching failed work",
    async (code, recoverable) => {
      const f = open(disk());
      await f.seed();
      f.consolidate.mockRejectedValue(
        new ProviderError(code, "same human-readable text", true, identity),
      );
      await f.memory.consolidatePending(undefined, vi.fn());
      expect(f.rows().every((row) => row.errorCode === code)).toBe(true);
      expect(JSON.parse(f.rows()[0]!.result!)).toMatchObject({
        lastFailure: { requestIdentity: identity },
      });
      const wake = vi.spyOn(f.maintenance, "wake");
      f.maintenance.recoverProviderFailures(recovery());
      expect(
        f
          .rows()
          .every((row) => row.status === (recoverable ? "pending" : "failed")),
      ).toBe(true);
      f.maintenance.recoverProviderFailures(recovery());
      expect(wake).toHaveBeenCalledTimes(recoverable ? 1 : 0);
      if (recoverable) {
        await f.memory.consolidatePending(undefined, vi.fn());
        await f.memory.consolidatePending(undefined, vi.fn());
        expect(
          f.rows().every((row) => row.attempt === 2 && row.status === "failed"),
        ).toBe(true);
        expect(f.consolidate).toHaveBeenCalledTimes(4);
      }
    },
  );

  it("does not infer missing identity or confuse a shared selector's actual profile/model with its caller", async () => {
    for (const failureIdentity of [
      undefined,
      { ...identity, profileId: "other-profile" },
      { ...identity, modelId: "other-model" },
      { ...identity, apiStyle: "azure-openai" as const },
    ]) {
      const f = open(disk());
      await f.seed();
      f.select.mockRejectedValue(
        new ProviderError(
          "PROVIDER.TIMEOUT",
          "selector connection failed",
          true,
          failureIdentity,
        ),
      );
      await f.memory.consolidatePending(undefined, vi.fn());
      expect(f.select).toHaveBeenCalledOnce();
      expect(f.consolidate).not.toHaveBeenCalled();
      expect(f.rows().every((row) => row.status === "failed")).toBe(true);
      expect(f.memory.recoverProviderFailures(recovery())).toBe(0);
      expect(
        f.memory.recoverProviderFailures(recovery("different-processor")),
      ).toBe(0);
      expect(f.rows().every((row) => row.status === "failed")).toBe(true);
    }
  });

  it("redacts detected credentials in the durable failure message without changing recovery identity", async () => {
    const f = open(disk());
    await f.seed();
    const fixtureSecret = "sk-1234567890abcdef";
    f.consolidate.mockRejectedValue(
      new ProviderError(
        "PROVIDER.TIMEOUT",
        `Fixture server message contains ${fixtureSecret}`,
        true,
        identity,
      ),
    );
    await f.memory.consolidatePending(undefined, vi.fn());
    for (const row of f.rows()) {
      expect(row.errorCode).toBe("PROVIDER.TIMEOUT");
      expect(row.result).not.toContain(fixtureSecret);
      expect(JSON.parse(row.result!)).toMatchObject({
        lastFailure: { requestIdentity: identity },
      });
    }
    expect(f.memory.recoverProviderFailures(recovery())).toBe(2);
  });

  it("does not bank a successful event while the actual model attempt is still running", async () => {
    const f = open(disk());
    await f.seed();
    const entered = deferred();
    const release = deferred();
    f.consolidate.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new ProviderError(
        "PROVIDER.UNREACHABLE",
        "disconnected afterwards",
        true,
        identity,
      );
    });
    const running = f.memory.consolidatePending(undefined, vi.fn());
    await entered.promise;
    expect(f.memory.recoverProviderFailures(recovery())).toBe(0);
    release.resolve();
    await running;
    await f.memory.consolidatePending(undefined, vi.fn());
    expect(f.consolidate).toHaveBeenCalledTimes(2);
    expect(f.rows().every((row) => row.status === "failed")).toBe(true);
    expect(f.memory.recoverProviderFailures(recovery())).toBe(2);
  });

  it("excludes a replaced source version and preserves completed work through new-processor recovery", async () => {
    const f = open(disk());
    const original = await f.seed();
    f.consolidate.mockRejectedValue(
      new ProviderError("PROVIDER.TIMEOUT", "network", true, identity),
    );
    await f.memory.consolidatePending(undefined, vi.fn());
    const memoryId = original.changes[0]!.memoryId;
    const replaced = f.rows().find((row) => row.subjectId === memoryId)!;
    f.memory.revise({
      memoryId,
      content: "照片现在移到绿色相册。",
      reason: "实际后续变化",
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          createdAt: clock.now(),
        },
      ],
    });
    expect(f.memory.recoverProviderFailures(recovery())).toBe(1);
    expect(f.rows().find(({ id }) => id === replaced.id)).toMatchObject({
      status: "failed",
      attempt: 1,
    });
    f.consolidate.mockImplementation(retain);
    await f.memory.consolidatePending(undefined, vi.fn());
    const completed = f.rows().filter(({ status }) => status === "complete");
    expect(completed.length).toBeGreaterThan(0);
    Object.defineProperty(f.model, "version", {
      value: "processing-v3",
      configurable: true,
    });
    f.memory.recoverInterruptedWork();
    await f.memory.consolidatePending(undefined, vi.fn());
    expect(f.rows().filter(({ status }) => status === "complete")).toEqual(
      completed,
    );
    expect(f.rows().find(({ id }) => id === replaced.id)).toMatchObject({
      status: "failed",
      attempt: 1,
    });
  });

  it("keeps work intact when configuration is unavailable and surfaces an unknown storage error", async () => {
    const f = open(disk(), "prior-version");
    await f.seed();
    f.consolidate.mockRejectedValue(new TypeError("semantic failure"));
    await f.memory.consolidatePending(undefined, vi.fn());
    const before = f.rows();
    Object.defineProperty(f.model, "version", {
      configurable: true,
      get: () => {
        throw new ProviderError(
          "PROVIDER.INVALID_CONFIGURATION",
          "not configured",
          false,
        );
      },
    });
    expect(() => f.memory.recoverInterruptedWork()).not.toThrow();
    expect(await f.memory.consolidatePending()).toBe(0);
    expect(f.memory.recoverProviderFailures(recovery())).toBe(0);
    expect(f.rows()).toEqual(before);
    Object.defineProperty(f.model, "version", {
      configurable: true,
      get: () => {
        throw new Error("SQLite read unavailable");
      },
    });
    expect(() => f.memory.recoverInterruptedWork()).toThrow(
      "SQLite read unavailable",
    );
    expect(f.rows()).toEqual(before);
  });

  it("configuration retry cancels only the unfinished member and keeps the committed derived account valid", async () => {
    const f = open(disk());
    await f.seed();
    const secondEntered = deferred();
    let calls = 0;
    f.consolidate.mockImplementation(async (input, execution, signal) => {
      expect(execution.expectedProcessorVersion).toBe(version);
      if (++calls === 1)
        return {
          disposition: "consolidate",
          reason: "同一相册事件的有界理解",
          content: input.evidence.map(({ content }) => content).join("；"),
          account: "episode_summary",
          dependencies: input.evidence.map(({ revisionId }) => revisionId),
          citations: input.evidence.flatMap((item) =>
            item.sourceRefs.flatMap((source) =>
              (source.spans ?? []).map(({ quote }) => ({
                revisionId: item.revisionId,
                sourceId: source.sourceId,
                quote,
              })),
            ),
          ),
        };
      if (calls === 2) {
        secondEntered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException(
                  "Configuration retry cancelled this attempt",
                  "AbortError",
                ),
              ),
            {
              once: true,
            },
          );
        });
      }
      return retain();
    });
    f.memory.setChangedListener(() => f.maintenance.wake());
    f.maintenance.start();
    await secondEntered.promise;
    const committed = f.rows().find(({ status }) => status === "complete")!;
    expect(committed).toBeDefined();
    const summary = f.database
      .prepare(
        "SELECT revision_id AS revisionId FROM memory_revision_semantics WHERE kind='reflection'",
      )
      .get() as { revisionId: string };
    expect(
      f.repository.recall.evidence([summary.revisionId], clock.now())[0]
        ?.semantics?.qualifiers["consolidationVersion"],
    ).toBe(MEMORY_CONSOLIDATION_VERSION);
    f.maintenance.retry();
    await f.maintenance.idle();
    expect(f.rows().find(({ id }) => id === committed.id)).toEqual(committed);
    expect(
      f
        .rows()
        .map(({ status, attempt }) => ({ status, attempt }))
        .sort((a, b) => a.attempt - b.attempt),
    ).toEqual([
      { status: "complete", attempt: 1 },
      { status: "complete", attempt: 2 },
    ]);
    expect(f.consolidate).toHaveBeenCalledTimes(3);
    Object.defineProperty(f.model, "version", {
      value: "processing-v3",
      configurable: true,
    });
    f.memory.recoverInterruptedWork();
    expect(
      f.repository.recall.evidence([summary.revisionId], clock.now())[0]
        ?.revisionId,
    ).toBe(summary.revisionId);
    expect(
      f.memory.validateEvidenceReferences({
        personaId: "user-memory-read",
        references: [
          {
            memoryId: f.repository.recall.evidence(
              [summary.revisionId],
              clock.now(),
            )[0]!.memoryId,
            revisionId: summary.revisionId,
            use: "current",
          },
        ],
        usage: "grounding",
      }),
    ).toEqual([]);
    await f.maintenance.shutdown();
  });
});

function grounded(
  input: Parameters<MemoryConsolidationModel["consolidate"]>[0],
  suffix: string,
) {
  return {
    disposition: "consolidate" as const,
    reason: "保留真实来源及尚未完成条件",
    content: `${input.evidence.map(({ content }) => content).join("；")}（${suffix}）`,
    account: "episode_summary" as const,
    dependencies: input.evidence.map(({ revisionId }) => revisionId),
    citations: input.evidence.flatMap((item) =>
      item.sourceRefs.flatMap((source) =>
        (source.spans ?? []).map(({ quote }) => ({
          revisionId: item.revisionId,
          sourceId: source.sourceId,
          quote,
        })),
      ),
    ),
  };
}

function addSupport(f: ReturnType<typeof open>, revisionId: string) {
  const source = {
    id: randomUUID(),
    referenceId: randomUUID(),
    type: "chat" as const,
    createdAt: clock.now(),
  };
  f.repository.attachEvidence(revisionId, [source]);
  f.repository.recall.addSpan(
    revisionId,
    source.id,
    0,
    "新的真实支持".length,
    "新的真实支持",
  );
  return source.id;
}

// The clock deliberately does not advance: a deferred member cannot depend on
// updated_at becoming larger than the cohort cursor in order to run only once.
describe("consolidation input changes through the actual maintenance owner", () => {
  it.each(["support", "quotes", "target"] as const)(
    "discards an obsolete %s output, then finishes the same member with fresh input",
    async (change) => {
      const f = open(disk());
      await f.seed();
      const entered = deferred();
      const release = deferred();
      const drain = vi.spyOn(f.memory, "consolidatePending");
      let calls = 0;
      let interruptedInput:
        Parameters<MemoryConsolidationModel["consolidate"]>[0] | undefined;
      f.consolidate.mockImplementation(async (input) => {
        calls += 1;
        if (calls === 2) {
          interruptedInput = input;
          entered.resolve();
          await release.promise;
          return grounded(input, "obsolete second output");
        }
        if (calls > 2) {
          expect(drain.mock.calls.length).toBeGreaterThan(1);
          if (change === "support")
            expect(input.evidence.some((item) => item.sourceCount === 2)).toBe(
              true,
            );
          return change === "support"
            ? grounded(input, "fresh source state")
            : retain();
        }
        return grounded(input, "first committed member");
      });
      f.memory.setChangedListener(() => f.maintenance.wake());
      f.maintenance.start();
      await entered.promise;
      const committed = f.rows().find(({ status }) => status === "complete")!;
      const running = f.rows().find(({ status }) => status === "running")!;
      expect(committed).toBeDefined();
      const input = interruptedInput!;
      if (change === "support") {
        const parent = input.evidence.find(
          ({ revisionId }) => revisionId !== input.anchorRevisionId,
        )!;
        addSupport(f, parent.revisionId);
      } else if (change === "quotes") {
        const parent = input.evidence[0]!;
        const source = parent.sourceRefs[0]!;
        const span = source.spans![0]!;
        f.database
          .prepare(
            "DELETE FROM memory_revision_source_spans WHERE revision_id=? AND source_id=? AND span_start=? AND span_end=? AND quote=?",
          )
          .run(
            parent.revisionId,
            source.sourceId,
            span.start,
            span.end,
            span.quote,
          );
      } else {
        const target = input.existing!;
        expect(target).toBeDefined();
        f.memory.revise({
          memoryId: target.memoryId,
          content: "人工更正：尚未整理相册",
          reason: "真实更正",
          sources: [],
        });
      }
      release.resolve();
      await f.maintenance.idle();
      const resumed = f.rows().find(({ id }) => id === running.id)!;
      expect(resumed).toMatchObject({ status: "complete", attempt: 2 });
      expect(JSON.parse(resumed.result!)).toMatchObject({
        lastFailure: {
          code: `consolidation_${change === "support" ? "dependencies" : change}_changed`,
          attempt: 1,
        },
      });
      expect(f.rows().find(({ id }) => id === committed.id)).toEqual(committed);
      expect(
        f.database
          .prepare("SELECT 1 FROM memory_revisions WHERE content LIKE ?")
          .get("%obsolete second output%") !== undefined,
      ).toBe(false);
      const beforeWake = f.consolidate.mock.calls.length;
      f.maintenance.wake();
      await f.maintenance.idle();
      expect(f.consolidate).toHaveBeenCalledTimes(beforeWake);
      await f.maintenance.shutdown();
    },
  );

  it.each(["foreground", "restart"] as const)(
    "keeps a deferred member pending across %s and resumes from the real owner",
    async (boundary) => {
      const file = disk();
      const f = open(file);
      await f.seed();
      // Leave exactly one real work pending; the other was intentionally handled.
      const other = f.rows()[1]!;
      const otherAttempt = f.repository.learning.start(
        other.id,
        version,
        clock.now(),
      )!;
      f.repository.learning.complete(
        other.id,
        otherAttempt,
        { disposition: "retain_originals" },
        clock.now(),
      );
      const completed = f.rows().find(({ id }) => id === other.id)!;
      const entered = deferred();
      const release = deferred();
      f.consolidate.mockImplementationOnce(async (input) => {
        entered.resolve();
        await release.promise;
        return grounded(input, "must not commit");
      });
      f.onError.mockImplementation(() =>
        f.maintenance.setForegroundActive(true),
      );
      f.maintenance.start();
      await entered.promise;
      const running = f.rows().find(({ status }) => status === "running")!;
      const input = f.consolidate.mock.calls[0]![0];
      const parent = input.evidence.find(
        ({ revisionId }) => revisionId !== input.anchorRevisionId,
      )!;
      addSupport(f, parent.revisionId);
      release.resolve();
      await f.maintenance.idle();
      expect(f.rows().find(({ id }) => id === running.id)).toMatchObject({
        status: "pending",
        attempt: 1,
      });
      expect(f.consolidate).toHaveBeenCalledTimes(1);
      expect(f.rows().find(({ id }) => id === other.id)).toEqual(completed);
      if (boundary === "foreground") {
        f.onError.mockReset();
        f.maintenance.setForegroundActive(false);
        await f.maintenance.idle();
        expect(f.rows().find(({ id }) => id === running.id)).toMatchObject({
          status: "complete",
          attempt: 2,
        });
        expect(f.consolidate).toHaveBeenCalledTimes(2);
        await f.maintenance.shutdown();
      } else {
        await f.maintenance.shutdown();
        f.database.close();
        const reopened = open(file);
        reopened.maintenance.start();
        await reopened.maintenance.idle();
        expect(
          reopened.rows().find(({ id }) => id === running.id),
        ).toMatchObject({ status: "complete", attempt: 2 });
        expect(reopened.rows().find(({ id }) => id === other.id)).toEqual(
          completed,
        );
        await reopened.maintenance.shutdown();
      }
    },
  );

  it("does not retry a stable invalid model proposal on ordinary wake", async () => {
    const f = open(disk());
    await f.seed();
    f.consolidate.mockImplementation((input) =>
      Promise.resolve({
        ...grounded(input, "invalid"),
        citations: [
          {
            revisionId: input.anchorRevisionId,
            sourceId: "not supplied",
            quote: "invented",
          },
        ],
      }),
    );
    f.maintenance.start();
    await f.maintenance.idle();
    const before = f.rows();
    expect(
      before.every(
        ({ status, errorCode }) =>
          status === "failed" &&
          errorCode === "consolidation_validation_failed",
      ),
    ).toBe(true);
    const calls = f.consolidate.mock.calls.length;
    f.maintenance.wake();
    await f.maintenance.idle();
    expect(f.rows()).toEqual(before);
    expect(f.consolidate).toHaveBeenCalledTimes(calls);
    await f.maintenance.shutdown();
  });
});

describe("stale shared consolidation input", () => {
  it.each(["support", "quotes"] as const)(
    "does not generate from a cached Pack after %s changes between members",
    async (change) => {
      const f = open(disk());
      await f.seed();
      let firstRevision: string | undefined;
      f.consolidate.mockImplementation((input) => {
        if (f.consolidate.mock.calls.length === 1) {
          firstRevision = input.anchorRevisionId;
          return Promise.resolve(
            grounded(input, "committed before source change"),
          );
        }
        expect(f.select.mock.calls.length).toBeGreaterThan(1);
        if (change === "support")
          expect(
            input.evidence.some(({ sourceCount }) => sourceCount === 2),
          ).toBe(true);
        return retain();
      });
      let changed = false;
      f.memory.setChangedListener(() => {
        if (!changed) {
          changed = true;
          if (change === "support") addSupport(f, firstRevision!);
          else
            f.database
              .prepare(
                "DELETE FROM memory_revision_source_spans WHERE revision_id=?",
              )
              .run(firstRevision!);
        }
        f.maintenance.wake();
      });
      f.maintenance.start();
      await f.maintenance.idle();
      const retried = f.rows().find(({ attempt }) => attempt === 2)!;
      expect(retried).toMatchObject({ status: "complete" });
      expect(JSON.parse(retried.result!)).toMatchObject({
        lastFailure: {
          code: `consolidation_${change === "support" ? "dependencies" : "quotes"}_changed`,
        },
      });
      expect(f.consolidate).toHaveBeenCalledTimes(2);
      await f.maintenance.shutdown();
    },
  );

  it("replaces a changed anchor key and never commits its old output", async () => {
    const f = open(disk());
    await f.seed();
    const entered = deferred();
    const release = deferred();
    f.consolidate.mockImplementationOnce(async (input) => {
      entered.resolve();
      await release.promise;
      return grounded(input, "old anchor output");
    });
    f.memory.setChangedListener(() => f.maintenance.wake());
    f.maintenance.start();
    await entered.promise;
    const old = f.rows().find(({ status }) => status === "running")!;
    f.memory.revise({
      memoryId: old.subjectId,
      content: "更正：还没有整理照片",
      reason: "用户真实更正",
      sources: [],
    });
    release.resolve();
    await f.maintenance.idle();
    const original = f.rows().find(({ id }) => id === old.id)!;
    expect(original).toMatchObject({ status: "complete", attempt: 1 });
    expect(JSON.parse(original.result!)).toMatchObject({
      disposition: "source_changed",
      lastFailure: { code: "consolidation_dependencies_changed" },
    });
    const replacement = f
      .rows()
      .find(
        ({ subjectId, id }) => subjectId === old.subjectId && id !== old.id,
      )!;
    expect(replacement).toMatchObject({ status: "complete", attempt: 1 });
    expect(
      f.database
        .prepare("SELECT 1 FROM memory_revisions WHERE content LIKE ?")
        .get("%old anchor output%") !== undefined,
    ).toBe(false);
    await f.maintenance.shutdown();
  });
});

describe("consolidation no-op and initial input boundaries", () => {
  it("does not complete an obsolete retain decision and reruns only that member", async () => {
    const f = open(disk());
    await f.seed();
    const entered = deferred(),
      release = deferred();
    f.consolidate.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return retain();
    });
    f.maintenance.start();
    await entered.promise;
    const old = f.rows().find(({ status }) => status === "running")!;
    const input = f.consolidate.mock.calls[0]![0];
    addSupport(f, input.anchorRevisionId);
    release.resolve();
    await f.maintenance.idle();
    const original = f.rows().find(({ id }) => id === old.id)!;
    expect(JSON.parse(original.result!)).toMatchObject({
      disposition: "source_changed",
      lastFailure: { code: "consolidation_dependencies_changed", attempt: 1 },
    });
    expect(
      f
        .rows()
        .find(
          ({ id, subjectId }) => id !== old.id && subjectId === old.subjectId,
        ),
    ).toMatchObject({ status: "complete", attempt: 1 });
    await f.maintenance.shutdown();
  });

  it("does not give an anchor read before awaited Recall a later receipt version", async () => {
    const f = open(disk());
    await f.seed();
    const entered = deferred(),
      release = deferred();
    const select = f.select.getMockImplementation()!;
    f.select.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return select(...args);
    });
    f.maintenance.start();
    await entered.promise;
    const old = f.rows().find(({ status }) => status === "running")!;
    const originalRevision = f.repository.learning.anchor(
      old.subjectId,
    )!.revisionId;
    addSupport(f, originalRevision);
    release.resolve();
    await f.maintenance.idle();
    const original = f.rows().find(({ id }) => id === old.id)!;
    expect(JSON.parse(original.result!)).toMatchObject({
      disposition: "source_changed",
      lastFailure: { code: "consolidation_dependencies_changed" },
    });
    for (const [input] of f.consolidate.mock.calls)
      expect(
        input.evidence.find(({ revisionId }) => revisionId === originalRevision)
          ?.sourceCount,
      ).toBe(2);
    expect(f.consolidate.mock.calls.length).toBeGreaterThan(0);
    await f.maintenance.shutdown();
  });

  it("fails an initially invalid Pack before generation without retrying it on ordinary wake", async () => {
    const f = open(disk());
    await f.seed();
    // A malformed adapter result is not a database version change. Use the
    // actual Recall and SQLite rows, changing only one returned quote.
    const original = f.repository.recall.evidence.bind(f.repository.recall);
    const read = vi
      .spyOn(f.repository.recall, "evidence")
      .mockImplementation((...args) =>
        original(...args).map((item) => ({
          ...item,
          sourceRefs: item.sourceRefs.map((source) => ({
            ...source,
            ...(source.spans
              ? {
                  spans: source.spans.map((span) => ({
                    ...span,
                    quote: "引用不在真实SQLite中",
                  })),
                }
              : {}),
          })),
        })),
      );
    try {
      f.maintenance.start();
      await f.maintenance.idle();
      const failed = f.rows();
      expect(
        failed.every(
          ({ status, errorCode }) =>
            status === "failed" &&
            errorCode === "consolidation_validation_failed",
        ),
      ).toBe(true);
      expect(f.consolidate).not.toHaveBeenCalled();
      const reads = read.mock.calls.length;
      f.maintenance.wake();
      await f.maintenance.idle();
      expect(f.rows()).toEqual(failed);
      expect(read).toHaveBeenCalledTimes(reads);
      await f.maintenance.shutdown();
    } finally {
      read.mockRestore();
    }
  });
});

// Domain fixtures use real source/span/revision repositories. They establish
// allocation and CAS behavior, not natural model quality or encoder accuracy.
function rawMaterial(
  f: ReturnType<typeof open>,
  content: string,
  validTo?: string,
) {
  const source = {
    id: randomUUID(),
    referenceId: randomUUID(),
    type: "chat" as const,
    createdAt: clock.now(),
  };
  const detail = f.repository.create({
    memoryId: randomUUID(),
    revisionId: randomUUID(),
    type: "event",
    content,
    confidence: 1,
    importance: 0.5,
    reason: "allocation fixture",
    now: clock.now(),
    sources: [source],
  });
  const revisionId = detail.memory.currentRevisionId;
  f.repository.recall.putSemantics(
    revisionId,
    {
      kind: "episode",
      owner: "user",
      basis: "explicit_user_statement",
      qualifiers: {},
      ...(validTo ? { validTo } : {}),
    },
    [],
  );
  f.repository.recall.addSpan(
    revisionId,
    source.id,
    0,
    content.length,
    content,
  );
  return { memoryId: detail.memory.id, revisionId, source, content };
}

function derivedMaterial(
  f: ReturnType<typeof open>,
  parents: ReturnType<typeof rawMaterial>[],
  options: {
    now?: string;
    validFrom?: string;
    validTo?: string;
    use?: "current" | "history";
    uses?: readonly ("current" | "history")[];
    content?: string;
  } = {},
) {
  const detail = f.repository.create({
    memoryId: randomUUID(),
    revisionId: randomUUID(),
    type: "agent_learning",
    content: options.content ?? "保留这两段照片事件的条件。",
    confidence: 0.5,
    importance: 0.5,
    reason: "actual derived fixture",
    now: options.now ?? clock.now(),
    sources: parents.map(({ source }) => source),
  });
  const revisionId = detail.memory.currentRevisionId;
  f.repository.recall.putSemantics(
    revisionId,
    {
      kind: "reflection",
      owner: "user",
      basis: "inference",
      ...(options.validFrom ? { validFrom: options.validFrom } : {}),
      ...(options.validTo ? { validTo: options.validTo } : {}),
      qualifiers: {
        consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
        consolidationDependencyCount: String(parents.length),
        account: "episode_summary",
      },
    },
    [],
  );
  for (const [index, parent] of parents.entries()) {
    f.repository.recall.addSpan(
      revisionId,
      parent.source.id,
      0,
      parent.content.length,
      parent.content,
    );
    f.repository.recall.link(
      revisionId,
      parent.revisionId,
      "derived_from",
      parent.source.id,
      options.uses?.[index] ?? options.use ?? "current",
    );
  }
  return { memoryId: detail.memory.id, revisionId };
}

function keepOnePending(f: ReturnType<typeof open>) {
  const [selected, ...others] = f
    .rows()
    .filter(({ status }) => status === "pending");
  if (!selected) throw new Error("Fixture has no pending member");
  for (const other of others) {
    const attempt = f.repository.learning.start(
      other.id,
      version,
      clock.now(),
    )!;
    f.repository.learning.complete(
      other.id,
      attempt,
      { disposition: "retain_originals" },
      clock.now(),
    );
  }
  return selected;
}

function fitMeasurement(
  input: Parameters<MemoryConsolidationModel["measureInput"]>[0],
) {
  return { measurement: estimateInputBudget(input), budget: 258000 };
}

describe("complete consolidation material allocation", () => {
  it.each([false, true])(
    "preserves a rejected count and defers only a changed non-anchor dependency: changed=%s",
    async (changed) => {
      const f = open(disk());
      await f.seed();
      const work = keepOnePending(f);
      const entered = deferred(),
        release = deferred();
      const failure = new ProviderError(
        "PROVIDER.UNAVAILABLE",
        "count endpoint overloaded",
        true,
        identity,
      );
      f.measureInput.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      });
      const errors = vi.fn();
      const pending = f.memory.consolidatePending(undefined, errors);
      await entered.promise;
      const input = f.measureInput.mock.calls[0]![0];
      if (changed)
        addSupport(
          f,
          input.evidence.find(
            ({ revisionId }) => revisionId !== input.anchorRevisionId,
          )!.revisionId,
        );
      release.resolve();
      await pending;
      expect(f.consolidate).not.toHaveBeenCalled();
      const row = f.rows().find(({ id }) => id === work.id)!;
      expect(row).toMatchObject({
        status: changed ? "pending" : "failed",
        errorCode: changed
          ? "consolidation_dependencies_changed"
          : "PROVIDER.UNAVAILABLE",
      });
      expect(JSON.parse(row.result!)).toMatchObject({
        lastFailure: changed
          ? {
              code: "consolidation_dependencies_changed",
              cause: {
                code: failure.code,
                message: failure.message,
                retryable: true,
                requestIdentity: identity,
              },
            }
          : {
              code: failure.code,
              message: failure.message,
              requestIdentity: identity,
            },
      });
      if (!changed) expect(errors.mock.calls[0]![0]).toBe(failure);
      else {
        await f.memory.consolidatePending();
        expect(f.rows().find(({ id }) => id === work.id)).toMatchObject({
          status: "complete",
          attempt: 2,
        });
      }
    },
  );

  it.each(["false_fit", "reject", "cancel"] as const)(
    "checks the original snapshot before consuming %s",
    async (outcome) => {
      const f = open(disk());
      await f.seed();
      const work = keepOnePending(f);
      const entered = deferred(),
        release = deferred();
      const controller = new AbortController();
      f.measureInput.mockImplementationOnce(async (input) => {
        entered.resolve();
        await release.promise;
        if (outcome === "reject")
          throw new ProviderError(
            "PROVIDER.TIMEOUT",
            "count timed out",
            true,
            identity,
          );
        return {
          measurement: {
            ...estimateInputBudget(input),
            exactInputTokens: 100001,
          },
          budget: 100000,
        };
      });
      const pending = f.memory.consolidatePending(controller.signal, vi.fn());
      await entered.promise;
      addSupport(
        f,
        f.measureInput.mock.calls[0]![0].evidence.find(
          ({ revisionId }) =>
            revisionId !== f.measureInput.mock.calls[0]![0].anchorRevisionId,
        )!.revisionId,
      );
      if (outcome === "cancel") controller.abort();
      release.resolve();
      if (outcome === "cancel") await expect(pending).rejects.toThrow();
      else await pending;
      expect(f.consolidate).not.toHaveBeenCalled();
      expect(f.rows().find(({ id }) => id === work.id)).toMatchObject({
        status: "pending",
        errorCode:
          outcome === "cancel"
            ? "consolidation_interrupted"
            : "consolidation_dependencies_changed",
      });
    },
  );

  it("removes only optional tails and generates the exact final measured input", async () => {
    const f = open(disk());
    await f.seed("蓝色相册暂不整理；照片暂时夹在第一页；要等周末才处理照片");
    keepOnePending(f);
    f.measureInput.mockImplementation((input) =>
      Promise.resolve({
        measurement: {
          ...estimateInputBudget(input),
          exactInputTokens: input.evidence.length > 2 ? 201 : 100,
        },
        budget: 200,
      }),
    );
    await f.memory.consolidatePending();
    expect(f.measureInput.mock.calls[0]![0].evidence.length).toBeGreaterThan(2);
    expect(f.consolidate).toHaveBeenCalledOnce();
    expect(f.consolidate.mock.calls[0]![0]).toEqual(
      f.measureInput.mock.calls.at(-1)![0],
    );
    expect(f.consolidate.mock.calls[0]![0].evidence).toHaveLength(2);
    expect(
      f.consolidate.mock.calls[0]![0].evidence.some(
        ({ revisionId }) =>
          revisionId === f.consolidate.mock.calls[0]![0].anchorRevisionId,
      ),
    ).toBe(true);
  });

  it("records a stable required request limit as failed, without retain or ordinary-wake retry", async () => {
    const f = open(disk());
    await f.seed();
    const work = keepOnePending(f);
    f.measureInput.mockImplementation((input) =>
      Promise.resolve({
        measurement: {
          ...estimateInputBudget(input),
          exactInputTokens: 300000,
        },
        budget: 258000,
      }),
    );
    await f.memory.consolidatePending();
    const first = f.rows().find(({ id }) => id === work.id)!;
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "consolidation_input_limit",
    });
    expect(f.consolidate).not.toHaveBeenCalled();
    await f.memory.consolidatePending();
    expect(f.rows().find(({ id }) => id === work.id)).toEqual(first);
  });

  it("supplies a complete anchor above the old local allocation when the measured request fits", async () => {
    const f = open(disk());
    const content = Array.from(
      { length: 900 },
      (_, n) => `照片第${n}项：周末核对对象${n}；下雨时先保留原件。`,
    ).join("\n");
    const large = rawMaterial(f, content);
    rawMaterial(f, "照片整理前先核对原件；未核对时不删除。");
    f.repository.learning.enqueue(large.memoryId, clock.now());
    await f.memory.indexPending();
    f.measureInput.mockImplementation((input) =>
      Promise.resolve({
        measurement: { ...estimateInputBudget(input), exactInputTokens: 100 },
        budget: 258000,
      }),
    );
    await f.memory.consolidatePending();
    const input = f.measureInput.mock.calls[0]![0];
    const anchor = input.evidence.find(
      ({ revisionId }) => revisionId === large.revisionId,
    )!;
    expect(estimateInputBudget(input).estimatedTokens).toBeGreaterThan(16384);
    expect(anchor.content).toBe(content);
    expect(anchor.sourceRefs[0]!.spans).toEqual([
      { start: 0, end: content.length, quote: content },
    ]);
    expect(f.consolidate.mock.calls[0]![0]).toEqual(input);
  });

  it.each(["future", "expired", "missing_parent"] as const)(
    "selects the older eligible target in the same query before LIMIT: %s",
    (ineligible) => {
      const f = open(disk());
      const parents = [
        rawMaterial(f, "照片暂存相册。"),
        rawMaterial(f, "雨天不搬照片。"),
      ];
      const valid = derivedMaterial(f, parents, {
        now: "2026-09-16T09:00:00.000Z",
      });
      const recent = derivedMaterial(f, parents, {
        now: "2026-09-16T10:00:00.000Z",
        ...(ineligible === "future"
          ? { validFrom: "2026-09-17T00:00:00.000Z" }
          : {}),
        ...(ineligible === "expired" ? { validTo: clock.now() } : {}),
      });
      if (ineligible === "missing_parent")
        f.database
          .prepare(
            "DELETE FROM memory_revision_links WHERE from_revision_id=? AND to_revision_id=?",
          )
          .run(recent.revisionId, parents[1]!.revisionId);
      expect(
        f.repository.learning.derivedTarget(
          parents.map(({ memoryId }) => memoryId),
          "user",
          undefined,
          clock.now(),
        ),
      ).toEqual(valid);
    },
  );

  it("keeps persisted history use for current parents while reading complete prior bodies", async () => {
    const f = open(disk());
    const parents = [
      rawMaterial(f, "照片暂存相册。"),
      rawMaterial(f, "雨天不搬照片。"),
    ];
    const old = derivedMaterial(f, parents, { use: "history" });
    f.repository.learning.enqueue(parents[0]!.memoryId, clock.now());
    await f.memory.indexPending();
    f.consolidate.mockImplementation((input) =>
      Promise.resolve(grounded(input, "完整保留历史用途")),
    );
    await f.memory.consolidatePending();
    expect(f.consolidate.mock.calls[0]![0].existing?.revisionId).toBe(
      old.revisionId,
    );
    const current = f.repository.getDetail(old.memoryId)!.memory
      .currentRevisionId;
    expect(current).not.toBe(old.revisionId);
    expect(
      f.repository.learning
        .derivation(current, clock.now())
        ?.dependencies.map(({ use }) => use),
    ).toEqual(["history", "history"]);
  });

  it("preserves an existing current dependency when the same revision also has history use", async () => {
    const f = open(disk());
    const parents = [
      rawMaterial(f, "照片暂存相册。"),
      rawMaterial(f, "雨天不搬照片。"),
    ];
    const first = parents[0]!;
    const extraSource = {
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "chat" as const,
      createdAt: clock.now(),
    };
    const quote = "这项照片暂存安排目前仍然有效。";
    f.repository.attachEvidence(first.revisionId, [extraSource]);
    f.repository.recall.addSpan(
      first.revisionId,
      extraSource.id,
      0,
      quote.length,
      quote,
    );
    const old = derivedMaterial(
      f,
      [...parents, { ...first, source: extraSource, content: quote }],
      { uses: ["history", "history", "current"] },
    );
    expect(
      f.repository.learning
        .derivation(old.revisionId, clock.now())
        ?.dependencies.filter(
          ({ revisionId }) => revisionId === first.revisionId,
        )
        .map(({ use }) => use)
        .sort(),
    ).toEqual(["current", "history"]);
    f.repository.learning.enqueue(first.memoryId, clock.now());
    await f.memory.indexPending();
    f.consolidate.mockImplementation((input) =>
      Promise.resolve(grounded(input, "保留已有当期依赖")),
    );
    await f.memory.consolidatePending();
    const current = f.repository.getDetail(old.memoryId)!.memory
      .currentRevisionId;
    expect(current).not.toBe(old.revisionId);
    const dependencies = f.repository.learning.derivation(
      current,
      clock.now(),
    )!.dependencies;
    expect(
      dependencies.find(({ revisionId }) => revisionId === first.revisionId)
        ?.use,
    ).toBe("current");
    expect(
      dependencies.find(
        ({ revisionId }) => revisionId === parents[1]!.revisionId,
      )?.use,
    ).toBe("history");
    const summaryReference = {
      memoryId: old.memoryId,
      revisionId: current,
      use: "current" as const,
    };
    const request = {
      personaId: "",
      references: [summaryReference],
      usage: "grounding" as const,
    };
    expect(
      f.repository.recall.validateEvidenceReferences(request, clock.now()),
    ).toEqual([]);
    // A legal later version leaves the original fact historically true. It
    // still invalidates a summary that explicitly depended on its current use.
    f.repository.revise({
      memoryId: first.memoryId,
      predecessorRevisionId: first.revisionId,
      priorDispositions: [
        { revisionId: first.revisionId, disposition: "retained_history" },
      ],
      revisionId: randomUUID(),
      content: "照片现在已移到新相册。",
      reason: "安排已经变化",
      now: clock.now(),
      sources: [extraSource],
    });
    expect(
      f.repository.recall.validateEvidenceReferences(
        {
          personaId: "",
          references: [
            {
              memoryId: first.memoryId,
              revisionId: first.revisionId,
              use: "history",
            },
          ],
          usage: "grounding",
        },
        clock.now(),
      ),
    ).toEqual([]);
    expect(
      f.repository.recall.validateEvidenceReferences(request, clock.now()),
    ).toEqual([summaryReference]);
  });

  it("defers when a live target appears during count instead of creating a competing summary", async () => {
    const f = open(disk());
    const parents = [
      rawMaterial(f, "照片暂存相册。"),
      rawMaterial(f, "雨天不搬照片。"),
    ];
    f.repository.learning.enqueue(parents[0]!.memoryId, clock.now());
    await f.memory.indexPending();
    const entered = deferred(),
      release = deferred();
    f.measureInput.mockImplementationOnce(async (input) => {
      entered.resolve();
      await release.promise;
      return fitMeasurement(input);
    });
    const pending = f.memory.consolidatePending(undefined, vi.fn());
    await entered.promise;
    expect(f.measureInput.mock.calls[0]![0].existing).toBeUndefined();
    const actual = derivedMaterial(f, parents);
    release.resolve();
    await pending;
    expect(f.consolidate).not.toHaveBeenCalled();
    expect(f.rows()[0]).toMatchObject({
      status: "pending",
      errorCode: "consolidation_target_changed",
    });
    expect(
      f.repository.learning.derivedTarget(
        parents.map(({ memoryId }) => memoryId),
        "user",
        undefined,
        clock.now(),
      ),
    ).toEqual(actual);
  });
  it("shares the raw allocation across initial target and previously unread dependencies", async () => {
    const f = open(disk());
    const anchor = rawMaterial(f, "照片暂存相册。");
    // Deliberately regular bytes isolate read allocation, not semantic quality.
    const parent = rawMaterial(f, "q".repeat(6 * 1024 * 1024));
    const target = derivedMaterial(f, [anchor, parent]);
    const initialIds = [anchor.revisionId, target.revisionId];
    const initial = f.repository.recall.evidenceReadCost(
      initialIds,
      clock.now(),
    );
    const remaining = f.repository.recall.evidenceReadCost(
      [parent.revisionId],
      clock.now(),
    );
    const limit = 16 * 1024 * 1024;
    expect(initial.rawValueBytes).toBeLessThan(limit);
    expect(remaining.rawValueBytes).toBeLessThan(limit);
    expect(initial.rawValueBytes + remaining.rawValueBytes).toBeGreaterThan(
      limit,
    );
    f.repository.learning.enqueue(anchor.memoryId, clock.now());
    const evidence = vi.spyOn(f.repository.recall, "evidence");
    await f.memory.consolidatePending(undefined, vi.fn());
    expect(f.rows()[0]).toMatchObject({
      status: "failed",
      errorCode: "consolidation_resource_limit",
    });
    expect(f.measureInput).not.toHaveBeenCalled();
    expect(f.consolidate).not.toHaveBeenCalled();
    expect(
      evidence.mock.calls.some(
        ([ids, , projection]) =>
          projection === undefined && ids.includes(parent.revisionId),
      ),
    ).toBe(false);
    expect(
      f.repository.getDetail(target.memoryId)!.memory.currentRevisionId,
    ).toBe(target.revisionId);
  });

  it("keeps an expired original anchor eligible as historical grounding", async () => {
    const f = open(disk());
    const old = rawMaterial(
      f,
      "过去照片暂存蓝色相册，后来这项安排结束。",
      "2026-09-15T00:00:00.000Z",
    );
    rawMaterial(f, "现在照片仍需核对，尚未删除原件。");
    f.repository.learning.enqueue(old.memoryId, clock.now());
    await f.memory.indexPending();
    await f.memory.consolidatePending();
    expect(f.consolidate).toHaveBeenCalledOnce();
    const supplied = f.consolidate.mock.calls[0]![0].evidence.find(
      ({ revisionId }) => revisionId === old.revisionId,
    )!;
    expect(supplied.current).toBe(false);
    expect(supplied.content).toBe(old.content);
    expect(supplied.sourceRefs[0]!.spans![0]!.quote).toBe(old.content);
    expect(f.rows()[0]).toMatchObject({ status: "complete", errorCode: null });
  });
});

// A finite source-projection regression, not a replay of the original story DB.
// Derive the fixture allocation from actual complete records; never alter the
// product's final input or raw read limits to make the example pass.
async function sparseSelection(
  f: ReturnType<typeof open>,
  parents: ReturnType<typeof rawMaterial>[],
) {
  await f.memory.indexPending();
  const ids = parents.map(({ revisionId }) => revisionId);
  const full = f.repository.recall.evidence(ids, clock.now()).map((item) => ({
    ...item,
    questionIds: ["developments"],
  }));
  const compact = full.map((item) => ({
    ...item,
    sourceCount: item.sourceCount ?? item.sourceRefs.length,
    sourceRefs: item.sourceRefs
      .slice(0, 1)
      .map(({ sourceId, referenceId, type }) => ({
        sourceId,
        referenceId,
        type,
      })),
  }));
  f.recallBudget.maxTokens = estimateInputBudget(compact).estimatedTokens;
  expect(fitMemoryEvidence(full, f.recallBudget.maxTokens)).toEqual(compact);
  f.select.mockImplementation(({ plan, candidates }) => {
    expect(new Set(candidates.map(({ revisionId }) => revisionId))).toEqual(
      new Set(ids),
    );
    return Promise.resolve({
      selected: ids.map((revisionId) => ({
        revisionId,
        questionIds: plan.questions.map(({ id }) => id),
      })),
      coverage: plan.questions.map(({ id }) => ({
        questionId: id,
        status: "supported",
        revisionIds: ids,
      })),
    });
  });
  const anchor = parents[0]!;
  const pack = await f.memory.recall({
    purpose: "reflection",
    query: anchor.content,
    questions: [
      {
        id: "developments",
        text: `与这段原始记忆有关的事件发展、限定、纠正和独立支持：${anchor.content}`,
      },
    ],
    owner: "user",
    contextBudget: f.recallBudget,
  });
  expect(pack.items).toEqual(compact);
  f.select.mockClear();
  f.repository.learning.enqueue(anchor.memoryId, clock.now());
  return { full, pack };
}

function consolidationInput(request: Parameters<ModelProvider["stream"]>[0]) {
  const message = request.input[0];
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message["type"] !== "message" ||
    typeof message["content"] !== "string"
  )
    throw new TypeError("Expected actual consolidation input");
  return JSON.parse(message["content"]) as Parameters<
    MemoryConsolidationModel["consolidate"]
  >[0];
}

function actualConsolidation(limits = {}) {
  const measure = vi.fn<ModelProvider["measureInput"]>((request, signal) => {
    signal.throwIfAborted();
    return Promise.resolve(estimateInputBudget(request));
  });
  const stream = vi.fn<ModelProvider["stream"]>(
    async function* (request, signal) {
      signal.throwIfAborted();
      const input = consolidationInput(request);
      yield await Promise.resolve({
        type: "text.delta" as const,
        delta: JSON.stringify(grounded(input, "完整精确引文")),
      });
      yield {
        type: "response.completed",
        responseId: "offline-consolidation",
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      };
    },
  );
  const provider: ModelProvider = {
    stream,
    measureInput: measure,
    estimateInput: (request) => estimateInputBudget(request),
    resolveContextLimits: () => Promise.resolve(limits),
  };
  const model = new ModelMemoryConsolidation(provider, "model-a", limits);
  return { model, measure, stream };
}

function addLargeQuote(
  f: ReturnType<typeof open>,
  item: ReturnType<typeof rawMaterial>,
  bytes: number,
  source = item.source,
) {
  if (source.id !== item.source.id)
    f.repository.attachEvidence(item.revisionId, [source]);
  // Regular bytes test the fixed existing resource guard, not semantic quality.
  f.repository.recall.addSpan(
    item.revisionId,
    source.id,
    100,
    100 + bytes,
    "q".repeat(bytes),
  );
}

describe("complete selected optional consolidation evidence", () => {
  it.each([
    [
      "permission and plan",
      [
        "我答应会分享这次收藏的选择。",
        "我刚观察了收藏，只知道文字描述，未看到图片。",
        "我安排明天再看收藏，还没有执行。",
        "对这次收藏我愿意听你讲喜欢哪里。",
      ],
    ],
    [
      "dated rest",
      [
        "这次先歇一会儿，不急着添东西。",
        "明天再看是否需要调整，现在还没有执行。",
        "二月五日说当天先歇一会儿，不能当长期习惯。",
      ],
    ],
  ] as const)(
    "completes selected optional spans through the real request and reopen: %s",
    async (_name, contents) => {
      const actual = actualConsolidation();
      const file = disk();
      const f = open(file, actual.model.version);
      f.bind.mockResolvedValue(actual.model);
      const parents = contents.map((content) => rawMaterial(f, content));
      addSupport(f, parents[1]!.revisionId);
      const { full, pack } = await sparseSelection(f, parents);
      expect(
        pack.items
          .slice(1)
          .every((item) => item.sourceRefs.every((source) => !source.spans)),
      ).toBe(true);
      await f.memory.consolidatePending(undefined, vi.fn());
      expect(actual.stream).toHaveBeenCalledOnce();
      expect(f.select).toHaveBeenCalledOnce();
      const measured = actual.measure.mock.calls.at(-1)![0];
      expect(actual.stream.mock.calls[0]![0]).toEqual(measured);
      const input = consolidationInput(measured);
      for (const expected of full) {
        expect(
          input.evidence.find(
            ({ revisionId }) => revisionId === expected.revisionId,
          )?.sourceRefs,
        ).toEqual(expected.sourceRefs);
      }
      expect(input.coverage.retrieval).toEqual({
        coverage: pack.coverage,
        gaps: pack.gaps,
        truncated: pack.truncated,
        incompleteReasons: pack.incompleteReasons,
      });
      expect(input.coverage.materialOmissions).toBeUndefined();
      expect(
        input.coverage.supplied.every(
          ({ omittedStoredSpanCount, unavailableSpanCount }) =>
            omittedStoredSpanCount === 0 && unavailableSpanCount === 0,
        ),
      ).toBe(true);
      expect(f.rows()[0]!.status).toBe("complete");
      const target = f.repository.learning.derivedTarget(
        parents.map(({ memoryId }) => memoryId),
        "user",
        undefined,
        clock.now(),
      )!;
      expect(target).toBeDefined();
      f.database.close();
      const reopened = open(file, actual.model.version);
      const evidence = reopened.repository.recall.evidence(
        [target.revisionId],
        clock.now(),
      )[0]!;
      expect(
        evidence.derivation?.dependencies
          .map(({ revisionId }) => revisionId)
          .sort(),
      ).toEqual(parents.map(({ revisionId }) => revisionId).sort());
      for (const parent of full)
        for (const source of parent.sourceRefs)
          for (const span of source.spans ?? []) {
            expect(
              reopened.repository.recall.hasSpan(
                target.revisionId,
                source.sourceId,
                span.start,
                span.end,
                span.quote,
              ),
            ).toBe(true);
          }
    },
  );

  it("reads an optional prefix with one cumulative raw guard and never reads the blocked tail", async () => {
    const f = open(disk());
    const parents = [
      "照片暂存。",
      "先核对日期。",
      "再核对地点。",
      "最后再决定摆放。",
    ].map((text) => rawMaterial(f, text));
    // Same source, different Revisions: their full projections both cost bytes.
    addLargeQuote(f, parents[1]!, 9 * 1024 * 1024);
    addLargeQuote(f, parents[2]!, 9 * 1024 * 1024, parents[1]!.source);
    const { pack } = await sparseSelection(f, parents);
    const ids = parents.map(({ revisionId }) => revisionId);
    const firstCost = f.repository.recall.evidenceReadCost(
      ids.slice(0, 2),
      clock.now(),
    ).rawValueBytes;
    expect(firstCost).toBeLessThan(16 * 1024 * 1024);
    expect(
      firstCost +
        f.repository.recall.evidenceReadCost([ids[2]!], clock.now())
          .rawValueBytes,
    ).toBeGreaterThan(16 * 1024 * 1024);
    // Isolate raw allocation from the independent model input limit here.
    f.measureInput.mockImplementation((input) =>
      Promise.resolve({
        measurement: estimateInputBudget(input),
        budget: Number.MAX_SAFE_INTEGER,
      }),
    );
    const reads = vi.spyOn(f.repository.recall, "evidence");
    await f.memory.consolidatePending();
    const input = f.consolidate.mock.calls[0]![0];
    expect(input.evidence.map(({ revisionId }) => revisionId)).toEqual(
      ids.slice(0, 2),
    );
    expect(input.coverage.materialOmissions).toEqual(
      ids
        .slice(2)
        .map((revisionId) => ({ revisionId, reason: "resource_limit" })),
    );
    expect(input.coverage.retrieval).toEqual({
      coverage: pack.coverage,
      gaps: pack.gaps,
      truncated: pack.truncated,
      incompleteReasons: pack.incompleteReasons,
    });
    expect(
      reads.mock.calls
        .filter(([, , projection]) => projection === undefined)
        .flatMap(([readIds]) => readIds),
    ).toEqual(ids.slice(0, 2));
    expect(
      f.repository.recall.evidenceReadCost(ids, clock.now()).rawValueBytes,
    ).toBeGreaterThan(16 * 1024 * 1024);
  });

  it("fails resource omission below two facts without turning it into the single-fact no-op", async () => {
    const f = open(disk());
    const parents = [
      rawMaterial(f, "照片暂存。"),
      rawMaterial(f, "核对日期后再处理。"),
    ];
    addLargeQuote(f, parents[1]!, 17 * 1024 * 1024);
    await sparseSelection(f, parents);
    await f.memory.consolidatePending(undefined, vi.fn());
    expect(f.rows()[0]).toMatchObject({
      status: "failed",
      errorCode: "consolidation_resource_limit",
    });
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.consolidate).not.toHaveBeenCalled();
    const before = f.rows();
    await f.memory.consolidatePending();
    expect(f.rows()).toEqual(before);
    const single = open(disk());
    const only = rawMaterial(single, "只有这一次照片观察。");
    await sparseSelection(single, [only]);
    await single.memory.consolidatePending();
    expect(single.rows()[0]).toMatchObject({
      status: "complete",
      errorCode: null,
    });
    expect(single.bind).not.toHaveBeenCalled();
  });

  it.each(["resource_limit", "input_limit"] as const)(
    "keeps omitted %s target candidates through awaited count",
    async (reason) => {
      const limits: { maxPromptTokens?: number } = {};
      const actual = actualConsolidation(limits);
      const f = open(disk(), actual.model.version);
      f.bind.mockResolvedValue(actual.model);
      const parents = ["照片暂存。", "先核对日期。", "地点尚未核对。"].map(
        (text) => rawMaterial(f, text),
      );
      if (reason === "resource_limit")
        addLargeQuote(f, parents[2]!, 17 * 1024 * 1024);
      await sparseSelection(f, parents);
      const entered = deferred(),
        release = deferred();
      actual.measure.mockImplementation(async (request) => {
        const input = consolidationInput(request);
        const measured = estimateInputBudget(request);
        if (input.evidence.length > 2) {
          limits.maxPromptTokens = Math.floor(
            measured.estimatedTokens / INPUT_BUDGET_ESTIMATE_RATIO,
          );
          return measured;
        }
        entered.resolve();
        await release.promise;
        return measured;
      });
      const pending = f.memory.consolidatePending(undefined, vi.fn());
      try {
        await entered.promise;
        const input = consolidationInput(actual.measure.mock.calls.at(-1)![0]);
        expect(input.coverage.materialOmissions).toEqual([
          { revisionId: parents[2]!.revisionId, reason },
        ]);
        expect(input.existing).toBeUndefined();
        const other = rawMaterial(f, "另一个相关的真实事件。");
        const target = derivedMaterial(f, [parents[2]!, other]);
        release.resolve();
        await pending;
        expect(actual.stream).not.toHaveBeenCalled();
        expect(f.rows()[0]).toMatchObject({
          status: "pending",
          errorCode: "consolidation_target_changed",
        });
        expect(
          f.repository.learning.derivedTarget(
            [parents[2]!.memoryId],
            "user",
            undefined,
            clock.now(),
          ),
        ).toEqual(target);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("checks a newly completed optional span after awaited count", async () => {
    const f = open(disk());
    const parents = [
      rawMaterial(f, "照片暂存。"),
      rawMaterial(f, "日期核对完成后才可处理。"),
    ];
    await sparseSelection(f, parents);
    const entered = deferred(),
      release = deferred();
    f.measureInput.mockImplementationOnce(async (input) => {
      entered.resolve();
      await release.promise;
      return fitMeasurement(input);
    });
    const pending = f.memory.consolidatePending(undefined, vi.fn());
    try {
      await entered.promise;
      const supplied = f.measureInput.mock.calls[0]![0].evidence.find(
        ({ revisionId }) => revisionId === parents[1]!.revisionId,
      )!;
      expect(supplied.sourceRefs[0]!.spans![0]!.quote).toBe(
        parents[1]!.content,
      );
      f.database
        .prepare(
          "DELETE FROM memory_revision_source_spans WHERE revision_id=? AND source_id=?",
        )
        .run(parents[1]!.revisionId, parents[1]!.source.id);
      release.resolve();
      await pending;
      expect(f.consolidate).not.toHaveBeenCalled();
      expect(f.rows()[0]).toMatchObject({
        status: "pending",
        errorCode: "consolidation_quotes_changed",
      });
    } finally {
      release.resolve();
      await pending;
    }
  });
});
