import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../fixtures/formationModel";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APIError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  memoryFormationProcessorVersion,
  memoryModelRecovery,
} from "../../src/main/app/memoryFormationRuntime";
import { RunRepository } from "../../src/main/agent/runRepository";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryMaintenance } from "../../src/main/memory/memoryMaintenance";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";

import {
  MemoryService,
  type MemoryProviderRecovery,
} from "../../src/main/memory/memoryService";
import { memoryConsolidationProcessorVersion } from "../../src/main/app/memoryConsolidationRuntime";
import { ProviderError } from "../../src/main/providers/providerError";
import { mapSdkError } from "../../src/main/providers/openaiProviderAdapter";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { Run, RunItem } from "../../src/shared/contracts/run";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { chatFixture, runFixture } from "../fixtures/foundationContracts";
import { formationIntake } from "../fixtures/memoryFormation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  initialFailure = new ProviderError(
    "PROVIDER.UNREACHABLE",
    "offline fixture",
    true,
  ),
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "run-memory-recovery-"));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const clock = { now: () => "2026-09-16T08:00:00.000Z" };
  const ids = new CryptoIdGenerator();
  const repository = new MemoryRepository(database);
  const version = memoryFormationProcessorVersion(runFixture.provider);
  const form = vi.fn<FormationModelMock["form"]>(() =>
    Promise.reject(initialFailure),
  );
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(database, repository, clock),
    ids,
    clock,
    {
      embedding: {
        modelKey: "run-recovery-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: (texts) =>
          Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
        embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
      },
      vectorSearch: { search: () => Promise.resolve([]) },
      selector: {
        select: ({ plan }) =>
          Promise.resolve({
            selected: [],
            coverage: plan.questions.map(({ id }) => ({
              questionId: id,
              status: "missing",
              revisionIds: [],
            })),
          }),
      },
      formation: formationRuntime({ version, form }),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 1600 }),
    },
  );
  const maintenance = new MemoryMaintenance(memory, { onError: vi.fn() });
  cleanups.push(async () => {
    try {
      await maintenance.shutdown();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const ref = memory.enqueueEpisode(
    formationIntake({
      id: randomUUID(),
      version: "1",
      recordedAt: clock.now(),
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat",
          speaker: "user",
          content: "我们一起看过那次海边的日落。",
          occurredAt: clock.now(),
        },
      ],
    }),
  );
  await expect(memory.formEpisode(ref.workId)).rejects.toThrow(
    initialFailure.message,
  );
  maintenance.start();
  await maintenance.idle();
  expect(form).toHaveBeenCalledOnce();
  const runs = new RunRepository(database);
  new ChatRepository(database).insertChat(chatFixture);
  const lifeRuns = new Set<string>();
  const published: RunEventEnvelope[] = [];
  const recovered: MemoryProviderRecovery[] = [];
  const events = new RunEventService(runs, {
    publish(envelope) {
      published.push(envelope);
      const processor = memoryModelRecovery(
        envelope,
        runs,
        lifeRuns.has(envelope.streamId),
      );
      if (processor !== undefined) {
        recovered.push(processor);
        maintenance.recoverProviderFailures(processor);
      }
    },
  });
  const writer = new RunEventWriter(runs, events, ids, clock);
  const run = (overrides: Partial<Run> = {}, life = false) => {
    const value: Run = { ...runFixture, id: randomUUID(), ...overrides };
    if (life) lifeRuns.add(value.id);
    writer.startRun(value);
    return value;
  };
  const complete = (
    runId: string,
    patch: {
      kind?: RunItem["kind"];
      status?: "completed" | "interrupted";
      responseId?: unknown;
    } = {},
  ) => {
    const item = writer.startItem(runId, patch.kind ?? "assistant_message");
    return writer.completeItem(item.id, {
      status: patch.status ?? "completed",
      output: {
        responseId: (patch.responseId ??
          "actual-fixture-model-response") as string,
      },
    });
  };
  return {
    database,
    repository,
    ref,
    version,
    recovery: {
      formationProcessorVersion: version,
      consolidationProcessorVersion: memoryConsolidationProcessorVersion(
        runFixture.provider,
      ),
      requestIdentity: {
        profileId: runFixture.provider.profileId,
        apiStyle: runFixture.provider.apiStyle,
        modelId: runFixture.provider.modelId,
      },
    },
    form,
    memory,
    maintenance,
    runs,
    events,
    writer,
    run,
    complete,
    published,
    recovered,
  };
}

describe("actual Run events driving memory Provider recovery", () => {
  it.each([400, 503])(
    "preserves an HTTP %i failure and recovers only temporary service failure after a real response event",
    async (status) => {
      const failure = mapSdkError(
        APIError.generate(
          status,
          {
            error: {
              message: "upstream unavailable",
              code: "model_overloaded",
            },
          },
          undefined,
          new Headers(),
        ),
      );
      const f = await setup(failure);
      f.form.mockImplementation(({ episode }) => {
        const source = episode.sources.find(({ id }) =>
          episode.evidenceSourceIds.includes(id),
        )!;
        return Promise.resolve({
          entities: [],
          units: [
            {
              operation: "create",
              content: source.content,
              type: "event",
              entityKeys: [],
              links: [],
              semantics: {
                kind: "episode",
                owner: "user",
                basis: "explicit_user_statement",
                qualifiers: {},
              },
              citations: [{ sourceId: source.id, quote: source.content }],
            },
          ],
        });
      });
      f.maintenance.wake();
      await f.maintenance.idle();
      expect(f.form).toHaveBeenCalledOnce();
      expect(f.repository.formation.work(f.ref.workId).status).toBe("failed");
      const run = f.run();
      f.complete(run.id);
      await f.maintenance.idle();
      expect(f.repository.formation.work(f.ref.workId)).toMatchObject({
        attempt: status === 503 ? 2 : 1,
        status: status === 503 ? "complete" : "failed",
      });
      expect(
        f.memory.list({}).memories.map(({ revision }) => revision.content),
      ).toEqual(status === 503 ? ["我们一起看过那次海边的日落。"] : []);
      f.complete(run.id);
      f.maintenance.wake();
      await f.maintenance.idle();
      expect(f.form).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
    },
  );

  it("retries only at the first actual response, without duplicate append, replay or later tool/model loops", async () => {
    const f = await setup();
    const run = f.run();
    const first = f.complete(run.id);
    await f.maintenance.idle();
    expect(f.recovered).toEqual([f.recovery]);
    expect(f.form).toHaveBeenCalledTimes(2);
    expect(f.repository.formation.work(f.ref.workId)).toMatchObject({
      status: "failed",
      attempt: 2,
    });
    const completed = f.published.find(
      (event) =>
        event.event.type === "item.completed" &&
        event.event.item.id === first.id,
    )!;
    const count = f.published.length;
    f.events.append(completed);
    f.events.replay({ streamId: run.id, afterSequence: 0 });
    expect(f.published).toHaveLength(count);
    f.complete(run.id, { kind: "tool_call" });
    f.complete(run.id);
    f.maintenance.wake();
    await f.maintenance.idle();
    expect(f.recovered).toEqual([f.recovery]);
    expect(f.form).toHaveBeenCalledTimes(2);
    f.writer.transition(run.id, "completed");
    f.complete(f.run().id);
    await f.maintenance.idle();
    expect(f.recovered).toEqual([f.recovery, f.recovery]);
    expect(f.form).toHaveBeenCalledTimes(3);
  });

  it("ignores interrupted, non-model, and empty-response Items without consuming the first valid response", async () => {
    const f = await setup();
    const run = f.run();
    f.complete(run.id, { status: "interrupted" });
    f.complete(run.id, { kind: "tool_call" });
    f.complete(run.id, { responseId: "" });
    const synthetic = f.writer.startItem(run.id, "assistant_message");
    f.writer.completeItem(synthetic.id, {
      status: "completed",
      output: { messageId: randomUUID() },
    });
    const invalid = f.writer.startItem(run.id, "assistant_message");
    f.writer.completeItem(invalid.id, {
      status: "completed",
      output: { responseId: 42 },
    });
    await f.maintenance.idle();
    expect(f.recovered).toEqual([]);
    expect(f.form).toHaveBeenCalledOnce();
    f.complete(run.id);
    await f.maintenance.idle();
    expect(f.recovered).toEqual([f.recovery]);
    expect(f.form).toHaveBeenCalledTimes(2);
  });

  it.each(["voice", "life"] as const)(
    "does not use %s responses as recovery triggers",
    async (source) => {
      const f = await setup();
      const run = f.run(
        source === "voice" ? { source } : {},
        source === "life",
      );
      f.complete(run.id);
      await f.maintenance.idle();
      expect(f.recovered).toEqual([]);
      expect(f.form).toHaveBeenCalledOnce();
      expect(f.repository.formation.work(f.ref.workId).status).toBe("failed");
    },
  );

  it.each(["profile", "model", "protocol"] as const)(
    "does not recover memory through a different actual %s",
    async (field) => {
      const f = await setup();
      const provider = { ...runFixture.provider } as Run["provider"];
      if (field === "profile") provider.profileId = randomUUID();
      if (field === "model") provider.modelId = "different-fixture-model";
      if (field === "protocol") provider.apiStyle = "azure-openai";
      f.complete(f.run({ provider }).id);
      await f.maintenance.idle();
      expect(f.recovered).toEqual([
        {
          formationProcessorVersion: memoryFormationProcessorVersion(provider),
          consolidationProcessorVersion:
            memoryConsolidationProcessorVersion(provider),
          requestIdentity: {
            profileId: provider.profileId,
            apiStyle: provider.apiStyle,
            modelId: provider.modelId,
          },
        },
      ]);
      expect(f.form).toHaveBeenCalledOnce();
      expect(f.repository.formation.work(f.ref.workId).status).toBe("failed");
    },
  );
});
