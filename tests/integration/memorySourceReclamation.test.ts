import { randomUUID } from "node:crypto";
import type { CognitionAnalysis } from "../../src/shared/contracts/cognition";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { referencedCognitionState } from "../../src/main/app/canonicalCognitionSources";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openApplicationDatabase } from "../../src/main/db/database";
import { MemoryFormationRepository } from "../../src/main/memory/memoryFormationRepository";
import { CognitionRepository } from "../../src/main/cognition/cognitionRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { RunRepository } from "../../src/main/agent/runRepository";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import { reclaimMemorySources } from "../../src/main/app/memorySourceReclamation";
import { createMemoryFormationIntake } from "../../src/main/app/memoryFormationSources";
import type { MemoryFormationSource } from "../../src/shared/contracts/memoryRecall";
import type { RunItem } from "../../src/shared/contracts/run";
import {
  chatFixture,
  messageFixture,
  runFixture,
} from "../fixtures/foundationContracts";

const now = "2026-09-15T08:00:00.000Z";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const database = openApplicationDatabase(":memory:");
  databases.push(database);
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const personaId = personas.getLibrary().activePersonaId;
  const memory = new MemoryFormationRepository(database);
  const cognition = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  chats.insertChat(chatFixture);
  const run = { ...runFixture, id: randomUUID() };
  runs.appendEvent({
    event: { type: "run.started", run },
    streamId: run.id,
    sequence: 1,
    occurredAt: now,
  });
  let sequence = 1;
  function source(useOutput = false) {
    const message = chats.insertMessage({
      ...messageFixture,
      id: randomUUID(),
      runId: run.id,
      chatId: chatFixture.id,
      content: "我会等杯子晾干再上釉。",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    const item: RunItem = {
      id: randomUUID(),
      runId: run.id,
      sequence: ++sequence,
      kind: "user_message",
      status: "running",
      artifacts: [],
      startedAt: now,
      ...(useOutput
        ? { output: { messageId: message.id } }
        : { input: { messageId: message.id } }),
    };
    runs.appendEvent({
      event: { type: "item.started", item },
      streamId: run.id,
      sequence,
      occurredAt: now,
    });
    runs.appendEvent({
      event: {
        type: "item.completed",
        item: { ...item, status: "completed", endedAt: now },
      },
      streamId: run.id,
      sequence: ++sequence,
      occurredAt: now,
    });
    const original: MemoryFormationSource = {
      id: message.id,
      type: "chat",
      referenceId: message.chatId,
      speaker: "user",
      occurredAt: now,
      content: message.content,
    };
    const intake = createMemoryFormationIntake({
      id: randomUUID(),
      personaId,
      sources: [{ source: original, primary: true }],
      resolveSource: () => original,
    })!;
    const work = memory.enqueue(intake, "retention-fixture", now);
    const execution = memory.startWork(
      work.workId,
      "retention-fixture",
      undefined,
      now,
    )!;
    memory.finish(execution, { changes: [], sourceIds: [original.id] }, now);
    return { original, message, item, intake, work };
  }
  function observe(value: ReturnType<typeof source>) {
    return cognition.ingest(
      {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "utterance",
        source: { kind: "run", id: run.id, fragment: value.item.id },
        observedAt: now,
        text: value.original.content,
      },
      now,
    ).evidence;
  }
  const options = {
    database,
    memory,
    cognition,
    chats,
    runs,
    clock: { now: () => now },
  };
  return {
    ...options,
    personaId,
    run,
    source,
    observe,
    reclaim: (signal = new AbortController().signal) =>
      reclaimMemorySources(options, signal),
  };
}

describe("Memory canonical source reclamation through actual domain ports", () => {
  it.each([false, true])(
    "maps actual Message to Run Item metadata and reclaims only after its consumer settles (output=%s)",
    async (output) => {
      const f = fixture();
      const wanted = f.source(output);
      const unrelated = f.source();
      const evidence = f.observe(wanted);
      const fullRunRead = vi.spyOn(f.runs, "memoryFormationItemReferences");
      const bodyRead = vi.spyOn(f.chats, "getMessage");
      const first = await f.reclaim();
      expect(first).toMatchObject({
        scanned: 2,
        released: 1,
        retained: { unanalysed: 1 },
        interrupted: false,
      });
      expect(f.memory.getSourceMetadata(unrelated.original.id)).toBeDefined();
      expect(
        f.memory.sourceWindow(
          wanted.work.workId,
          wanted.original.id,
          0,
          wanted.original.content.length,
        ),
      ).toBe(wanted.original.content);
      expect(() =>
        f.memory.sourceWindow(
          unrelated.work.workId,
          unrelated.original.id,
          0,
          unrelated.original.content.length,
        ),
      ).toThrow();
      f.cognition.updateAttention(f.personaId, now, (state) => ({
        ...state,
        analyzedThroughSequence: evidence.receiptSequence,
        catalogueReviewedThroughSequence: evidence.receiptSequence,
      }));
      const second = await f.reclaim();
      expect(second).toMatchObject({ scanned: 1, released: 1, retained: {} });
      expect(f.memory.canonicalStorageStats().releasedSources).toBe(2);
      expect(fullRunRead).not.toHaveBeenCalled();
      expect(bodyRead).not.toHaveBeenCalled();
    },
  );

  it("retains a completed original if a new formation work is still using it", async () => {
    const f = fixture();
    const value = f.source();
    const another = f.memory.enqueue(
      {
        ...value.intake,
        episode: { ...value.intake.episode, id: randomUUID() },
      },
      "retention-fixture",
      now,
    );
    expect((await f.reclaim()).released).toBe(0);
    const execution = f.memory.startWork(
      another.workId,
      "retention-fixture",
      undefined,
      now,
    )!;
    f.memory.finish(execution, { changes: [] }, now);
    expect((await f.reclaim()).released).toBe(1);
  });

  it("rolls back the whole source if its release fails and leaves the complete receipt unchanged", async () => {
    const f = fixture();
    const value = f.source();
    const receipt = f.memory.work(value.work.workId);
    const release = f.memory.releaseCanonicalSource.bind(f.memory);
    vi.spyOn(f.memory, "releaseCanonicalSource").mockImplementationOnce(
      (id) => {
        expect(f.database.inTransaction).toBe(true);
        release(id);
        throw new Error("Fixture interruption before transaction commit");
      },
    );
    await expect(f.reclaim()).rejects.toThrow("before transaction commit");
    expect(
      f.memory.sourceWindow(
        value.work.workId,
        value.original.id,
        0,
        value.original.content.length,
      ),
    ).toBe(value.original.content);
    expect(f.memory.work(value.work.workId)).toEqual(receipt);
    expect((await f.reclaim()).released).toBe(1);
  });

  it("yields between whole sources and cancels without half-released originals", async () => {
    const f = fixture();
    f.source();
    f.source();
    const abort = new AbortController();
    const release = f.memory.releaseCanonicalSource.bind(f.memory);
    vi.spyOn(f.memory, "releaseCanonicalSource").mockImplementationOnce(
      (id) => {
        const result = release(id);
        abort.abort();
        return result;
      },
    );
    expect(await f.reclaim(abort.signal)).toMatchObject({
      scanned: 1,
      released: 1,
      interrupted: true,
    });
    expect(f.memory.canonicalStorageStats()).toMatchObject({
      presentSources: 1,
      releasedSources: 1,
    });
    expect((await f.reclaim()).released).toBe(1);
  });

  it("retains identities whose deleted Message can no longer be mapped exactly", async () => {
    const f = fixture();
    const value = f.source();
    f.chats.deleteChat(value.message.chatId);
    const result = await f.reclaim();
    expect(result).toMatchObject({
      released: 0,
      retained: { unknown_mapping: 1 },
    });
    expect(f.memory.getSourceMetadata(value.original.id)).toBeDefined();
  });
});

// Append to the existing actual source-owner fixture after candidate integration.
describe("retrieved canonical sources recover their owning Cognition state", () => {
  function remembered(
    f: ReturnType<typeof fixture>,
    original: MemoryFormationSource,
  ) {
    const repository = new MemoryRepository(f.database);
    const detail = repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content: original.content,
      type: "event",
      confidence: 1,
      importance: 0.5,
      reason: "实际来源的测试记忆",
      now,
      sources: [
        {
          id: original.id,
          referenceId: original.referenceId,
          type: original.type,
          createdAt: original.occurredAt,
        },
      ],
    });
    repository.recall.putSemantics(
      detail.memory.currentRevisionId,
      {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    const memory = new MemoryService(
      repository,
      { search: () => [] },
      { generate: randomUUID },
      { now: () => now },
    );
    const resolved = memory.resolveEvidence({
      personaId: f.personaId,
      references: [
        {
          memoryId: detail.memory.id,
          revisionId: detail.memory.currentRevisionId,
          use: "history",
        },
      ],
      resourceBudget: { maxReadBytes: 4000 },
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved")
      throw new Error("Expected complete Memory read");
    expect(resolved.items).toHaveLength(1);
    return resolved.items;
  }
  function closeSituation(
    f: ReturnType<typeof fixture>,
    evidenceId: string,
    withEpisode: boolean,
  ) {
    let attempt = f.cognition.createAttempt(
      f.cognition.readSnapshot(f.personaId, now),
      "semantic_change",
      now,
    );
    attempt = f.cognition.saveAttempt({ ...attempt, status: "analyzing" });
    const value: CognitionAnalysis = {
      delta: {
        createSituations: [
          {
            localId: "new:pottery",
            value: {
              status: "closed",
              title: "杯子上釉安排",
              summary: "当时的安排已经结束",
              objectRefs: [],
              episodes: withEpisode
                ? [
                    {
                      id: "drying",
                      label: "上釉安排",
                      state: "closed",
                      startedAt: now,
                      endedAt: now,
                      evidenceIds: [evidenceId],
                      objectKeys: [],
                      boundaryReason: "当时事项结束",
                    },
                  ]
                : [],
              claims: [
                {
                  id: "glazing",
                  text: "用户当时安排等杯子晾干再上釉",
                  basis: "reported",
                  state: "supported",
                  evidenceIds: [evidenceId],
                  contradictingEvidenceIds: [],
                },
              ],
              unresolved: [],
              relatedSituationIds: [],
            },
          },
        ],
        updateSituations: [],
        createIntents: [],
        updateIntents: [],
        attention: {},
      },
      decision: {
        choices: [
          {
            id: "quiet",
            kind: "remain_quiet",
            evidenceIds: [],
            rationale: "安静陪伴",
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
        reason: "安静陪伴",
      },
    };
    const result = f.cognition.commitAnalysis(attempt.id, value, now);
    f.cognition.saveAttempt({ ...result, status: "settled", outcome: "quiet" });
  }
  it.each([false, true])(
    "loads only the actual parent of a retrieved Message/Run source (episode=%s)",
    (episode) => {
      const f = fixture();
      const wanted = f.source();
      const original = f.observe(wanted);
      closeSituation(f, original.id, episode);
      const unrelated = f.source();
      closeSituation(f, f.observe(unrelated).id, true);
      expect(f.cognition.getSnapshot(f.personaId, now).situations).toEqual([]);
      const items = remembered(f, wanted.original);
      const bodyRead = vi.spyOn(f.chats, "getMessage");
      const wholeRun = vi.spyOn(f.runs, "memoryFormationItemReferences");
      const references = referencedCognitionState(f.personaId, items, 4000, f);
      expect(references).toMatchObject({
        missingReferenceCount: 0,
        truncated: false,
        intentIds: [],
      });
      expect(references.situationIds).toHaveLength(1);
      const restored = f.cognition.readSnapshot(
        f.personaId,
        now,
        32768,
        references,
      );
      expect(restored.snapshot.situations).toHaveLength(1);
      expect(restored.snapshot.situations[0]).toMatchObject({
        id: references.situationIds[0],
        status: "closed",
        revision: 1,
      });
      expect(restored.snapshot.situations[0]!.claims[0]!.evidenceIds).toContain(
        original.id,
      );
      expect(f.cognition.getSnapshot(f.personaId, now).situations).toEqual([]);
      expect(bodyRead).not.toHaveBeenCalled();
      expect(wholeRun).not.toHaveBeenCalled();
    },
  );
  it("reports owner and omitted-source discovery gaps without duplicating known aliases", () => {
    const f = fixture();
    const wanted = f.source();
    closeSituation(f, f.observe(wanted).id, false);
    const items = remembered(f, wanted.original);
    const first = items[0]!;
    const detached = {
      sourceId: randomUUID(),
      referenceId: randomUUID(),
      type: "chat" as const,
    };
    const references = referencedCognitionState(
      f.personaId,
      [
        {
          ...first,
          sourceRefs: [...first.sourceRefs, detached],
          sourceCount: (first.sourceCount ?? first.sourceRefs.length) + 3,
        },
        first,
      ],
      4000,
      f,
    );
    expect(references).toMatchObject({
      missingReferenceCount: 3,
      truncated: false,
    });
    expect(references.situationIds).toHaveLength(1);
    const foreign = referencedCognitionState(randomUUID(), items, 4000, f);
    expect(foreign).toMatchObject({
      situationIds: [],
      intentIds: [],
      missingReferenceCount: 1,
    });
  });
});
