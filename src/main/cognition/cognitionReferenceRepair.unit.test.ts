import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { modelTimeContext } from "../agent/modelTimeContext";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { defaultPersonaSnapshot } from "../persona/personaPresets";
import { estimateInputBudget } from "../providers/inputBudget";
import { ModelCognitionDriver } from "./cognitionDriver";
import { decodeCognitionModelOutput } from "./cognitionModelOutput";
import {
  CognitionReferenceError,
  selectAnalysisSnapshot,
  validateCognitionEvidenceReferences,
  validateCognitionStateReferences,
} from "./cognitionProjection";
import { CognitionRepository } from "./cognitionRepository";
import { readSituationView } from "./cognitionSnapshotReader";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionEvidenceInput,
} from "./cognitionTypes";

const now = "2026-09-15T08:00:00.000Z";
const next = "2026-09-15T08:01:00.000Z";
const later = "2026-09-15T08:02:00.000Z";
const originalId = "1759faff-8e37-45c4-bfe6-89eb29e3a089";
const mistypedId = "1759faff-8f37-45c4-bfe6-89eb29e3a089";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

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
      reason: "只更新可见的编辑经历",
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: [],
          rationale: "当前没有需要打断的事",
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

function setup(
  partial = false,
  withClosedHistory = false,
  minimalRelations = false,
) {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys=ON");
  db.exec(CURRENT_SCHEMA_SQL);
  const persona = defaultPersonaSnapshot(now);
  const personaId = persona.personaId;
  db.prepare(
    "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES(?,'custom',1,?,?)",
  ).run(personaId, now, now);
  const repo = new CognitionRepository(db, { readBudgetBytes: 131_072 });
  const ingest = (
    value: Omit<CognitionEvidenceInput, "personaId">,
    receivedAt = next,
  ) => repo.ingest({ ...value, personaId }, receivedAt).evidence;
  const observation = (id: string, text: string, at: string) =>
    ingest(
      {
        id,
        actor: "unknown",
        kind: "observation",
        source: { kind: "activity", id },
        object: { key: "editor:board", identity: "adapter" },
        observedAt: at,
        boundary: "content",
        text,
      },
      at,
    );
  observation(originalId, "编辑页仍显示未提交草稿。", now);
  const otherId = randomUUID();
  observation(otherId, "另一个材料页显示三月版目录。", now);
  const initial = quiet();
  initial.delta.createSituations.push({
    localId: "new:editing",
    value: {
      title: "编辑经历",
      summary: "完整状态正文，不应被局部占位内容替换",
      status: "current",
      objectRefs: [],
      unresolved: ["提交状态尚不明确"],
      relatedSituationIds: [],
      episodes: ["editing", "hidden-episode"].map((id) => ({
        id,
        label: id,
        state: "open",
        startedAt: now,
        evidenceIds: [originalId],
        objectKeys: [],
        boundaryReason: "实际可见编辑阶段",
      })),
      claims: ["visible-claim", "hidden-claim", "other-page"].map((id) => ({
        id,
        text: id === "other-page" ? "目录显示三月版" : "草稿尚未提交",
        basis: "observed",
        state: "supported",
        evidenceIds: [id === "other-page" ? otherId : originalId],
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
      goal: "可能正在准备复查草稿",
      successCriteria: [],
      evidenceIds: [originalId],
      blockers: ["没有收到明确请求"],
      resumeConditions: [],
      progress: "尚未开始协助",
      effectEvidenceIds: [],
      nextWakeAt: later,
    },
  });
  if (withClosedHistory) {
    const history = structuredClone(initial.delta.createSituations[0]!);
    history.localId = "new:closed-history";
    history.value.title = "已结束的历史事项";
    history.value.status = "closed";
    history.value.episodes = history.value.episodes.map((episode) => ({
      ...episode,
      state: "closed",
      endedAt: now,
    }));
    initial.delta.createSituations[0]!.value.relatedSituationIds = [
      history.localId,
    ];
    initial.delta.createIntents[0]!.value.situationId = "new:editing";
    if (partial)
      initial.delta.createSituations[0]!.value.summary =
        "完整的当前事项正文。".repeat(131_072);
    initial.delta.createSituations.push(history);
    initial.delta.attention.currentSituationId = "new:editing";
  }
  const catalogue = repo.readSnapshot(personaId, now);
  let initialAttempt = repo.createAttempt(
    catalogue,
    "semantic_change",
    now,
    catalogue.coverage.allocation,
    now,
    catalogue.coverage.sourceCoverage,
  );
  initialAttempt = repo.saveAttempt({ ...initialAttempt, status: "analyzing" });
  // The setup needs both original versions. Select and actually read them;
  // a catalogue identity alone cannot ground the seeded claims.
  initialAttempt = repo.commitAnalysis(
    initialAttempt.id,
    {
      ...quiet(),
      sourceReadPlan: {
        requests: [originalId, otherId].map((evidenceId) => ({
          catalogueId: catalogue.coverage.sourceCoverage!.entries[0]!.id,
          evidenceId,
          question: "核对原始草稿和随后目录中的内容",
        })),
      },
    },
    now,
  );
  const originals = repo.readSnapshot(personaId, now);
  expect(originals.snapshot.evidence.map(({ id }) => id)).toEqual(
    expect.arrayContaining([originalId, otherId]),
  );
  initialAttempt = repo.saveAttempt({
    ...initialAttempt,
    status: "analyzing",
    sourceCoverage: originals.coverage.sourceCoverage!,
    dependencies: {
      ...initialAttempt.dependencies,
      evidenceIds: originals.snapshot.evidence.map(({ id }) => id),
    },
  });
  const initialCommit = repo.commitAnalysis(initialAttempt.id, initial, now);
  repo.saveAttempt({ ...initialCommit, status: "settled", outcome: "quiet" });

  const current = observation(
    randomUUID(),
    "正文新增一段讨论，仍未看到提交回执。",
    next,
  );
  const originalRead = repo.readSnapshot(personaId, next);
  if (minimalRelations) {
    // Use the same actual SQL projection primitive as readSnapshot's reserved
    // current-state pass. Its allocation, not a handwritten placeholder, is
    // bound into the Attempt before the pure analysis selection.
    const view = readSituationView(
      db,
      originalRead.snapshot.situations[0]!.id,
      131_072,
      true,
    )!;
    originalRead.snapshot.situations[0] = view.value;
    originalRead.coverage.allocation!.situations = [view.allocation!];
  }
  // State-reference cases use the actual Reader -> selection -> Attempt chain.
  // An active Intent pointing at the closed parent would supply it legitimately.
  const read = withClosedHistory
    ? {
        ...selectAnalysisSnapshot(
          originalRead.snapshot,
          131_072,
          originalRead.coverage,
        ),
        receivedThroughSequence: originalRead.receivedThroughSequence,
      }
    : originalRead;
  if (!withClosedHistory) read.snapshot.evidence = [current];
  const situation = read.snapshot.situations[0]!;
  const canonical = repo.getSituation(situation.id)!;
  const intent = read.snapshot.intents[0]!;
  if (partial && !withClosedHistory) {
    situation.episodes = situation.episodes.filter(
      ({ id }) => id !== "hidden-episode",
    );
    situation.claims = situation.claims.filter(
      ({ id }) => id !== "hidden-claim",
    );
    situation.summary = "INCOMPLETE EXCERPT";
  }
  let attempt = repo.createAttempt(
    read,
    "semantic_change",
    next,
    withClosedHistory
      ? read.coverage.allocation
      : partial
        ? {
            situations: [
              {
                id: situation.id,
                episodeIds: situation.episodes.map(({ id }) => id),
                claimIds: situation.claims.map(({ id }) => id),
                preservedFields: ["summary"],
              },
            ],
            intents: [
              {
                id: intent.id,
                evidenceIds: [...intent.evidenceIds],
                effectEvidenceIds: [...intent.effectEvidenceIds],
                preservedFields: [],
              },
            ],
          }
        : undefined,
    withClosedHistory ? next : undefined,
    withClosedHistory ? read.coverage.sourceCoverage : undefined,
  );
  attempt = repo.saveAttempt({ ...attempt, status: "analyzing" });
  const input: CognitionAnalysisInput = {
    attempt,
    snapshot: read.snapshot,
    availability: {
      userEngaged: false,
      activeUserRunIds: [],
      chatRuns: [],
      activeVoice: false,
      sleeping: false,
      hasOutstandingBubble: false,
      mayInitiateConversation: true,
      mayActInTerritory: true,
      characterTools: [],
    },
  };
  return {
    db,
    repo,
    persona,
    personaId,
    input,
    canonical,
    situation,
    intent,
    current,
    otherId,
    ingest,
    observation,
  };
}

function wire(h: ReturnType<typeof setup>, reference = originalId) {
  const analysis = quiet();
  return {
    ...analysis,
    delta: {
      ...analysis.delta,
      attention: {
        currentSituationId: { op: "keep" },
        committedIntentId: { op: "keep" },
      },
      updateSituations: [
        {
          id: h.situation.id,
          expectedRevision: h.situation.revision,
          changes: {
            status: null,
            title: null,
            summary: null,
            objectRefs: null,
            episodes: [
              {
                id: "editing",
                label: null,
                state: null,
                startedAt: null,
                endedAt: { op: "keep" },
                evidenceIds: [reference, h.current.id],
                objectKeys: null,
                boundaryReason: "已看到新的段落，提交仍未确认",
              },
            ],
            claims: [],
            episodeOrder: null,
            claimOrder: null,
            unresolved: null,
            relatedSituationIds: null,
            journeyId: { op: "keep" },
            togetherSessionId: { op: "keep" },
            supersededBy: { op: "keep" },
          },
        },
      ],
    },
  };
}

function model(
  h: ReturnType<typeof setup>,
  output: (ordinal: number) => unknown,
  onMeasure?: (request: ModelRequest, signal: AbortSignal) => void,
) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    estimateInput: (request) => estimateInputBudget(request, request.modelId),
    measureInput(request, signal) {
      onMeasure?.(request, signal);
      signal.throwIfAborted();
      return Promise.resolve(this.estimateInput(request));
    },
    resolveContextLimits: () =>
      Promise.resolve({ effectiveInputTokens: 258_000 }),
    stream: async function* (request): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield Promise.resolve<ModelEvent>({
        type: "text.delta",
        delta: JSON.stringify(output(requests.length)),
      });
      yield {
        type: "response.completed",
        responseId: `offline-${requests.length}`,
        status: "completed",
        usage: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 0 },
      };
    },
  };
  const driver = new ModelCognitionDriver({
    getPersona: () => h.persona,
    getTimeContext: () => modelTimeContext(next, "UTC"),
    createRuntime: () => Promise.resolve({ provider, modelId: "gpt-6-astra" }),
  });
  return { driver, requests };
}

function unchanged(h: ReturnType<typeof setup>) {
  return {
    situation: h.repo.getSituation(h.situation.id),
    intent: h.repo.getIntent(h.intent.id),
    attention: h.repo.getAttention(h.personaId, next),
    attempt: h.repo.getAttempt(h.input.attempt.id),
    handoffs: [...h.repo.pendingMemoryHandoffs()],
    entityCounts: h.db
      .prepare(
        `SELECT
      (SELECT count(*) FROM cognition_situations) AS situations,
      (SELECT count(*) FROM cognition_intents) AS intents,
      (SELECT count(*) FROM cognition_decision_attempts) AS attempts`,
      )
      .get(),
  };
}

function newSituationWire(h: ReturnType<typeof setup>, relatedId: string) {
  const proposal = wire(h);
  proposal.delta.createSituations = [
    {
      localId: "new:current-agreement",
      value: {
        title: "对新增段落的当前约定",
        summary: "新增段落可见，提交仍未确认",
        status: "current",
        objectRefs: [],
        relatedSituationIds: [relatedId],
        unresolved: ["提交状态未知"],
        episodes: [],
        claims: [
          {
            id: "new-paragraph",
            text: "当前看到新增段落",
            state: "supported",
            basis: "observed",
            evidenceIds: [h.current.id],
            contradictingEvidenceIds: [],
          },
        ],
      },
    },
  ];
  return proposal;
}

describe("Cognition bounded state relation correction", () => {
  it.each([false, true])(
    "corrects a new link to an omitted historical parent without losing its existing link (partial=%s)",
    async (partial) => {
      const h = setup(partial, true);
      const historicalId = h.situation.relatedSituationIds[0]!;
      expect(historicalId).toBeTruthy();
      expect(h.repo.getSituation(historicalId)?.status).toBe("closed");
      expect(h.input.snapshot.situations.map(({ id }) => id)).not.toContain(
        historicalId,
      );
      expect(
        h.input.attempt.dependencies.situations.map(({ id }) => id),
      ).not.toContain(historicalId);
      expect(
        h.input.attempt.dependencies.situations.map(({ id }) => id),
      ).toEqual(h.input.snapshot.situations.map(({ id }) => id));
      if (partial)
        expect(h.input.attempt.allocation?.situations).toContainEqual(
          expect.objectContaining({
            id: h.situation.id,
            preservedFields: expect.arrayContaining(["summary"]) as unknown,
          }),
        );
      const before = unchanged(h);
      const bad = newSituationWire(h, historicalId);
      expect(() =>
        h.repo.commitAnalysis(
          h.input.attempt.id,
          decodeCognitionModelOutput(bad, h.input),
          next,
          h.input.snapshot.evidence,
        ),
      ).toThrow("Unknown related situation");
      expect(unchanged(h)).toEqual(before);
      const m = model(h, (ordinal) => {
        expect(unchanged(h)).toEqual(before);
        return ordinal === 1 ? bad : newSituationWire(h, h.situation.id);
      });
      const corrected = await m.driver.analyze(
        h.input,
        new AbortController().signal,
      );
      expect(m.requests).toHaveLength(2);
      expect(m.requests[1]!.input.slice(0, -1)).toEqual(m.requests[0]!.input);
      const feedback = JSON.parse(
        (m.requests[1]!.input.at(-1) as { content: string }).content,
      ) as { validationFeedback: { proposal: unknown; issues: unknown[] } };
      expect(feedback.validationFeedback.proposal).toEqual(bad);
      expect(feedback.validationFeedback.issues).toContainEqual(
        expect.objectContaining({
          kind: "state_reference_not_supplied",
          field: "delta.createSituations[0].value.relatedSituationIds[0]",
          referenceId: historicalId,
          entityKind: "situation",
          parentId: "new:current-agreement",
        }),
      );
      const committed = h.repo.commitAnalysis(
        h.input.attempt.id,
        corrected,
        next,
        h.input.snapshot.evidence,
      );
      expect(committed.id).toBe(h.input.attempt.id);
      expect(committed.status).toBe("ready");
      expect(h.repo.getSituation(h.situation.id)?.relatedSituationIds).toEqual([
        historicalId,
      ]);
      expect(h.repo.getSituation(historicalId)?.status).toBe("closed");
      expect(
        h.repo
          .readSnapshot(h.personaId, next)
          .snapshot.situations.find(
            ({ title }) => title === "对新增段落的当前约定",
          )?.relatedSituationIds,
      ).toEqual([h.situation.id]);
      expect(
        h.repo.getAttention(h.personaId, next).analyzedThroughSequence,
      ).toBe(h.input.attempt.throughSequence);
    },
  );
  it("retains the old link without requesting another proposal", async () => {
    const h = setup(false, true);
    const old = h.situation.relatedSituationIds[0]!;
    const m = model(h, () => wire(h));
    const result = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(m.requests).toHaveLength(1);
    h.repo.commitAnalysis(
      h.input.attempt.id,
      result,
      next,
      h.input.snapshot.evidence,
    );
    expect(h.repo.getSituation(h.situation.id)?.relatedSituationIds).toEqual([
      old,
    ]);
    expect(h.repo.getSituation(old)?.status).toBe("closed");
  });

  it("ignores protected relation fields from a real bounded SQL view", async () => {
    const h = setup(false, true, true);
    const allocation = h.input.attempt.allocation!.situations.find(
      ({ id }) => id === h.situation.id,
    )!;
    expect(allocation.preservedFields).toEqual(
      expect.arrayContaining(["relatedSituationIds", "supersededBy"]),
    );
    const proposal = wire(h);
    proposal.delta.updateSituations[0]!.changes.episodes = [];
    Object.assign(proposal.delta.updateSituations[0]!.changes, {
      relatedSituationIds: [randomUUID()],
      supersededBy: { op: "set", value: randomUUID() },
    });
    const m = model(h, () => proposal);
    const result = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(m.requests).toHaveLength(1);
    h.repo.commitAnalysis(
      h.input.attempt.id,
      result,
      next,
      h.input.snapshot.evidence,
    );
    expect(h.repo.getSituation(h.situation.id)?.relatedSituationIds).toEqual(
      h.canonical.relatedSituationIds,
    );
    expect(h.repo.getSituation(h.situation.id)?.supersededBy).toBe(
      h.canonical.supersededBy,
    );
  });

  it("does not confuse a newly declared Intent with a Situation target", () => {
    const h = setup(false, true);
    const proposal = decodeCognitionModelOutput(
      newSituationWire(h, "new:intent-only"),
      h.input,
    );
    proposal.delta.createIntents.push({
      localId: "new:intent-only",
      value: {
        owner: "character",
        basis: "character",
        status: "candidate",
        goal: "以后核对段落",
        successCriteria: [],
        evidenceIds: [],
        blockers: [],
        resumeConditions: [],
        progress: "尚未执行",
        effectEvidenceIds: [],
      },
    });
    expect(() => validateCognitionStateReferences(proposal, h.input)).toThrow(
      CognitionReferenceError,
    );
    expect(() =>
      h.repo.commitAnalysis(
        h.input.attempt.id,
        proposal,
        next,
        h.input.snapshot.evidence,
      ),
    ).toThrow("Unknown related situation");
  });

  it("accepts supplied parents and same-proposal forward references without correction", async () => {
    const h = setup(false, true);
    const proposal = newSituationWire(h, "new:forward-parent");
    proposal.delta.createSituations[0]!.value.relatedSituationIds.push(
      h.situation.id,
    );
    proposal.delta.createSituations.push({
      localId: "new:forward-parent",
      value: {
        ...proposal.delta.createSituations[0]!.value,
        title: "后声明的当前事项",
        relatedSituationIds: [],
        claims: [],
      },
    });
    Object.assign(proposal.delta.createSituations[0]!.value, {
      supersededBy: "new:forward-parent",
    });
    proposal.delta.createIntents.push({
      localId: "new:forward-intent",
      value: {
        owner: "character",
        basis: "character",
        status: "candidate",
        goal: "在新增事项中核对段落",
        situationId: "new:forward-parent",
        successCriteria: [],
        evidenceIds: [h.current.id],
        blockers: [],
        resumeConditions: [],
        progress: "尚未执行",
        effectEvidenceIds: [],
      },
    });
    Object.assign(proposal.delta.attention, {
      currentSituationId: { op: "set", id: "new:forward-parent" },
      committedIntentId: { op: "set", id: "new:forward-intent" },
    });
    Object.assign(proposal.decision.choices[0]!, {
      situationId: "new:forward-parent",
      intentId: "new:forward-intent",
      evidenceIds: [h.current.id],
    });
    proposal.decision.selectedBasis.evidenceUses = [
      { evidenceId: h.current.id, use: "history" },
    ];
    proposal.decision.selectedBasis.currentClaimRefs = [
      { situationId: "new:current-agreement", claimId: "new-paragraph" },
    ];
    const m = model(h, () => proposal);
    const result = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(m.requests).toHaveLength(1);
    const committed = h.repo.commitAnalysis(
      h.input.attempt.id,
      result,
      next,
      h.input.snapshot.evidence,
    );
    const choice = committed.decision!.choices[0]!;
    const parent = h.repo.getSituation(choice.situationId!)!;
    const intent = h.repo.getIntent(choice.intentId!)!;
    const child = h.repo.getSituation(
      committed.decision!.selectedBasis.currentClaimRefs[0]!.situationId,
    )!;
    expect(parent.title).toBe("后声明的当前事项");
    expect(child.relatedSituationIds).toEqual([parent.id, h.situation.id]);
    expect(child.supersededBy).toBe(parent.id);
    expect(intent.situationId).toBe(parent.id);
    expect(h.repo.getAttention(h.personaId, next)).toMatchObject({
      currentSituationId: parent.id,
      committedIntentId: intent.id,
    });
  });

  it.each([
    "supersession",
    "intent_parent",
    "choice_situation",
    "choice_intent",
    "claim_parent",
    "attention_situation",
    "attention_intent",
  ] as const)(
    "does not promote an omitted old link or wrong entity kind to %s",
    (use) => {
      const h = setup(false, true);
      const old = h.situation.relatedSituationIds[0]!;
      const proposal = decodeCognitionModelOutput(wire(h), h.input);
      let field: string;
      let referenceId = old;
      let entityKind = "situation";
      switch (use) {
        case "supersession":
          proposal.delta.updateSituations[0]!.value.supersededBy = old;
          field = "delta.updateSituations[0].value.supersededBy";
          break;
        case "intent_parent":
          proposal.delta.createIntents.push({
            localId: "new:other-intent",
            value: {
              owner: "character",
              basis: "character",
              status: "candidate",
              goal: "核对事项",
              situationId: old,
              successCriteria: [],
              evidenceIds: [h.current.id],
              blockers: [],
              resumeConditions: [],
              progress: "未执行",
              effectEvidenceIds: [],
            },
          });
          field = "delta.createIntents[0].value.situationId";
          break;
        case "choice_situation":
          proposal.decision.choices[0]!.situationId = old;
          field = "decision.choices[0].situationId";
          break;
        case "choice_intent":
          referenceId = h.situation.id;
          entityKind = "intent";
          proposal.decision.choices[0]!.intentId = referenceId;
          field = "decision.choices[0].intentId";
          break;
        case "claim_parent":
          proposal.decision.selectedBasis.currentClaimRefs = [
            { situationId: old, claimId: "visible-claim" },
          ];
          field = "decision.selectedBasis.currentClaimRefs[0].situationId";
          break;
        case "attention_situation":
          proposal.delta.attention.currentSituationId = old;
          field = "delta.attention.currentSituationId";
          break;
        case "attention_intent":
          referenceId = h.situation.id;
          entityKind = "intent";
          proposal.delta.attention.committedIntentId = referenceId;
          field = "delta.attention.committedIntentId";
      }
      const before = unchanged(h);
      try {
        validateCognitionStateReferences(proposal, h.input);
        expect.fail(
          "Expected the actual omitted/wrong-kind state target to be rejected",
        );
      } catch (error) {
        expect(error).toBeInstanceOf(CognitionReferenceError);
        expect((error as CognitionReferenceError).issues).toContainEqual(
          expect.objectContaining({
            kind: "state_reference_not_supplied",
            field,
            referenceId,
            entityKind,
          }),
        );
      }
      expect(() =>
        h.repo.commitAnalysis(
          h.input.attempt.id,
          proposal,
          next,
          h.input.snapshot.evidence,
        ),
      ).toThrow();
      expect(unchanged(h)).toEqual(before);
    },
  );

  it("ends after the existing one correction when the state reference is still invalid", async () => {
    const h = setup(false, true);
    const before = unchanged(h);
    const m = model(h, () =>
      newSituationWire(h, h.situation.relatedSituationIds[0]!),
    );
    await expect(
      m.driver.analyze(h.input, new AbortController().signal),
    ).rejects.toBeInstanceOf(CognitionReferenceError);
    expect(m.requests).toHaveLength(2);
    expect(unchanged(h)).toEqual(before);
  });

  it("does not generate or commit a state correction after cancellation during its measurement", async () => {
    const h = setup(false, true);
    const before = unchanged(h);
    const controller = new AbortController();
    const cancelled = new Error("cancel during correction measurement");
    const m = model(
      h,
      () => newSituationWire(h, h.situation.relatedSituationIds[0]!),
      (request) => {
        if (JSON.stringify(request.input.at(-1)).includes("validationFeedback"))
          controller.abort(cancelled);
      },
    );
    await expect(m.driver.analyze(h.input, controller.signal)).rejects.toBe(
      cancelled,
    );
    expect(m.requests).toHaveLength(1);
    expect(unchanged(h)).toEqual(before);
  });

  it("does not commit the corrected state after a real user-generation change", async () => {
    const h = setup(false, true);
    const m = model(h, (ordinal) =>
      newSituationWire(
        h,
        ordinal === 1 ? h.situation.relatedSituationIds[0]! : h.situation.id,
      ),
    );
    const corrected = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    h.ingest(
      {
        id: randomUUID(),
        actor: "user",
        kind: "control",
        control: "user_correction",
        source: { kind: "run", id: randomUUID() },
        observedAt: later,
      },
      later,
    );
    const beforeCommit = unchanged(h);
    expect(() =>
      h.repo.commitAnalysis(
        h.input.attempt.id,
        corrected,
        later,
        h.input.snapshot.evidence,
      ),
    ).toThrow("User control changed during analysis");
    expect(m.requests).toHaveLength(2);
    expect(unchanged(h)).toEqual(beforeCommit);
  });
});

describe("Cognition supplied-reference correction with actual Repository", () => {
  it.each([false, true])(
    "rejects before writes and commits a model correction in the same Attempt (partial=%s)",
    async (partial) => {
      const h = setup(partial);
      const bad = wire(h, mistypedId);
      const badAnalysis = decodeCognitionModelOutput(bad, h.input);
      const before = unchanged(h);
      const inputBefore = structuredClone(h.input);
      expect(h.input.snapshot.evidence.map(({ id }) => id)).toEqual([
        h.current.id,
      ]);
      expect(() =>
        h.repo.commitAnalysis(
          h.input.attempt.id,
          badAnalysis,
          next,
          h.input.snapshot.evidence,
        ),
      ).toThrow("Unknown evidence");
      expect(unchanged(h)).toEqual(before);
      expect(() =>
        validateCognitionEvidenceReferences(badAnalysis, h.input),
      ).toThrow(CognitionReferenceError);
      const m = model(h, (ordinal) => {
        expect(unchanged(h)).toEqual(before);
        return ordinal === 1 ? bad : wire(h);
      });
      const corrected = await m.driver.analyze(
        h.input,
        new AbortController().signal,
      );
      expect(m.requests).toHaveLength(2);
      expect(m.requests[1]!.input.slice(0, -1)).toEqual(m.requests[0]!.input);
      const feedback = JSON.parse(
        (m.requests[1]!.input.at(-1) as { content: string }).content,
      ) as { validationFeedback: { proposal: unknown; issues: unknown[] } };
      expect(feedback.validationFeedback.proposal).toEqual(bad);
      expect(feedback.validationFeedback.issues).toContainEqual(
        expect.objectContaining({
          kind: "reference_not_supplied",
          field: "delta.updateSituations[0].value.episodes[0].evidenceIds[0]",
          evidenceId: mistypedId,
          scope: "visible_provenance",
          parentId: h.situation.id,
          childId: "editing",
          suppliedPaths: expect.arrayContaining([
            "snapshot.situations[0].episodes[0].evidenceIds",
          ]) as unknown,
        }),
      );
      expect(unchanged(h)).toEqual(before);
      const committed = h.repo.commitAnalysis(
        h.input.attempt.id,
        corrected,
        next,
        h.input.snapshot.evidence,
      );
      expect(committed.id).toBe(h.input.attempt.id);
      expect(committed.status).toBe("ready");
      expect(committed.dependencies.evidenceIds).toEqual([h.current.id]);
      expect(committed.decision?.selectedBasis.evidenceUses).toEqual([]);
      const stored = h.repo.getSituation(h.situation.id)!;
      expect(
        stored.episodes.find(({ id }) => id === "editing")?.evidenceIds,
      ).toEqual([originalId, h.current.id]);
      expect(stored.episodes.find(({ id }) => id === "hidden-episode")).toEqual(
        h.canonical.episodes.find(({ id }) => id === "hidden-episode"),
      );
      expect(stored.claims).toEqual(h.canonical.claims);
      expect(stored.summary).toBe(h.canonical.summary);
      expect(
        h.repo.getAttention(h.personaId, next).analyzedThroughSequence,
      ).toBe(h.input.attempt.throughSequence);
      expect(h.input).toEqual(inputBefore);
    },
  );

  it("keeps valid old provenance without another generation or exposing its body", async () => {
    const h = setup(true);
    const m = model(h, () => wire(h));
    const result = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    expect(m.requests).toHaveLength(1);
    expect(JSON.stringify(m.requests[0]!.input)).not.toContain(
      "编辑页仍显示未提交草稿。",
    );
    expect(() =>
      h.repo.commitAnalysis(
        h.input.attempt.id,
        result,
        next,
        h.input.snapshot.evidence,
      ),
    ).not.toThrow();
  });

  it("does not turn retained Episode provenance into supplied selected evidence", () => {
    const h = setup();
    const proposal = decodeCognitionModelOutput(wire(h), h.input);
    proposal.decision.choices[0]!.evidenceIds = [originalId];
    proposal.decision.selectedBasis.evidenceUses = [
      { evidenceId: originalId, use: "history" },
    ];
    expect(() =>
      validateCognitionEvidenceReferences(proposal, h.input),
    ).toThrow("actual snapshot.evidence");
    expect(() =>
      h.repo.commitAnalysis(
        h.input.attempt.id,
        proposal,
        next,
        h.input.snapshot.evidence,
      ),
    ).toThrow("Cannot choose evidence omitted");
    expect(h.repo.getAttempt(h.input.attempt.id)?.status).toBe("analyzing");
  });

  it("does not widen a partial Intent to other visible state references", () => {
    const h = setup(true);
    const proposal = quiet();
    proposal.delta.updateIntents.push({
      id: h.intent.id,
      expectedRevision: h.intent.revision,
      value: {
        owner: h.intent.owner,
        basis: h.intent.basis,
        status: h.intent.status,
        goal: h.intent.goal,
        successCriteria: h.intent.successCriteria,
        evidenceIds: [originalId, h.otherId],
        blockers: h.intent.blockers,
        resumeConditions: h.intent.resumeConditions,
        progress: h.intent.progress,
        effectEvidenceIds: [],
      },
    });
    expect(
      h.input.snapshot.situations[0]!.claims.some((claim) =>
        claim.evidenceIds.includes(h.otherId),
      ),
    ).toBe(true);
    expect(() =>
      validateCognitionEvidenceReferences(proposal, h.input),
    ).toThrow("partial Intent");
    expect(() =>
      h.repo.commitAnalysis(h.input.attempt.id, proposal, next),
    ).toThrow("partial intent input");
    expect(h.repo.getIntent(h.intent.id)).toEqual(h.intent);
  });

  it("requires actual supplied sources for a new completion, while keeping old state references separate", () => {
    const h = setup();
    const proposal = quiet();
    proposal.delta.createIntents.push({
      localId: "new:completed",
      value: {
        owner: "character",
        basis: "character",
        status: "fulfilled",
        goal: "核对草稿",
        successCriteria: ["已经核对"],
        evidenceIds: [originalId],
        blockers: [],
        resumeConditions: [],
        progress: "声称已核对",
        effectEvidenceIds: [],
        completion: {
          evidenceUses: [{ evidenceId: originalId, basis: "user_report" }],
        },
      },
    });
    expect(() =>
      validateCognitionEvidenceReferences(proposal, h.input),
    ).toThrow("authorize a new completion");
    expect(() =>
      h.repo.commitAnalysis(h.input.attempt.id, proposal, next),
    ).toThrow("was not supplied for this Persona");
  });

  it.each(["revision", "generation"] as const)(
    "still rejects actual %s changes after the model correction",
    async (change) => {
      const h = setup();
      const m = model(h, (ordinal) =>
        wire(h, ordinal === 1 ? mistypedId : originalId),
      );
      const corrected = await m.driver.analyze(
        h.input,
        new AbortController().signal,
      );
      if (change === "revision")
        h.db
          .prepare(
            "UPDATE cognition_situations SET revision=revision+1,payload_json=json_set(payload_json,'$.revision',revision+1) WHERE id=?",
          )
          .run(h.situation.id);
      else
        h.ingest(
          {
            id: randomUUID(),
            actor: "user",
            kind: "control",
            control: "user_correction",
            source: { kind: "run", id: randomUUID() },
            observedAt: later,
          },
          later,
        );
      const beforeCommit = unchanged(h);
      expect(() =>
        h.repo.commitAnalysis(
          h.input.attempt.id,
          corrected,
          later,
          h.input.snapshot.evidence,
        ),
      ).toThrow("changed during analysis");
      expect(unchanged(h)).toEqual(beforeCommit);
    },
  );

  it("retains the actual receipt boundary for a same-generation user utterance after correction", async () => {
    const h = setup();
    const m = model(h, (ordinal) =>
      wire(h, ordinal === 1 ? mistypedId : originalId),
    );
    const corrected = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    h.ingest(
      {
        id: randomUUID(),
        actor: "user",
        kind: "utterance",
        text: "刚才的安排需要再调整。",
        source: { kind: "run", id: randomUUID() },
        observedAt: later,
      },
      later,
    );
    expect(h.repo.getAttention(h.personaId, later).userGeneration).toBe(
      h.input.attempt.dependencies.userGeneration,
    );
    const committed = h.repo.commitAnalysis(
      h.input.attempt.id,
      corrected,
      later,
      h.input.snapshot.evidence,
    );
    expect(committed.dependencies.receivedThroughSequence).toBe(
      h.input.attempt.dependencies.receivedThroughSequence,
    );
    expect(h.repo.actionFreshness(committed, later)).toMatchObject({
      current: false,
      reason: "control_changed",
    });
  });

  it("still checks an actual selected object's later source change", async () => {
    const h = setup();
    const m = model(h, (ordinal) => {
      const proposal = wire(h, ordinal === 1 ? mistypedId : originalId);
      proposal.decision.choices[0]!.evidenceIds = [h.current.id];
      proposal.decision.selectedBasis.evidenceUses = [
        { evidenceId: h.current.id, use: "current_object" },
      ];
      return proposal;
    });
    const corrected = await m.driver.analyze(
      h.input,
      new AbortController().signal,
    );
    const committed = h.repo.commitAnalysis(
      h.input.attempt.id,
      corrected,
      next,
      h.input.snapshot.evidence,
    );
    expect(h.repo.actionFreshness(committed, next)).toEqual({ current: true });
    h.observation(randomUUID(), "编辑页内容已经换成另一份材料。", later);
    expect(h.repo.actionFreshness(committed, later)).toMatchObject({
      current: false,
      reason: "object_changed",
    });
  });
});
