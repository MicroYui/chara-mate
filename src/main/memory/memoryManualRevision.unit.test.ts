import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryRevisionSemantics } from "../../shared/contracts/memoryRecall";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { openApplicationDatabase } from "../db/database";
import { PersonaRepository } from "../persona/personaRepository";
import { LexicalRetrievalPipeline } from "./lexicalRetrievalPipeline";
import { MemoryRepository } from "./memoryRepository";
import { MemoryService } from "./memoryService";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memory-manual-edit-"));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = "2026-09-15T12:00:00.000Z";
  const clock = { now: () => now };
  const personas = new PersonaRepository(database);
  personas.initialize(now);
  const [personaA, personaB] = personas
    .getLibrary()
    .personas.map(({ snapshot }) => snapshot.personaId);
  if (!personaA || !personaB) throw new Error("Fixture requires two Personas");
  const repository = new MemoryRepository(database);
  const service = new MemoryService(
    repository,
    new LexicalRetrievalPipeline(database, repository, clock),
    new CryptoIdGenerator(),
    clock,
  );
  const create = (
    semantics?: MemoryRevisionSemantics,
    calendar?: { occursAt: string; timeZone: string },
  ) => {
    const detail = repository.create({
      memoryId: randomUUID(),
      revisionId: randomUUID(),
      content: "小猫已经在领地摆好纸灯笼。",
      type: "event",
      confidence: 1,
      importance: 0.5,
      reason: "Synthetic source-backed fixture",
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "tool",
          createdAt: now,
        },
      ],
      now,
      ...(calendar ? { ...calendar, importantMoment: true } : {}),
    });
    if (semantics)
      repository.recall.putSemantics(
        detail.memory.currentRevisionId,
        semantics,
        [],
      );
    return detail;
  };
  const evidence = (revisionId: string) =>
    repository.recall.evidence([revisionId], now)[0]!;
  const candidates = (personaId: string) =>
    repository.recall.lexical(
      "纸灯笼",
      {
        purpose: "conversation",
        query: "纸灯笼",
        questions: [{ id: "q", text: "纸灯笼" }],
        personaId,
        contextBudget: { maxTokens: 8192 },
      },
      20,
      now,
    );
  const edit = (memoryId: string) =>
    service.revise({
      memoryId,
      content: "小猫说纸灯笼还没有摆好。",
      sources: [],
      reason: "用户在 Memory 页面编辑",
    });
  return {
    database,
    repository,
    service,
    create,
    edit,
    evidence,
    candidates,
    personaA,
    personaB,
    now,
  };
}

describe("Manual Memory revision ownership", () => {
  it("keeps a known character's identity and represents the correction as a user report", () => {
    const f = fixture();
    const entityId = randomUUID();
    f.repository.recall.putEntity(
      { id: entityId, name: "纸灯笼", kind: "object", aliases: [] },
      f.now,
    );
    const old = f.create({
      kind: "commitment",
      owner: "character",
      personaId: f.personaA,
      basis: "direct_observation",
      subjectEntityId: entityId,
      predicate: "placed",
      objectValue: "领地",
      commitmentState: "completed",
      occurredFrom: "2026-09-14T12:00:00.000Z",
      validFrom: "2026-09-14T12:00:00.000Z",
      validTo: "2027-09-14T12:00:00.000Z",
      qualifiers: { location: "领地" },
    });
    expect(f.candidates(f.personaB)).toEqual([]);
    const revised = f.edit(old.memory.id);
    const item = f.evidence(revised.memory.currentRevisionId);
    expect(item.semantics).toEqual({
      kind: "claim",
      owner: "character",
      personaId: f.personaA,
      basis: "explicit_user_statement",
      qualifiers: { authoring: "user_edit" },
    });
    expect(item.entityIds).toEqual([]);
    expect(item.sourceRefs).toEqual([]);
    expect(item.occurredFrom).toBeUndefined();
    expect(item.validFrom).toBeUndefined();
    expect(item.validTo).toBeUndefined();
    expect(
      revised.revisions.find(({ id }) => id === item.revisionId)?.sourceType,
    ).toBe("user_edit");
    expect(f.candidates(f.personaA)).toContain(item.revisionId);
    expect(f.candidates(f.personaB)).toEqual([]);
    expect(f.evidence(old.memory.currentRevisionId).semantics?.basis).toBe(
      "direct_observation",
    );
  });

  it("keeps a known user fact shared across Personas without retaining an inference basis", () => {
    const f = fixture();
    const old = f.create({
      kind: "reflection",
      owner: "user",
      basis: "inference",
      qualifiers: {},
    });
    const revised = f.edit(old.memory.id);
    expect(f.evidence(revised.memory.currentRevisionId).semantics).toEqual({
      kind: "claim",
      owner: "user",
      basis: "explicit_user_statement",
      qualifiers: { authoring: "user_edit" },
    });
    expect(f.candidates(f.personaA)).toContain(
      revised.memory.currentRevisionId,
    );
    expect(f.candidates(f.personaB)).toContain(
      revised.memory.currentRevisionId,
    );
  });

  it("does not invent ownership for an unclassified older record", () => {
    const f = fixture();
    const old = f.create();
    const revised = f.edit(old.memory.id);
    const item = f.evidence(revised.memory.currentRevisionId);
    expect(item.semantics).toBeUndefined();
    expect(item.owner).toBeUndefined();
    expect(item.personaId).toBeUndefined();
  });

  it("keeps user-set calendar fields distinct from discarded automatic semantic time", () => {
    const f = fixture();
    const calendar = {
      occursAt: "2026-09-17T06:00:00.000Z",
      timeZone: "Asia/Shanghai",
    };
    const old = f.create(
      {
        kind: "episode",
        owner: "character",
        personaId: f.personaA,
        basis: "direct_observation",
        occurredFrom: "2026-09-14T12:00:00.000Z",
        timePrecision: "day",
        qualifiers: {},
      },
      calendar,
    );
    const revised = f.edit(old.memory.id);
    const item = f.evidence(revised.memory.currentRevisionId);
    expect(item.semantics?.occurredFrom).toBeUndefined();
    expect(item.semantics?.timePrecision).toBeUndefined();
    expect(item.occurredFrom).toBe(calendar.occursAt);
    expect(
      revised.revisions.find(({ id }) => id === item.revisionId),
    ).toMatchObject({ ...calendar, importantMoment: true });
  });

  it("uses explicitly supplied new validity bounds instead of old semantic bounds", () => {
    const f = fixture();
    const old = f.create({
      kind: "episode",
      owner: "character",
      personaId: f.personaA,
      basis: "direct_observation",
      validFrom: "2026-09-14T00:00:00.000Z",
      validTo: "2026-09-18T00:00:00.000Z",
      qualifiers: {},
    });
    const validFrom = "2026-09-15T00:00:00.000Z",
      validTo = "2026-09-16T00:00:00.000Z";
    const revised = f.service.revise({
      memoryId: old.memory.id,
      content: "纸灯笼今天暂时放在书桌。",
      sources: [],
      reason: "用户纠正有效时间",
      validFrom,
      validTo,
    });
    expect(
      f.evidence(revised.memory.currentRevisionId).semantics,
    ).toMatchObject({
      validFrom,
      validTo,
      owner: "character",
      personaId: f.personaA,
    });
  });

  it("rolls back the new revision and search projection if ownership persistence fails", () => {
    const f = fixture();
    const old = f.create({
      kind: "episode",
      owner: "character",
      personaId: f.personaA,
      basis: "direct_observation",
      qualifiers: {},
    });
    const before = f.database
      .prepare("SELECT COUNT(*) AS count FROM memory_fts")
      .get();
    vi.spyOn(f.repository.recall, "putSemantics").mockImplementation(() => {
      throw new Error("synthetic semantics write failure");
    });
    expect(() => f.edit(old.memory.id)).toThrow(
      "synthetic semantics write failure",
    );
    expect(
      f.repository.requireDetail(old.memory.id).memory.currentRevisionId,
    ).toBe(old.memory.currentRevisionId);
    expect(f.repository.requireDetail(old.memory.id).revisions).toHaveLength(1);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM memory_fts").get(),
    ).toEqual(before);
  });
});
