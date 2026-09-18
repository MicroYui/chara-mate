import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import type { CognitionAnalysis, CognitionSituation } from "./cognitionTypes";

const now = "2026-09-15T00:00:00.000Z";
const personaId = "11111111-1111-4111-8111-111111111111";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function fixture(
  use: "history" | "current_object" | "current_foreground" = "history",
) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  database
    .prepare(
      "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, now, now);
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const observe = (objectKey: string, sequence: number, observedAt = now) => {
    const id = randomUUID();
    return repository.ingest(
      {
        id,
        personaId,
        actor: "user",
        source: { kind: "activity", id },
        kind: "observation",
        observedAt,
        object: { key: objectKey, identity: "adapter" },
        boundary: "content",
        text: "局部文档内容",
        sourceEpoch: "native",
        sourceSequence: sequence,
      },
      now,
    ).evidence;
  };
  const background = observe("background", 1, "2026-09-14T23:59:58.000Z");
  const foreground = observe("foreground", 10);
  const id = randomUUID();
  const reported = repository.ingest(
    {
      id,
      personaId,
      actor: "user",
      source: { kind: "message", id },
      kind: "utterance",
      text: "我现在不吃香菜",
      observedAt: now,
    },
    now,
  ).evidence;
  const source = use === "history" ? reported : foreground;
  const output: CognitionAnalysis = {
    delta: {
      createSituations: [
        {
          localId: "new:task",
          value: {
            status: "current",
            title: "共同的事务",
            summary: "保留实际出处",
            objectRefs: [],
            episodes: [
              {
                id: "episode",
                label: "当前谈话",
                state: "open",
                startedAt: now,
                evidenceIds: [reported.id],
                objectKeys: [],
                boundaryReason: "用户正在讨论",
              },
            ],
            claims: [
              {
                id: "preference",
                text: "用户不吃香菜",
                basis: "reported",
                state: "supported",
                evidenceIds: [reported.id],
                contradictingEvidenceIds: [],
              },
              {
                id: "unrelated",
                text: "另一条备注",
                basis: "reported",
                state: "uncertain",
                evidenceIds: [reported.id],
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
          situationId: "new:task",
          evidenceIds: [source.id],
          rationale: "此刻无需打断",
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
        evidenceUses: [{ evidenceId: source.id, use }],
        currentClaimRefs: [],
      },
      reason: "保留当前事务",
    },
  };
  const commit = (value = output) => {
    const attempt = repository.createAttempt(
      repository.readSnapshot(personaId, now),
      "semantic_change",
      now,
    );
    repository.saveAttempt({ ...attempt, status: "analyzing" });
    return repository.commitAnalysis(attempt.id, value, now);
  };
  const mutateSituation = (
    change: (situation: CognitionSituation) => CognitionSituation,
  ) => {
    const previous = repository.getSnapshot(personaId, now).situations[0]!;
    const changed = change({ ...previous, revision: previous.revision + 1 });
    database
      .prepare(
        "UPDATE cognition_situations SET revision=?,status=?,superseded_by=?,payload_json=? WHERE id=?",
      )
      .run(
        changed.revision,
        changed.status,
        changed.supersededBy ?? null,
        JSON.stringify(changed),
        changed.id,
      );
  };
  return {
    database,
    repository,
    output,
    commit,
    observe,
    reported,
    foreground,
    background,
    mutateSituation,
  };
}

describe("selected action dependencies", () => {
  it.each([
    ["agent", "current_object"],
    ["system", "current_object"],
    ["agent", "history"],
    ["system", "history"],
  ] as const)(
    "checks actual %s object changes only for a %s dependency",
    (actor, use) => {
      const h = fixture(use);
      // The same actual observation can support a past description or a claim
      // about the current object. Actor attribution does not freeze its content.
      h.output.decision.choices[0]!.evidenceIds = [h.foreground.id];
      h.output.decision.selectedBasis.evidenceUses = [
        { evidenceId: h.foreground.id, use },
      ];
      const attempt = h.commit();
      const change = (sequence: number) => {
        const id = randomUUID();
        h.repository.ingest(
          {
            id,
            personaId,
            actor,
            kind: "observation",
            source: { kind: "activity", id },
            object: h.foreground.object!,
            boundary: "content",
            text: "同一对象现已显示修改后的正文",
            observedAt: "2026-09-15T00:00:30.000Z",
            sourceEpoch: "native",
            sourceSequence: sequence,
          },
          now,
        );
      };
      change(9);
      expect(h.repository.actionFreshness(attempt, now)).toEqual({
        current: true,
      });
      change(20);
      expect(h.repository.actionFreshness(attempt, now)).toEqual(
        use === "history"
          ? { current: true }
          : {
              current: false,
              reason: "object_changed",
              referenceId: h.foreground.id,
            },
      );
    },
  );

  it("keeps history current across unrelated focus and content while a new user instruction still stops it", () => {
    const h = fixture();
    const attempt = h.commit();
    h.observe("other-app", 11);
    expect(h.repository.actionFreshness(attempt, now)).toEqual({
      current: true,
    });
    h.repository.ingest(
      {
        personaId,
        actor: "user",
        kind: "utterance",
        observedAt: now,
        id: randomUUID(),
        source: { kind: "message", id: randomUUID() },
        text: "先别继续了",
      },
      now,
    );
    expect(h.repository.actionFreshness(attempt, now)).toMatchObject({
      current: false,
      reason: "control_changed",
    });
  });

  it("binds current foreground even after its old object stops being the current object", () => {
    const h = fixture("current_foreground");
    const attempt = h.commit();
    h.observe("other-app", 11);
    expect(h.repository.actionFreshness(attempt, now)).toMatchObject({
      current: false,
      reason: "focus_changed",
      referenceId: h.foreground.id,
    });
  });

  it("ignores a late unrelated object update but checks a new current-object sequence", () => {
    const h = fixture("current_object");
    const attempt = h.commit();
    h.observe("background", 5, "2026-09-14T23:59:59.000Z");
    h.observe("foreground", 9, "2026-09-15T00:00:30.000Z");
    expect(h.repository.actionFreshness(attempt, now)).toEqual({
      current: true,
    });
    h.observe("foreground", 11);
    expect(h.repository.actionFreshness(attempt, now)).toMatchObject({
      current: false,
      reason: "object_changed",
    });
  });

  it("binds newly mapped local claims and checks their alternative without depending on unrelated claims", () => {
    const h = fixture();
    h.output.decision.selectedBasis.currentClaimRefs = [
      { situationId: "new:task", claimId: "preference" },
    ];
    const attempt = h.commit();
    expect(attempt.actionReadSet?.claims[0]?.situationId).not.toBe("new:task");
    expect(attempt.actionReadSet?.claims[0]?.claimId).toBe("preference");
    h.mutateSituation((situation) => ({
      ...situation,
      claims: situation.claims.map((claim) =>
        claim.id === "unrelated" ? { ...claim, text: "另一条备注更正" } : claim,
      ),
    }));
    expect(h.repository.actionFreshness(attempt, now)).toEqual({
      current: true,
    });
    h.mutateSituation((situation) => ({
      ...situation,
      claims: situation.claims.map((claim) =>
        claim.id === "preference"
          ? { ...claim, alternative: "只是不喜欢目前这道菜的做法" }
          : claim,
      ),
    }));
    expect(h.repository.actionFreshness(attempt, now)).toMatchObject({
      current: false,
      reason: "claim_changed",
    });
  });

  it("keeps neutral historical provenance separate from current claim material", () => {
    const h = fixture();
    h.output.decision.selectedBasis.currentClaimRefs = [
      { situationId: "new:task", claimId: "preference" },
    ];
    const attempt = h.commit();
    h.mutateSituation((situation) => ({
      ...situation,
      claims: situation.claims.map((claim) => ({
        ...claim,
        historyEvidenceIds: [h.background.id],
      })),
    }));
    expect(h.repository.actionFreshness(attempt, now)).toEqual({
      current: true,
    });
    h.mutateSituation((situation) => ({ ...situation, status: "closed" }));
    expect(h.repository.actionFreshness(attempt, now)).toMatchObject({
      current: false,
      reason: "situation_changed",
    });
  });

  it.each([
    "missing",
    "duplicate",
    "wrong_choice",
    "utterance_as_current",
    "unknown_claim",
  ])("rejects %s basis and rolls state and handoff back", (kind) => {
    const h = fixture();
    if (kind === "missing") h.output.decision.selectedBasis.evidenceUses = [];
    if (kind === "duplicate")
      h.output.decision.selectedBasis.evidenceUses.push(
        h.output.decision.selectedBasis.evidenceUses[0]!,
      );
    if (kind === "wrong_choice")
      h.output.decision.selectedBasis.choiceId = "another-choice";
    if (kind === "utterance_as_current")
      h.output.decision.selectedBasis.evidenceUses[0]!.use = "current_object";
    if (kind === "unknown_claim")
      h.output.decision.selectedBasis.currentClaimRefs = [
        { situationId: "new:task", claimId: "not-supplied" },
      ];
    expect(() => h.commit()).toThrow();
    expect(h.repository.getSnapshot(personaId, now).situations).toEqual([]);
    expect([...h.repository.pendingMemoryHandoffs()]).toEqual([]);
  });

  it("refuses a hidden claim reference without interpreting a canonical read as model visibility", () => {
    const h = fixture();
    const ready = h.commit();
    h.repository.saveAttempt({ ...ready, status: "settled" });
    const snapshotRead = h.repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    const situation = snapshot.situations[0]!;
    situation.claims = situation.claims.filter(({ id }) => id === "unrelated");
    const attempt = h.repository.createAttempt(
      snapshotRead,
      "semantic_change",
      now,
      {
        situations: [
          {
            id: situation.id,
            episodeIds: situation.episodes.map(({ id }) => id),
            claimIds: ["unrelated"],
            preservedFields: [],
          },
        ],
      },
    );
    h.repository.saveAttempt({ ...attempt, status: "analyzing" });
    const output = structuredClone(h.output);
    output.delta.createSituations = [];
    output.decision.choices[0]!.situationId = situation.id;
    output.decision.selectedBasis.currentClaimRefs = [
      { situationId: situation.id, claimId: "preference" },
    ];
    expect(() => h.repository.commitAnalysis(attempt.id, output, now)).toThrow(
      "not supplied or created",
    );
  });

  it("does not execute after a required immutable source is deleted", () => {
    const h = fixture("current_object");
    const ready = h.commit();
    h.database
      .prepare("DELETE FROM cognition_evidence WHERE id = ?")
      .run(h.foreground.id);
    expect(h.repository.actionFreshness(ready, now)).toMatchObject({
      current: false,
      reason: "source_missing",
    });
  });

  it("still checks full entity CAS before committing analysis even when an unrelated state edit would allow the action", () => {
    const h = fixture();
    const ready = h.commit();
    h.repository.saveAttempt({ ...ready, status: "settled" });
    const snapshotRead = h.repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    const attempt = h.repository.createAttempt(
      snapshotRead,
      "semantic_change",
      now,
    );
    h.repository.saveAttempt({ ...attempt, status: "analyzing" });
    h.mutateSituation((situation) => ({
      ...situation,
      summary: "模型运行中真实更新",
    }));
    const output = structuredClone(h.output);
    output.delta.createSituations = [];
    output.decision.choices[0]!.situationId = snapshot.situations[0]!.id;
    expect(() => h.repository.commitAnalysis(attempt.id, output, now)).toThrow(
      "Situation or intent changed",
    );
  });

  it("does not consider its own supplied current-view evidence a later unseen change", () => {
    const h = fixture("current_object");
    const snapshotRead = h.repository.readSnapshot(personaId, now);
    const snapshot = snapshotRead.snapshot;
    snapshot.attention.lastReceiptSequence = h.background.receiptSequence;
    const attempt = h.repository.createAttempt(
      snapshotRead,
      "semantic_change",
      now,
    );
    h.repository.saveAttempt({ ...attempt, status: "analyzing" });
    h.output.delta.createSituations = [];
    delete h.output.decision.choices[0]!.situationId;
    const ready = h.repository.commitAnalysis(attempt.id, h.output, now);
    expect(h.repository.actionFreshness(ready, now)).toEqual({ current: true });
  });
});
