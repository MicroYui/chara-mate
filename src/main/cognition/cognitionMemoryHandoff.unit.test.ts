import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CognitionAnalysis,
  CognitionEpisode,
  CognitionEvidence,
  CognitionSituation,
} from "./cognitionTypes";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import { enqueueMemoryHandoff } from "./cognitionMemoryHandoff";

const now = "2026-09-15T08:00:00.000Z";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec(CURRENT_SCHEMA_SQL);
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const persona = () => {
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      )
      .run(id, now, now);
    return id;
  };
  const personaId = persona();
  const evidence = (text: string, owner = personaId): CognitionEvidence => {
    const id = randomUUID();
    return repository.ingest(
      {
        id,
        personaId: owner,
        actor: "user",
        source: { kind: "activity", id },
        kind: "observation",
        boundary: "content",
        observedAt: now,
        text,
      },
      now,
    ).evidence;
  };
  const commit = (output: CognitionAnalysis, owner = personaId) => {
    const attempt = repository.createAttempt(
      repository.readSnapshot(owner, now),
      "semantic_change",
      now,
    );
    repository.saveAttempt({ ...attempt, status: "analyzing" });
    const ready = repository.commitAnalysis(attempt.id, output, now);
    repository.saveAttempt({ ...ready, status: "settled", outcome: "quiet" });
    return ready;
  };
  return { database, repository, personaId, persona, evidence, commit };
}
function output(): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
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
          rationale: "观察",
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
      reason: "证据留存",
    },
  };
}
function episode(
  id: string,
  evidenceIds: string[],
  state: CognitionEpisode["state"] = "open",
): CognitionEpisode {
  return {
    id,
    state,
    evidenceIds,
    label: id,
    startedAt: now,
    objectKeys: [],
    boundaryReason: "实际来源分段",
  };
}
function create(episodes: CognitionEpisode[], localId = "new:one") {
  return {
    localId,
    value: {
      status: "current" as const,
      title: "同语义情境",
      summary: "仅用于认知状态",
      objectRefs: [],
      episodes,
      claims: [],
      unresolved: [],
      relatedSituationIds: [],
    },
  };
}
function update(situation: CognitionSituation, episodes: CognitionEpisode[]) {
  return {
    id: situation.id,
    expectedRevision: situation.revision,
    value: {
      status: situation.status,
      title: situation.title,
      summary: situation.summary,
      objectRefs: situation.objectRefs,
      episodes,
      claims: situation.claims,
      unresolved: situation.unresolved,
      relatedSituationIds: situation.relatedSituationIds,
    },
  };
}

describe("Cognition durable Memory handoff", () => {
  it("freezes the final indexed Episode relation and recomputes the cutoff from accepted primaries", () => {
    const h = fixture();
    const [intro, early, middle, late, future] = Array.from(
      { length: 5 },
      (_, i) => h.evidence(`真实来源${i}`),
    ) as [
      CognitionEvidence,
      CognitionEvidence,
      CognitionEvidence,
      CognitionEvidence,
      CognitionEvidence,
    ];
    const initial = output();
    initial.delta.createSituations = [
      create([
        episode("shared", [intro.id, early.id, middle.id, late.id, future.id]),
      ]),
    ];
    const ready = h.commit(initial);
    const situationId = ready.dependencies.situations[0]!.id;
    h.database.transaction(() =>
      enqueueMemoryHandoff(h.database, {
        personaId: h.personaId,
        situationId,
        committedAt: now,
        primaryEvidenceIds: [early.id, late.id],
        historyEvidenceIds: [],
      }),
    )();
    const frozen = [...h.repository.pendingMemoryHandoffs()][0]!;
    expect(frozen.contextGroups[0]!.contextEvidenceIds).not.toContain(
      future.id,
    );
    expect(
      [...h.repository.memoryHandoffContext(frozen, [early.id])].map(
        (e) => e.id,
      ),
    ).toEqual([intro.id]);
    expect(
      [...h.repository.memoryHandoffContext(frozen, [early.id, late.id])].map(
        (e) => e.id,
      ),
    ).toEqual([intro.id, middle.id]);
    const current = h.repository.getSituation(situationId)!;
    const changed = output();
    changed.delta.updateSituations = [
      update(current, [episode("shared", [future.id])]),
    ];
    h.commit(changed);
    const restored = new CognitionRepository(h.database, {
      readBudgetBytes: 32_768,
    });
    expect([...restored.pendingMemoryHandoffs()]).toEqual([frozen]);
    expect(
      [...restored.memoryHandoffContext(frozen, [early.id])].map((e) => e.id),
    ).toEqual([intro.id]);
    expect([...restored.formationContext(h.personaId, [early.id])]).toEqual([]);
  });

  it("selects only groups sharing accepted anchors without recursively following another Episode", () => {
    const h = fixture();
    const raw = Array.from({ length: 6 }, (_, i) => h.evidence(`来源${i}`));
    const initial = output();
    initial.delta.createSituations = [
      create([
        episode("accepted", [raw[0]!.id, raw[2]!.id, raw[4]!.id]),
        episode("unsupported", [raw[1]!.id, raw[5]!.id]),
        episode("second-hop", [raw[0]!.id, raw[3]!.id]),
      ]),
    ];
    const situationId = h.commit(initial).dependencies.situations[0]!.id;
    h.database.transaction(() =>
      enqueueMemoryHandoff(h.database, {
        personaId: h.personaId,
        situationId,
        committedAt: now,
        primaryEvidenceIds: [raw[4]!.id, raw[5]!.id],
        historyEvidenceIds: [],
      }),
    )();
    const item = [...h.repository.pendingMemoryHandoffs()][0]!;
    expect(
      [...h.repository.memoryHandoffContext(item, [raw[4]!.id])].map(
        (e) => e.id,
      ),
    ).toEqual([raw[0]!.id, raw[2]!.id]);
    expect([...h.repository.memoryHandoffContext(item, [])]).toEqual([]);
    expect(() => [
      ...h.repository.memoryHandoffContext(item, [raw[3]!.id]),
    ]).toThrow("outside");
    expect(() => [
      ...h.repository.memoryHandoffEvidence(item, [raw[3]!.id]),
    ]).toThrow("outside");
  });

  it("rolls back the Situation, index and pending handoff when the same state transaction fails", () => {
    const h = fixture(),
      raw = h.evidence("已结束的真实工作");
    const initial = output();
    initial.delta.createSituations = [
      create([episode("work", [raw.id], "closed")]),
    ];
    h.database.exec(
      "CREATE TRIGGER fail_handoff BEFORE INSERT ON cognition_memory_handoffs BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END;",
    );
    expect(() => h.commit(initial)).toThrow("fixture persistence failure");
    for (const table of [
      "cognition_situations",
      "cognition_episode_evidence",
      "cognition_memory_handoffs",
    ])
      expect(
        h.database.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    expect(
      h.repository.getAttention(h.personaId, now).analyzedThroughSequence,
    ).toBe(0);
    h.database.exec("DROP TRIGGER fail_handoff");
  });

  it("requires atomic acknowledgement and rolls back a receiving-domain write at both crash boundaries", () => {
    const h = fixture(),
      raw = h.evidence("真实来源");
    const initial = output();
    initial.delta.createSituations = [
      create([episode("closed", [raw.id], "closed")]),
    ];
    h.commit(initial);
    const item = [...h.repository.pendingMemoryHandoffs()][0]!;
    // A minimal receiving-domain fixture proves SQLite atomicity, not Q2 Memory behavior.
    h.database.exec("CREATE TABLE receiving_fixture(id TEXT PRIMARY KEY)");
    expect(() => h.repository.acknowledgeMemoryHandoff(item.id)).toThrow(
      "same transaction",
    );
    for (const failAfterAck of [false, true]) {
      expect(() =>
        h.database.transaction(() => {
          h.database.transaction(() =>
            h.database
              .prepare("INSERT INTO receiving_fixture VALUES(?)")
              .run(item.id),
          )();
          if (failAfterAck) h.repository.acknowledgeMemoryHandoff(item.id);
          throw new Error("fixture crash before commit");
        })(),
      ).toThrow("fixture crash");
      expect(
        h.database
          .prepare("SELECT count(*) AS count FROM receiving_fixture")
          .get(),
      ).toEqual({ count: 0 });
      expect([...h.repository.pendingMemoryHandoffs()]).toEqual([item]);
    }
    h.database.transaction(() => {
      h.database
        .prepare("INSERT INTO receiving_fixture VALUES(?)")
        .run(item.id);
      expect(h.repository.acknowledgeMemoryHandoff(item.id)).toBe(true);
    })();
    expect([
      ...new CognitionRepository(h.database, {
        readBudgetBytes: 32_768,
      }).pendingMemoryHandoffs(),
    ]).toEqual([]);
    expect(
      h.database.transaction(() =>
        h.repository.acknowledgeMemoryHandoff(item.id),
      )(),
    ).toBe(false);
  });

  it("keeps all Persona pending items across restart and permits consumer writes while iterating", () => {
    const h = fixture(),
      second = h.persona();
    for (const owner of [h.personaId, second]) {
      const raw = h.evidence(`材料${owner}`, owner),
        initial = output();
      initial.delta.createSituations = [
        create([episode("closed", [raw.id], "closed")]),
      ];
      h.commit(initial, owner);
    }
    const restored = new CognitionRepository(h.database, {
      readBudgetBytes: 32_768,
    });
    const seen = new Set<string>();
    for (const item of restored.pendingMemoryHandoffs()) {
      seen.add(item.personaId);
      h.database.transaction(() =>
        restored.acknowledgeMemoryHandoff(item.id),
      )();
    }
    expect(seen).toEqual(new Set([h.personaId, second]));
    expect([...restored.pendingMemoryHandoffs()]).toEqual([]);
  });

  it("deduplicates exact pending material but preserves a correction and neutral history separately", () => {
    const h = fixture(),
      old = h.evidence("旧说法"),
      current = h.evidence("实际改口");
    const initial = output();
    initial.delta.createSituations = [
      create([episode("one", [old.id, current.id])]),
    ];
    const situationId = h.commit(initial).dependencies.situations[0]!.id;
    const input = {
      personaId: h.personaId,
      situationId,
      committedAt: now,
      primaryEvidenceIds: [old.id],
      historyEvidenceIds: [],
    };
    h.database.transaction(() => {
      expect(enqueueMemoryHandoff(h.database, input)).toBe(true);
      expect(
        enqueueMemoryHandoff(h.database, {
          ...input,
          committedAt: "2026-09-15T09:00:00.000Z",
        }),
      ).toBe(false);
      expect(
        enqueueMemoryHandoff(h.database, {
          ...input,
          primaryEvidenceIds: [current.id],
          historyEvidenceIds: [old.id],
        }),
      ).toBe(true);
      expect(
        enqueueMemoryHandoff(h.database, { ...input, primaryEvidenceIds: [] }),
      ).toBe(false);
    })();
    const pending = [...h.repository.pendingMemoryHandoffs()];
    expect(pending).toHaveLength(2);
    expect(
      pending.find((item) => item.historyEvidenceIds.length),
    ).toMatchObject({
      primaryEvidenceIds: [current.id],
      historyEvidenceIds: [old.id],
    });
  });

  it("rejects unknown or cross-Persona sources without writing a partial pending item", () => {
    const h = fixture(),
      foreign = h.evidence("另一个人的来源", h.persona()),
      raw = h.evidence("本人来源");
    const initial = output();
    initial.delta.createSituations = [create([episode("one", [raw.id])])];
    const situationId = h.commit(initial).dependencies.situations[0]!.id;
    for (const id of [foreign.id, randomUUID()]) {
      expect(() =>
        h.database.transaction(() =>
          enqueueMemoryHandoff(h.database, {
            personaId: h.personaId,
            situationId,
            committedAt: now,
            primaryEvidenceIds: [id],
            historyEvidenceIds: [],
          }),
        )(),
      ).toThrow("another Persona");
    }
    expect([...h.repository.pendingMemoryHandoffs()]).toEqual([]);
  });

  it("keeps missing source work pending and deletes pending items with their owning Persona", () => {
    const h = fixture(),
      raw = h.evidence("将缺失的证据");
    const initial = output();
    initial.delta.createSituations = [
      create([episode("one", [raw.id], "closed")]),
    ];
    h.commit(initial);
    const item = [...h.repository.pendingMemoryHandoffs()][0]!;
    h.database.prepare("DELETE FROM cognition_evidence WHERE id=?").run(raw.id);
    expect(() => [
      ...h.repository.memoryHandoffEvidence(item, item.primaryEvidenceIds),
    ]).toThrow("missing");
    expect([...h.repository.pendingMemoryHandoffs()]).toEqual([item]);
    h.database.prepare("DELETE FROM personas WHERE id=?").run(h.personaId);
    expect([...h.repository.pendingMemoryHandoffs()]).toEqual([]);
  });

  it("reads only source metadata and preserves pending Activity retention until acknowledgement", () => {
    const h = fixture(),
      raw = h.evidence("大正文".repeat(100_000));
    const initial = output();
    initial.delta.createSituations = [
      create([episode("one", [raw.id], "closed")]),
    ];
    h.commit(initial);
    const item = [...h.repository.pendingMemoryHandoffs()][0]!;
    expect(JSON.stringify(item).length).toBeLessThan(1000);
    const metadata = [
      ...h.repository.memoryHandoffEvidence(item, item.primaryEvidenceIds),
    ][0]!;
    expect(metadata.text).toBeUndefined();
    expect(metadata.source).toEqual(raw.source);
    expect(
      h.repository.protectedActivitySourceIds(
        [raw.source.id],
        new Set([raw.source.id]),
      ),
    ).toEqual(new Set([raw.source.id]));
    h.database.transaction(() =>
      h.repository.acknowledgeMemoryHandoff(item.id),
    )();
    expect(
      h.repository.protectedActivitySourceIds(
        [raw.source.id],
        new Set([raw.source.id]),
      ),
    ).toEqual(new Set());
  });
});
