import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CognitionAnalysis,
  CognitionEvidenceInput,
  CognitionIntent,
  CognitionSourceRetentionCandidate,
} from "../../shared/contracts/cognition";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";

const now = "2026-09-15T08:00:00.000Z";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(CURRENT_SCHEMA_SQL);
  const personas = [randomUUID(), randomUUID()];
  for (const id of personas)
    db.prepare(
      "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    ).run(id, now, now);
  const repository = new CognitionRepository(db, { readBudgetBytes: 32_768 });
  const sourceId = randomUUID();
  const reference = {
    kind: "run" as const,
    id: randomUUID(),
    fragment: sourceId,
  };
  const candidate: CognitionSourceRetentionCandidate = {
    candidateId: sourceId,
    references: [reference],
  };
  const publish = (
    personaId = personas[0]!,
    extra: Partial<CognitionEvidenceInput> = {},
  ) =>
    repository.ingest(
      {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "utterance",
        source: reference,
        text: "我想等陶艺杯晾干以后再上釉。",
        observedAt: now,
        ...extra,
      },
      now,
    ).evidence;
  function analyze(
    personaId = personas[0]!,
    delta?: Partial<CognitionAnalysis["delta"]>,
  ) {
    const snapshotRead = repository.readSnapshot(personaId, now);
    const attempt = repository.createAttempt(
      snapshotRead,
      "semantic_change",
      now,
    );
    repository.saveAttempt({ ...attempt, status: "analyzing" });
    return repository.commitAnalysis(
      attempt.id,
      {
        delta: {
          createSituations: [],
          updateSituations: [],
          createIntents: [],
          updateIntents: [],
          attention: {},
          ...delta,
        },
        decision: {
          choices: [
            {
              id: "quiet",
              kind: "remain_quiet",
              evidenceIds: [],
              rationale: "继续陪着",
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
          reason: "继续陪着",
        },
      },
      now,
    );
  }
  function settle(attempt: ReturnType<typeof analyze>) {
    repository.saveAttempt({ ...attempt, status: "settled", outcome: "quiet" });
  }
  function acknowledge() {
    for (const item of repository.pendingMemoryHandoffs())
      db.transaction(() => repository.acknowledgeMemoryHandoff(item.id))();
  }
  return {
    db,
    repository,
    personas,
    sourceId,
    candidate,
    publish,
    analyze,
    settle,
    acknowledge,
    reasons: () =>
      repository.protectedCanonicalSources([candidate])[0]?.reasons ?? [],
  };
}

describe("canonical originals retained by actual Cognition consumers", () => {
  it.each(["settled", "failed", "superseded"] as const)(
    "keeps active dependencies across generations until every owner is %s",
    (terminalStatus) => {
      const f = fixture();
      const original = f.publish();
      const read = f.repository.readSnapshot(f.personas[0]!, now);
      f.settle(f.analyze());
      expect(f.reasons()).toEqual([]);
      expect(
        f.repository.getAttention(f.personas[0]!, now).userGeneration,
      ).toBe(read.snapshot.attention.userGeneration);
      const first = f.repository.createAttempt(read, "semantic_change", now);
      expect(first.dependencies.evidenceIds).toContain(original.id);
      // The committed quiet analysis consumed the original. These are actual
      // Attempt dependencies, with no Claim, Intent, or current-view protection.
      const repeated = {
        ...first,
        dependencies: {
          ...first.dependencies,
          evidenceIds: [...first.dependencies.evidenceIds, original.id],
        },
      };
      for (const status of [
        "pending",
        "analyzing",
        "awaiting_recall",
        "ready",
        "dispatched",
      ] as const) {
        f.repository.saveAttempt({ ...repeated, status });
        expect(f.reasons()).toEqual(["decision"]);
      }
      const second = f.repository.createAttempt(read, "semantic_change", now);
      f.repository.saveAttempt({ ...second, status: "dispatched" });
      expect(second.dependencies.evidenceIds).toContain(original.id);
      f.publish(f.personas[0], {
        kind: "control",
        control: "user_correction",
        source: { kind: "system", id: randomUUID() },
      });
      expect(
        f.repository.getAttention(f.personas[0]!, now).userGeneration,
      ).toBe(first.dependencies.userGeneration + 1);
      expect(f.repository.getAttempt(first.id)!.status).toBe("dispatched");
      expect(f.repository.getAttempt(second.id)!.status).toBe("dispatched");
      // Active execution dependencies survive a generation change until the
      // owner settles. Only pending catalogue reads have a current-gen gate.
      expect(f.reasons()).toEqual(["decision"]);
      f.repository.saveAttempt({ ...second, status: terminalStatus });
      expect(f.reasons()).toEqual(["decision"]);
      f.repository.saveAttempt({ ...repeated, status: terminalStatus });
      expect(f.reasons()).toEqual([]);
    },
  );

  it("waits for every Persona and every representation of the exact source to finish", () => {
    const f = fixture();
    f.publish();
    f.publish(f.personas[1], {
      source: { ...f.candidate.references[0]!, revision: "second-view" },
    });
    expect(f.reasons()).toEqual(["unanalysed"]);
    f.settle(f.analyze());
    expect(f.reasons()).toEqual(["unanalysed"]);
    const second = f.analyze(f.personas[1]);
    expect(f.reasons()).toEqual(["decision"]);
    f.settle(second);
    expect(f.reasons()).toEqual([]);
    // Another item from the same Run must not retain this original.
    f.publish(f.personas[0], {
      source: { ...f.candidate.references[0]!, fragment: randomUUID() },
    });
    expect(f.reasons()).toEqual([]);
  });

  it("keeps open episodes and current claims even when Activity may rely on a canonical copy", () => {
    const f = fixture();
    const original = f.publish(f.personas[0], {
      kind: "observation",
      source: { kind: "activity", id: f.sourceId },
    });
    const candidate: CognitionSourceRetentionCandidate = {
      candidateId: f.sourceId,
      references: [{ kind: "activity", id: f.sourceId }],
    };
    const reasons = () =>
      f.repository.protectedCanonicalSources([candidate])[0]?.reasons ?? [];
    const value = {
      status: "current" as const,
      title: "陶艺上釉",
      summary: "等杯子晾干",
      objectRefs: [],
      episodes: [
        {
          id: "drying",
          label: "晾干杯子",
          state: "open" as const,
          startedAt: now,
          evidenceIds: [original.id],
          objectKeys: [],
          boundaryReason: "开始晾干",
        },
      ],
      claims: [
        {
          id: "unfinished",
          text: "杯子还未上釉",
          basis: "observed" as const,
          state: "supported" as const,
          evidenceIds: [original.id],
          contradictingEvidenceIds: [],
        },
      ],
      unresolved: [],
      relatedSituationIds: [],
    };
    f.settle(
      f.analyze(undefined, {
        createSituations: [{ localId: "new:pottery", value }],
      }),
    );
    expect(reasons()).toEqual(["claim", "episode", "handoff"]);
    f.acknowledge();
    expect(reasons()).toEqual(["claim", "episode"]);
    expect(
      f.repository.protectedActivitySourceIds(
        [f.sourceId],
        new Set([f.sourceId]),
      ),
    ).toEqual(new Set());
    const current = f.repository.getSnapshot(f.personas[0]!, now)
      .situations[0]!;
    f.settle(
      f.analyze(undefined, {
        updateSituations: [
          {
            id: current.id,
            expectedRevision: current.revision,
            value: {
              ...value,
              status: "closed",
              episodes: [
                { ...value.episodes[0]!, state: "closed", endedAt: now },
              ],
              claims: [{ ...value.claims[0]!, state: "superseded" }],
            },
          },
        ],
      }),
    );
    expect(reasons()).toEqual(["handoff"]);
    f.acknowledge();
    expect(reasons()).toEqual([]);
  });

  it("retains the exact tool original while a character intent still uses its effect", () => {
    const f = fixture();
    const evidence = f.publish(f.personas[0], {
      actor: "agent",
      kind: "effect",
      effect: {
        runId: f.candidate.references[0]!.id,
        itemId: f.sourceId,
        outcome: "performed",
        description: "已把陶艺杯放到晾干架",
        sourceRefs: [],
        worldChange: "placed",
      },
    });
    f.settle(f.analyze());
    const intent: CognitionIntent = {
      id: randomUUID(),
      personaId: f.personas[0]!,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "继续上釉",
      evidenceIds: [],
      effectEvidenceIds: [evidence.id],
      successCriteria: [],
      blockers: [],
      resumeConditions: [],
      progress: "等待干燥",
      createdAt: now,
      updatedAt: now,
    };
    f.repository.saveIntent(intent);
    expect(f.reasons()).toEqual(["intent"]);
    f.repository.saveIntent({ ...intent, revision: 2, status: "abandoned" }, 1);
    expect(f.reasons()).toEqual([]);
  });
});
