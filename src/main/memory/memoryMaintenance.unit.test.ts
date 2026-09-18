import {
  formationRuntime,
  formationResourceBudget,
  type FormationModelMock,
} from "../../../tests/fixtures/formationModel";
import { searchMemoryVectors } from "./memoryVectorSearch";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formationIntake,
  type FormationFixture,
} from "../../../tests/fixtures/memoryFormation";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { openApplicationDatabase } from "../db/database";
import { LexicalRetrievalPipeline } from "./lexicalRetrievalPipeline";
import { MemoryMaintenance } from "./memoryMaintenance";
import type { MemoryEmbeddingProvider } from "./memoryModels";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(reclaimSources?: (signal: AbortSignal) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "memory-maintenance-"));
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  cleanups.push(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const repository = new MemoryRepository(database);
  const clock = { now: () => "2026-09-15T12:00:00.000Z" };
  const form = vi.fn<FormationModelMock["form"]>(() =>
    Promise.resolve({ entities: [], units: [] }),
  );
  const model: FormationModelMock = {
    version: "maintenance-fixture-v1",
    form,
  };
  const embedDocuments = vi.fn<MemoryEmbeddingProvider["embedDocuments"]>(
    (texts) => Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
  );
  const memory = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(database, repository, clock),
    new CryptoIdGenerator(),
    clock,
    {
      embedding: {
        modelKey: "maintenance-numeric-fixture",
        dimensions: 2,
        splitDocument: (text) => Promise.resolve([text]),
        embedDocuments,
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
      formation: formationRuntime(model),
      formationResourceBudget,
      formationContextBudget: () => ({ maxTokens: 8000 }),
    },
  );
  const onError = vi.fn();
  const maintenance = new MemoryMaintenance(memory, {
    onError,
    ...(reclaimSources ? { reclaimSources } : {}),
  });
  memory.setChangedListener(() => maintenance.wake());
  const episode = (): FormationFixture => ({
    id: randomUUID(),
    version: "1",
    recordedAt: clock.now(),
    sources: [
      {
        id: randomUUID(),
        referenceId: randomUUID(),
        type: "chat",
        speaker: "user",
        content: "今天聊了聊",
        occurredAt: clock.now(),
      },
    ],
  });
  return {
    database,
    repository,
    clock,
    memory,
    maintenance,
    form,
    model,
    embedDocuments,
    onError,
    episode,
  };
}
describe("Event-driven memory maintenance", () => {
  it("projects immutable formation sources once and removes only deleted work references", () => {
    const f = fixture();
    const episode = f.episode();
    episode.sources[0]!.type = "activity_event";
    episode.sources.push(f.episode().sources[0]!);
    f.memory.enqueueEpisode(formationIntake(episode));
    f.memory.enqueueEpisode(formationIntake(episode));
    const work = f.database
      .prepare("SELECT id,payload_json FROM memory_work WHERE subject_id=?")
      .get(episode.id) as {
      id: string;
      payload_json: string;
    };
    const projections = f.database
      .prepare("SELECT * FROM memory_work_sources ORDER BY work_id,ordinal")
      .all();
    expect(projections).toEqual(
      episode.sources.map((source, ordinal) => ({
        work_id: work.id,
        ordinal,
        source_id: source.id,
        is_primary: 1,
        occurred_at: source.occurredAt,
      })),
    );
    expect(() =>
      f.memory.enqueueEpisode(
        formationIntake({
          ...episode,
          sources: [{ ...episode.sources[0]!, content: "替换同版本原文" }],
        }),
      ),
    ).toThrow("reused for different source uses");
    expect(
      f.database
        .prepare("SELECT payload_json FROM memory_work WHERE id=?")
        .get(work.id),
    ).toEqual({ payload_json: work.payload_json });
    expect(
      f.database
        .prepare("SELECT * FROM memory_work_sources ORDER BY work_id,ordinal")
        .all(),
    ).toEqual(projections);
    const duplicate = { ...episode, id: randomUUID() };
    f.memory.enqueueEpisode(formationIntake(duplicate));
    f.database.prepare("DELETE FROM memory_work WHERE id=?").run(work.id);
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM memory_work_sources")
        .get(),
    ).toEqual({ count: episode.sources.length });
    expect(
      f.memory.getFormationSource(
        "activity_event",
        episode.sources[0]!.referenceId,
      ),
    ).toEqual(episode.sources[0]);
    f.database
      .prepare("DELETE FROM memory_work WHERE subject_id=?")
      .run(duplicate.id);
    expect(
      f.database
        .prepare("SELECT * FROM memory_work_sources ORDER BY work_id,ordinal")
        .all(),
    ).toEqual([]);
    expect(
      f.memory.getFormationSource(
        "activity_event",
        episode.sources[0]!.referenceId,
      ),
    ).toEqual(episode.sources[0]);
    // Canonical originals have their own lifecycle; deleting a work reference
    // cannot silently delete a source that a revision may still cite.
    f.database
      .prepare("DELETE FROM memory_sources WHERE id=?")
      .run(episode.sources[0]!.id);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) n FROM memory_source_text_chunks WHERE source_id=?",
        )
        .get(episode.sources[0]!.id),
    ).toEqual({ n: 0 });
  });
  it("rolls back source intake if its source reference projection cannot commit", () => {
    const f = fixture();
    f.database.exec(`CREATE TEMP TRIGGER reject_source_projection
      BEFORE INSERT ON memory_work_sources WHEN NEW.ordinal=1
      BEGIN SELECT RAISE(ABORT,'source projection unavailable'); END`);
    const episode = f.episode();
    episode.sources.push(f.episode().sources[0]!);
    expect(() => f.memory.enqueueEpisode(formationIntake(episode))).toThrow(
      "source projection unavailable",
    );
    expect(
      f.database.prepare("SELECT * FROM memory_work WHERE kind='form'").all(),
    ).toEqual([]);
    expect(
      f.database
        .prepare("SELECT * FROM memory_work_sources ORDER BY work_id,ordinal")
        .all(),
    ).toEqual([]);
    f.database.exec("DROP TRIGGER reject_source_projection");
    f.memory.enqueueEpisode(formationIntake(episode));
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM memory_work_sources")
        .get(),
    ).toEqual({ count: 2 });
  });
  it("returns only unambiguous candidates in a mixed batch of canonical Activity references", () => {
    const f = fixture();
    const episode = f.episode();
    episode.sources[0]!.type = "activity_event";
    const stable = {
      ...episode.sources[0]!,
      id: randomUUID(),
      referenceId: randomUUID(),
    };
    episode.sources.push(stable);
    f.memory.enqueueEpisode(formationIntake(episode));
    const conflicting = {
      ...episode.sources[0]!,
      id: randomUUID(),
      content: "同引用的不同原文",
    };
    f.memory.enqueueEpisode(
      formationIntake({
        ...episode,
        id: randomUUID(),
        sources: [conflicting],
      }),
    );
    const candidates = [
      stable.referenceId,
      conflicting.referenceId,
      randomUUID(),
      stable.referenceId,
    ];
    expect(f.memory.snapshottedActivitySourceIds(candidates)).toEqual(
      new Set([stable.referenceId]),
    );
    expect(f.memory.protectedActivitySourceIds(candidates)).toEqual(
      new Set([stable.referenceId, conflicting.referenceId]),
    );
    expect(
      f.memory.getFormationSource("activity_event", conflicting.referenceId),
    ).toBeUndefined();
  });
  it("checks one complete superset for a source in a shared Chat with no situation", async () => {
    const f = fixture();
    const episode = f.episode();
    const chatId = episode.sources[0]!.referenceId;
    episode.sources.push({ ...f.episode().sources[0]!, referenceId: chatId });
    f.form.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      f.memory.formEpisode(
        f.memory.enqueueEpisode(formationIntake(episode)).workId,
      ),
    ).rejects.toThrow("provider unavailable");
    for (let index = 0; index < 3; index++)
      await f.memory.formEpisode(
        f.memory.enqueueEpisode(
          formationIntake({
            ...episode,
            id: randomUUID(),
            sources: [{ ...f.episode().sources[0]!, referenceId: chatId }],
          }),
        ).workId,
      );
    const plan = {
      purpose: "conversation" as const,
      query: "聊了什么",
      questions: [],
      contextBudget: { maxTokens: 8192 },
    };
    expect((await f.memory.recall(plan)).incompleteReasons).toContain(
      "部分经历尚未形成可检索记忆",
    );
    await f.memory.formEpisode(
      f.memory.enqueueEpisode(
        formationIntake({
          ...episode,
          id: randomUUID(),
          sources: [...episode.sources].reverse(),
        }),
      ).workId,
    );
    expect((await f.memory.recall(plan)).incompleteReasons).toEqual([]);
    // Chat references identify a conversation, so they cannot recover one
    // arbitrary message when the reference has several canonical sources.
    expect(f.memory.getFormationSource("chat", chatId)).toBeUndefined();
  });
  it("clears only the processing gap when one complete canonical superset covers a failed episode", async () => {
    const f = fixture();
    const episode = f.episode();
    episode.personaId = randomUUID();
    episode.situationId = randomUUID();
    episode.sources[0]!.type = "activity_event";
    episode.sources[0]!.speaker = "environment";
    f.form.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      f.memory.formEpisode(
        f.memory.enqueueEpisode(formationIntake(episode)).workId,
      ),
    ).rejects.toThrow("provider unavailable");
    const failure = f.database
      .prepare("SELECT * FROM memory_work WHERE subject_id=?")
      .get(episode.id);
    const plan = {
      purpose: "conversation" as const,
      query: "今天聊了什么",
      questions: [],
      personaId: episode.personaId,
      contextBudget: { maxTokens: 8192 },
    };
    expect((await f.memory.recall(plan)).incompleteReasons).toContain(
      "部分经历尚未形成可检索记忆",
    );
    expect(
      f.memory.protectedActivitySourceIds([episode.sources[0]!.referenceId]),
    ).toEqual(new Set([episode.sources[0]!.referenceId]));
    const superset = {
      ...episode,
      id: randomUUID(),
      sources: [...episode.sources, f.episode().sources[0]!],
    };
    const result = await f.memory.formEpisode(
      f.memory.enqueueEpisode(formationIntake(superset)).workId,
    );
    expect(result.changes).toEqual([]);
    expect((await f.memory.recall(plan)).incompleteReasons).toEqual([]);
    expect(
      f.memory.protectedActivitySourceIds([episode.sources[0]!.referenceId]),
    ).toEqual(new Set());
    expect(
      f.database
        .prepare("SELECT * FROM memory_work WHERE subject_id=?")
        .get(episode.id),
    ).toEqual(failure);
    // An empty valid extraction still processed its sources; it does not prove
    // that any fact was remembered, and the original failed task stays failed.
    expect(f.memory.list({}).memories).toEqual([]);
  });
  it.each([
    "id",
    "referenceId",
    "type",
    "speaker",
    "content",
    "occurredAt",
    "personaId",
    "situationId",
  ] as const)(
    "keeps a failed source gap when completed work differs in %s",
    async (field) => {
      const f = fixture();
      const episode = f.episode();
      episode.personaId = randomUUID();
      episode.situationId = randomUUID();
      episode.sources[0]!.type = "activity_event";
      episode.sources[0]!.speaker = "environment";
      f.form.mockRejectedValueOnce(new Error("provider unavailable"));
      await expect(
        f.memory.formEpisode(
          f.memory.enqueueEpisode(formationIntake(episode)).workId,
        ),
      ).rejects.toThrow("provider unavailable");
      const completed = {
        ...episode,
        id: randomUUID(),
        sources: episode.sources.map((source) => ({ ...source })),
      };
      switch (field) {
        case "personaId":
          completed.personaId = randomUUID();
          break;
        case "situationId":
          completed.situationId = randomUUID();
          break;
        case "id":
          completed.sources[0]!.id = randomUUID();
          break;
        case "referenceId":
          completed.sources[0]!.referenceId = randomUUID();
          break;
        case "type":
          completed.sources[0]!.type = "activity";
          break;
        case "speaker":
          completed.sources[0]!.speaker = "user";
          break;
        case "content":
          completed.sources[0]!.content = "修改后的原始材料";
          break;
        case "occurredAt":
          completed.sources[0]!.occurredAt = "2026-09-14T12:00:00.000Z";
          break;
      }
      if (!["id", "personaId", "situationId"].includes(field)) {
        expect(() =>
          f.repository.formation.registerSource(completed.sources[0]!),
        ).toThrow("reused");
        completed.sources[0]!.id = randomUUID();
      }
      await f.memory.formEpisode(
        f.memory.enqueueEpisode(formationIntake(completed)).workId,
      );
      expect(
        (
          await f.memory.recall({
            purpose: "conversation",
            query: "今天聊了什么",
            questions: [],
            personaId: episode.personaId,
            contextBudget: { maxTokens: 8192 },
          })
        ).incompleteReasons,
      ).toContain("部分经历尚未形成可检索记忆");
      expect(
        f.memory.protectedActivitySourceIds([episode.sources[0]!.referenceId]),
      ).toEqual(new Set([episode.sources[0]!.referenceId]));
    },
  );
  it("does not treat context-only processing as coverage of failed primary sources", async () => {
    const f = fixture();
    const episode = f.episode();
    episode.personaId = randomUUID();
    episode.situationId = randomUUID();
    episode.sources[0]!.type = "activity_event";
    episode.sources[0]!.speaker = "environment";
    const context = f.episode().sources[0]!;
    episode.sources.push(context);
    episode.evidenceSourceIds = [episode.sources[0]!.id];
    f.form.mockRejectedValueOnce(new Error("formation failed"));
    await expect(
      f.memory.formEpisode(
        f.memory.enqueueEpisode(formationIntake(episode)).workId,
      ),
    ).rejects.toThrow("formation failed");
    const failure = f.database
      .prepare("SELECT * FROM memory_work WHERE subject_id=?")
      .get(episode.id);
    await f.memory.formEpisode(
      f.memory.enqueueEpisode(
        formationIntake({
          ...episode,
          id: randomUUID(),
          evidenceSourceIds: [context.id],
        }),
      ).workId,
    );
    const plan = {
      purpose: "conversation" as const,
      query: "经历",
      questions: [],
      personaId: episode.personaId,
      contextBudget: { maxTokens: 8192 },
    };
    expect((await f.memory.recall(plan)).incompleteReasons).toContain(
      "部分经历尚未形成可检索记忆",
    );
    expect(
      f.memory.protectedActivitySourceIds([episode.sources[0]!.referenceId]),
    ).toEqual(new Set([episode.sources[0]!.referenceId]));
    await f.memory.formEpisode(
      f.memory.enqueueEpisode(formationIntake({ ...episode, id: randomUUID() }))
        .workId,
    );
    expect((await f.memory.recall(plan)).incompleteReasons).toEqual([]);
    expect(
      f.memory.protectedActivitySourceIds([episode.sources[0]!.referenceId]),
    ).toEqual(new Set());
    expect(
      f.database
        .prepare("SELECT * FROM memory_work WHERE subject_id=?")
        .get(episode.id),
    ).toEqual(failure);
  });
  it("does not assemble processing coverage from separately completed source subsets", async () => {
    const f = fixture();
    const episode = f.episode();
    episode.sources[0]!.type = "activity_event";
    episode.sources.push(f.episode().sources[0]!);
    f.form.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      f.memory.formEpisode(
        f.memory.enqueueEpisode(formationIntake(episode)).workId,
      ),
    ).rejects.toThrow("provider unavailable");
    for (const source of episode.sources)
      await f.memory.formEpisode(
        f.memory.enqueueEpisode(
          formationIntake({
            ...episode,
            id: randomUUID(),
            sources: [source],
          }),
        ).workId,
      );
    expect(
      f.memory.protectedActivitySourceIds([episode.sources[0]!.referenceId]),
    ).toEqual(new Set([episode.sources[0]!.referenceId]));
    expect(
      (
        await f.memory.recall({
          purpose: "conversation",
          query: "今天聊了什么",
          questions: [],
          contextBudget: { maxTokens: 8192 },
        })
      ).incompleteReasons,
    ).toContain("部分经历尚未形成可检索记忆");
  });
  it("does not exempt pending or running formation even when an earlier complete job has identical sources", async () => {
    const f = fixture();
    const episode = f.episode();
    episode.sources[0]!.type = "activity_event";
    await f.memory.formEpisode(
      f.memory.enqueueEpisode(formationIntake({ ...episode, id: randomUUID() }))
        .workId,
    );
    f.memory.enqueueEpisode(formationIntake(episode));
    const referenceId = episode.sources[0]!.referenceId;
    expect(f.memory.protectedActivitySourceIds([referenceId])).toEqual(
      new Set([referenceId]),
    );
    const running = deferred();
    f.form.mockImplementationOnce(
      (_input, _execution, signal) =>
        new Promise((_resolve, reject) => {
          running.resolve();
          signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const abort = new AbortController();
    const operation = f.memory.formEpisode(
      f.memory.enqueueEpisode(formationIntake(episode)).workId,
      abort.signal,
    );
    await running.promise;
    expect(f.memory.protectedActivitySourceIds([referenceId])).toEqual(
      new Set([referenceId]),
    );
    expect(
      (
        await f.memory.recall({
          purpose: "conversation",
          query: "今天聊了什么",
          questions: [],
          contextBudget: { maxTokens: 8192 },
        })
      ).incompleteReasons,
    ).toContain("部分经历尚未形成可检索记忆");
    abort.abort();
    await expect(operation).rejects.toThrow("aborted");
  });
  it("indexes committed CRUD while a model formation is blocked without parallel or duplicate encoding", async () => {
    const f = fixture();
    const forming = deferred();
    const releaseFormation = deferred();
    f.form.mockImplementationOnce(async () => {
      forming.resolve();
      await releaseFormation.promise;
      return { entities: [], units: [] };
    });
    const encoding = deferred();
    const releaseEncoding = deferred();
    f.embedDocuments.mockImplementationOnce(async (texts) => {
      encoding.resolve();
      await releaseEncoding.promise;
      return texts.map(() => new Float32Array([1, 0]));
    });
    f.maintenance.enqueueEpisode(formationIntake(f.episode()));
    f.maintenance.start();
    await forming.promise;
    const created = f.memory.create({
      type: "event",
      content: "今天一起做了南瓜汤",
      confidence: 1,
      importance: 0.5,
      reason: "user edit",
      sources: [],
    });
    await encoding.promise;
    f.maintenance.wake();
    f.maintenance.wake();
    const indexComplete = f.memory.indexPending();
    releaseEncoding.resolve();
    await indexComplete;
    expect(
      f.database
        .prepare(
          `SELECT c.revision_id FROM memory_chunk_embeddings e
      JOIN memory_search_chunks c ON c.id=e.chunk_id`,
        )
        .get(),
    ).toMatchObject({
      revision_id: created.memory.currentRevisionId,
    });
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "running" });
    expect(f.embedDocuments).toHaveBeenCalledTimes(1);
    releaseFormation.resolve();
    await f.maintenance.idle();
    expect(f.form).toHaveBeenCalledTimes(1);
    expect(f.embedDocuments).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
    await f.maintenance.shutdown();
  });
  it("recovers the complete canonical Activity source after raw cleanup and accepts only consistent snapshots", async () => {
    const f = fixture();
    const episode = f.episode();
    const source = episode.sources[0]!;
    source.type = "activity_event";
    source.speaker = "environment";
    source.id = source.referenceId;
    const details = {
      source: "active_app",
      appName: "TextEdit",
      windowTitle: "夜班安排",
      content: {
        source: "accessibility",
        scope: "viewport",
        text: "周五夜班，小陈代班。",
      },
    };
    source.content = JSON.stringify({
      id: source.id,
      actor: "user",
      startedAt: source.occurredAt,
      details,
    });
    f.database
      .prepare(
        `INSERT INTO activity_events
      (id,actor,source,details_json,started_at,created_at)
      VALUES (?,'user','active_app',?,?,?)`,
      )
      .run(
        source.id,
        JSON.stringify(details),
        source.occurredAt,
        source.occurredAt,
      );
    f.maintenance.enqueueEpisode(formationIntake(episode));
    f.maintenance.enqueueEpisode(
      formationIntake({ ...episode, id: randomUUID() }),
    );
    const candidates = [source.referenceId, source.referenceId, randomUUID()];
    expect(f.memory.snapshottedActivitySourceIds(candidates)).toEqual(
      new Set([source.referenceId]),
    );
    f.maintenance.start();
    await f.maintenance.idle();
    f.database.prepare("DELETE FROM activity_events WHERE id=?").run(source.id);
    expect(
      f.memory.getFormationSource("activity_event", source.referenceId),
    ).toEqual(source);
    expect(
      f.memory.getFormationSource("activity", source.referenceId),
    ).toBeUndefined();
    expect(
      f.memory.getFormationSource("activity_event", randomUUID()),
    ).toBeUndefined();
    expect(f.memory.snapshottedActivitySourceIds(candidates)).toEqual(
      new Set([source.referenceId]),
    );
    expect(f.memory.snapshottedActivitySourceIds([])).toEqual(new Set());
    await f.maintenance.shutdown();
  });
  it.each(["id", "speaker", "content", "occurredAt"] as const)(
    "does not release an Activity source with inconsistent %s snapshots",
    (field) => {
      const f = fixture();
      const episode = f.episode();
      const source = episode.sources[0]!;
      source.type = "activity_event";
      source.speaker = "environment";
      f.memory.enqueueEpisode(formationIntake(episode));
      const conflicting = {
        ...source,
        id: randomUUID(),
        [field]: {
          id: randomUUID(),
          speaker: "user",
          content: "另一个原文",
          occurredAt: "2026-09-14T12:00:00.000Z",
        }[field],
      };
      f.memory.enqueueEpisode(
        formationIntake({
          ...episode,
          id: randomUUID(),
          sources: [conflicting],
        }),
      );
      expect(
        f.memory.getFormationSource("activity_event", source.referenceId),
      ).toBeUndefined();
      expect(
        f.memory.snapshottedActivitySourceIds([source.referenceId]),
      ).toEqual(new Set());
    },
  );
  it("does not report a malformed stored snapshot as recoverable", () => {
    const f = fixture();
    const episode = f.episode();
    episode.sources[0]!.type = "activity_event";
    f.memory.enqueueEpisode(formationIntake(episode));
    f.database
      .prepare(`UPDATE memory_sources SET created_at='invalid-timestamp'`)
      .run();
    const referenceId = episode.sources[0]!.referenceId;
    expect(
      f.memory.getFormationSource("activity_event", referenceId),
    ).toBeUndefined();
    expect(f.memory.snapshottedActivitySourceIds([referenceId])).toEqual(
      new Set(),
    );
  });
  it("protects requested raw Activity references while queued, running or failed and releases completed work", async () => {
    const f = fixture();
    const episode = f.episode();
    episode.sources[0]!.type = "activity_event";
    episode.sources[0]!.speaker = "environment";
    const eventId = episode.sources[0]!.referenceId;
    const otherEvent = randomUUID();
    const digestId = randomUUID();
    episode.sources.push(
      { ...episode.sources[0]!, id: randomUUID(), referenceId: otherEvent },
      {
        ...episode.sources[0]!,
        id: randomUUID(),
        referenceId: digestId,
        type: "activity",
      },
    );
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let fail!: (error: Error) => void;
    f.form.mockImplementationOnce(() => {
      started();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    f.maintenance.enqueueEpisode(formationIntake(episode));
    const requested = [
      eventId,
      eventId,
      digestId,
      episode.sources[0]!.id,
      randomUUID(),
    ];
    expect(f.memory.protectedActivitySourceIds(requested)).toEqual(
      new Set([eventId]),
    );
    expect(f.memory.protectedActivitySourceIds([])).toEqual(new Set());
    f.maintenance.start();
    await running;
    expect(f.memory.protectedActivitySourceIds(requested)).toEqual(
      new Set([eventId]),
    );
    fail(new Error("formation unavailable"));
    await f.maintenance.idle();
    expect(f.memory.protectedActivitySourceIds(requested)).toEqual(
      new Set([eventId]),
    );
    f.maintenance.retry();
    await f.maintenance.idle();
    expect(f.memory.protectedActivitySourceIds([eventId, otherEvent])).toEqual(
      new Set(),
    );
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "complete" });
    await f.maintenance.shutdown();
  });
  it("persists intake before scheduling, serially replays once, and indexes manual CRUD after a wake", async () => {
    const f = fixture();
    const episode = f.episode();
    f.maintenance.enqueueEpisode(formationIntake(episode));
    expect(f.form).not.toHaveBeenCalled();
    expect(
      f.database
        .prepare(
          "SELECT status,payload_json FROM memory_work WHERE kind='form'",
        )
        .get(),
    ).toMatchObject({
      status: "pending",
      payload_json: JSON.stringify(formationIntake(episode).episode),
    });
    f.maintenance.start();
    await f.maintenance.idle();
    f.maintenance.enqueueEpisode(formationIntake(episode));
    await f.maintenance.idle();
    expect(f.form).toHaveBeenCalledTimes(1);
    const created = f.memory.create({
      type: "event",
      content: "昨天一起看流星",
      confidence: 1,
      importance: 0.5,
      reason: "user edit",
      sources: [],
    });
    await f.maintenance.idle();
    expect(
      f.database
        .prepare(
          "SELECT c.revision_id FROM memory_chunk_embeddings e JOIN memory_search_chunks c ON c.id=e.chunk_id",
        )
        .get(),
    ).toMatchObject({ revision_id: created.memory.currentRevisionId });
    expect(f.onError).not.toHaveBeenCalled();
    await f.maintenance.shutdown();
  });
  it("does not retry failed work on wake or restart and resumes on the configuration retry event", async () => {
    const f = fixture();
    f.form.mockRejectedValueOnce(new Error("provider unavailable"));
    f.maintenance.enqueueEpisode(formationIntake(f.episode()));
    f.maintenance.start();
    await f.maintenance.idle();
    expect(f.form).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "failed" });
    f.maintenance.wake();
    await f.maintenance.idle();
    expect(f.form).toHaveBeenCalledTimes(1);
    await f.maintenance.shutdown();
    const restarted = new MemoryMaintenance(f.memory, { onError: f.onError });
    restarted.start();
    await restarted.idle();
    expect(f.form).toHaveBeenCalledTimes(1);
    restarted.retry();
    await restarted.idle();
    expect(f.form).toHaveBeenCalledTimes(2);
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "complete" });
    await restarted.shutdown();
  });
  it("cancels and awaits in-flight formation, preserving pending intake for restart", async () => {
    const f = fixture();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    f.form.mockImplementationOnce(
      (_input, _execution, signal) =>
        new Promise((_resolve, reject) => {
          notifyStarted();
          signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const encoding = deferred();
    f.embedDocuments.mockImplementationOnce(
      (_texts, signal) =>
        new Promise((_resolve, reject) => {
          encoding.resolve();
          signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    f.memory.create({
      type: "event",
      content: "昨天一起看流星",
      confidence: 1,
      importance: 0.5,
      reason: "user edit",
      sources: [],
    });
    f.maintenance.enqueueEpisode(formationIntake(f.episode()));
    f.maintenance.start();
    await Promise.all([started, encoding.promise]);
    await f.maintenance.shutdown();
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "pending" });
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='embed'")
        .get(),
    ).toMatchObject({ status: "pending" });
    expect(f.onError).not.toHaveBeenCalled();
    const restarted = new MemoryMaintenance(f.memory, { onError: f.onError });
    restarted.start();
    await restarted.idle();
    expect(f.form).toHaveBeenCalledTimes(2);
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE kind='form'")
        .get(),
    ).toMatchObject({ status: "complete" });
    await restarted.shutdown();
  });
  it("consumes a configuration retry after the current work, without retrying a later unrelated failure twice", async () => {
    const f = fixture();
    const first = f.episode(),
      later = f.episode();
    const entered = deferred(),
      release = deferred();
    const seen: string[] = [];
    const events: string[] = [];
    const original = f.memory.retryFailedFormationWork.bind(f.memory);
    const retry = vi.spyOn(f.memory, "retryFailedFormationWork");
    retry.mockImplementation(() => {
      events.push("retry");
      original();
    });
    f.form.mockImplementation(async ({ episode }) => {
      seen.push(episode.id);
      events.push(episode.id);
      if (
        episode.id === first.id &&
        seen.filter((id) => id === first.id).length === 1
      ) {
        entered.resolve();
        await release.promise;
        throw new Error("first in-flight failure");
      }
      if (episode.id === later.id) throw new Error("later unrelated failure");
      return { entities: [], units: [] };
    });
    f.maintenance.enqueueEpisode(formationIntake(first));
    f.maintenance.start();
    await entered.promise;
    f.maintenance.enqueueEpisode(formationIntake(later));
    f.maintenance.retry();
    release.resolve();
    await f.maintenance.idle();
    expect(seen.filter((id) => id === first.id)).toHaveLength(2);
    expect(seen.filter((id) => id === later.id)).toHaveLength(1);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(events.slice(0, 3)).toEqual([first.id, "retry", "retry"]);
    expect(
      f.database
        .prepare("SELECT status FROM memory_work WHERE subject_id=?")
        .get(later.id),
    ).toEqual({ status: "failed" });
    f.maintenance.wake();
    await f.maintenance.idle();
    expect(seen.filter((id) => id === later.id)).toHaveLength(1);
    await f.maintenance.shutdown();
  });

  it("persists the retry of already failed work even when closed before the lane starts", async () => {
    const f = fixture();
    const episode = f.episode();
    const ref = f.memory.enqueueEpisode(formationIntake(episode));
    f.repository.formation.failPending(
      ref.workId,
      "prior_failure",
      "2026-09-15T12:00:00.000Z",
    );
    f.maintenance.retry();
    expect(f.repository.formation.work(ref.workId).status).toBe("pending");
    await f.maintenance.shutdown();
    const restarted = new MemoryMaintenance(f.memory, { onError: f.onError });
    restarted.start();
    await restarted.idle();
    expect(f.form).toHaveBeenCalledOnce();
    expect(f.repository.formation.work(ref.workId).status).toBe("complete");
    await restarted.shutdown();
  });
});

describe("event-driven canonical source release", () => {
  it("wakes release after zero-change formation and does not wait for a later blocked work", async () => {
    const release = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      let id: string | undefined;
      for (;;) {
        const candidate = f.memory.nextReclaimableSource(id);
        if (!candidate) break;
        id = candidate.id;
        f.memory.releaseCanonicalSource(id);
      }
      await Promise.resolve();
    });
    const f: ReturnType<typeof fixture> = fixture(release);
    const first = f.episode(),
      second = f.episode();
    second.recordedAt = "2026-09-15T13:00:00.000Z";
    f.memory.enqueueEpisode(formationIntake(first));
    // Control the actual queue timestamp; random IDs do not decide work order.
    f.clock.now = () => "2026-09-15T13:00:00.000Z";
    f.memory.enqueueEpisode(formationIntake(second));
    const entered = deferred(),
      continueFormation = deferred();
    f.form.mockImplementation(async ({ episode }) => {
      if (episode.id === second.id) {
        entered.resolve();
        await continueFormation.promise;
      }
      return { entities: [], units: [] };
    });
    f.maintenance.start();
    await entered.promise;
    expect(
      f.memory.getFormationSource(
        first.sources[0]!.type,
        first.sources[0]!.referenceId,
      ),
    ).toBeUndefined();
    expect(
      f.memory.getFormationSource(
        second.sources[0]!.type,
        second.sources[0]!.referenceId,
      ),
    ).toBeDefined();
    expect(f.memory.canonicalStorageStats().releasedSources).toBe(1);
    continueFormation.resolve();
    await f.maintenance.idle();
    expect(f.memory.canonicalStorageStats().releasedSources).toBe(2);
    expect(f.onError).not.toHaveBeenCalled();
    await f.maintenance.shutdown();
  });

  it("coalesces wake requests while release is in flight and includes it in idle", async () => {
    const started = deferred(),
      finish = deferred();
    const release = vi.fn(async () => {
      if (release.mock.calls.length === 1) {
        started.resolve();
        await finish.promise;
      }
    });
    const f = fixture(release);
    f.maintenance.start();
    await started.promise;
    f.maintenance.wake();
    f.maintenance.wake();
    f.maintenance.wake();
    const idle = vi.fn();
    const waiting = f.maintenance.idle().then(idle);
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    finish.resolve();
    await waiting;
    expect(release).toHaveBeenCalledTimes(2);
    await f.maintenance.shutdown();
  });

  it("reports a release failure without a retry loop and preserves failed formation protection", async () => {
    const release = vi.fn(() =>
      Promise.reject(new Error("consumer query failed")),
    );
    const f = fixture(release);
    f.maintenance.start();
    await f.maintenance.idle();
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenLastCalledWith(
      expect.any(Error),
      "source_release",
    );
    f.form.mockRejectedValueOnce(new Error("model failed"));
    const input = f.episode();
    f.maintenance.enqueueEpisode(formationIntake(input));
    await f.maintenance.idle();
    expect(f.memory.releaseCanonicalSource(input.sources[0]!.id)).toBe(false);
    expect(
      f.memory.getFormationSource(
        input.sources[0]!.type,
        input.sources[0]!.referenceId,
      ),
    ).toBeDefined();
    const calls = release.mock.calls.length;
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(calls);
    await f.maintenance.shutdown();
  });

  it("aborts and awaits source release on shutdown without another callback", async () => {
    const started = deferred();
    const release = vi.fn(async (signal: AbortSignal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const f = fixture(release);
    f.maintenance.start();
    await started.promise;
    await f.maintenance.shutdown();
    expect(release.mock.calls[0]![0].aborted).toBe(true);
    f.maintenance.wake();
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
  });
});
