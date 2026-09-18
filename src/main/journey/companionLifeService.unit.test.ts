import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Run } from "../../shared/contracts/run";
import type {
  CognitionAnalysis,
  CognitionIntent,
} from "../../shared/contracts/cognition";
import { openApplicationDatabase } from "../db/database";
import { PersonaRepository } from "../persona/personaRepository";
import { CognitionRepository } from "../cognition/cognitionRepository";
import { CHARACTER_LIFE_PAUSED_BLOCKER } from "../cognition/cognitionTypes";
import { ToolRegistry } from "../tools/toolRegistry";
import { FakeClock } from "../../../tests/fixtures/fakeClock";
import {
  CompanionLifeService,
  COMPANION_LIFE_TOOL_NAMES,
} from "./companionLifeService";
import { registerCompanionLifeTool } from "./companionLifeTool";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function harness() {
  const database = openApplicationDatabase(":memory:");
  databases.push(database);
  const clock = new FakeClock("2026-09-15T01:00:00.000Z");
  const personas = new PersonaRepository(database);
  personas.initialize(clock.now());
  const persona = personas.getActiveSnapshot();
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const cognition = {
    getSnapshot: (id: string) => repository.getSnapshot(id, clock.now()),
    currentCharacterIntent: (id: string) =>
      repository.currentCharacterIntent(id, clock.now()),
    characterIntents: (id: string) => repository.characterIntents(id),
    isCharacterPaused: (id: string) => repository.isCharacterPaused(id),
    saveCharacterIntent: vi.fn((intent: CognitionIntent, revision?: number) =>
      repository.saveIntent(intent, revision),
    ),
    getRunIntent: (runId: string) => {
      const attempt = repository.getAttemptForRun(runId);
      const id = attempt?.decision?.choices.find(
        (choice) => choice.id === attempt.decision?.selectedChoiceId,
      )?.intentId;
      return id ? repository.getIntent(id) : undefined;
    },
    yieldToUser: vi.fn<(_: string) => Promise<void>>(() => Promise.resolve()),
  };
  const service = new CompanionLifeService({ cognition, personas, clock });
  service.initialize();
  const runs = new Map<string, Run>();
  const registry = new ToolRegistry();
  registerCompanionLifeTool(registry, service, {
    getRun: (id) => runs.get(id),
  });
  const current = (): CognitionIntent => {
    const result = cognition
      .getSnapshot(persona.personaId)
      .intents.find(({ owner }) => owner === "character");
    if (!result) throw new Error("Missing character intention");
    return result;
  };
  const makeRun = (intent = current()): Run => {
    let attempt = repository.createAttempt(
      repository.readSnapshot(persona.personaId, clock.now()),
      "character_due",
      clock.now(),
    );
    attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
    const choice = {
      id: "own-life",
      kind: "continue_character" as const,
      intentId: intent.id,
      evidenceIds: [],
      rationale: "有空整理住处",
      userImpact: "none" as const,
      executionScope: "territory" as const,
      reversibility: "undoable" as const,
      timing: "now" as const,
      resumeConditions: [],
    };
    const value: CognitionAnalysis = {
      delta: {
        createSituations: [],
        updateSituations: [],
        createIntents: [],
        updateIntents: [],
        attention: {},
      },
      decision: {
        choices: [choice],
        selectedChoiceId: choice.id,
        selectedBasis: {
          choiceId: choice.id,
          evidenceUses: [],
          currentClaimRefs: [],
        },
        reason: "自主日常",
      },
    };
    attempt = repository.commitAnalysis(attempt.id, value, clock.now());
    const run: Run = {
      id: randomUUID(),
      chatId: randomUUID(),
      persona,
      source: "text",
      provider: {
        apiStyle: "openai-compatible",
        modelId: "gpt-6-astra",
        profileId: randomUUID(),
        profileName: "Offline fixture",
      },
      execution: { mode: "agent", approvalMode: "full_access" },
      status: "running",
      createdAt: clock.now(),
      startedAt: clock.now(),
      latestSequence: 1,
    };
    runs.set(run.id, run);
    database.transaction(() =>
      repository.bindDispatched(attempt.dispatchKey, run.id, clock.now()),
    )();
    return run;
  };
  return {
    service,
    repository,
    cognition,
    personas,
    persona,
    current,
    clock,
    registry,
    runs,
    makeRun,
  };
}

const future = "2026-09-15T01:00:01.000Z";
function planContext(runId: string) {
  return {
    runId,
    itemId: randomUUID(),
    onDelta: vi.fn(),
    signal: new AbortController().signal,
  };
}

describe("character life as a Cognition intent adapter", () => {
  it("initializes one canonical intention and projects no fabricated completed experience", () => {
    const h = harness();
    const initial = h.current();
    h.service.initialize();
    expect(h.cognition.getSnapshot(h.persona.personaId).intents).toHaveLength(
      1,
    );
    expect(h.current().id).toBe(initial.id);
    expect(h.current().effectEvidenceIds).toEqual([]);
    expect(h.service.context(h.persona.personaId)).toContain("尚未开始");
    expect("runDue" in h.service).toBe(false);
    expect(COMPANION_LIFE_TOOL_NAMES).not.toContain("territory.propose_moment");
  });

  it("pauses every character intention and resumes the same selected identity without a second state", () => {
    const h = harness();
    const first = h.current();
    const second = { ...first, id: randomUUID(), goal: "整理书架" };
    h.cognition.saveCharacterIntent(second);
    const paused = h.service.updatePlan(h.persona, {
      intent: "休息",
      paused: true,
      nextWakeAt: future,
    });
    expect(h.service.isPaused()).toBe(true);
    expect(
      h.cognition
        .getSnapshot(h.persona.personaId)
        .intents.every(
          (intent) =>
            intent.status === "suspended" &&
            !intent.nextWakeAt &&
            intent.blockers.includes(CHARACTER_LIFE_PAUSED_BLOCKER),
        ),
    ).toBe(true);
    h.repository.updateAttention(
      h.persona.personaId,
      h.clock.now(),
      (state) => ({ ...state, committedIntentId: paused.intentId }),
    );
    const resumed = h.service.updatePlan(h.persona, {
      intent: "继续整理",
      paused: false,
      nextWakeAt: future,
    });
    expect(resumed.intentId).toBe(paused.intentId);
    expect(resumed.nextWakeAt).toBe(future);
    expect(h.service.isPaused()).toBe(false);
    expect(h.repository.getIntent(resumed.intentId)?.status).toBe("active");
    expect(
      h.cognition
        .getSnapshot(h.persona.personaId)
        .intents.filter(({ status }) => status === "active"),
    ).toHaveLength(1);
  });

  it("preserves actual progress and effects when planning the next activity", () => {
    const h = harness();
    const initial = h.current();
    const effectId = randomUUID();
    h.cognition.saveCharacterIntent(
      {
        ...initial,
        revision: 2,
        progress: "已放入一盆花",
        effectEvidenceIds: [effectId],
      },
      1,
    );
    h.service.updatePlan(h.persona, {
      intent: "欣赏刚放好的花",
      paused: false,
      nextWakeAt: future,
    });
    expect(h.current()).toMatchObject({
      id: initial.id,
      progress: "已放入一盆花",
      effectEvidenceIds: [effectId],
    });
    expect(() =>
      h.service.updatePlan(h.persona, {
        intent: "马上继续",
        paused: false,
        nextWakeAt: h.clock.now(),
      }),
    ).toThrow("future");
  });

  it("edits the intention bound to the actual Run even when another intent becomes current", async () => {
    const h = harness();
    const first = h.current();
    const run = h.makeRun(first);
    const second = { ...first, id: randomUUID(), goal: "另一件小事" };
    h.cognition.saveCharacterIntent(second);
    h.repository.updateAttention(
      h.persona.personaId,
      h.clock.now(),
      (state) => ({ ...state, committedIntentId: second.id }),
    );
    const output = await h.registry.execute(
      "companion.life",
      { intent: "继续这次布置", paused: false, nextWakeAt: future },
      planContext(run.id),
    );
    expect(output.status).toBe("success");
    expect(h.repository.getIntent(first.id)?.goal).toBe("继续这次布置");
    expect(h.repository.getIntent(second.id)?.goal).toBe("另一件小事");
    expect(h.service.isLifeRun(run.id)).toBe(true);
    const recovered = new CompanionLifeService({
      cognition: h.cognition,
      personas: h.personas,
      clock: h.clock,
    });
    expect(recovered.isLifeRun(run.id)).toBe(true);
  });

  it.each([false, true])(
    "clears completion when the Run plans another activity (paused=%s), retaining actual effects and identity",
    async (paused) => {
      const h = harness();
      const run = h.makeRun(h.current());
      // Final decision consumption is part of the current canonical revision.
      const initial = h.current();
      const effectId = randomUUID();
      const itemId = randomUUID();
      h.repository.ingest(
        {
          id: effectId,
          personaId: h.persona.personaId,
          actor: "agent",
          source: { kind: "run", id: run.id, fragment: itemId },
          observedAt: h.clock.now(),
          kind: "effect",
          text: "已把一盆花放在窗边。",
          effect: {
            runId: run.id,
            itemId,
            callId: "place-flower",
            outcome: "performed",
            description: "一盆花已放在窗边。",
            sourceRefs: [{ kind: "run", id: run.id, fragment: itemId }],
            worldChange: "modified",
          },
        },
        h.clock.now(),
      );
      // The existing completed state is a fixture; this planning Tool does not create it.
      h.repository.saveIntent(
        {
          ...initial,
          revision: initial.revision + 1,
          status: "fulfilled",
          progress: "已把一盆花放在窗边。",
          effectEvidenceIds: [effectId],
          completion: {
            evidenceUses: [{ evidenceId: effectId, basis: "performed_effect" }],
          },
        },
        initial.revision,
      );
      h.repository.updateAttention(
        h.persona.personaId,
        h.clock.now(),
        (state) => ({
          ...state,
          committedIntentId: initial.id,
        }),
      );
      expect(h.service.context(h.persona.personaId)).toContain(
        "performed_effect",
      );
      expect(h.service.context(h.persona.personaId)).toContain(effectId);
      const output = await h.registry.execute(
        "companion.life",
        { intent: "歇一会再欣赏窗边的花", paused, nextWakeAt: future },
        planContext(run.id),
      );
      expect(output.status).toBe("success");
      expect(h.repository.getIntent(initial.id)).toMatchObject({
        id: initial.id,
        revision: initial.revision + 2,
        status: paused ? "suspended" : "active",
        progress: "已把一盆花放在窗边。",
        effectEvidenceIds: [effectId],
      });
      expect(h.repository.getIntent(initial.id)).not.toHaveProperty(
        "completion",
      );
      expect(
        [...h.repository.characterIntents(h.persona.personaId)].map(
          ({ id }) => id,
        ),
      ).toEqual([initial.id]);
      expect(h.cognition.saveCharacterIntent).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a stale Persona, a terminal Run, and a cancelled Tool before writing a plan", async () => {
    const h = harness();
    const run = h.makeRun();
    const before = h.current();
    h.runs.set(run.id, { ...run, status: "completed" });
    await expect(
      h.registry.execute(
        "companion.life",
        { intent: "迟到的布置", paused: false, nextWakeAt: future },
        planContext(run.id),
      ),
    ).rejects.toThrow("no longer running");
    h.runs.set(run.id, run);
    const abort = new AbortController();
    abort.abort();
    await expect(
      h.registry.execute(
        "companion.life",
        { intent: "被取消的布置", paused: false, nextWakeAt: future },
        { ...planContext(run.id), signal: abort.signal },
      ),
    ).rejects.toThrow();
    expect(() =>
      h.service.updatePlan(
        { ...h.persona, revision: h.persona.revision + 1 },
        { intent: "另一版本", paused: false, nextWakeAt: future },
      ),
    ).toThrow("character changed");
    expect(h.current()).toEqual(before);
  });

  it("waits for the actual Cognition cancellation when the user takes over", async () => {
    const h = harness();
    let complete: (() => void) | undefined;
    h.cognition.yieldToUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    let finished = false;
    const waiting = h.service.yieldToUser().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    complete?.();
    await waiting;
    expect(h.cognition.yieldToUser).toHaveBeenCalledWith(h.persona.personaId);
  });
});
