import { attachSelectedRecollections } from "./cognitionActionContext";
import { randomUUID } from "node:crypto";

import type {
  MemoryRecall,
  EvidencePack,
} from "../../shared/contracts/memoryRecall";
import type { Clock } from "../../shared/pure/clock";
import { parseSchema } from "../../shared/schemas/validation";
import { CognitionAnalysisSchema } from "../../shared/schemas/cognition";
import {
  CognitionConflictError,
  projectCognitionContext,
  selectAnalysisSnapshot,
} from "./cognitionProjection";
import type { CognitionRepository } from "./cognitionRepository";
import { INPUT_BUDGET_ESTIMATE_RATIO } from "../providers/inputBudget";
import { CognitionInputBudgetError } from "./cognitionTypes";
import type { CognitionSnapshotRead } from "./cognitionSnapshotReader";
import type {
  CognitionAnalysis,
  CognitionDecisionAttempt,
  CognitionDriver,
  CognitionEvidenceInput,
  CognitionIntent,
  CognitionPreparedContext,
  CognitionRuntimePort,
  CognitionServiceContract,
  CognitionSnapshot,
  CognitionTurnInput,
  CognitionStateReferences,
} from "./cognitionTypes";

export interface CognitionServiceOptions {
  readonly repository: CognitionRepository;
  readonly driver: CognitionDriver;
  readonly memory: MemoryRecall;
  readonly runtime: CognitionRuntimePort;
  readonly clock: Clock;
  readonly activePersonaId: () => string;
  /** UTF-8 bytes for the local analysis snapshot and its coverage metadata. */
  readonly analysisReadBudgetBytes: number;
  /** Memory evidence allocation; independent of the local snapshot byte budget. */
  readonly analysisBudgetTokens: number;
  /** Local batching heuristic. It does not define an episode or a brain constant. */
  readonly batchWindowMs: number;
  readonly onScheduleChanged?: () => void;
  readonly onError?: (error: unknown) => void;
  /** Notification after a state commit; durable pending items own crash recovery. */
  readonly onMemoryHandoffPending?: () => void;
  /** Recheck retained originals after decision/intent consumers settle or change. */
  readonly onSourceConsumersChanged?: () => void;
  /** On-demand input refresh for an already due analysis, never for prepareTurn. */
  readonly beforeAnalysis?: (signal: AbortSignal) => Promise<void>;
  /** Main resolves canonical source aliases; owner is not a Persona selector. */
  readonly resolveMemoryStateReferences?: (
    personaId: string,
    items: EvidencePack["items"],
    maxBytes: number,
  ) => CognitionStateReferences;
}

interface CountBuffer {
  evidence: CognitionEvidenceInput;
  firstAt: string;
  sourceIds: Set<string>;
}

export class CognitionService implements CognitionServiceContract {
  readonly #countBuffers = new Map<string, CountBuffer>();
  readonly #triggers = new Map<string, CognitionDecisionAttempt["trigger"]>();
  #task: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #stopped = false;
  readonly #failedContexts = new Map<
    string,
    { generation: number; consideredAt: string }
  >();
  readonly #recoveryGenerations = new Map<string, number>();
  readonly #visualRefreshPending = new Set<string>();

  private recoveryContext(personaId: string): number {
    return this.#recoveryGenerations.get(personaId) ?? 0;
  }
  private changedRecoveryContext(personaId: string): void {
    this.#recoveryGenerations.set(
      personaId,
      this.recoveryContext(personaId) + 1,
    );
  }
  private sameFailedContext(personaId: string): boolean {
    return (
      this.#failedContexts.get(personaId)?.generation ===
      this.recoveryContext(personaId)
    );
  }

  constructor(private readonly options: CognitionServiceOptions) {
    if (
      !Number.isSafeInteger(options.analysisReadBudgetBytes) ||
      options.analysisReadBudgetBytes <= 0 ||
      !(options.analysisBudgetTokens > 0) ||
      options.batchWindowMs < 0
    ) {
      throw new RangeError(
        "Cognition requires valid host budget allocations and batch window",
      );
    }
  }

  private analysisBytes(
    read: Pick<CognitionSnapshotRead, "snapshot" | "coverage">,
  ): number {
    return Buffer.byteLength(
      JSON.stringify({ snapshot: read.snapshot, coverage: read.coverage }),
      "utf8",
    );
  }

  private reduceAnalysisReadBudget(
    error: unknown,
    budget: number,
    read: Pick<CognitionSnapshotRead, "snapshot" | "coverage">,
  ): number {
    if (!(error instanceof CognitionInputBudgetError)) throw error;
    const { exactInputTokens, estimatedTokens, unknownKinds } =
      error.measurement;
    const measured = exactInputTokens ?? estimatedTokens;
    const allowed =
      exactInputTokens === undefined
        ? Math.floor(error.budget * INPUT_BUDGET_ESTIMATE_RATIO) - 1
        : error.budget;
    if (
      (exactInputTokens === undefined && unknownKinds.length) ||
      !Number.isSafeInteger(measured) ||
      measured <= allowed ||
      allowed <= 0
    )
      throw error;
    const current = Math.min(budget, this.analysisBytes(read));
    // A measured proportion guides the next read, not a bytes-to-token conversion.
    // Only the next complete Provider measurement can accept the actual request.
    const next = Math.floor((current * allowed) / measured);
    if (next <= 0 || next >= current) throw error;
    return next;
  }

  private assertAnalysisContext(
    attempt: CognitionDecisionAttempt,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    if (
      this.options.activePersonaId() !== attempt.personaId ||
      this.options.repository.getAttention(
        attempt.personaId,
        this.options.clock.now(),
      ).userGeneration !== attempt.dependencies.userGeneration ||
      this.options.runtime.availability(attempt.personaId).sleeping
    )
      throw new CognitionConflictError(
        "Host context changed while reallocating analysis input",
      );
  }

  initialize(): void {
    this.#failedContexts.clear();
    const now = this.options.clock.now();
    for (const personaId of new Set([
      ...this.options.repository.listPersonaIds(),
      this.options.activePersonaId(),
    ])) {
      for (const attempt of this.options.repository.unfinishedAttempts(
        personaId,
      )) {
        if (
          ["pending", "analyzing", "awaiting_recall", "ready"].includes(
            attempt.status,
          )
        ) {
          this.options.repository.restoreAttemptWakes(attempt, now);
          this.options.repository.saveAttempt({
            ...attempt,
            status: "superseded",
            outcome: "interrupted",
            updatedAt: now,
          });
        }
      }
      if (
        personaId === this.options.activePersonaId() &&
        (this.options.repository.hasReviewableInput(personaId) ||
          this.options.repository.hasPendingOpportunity(personaId, now) ||
          this.options.repository.hasFailedWork(personaId))
      ) {
        this.schedule(personaId, "resume", now);
      }
    }
    this.options.onScheduleChanged?.();
  }

  ingest(evidence: CognitionEvidenceInput): void {
    if (this.#stopped) return;
    if (
      evidence.kind === "observation" &&
      evidence.boundary === "interaction" &&
      !evidence.text &&
      !evidence.visual &&
      !evidence.effect &&
      !evidence.opportunity &&
      !evidence.control
    ) {
      this.bufferCounts(evidence);
      return;
    }
    this.flushCounts(evidence.personaId);
    if (
      evidence.kind === "observation" &&
      evidence.object &&
      evidence.boundary !== "idle" &&
      !evidence.interaction &&
      !evidence.effect &&
      !evidence.opportunity &&
      !evidence.control
    ) {
      const previous = this.options.repository.latestObservation(
        evidence.personaId,
        evidence.actor,
      );
      if (
        previous &&
        !previous.interaction &&
        !previous.effect &&
        !previous.opportunity &&
        !previous.control &&
        // Returning to a surface is new evidence even if its contents match.
        // A late receipt must not suppress a subsequent real focus change.
        ((evidence.actor !== "user" && evidence.actor !== "unknown") ||
          this.options.repository.getAttention(
            evidence.personaId,
            this.options.clock.now(),
          ).foregroundObject?.key === evidence.object.key) &&
        JSON.stringify([
          previous.source.kind,
          previous.sourceEpoch,
          previous.boundary,
          previous.object,
          previous.text,
          previous.visibility,
          previous.visual,
        ]) ===
          JSON.stringify([
            evidence.source.kind,
            evidence.sourceEpoch,
            evidence.boundary,
            evidence.object,
            evidence.text,
            evidence.visibility,
            evidence.visual,
          ])
      ) {
        this.options.repository.recordCoalescedObservation(
          evidence,
          this.options.clock.now(),
        );
        return;
      }
    }
    const receipt = this.options.repository.ingest(
      evidence,
      this.options.clock.now(),
    );
    if (!receipt.inserted) return;
    if (
      evidence.control === "user_engaged" ||
      evidence.control === "user_stop" ||
      evidence.control === "user_correction" ||
      evidence.control === "persona_changed"
    ) {
      this.#abort?.abort(new Error("User control changed"));
    }
    if (evidence.control === "sleep")
      this.#abort?.abort(new Error("Host sleeping"));
    if (evidence.opportunity) {
      this.changedRecoveryContext(evidence.personaId);
      if (evidence.opportunity.status === "cancelled") {
        for (const personaId of this.options.repository.opportunityPersonaIds(
          evidence.opportunity.id,
        )) {
          if (personaId !== evidence.personaId)
            this.ingest({ ...evidence, id: randomUUID(), personaId });
        }
        this.#abort?.abort(new Error("Important-moment source invalidated"));
        const affectedRun = [
          ...this.options.repository.unfinishedAttempts(evidence.personaId),
        ].some((attempt) => {
          if (attempt.status !== "dispatched") return false;
          const selected = attempt.decision?.choices.find(
            (value) => value.id === attempt.decision?.selectedChoiceId,
          );
          return (
            selected &&
            [
              ...this.options.repository.choiceOpportunityEvidence(
                selected,
                evidence.personaId,
              ),
            ].some((item) => item.opportunity?.id === evidence.opportunity?.id)
          );
        });
        if (affectedRun)
          void this.options.runtime
            .yieldCharacterRun(evidence.personaId)
            .catch((error: unknown) => this.options.onError?.(error));
      }
      this.schedule(
        evidence.personaId,
        "semantic_change",
        this.options.clock.now(),
      );
      return;
    }
    if (
      evidence.source.kind === "memory" ||
      evidence.boundary === "idle" ||
      evidence.visual?.trigger === "frame"
    )
      return;
    this.changedRecoveryContext(evidence.personaId);
    this.schedule(
      evidence.personaId,
      evidence.kind === "effect"
        ? "feedback"
        : evidence.kind === "utterance"
          ? "user_turn"
          : "semantic_change",
    );
  }

  observeFeedback(evidence: CognitionEvidenceInput): void {
    if (this.#stopped) return;
    this.ingest(evidence);
    const runId =
      evidence.effect?.runId ??
      (evidence.source.kind === "run" ? evidence.source.id : undefined);
    if (!runId) return;
    const now = this.options.clock.now();
    const storedEvidenceId = this.options.repository.ingest(evidence, now)
      .evidence.id;
    const attempt = this.options.repository.getAttemptForRun(runId);
    if (attempt && attempt.personaId === evidence.personaId) {
      this.options.repository.saveAttempt({
        ...attempt,
        feedbackEvidenceIds: [
          ...new Set([...attempt.feedbackEvidenceIds, storedEvidenceId]),
        ],
        updatedAt: now,
      });
    }
  }

  prepareTurn(input: CognitionTurnInput): Promise<CognitionPreparedContext> {
    input.signal.throwIfAborted();
    const read = this.options.repository.readConversationContext(
      input.personaId,
      this.options.clock.now(),
      input.resourceBudget,
      input.signal,
    );
    const context = projectCognitionContext(
      read.snapshot,
      input.contextBudget.maxTokens,
      read,
    );
    // Current input already belongs to the real Agent turn. No invented recall plan or classifier.
    // Background packs are not automatically injected into an unrelated greeting.
    return Promise.resolve(context);
  }

  async yieldToUser(
    personaId: string,
    continuingRunId?: string,
  ): Promise<void> {
    if (this.#stopped) return;
    const now = this.options.clock.now();
    this.ingest({
      id: randomUUID(),
      personaId,
      actor: "user",
      kind: "control",
      control: "user_engaged",
      source: { kind: "system", id: `user-engaged:${randomUUID()}` },
      observedAt: now,
    });
    // This awaits actual runtime cancellation, including cooperative tools. Completed effects survive.
    await this.options.runtime.yieldCharacterRun(personaId, continuingRunId);
  }

  getSnapshot(personaId: string): CognitionSnapshot {
    return this.options.repository.getSnapshot(
      personaId,
      this.options.clock.now(),
    );
  }

  characterIntents(personaId: string): Iterable<CognitionIntent> {
    return this.options.repository.characterIntents(personaId);
  }
  currentCharacterIntent(personaId: string): CognitionIntent | undefined {
    return this.options.repository.currentCharacterIntent(
      personaId,
      this.options.clock.now(),
    );
  }
  isCharacterPaused(personaId: string): boolean {
    return this.options.repository.isCharacterPaused(personaId);
  }

  getRunIntent(runId: string): CognitionIntent | undefined {
    const attempt = this.options.repository.getAttemptForRun(runId);
    const choice = attempt?.decision?.choices.find(
      ({ id }) => id === attempt.decision?.selectedChoiceId,
    );
    return choice?.intentId
      ? this.options.repository.getIntent(choice.intentId)
      : undefined;
  }

  earliestNextRunAt(): string | undefined {
    if (this.#stopped) return undefined;
    const personaId = this.options.activePersonaId();
    if (this.options.runtime.availability(personaId).sleeping) return undefined;
    if (
      this.sameFailedContext(personaId) &&
      !this.#visualRefreshPending.has(personaId)
    ) {
      // A separate, already scheduled future consideration is a new event,
      // not a timer that retries the failed consideration.
      return this.options.repository.earliestNextRunAt(
        personaId,
        this.#failedContexts.get(personaId)!.consideredAt,
      );
    }
    return this.options.repository.earliestNextRunAt(personaId);
  }

  /** Pixel-change metadata is a wake signal, not evidence or a second decision path. */
  notifyVisualChange(): void {
    if (this.#stopped) return;
    const personaId = this.options.activePersonaId();
    if (this.options.runtime.availability(personaId).sleeping) return;
    const attention = this.options.repository.getAttention(
      personaId,
      this.options.clock.now(),
    );
    // A real pixel-change signal may refresh input once; unchanged refreshed input does not retry the model.
    this.#visualRefreshPending.add(personaId);
    if (!attention.nextWakeAt) this.schedule(personaId, "semantic_change");
    else this.options.onScheduleChanged?.();
  }

  retryAfterConfigurationChange(): void {
    if (this.#stopped) return;
    const interrupted = this.#task !== undefined;
    this.changedRecoveryContext(this.options.activePersonaId());
    this.#abort?.abort(new Error("Provider configuration changed"));
    const personaId = this.options.activePersonaId();
    if (this.options.runtime.availability(personaId).sleeping) return;
    const now = this.options.clock.now();
    if (
      interrupted ||
      this.options.repository.hasReviewableInput(personaId) ||
      this.options.repository.hasPendingOpportunity(personaId, now) ||
      this.options.repository.hasFailedWork(personaId)
    )
      this.schedule(personaId, "resume", now);
  }

  runDue(now = this.options.clock.now()): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#task) return this.#task;
    this.#task = this.drain(now).finally(() => {
      this.#task = undefined;
      this.#abort = undefined;
      if (!this.#stopped) this.options.onSourceConsumersChanged?.();
    });
    return this.#task;
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort(new Error("Cognition shutdown"));
    for (const personaId of new Set([
      ...this.options.repository.listPersonaIds(),
      ...[...this.#countBuffers.values()].map(
        ({ evidence }) => evidence.personaId,
      ),
    ]))
      this.flushCounts(personaId);
    await this.#task;
    this.#countBuffers.clear();
    this.#triggers.clear();
  }

  /** Host-owned Life tools adopt/edit the same persistent intent; there is no second Life scheduler. */
  saveCharacterIntent(
    value: CognitionIntent,
    expectedRevision?: number,
  ): CognitionIntent {
    if (this.#stopped) throw new Error("Cognition has stopped");
    if (value.owner !== "character" || value.basis !== "character") {
      throw new CognitionConflictError(
        "Life intent must belong to the character",
      );
    }
    if (value.status === "fulfilled" || value.completion)
      throw new CognitionConflictError(
        "Life planning does not create completion receipts",
      );
    const saved = this.options.repository.saveIntent(value, expectedRevision);
    this.changedRecoveryContext(value.personaId);
    this.options.onSourceConsumersChanged?.();
    this.schedule(
      value.personaId,
      "character_due",
      value.nextWakeAt ?? this.options.clock.now(),
    );
    return saved;
  }

  private schedule(
    personaId: string,
    trigger: CognitionDecisionAttempt["trigger"],
    dueAt?: string,
    notify = true,
  ): void {
    const now = this.options.clock.now();
    const due =
      dueAt ??
      new Date(Date.parse(now) + this.options.batchWindowMs).toISOString();
    this.#triggers.set(personaId, trigger);
    this.options.repository.updateAttention(personaId, now, (state) => ({
      ...state,
      nextWakeAt:
        state.nextWakeAt && state.nextWakeAt < due ? state.nextWakeAt : due,
    }));
    if (notify) this.options.onScheduleChanged?.();
  }

  private bufferCounts(evidence: CognitionEvidenceInput): void {
    const key = `${evidence.personaId}:${evidence.actor}`;
    let buffer = this.#countBuffers.get(key);
    if (
      buffer &&
      (buffer.evidence.object?.key !== evidence.object?.key ||
        Date.parse(evidence.observedAt) - Date.parse(buffer.firstAt) >=
          this.options.batchWindowMs)
    ) {
      this.flushCountBuffer(key, buffer);
      buffer = undefined;
    }
    if (buffer?.sourceIds.has(evidence.id)) return;
    if (!buffer) {
      this.#countBuffers.set(key, {
        evidence: structuredClone(evidence),
        firstAt: evidence.observedAt,
        sourceIds: new Set([evidence.id]),
      });
      return;
    }
    const before = buffer.evidence.interaction ?? {
      clicks: 0,
      keystrokes: 0,
      scrolls: 0,
    };
    const added = evidence.interaction ?? {
      clicks: 0,
      keystrokes: 0,
      scrolls: 0,
    };
    buffer.sourceIds.add(evidence.id);
    buffer.evidence = {
      ...evidence,
      interaction: {
        clicks: before.clicks + added.clicks,
        keystrokes: before.keystrokes + added.keystrokes,
        scrolls: before.scrolls + added.scrolls,
      },
    };
  }

  private flushCountBuffer(key: string, buffer: CountBuffer): void {
    this.#countBuffers.delete(key);
    this.options.repository.ingest(buffer.evidence, this.options.clock.now());
    this.options.repository.consumePassivePrefix(
      buffer.evidence.personaId,
      this.options.clock.now(),
    );
  }

  private flushCounts(personaId: string): void {
    for (const [key, buffer] of this.#countBuffers) {
      if (buffer.evidence.personaId === personaId)
        this.flushCountBuffer(key, buffer);
    }
  }

  private reconcile(snapshot: CognitionSnapshot): void {
    for (const attempt of this.options.repository.unfinishedAttempts(
      snapshot.attention.personaId,
    )) {
      if (attempt.status !== "dispatched" || !attempt.runId) continue;
      const result = this.options.runtime.reconcileRun(attempt.runId);
      for (const evidence of result.evidence) this.observeFeedback(evidence);
      if (!result.terminal || result.deliveryPending) continue;
      const latest = this.options.repository.getAttempt(attempt.id) ?? attempt;
      this.options.repository.saveAttempt({
        ...latest,
        status: "settled",
        // Delivery is an actual surface receipt, never a generated assistant sentence.
        outcome: this.options.repository.hasEvidence(
          attempt.personaId,
          {
            kind: "run",
            id: attempt.runId,
            revision: "surface:offered",
          },
          "observation",
        )
          ? "delivered"
          : (result.unsuccessful ??
            (result.evidence.some(
              (item) => item.effect?.outcome === "performed",
            )
              ? "performed"
              : "unknown")),
        updatedAt: this.options.clock.now(),
      });
    }
  }

  private async drain(now: string): Promise<void> {
    const personaId = this.options.activePersonaId();
    const snapshot = this.getSnapshot(personaId);
    this.reconcile(snapshot);
    if (this.#stopped || this.options.runtime.availability(personaId).sleeping)
      return;
    const due = this.earliestNextRunAt();
    if (!due || due > now) return;
    this.flushCounts(personaId);
    this.options.repository.consumePassivePrefix(personaId, now);
    let recoveryContext = this.recoveryContext(personaId);
    let consideredAt = now;
    this.#visualRefreshPending.delete(personaId);
    let attempt: CognitionDecisionAttempt | undefined;
    let committedState = false;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    try {
      await this.options.beforeAnalysis?.(signal);
      signal.throwIfAborted();
      if (this.sameFailedContext(personaId)) {
        const nextConsideration = this.options.repository.earliestNextRunAt(
          personaId,
          this.#failedContexts.get(personaId)!.consideredAt,
        );
        if (!nextConsideration || nextConsideration > this.options.clock.now())
          return;
        this.changedRecoveryContext(personaId);
      }
      recoveryContext = this.recoveryContext(personaId);
      if (
        this.options.activePersonaId() !== personaId ||
        this.options.repository.getAttention(
          personaId,
          this.options.clock.now(),
        ).userGeneration !== snapshot.attention.userGeneration ||
        this.options.runtime.availability(personaId).sleeping
      ) {
        throw new CognitionConflictError(
          "Host context changed while refreshing analysis input",
        );
      }
      consideredAt = this.options.clock.now();
      let readBudget = this.options.analysisReadBudgetBytes;
      let selection = this.options.repository.readSnapshot(
        personaId,
        consideredAt,
        readBudget,
      );
      let selected = selection.snapshot;
      const originalSelection = selection;
      const retainedFeedback = selected.recentAttempts.filter(
        ({ status, error }) =>
          error && (status === "failed" || status === "superseded"),
      );
      const trigger = this.#triggers.get(personaId) ?? "character_due";
      this.#triggers.delete(personaId);
      attempt = this.options.repository.createAttempt(
        selection,
        trigger,
        now,
        selection.coverage.allocation,
        consideredAt,
        selection.coverage.sourceCoverage,
      );
      attempt = this.options.repository.saveAttempt({
        ...attempt,
        status: "analyzing",
      });
      let analysis: CognitionAnalysis;
      for (;;) {
        try {
          analysis = parseSchema(
            CognitionAnalysisSchema,
            await this.options.driver.analyze(
              {
                attempt,
                snapshot: selected,
                executionMaterial:
                  this.options.repository.actionMaterialSources(
                    personaId,
                    selected.evidence.map(({ id }) => id),
                  ),
                coverage: selection.coverage,
                availability: this.options.runtime.availability(personaId),
              },
              signal,
            ),
          );
          break;
        } catch (error) {
          this.assertAnalysisContext(attempt, signal);
          readBudget = this.reduceAnalysisReadBudget(
            error,
            readBudget,
            selection,
          );
          const reread = this.options.repository.readSnapshot(
            personaId,
            this.options.clock.now(),
            readBudget,
          );
          const next = selectAnalysisSnapshot(
            {
              ...reread.snapshot,
              evidence: reread.snapshot.evidence.filter(
                (value) =>
                  value.receiptSequence <=
                  originalSelection.receivedThroughSequence,
              ),
              attention: {
                ...reread.snapshot.attention,
                lastReceiptSequence: Math.min(
                  reread.snapshot.attention.lastReceiptSequence,
                  originalSelection.snapshot.attention.lastReceiptSequence,
                ),
              },
            },
            readBudget,
            {
              ...reread.coverage,
              ...(originalSelection.coverage.currentUserSource
                ? {
                    currentUserSource:
                      originalSelection.coverage.currentUserSource,
                  }
                : {}),
              ...(originalSelection.coverage.sourceCoverage
                ? {
                    sourceCoverage: {
                      ...originalSelection.coverage.sourceCoverage,
                      supplied: reread.coverage.sourceCoverage?.supplied ?? [],
                      ...(reread.coverage.sourceCoverage?.readResults
                        ? {
                            readResults:
                              reread.coverage.sourceCoverage.readResults,
                          }
                        : {}),
                    },
                  }
                : {}),
            },
            retainedFeedback,
          );
          if (this.analysisBytes(next) >= this.analysisBytes(selection))
            throw error;
          this.assertAnalysisContext(attempt, signal);
          selection = {
            ...next,
            receivedThroughSequence: originalSelection.receivedThroughSequence,
          };
          selected = selection.snapshot;
          const previous = { ...attempt };
          delete previous.allocation;
          delete previous.sourceCoverage;
          attempt = this.options.repository.saveAttempt({
            ...previous,
            throughSequence: selected.attention.lastReceiptSequence,
            ...(selection.coverage.allocation
              ? { allocation: selection.coverage.allocation }
              : {}),
            ...(selection.coverage.sourceCoverage
              ? { sourceCoverage: selection.coverage.sourceCoverage }
              : {}),
            dependencies: {
              ...attempt.dependencies,
              focusRevision: selected.attention.focusRevision,
              situations: selected.situations.map(({ id, revision }) => ({
                id,
                revision,
              })),
              intents: selected.intents.map(({ id, revision }) => ({
                id,
                revision,
              })),
              evidenceIds: selected.evidence.map(({ id }) => id),
            },
            ...(attempt.wakeSources
              ? {
                  wakeSources: {
                    ...(attempt.wakeSources.attentionWakeAt &&
                    attempt.wakeSources.attentionWakeAt ===
                      selected.attention.nextWakeAt
                      ? { attentionWakeAt: attempt.wakeSources.attentionWakeAt }
                      : {}),
                    intents: attempt.wakeSources.intents.filter((wake) =>
                      selected.intents.some(
                        (value) =>
                          value.id === wake.id &&
                          value.revision === wake.revision &&
                          value.nextWakeAt === wake.nextWakeAt,
                      ),
                    ),
                  },
                }
              : {}),
          });
        }
      }
      signal.throwIfAborted();
      if (this.options.activePersonaId() !== personaId)
        throw new CognitionConflictError("Active persona changed");
      attempt = this.options.repository.commitAnalysis(
        attempt.id,
        analysis,
        this.options.clock.now(),
        selected.evidence,
      );
      committedState = true;
      this.publishMemoryHandoff();
      if (attempt.recallPlan || analysis.sourceReadPlan) {
        const plan = attempt.recallPlan
          ? {
              ...attempt.recallPlan,
              personaId,
              contextBudget: {
                maxTokens: Math.min(
                  attempt.recallPlan.contextBudget.maxTokens,
                  this.options.analysisBudgetTokens,
                ),
              },
            }
          : undefined;
        attempt = this.options.repository.saveAttempt({
          ...attempt,
          status: "awaiting_recall",
          ...(plan ? { recallPlan: plan } : {}),
        });
        const pack = plan
          ? await this.options.memory.recall(plan, signal)
          : undefined;
        signal.throwIfAborted();
        const memoryEvidence = (pack?.items ?? [])
          .map((item): CognitionEvidenceInput => ({
            id: randomUUID(),
            personaId,
            actor: "system",
            kind: "recollection",
            text: item.content,
            observedAt: this.options.clock.now(),
            source: {
              kind: "memory",
              id: item.memoryId,
              revision: item.revisionId,
              fragment: attempt!.id,
            },
            recollection: {
              type: item.type,
              current: item.current,
              historyStatus: item.historyStatus,
              ...(item.historyStatusRevisionId
                ? { historyStatusRevisionId: item.historyStatusRevisionId }
                : {}),
              recordedAt: item.recordedAt,
              ...(item.basis ? { basis: item.basis } : {}),
              ...(item.owner ? { owner: item.owner } : {}),
              ...(item.personaId ? { personaId: item.personaId } : {}),
              ...(item.occurredFrom ? { occurredFrom: item.occurredFrom } : {}),
              ...(item.occurredTo ? { occurredTo: item.occurredTo } : {}),
              ...(item.validFrom ? { validFrom: item.validFrom } : {}),
              ...(item.validTo ? { validTo: item.validTo } : {}),
            },
          }))
          .map(
            (value) =>
              this.options.repository.ingest(value, this.options.clock.now())
                .evidence,
          );
        const requestedSourceIds =
          attempt.sourceCoverage?.readPlan?.requests.map(
            ({ evidenceId }) => evidenceId,
          ) ?? [];
        let completion: ReturnType<typeof selectAnalysisSnapshot>;
        let previousCompletionBytes: number | undefined;
        for (;;) {
          const afterRead = this.options.repository.readSnapshot(
            personaId,
            this.options.clock.now(),
            readBudget,
            this.options.resolveMemoryStateReferences?.(
              personaId,
              pack?.items ?? [],
              readBudget,
            ),
            [
              ...requestedSourceIds,
              ...[...selected.evidence, ...memoryEvidence].map(({ id }) => id),
            ],
          );
          const afterRecall = afterRead.snapshot;
          if (
            afterRecall.attention.userGeneration !==
              attempt.dependencies.userGeneration ||
            this.options.activePersonaId() !== personaId
          ) {
            throw new CognitionConflictError(
              "User context changed during recall",
            );
          }
          // Keep sources required by the actual visible state along with this attempt's
          // selected inputs. Do not import the unrelated journal page read during recall.
          const evidenceIds = new Set([
            ...requestedSourceIds,
            ...[...selected.evidence, ...memoryEvidence].map(({ id }) => id),
          ]);
          for (const situation of afterRecall.situations) {
            for (const episode of situation.episodes)
              episode.evidenceIds.forEach((id) => evidenceIds.add(id));
            for (const claim of situation.claims)
              [
                ...claim.evidenceIds,
                ...claim.contradictingEvidenceIds,
                ...(claim.historyEvidenceIds ?? []),
              ].forEach((id) => evidenceIds.add(id));
          }
          for (const intent of afterRecall.intents)
            [
              ...intent.evidenceIds,
              ...intent.effectEvidenceIds,
              ...(intent.completion?.evidenceUses.map(
                ({ evidenceId }) => evidenceId,
              ) ?? []),
            ].forEach((id) => evidenceIds.add(id));
          const evidence = afterRecall.evidence.filter(({ id }) =>
            evidenceIds.has(id),
          );
          const finalSnapshot: CognitionSnapshot = {
            ...afterRecall,
            evidence,
            attention: {
              ...afterRecall.attention,
              lastReceiptSequence: attempt.throughSequence,
            },
          };
          completion = selectAnalysisSnapshot(
            finalSnapshot,
            readBudget,
            {
              ...afterRead.coverage,
              ...(attempt.sourceCoverage
                ? {
                    sourceCoverage: {
                      ...attempt.sourceCoverage,
                      supplied:
                        afterRead.coverage.sourceCoverage?.supplied ?? [],
                      ...(afterRead.coverage.sourceCoverage?.readResults
                        ? {
                            readResults:
                              afterRead.coverage.sourceCoverage.readResults,
                          }
                        : {}),
                    },
                  }
                : {}),
            },
            // The awaiting-recall Attempt is now the latest persisted row. Carry
            // only failure feedback actually supplied in this same analysis;
            // re-reading the journal must not erase it or expand error history.
            retainedFeedback,
          );
          const completionBytes = this.analysisBytes(completion);
          if (
            previousCompletionBytes !== undefined &&
            completionBytes >= previousCompletionBytes
          )
            throw new RangeError(
              "Cognition completion input cannot be reduced further",
            );
          attempt = this.options.repository.saveAttempt({
            ...attempt,
            status: "analyzing",
            ...(pack
              ? {
                  recallSummary: {
                    coverage: pack.coverage,
                    gaps: pack.gaps,
                    truncated: pack.truncated,
                    incompleteReasons: pack.incompleteReasons,
                  },
                }
              : {}),
            ...(completion.coverage.sourceCoverage
              ? { sourceCoverage: completion.coverage.sourceCoverage }
              : {}),
            ...(completion.coverage.allocation
              ? { allocation: completion.coverage.allocation }
              : {}),
            dependencies: {
              // Recall adds selected material, not a newer user receipt boundary.
              ...attempt.dependencies,
              situations: completion.snapshot.situations.map(
                ({ id, revision }) => ({
                  id,
                  revision,
                }),
              ),
              intents: completion.snapshot.intents.map(({ id, revision }) => ({
                id,
                revision,
              })),
              evidenceIds: completion.snapshot.evidence.map(({ id }) => id),
            },
          });
          try {
            analysis = parseSchema(
              CognitionAnalysisSchema,
              await this.options.driver.analyze(
                {
                  attempt,
                  snapshot: completion.snapshot,
                  executionMaterial:
                    this.options.repository.actionMaterialSources(
                      personaId,
                      completion.snapshot.evidence.map(({ id }) => id),
                    ),
                  coverage: completion.coverage,
                  ...(pack ? { evidencePack: pack } : {}),
                  availability: this.options.runtime.availability(personaId),
                },
                signal,
              ),
            );
            signal.throwIfAborted();
            break;
          } catch (error) {
            this.assertAnalysisContext(attempt, signal);
            readBudget = this.reduceAnalysisReadBudget(
              error,
              readBudget,
              completion,
            );
            previousCompletionBytes = completionBytes;
          }
        }
        if (analysis.recallPlan || analysis.sourceReadPlan)
          throw new CognitionConflictError(
            "Evidence completion must resolve or retain gaps, not recursively replan reading",
          );
        attempt = this.options.repository.commitAnalysis(
          attempt.id,
          analysis,
          this.options.clock.now(),
          completion.snapshot.evidence,
        );
        this.publishMemoryHandoff();
      }
      await this.dispatchOrSettle(attempt, signal);
      const settled = this.options.repository.getAttempt(attempt.id);
      if (settled?.status === "superseded" && !settled.runId) {
        this.options.repository.restoreAttemptWakes(
          settled,
          this.options.clock.now(),
        );
        this.#failedContexts.set(personaId, {
          generation: recoveryContext,
          consideredAt,
        });
      }
      this.options.repository.consumePassivePrefix(
        personaId,
        this.options.clock.now(),
      );
      if (this.options.repository.hasReviewableInput(personaId))
        this.schedule(personaId, "semantic_change", undefined, false);
    } catch (error) {
      if (attempt) {
        const latest =
          this.options.repository.getAttempt(attempt.id) ?? attempt;
        this.options.repository.restoreAttemptWakes(
          latest,
          this.options.clock.now(),
        );
        if (
          !latest.runId &&
          !["settled", "superseded", "failed"].includes(latest.status)
        ) {
          this.options.repository.saveAttempt({
            ...latest,
            status:
              signal.aborted || error instanceof CognitionConflictError
                ? "superseded"
                : "failed",
            outcome: signal.aborted ? "interrupted" : "failed",
            error:
              error instanceof Error
                ? error.message
                : "Cognition analysis failed",
            updatedAt: this.options.clock.now(),
          });
        }
      }
      this.#failedContexts.set(personaId, {
        generation: recoveryContext,
        consideredAt,
      });
      if (!signal.aborted) this.options.onError?.(error);
      if (
        committedState &&
        error instanceof CognitionConflictError &&
        !signal.aborted &&
        this.options.repository.hasReviewableInput(personaId)
      )
        this.schedule(personaId, "semantic_change", undefined, false);
    }
  }

  private publishMemoryHandoff(): void {
    try {
      this.options.onMemoryHandoffPending?.();
    } catch (error) {
      // Notification is not the handoff: a failed consumer leaves pending work
      // durable, and Main may retry it without replaying historical situations.
      this.options.onError?.(error);
    }
  }

  private async dispatchOrSettle(
    attempt: CognitionDecisionAttempt,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const now = this.options.clock.now();
    const choice = attempt.decision?.choices.find(
      ({ id }) => id === attempt.decision?.selectedChoiceId,
    );
    if (!choice)
      throw new CognitionConflictError("Ready attempt has no selected choice");
    if (
      !this.options.repository.actionFreshness(attempt, now).current ||
      this.options.activePersonaId() !== attempt.personaId
    ) {
      this.options.repository.saveAttempt({
        ...attempt,
        status: "superseded",
        outcome: "deferred",
        updatedAt: now,
      });
      return;
    }
    const blocked = this.options.repository.choiceBlockReason(
      choice,
      attempt.personaId,
      this.options.runtime.availability(attempt.personaId, attempt),
    );
    if (choice.kind === "remain_quiet" || blocked) {
      this.options.repository.saveAttempt({
        ...attempt,
        status: "settled",
        outcome: blocked ? "deferred" : "quiet",
        updatedAt: now,
      });
      if (choice.intentId) {
        const intent = this.options.repository.getIntent(choice.intentId);
        if (
          intent &&
          intent.status !== "fulfilled" &&
          intent.status !== "abandoned"
        ) {
          const resumeConditions =
            blocked && attempt.decision?.selectedBasis.requestedContinuation
              ? [
                  ...new Map(
                    [
                      ...intent.resumeConditions,
                      ...choice.resumeConditions,
                    ].map((condition) => [
                      JSON.stringify(condition),
                      condition,
                    ]),
                  ).values(),
                ]
              : choice.resumeConditions;
          const nextWakeAt = resumeConditions
            .flatMap(({ after }) => (after ? [after] : []))
            .filter((value) => value > now)
            .sort()[0];
          const updated = {
            ...intent,
            revision: intent.revision + 1,
            resumeConditions,
            blockers: blocked
              ? [...new Set([...intent.blockers, blocked])]
              : intent.blockers,
            updatedAt: now,
          };
          delete updated.nextWakeAt;
          if (nextWakeAt) updated.nextWakeAt = nextWakeAt;
          this.options.repository.saveIntent(updated, intent.revision);
        }
      }
      return;
    }
    const result = await this.options.runtime.dispatch({
      attemptId: attempt.id,
      signal,
      dispatchKey: attempt.dispatchKey,
      personaId: attempt.personaId,
      choice,
      // The selected set is complete or unavailable; the consuming Runtime
      // counts its complete wire after this synchronous material read.
      prepareContext: ({ maxReadBytes, signal: preparationSignal }) => {
        preparationSignal.throwIfAborted();
        const context = this.options.repository.readActionContext(
          attempt,
          maxReadBytes,
          (selected, remainingReadBytes) => {
            preparationSignal.throwIfAborted();
            return attachSelectedRecollections(
              selected,
              attempt,
              this.options.memory,
              this.options.repository.actionRecollectionRequest(attempt),
              remainingReadBytes,
            );
          },
        );
        preparationSignal.throwIfAborted();
        return context;
      },
    });
    const persisted = this.options.repository.getAttempt(attempt.id);
    if (result.continuedInputItemId) {
      if (
        persisted?.status !== "settled" ||
        persisted.outcome !== "context_supplied" ||
        persisted.contextContinuation?.runId !== result.runId ||
        persisted.contextContinuation.itemId !== result.continuedInputItemId ||
        persisted.runId
      )
        throw new CognitionConflictError(
          "Runtime failed to accept context atomically in its existing Run",
        );
      return;
    }
    if (
      persisted?.runId !== result.runId ||
      persisted.status !== "dispatched"
    ) {
      throw new CognitionConflictError(
        "Runtime failed to bind dispatch atomically to its Run",
      );
    }
  }
}
