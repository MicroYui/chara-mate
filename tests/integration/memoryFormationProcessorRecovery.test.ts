import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../fixtures/formationModel";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryFormationRuntime } from "../../src/main/app/memoryFormationRuntime";
import { ProviderError } from "../../src/main/providers/providerError";
import { ProviderRepository } from "../../src/main/providers/providerRepository";
import { ProviderService } from "../../src/main/providers/providerService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryMaintenance } from "../../src/main/memory/memoryMaintenance";

import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import type { MemoryFormationRuntime } from "../../src/main/memory/memoryModels";
import { registerMemoryFormationTool } from "../../src/main/memory/memoryTool";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import {
  MemoryService,
  type MemoryProviderRecovery,
} from "../../src/main/memory/memoryService";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import {
  formationIntake,
  type FormationFixture,
} from "../fixtures/memoryFormation";

function providerRecovery(
  formationProcessorVersion: string,
): MemoryProviderRecovery {
  return {
    formationProcessorVersion,
    consolidationProcessorVersion: "unused-consolidation-processor",
    requestIdentity: {
      profileId: "profile-a",
      apiStyle: "openai-compatible",
      modelId: "model-a",
    },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
const clock = { now: () => "2026-09-16T08:00:00.000Z" };
function disk() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "memory-processor-recovery-"),
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "app.sqlite");
}
function open(
  file: string,
  version: string,
  implementation?: FormationModelMock["form"],
  runtime?: MemoryFormationRuntime,
) {
  const database = openApplicationDatabase(file);
  cleanups.push(() => {
    if (database.open) database.close();
  });
  const repository = new MemoryRepository(database);
  const form = vi.fn<FormationModelMock["form"]>(
    implementation ?? (() => Promise.resolve({ entities: [], units: [] })),
  );
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(database, repository, clock),
    new CryptoIdGenerator(),
    clock,
    {
      embedding: {
        modelKey: "recovery-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments: (texts) =>
          Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
        embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
      },
      vectorSearch: {
        search: () => Promise.resolve([]),
      },
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
      formation: formationRuntime(runtime ?? { version, form }),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 1600 }),
    },
  );
  const onError = vi.fn();
  const maintenance = new MemoryMaintenance(memory, { onError });
  memory.setChangedListener(() => maintenance.wake());
  return { database, repository, memory, maintenance, form, onError };
}
function episode(
  content = "那天我们在海边散步。",
  personaId?: string,
): FormationFixture {
  return {
    id: randomUUID(),
    version: "1",
    recordedAt: clock.now(),
    ...(personaId ? { personaId } : {}),
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
  };
}
const segment: FormationModelMock["form"] = ({
  episode: input,
  sourceWindows,
}) =>
  Promise.resolve({
    entities: [],
    units: [
      {
        operation: "create",
        type: "event",
        content: `海边经历的第 ${String(sourceWindows![0]!.start)} 段`,
        semantics: {
          kind: "episode",
          owner: "user",
          basis: "explicit_user_statement",
          qualifiers: {},
        },
        entityKeys: [],
        citations: [
          { sourceId: input.sources[0]!.id, quote: input.sources[0]!.content },
        ],
        links: [],
      },
    ],
  });
async function failOriginal(
  file: string,
  input: FormationFixture,
  partial = false,
) {
  const prior = open(file, "old-v1", (value, execution, signal) =>
    partial && value.sourceWindows![0]!.start === 0
      ? segment(value, execution, signal)
      : Promise.reject(new Error("old processor rejected source")),
  );
  const ref = prior.memory.enqueueEpisode(formationIntake(input));
  await expect(prior.memory.formEpisode(ref.workId)).rejects.toThrow(
    "old processor rejected source",
  );
  return { ...prior, ref };
}

function providers(file: string) {
  const database = openApplicationDatabase(file);
  cleanups.push(() => {
    if (database.open) database.close();
  });
  const repository = new ProviderRepository(database);
  const service = new ProviderService(
    repository,
    {
      store: vi.fn(() => Promise.resolve("unused-fixture-reference")),
      get: vi.fn(() => Promise.resolve("unused-fixture-secret")),
      delete: vi.fn(() => Promise.resolve()),
      prune: vi.fn(() => Promise.resolve()),
    },
    new CryptoIdGenerator(),
    clock,
    { warn: vi.fn() },
  );
  return { service, repository };
}

describe("formation processor recovery through real disk startup", () => {
  it("automatically resumes an old failed cursor with the new processor without rewriting the committed prefix", async () => {
    const file = disk();
    const input = episode("那天我们在海边慢慢走了一会儿。\n".repeat(140));
    const prior = await failOriginal(file, input, true);
    const work = prior.repository.formation.work(prior.ref.workId);
    const progress = work.result as {
      cursor: { ordinal: number; start: number };
      changes: { memoryId: string; revisionId: string }[];
    };
    expect(progress.cursor.start).toBeGreaterThan(0);
    const prefix = prior.database
      .prepare("SELECT * FROM memory_revisions WHERE id=?")
      .get(progress.changes[0]!.revisionId);
    prior.database.close();
    const next = open(file, "new-v16", segment);
    next.maintenance.start();
    await next.maintenance.idle();
    expect(next.onError.mock.calls.map(([error]) => String(error))).toEqual([]);
    const resumed = next.repository.formation.work(prior.ref.workId);
    expect(resumed).toMatchObject({
      status: "complete",
      processorVersion: "new-v16",
      attempt: 2,
    });
    expect(
      next.form.mock.calls.every(
        ([value, execution]) =>
          value.sourceWindows![0]!.start >= progress.cursor.start &&
          execution.expectedProcessorVersion === "new-v16",
      ),
    ).toBe(true);
    expect(
      next.database
        .prepare("SELECT * FROM memory_revisions WHERE id=?")
        .get(progress.changes[0]!.revisionId),
    ).toEqual(prefix);
    expect(resumed.result).toMatchObject({
      processorTransitions: [
        {
          fromProcessorVersion: "old-v1",
          toProcessorVersion: "new-v16",
          priorAttempt: 1,
          priorErrorCode: "formation_failed",
          atCursor: progress.cursor,
        },
      ],
    });
    const spans = next.database
      .prepare(
        "SELECT span_start,span_end,quote FROM memory_revision_source_spans ORDER BY span_start",
      )
      .all() as { span_start: number; span_end: number; quote: string }[];
    expect(spans.map(({ quote }) => quote).join("")).toBe(
      input.sources[0]!.content,
    );
    expect(next.onError).not.toHaveBeenCalled();
    await next.maintenance.shutdown();
  });

  it("does not retry a same-processor failure on startup, wake, or another unrelated source", async () => {
    const file = disk();
    const prior = await failOriginal(file, episode());
    prior.database.close();
    const next = open(file, "old-v1");
    next.maintenance.start();
    await next.maintenance.idle();
    next.maintenance.wake();
    await next.maintenance.idle();
    expect(next.form).not.toHaveBeenCalled();
    next.maintenance.enqueueEpisode(
      formationIntake(episode("今天换了一个话题。")),
    );
    await next.maintenance.idle();
    expect(next.form).toHaveBeenCalledOnce();
    expect(next.repository.formation.work(prior.ref.workId).status).toBe(
      "failed",
    );
    await next.maintenance.shutdown();
  });

  it("persists a new processor failure so a second startup does not call it again", async () => {
    const file = disk();
    const prior = await failOriginal(file, episode());
    prior.database.close();
    const next = open(file, "new-v16", () =>
      Promise.reject(new Error("still invalid")),
    );
    next.maintenance.start();
    await next.maintenance.idle();
    expect(next.form).toHaveBeenCalledOnce();
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "failed",
      processorVersion: "new-v16",
      attempt: 2,
    });
    await next.maintenance.shutdown();
    next.database.close();
    const restarted = open(file, "new-v16");
    restarted.maintenance.start();
    await restarted.maintenance.idle();
    expect(restarted.form).not.toHaveBeenCalled();
    await restarted.maintenance.shutdown();
  });

  it("leaves completed work and an already covered old failure untouched", async () => {
    const file = disk();
    const input = episode();
    const prior = await failOriginal(file, input);
    const expanded = {
      ...input,
      version: "2",
      sources: [...input.sources, episode("后来聊完就回家了。").sources[0]!],
    };
    const covering = open(file, "old-v1");
    const complete = covering.memory.enqueueEpisode(formationIntake(expanded));
    await covering.memory.formEpisode(complete.workId);
    covering.database.close();
    prior.database.close();
    const next = open(file, "new-v16");
    next.maintenance.start();
    await next.maintenance.idle();
    expect(next.form).not.toHaveBeenCalled();
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "failed",
      processorVersion: "old-v1",
    });
    expect(next.repository.formation.work(complete.workId)).toMatchObject({
      status: "complete",
      processorVersion: "old-v1",
    });
    await next.maintenance.shutdown();
  });

  it("does not treat another persona's completed source as coverage", async () => {
    const file = disk();
    const input = episode("那天我们在海边散步。", randomUUID());
    const prior = await failOriginal(file, input);
    const other = open(file, "old-v1");
    const ref = other.memory.enqueueEpisode(
      formationIntake({ ...input, id: randomUUID(), personaId: randomUUID() }),
    );
    await other.memory.formEpisode(ref.workId);
    other.database.close();
    prior.database.close();
    const next = open(file, "new-v16");
    next.maintenance.start();
    await next.maintenance.idle();
    expect(next.form).toHaveBeenCalledOnce();
    expect(next.repository.formation.work(prior.ref.workId).status).toBe(
      "complete",
    );
    await next.maintenance.shutdown();
  });

  it("retains pending recovery across shutdown and resumes it after a second disk reopen", async () => {
    const file = disk();
    const prior = await failOriginal(file, episode());
    prior.database.close();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const next = open(
      file,
      "new-v16",
      (_input, _execution, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () =>
              reject(
                signal!.reason instanceof Error
                  ? signal!.reason
                  : new DOMException("Aborted", "AbortError"),
              ),
            {
              once: true,
            },
          );
          entered();
        }),
    );
    next.maintenance.start();
    await started;
    await next.maintenance.shutdown();
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "pending",
      processorVersion: "new-v16",
    });
    next.database.close();
    const restarted = open(file, "new-v16");
    restarted.maintenance.start();
    await restarted.maintenance.idle();
    expect(restarted.form).toHaveBeenCalledOnce();
    expect(restarted.repository.formation.work(prior.ref.workId).status).toBe(
      "complete",
    );
    await restarted.maintenance.shutdown();
  });

  it("does not fabricate a retired raw body when the failed source cannot be resolved", async () => {
    const file = disk();
    const input = episode();
    const prior = await failOriginal(file, input);
    prior.database
      .prepare("DELETE FROM memory_source_text_chunks WHERE source_id=?")
      .run(input.sources[0]!.id);
    prior.database
      .prepare("UPDATE memory_sources SET raw_present=0 WHERE id=?")
      .run(input.sources[0]!.id);
    prior.database.close();
    const next = open(file, "new-v16");
    next.maintenance.start();
    await next.maintenance.idle();
    expect(next.form).not.toHaveBeenCalled();
    expect(next.repository.formation.work(prior.ref.workId).status).toBe(
      "failed",
    );
    expect(next.onError).toHaveBeenCalledOnce();
    expect(
      next.database.prepare("SELECT COUNT(*) n FROM memories").get(),
    ).toEqual({ n: 0 });
    await next.maintenance.shutdown();
  });
});

describe("formation recovery waits for the real configured processor", () => {
  it("starts with a genuinely unconfigured Provider and leaves old failures durable", async () => {
    const file = disk();
    const prior = await failOriginal(file, episode());
    prior.database.close();
    const source = providers(file);
    const runtime = createMemoryFormationRuntime(source.service, vi.fn());
    expect(() => runtime.version).toThrow("请先配置");
    const next = open(file, "unused", undefined, runtime);
    expect(() => next.maintenance.start()).not.toThrow();
    await next.maintenance.idle();
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "failed",
      processorVersion: "old-v1",
      attempt: 1,
    });
    expect(next.form).not.toHaveBeenCalled();
    await next.maintenance.shutdown();
  });

  it("does not hide Provider storage failures or unknown processor getter errors", () => {
    const file = disk();
    const source = providers(file);
    vi.spyOn(source.repository, "list").mockImplementation(() => {
      throw new Error("actual provider storage unavailable");
    });
    const runtime = createMemoryFormationRuntime(source.service, vi.fn());
    const next = open(file, "unused", undefined, runtime);
    expect(() => next.maintenance.start()).toThrow(
      "无法读取默认 Chat Provider",
    );
    const unknown: FormationModelMock = {
      get version(): string {
        throw new Error("unexpected processor failure");
      },
      form: vi.fn(),
    };
    const other = open(file, "unused", undefined, formationRuntime(unknown));
    expect(() => other.maintenance.start()).toThrow(
      "unexpected processor failure",
    );
  });
});

function recordTool(memory: MemoryService, input: FormationFixture) {
  const tools = new ToolRegistry();
  const resolve = vi.fn((runId: string, itemId: string) => {
    expect(runId).toBe(input.id);
    expect(itemId).toEqual(expect.any(String));
    return formationIntake(input);
  });
  registerMemoryFormationTool(tools, memory, resolve);
  const execute = (signal = new AbortController().signal) =>
    tools.execute(
      "memory.record",
      {},
      {
        runId: input.id,
        itemId: randomUUID(),
        onDelta: () => undefined,
        signal,
      },
    );
  return { execute, resolve };
}

describe("explicit memory.record recovery through the actual Tool and SQLite", () => {
  it("retries only this source work, preserves its committed prefix, and replays the completed receipt", async () => {
    const file = disk();
    const input = episode("那天我们在海边慢慢走了一会儿。\n".repeat(140));
    const prior = await failOriginal(file, input, true);
    const progress = prior.repository.formation.work(prior.ref.workId)
      .result as {
      cursor: { start: number };
      changes: { revisionId: string }[];
    };
    const prefix = prior.database
      .prepare("SELECT * FROM memory_revisions WHERE id=?")
      .get(progress.changes[0]!.revisionId);
    prior.database.close();
    const other = await failOriginal(
      file,
      episode("这是另一次未成功形成的谈话。"),
    );
    other.database.close();
    const next = open(file, "old-v1", segment);
    const tool = recordTool(next.memory, input);
    const result = await tool.execute();
    expect(result.status).toBe("success");
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "complete",
      attempt: 2,
    });
    expect(next.repository.formation.work(other.ref.workId)).toMatchObject({
      status: "failed",
      attempt: 1,
    });
    expect(
      next.form.mock.calls.every(
        ([value]) =>
          value.sourceWindows![0]!.start >= progress.cursor.start &&
          value.episode.sources[0]!.id === input.sources[0]!.id,
      ),
    ).toBe(true);
    expect(
      next.database
        .prepare("SELECT * FROM memory_revisions WHERE id=?")
        .get(progress.changes[0]!.revisionId),
    ).toEqual(prefix);
    const count = next.form.mock.calls.length;
    const replay = await tool.execute();
    expect(replay.modelContent).toMatchObject({ replayed: true });
    expect(next.form).toHaveBeenCalledTimes(count);
  });

  it("merges two actual in-flight record executions into one formation attempt", async () => {
    const file = disk();
    const input = episode();
    const prior = await failOriginal(file, input);
    prior.database.close();
    let enter!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const next = open(file, "old-v1", async () => {
      enter();
      await release;
      return { entities: [], units: [] };
    });
    const tool = recordTool(next.memory, input);
    const one = tool.execute();
    await started;
    const two = tool.execute();
    finish();
    await expect(Promise.all([one, two])).resolves.toHaveLength(2);
    expect(next.form).toHaveBeenCalledOnce();
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "complete",
      attempt: 2,
    });
    expect(tool.resolve.mock.calls).toHaveLength(2);
  });

  it("requires a new actual record execution after another same-version failure and does not retry on background wake", async () => {
    const file = disk();
    const input = episode();
    const prior = await failOriginal(file, input);
    prior.database.close();
    const next = open(file, "old-v1", () =>
      Promise.reject(new Error("still rejected")),
    );
    const tool = recordTool(next.memory, input);
    await expect(tool.execute()).rejects.toThrow("still rejected");
    next.maintenance.start();
    await next.maintenance.idle();
    next.maintenance.wake();
    await next.maintenance.idle();
    expect(next.form).toHaveBeenCalledOnce();
    await expect(tool.execute()).rejects.toThrow("still rejected");
    expect(next.form).toHaveBeenCalledTimes(2);
    expect(next.repository.formation.work(prior.ref.workId)).toMatchObject({
      status: "failed",
      attempt: 3,
    });
    expect(tool.resolve.mock.calls[0]![1]).not.toBe(
      tool.resolve.mock.calls[1]![1],
    );
    await next.maintenance.shutdown();
  });

  it("recovers interrupted record work from disk without a user-managed retry", async () => {
    const file = disk();
    const input = episode();
    const prior = await failOriginal(file, input);
    prior.database.close();
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const next = open(
      file,
      "old-v1",
      (_input, _execution, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          enter();
        }),
    );
    const controller = new AbortController();
    const result = recordTool(next.memory, input).execute(controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
    expect(next.repository.formation.work(prior.ref.workId).status).toBe(
      "pending",
    );
    next.database.close();
    const restarted = open(file, "old-v1");
    restarted.maintenance.start();
    await restarted.maintenance.idle();
    expect(restarted.form).toHaveBeenCalledOnce();
    expect(restarted.repository.formation.work(prior.ref.workId).status).toBe(
      "complete",
    );
    await restarted.maintenance.shutdown();
  });
});

describe("formation recovery from a matching Provider success event", () => {
  it.each([
    ["PROVIDER.TIMEOUT", true],
    ["PROVIDER.UNREACHABLE", true],
    ["PROVIDER.RATE_LIMITED", true],
    ["PROVIDER.CONTEXT_LIMIT_EXCEEDED", false],
    ["PROVIDER.AUTHENTICATION_FAILED", false],
    ["PROVIDER.REQUEST_FAILED", false],
  ] as const)(
    "preserves %s and only requeues connectivity failures",
    async (code, selected) => {
      const current = open(disk(), "v16:profile-a:responses:model-a", () =>
        Promise.reject(
          new ProviderError(code, "fixture Provider failed", true),
        ),
      );
      const ref = current.memory.enqueueEpisode(formationIntake(episode()));
      await expect(current.memory.formEpisode(ref.workId)).rejects.toThrow(
        "fixture Provider failed",
      );
      expect(current.repository.formation.work(ref.workId)).toMatchObject({
        status: "failed",
        errorCode: code,
        attempt: 1,
      });
      const wake = vi.spyOn(current.maintenance, "wake");
      current.maintenance.recoverProviderFailures(
        providerRecovery("v16:profile-a:responses:model-a"),
      );
      expect(current.repository.formation.work(ref.workId)).toMatchObject({
        status: selected ? "pending" : "failed",
        errorCode: code,
        attempt: 1,
      });
      expect(wake).toHaveBeenCalledTimes(selected ? 1 : 0);
      current.maintenance.recoverProviderFailures(
        providerRecovery("v16:profile-a:responses:model-a"),
      );
      expect(wake).toHaveBeenCalledTimes(selected ? 1 : 0);
      expect(current.form).toHaveBeenCalledOnce();
    },
  );

  it("matches the actual configured processor and only failed rows of that same profile/model", async () => {
    const file = disk();
    const versions = [
      "v16:profile-a:responses:model-a",
      "v16:profile-b:responses:model-a",
      "v16:profile-a:responses:model-b",
    ];
    const refs = [];
    for (const version of versions) {
      const source = open(file, version, () =>
        Promise.reject(new ProviderError("PROVIDER.TIMEOUT", "timeout", true)),
      );
      const ref = source.memory.enqueueEpisode(formationIntake(episode()));
      await expect(source.memory.formEpisode(ref.workId)).rejects.toThrow(
        "timeout",
      );
      refs.push(ref);
      source.database.close();
    }
    const current = open(file, versions[0]!);
    const wake = vi.spyOn(current.maintenance, "wake");
    current.maintenance.recoverProviderFailures(providerRecovery(versions[1]!));
    expect(
      refs.map((ref) => current.repository.formation.work(ref.workId).status),
    ).toEqual(["failed", "failed", "failed"]);
    expect(wake).not.toHaveBeenCalled();
    current.maintenance.recoverProviderFailures(providerRecovery(versions[0]!));
    expect(
      refs.map((ref) => current.repository.formation.work(ref.workId).status),
    ).toEqual(["pending", "failed", "failed"]);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("does not leave an availability event for a later in-flight failure or retry again on ordinary wake", async () => {
    let enter!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const current = open(disk(), "same-v16", async () => {
      enter();
      await release;
      throw new ProviderError("PROVIDER.UNREACHABLE", "lost connection", true);
    });
    const ref = current.memory.enqueueEpisode(formationIntake(episode()));
    current.maintenance.start();
    await started;
    current.maintenance.recoverProviderFailures(providerRecovery("same-v16"));
    finish();
    await current.maintenance.idle();
    expect(current.repository.formation.work(ref.workId).status).toBe("failed");
    current.maintenance.wake();
    await current.maintenance.idle();
    expect(current.form).toHaveBeenCalledOnce();
    current.maintenance.recoverProviderFailures(providerRecovery("same-v16"));
    await current.maintenance.idle();
    expect(current.form).toHaveBeenCalledTimes(2);
    expect(current.repository.formation.work(ref.workId)).toMatchObject({
      status: "failed",
      attempt: 2,
    });
    await current.maintenance.shutdown();
    current.maintenance.recoverProviderFailures(providerRecovery("same-v16"));
    expect(current.repository.formation.work(ref.workId).status).toBe("failed");
  });

  it("does not retry complete work or failures already covered by an actual completed expanded source", async () => {
    const file = disk();
    const input = episode();
    const prior = open(file, "same-v16", () =>
      Promise.reject(
        new ProviderError("PROVIDER.RATE_LIMITED", "rate limited", true),
      ),
    );
    const failed = prior.memory.enqueueEpisode(formationIntake(input));
    await expect(prior.memory.formEpisode(failed.workId)).rejects.toThrow(
      "rate limited",
    );
    prior.database.close();
    const current = open(file, "same-v16");
    const complete = current.memory.enqueueEpisode(
      formationIntake({
        ...input,
        version: "2",
        sources: [...input.sources, episode("回家了。").sources[0]!],
      }),
    );
    await current.memory.formEpisode(complete.workId);
    const wake = vi.spyOn(current.maintenance, "wake");
    current.maintenance.recoverProviderFailures(providerRecovery("same-v16"));
    expect(current.repository.formation.work(failed.workId).status).toBe(
      "failed",
    );
    expect(current.repository.formation.work(complete.workId).status).toBe(
      "complete",
    );
    expect(wake).not.toHaveBeenCalled();
  });

  it("preserves selected partial work through disk restart without rewriting the committed source prefix", async () => {
    const file = disk();
    const input = episode("海边的一段真实对话。\n".repeat(150));
    const prior = open(file, "same-v16", (value, execution, signal) =>
      value.sourceWindows![0]!.start === 0
        ? segment(value, execution, signal)
        : Promise.reject(
            new ProviderError(
              "PROVIDER.TIMEOUT",
              "timeout after committed segment",
              true,
            ),
          ),
    );
    const ref = prior.memory.enqueueEpisode(formationIntake(input));
    await expect(prior.memory.formEpisode(ref.workId)).rejects.toThrow(
      "timeout after committed segment",
    );
    const old = prior.repository.formation.work(ref.workId);
    const progress = old.result as {
      cursor: { start: number };
      changes: { revisionId: string }[];
    };
    const prefix = prior.database
      .prepare("SELECT * FROM memory_revisions WHERE id=?")
      .get(progress.changes[0]!.revisionId);
    prior.maintenance.recoverProviderFailures(providerRecovery("same-v16"));
    expect(prior.repository.formation.work(ref.workId).result).toEqual(
      old.result,
    );
    expect(prior.repository.formation.work(ref.workId).status).toBe("pending");
    prior.database.close();
    const current = open(file, "same-v16", segment);
    current.maintenance.start();
    await current.maintenance.idle();
    expect(current.repository.formation.work(ref.workId)).toMatchObject({
      status: "complete",
      attempt: 2,
    });
    expect(
      current.form.mock.calls.every(
        ([value]) => value.sourceWindows![0]!.start >= progress.cursor.start,
      ),
    ).toBe(true);
    expect(
      current.database
        .prepare("SELECT * FROM memory_revisions WHERE id=?")
        .get(progress.changes[0]!.revisionId),
    ).toEqual(prefix);
    await current.maintenance.shutdown();
  });

  it("keeps failures unchanged when the actual Provider is unconfigured and surfaces storage errors", async () => {
    const file = disk();
    const prior = open(file, "v16:profile-a:responses:model-a", () =>
      Promise.reject(new ProviderError("PROVIDER.TIMEOUT", "timeout", true)),
    );
    const ref = prior.memory.enqueueEpisode(formationIntake(episode()));
    await expect(prior.memory.formEpisode(ref.workId)).rejects.toThrow(
      "timeout",
    );
    prior.database.close();
    const source = providers(file);
    const runtime = createMemoryFormationRuntime(source.service, vi.fn());
    const current = open(file, "unused", undefined, runtime);
    const wake = vi.spyOn(current.maintenance, "wake");
    expect(() =>
      current.maintenance.recoverProviderFailures(
        providerRecovery("v16:profile-a:responses:model-a"),
      ),
    ).not.toThrow();
    expect(current.repository.formation.work(ref.workId).status).toBe("failed");
    expect(wake).not.toHaveBeenCalled();
    vi.spyOn(source.repository, "list").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() =>
      current.maintenance.recoverProviderFailures(
        providerRecovery("v16:profile-a:responses:model-a"),
      ),
    ).toThrow("无法读取默认 Chat Provider");
  });
});

describe("semantic replacement across an actual disk restart", () => {
  it("keeps the whole uncommitted segment pending through cancellation, then forms it once after reopening", async () => {
    const file = disk();
    const input = episode();
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const current = open(file, "v17", (value, execution, signal) => {
      if (!value.validationFeedback)
        return segment(value, execution, signal).then((batch) => ({
          ...batch,
          units: [
            ...batch.units,
            {
              ...batch.units[0]!,
              citations: [
                { sourceId: value.episode.sources[0]!.id, quote: "没有这句" },
              ],
            },
          ],
        }));
      enter();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    const ref = current.memory.enqueueEpisode(formationIntake(input));
    const controller = new AbortController();
    const pending = current.memory.formEpisode(ref.workId, controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    const before = current.repository.formation.work(ref.workId);
    expect(before.status).toBe("pending");
    expect(before.result).toMatchObject({
      cursor: { ordinal: 0, start: 0 },
      changes: [],
    });
    expect(
      current.database.prepare("SELECT count(*) n FROM memories").get(),
    ).toEqual({ n: 0 });
    current.database.close();
    const next = open(file, "v17", segment);
    next.maintenance.start();
    await next.maintenance.idle();
    expect(next.repository.formation.work(ref.workId)).toMatchObject({
      status: "complete",
      attempt: 2,
    });
    expect(
      next.database.prepare("SELECT count(*) n FROM memories").get(),
    ).toEqual({ n: 1 });
    expect(next.form).toHaveBeenCalledOnce();
    const replay = await next.memory.formEpisode(ref.workId);
    expect(replay.replayed).toBe(true);
    expect(next.form).toHaveBeenCalledOnce();
    await next.maintenance.shutdown();
  });
});

describe("active revision changes through the existing Formation owners", () => {
  it.each(["tool", "maintenance"] as const)(
    "continues the actual %s owner without re-enqueueing at a constant clock",
    async (owner) => {
      const file = disk();
      const current = open(file, "same-processor", segment);
      const seed = current.memory.enqueueEpisode(
        formationIntake(episode("原来的出发安排。")),
      );
      const target = (await current.memory.formEpisode(seed.workId))
        .changes[0]!;
      const input = {
        ...episode("我们后来决定改天出发。"),
        availableMemoryReferences: [
          {
            memoryId: target.memoryId,
            revisionId: target.revisionId,
            use: "current" as const,
          },
        ],
      };
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      current.form.mockClear();
      current.form.mockImplementation(async (value, execution, signal) => {
        calls += 1;
        const item = value.existing.find(
          ({ memoryId }) => memoryId === target.memoryId,
        )!;
        if (calls === 1) {
          enter();
          await released;
        }
        const batch = await segment(value, execution, signal);
        const unit = batch.units[0]!;
        if (unit.operation === "support")
          throw new Error("Expected content fixture");
        return {
          entities: [],
          units: [
            {
              ...unit,
              operation: "revise" as const,
              targetRevisionId: item.revisionId,
              retainedCitations: [],
              priorDispositions: [
                {
                  scope: "revision" as const,
                  revisionId: item.revisionId,
                  disposition: "retained_history" as const,
                  sourceId: value.episode.sources[0]!.id,
                  quote: value.episode.sources[0]!.content,
                },
              ],
            },
          ],
        };
      });
      const ref = current.memory.enqueueEpisode(formationIntake(input));
      const controller = new AbortController();
      const toolResult =
        owner === "tool"
          ? recordTool(current.memory, input).execute(controller.signal)
          : undefined;
      if (owner === "maintenance") current.maintenance.start();
      try {
        await entered;
        const old = current.repository.recall.evidence(
          [target.revisionId],
          clock.now(),
        )[0]!;
        const replacementId = randomUUID();
        current.repository.revise({
          memoryId: target.memoryId,
          predecessorRevisionId: target.revisionId,
          priorDispositions: [
            { revisionId: target.revisionId, disposition: "retained_history" },
          ],
          revisionId: replacementId,
          content: "另一条已提交的当前出发安排。",
          sources: [],
          reason: "Concurrent repository update",
          now: clock.now(),
        });
        current.repository.recall.putSemantics(
          replacementId,
          old.semantics!,
          old.entityIds,
        );
        expect(
          current.database
            .prepare(
              "SELECT count(*) n FROM memory_search_chunks WHERE revision_id=?",
            )
            .get(replacementId),
        ).toEqual({ n: 0 });
        release();
        if (toolResult) {
          const result = await toolResult;
          expect(result.status).toBe("success");
          expect(result.modelContent).toMatchObject({
            storage: "source_and_revision_committed",
          });
        } else await current.maintenance.idle();
        expect(current.onError).not.toHaveBeenCalled();
        expect(current.form).toHaveBeenCalledTimes(2);
        expect(current.form.mock.calls[1]![0].existing).toContainEqual(
          expect.objectContaining({ revisionId: replacementId }),
        );
        expect(current.repository.formation.work(ref.workId)).toMatchObject({
          status: "complete",
          attempt: 1,
          processorVersion: "same-processor",
        });
        expect(
          current.repository.requireDetail(target.memoryId).revisions,
        ).toHaveLength(3);
        expect([...current.memory.pendingFormationWork()]).toEqual([]);
      } finally {
        controller.abort();
        release();
        if (toolResult) await Promise.allSettled([toolResult]);
        await current.maintenance.shutdown();
      }
    },
  );

  it("preserves committed source progress when a re-read is cancelled, then resumes after same-processor disk reopen", async () => {
    const file = disk();
    const current = open(file, "same-processor", segment);
    const seed = current.memory.enqueueEpisode(
      formationIntake(episode("此前的旅程安排。")),
    );
    const target = (await current.memory.formEpisode(seed.workId)).changes[0]!;
    const input = {
      ...episode("这次长谈继续记录我们各段真实来源。\n".repeat(140)),
      availableMemoryReferences: [
        {
          memoryId: target.memoryId,
          revisionId: target.revisionId,
          use: "current" as const,
        },
      ],
    };
    let enter!: () => void, release!: () => void, reread!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rereading = new Promise<void>((resolve) => {
      reread = resolve;
    });
    let replacementId: string | undefined;
    let held = false;
    current.form.mockImplementation(async (value, execution, signal) => {
      const batch = await segment(value, execution, signal);
      if (value.sourceWindows![0]!.start === 0) {
        const unit = batch.units[0]!;
        if (unit.operation === "support")
          throw new Error("Expected content fixture");
        unit.content = "本次长谈的首个已提交片段。";
        return batch;
      }
      const item = value.existing.find(
        ({ memoryId }) => memoryId === target.memoryId,
      )!;
      if (item.revisionId === replacementId) {
        reread();
        return new Promise((_resolve, reject) =>
          signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      }
      if (!held) {
        held = true;
        enter();
        await released;
      }
      return {
        entities: [],
        units: [
          {
            operation: "support" as const,
            targetRevisionId: item.revisionId,
            citations: [
              {
                sourceId: value.episode.sources[0]!.id,
                quote: value.episode.sources[0]!.content,
              },
            ],
            links: [],
          },
        ],
      };
    });
    const ref = current.memory.enqueueEpisode(formationIntake(input));
    const controller = new AbortController();
    const pending = current.memory.formEpisode(ref.workId, controller.signal);
    try {
      await entered;
      const progress = current.repository.formation.work(ref.workId).result as {
        cursor: { ordinal: number; start: number };
        changes: { revisionId: string }[];
      };
      expect(progress.cursor.start).toBeGreaterThan(0);
      expect(progress.changes).toHaveLength(1);
      const prefix = current.database
        .prepare("SELECT * FROM memory_revisions WHERE id=?")
        .get(progress.changes[0]!.revisionId);
      const old = current.repository.recall.evidence(
        [target.revisionId],
        clock.now(),
      )[0]!;
      replacementId = randomUUID();
      const source = input.sources[0]!;
      current.repository.revise({
        memoryId: target.memoryId,
        predecessorRevisionId: target.revisionId,
        priorDispositions: [
          { revisionId: target.revisionId, disposition: "retained_history" },
        ],
        revisionId: replacementId,
        content: "并发写入已处理同一原始长谈的新安排。",
        sources: [
          {
            id: source.id,
            type: source.type,
            referenceId: source.referenceId,
            createdAt: source.occurredAt,
          },
        ],
        reason: "Concurrent source-backed revision",
        now: clock.now(),
      });
      current.repository.recall.putSemantics(
        replacementId,
        old.semantics!,
        old.entityIds,
      );
      release();
      await rereading;
      controller.abort();
      await expect(pending).rejects.toBe(controller.signal.reason);
      expect(current.repository.formation.work(ref.workId)).toMatchObject({
        status: "pending",
        attempt: 1,
        result: { cursor: progress.cursor, changes: progress.changes },
      });
      expect(
        current.database
          .prepare("SELECT * FROM memory_revisions WHERE id=?")
          .get(progress.changes[0]!.revisionId),
      ).toEqual(prefix);
      current.database.close();
      const next = open(file, "same-processor", segment);
      next.maintenance.start();
      try {
        await next.maintenance.idle();
        expect(next.onError).not.toHaveBeenCalled();
        expect(next.repository.formation.work(ref.workId)).toMatchObject({
          status: "complete",
          attempt: 2,
          processorVersion: "same-processor",
        });
        expect(next.form.mock.calls[0]![0].sourceWindows![0]!.start).toBe(
          progress.cursor.start,
        );
        expect(next.form.mock.calls[0]![0].existing).toContainEqual(
          expect.objectContaining({ revisionId: replacementId }),
        );
        expect(
          next.form.mock.calls.every(
            ([value]) =>
              value.sourceWindows![0]!.start >= progress.cursor.start,
          ),
        ).toBe(true);
        expect(
          next.database
            .prepare("SELECT * FROM memory_revisions WHERE id=?")
            .get(progress.changes[0]!.revisionId),
        ).toEqual(prefix);
      } finally {
        await next.maintenance.shutdown();
      }
    } finally {
      controller.abort();
      release();
      await Promise.allSettled([pending]);
      await current.maintenance.shutdown();
    }
  });
});
