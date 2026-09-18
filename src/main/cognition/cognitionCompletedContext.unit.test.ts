import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import { projectCognitionContext } from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionEvidenceInput,
  CognitionIntent,
} from "./cognitionTypes";

const personaId = "11111111-1111-4111-8111-111111111111";
const otherPersonaId = "22222222-2222-4222-8222-222222222222";
const now = "2026-09-16T00:00:00.000Z";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function quiet(intentId?: string, evidenceId?: string): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: { committedIntentId: null },
    },
    decision: {
      choices: [
        {
          id: "record",
          kind: "remain_quiet",
          ...(intentId ? { intentId } : {}),
          evidenceIds: evidenceId ? [evidenceId] : [],
          rationale: "PRIVATE_DECISION_REASON",
          userImpact: "none",
          executionScope: "none",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
        },
      ],
      selectedChoiceId: "record",
      selectedBasis: {
        choiceId: "record",
        evidenceUses: evidenceId ? [{ evidenceId, use: "history" }] : [],
        currentClaimRefs: [],
      },
      reason: "PRIVATE_DECISION_REASON",
    },
  };
}

function fixture(
  basis: "user_report" | "performed_effect" | "completed_reply" = "user_report",
) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(CURRENT_SCHEMA_SQL);
  for (const id of [personaId, otherPersonaId])
    db.prepare(
      "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES(?,'custom',1,?,?)",
    ).run(id, now, now);
  const repo = new CognitionRepository(db, { readBudgetBytes: 32_768 });
  const ingest = (text: string, extra: Partial<CognitionEvidenceInput> = {}) =>
    repo.ingest(
      {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "utterance",
        source: { kind: "run", id: randomUUID(), revision: "completed" },
        observedAt: now,
        text,
        ...extra,
      },
      now,
    ).evidence;
  const request = ingest(
    basis === "completed_reply"
      ? "请写出门要带的三样东西，不保存文件。"
      : "请把出门清单保存为本地文件。",
  );
  const receipt = ingest(
    basis === "user_report"
      ? "我自己保存并读回了出门清单。"
      : basis === "completed_reply"
        ? "钥匙、手机、水杯。"
        : "文件已实际写入并读回。",
    basis === "performed_effect"
      ? {
          actor: "agent",
          kind: "effect",
          effect: {
            runId: randomUUID(),
            outcome: "performed",
            description: "文件实际写入并读回。",
            sourceRefs: [],
          },
        }
      : basis === "completed_reply"
        ? {
            actor: "agent",
            chatId: randomUUID(),
            source: {
              kind: "run",
              id: request.source.id,
              fragment: randomUUID(),
              revision: "completed",
            },
          }
        : {},
  );
  const intent: CognitionIntent = {
    id: randomUUID(),
    personaId,
    revision: 1,
    owner: "user",
    basis: "explicit_user",
    status: "active",
    goal: basis === "completed_reply" ? "写出门清单" : "保存出门清单",
    successCriteria:
      basis === "completed_reply"
        ? ["给出三样日常随身物品"]
        : ["本地文件实际写入并读回"],
    evidenceIds: [request.id],
    effectEvidenceIds: [],
    blockers: [],
    resumeConditions: [],
    progress: "尚未保存",
    createdAt: now,
    updatedAt: now,
  };
  repo.saveIntent(intent);
  const pending = () => {
    const read = repo.readSnapshot(personaId, now);
    return repo.createAttempt(
      read,
      "semantic_change",
      now,
      read.coverage.allocation,
    );
  };
  const commit = (analysis: CognitionAnalysis) => {
    const read = repo.readSnapshot(personaId, now);
    const attempt = repo.saveAttempt({
      ...repo.createAttempt(
        read,
        "semantic_change",
        now,
        read.coverage.allocation,
      ),
      status: "analyzing",
    });
    const done = repo.commitAnalysis(
      attempt.id,
      analysis,
      now,
      read.snapshot.evidence,
    );
    return repo.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
  };
  const output = quiet(intent.id, receipt.id);
  output.delta.updateIntents.push({
    id: intent.id,
    expectedRevision: 1,
    completionOperation: "set",
    value: {
      owner: intent.owner,
      basis: intent.basis,
      status: "fulfilled",
      goal: intent.goal,
      successCriteria: intent.successCriteria,
      evidenceIds: [request.id, receipt.id],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress:
        basis === "user_report"
          ? "按用户报告完成，未独立验证。"
          : basis === "completed_reply"
            ? "三样物品已写在回复里。"
            : "本地写入回执确认完成。",
      completion: { evidenceUses: [{ evidenceId: receipt.id, basis }] },
    },
  });
  const done = commit(output);
  const context = (budget = 12_000) => {
    const read = repo.readConversationContext(
      personaId,
      now,
      { maxReadBytes: 16 * 1024 * 1024 },
      new AbortController().signal,
    );
    return projectCognitionContext(read.snapshot, budget, read);
  };
  const retained = (source = receipt) =>
    repo.protectedCanonicalSources([
      { candidateId: source.id, references: [source.source] },
    ]);
  return {
    db,
    repo,
    ingest,
    request,
    receipt,
    intent,
    done,
    pending,
    commit,
    context,
    retained,
  };
}

describe("ordinary context for the latest selected completion", () => {
  it.each(["user_report", "performed_effect", "completed_reply"] as const)(
    "reads current %s completion and its source after the commitment is cleared",
    (basis) => {
      const f = fixture(basis);
      expect(
        f.repo.getAttention(personaId, now).committedIntentId,
      ).toBeUndefined();
      const context = f.context();
      expect(context.intentIds).toEqual([f.intent.id]);
      expect(context.evidenceIds).toContain(f.receipt.id);
      expect(context.text).toContain(f.receipt.text);
      expect(context.text).toContain(`"basis":"${basis}"`);
      expect(context.text).toContain('"revision":2');
      expect(context.text).not.toContain("PRIVATE_DECISION_REASON");
      expect(context.text).not.toContain('"instruction"');
      expect(f.retained()).toEqual([
        { candidateId: f.receipt.id, reasons: ["intent"] },
      ]);
    },
  );

  it.each(["no_intent", "different_intent"])(
    "does not revive an older selected completion after a new %s decision",
    (next) => {
      const f = fixture();
      const id = next === "different_intent" ? randomUUID() : undefined;
      if (id) f.repo.saveIntent({ ...f.intent, id, goal: "另一个计划" });
      f.commit(quiet(id));
      expect(f.context().intentIds).not.toContain(f.intent.id);
      expect(f.retained()).toEqual([]);
    },
  );

  it.each([
    "pending",
    "analyzing",
    "awaiting_recall",
    "failed",
    "superseded",
  ] as const)(
    "does not treat the latest %s Attempt as a committed consumer or fall back to the old one",
    (status) => {
      const f = fixture();
      const next = f.pending();
      f.repo.saveAttempt({
        ...next,
        status,
        decision: f.done.decision!,
        actionReadSet: f.done.actionReadSet!,
      });
      expect(f.context().intentIds).not.toContain(f.intent.id);
      const reasons = f.retained().flatMap((value) => value.reasons);
      expect(reasons).not.toContain("intent");
      // Genuine in-flight dependencies retain originals independently of ordinary completion.
      expect(reasons.includes("decision")).toBe(
        !["failed", "superseded"].includes(status),
      );
    },
  );

  it.each(["choice", "basis", "selected_intent", "dependency", "persona"])(
    "requires the actual selected/read-set/dependency pairing (%s)",
    (broken) => {
      const f = fixture();
      const value = structuredClone(f.done);
      if (broken === "choice") value.actionReadSet!.choiceId = "another";
      if (broken === "basis")
        value.decision!.selectedBasis.choiceId = "another";
      if (broken === "selected_intent")
        value.actionReadSet!.selectedIntent!.id = randomUUID();
      if (broken === "dependency") value.dependencies.intents[0]!.revision += 1;
      if (broken === "persona") value.dependencies.personaId = otherPersonaId;
      f.repo.saveAttempt(value);
      expect(f.context().intentIds).not.toContain(f.intent.id);
      expect(f.retained()).toEqual([]);
    },
  );

  it("reads the canonical revision and its current completion instead of copying the prior selected version", () => {
    const f = fixture();
    const replacement = f.ingest("我已重新保存更正后的出门清单并读回。");
    const current = f.repo.getIntent(f.intent.id)!;
    f.repo.saveIntent(
      {
        ...current,
        revision: current.revision + 1,
        progress: "更正版本已按用户报告完成。",
        completion: {
          evidenceUses: [{ evidenceId: replacement.id, basis: "user_report" }],
        },
      },
      current.revision,
    );
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      analyzedThroughSequence: state.lastReceiptSequence,
    }));
    expect(f.context().text).toContain('"revision":3');
    expect(f.context().text).toContain(replacement.text);
    expect(f.retained()).toEqual([]);
    expect(f.retained(replacement)).toEqual([
      { candidateId: replacement.id, reasons: ["intent"] },
    ]);
  });

  it("does not treat another Persona's newer Attempt as the current selection", () => {
    const f = fixture();
    const id = randomUUID();
    f.repo.saveAttempt({
      ...f.done,
      id,
      dispatchKey: `cognition:${id}`,
      personaId: otherPersonaId,
      dependencies: { ...f.done.dependencies, personaId: otherPersonaId },
    });
    expect(f.context().intentIds).toEqual([f.intent.id]);
    expect(f.retained()).toEqual([
      { candidateId: f.receipt.id, reasons: ["intent"] },
    ]);
  });

  it("preserves small current semantics before a huge latest selection proof and reports that proof as unread", () => {
    const f = fixture();
    const current = f.repo.saveIntent({
      ...f.intent,
      id: randomUUID(),
      goal: "仍有效的小承诺",
    });
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: current.id,
    }));
    const latest = structuredClone(f.done);
    latest.decision!.reason = "非常大的既有决定说明。".repeat(10_000);
    f.repo.saveAttempt(latest);
    const read = f.repo.readConversationContext(
      personaId,
      now,
      { maxReadBytes: 4096 },
      new AbortController().signal,
    );
    const context = projectCognitionContext(read.snapshot, 12_000, read);
    expect(context.intentIds).toEqual([current.id]);
    expect(context.text).toContain(current.goal);
    expect(context.text).toContain(f.request.text);
    expect(context.text).toContain('"selectionOmittedForResource":true');
    expect(read.snapshot.recentAttempts).toEqual([]);
    expect(read.coverage.selectionOmittedForResource).toBe(true);
    expect(read.readCost.rawValueBytes).toBeLessThanOrEqual(4096);
    expect(f.repo.getAttempt(latest.id)).toEqual(latest);
  });

  it("omits an oversized ordinary body or missing Attempt metadata instead of guessing a selection", () => {
    const f = fixture();
    expect(f.context(512).intentIds).toEqual([]);
    const large = structuredClone(f.done);
    large.decision!.reason = "长决定说明。".repeat(10_000);
    f.repo.saveAttempt(large);
    const read = f.repo.readSnapshot(personaId, now);
    expect(read.snapshot.intents.map(({ id }) => id)).toContain(f.intent.id);
    expect(read.snapshot.recentAttempts).toHaveLength(1);
    expect(read.snapshot.recentAttempts[0]).toMatchObject({
      id: large.id,
      projection: "lifecycle",
      status: large.status,
    });
    expect(read.snapshot.recentAttempts[0]).not.toHaveProperty("decision");
    expect(f.repo.getAttempt(large.id)).toEqual(large);
    expect(
      projectCognitionContext(read.snapshot, 12_000, read).intentIds,
    ).toEqual([]);
    expect(JSON.stringify(read).length).toBeLessThan(32_768);
  });
});
