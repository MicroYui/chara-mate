import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import { CognitionService } from "./cognitionService";
import {
  projectCognitionContext,
  selectAnalysisSnapshot,
} from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionEvidenceInput,
  CognitionSituation,
  CognitionStateReferences,
} from "./cognitionTypes";
import type { EvidencePack } from "../../shared/contracts/memoryRecall";

const personaId = "11111111-1111-4111-8111-111111111111";
const otherPersona = "22222222-2222-4222-8222-222222222222";
const opened: Database.Database[] = [];
const services: CognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  opened.splice(0).forEach((database) => database.close());
});
function fixture(budget = 32_768) {
  const database = new Database(":memory:");
  opened.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  let tick = 0;
  const time = () =>
    new Date(Date.UTC(2026, 8, 15, 8, 0, tick++)).toISOString();
  for (const id of [personaId, otherPersona])
    database
      .prepare(
        "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      )
      .run(id, time(), time());
  const repository = new CognitionRepository(database, {
    readBudgetBytes: budget,
  });
  const utterance = (text: string, owner = personaId) => {
    const input: CognitionEvidenceInput = {
      id: randomUUID(),
      personaId: owner,
      actor: "user",
      kind: "utterance",
      source: {
        kind: "run",
        id: randomUUID(),
        fragment: randomUUID(),
        revision: "completed",
      },
      observedAt: time(),
      text,
    };
    return repository.ingest(input, time()).evidence;
  };
  const commit = (
    output: CognitionAnalysis,
    owner = personaId,
    references?: CognitionStateReferences,
    maxBytes = budget,
  ) => {
    const read = repository.readSnapshot(owner, time(), maxBytes, references);
    let attempt = repository.createAttempt(
      read,
      "semantic_change",
      time(),
      read.coverage.allocation,
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const done = repository.commitAnalysis(attempt.id, output, time());
    repository.saveAttempt({ ...done, status: "settled", updatedAt: time() });
    return done;
  };
  const close = (owner = personaId, claimOnly = false) => {
    const source = utterance(
      "九月账本已保存并读回1260；八月版保留，完成了。",
      owner,
    );
    const output = quiet([source.id]);
    output.delta.createSituations = [
      {
        localId: "new:ledger",
        value: {
          status: "closed",
          title: "九月账本",
          summary: "读回1260；八月保留",
          objectRefs: [],
          episodes: claimOnly
            ? []
            : [
                {
                  id: "save",
                  label: "保存核对",
                  state: "closed",
                  startedAt: source.observedAt,
                  endedAt: source.observedAt,
                  evidenceIds: [source.id],
                  objectKeys: [],
                  boundaryReason: "用户确认完成",
                },
              ],
          claims: [
            {
              id: "saved",
              text: "用户报告九月账本保存读回1260，八月版保留。",
              basis: "reported",
              state: "supported",
              evidenceIds: [source.id],
              contradictingEvidenceIds: [],
            },
          ],
          unresolved: [],
          relatedSituationIds: [],
        },
      },
    ];
    output.delta.createIntents = [
      {
        localId: "new:save",
        value: {
          situationId: "new:ledger",
          owner: "user",
          basis: "explicit_user",
          status: "fulfilled",
          completion: {
            evidenceUses: [{ evidenceId: source.id, basis: "user_report" }],
          },
          goal: "保存并核对九月账本",
          successCriteria: ["读回1260"],
          evidenceIds: [source.id],
          blockers: [],
          resumeConditions: [],
          progress: "用户确认已完成",
          effectEvidenceIds: [],
        },
      },
    ];
    output.decision.choices[0]!.situationId = "new:ledger";
    output.decision.choices[0]!.intentId = "new:save";
    const done = commit(output, owner);
    const situationId = done.decision!.choices[0]!.situationId!;
    const intentId = done.decision!.choices[0]!.intentId!;
    return { source, situationId, intentId, done };
  };
  return { database, repository, time, utterance, commit, close };
}
function quiet(evidenceIds: string[] = []): CognitionAnalysis {
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
          evidenceIds,
          rationale: "记录更正，不重复操作",
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
        evidenceUses: evidenceIds.map((evidenceId) => ({
          evidenceId,
          use: "history",
        })),
        currentClaimRefs: [],
      },
      reason: "保留正确范围",
    },
  };
}
function references(
  situationIds: string[],
  intentIds: string[] = [],
): CognitionStateReferences {
  return {
    situationIds,
    intentIds,
    missingReferenceCount: 0,
    truncated: false,
  };
}
function situationValue(old: CognitionSituation) {
  const value = { ...old };
  for (const key of ["id", "personaId", "revision", "createdAt", "updatedAt"])
    delete (value as unknown as Record<string, unknown>)[key];
  return value;
}
function changed(
  old: CognitionSituation,
  evidenceId: string,
): CognitionAnalysis {
  const output = quiet([evidenceId]);
  output.delta.updateSituations = [
    {
      id: old.id,
      expectedRevision: old.revision,
      value: {
        ...situationValue(old),
        claims: [
          ...old.claims,
          {
            id: "local-only",
            text: "用户更正：只保存在本地；八月1190是另一份文件，不是九月回退。",
            basis: "reported",
            state: "supported",
            evidenceIds: [evidenceId],
            contradictingEvidenceIds: [],
          },
        ],
      },
    },
  ];
  return output;
}

describe("Cognition historical state references", () => {
  it.each([0, -60_000])(
    "uses persistent creation order when the next attempt's clock moves by %d ms",
    (clockDelta) => {
      const f = fixture();
      const old = f.close();
      const createdAt = f.time();
      const previous = f.repository.saveAttempt({
        ...old.done,
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        dispatchKey: "cognition:previous",
        status: "settled",
        createdAt,
        updatedAt: createdAt,
      });
      expect(
        f.repository
          .readSnapshot(personaId, f.time())
          .snapshot.situations.map(({ id }) => id),
      ).toContain(old.situationId);
      const newest = f.repository.saveAttempt({
        ...previous,
        id: "00000000-0000-4000-8000-000000000000",
        dispatchKey: "cognition:newest",
        decision: quiet().decision,
        createdAt: new Date(Date.parse(createdAt) + clockDelta).toISOString(),
      });
      // Updating an earlier attempt does not make it the newest created one.
      f.repository.saveAttempt({
        ...previous,
        status: "failed",
        updatedAt: f.time(),
      });
      for (const vacuum of [false, true]) {
        if (vacuum) f.database.exec("VACUUM");
        const read = f.repository.readSnapshot(personaId, f.time());
        expect(read.snapshot.recentAttempts.map(({ id }) => id)).toEqual([
          newest.id,
        ]);
        expect(read.snapshot.situations.map(({ id }) => id)).not.toContain(
          old.situationId,
        );
        expect(read.snapshot.intents.map(({ id }) => id)).not.toContain(
          old.intentId,
        );
        expect(f.repository.hasFailedWork(personaId)).toBe(false);
        f.repository.saveAttempt({ ...newest, status: "failed" });
        expect(f.repository.hasFailedWork(personaId)).toBe(true);
        f.repository.saveAttempt({ ...newest, status: "settled" });
      }
    },
  );

  it("restores selected closed state with current revision, persists a correction and keeps the fulfilled goal quiet", () => {
    const f = fixture();
    const old = f.close();
    const correction = f.utterance(
      "只是本地保存，没有发给别人。八月1190是另一份，不是九月回退。",
    );
    const read = f.repository.readSnapshot(personaId, f.time());
    const situation = read.snapshot.situations.find(
      ({ id }) => id === old.situationId,
    )!;
    expect(situation.status).toBe("closed");
    expect(
      read.snapshot.intents.find(({ id }) => id === old.intentId)?.status,
    ).toBe("fulfilled");
    expect(situation.claims).toHaveLength(1);
    f.commit(changed(situation, correction.id));
    expect(
      f.repository.getSituation(old.situationId)?.claims.map(({ id }) => id),
    ).toContain("local-only");
    expect(f.repository.getSituation(old.situationId)?.status).toBe("closed");
    expect(f.repository.getIntent(old.intentId)?.status).toBe("fulfilled");
    expect(
      [...f.repository.pendingMemoryHandoffs()].some((job) =>
        job.primaryEvidenceIds.includes(correction.id),
      ),
    ).toBe(true);
    const ordinary = f.repository.readConversationContext(
      personaId,
      f.time(),
      { maxReadBytes: 16 * 1024 * 1024 },
      new AbortController().signal,
    );
    const prepared = projectCognitionContext(
      ordinary.snapshot,
      10_000,
      ordinary,
    );
    expect(prepared.situationIds).toEqual([]);
    expect(prepared.intentIds).toEqual([]);
  });

  it("does not renew closed residency merely because a later unrelated attempt read it", () => {
    const f = fixture();
    const old = f.close();
    for (let step = 0; step < 3; step += 1) {
      const source = f.utterance("我仍在说这份已保存的账本。");
      const use = quiet([source.id]);
      use.decision.choices[0]!.situationId = old.situationId;
      use.decision.choices[0]!.intentId = old.intentId;
      f.commit(use);
      expect(
        f.repository
          .readSnapshot(personaId, f.time())
          .snapshot.situations.map(({ id }) => id),
      ).toContain(old.situationId);
    }
    for (let step = 0; step < 3; step += 1) {
      f.utterance("天气不错。");
      f.commit(quiet());
      const read = f.repository.readSnapshot(personaId, f.time());
      expect(read.snapshot.situations.map(({ id }) => id)).not.toContain(
        old.situationId,
      );
      expect(read.snapshot.intents.map(({ id }) => id)).not.toContain(
        old.intentId,
      );
    }
  });

  it("renews only the situation selected through an actual current-claim basis", () => {
    const f = fixture();
    const old = f.close();
    const use = quiet([old.source.id]);
    use.decision.selectedBasis.currentClaimRefs = [
      { situationId: old.situationId, claimId: "saved" },
    ];
    f.commit(use);
    const read = f.repository.readSnapshot(personaId, f.time());
    expect(read.snapshot.situations.map(({ id }) => id)).toContain(
      old.situationId,
    );
    expect(read.snapshot.intents.map(({ id }) => id)).not.toContain(
      old.intentId,
    );
  });

  it("preserves mapping gaps through the existing bounded completion projection", () => {
    const f = fixture();
    const read = f.repository.readSnapshot(personaId, f.time(), 5000, {
      ...references([]),
      missingReferenceCount: 2,
      truncated: true,
    });
    const projected = selectAnalysisSnapshot(
      read.snapshot,
      5000,
      read.coverage,
    );
    expect(projected.coverage.stateReferences).toEqual({
      missing: false,
      omittedForBudget: false,
      sourceMappingMissingCount: 2,
      sourceMappingTruncated: true,
    });
  });

  it("bounds many historical parents by ID bytes without declaring the unvisited remainder absent", () => {
    const f = fixture();
    const old = f.close(personaId, true);
    const parent = f.repository.getSituation(old.situationId)!;
    const output = quiet([old.source.id]);
    output.delta.createSituations = Array.from({ length: 40 }, (_, i) => ({
      localId: `new:other-${i}`,
      value: situationValue(parent),
    }));
    f.commit(output);
    const group = [
      { candidateId: old.source.id, references: [old.source.source] },
    ];
    const all = f.repository.stateReferencesForSources(personaId, group, 10000);
    expect(all.situationIds).toHaveLength(41);
    expect(all.truncated).toBe(false);
    const bounded = f.repository.stateReferencesForSources(
      personaId,
      group,
      300,
    );
    expect(
      Buffer.byteLength(JSON.stringify(bounded), "utf8"),
    ).toBeLessThanOrEqual(300);
    expect(bounded.situationIds.length).toBeGreaterThan(0);
    expect(bounded.situationIds.length).toBeLessThan(all.situationIds.length);
    expect(bounded.truncated).toBe(true);
    expect(bounded.missingReferenceCount).toBe(0);
  });

  it("maps canonical alias groups through claim-only sources, separates personas and returns bounded parent IDs", () => {
    const f = fixture();
    const old = f.close(personaId, true);
    const foreign = f.close(otherPersona, true);
    const result = f.repository.stateReferencesForSources(
      personaId,
      [
        {
          candidateId: old.source.id,
          references: [
            { kind: "message", id: randomUUID() },
            old.source.source,
          ],
        },
        { candidateId: foreign.source.id, references: [foreign.source.source] },
      ],
      1000,
    );
    expect(result).toEqual({
      situationIds: [old.situationId],
      intentIds: [old.intentId],
      situationChildren: [
        { situationId: old.situationId, claimIds: ["saved"], episodeIds: [] },
      ],
      missingReferenceCount: 1,
      truncated: false,
    });
    expect(
      f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: old.source.id, references: [old.source.source] }],
        150,
      ).truncated,
    ).toBe(true);
    const input = f.utterance("没有关联事项的原话");
    expect(
      f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: input.id, references: [input.source] }],
        1000,
      ).missingReferenceCount,
    ).toBe(1);
  });

  it("reports missing and budget-limited state without granting writes to unread children", () => {
    const f = fixture();
    const old = f.close();
    const huge = "有来源的历史细节".repeat(3000);
    const current = f.repository.getSituation(old.situationId)!;
    const output = quiet([old.source.id]);
    output.delta.updateSituations = [
      {
        id: current.id,
        expectedRevision: current.revision,
        value: {
          ...situationValue(current),
          summary: huge,
          claims: [{ ...current.claims[0]!, text: huge }],
        },
      },
    ];
    f.commit(output);
    const read = f.repository.readSnapshot(
      personaId,
      f.time(),
      4500,
      references([old.situationId, randomUUID()]),
    );
    expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(
      4500,
    );
    expect(read.coverage.stateReferences?.missing).toBe(true);
    expect(
      read.coverage.allocation?.situations.find(
        ({ id }) => id === old.situationId,
      )?.claimIds,
    ).toEqual([]);
    let attempt = f.repository.createAttempt(
      read,
      "resume",
      f.time(),
      read.coverage.allocation,
    );
    attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    const illegal = quiet([old.source.id]);
    illegal.delta.updateSituations = [
      {
        id: old.situationId,
        expectedRevision: f.repository.getSituation(old.situationId)!.revision,
        value: {
          ...situationValue(current),
          claims: [{ ...current.claims[0]!, text: "偷换不可见旧事实" }],
        },
      },
    ];
    expect(() =>
      f.repository.commitAnalysis(attempt.id, illegal, f.time()),
    ).toThrow("unseen situation child");
    expect(() =>
      f.repository.readSnapshot(
        personaId,
        f.time(),
        1600,
        references([old.situationId]),
      ),
    ).toThrow("identity and coverage metadata");
    const empty = f.repository.readSnapshot(
      personaId,
      f.time(),
      2400,
      references([old.situationId]),
    );
    expect(empty.coverage.stateReferences?.omittedForBudget).toBe(true);
  });

  it.each(["claims", "episodes"] as const)(
    "restores a source-matched %s child among many unrelated children and preserves exact write allocation",
    (field) => {
      const f = fixture(250_000);
      const old = f.close(personaId, field === "claims");
      const current = f.repository.getSituation(old.situationId)!;
      const other = f.utterance("其他事项有各自的记录，不能覆盖九月账本。");
      const value = situationValue(current);
      if (field === "claims")
        value.claims = [
          current.claims[0]!,
          ...Array.from({ length: 100 }, (_, i) => ({
            ...current.claims[0]!,
            id: `unrelated-${i}`,
            text: `其他事项${i}${"独立细节".repeat(40)}`,
            evidenceIds: [other.id],
          })),
        ];
      else
        value.episodes = [
          current.episodes[0]!,
          ...Array.from({ length: 100 }, (_, i) => ({
            ...current.episodes[0]!,
            id: `unrelated-${i}`,
            label: `其他片段${i}${"独立细节".repeat(40)}`,
            evidenceIds: [other.id],
          })),
        ];
      const setup = quiet([old.source.id, other.id]);
      setup.delta.updateSituations = [
        { id: current.id, expectedRevision: current.revision, value },
      ];
      f.commit(setup);
      f.utterance("换一个话题");
      f.commit(quiet());
      const correction = f.utterance(
        "补充：九月账本只保存在本地，并没有发给别人。",
      );
      const refs = f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: old.source.id, references: [old.source.source] }],
        6000,
      );
      const read = f.repository.readSnapshot(personaId, f.time(), 6000, refs);
      const restored = read.snapshot.situations.find(
        ({ id }) => id === current.id,
      )!;
      const targetId = field === "claims" ? "saved" : "save";
      expect(restored[field].map(({ id }) => id)).toContain(targetId);
      expect(restored[field].length).toBeLessThan(value[field].length);
      expect(
        read.coverage.allocation?.situations.find(
          ({ id }) => id === current.id,
        )?.[field === "claims" ? "claimIds" : "episodeIds"],
      ).toContain(targetId);
      expect(read.snapshot.evidence.map(({ id }) => id)).toContain(
        old.source.id,
      );
      expect(
        Buffer.byteLength(JSON.stringify(read), "utf8"),
      ).toBeLessThanOrEqual(6000);
      const output = changed(restored, correction.id);
      output.decision.choices[0]!.situationId = restored.id;
      output.decision.choices[0]!.evidenceIds = [old.source.id, correction.id];
      output.decision.selectedBasis.evidenceUses = [
        old.source.id,
        correction.id,
      ].map((evidenceId) => ({ evidenceId, use: "history" }));
      output.decision.selectedBasis.currentClaimRefs = [
        { situationId: restored.id, claimId: "saved" },
      ];
      let attempt = f.repository.createAttempt(
        read,
        "resume",
        f.time(),
        read.coverage.allocation,
      );
      attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
      f.repository.commitAnalysis(attempt.id, output, f.time());
      expect(f.repository.getSituation(current.id)?.[field]).toHaveLength(
        value[field].length + Number(field === "claims"),
      );
    },
  );

  it("keeps the revision fence after a historical read", () => {
    const f = fixture();
    const old = f.close();
    const source = f.utterance("仅在本地保存");
    const read = f.repository.readSnapshot(
      personaId,
      f.time(),
      32_768,
      references([old.situationId]),
    );
    let attempt = f.repository.createAttempt(
      read,
      "resume",
      f.time(),
      read.coverage.allocation,
    );
    attempt = f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    const original = read.snapshot.situations.find(
      ({ id }) => id === old.situationId,
    )!;
    const intent = f.repository.getIntent(old.intentId)!;
    f.repository.saveIntent(
      {
        ...intent,
        revision: intent.revision + 1,
        progress: "另一领域提交了新进度",
        updatedAt: f.time(),
      },
      intent.revision,
    );
    expect(() =>
      f.repository.commitAnalysis(
        attempt.id,
        changed(original, source.id),
        f.time(),
      ),
    ).toThrow();
  });

  it("maintains claim reverse links across partial correction, retirement, rollback and cascade", () => {
    const f = fixture();
    const old = f.close(personaId, true);
    const original = f.repository.getSituation(old.situationId)!;
    const source = f.utterance("原报告有误，正确的是1270");
    const initial = quiet([source.id]);
    initial.delta.updateSituations = [
      {
        id: original.id,
        expectedRevision: original.revision,
        value: {
          ...situationValue(original),
          summary: "占位".repeat(9000),
          claims: [
            {
              ...original.claims[0]!,
              text: "用户更正为1270",
              evidenceIds: [source.id],
            },
          ],
        },
      },
    ];
    f.commit(initial);
    const read = f.repository.readSnapshot(
      personaId,
      f.time(),
      5000,
      references([old.situationId]),
    );
    expect(read.coverage.allocation?.situations).not.toEqual([]);
    const parent = read.snapshot.situations.find(
      ({ id }) => id === old.situationId,
    )!;
    const retirement = quiet([source.id]);
    retirement.delta.updateSituations = [
      {
        id: parent.id,
        expectedRevision: parent.revision,
        value: {
          ...situationValue(parent),
          claims: parent.claims.map((claim) => ({
            ...claim,
            state: "superseded",
          })),
        },
      },
    ];
    f.commit(retirement, personaId, references([old.situationId]), 5000);
    const links = f.database
      .prepare(
        "SELECT evidence_id,state FROM cognition_claim_evidence WHERE situation_id=? ORDER BY evidence_id",
      )
      .all(old.situationId) as { evidence_id: string; state: string }[];
    expect(links.map(({ evidence_id }) => evidence_id).sort()).toEqual(
      [source.id, old.source.id].sort(),
    );
    expect(links.every(({ state }) => state === "superseded")).toBe(true);
    expect(
      f.repository
        .protectedCanonicalSources([
          { candidateId: source.id, references: [source.source] },
        ])
        .flatMap(({ reasons }) => reasons),
    ).not.toContain("claim");
    const before = JSON.stringify(links);
    const bad = quiet();
    bad.delta.updateSituations = [
      {
        id: parent.id,
        expectedRevision: f.repository.getSituation(parent.id)!.revision,
        value: {
          ...situationValue(parent),
          claims: [{ ...parent.claims[0]!, evidenceIds: [randomUUID()] }],
        },
      },
    ];
    expect(() =>
      f.commit(bad, personaId, references([old.situationId]), 5000),
    ).toThrow();
    expect(
      JSON.stringify(
        f.database
          .prepare(
            "SELECT evidence_id,state FROM cognition_claim_evidence WHERE situation_id=? ORDER BY evidence_id",
          )
          .all(old.situationId),
      ),
    ).toBe(before);
    f.database
      .prepare("DELETE FROM cognition_situations WHERE id=?")
      .run(old.situationId);
    expect(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM cognition_claim_evidence WHERE situation_id=?",
        )
        .get(old.situationId),
    ).toEqual({ n: 0 });
  });

  it("keeps history discoverable without retaining its original after current support moves", () => {
    const f = fixture();
    const old = f.close(personaId, true);
    const current = f.repository.getSituation(old.situationId)!;
    const replacement = f.utterance("更正九月读回是1270，刚才1260不对。");
    const output = quiet([replacement.id]);
    output.delta.updateSituations = [
      {
        id: current.id,
        expectedRevision: current.revision,
        value: {
          ...situationValue(current),
          claims: [
            {
              ...current.claims[0]!,
              text: "用户更正九月读回为1270",
              evidenceIds: [replacement.id],
            },
          ],
        },
      },
    ];
    const priorIntent = f.repository.getIntent(old.intentId)!;
    const intentValue = { ...priorIntent } as Record<string, unknown>;
    for (const field of [
      "id",
      "personaId",
      "revision",
      "createdAt",
      "updatedAt",
      "completion",
    ])
      delete intentValue[field];
    output.delta.updateIntents = [
      {
        id: priorIntent.id,
        expectedRevision: priorIntent.revision,
        completionOperation: "clear",
        value: {
          ...intentValue,
          status: "abandoned",
        } as CognitionAnalysis["delta"]["updateIntents"][number]["value"],
      },
    ];
    f.commit(output);
    f.database.transaction(() => {
      for (const job of f.repository.pendingMemoryHandoffs())
        f.repository.acknowledgeMemoryHandoff(job.id);
    })();
    const stored = f.repository.getSituation(old.situationId)!.claims[0]!;
    expect(stored.historyEvidenceIds).toContain(old.source.id);
    expect(
      f.repository.protectedCanonicalSources([
        { candidateId: old.source.id, references: [old.source.source] },
      ]),
    ).toEqual([]);
    expect(
      f.repository.protectedCanonicalSources([
        { candidateId: replacement.id, references: [replacement.source] },
      ])[0]?.reasons,
    ).toContain("claim");
    expect(
      f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: old.source.id, references: [old.source.source] }],
        1000,
      ).situationIds,
    ).toEqual([old.situationId]);
    const row = f.database
      .prepare(
        "SELECT current_basis FROM cognition_claim_evidence WHERE situation_id=? AND evidence_id=?",
      )
      .get(old.situationId, old.source.id);
    expect(row).toEqual({ current_basis: 0 });
    // A historical source can later also be explicit current support; one row
    // must represent that current consumer rather than whichever use was inserted first.
    const latest = f.repository.getSituation(old.situationId)!;
    const reaffirm = quiet([old.source.id, replacement.id]);
    reaffirm.delta.updateSituations = [
      {
        id: latest.id,
        expectedRevision: latest.revision,
        value: {
          ...situationValue(latest),
          claims: [
            {
              ...latest.claims[0]!,
              evidenceIds: [old.source.id, replacement.id],
            },
          ],
        },
      },
    ];
    f.commit(
      reaffirm,
      personaId,
      f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: old.source.id, references: [old.source.source] }],
        32768,
      ),
    );
    expect(
      f.repository.getSituation(old.situationId)!.claims[0]!.historyEvidenceIds,
    ).toContain(old.source.id);
    expect(
      f.database
        .prepare(
          "SELECT current_basis FROM cognition_claim_evidence WHERE situation_id=? AND evidence_id=?",
        )
        .get(old.situationId, old.source.id),
    ).toEqual({ current_basis: 1 });
  });

  it("removes a deleted claim's reverse links while preserving the remaining canonical claim", () => {
    const f = fixture();
    const old = f.close(personaId, true);
    const other = f.utterance("今天还有另一个独立记录。");
    const current = f.repository.getSituation(old.situationId)!;
    const output = quiet([other.id]);
    output.delta.updateSituations = [
      {
        id: current.id,
        expectedRevision: current.revision,
        value: {
          ...situationValue(current),
          claims: [
            {
              ...current.claims[0]!,
              id: "other",
              text: "用户报告另一件事",
              evidenceIds: [other.id],
            },
          ],
        },
      },
    ];
    f.commit(output);
    expect(
      f.repository.getSituation(old.situationId)!.claims.map(({ id }) => id),
    ).toEqual(["other"]);
    expect(
      f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: old.source.id, references: [old.source.source] }],
        1000,
      ).missingReferenceCount,
    ).toBe(1);
    expect(
      f.repository.stateReferencesForSources(
        personaId,
        [{ candidateId: other.id, references: [other.source] }],
        1000,
      ).situationIds,
    ).toEqual([old.situationId]);
  });

  it.each([false, true])(
    "passes the actual attempt Persona and mapped parents to completion despite pending receipts=%s",
    async (backlog) => {
      const f = fixture();
      const old = f.close(personaId, true);
      f.utterance("现在换个话题");
      f.commit(quiet());
      const revisionId = randomUUID();
      const pack: EvidencePack = {
        items: [
          {
            memoryId: randomUUID(),
            revisionId,
            type: "event",
            content: "九月本地账本读回1260",
            historyStatus: "current",
            basis: "explicit_user_statement",
            owner: "user",
            entityIds: [],
            sourceRefs: [],
            recordedAt: old.source.observedAt,
            current: true,
            questionIds: ["q"],
          },
        ],
        coverage: [
          { questionId: "q", status: "supported", revisionIds: [revisionId] },
        ],
        gaps: [],
        estimatedTokens: 100,
        truncated: false,
        incompleteReasons: [],
      };
      const resolver = vi.fn(
        (owner: string, _items: EvidencePack["items"], budget: number) =>
          f.repository.stateReferencesForSources(
            owner,
            [{ candidateId: old.source.id, references: [old.source.source] }],
            budget,
          ),
      );
      const errors: unknown[] = [];
      const driver = {
        analyze: vi.fn((input: CognitionAnalysisInput) => {
          const output = quiet(input.snapshot.evidence.map(({ id }) => id));
          if (!input.evidencePack) {
            expect(
              input.snapshot.situations.find(
                ({ id }) => id === old.situationId,
              ),
            ).toBeUndefined();
            output.recallPlan = {
              purpose: "initiative",
              query: "上次九月账本",
              questions: [{ id: "q", text: "九月账本和八月版分别是什么？" }],
              contextBudget: { maxTokens: 1000 },
            };
            return Promise.resolve(output);
          }
          const parent = input.snapshot.situations.find(
            ({ id }) => id === old.situationId,
          )!;
          expect(parent.status).toBe("closed");
          expect(parent.revision).toBe(
            f.repository.getSituation(old.situationId)!.revision,
          );
          expect(
            input.snapshot.intents.find(({ id }) => id === old.intentId)
              ?.status,
          ).toBe("fulfilled");
          expect(parent.claims.map(({ id }) => id)).toContain("saved");
          expect(
            input.snapshot.evidence.find(({ id }) => id === old.source.id)
              ?.text,
          ).toBe(old.source.text);
          expect(input.attempt.dependencies.evidenceIds).toContain(
            old.source.id,
          );
          expect(
            input.snapshot.evidence.some(({ text }) =>
              text?.startsWith("后续窗口"),
            ),
          ).toBe(false);
          const correction = input.snapshot.evidence.find(
            ({ text, kind }) =>
              kind === "utterance" && text?.startsWith("补充："),
          )!;
          const outputWithCorrection = changed(parent, correction.id);
          outputWithCorrection.delta.updateSituations[0]!.value.claims =
            outputWithCorrection.delta.updateSituations[0]!.value.claims.map(
              (claim) =>
                claim.id === "saved"
                  ? {
                      ...claim,
                      text: `${claim.text} 新补充：仅保存在本地。`,
                      evidenceIds: [old.source.id, correction.id],
                    }
                  : claim,
            );
          outputWithCorrection.decision.choices[0]!.situationId = parent.id;
          outputWithCorrection.decision.choices[0]!.evidenceIds = [
            old.source.id,
            correction.id,
          ];
          outputWithCorrection.decision.selectedBasis.evidenceUses = [
            old.source.id,
            correction.id,
          ].map((evidenceId) => ({ evidenceId, use: "history" }));
          outputWithCorrection.decision.selectedBasis.currentClaimRefs = [
            { situationId: parent.id, claimId: "saved" },
          ];
          return Promise.resolve(outputWithCorrection);
        }),
      };
      const dispatch = vi.fn(() => Promise.resolve({ runId: randomUUID() }));
      const service = new CognitionService({
        repository: f.repository,
        driver,
        memory: {
          recall: () => {
            if (backlog)
              for (let i = 0; i < 60; i += 1)
                f.repository.ingest(
                  {
                    id: randomUUID(),
                    personaId,
                    actor: "user",
                    kind: "observation",
                    source: { kind: "activity", id: randomUUID() },
                    observedAt: f.time(),
                    text: `后续窗口${i}：${"别的文档内容".repeat(120)}`,
                  },
                  f.time(),
                );
            return Promise.resolve(pack);
          },
          resolveEvidence: () => ({
            status: "resolved",
            items: [],
            readCost: { rawValueBytes: 0, rowCount: 0 },
          }),
          validateEvidenceReferences: () => [],
        },
        runtime: {
          availability: () => ({
            userEngaged: false,
            activeUserRunIds: [],
            chatRuns: [],
            activeVoice: false,
            sleeping: false,
            hasOutstandingBubble: false,
            mayInitiateConversation: true,
            characterTools: [],
            mayActInTerritory: true,
          }),
          dispatch,
          yieldCharacterRun: () => Promise.resolve(),
          reconcileRun: () => ({ terminal: true, evidence: [] }),
        },
        clock: { now: f.time },
        activePersonaId: () => personaId,
        analysisReadBudgetBytes: 32_768,
        analysisBudgetTokens: 32_768,

        batchWindowMs: 0,
        resolveMemoryStateReferences: resolver,
        onError: (error) => errors.push(error),
      });
      services.push(service);
      const source: CognitionEvidenceInput = {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "utterance",
        source: { kind: "run", id: randomUUID(), fragment: randomUUID() },
        observedAt: f.time(),
        text: "补充：只是本地保存。八月1190是另一份，不是九月回退。",
      };
      service.ingest(source);
      await service.runDue("2026-09-16T08:00:00.000Z");
      expect(errors).toEqual([]);
      expect(driver.analyze).toHaveBeenCalledTimes(2);
      expect(resolver.mock.calls[0]?.[0]).toBe(personaId);
      expect(resolver.mock.calls[0]?.[1]).toEqual(pack.items);
      expect(
        f.repository.getSituation(old.situationId)?.claims.map(({ id }) => id),
      ).toContain("local-only");
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
