import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import { decodeCognitionModelOutput } from "./cognitionModelOutput";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
} from "./cognitionTypes";

const now = "2026-09-15T08:00:00.000Z";
const personaId = "11111111-1111-4111-8111-111111111111";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function quiet(): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: {},
    },
    decision: {
      selectedChoiceId: "quiet",
      selectedBasis: {
        choiceId: "quiet",
        evidenceUses: [],
        currentClaimRefs: [],
      },
      reason: "只更新已有材料",
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: [],
          rationale: "没有新的执行请求",
          userImpact: "none",
          executionScope: "none",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
        },
      ],
    },
  };
}

function setup(partial = false, linked = false) {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys=ON");
  db.exec(CURRENT_SCHEMA_SQL);
  db.prepare(
    "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES(?,'custom',1,?,?)",
  ).run(personaId, now, now);
  const repo = new CognitionRepository(db, { readBudgetBytes: 32_768 });
  const evidenceId = randomUUID();
  repo.ingest(
    {
      id: evidenceId,
      personaId,
      actor: "user",
      kind: "observation",
      source: { kind: "activity", id: evidenceId },
      observedAt: now,
      text: "草稿尚未提交",
      boundary: "content",
    },
    now,
  );
  const initial = quiet();
  initial.delta.createSituations.push({
    localId: "new:draft",
    value: {
      status: "current",
      title: "草稿",
      summary: "完整正文，不应被局部摘要覆盖",
      objectRefs: [],
      unresolved: ["是否提交尚未确认"],
      relatedSituationIds: [],
      episodes: ["start", "hidden", "edit"].map((id) => ({
        id,
        label: id,
        state: "open",
        startedAt: now,
        evidenceIds: [evidenceId],
        objectKeys: [],
        boundaryReason: "实际编辑阶段",
      })),
      claims: ["draft", "hidden-claim", "unsubmitted"].map((id) => ({
        id,
        text: id,
        basis: "observed",
        state: "supported",
        evidenceIds: [evidenceId],
        contradictingEvidenceIds: [],
      })),
    },
  });
  initial.delta.createIntents.push({
    localId: "new:review",
    value: {
      owner: "user",
      basis: "inferred_user",
      status: "candidate",
      goal: "可能正在修改草稿",
      successCriteria: [],
      evidenceIds: [evidenceId],
      blockers: ["缺少明确请求"],
      resumeConditions: [],
      progress: "仍在编辑",
      effectEvidenceIds: [],
      nextWakeAt: now,
    },
  });
  if (linked) {
    initial.delta.createSituations[0]!.value.supersededBy = "new:replacement";
    initial.delta.createSituations.push({
      localId: "new:replacement",
      value: {
        ...initial.delta.createSituations[0]!.value,
        title: "替代材料",
        status: "background",
        episodes: [],
        claims: [],
      },
    });
    delete initial.delta.createSituations[1]!.value.supersededBy;
  }
  let first = repo.createAttempt(
    repo.readSnapshot(personaId, now),
    "semantic_change",
    now,
  );
  first = repo.saveAttempt({ ...first, status: "analyzing" });
  const committed = repo.commitAnalysis(first.id, initial, now);
  repo.saveAttempt({ ...committed, status: "settled", outcome: "quiet" });
  const snapshotRead = repo.readSnapshot(personaId, now);
  const snapshot = snapshotRead.snapshot;
  const canonical = structuredClone(
    snapshot.situations.find((value) => value.title === "草稿")!,
  );
  const situation = snapshot.situations.find(
    (value) => value.title === "草稿",
  )!;
  if (partial) {
    situation.episodes = situation.episodes.filter((x) => x.id !== "hidden");
    situation.claims = situation.claims.filter((x) => x.id !== "hidden-claim");
    situation.summary = "INCOMPLETE EXCERPT";
  }
  let attempt = repo.createAttempt(
    snapshotRead,
    "semantic_change",
    now,
    partial
      ? {
          situations: [
            {
              id: situation.id,
              episodeIds: situation.episodes.map((x) => x.id),
              claimIds: situation.claims.map((x) => x.id),
              preservedFields: ["summary"],
            },
          ],
        }
      : undefined,
  );
  attempt = repo.saveAttempt({ ...attempt, status: "analyzing" });
  const input: CognitionAnalysisInput = {
    attempt,
    snapshot,
    availability: {
      userEngaged: false,
      activeUserRunIds: [],
      chatRuns: [],
      activeVoice: false,
      sleeping: false,
      hasOutstandingBubble: false,
      mayInitiateConversation: true,
      characterTools: [],
      mayActInTerritory: true,
    },
  };
  return { db, repo, input, situation, canonical, evidenceId };
}

function situationChanges() {
  return {
    status: null,
    title: null,
    summary: null,
    objectRefs: null,
    episodes: [] as unknown[],
    claims: [] as unknown[],
    episodeOrder: null as string[] | null,
    claimOrder: null as string[] | null,
    unresolved: null as string[] | null,
    relatedSituationIds: null,
    journeyId: { op: "keep" },
    togetherSessionId: { op: "keep" },
    supersededBy: { op: "keep" },
  };
}
function wire(
  h: ReturnType<typeof setup>,
  changes: unknown = situationChanges(),
) {
  const output = quiet();
  return {
    ...output,
    recallPlan: null,
    delta: {
      ...output.delta,
      attention: {
        currentSituationId: { op: "keep" },
        committedIntentId: { op: "keep" },
      },
      updateSituations: [
        { id: h.situation.id, expectedRevision: h.situation.revision, changes },
      ],
      updateIntents: [] as unknown[],
    },
  };
}
function episode(id: string) {
  return {
    id,
    label: null,
    state: null,
    startedAt: null,
    endedAt: { op: "keep" },
    evidenceIds: null,
    objectKeys: null,
    boundaryReason: null,
  };
}
function claim(id: string) {
  return {
    id,
    text: null,
    basis: null,
    state: null,
    evidenceIds: null,
    contradictingEvidenceIds: null,
    alternative: { op: "keep" },
  };
}
function commit(h: ReturnType<typeof setup>, output: unknown) {
  return h.repo.commitAnalysis(
    h.input.attempt.id,
    decodeCognitionModelOutput(output, h.input),
    now,
  );
}

describe("typed cognition model updates", () => {
  it.each([false, true])(
    "clears and later restores a supersededBy reference (partial=%s)",
    (partial) => {
      const h = setup(partial, true);
      const replacementId = h.canonical.supersededBy!;
      commit(
        h,
        wire(h, { ...situationChanges(), supersededBy: { op: "clear" } }),
      );
      expect(h.repo.getSituation(h.situation.id)).not.toHaveProperty(
        "supersededBy",
      );
      expect(
        h.db
          .prepare("SELECT superseded_by FROM cognition_situations WHERE id=?")
          .get(h.situation.id),
      ).toEqual({ superseded_by: null });
      const completed = h.repo.getAttempt(h.input.attempt.id)!;
      h.repo.saveAttempt({ ...completed, status: "settled", outcome: "quiet" });
      const nextRead = h.repo.readSnapshot(personaId, now);
      h.input.snapshot = nextRead.snapshot;
      h.situation = h.input.snapshot.situations.find(
        (x) => x.id === h.situation.id,
      )!;
      const next = h.repo.createAttempt(nextRead, "semantic_change", now);
      h.input.attempt = h.repo.saveAttempt({ ...next, status: "analyzing" });
      commit(
        h,
        wire(h, {
          ...situationChanges(),
          supersededBy: { op: "set", value: replacementId },
        }),
      );
      expect(h.repo.getSituation(h.situation.id)?.supersededBy).toBe(
        replacementId,
      );
    },
  );

  it("does not clear an optional reference hidden by preservedFields", () => {
    const h = setup(true, true);
    h.input.attempt.allocation!.situations[0]!.preservedFields.push(
      "supersededBy",
    );
    h.input.attempt = h.repo.saveAttempt(h.input.attempt);
    delete h.situation.supersededBy;
    commit(
      h,
      wire(h, { ...situationChanges(), supersededBy: { op: "clear" } }),
    );
    expect(h.repo.getSituation(h.situation.id)?.supersededBy).toBe(
      h.canonical.supersededBy,
    );
  });

  it("keeps retired raw support in canonical claim history when current support changes", () => {
    const h = setup();
    const later = randomUUID();
    h.repo.ingest(
      {
        id: later,
        personaId,
        actor: "user",
        kind: "observation",
        source: { kind: "activity", id: later },
        observedAt: now,
        text: "修改后的实际草稿",
      },
      now,
    );
    h.repo.saveAttempt({ ...h.input.attempt, status: "superseded" });
    const nextRead = h.repo.readSnapshot(personaId, now);
    h.input.snapshot = nextRead.snapshot;
    const attempt = h.repo.createAttempt(nextRead, "semantic_change", now);
    h.input.attempt = h.repo.saveAttempt({ ...attempt, status: "analyzing" });
    const changes = situationChanges();
    changes.claims = [
      { ...claim("draft"), text: "修改后的实际草稿", evidenceIds: [later] },
    ];
    commit(h, wire(h, changes));
    expect(
      h.repo.getSituation(h.situation.id)!.claims.find((x) => x.id === "draft"),
    ).toMatchObject({
      evidenceIds: [later],
      historyEvidenceIds: [h.evidenceId],
    });
  });

  it("keeps required nulls but applies explicit empty arrays without mutating the supplied view", () => {
    const h = setup();
    const before = structuredClone(h.input);
    const changes = situationChanges();
    changes.unresolved = [];
    const decoded = decodeCognitionModelOutput(wire(h, changes), h.input);
    expect(decoded.delta.updateSituations[0]!.value.summary).toBe(
      h.canonical.summary,
    );
    expect(decoded.delta.updateSituations[0]!.value.unresolved).toEqual([]);
    expect(h.input).toEqual(before);
    commit(h, wire(h, changes));
    expect(h.repo.getSituation(h.situation.id)?.unresolved).toEqual([]);
  });

  it.each([false, true])(
    "restores strict nested optional nulls and clears optional schedule state (partial=%s)",
    (partial) => {
      const h = setup(partial);
      if (partial) {
        const intent = h.input.snapshot.intents[0]!;
        h.input.attempt = h.repo.saveAttempt({
          ...h.input.attempt,
          allocation: {
            ...h.input.attempt.allocation!,
            intents: [
              {
                id: intent.id,
                evidenceIds: intent.evidenceIds,
                effectEvidenceIds: [],
                preservedFields: [],
              },
            ],
          },
        });
      }
      expect(h.repo.earliestNextRunAt(personaId)).toBe(now);
      const changes = {
        ...situationChanges(),
        objectRefs: [
          {
            key: "draft",
            identity: "adapter",
            appId: null,
            appName: "编辑器",
            url: null,
            title: null,
          },
        ],
      };
      const result = wire(h, changes);
      const intent = h.input.snapshot.intents[0]!;
      result.delta.updateIntents = [
        {
          id: intent.id,
          expectedRevision: intent.revision,
          changes: {
            situationId: { op: "set", value: h.situation.id },
            journeyId: { op: "keep" },
            owner: null,
            basis: null,
            status: null,
            goal: null,
            successCriteria: null,
            evidenceIds: null,
            blockers: null,
            progress: null,
            effectEvidenceIds: null,
            resumeConditions: [
              {
                kind: "new_evidence",
                description: "用户确认",
                referenceId: null,
                after: null,
              },
            ],
            nextWakeAt: { op: "clear" },
            completion: { op: "keep" },
          },
        },
      ];
      const decoded = decodeCognitionModelOutput(result, h.input);
      expect(decoded.delta.updateSituations[0]!.value.objectRefs).toEqual([
        { key: "draft", identity: "adapter", appName: "编辑器" },
      ]);
      expect(decoded.delta.updateIntents[0]!.value).toMatchObject({
        situationId: h.situation.id,
        goal: intent.goal,
        resumeConditions: [{ kind: "new_evidence", description: "用户确认" }],
      });
      expect(decoded.delta.updateIntents[0]!.value).not.toHaveProperty(
        "nextWakeAt",
      );
      commit(h, result);
      expect(h.repo.getIntent(intent.id)).not.toHaveProperty("nextWakeAt");
      expect(h.repo.earliestNextRunAt(personaId)).toBeUndefined();
    },
  );

  it("updates a claim by ID while retaining host provenance and untouched children", () => {
    const h = setup();
    h.situation.claims[0]!.historyEvidenceIds = [h.evidenceId];
    const changes = situationChanges();
    changes.claims = [
      { ...claim("draft"), text: "这是编辑器的当前草稿", state: "disputed" },
    ];
    const decoded = decodeCognitionModelOutput(wire(h, changes), h.input);
    const actual = decoded.delta.updateSituations[0]!.value.claims;
    expect(actual.map((x) => x.id)).toEqual(
      h.situation.claims.map((x) => x.id),
    );
    expect(actual[0]).toMatchObject({
      text: "这是编辑器的当前草稿",
      state: "disputed",
      historyEvidenceIds: [h.evidenceId],
    });
    expect(actual.slice(1)).toEqual(h.situation.claims.slice(1));
  });

  it("creates a fully specified child and leaves optional keep absent", () => {
    const h = setup();
    const changes = situationChanges();
    changes.episodes = [
      {
        ...episode("review"),
        label: "核对材料",
        state: "open",
        startedAt: now,
        evidenceIds: [h.evidenceId],
        objectKeys: [],
        boundaryReason: "进入新阶段",
      },
    ];
    commit(h, wire(h, changes));
    expect(h.repo.getSituation(h.situation.id)!.episodes.at(-1)).toMatchObject({
      id: "review",
      label: "核对材料",
    });
    expect(
      h.repo.getSituation(h.situation.id)!.episodes.at(-1),
    ).not.toHaveProperty("endedAt");
  });

  it("uses an explicit full permutation and makes the next bounded read match committed order", () => {
    const h = setup();
    const changes = situationChanges();
    changes.episodeOrder = ["edit", "start", "hidden"];
    changes.claimOrder = ["unsubmitted", "draft", "hidden-claim"];
    commit(h, wire(h, changes));
    const stored = h.repo.getSituation(h.situation.id)!;
    expect(stored.episodes.map((x) => x.id)).toEqual(changes.episodeOrder);
    expect(stored.claims.map((x) => x.id)).toEqual(changes.claimOrder);
    const next = h.repo
      .readSnapshot(personaId, now)
      .snapshot.situations.find((x) => x.id === stored.id)!;
    expect(next.episodes.map((x) => x.id)).toEqual(changes.episodeOrder);
    expect(next.claims.map((x) => x.id)).toEqual(changes.claimOrder);
  });

  it("preserves hidden episode/claim slots and canonical protected scalar on a partial update", () => {
    const h = setup(true);
    const changes = situationChanges();
    changes.episodeOrder = h.situation.episodes.map((x) => x.id).reverse();
    changes.claimOrder = h.situation.claims.map((x) => x.id).reverse();
    changes.claims = [{ ...claim("draft"), text: "可见草稿有新变化" }];
    commit(h, wire(h, changes));
    const stored = h.repo.getSituation(h.situation.id)!;
    expect(stored.summary).toBe(h.canonical.summary);
    expect(stored.episodes).toEqual(h.canonical.episodes);
    expect(stored.claims.map((x) => x.id)).toEqual(
      h.canonical.claims.map((x) => x.id),
    );
    expect(stored.claims.find((x) => x.id === "hidden-claim")).toEqual(
      h.canonical.claims.find((x) => x.id === "hidden-claim"),
    );
    expect(stored.claims.find((x) => x.id === "draft")?.text).toBe(
      "可见草稿有新变化",
    );
  });

  it("does not let a supplied parent authorize editing an unseen child", () => {
    const h = setup(true);
    const changes = situationChanges();
    const hidden = h.canonical.claims.find((x) => x.id === "hidden-claim")!;
    changes.claims = [
      { ...hidden, alternative: { op: "keep" }, text: "未经提供的改写" },
    ];
    expect(() => commit(h, wire(h, changes))).toThrow("unseen situation child");
    expect(h.repo.getSituation(h.situation.id)).toEqual(h.canonical);
  });

  it("retains the repository revision check after local model expansion", () => {
    const h = setup();
    const result = decodeCognitionModelOutput(wire(h), h.input);
    h.db
      .prepare(
        "UPDATE cognition_situations SET revision=revision+1,payload_json=json_set(payload_json,'$.revision',revision+1) WHERE id=?",
      )
      .run(h.situation.id);
    expect(() =>
      h.repo.commitAnalysis(h.input.attempt.id, result, now),
    ).toThrow("changed");
  });

  it.each([
    { ...situationChanges(), episodes: [episode("new-incomplete")] },
    { ...situationChanges(), claims: [claim("draft"), claim("draft")] },
    { ...situationChanges(), episodeOrder: ["start", "start", "hidden"] },
    { ...situationChanges(), claimOrder: ["draft"] },
    { ...situationChanges(), objectRefs: [{ key: "draft", identity: null }] },
    { ...situationChanges(), journeyId: { op: "set" } },
    {
      ...situationChanges(),
      claims: [{ ...claim("draft"), historyEvidenceIds: [] }],
    },
    { ...situationChanges(), inventedField: "not allowed" },
  ])(
    "rejects malformed or semantically incomplete typed changes %#",
    (changes) => {
      const h = setup();
      expect(() =>
        decodeCognitionModelOutput(wire(h, changes), h.input),
      ).toThrow();
    },
  );

  it("rejects an omitted parent and duplicate parent updates", () => {
    const h = setup();
    const missing = wire(h);
    missing.delta.updateSituations[0]!.id = randomUUID();
    expect(() => decodeCognitionModelOutput(missing, h.input)).toThrow(
      "not in supplied view",
    );
    const duplicate = wire(h);
    duplicate.delta.updateSituations.push(duplicate.delta.updateSituations[0]!);
    expect(() => decodeCognitionModelOutput(duplicate, h.input)).toThrow(
      "Duplicate entity ID",
    );
  });
});
