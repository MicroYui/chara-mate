import { randomUUID } from "node:crypto";

import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { CognitionIntent } from "../../shared/contracts/cognition";
import type { Clock } from "../../shared/pure/clock";
import type { CognitionService } from "../cognition/cognitionService";
import { CHARACTER_LIFE_PAUSED_BLOCKER } from "../cognition/cognitionTypes";

export const COMPANION_LIFE_TOOL_NAMES = [
  "companion.life",
  "territory.observe",
  "territory.act",
  "territory.generate_item",
] as const;

export interface CompanionLifeState {
  readonly personaId: string;
  readonly intentId: string;
  readonly intent: string;
  readonly paused: boolean;
  readonly nextWakeAt?: string;
  readonly updatedAt: string;
}

interface LifeDependencies {
  readonly cognition: Pick<
    CognitionService,
    | "getSnapshot"
    | "getRunIntent"
    | "saveCharacterIntent"
    | "yieldToUser"
    | "characterIntents"
    | "currentCharacterIntent"
    | "isCharacterPaused"
  >;
  readonly personas: { getActiveSnapshot(): PersonaSnapshot };
  readonly clock: Clock;
}

/** A product Tool adapter over CognitionIntent. It owns no persistence or scheduler. */
export class CompanionLifeService {
  #stopped = false;

  constructor(private readonly dependencies: LifeDependencies) {}

  initialize(): void {
    const persona = this.dependencies.personas.getActiveSnapshot();
    if (this.currentIntent(persona.personaId)) return;
    const now = this.dependencies.clock.now();
    this.dependencies.cognition.saveCharacterIntent({
      id: randomUUID(),
      personaId: persona.personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "按自己的兴趣认识住处，选择一件能在领地里完成的小事，也可以休息。",
      successCriteria: [
        "完成一次与当前兴趣相符且有真实结果的日常活动，或明确选择休息",
      ],
      evidenceIds: [],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "尚未开始；没有任何已完成经历。",
      nextWakeAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  context(personaId: string): string {
    const snapshot = this.dependencies.cognition.getSnapshot(personaId);
    const own = snapshot.intents.filter(({ owner }) => owner === "character");
    if (!own.length) return "";
    return [
      "Your own local life is represented by the same Cognition intents. These are not the user's personal history.",
      JSON.stringify(
        own.map(
          ({
            id,
            goal,
            status,
            progress,
            blockers,
            effectEvidenceIds,
            completion,
          }) => ({
            id,
            goal,
            status,
            progress,
            blockers,
            effectEvidenceIds,
            ...(completion ? { completion } : {}),
          }),
        ),
      ),
      "An intention or narration is not a completed experience. Completion user_report is the user's report, not independently verified execution; performed_effect is limited to the actual receipt scope; completed_reply records that the visible saved reply itself satisfied a finite conversational goal, not an external action, surface delivery or user reading. Excerpts prove only their visible content. Cite actual host effects for actions in the world. You may make ordinary reversible choices yourself, or rest, without requiring the user to manage each step.",
    ].join("\n");
  }

  isLifeRun(runId: string): boolean {
    return (
      this.dependencies.cognition.getRunIntent(runId)?.owner === "character"
    );
  }

  isPaused(
    personaId = this.dependencies.personas.getActiveSnapshot().personaId,
  ): boolean {
    return this.dependencies.cognition.isCharacterPaused(personaId);
  }

  updatePlan(
    persona: PersonaSnapshot,
    input: { intent: string; paused: boolean; nextWakeAt: string },
    runId?: string,
  ): CompanionLifeState {
    const active = this.dependencies.personas.getActiveSnapshot();
    if (
      this.#stopped ||
      active.personaId !== persona.personaId ||
      active.revision !== persona.revision
    ) {
      throw new Error("The active character changed.");
    }
    const now = this.dependencies.clock.now();
    const wake = Date.parse(input.nextWakeAt);
    if (!Number.isFinite(wake) || (!input.paused && wake <= Date.parse(now))) {
      throw new Error("Choose a valid future wake time.");
    }
    const runIntent = runId
      ? this.dependencies.cognition.getRunIntent(runId)
      : undefined;
    if (
      runIntent &&
      (runIntent.personaId !== persona.personaId ||
        runIntent.owner !== "character")
    ) {
      throw new Error("The Run belongs to another intention.");
    }
    if (!runIntent) this.initialize();
    const current = runIntent ?? this.currentIntent(persona.personaId);
    if (!current) throw new Error("The character's intention is unavailable.");
    // Pause updates every character intention. There is no second hidden life flag.
    for (const intent of this.dependencies.cognition.characterIntents(
      persona.personaId,
    )) {
      if (intent.id === current.id) continue;
      if (
        !input.paused &&
        !intent.blockers.includes(CHARACTER_LIFE_PAUSED_BLOCKER)
      )
        continue;
      const next: CognitionIntent = {
        ...intent,
        revision: intent.revision + 1,
        status: input.paused ? "suspended" : "candidate",
        blockers: [
          ...intent.blockers.filter(
            (value) => value !== CHARACTER_LIFE_PAUSED_BLOCKER,
          ),
          ...(input.paused ? [CHARACTER_LIFE_PAUSED_BLOCKER] : []),
        ],
        resumeConditions: input.paused
          ? [
              {
                kind: "user_engagement",
                description: "用户表示希望角色继续自己的日常",
              },
            ]
          : [],
        updatedAt: now,
      };
      delete next.nextWakeAt;
      delete next.completion;
      this.dependencies.cognition.saveCharacterIntent(next, intent.revision);
    }
    const value: CognitionIntent = {
      ...current,
      revision: current.revision + 1,
      goal: input.intent,
      successCriteria:
        input.intent === current.goal
          ? current.successCriteria
          : [input.intent],
      status: input.paused ? "suspended" : "active",
      blockers: [
        ...current.blockers.filter(
          (blocker) => blocker !== CHARACTER_LIFE_PAUSED_BLOCKER,
        ),
        ...(input.paused ? [CHARACTER_LIFE_PAUSED_BLOCKER] : []),
      ],
      resumeConditions: input.paused
        ? [
            {
              kind: "user_engagement",
              description: "用户表示希望角色继续自己的日常",
            },
          ]
        : [
            {
              kind: "time",
              after: input.nextWakeAt,
              description: "届时根据当前情境重新考虑自己的日常",
            },
          ],
      updatedAt: now,
    };
    delete value.nextWakeAt;
    delete value.completion;
    if (!input.paused) value.nextWakeAt = input.nextWakeAt;
    const saved = this.dependencies.cognition.saveCharacterIntent(
      value,
      current.revision,
    );
    return {
      personaId: saved.personaId,
      intentId: saved.id,
      intent: saved.goal,
      paused: input.paused,
      ...(saved.nextWakeAt ? { nextWakeAt: saved.nextWakeAt } : {}),
      updatedAt: saved.updatedAt,
    };
  }

  yieldToUser(): Promise<void> {
    return this.dependencies.cognition.yieldToUser(
      this.dependencies.personas.getActiveSnapshot().personaId,
    );
  }

  shutdown(): void {
    this.#stopped = true;
  }

  private currentIntent(personaId: string): CognitionIntent | undefined {
    return this.dependencies.cognition.currentCharacterIntent(personaId);
  }
}
