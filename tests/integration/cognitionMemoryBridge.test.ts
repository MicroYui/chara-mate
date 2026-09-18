import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openApplicationDatabase } from "../../src/main/db/database";
import { CognitionRepository } from "../../src/main/cognition/cognitionRepository";
import { CognitionMemoryBridge } from "../../src/main/app/cognitionMemoryBridge";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import type {
  CognitionAnalysis,
  CognitionEvidence,
} from "../../src/shared/contracts/cognition";
import type { MemoryFormationSource } from "../../src/shared/contracts/memoryRecall";
import type { MemorySourceResolution } from "../../src/main/app/memoryFormationSources";

const now = "2026-09-15T08:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done();
});
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cognition-memory-bridge-"));
  const dbPath = path.join(dir, "app.sqlite");
  let database = openApplicationDatabase(dbPath);
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const personaId = personas.getLibrary().activePersonaId;
  const models = vi.fn(() => Promise.resolve({ entities: [], units: [] }));
  const originals = new Map<string, MemoryFormationSource>();
  const bridges: CognitionMemoryBridge[] = [];
  function domains() {
    const cognition = new CognitionRepository(database, {
      readBudgetBytes: 32768,
    });
    const repository = new MemoryRepository(database);
    const memory = new MemoryService(
      repository,
      { search: () => [] },
      new CryptoIdGenerator(),
      { now: () => now },
      {
        embedding: {
          modelKey: "unused-bridge-fixture",
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
              coverage: plan.questions.map((q) => ({
                questionId: q.id,
                status: "missing",
                revisionIds: [],
              })),
            }),
        },
        formation: formationRuntime({
          version: "bridge-fixture",
          form: models,
        }),
        formationResourceBudget,
        formationContextBudget: () => ({ maxTokens: 8192 }),
      },
    );
    return { cognition, repository, memory };
  }
  let owners = domains();
  function publish(content = "用户说喜欢冲洗胶片。") {
    const source: MemoryFormationSource = {
      id: randomUUID(),
      type: "activity_event",
      referenceId: randomUUID(),
      speaker: "environment",
      content,
      occurredAt: now,
    };
    source.referenceId = source.id;
    originals.set(source.id, source);
    const { evidence } = owners.cognition.ingest(
      {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "observation",
        source: { kind: "activity", id: source.id },
        observedAt: now,
        text: "认知摘要不作原文",
      },
      now,
    );
    const attempt = owners.cognition.createAttempt(
      owners.cognition.readSnapshot(personaId, now),
      "semantic_change",
      now,
    );
    owners.cognition.saveAttempt({ ...attempt, status: "analyzing" });
    const analysis: CognitionAnalysis = {
      delta: {
        createSituations: [
          {
            localId: "new:memory",
            value: {
              status: "closed",
              title: "一次事件",
              summary: "认知解释",
              objectRefs: [],
              episodes: [
                {
                  id: "one",
                  label: "一次事件",
                  state: "closed",
                  startedAt: now,
                  endedAt: now,
                  evidenceIds: [evidence.id],
                  objectKeys: [],
                  boundaryReason: "完成",
                },
              ],
              claims: [],
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
            rationale: "等待",
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
        reason: "等待",
      },
    };
    const committed = owners.cognition.commitAnalysis(
      attempt.id,
      analysis,
      now,
    );
    owners.cognition.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    return { source, evidence };
  }
  function bridge(options: { unsupported?: boolean; missing?: boolean } = {}) {
    const describeSource = vi.fn(
      (e: CognitionEvidence): MemorySourceResolution => {
        if (options.unsupported) return { kind: "unsupported" };
        if (options.missing) return { kind: "missing", reference: e.source.id };
        const source =
          owners.memory.getFormationSourceMetadata(e.source.id) ??
          originals.get(e.source.id);
        if (!source) return { kind: "missing", reference: e.source.id };
        const { id, type, referenceId, speaker, occurredAt } = source;
        return {
          kind: "available",
          source: { id, type, referenceId, speaker, occurredAt },
        };
      },
    );
    const resolveSource = vi.fn((e: CognitionEvidence) =>
      originals.get(e.source.id),
    );
    const errors = vi.fn();
    const wake = vi.fn(() => {
      expect(database.inTransaction).toBe(false);
      expect([...owners.memory.pendingFormationWork()].length).toBeGreaterThan(
        0,
      );
    });
    const instance = new CognitionMemoryBridge({
      database,
      cognition: owners.cognition,
      memory: owners.memory,
      describeSource,
      resolveSource,
      wakeMemory: wake,
      onError: errors,
    });
    bridges.push(instance);
    return { instance, wake, errors, resolveSource, describeSource };
  }
  cleanups.push(async () => {
    for (const b of bridges) await b.shutdown();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get database() {
      return database;
    },
    get owners() {
      return owners;
    },
    models,
    originals,
    publish,
    bridge,
    reopen: async () => {
      for (const b of bridges) await b.shutdown();
      database.close();
      database = openApplicationDatabase(dbPath);
      owners = domains();
    },
  };
}

describe("durable Cognition to Memory transfer", () => {
  it("atomically registers originals and acknowledges before waking any model work", async () => {
    const f = fixture();
    const { source } = f.publish();
    const b = f.bridge();
    b.instance.start();
    await b.instance.idle();
    expect(b.errors).not.toHaveBeenCalled();
    expect(b.wake).toHaveBeenCalledTimes(1);
    expect(b.resolveSource).toHaveBeenCalledTimes(1);
    expect(f.models).not.toHaveBeenCalled();
    expect([...f.owners.cognition.pendingMemoryHandoffs()]).toEqual([]);
    const work = [...f.owners.memory.pendingFormationWork()][0]!;
    expect(
      f.owners.repository.formation.sourceWindow(
        work.workId,
        source.id,
        0,
        source.content.length,
      ),
    ).toBe(source.content);
    const payload = f.database
      .prepare("SELECT payload_json FROM memory_work WHERE id=?")
      .get(work.workId) as { payload_json: string };
    expect(payload.payload_json).not.toContain(source.content);
    expect(payload.payload_json).not.toContain("认知摘要");
  });
  it("rolls back canonical source and queue if acknowledgement fails and recovers after reopening", async () => {
    const f = fixture();
    f.publish();
    f.database.exec(
      "CREATE TRIGGER reject_ack BEFORE DELETE ON cognition_memory_handoffs BEGIN SELECT RAISE(ABORT,'fixture acknowledgement failure'); END",
    );
    const first = f.bridge();
    first.instance.start();
    await first.instance.idle();
    expect(first.errors).toHaveBeenCalledTimes(1);
    expect(first.wake).not.toHaveBeenCalled();
    expect([...f.owners.memory.pendingFormationWork()]).toEqual([]);
    expect(
      f.database
        .prepare("SELECT count(*) n FROM memory_source_text_chunks")
        .get(),
    ).toEqual({ n: 0 });
    expect([...f.owners.cognition.pendingMemoryHandoffs()]).toHaveLength(1);
    f.database.exec("DROP TRIGGER reject_ack");
    await f.reopen();
    const restored = f.bridge();
    restored.instance.start();
    await restored.instance.idle();
    expect(restored.errors).not.toHaveBeenCalled();
    expect(restored.wake).toHaveBeenCalledTimes(1);
    expect([...f.owners.cognition.pendingMemoryHandoffs()]).toHaveLength(0);
  });
  it("reads existing canonical metadata without loading the body again", async () => {
    const f = fixture();
    const { source } = f.publish("很长的实际内容。".repeat(12000));
    f.owners.repository.formation.registerSource(source);
    f.originals.delete(source.id);
    const b = f.bridge();
    b.instance.start();
    await b.instance.idle();
    expect(b.errors).not.toHaveBeenCalled();
    expect(b.resolveSource).not.toHaveBeenCalled();
    expect(b.wake).toHaveBeenCalledTimes(1);
  });
  it("leaves missing sources pending without looping but acknowledges unsupported sources", async () => {
    const f = fixture();
    f.publish();
    const state = { missing: true };
    const b = f.bridge(state);
    b.instance.start();
    await b.instance.idle();
    expect(b.errors).toHaveBeenCalledTimes(1);
    expect([...f.owners.cognition.pendingMemoryHandoffs()]).toHaveLength(1);
    expect(b.wake).not.toHaveBeenCalled();
    state.missing = false;
    b.instance.wake();
    await b.instance.idle();
    expect(b.wake).toHaveBeenCalledTimes(1);
    await b.instance.shutdown();
    f.publish();
    const unsupported = f.bridge({ unsupported: true });
    unsupported.instance.start();
    await unsupported.instance.idle();
    expect(unsupported.errors).not.toHaveBeenCalled();
    expect(unsupported.wake).toHaveBeenCalledOnce();
    expect([...f.owners.cognition.pendingMemoryHandoffs()]).toHaveLength(0);
  });
  it("recovers a committed handoff before bridge startup and never re-enqueues acknowledged history", async () => {
    const f = fixture();
    f.publish();
    await f.reopen();
    const b = f.bridge();
    b.instance.wake();
    expect(b.resolveSource).not.toHaveBeenCalled();
    b.instance.start();
    await b.instance.idle();
    expect(b.resolveSource).toHaveBeenCalledTimes(1);
    await f.reopen();
    const next = f.bridge();
    next.instance.start();
    await next.instance.idle();
    expect(next.resolveSource).not.toHaveBeenCalled();
    expect(next.describeSource).not.toHaveBeenCalled();
    expect([...f.owners.memory.pendingFormationWork()]).toHaveLength(1);
  });
});
