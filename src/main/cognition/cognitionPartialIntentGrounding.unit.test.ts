import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import type {
  CognitionAnalysis,
  CognitionEvidence,
  CognitionIntent,
  CognitionSnapshot,
} from "./cognitionTypes";

const personaId = "11111111-1111-4111-8111-111111111111";
const otherPersonaId = "22222222-2222-4222-8222-222222222222";
const earlier = "2026-09-15T08:00:00.000Z";
const now = "2026-09-15T08:00:10.000Z";
const databases: Database.Database[] = [];

afterEach(() => databases.splice(0).forEach((database) => database.close()));

function fixture(
  grounding: {
    actor?: "user" | "agent";
    kind?: "utterance" | "observation";
    personaId?: string;
    receivedAt?: string;
    basis?: "explicit_user" | "inferred_user" | "character";
  } = {},
) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  for (const id of [personaId, otherPersonaId])
    database
      .prepare(
        "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      )
      .run(id, earlier, earlier);
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 6_000,
  });
  const original = repository.ingest(
    {
      id: randomUUID(),
      personaId: grounding.personaId ?? personaId,
      actor: grounding.actor ?? "user",
      kind: grounding.kind ?? "utterance",
      source: { kind: "run", id: randomUUID(), revision: "completed" },
      observedAt: earlier,
      text: "请区分本地保存和对外发送，不能因为有文件就说已经送达。",
    },
    grounding.receivedAt ?? earlier,
  ).evidence;
  const observed = repository.ingest(
    {
      id: randomUUID(),
      personaId,
      actor: "user",
      kind: "observation",
      source: { kind: "activity", id: randomUUID() },
      observedAt: now,
      text: "本地已保存，远端送达未知。",
    },
    now,
  ).evidence;
  const basis = grounding.basis ?? "explicit_user";
  const intent: CognitionIntent = {
    id: randomUUID(),
    personaId,
    revision: 1,
    owner: basis === "character" ? "character" : "user",
    basis,
    status: basis === "inferred_user" ? "candidate" : "active",
    goal: "区分账本本地保存和实际送达",
    successCriteria: [],
    evidenceIds: [original.id],
    effectEvidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "已有请求尚无送达结果",
    createdAt: earlier,
    updatedAt: earlier,
  };
  repository.saveIntent(intent);
  repository.updateAttention(personaId, now, (state) => ({
    ...state,
    committedIntentId: intent.id,
  }));
  return { database, repository, original, observed, intent };
}

function prepare(
  f: ReturnType<typeof fixture>,
  partial = true,
  supplied: CognitionEvidence[] = [f.observed],
) {
  const view: CognitionIntent = {
    ...f.intent,
    evidenceIds: partial ? [] : f.intent.evidenceIds,
  };
  const snapshot: CognitionSnapshot = {
    attention: f.repository.getAttention(personaId, now),
    situations: [],
    intents: [view],
    evidence: supplied,
    recentAttempts: [],
  };
  const allocation = partial
    ? {
        situations: [],
        intents: [
          {
            id: f.intent.id,
            evidenceIds: [],
            effectEvidenceIds: [],
            preservedFields: [],
          },
        ],
      }
    : undefined;
  const created = f.repository.createAttempt(
    {
      snapshot,
      receivedThroughSequence: snapshot.attention.lastReceiptSequence,
    },
    "resume",
    now,
    allocation,
  );
  const attempt = f.repository.saveAttempt({ ...created, status: "analyzing" });
  const value = Object.fromEntries(
    Object.entries(view).filter(
      ([key]) =>
        !["id", "personaId", "revision", "createdAt", "updatedAt"].includes(
          key,
        ),
    ),
  ) as CognitionAnalysis["delta"]["updateIntents"][number]["value"];
  const analysis: CognitionAnalysis = {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [
        {
          id: f.intent.id,
          expectedRevision: 1,
          value: {
            ...value,
            evidenceIds: [f.observed.id],
            progress: "新观察为本地已保存、远端送达未知。",
          },
        },
      ],
      attention: {},
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          intentId: f.intent.id,
          evidenceIds: [f.observed.id],
          rationale: "更新已知的局部状态，不声称实际送达。",
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
        evidenceUses: [{ evidenceId: f.observed.id, use: "history" }],
        currentClaimRefs: [],
      },
      reason: "保持未知且不打断",
    },
  };
  return {
    attempt,
    analysis,
    value: analysis.delta.updateIntents[0]!.value,
    commit: () => f.repository.commitAnalysis(attempt.id, analysis, now),
  };
}

describe("partial Intent retained user grounding", () => {
  it("keeps real canonical request support when it was omitted from the entire input", () => {
    const f = fixture();
    const run = prepare(f);
    expect(run.attempt.dependencies.evidenceIds).not.toContain(f.original.id);
    run.commit();
    const stored = f.repository.getIntent(f.intent.id)!;
    expect(stored.revision).toBe(2);
    expect(stored.evidenceIds).toEqual([f.original.id, f.observed.id]);
    expect(stored.progress).toBe(run.value.progress);
    expect(stored.status).toBe("active");
    expect(stored.effectEvidenceIds).toEqual([]);
    expect(run.value.evidenceIds).toEqual([f.observed.id]);
  });

  it("also preserves canonical grounding when the original user utterance is independently supplied", () => {
    const f = fixture();
    const run = prepare(f, true, [f.original, f.observed]);
    run.commit();
    expect(f.repository.getIntent(f.intent.id)?.evidenceIds).toEqual([
      f.original.id,
      f.observed.id,
    ]);
  });

  it("retains full-view replacement semantics and rejects dropping the only user basis", () => {
    const f = fixture();
    const run = prepare(f, false, [f.original, f.observed]);
    expect(run.commit).toThrow(
      "Explicit user intent requires a user utterance",
    );
    expect(f.repository.getIntent(f.intent.id)).toEqual(f.intent);
  });

  it("can replace full-view support with a different actual supplied user utterance", () => {
    const f = fixture();
    const replacement = f.repository.ingest(
      {
        id: randomUUID(),
        personaId,
        source: { kind: "run", id: randomUUID() },
        actor: "user",
        kind: "utterance",
        observedAt: now,
        text: "继续按保存与送达分别说明。",
      },
      now,
    ).evidence;
    const run = prepare(f, false, [f.original, f.observed, replacement]);
    run.value.evidenceIds = [replacement.id];
    run.commit();
    expect(f.repository.getIntent(f.intent.id)?.evidenceIds).toEqual([
      replacement.id,
    ]);
  });

  it.each([
    { actor: "agent" as const },
    { kind: "observation" as const },
    { personaId: otherPersonaId },
    { receivedAt: "2026-09-15T08:00:11.000Z" },
  ])(
    "does not qualify an invalid or not-yet-received canonical source: %j",
    (source) => {
      const f = fixture(source);
      const run = prepare(f);
      expect(run.commit).toThrow(
        "Explicit user intent requires a user utterance",
      );
      expect(f.repository.getIntent(f.intent.id)).toEqual(f.intent);
    },
  );

  it("does not accept a canonical ID whose actual source has been removed", () => {
    const f = fixture();
    f.database
      .prepare("DELETE FROM cognition_evidence WHERE id = ?")
      .run(f.original.id);
    const run = prepare(f);
    expect(run.commit).toThrow(
      "Explicit user intent requires a user utterance",
    );
  });

  it.each(["evidenceIds", "effectEvidenceIds"] as const)(
    "does not allow a returned unsupplied reference in %s even if canonical grounding exists",
    (field) => {
      const f = fixture();
      const run = prepare(f);
      run.value[field] = [f.original.id];
      expect(run.commit).toThrow(
        "Cannot add evidence omitted from the partial intent input",
      );
      expect(f.repository.getIntent(f.intent.id)).toEqual(f.intent);
    },
  );

  it("does not turn retained request grounding into a new completion receipt", () => {
    const f = fixture();
    const run = prepare(f);
    run.value.status = "fulfilled";
    expect(run.commit).toThrow(
      "Intent completion requires a performed effect, user report or completed reply",
    );
    expect(f.repository.getIntent(f.intent.id)?.status).toBe("active");
  });

  it("allows an actual supplied performed effect to support completion", () => {
    const f = fixture();
    const effect = f.repository.ingest(
      {
        id: randomUUID(),
        personaId,
        source: { kind: "run", id: randomUUID() },
        actor: "agent",
        kind: "effect",
        observedAt: now,
        effect: {
          runId: randomUUID(),
          outcome: "performed",
          description: "实际工具回执提供送达结果，完成本次状态核对。",
          sourceRefs: [],
        },
      },
      now,
    ).evidence;
    const run = prepare(f, true, [f.observed, effect]);
    run.value.status = "fulfilled";
    run.value.effectEvidenceIds = [effect.id];
    run.analysis.delta.updateIntents[0]!.completionOperation = "set";
    run.value.completion = {
      evidenceUses: [{ evidenceId: effect.id, basis: "performed_effect" }],
    };
    run.commit();
    expect(f.repository.getIntent(f.intent.id)?.status).toBe("fulfilled");
    expect(f.repository.getIntent(f.intent.id)?.effectEvidenceIds).toEqual([
      effect.id,
    ]);
  });

  it.each(["character", "inferred_user"] as const)(
    "requires supplied user support when changing an existing %s basis",
    (basis) => {
      const f = fixture({ basis });
      const run = prepare(f);
      run.value.owner = "user";
      run.value.basis = "explicit_user";
      run.value.status = "active";
      expect(run.commit).toThrow(
        "Explicit user intent requires a user utterance",
      );
    },
  );

  it("does not expose retained grounding as a newly selected choice source", () => {
    const f = fixture();
    const run = prepare(f);
    run.analysis.decision.choices[0]!.evidenceIds = [f.original.id];
    run.analysis.decision.selectedBasis.evidenceUses = [
      { evidenceId: f.original.id, use: "history" },
    ];
    expect(run.commit).toThrow(
      "Cannot choose evidence omitted from the analysis input",
    );
  });

  it("does not lend retained grounding to a newly created explicit user intent", () => {
    const f = fixture();
    const run = prepare(f);
    run.analysis.delta.createIntents.push({
      localId: "new:another-request",
      value: { ...run.value, goal: "另一项新请求" },
    });
    expect(run.commit).toThrow(
      "Explicit user intent requires a user utterance",
    );
    expect(f.repository.getIntent(f.intent.id)).toEqual(f.intent);
  });

  it("allows an actual supplied user request when owner and basis change", () => {
    const f = fixture({ basis: "character" });
    const run = prepare(f, true, [f.original, f.observed]);
    run.value.owner = "user";
    run.value.basis = "explicit_user";
    run.value.evidenceIds = [f.original.id, f.observed.id];
    run.commit();
    expect(f.repository.getIntent(f.intent.id)?.owner).toBe("user");
    expect(f.repository.getIntent(f.intent.id)?.basis).toBe("explicit_user");
  });

  it("keeps existing revision and user-generation conflict checks", () => {
    const f = fixture();
    const run = prepare(f);
    f.repository.saveIntent({ ...f.intent, revision: 2 });
    expect(run.commit).toThrow("Situation or intent changed during analysis");
    f.repository.saveIntent(f.intent);
    f.repository.updateAttention(personaId, now, (state) => ({
      ...state,
      userGeneration: state.userGeneration + 1,
    }));
    expect(run.commit).toThrow("User control changed during analysis");
  });
});
