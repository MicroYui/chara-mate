import { ProviderError } from "../providers/providerError";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "@sinclair/typebox";

import { CONSOLIDATION_KEYS } from "./memoryLearningRepository";
import type {
  MemorySource,
  MemoryPriorDisposition,
} from "../../shared/contracts/memory";
import type {
  MemoryEvidenceItem,
  MemoryEvidenceReference,
  MemoryEvidenceReadCost,
  RecallPlan,
  MemoryFormationEpisode,
  MemoryFormationMaterial,
  MemoryFormationIntake,
  MemoryFormationWorkRef,
  MemoryRevisionSemantics,
} from "../../shared/contracts/memoryRecall";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactBoundaryValue, redactText } from "../../shared/pure/redaction";
import { MemoryRevisionSemanticsSchema } from "../../shared/schemas/memoryRecall";
import { EntityIdSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import {
  MemoryFormationBatchSchema,
  type MemoryFormationBatch,
  type MemoryFormationModel,
  type MemoryFormationRuntime,
  type MemoryFormationInput,
  type PreparedMemoryFormation,
  type MemoryFormationValidationIssue,
} from "./memoryModels";
import {
  segmentMemoryEpisode,
  type MemorySourceWindow,
} from "./memoryFormationSegments";
import {
  resolveMemoryEvidence,
  memoryCandidateCapacity,
  memoryEvidenceProjection,
  type MemoryRecallPipeline,
} from "./memoryRecallPipeline";
import type { MemoryRepository } from "./memoryRepository";
import { fitsInputBudget } from "../providers/inputBudget";
import type { FormationExecution } from "./memoryFormationRepository";

const FormationCursorSchema = Type.Object(
  {
    ordinal: Type.Integer({ minimum: 0 }),
    start: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const ProcessorTransitionSchema = Type.Object(
  {
    fromProcessorVersion: Type.String({ minLength: 1 }),
    toProcessorVersion: Type.String({ minLength: 1 }),
    atCursor: FormationCursorSchema,
    priorAttempt: Type.Integer({ minimum: 1 }),
    priorErrorCode: Type.Optional(Type.String({ minLength: 1 })),
    recordedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const FormationResultSchema = Type.Object(
  {
    processorVersion: Type.Optional(Type.String({ minLength: 1 })),
    processorTransitions: Type.Optional(Type.Array(ProcessorTransitionSchema)),
    retrievalIncompleteReasons: Type.Optional(
      Type.Array(Type.String({ minLength: 1 })),
    ),
    changes: Type.Array(
      Type.Object(
        {
          memoryId: EntityIdSchema,
          revisionId: EntityIdSchema,
          operation: Type.Union([
            Type.Literal("created"),
            Type.Literal("revised"),
            Type.Literal("supported"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const FormationProgressSchema = Type.Object(
  {
    version: Type.Literal("source-windows-v1"),
    segmentBudget: Type.Integer({ minimum: 1 }),
    cursor: FormationCursorSchema,
    processorTransitions: Type.Optional(Type.Array(ProcessorTransitionSchema)),
    changes: FormationResultSchema.properties.changes,
    lastRevisionIds: Type.Array(EntityIdSchema),
    retrievalIncompleteReasons: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type MemoryEpisodeFormationResult = Static<
  typeof FormationResultSchema
> & {
  replayed?: true;
  unavailableChanges?: Static<typeof FormationResultSchema>["changes"];
};

class FormationProposalError extends TypeError {}
class FormationContextError extends RangeError {
  constructor(
    readonly code: "formation_resource_limit" | "formation_input_limit",
    message: string,
  ) {
    super(message);
  }
}

/** A supplied active target was replaced by another current revision after
 * this model request began. It is not a proposal/retention/provider failure. */
type ChangedFormationTarget = Pick<
  MemoryEvidenceItem,
  "memoryId" | "type" | "owner" | "personaId"
>;
class MemoryFormationInputChangedError extends Error {
  constructor(readonly targets: readonly ChangedFormationTarget[]) {
    super(
      "An active Memory revision changed after the formation input was read",
    );
  }
}

class MemoryFormationValidationError extends TypeError {
  constructor(readonly issues: readonly MemoryFormationValidationIssue[]) {
    super(
      issues
        .map(
          ({ unitIndex, field, message }) =>
            `units[${unitIndex === null ? "batch" : String(unitIndex)}].${field}: ${message}`,
        )
        .join("; "),
    );
  }
}

function quoteStart(
  content: string,
  quote: string,
  occurrence: number | undefined,
): number {
  const positions: number[] = [];
  for (
    let start = content.indexOf(quote);
    start >= 0;
    start = content.indexOf(quote, start + 1)
  )
    positions.push(start);
  if (positions.length === 0)
    throw new FormationProposalError(
      "Memory quote is absent from its episode source",
    );
  // An exact unique quote has one possible source span; occurrence is only
  // needed to distinguish repeated quotes in the current source window.
  if (positions.length === 1) return positions[0]!;
  if (occurrence === undefined)
    throw new FormationProposalError(
      "Repeated memory quote needs an explicit occurrence",
    );
  const start = positions[occurrence ?? 0];
  if (start === undefined)
    throw new FormationProposalError(
      "Memory quote occurrence is outside its source",
    );
  return start;
}

function formationComparison(
  existing: readonly MemoryEvidenceItem[],
  entities: readonly { id: string; name: string; kind: string }[],
) {
  return {
    existing: existing
      .map((item) => ({
        ...item,
        // These labels describe a retrieval question, not the memory evidence.
        questionIds: [],
        entityIds: [...item.entityIds].sort(),
        // Source/span order is part of the model's retained-citation indices.
        sourceRefs: [...item.sourceRefs],
        ...(item.relations
          ? {
              relations: [...item.relations].sort(
                (a, b) =>
                  a.revisionId.localeCompare(b.revisionId) ||
                  a.relation.localeCompare(b.relation),
              ),
            }
          : {}),
      }))
      .sort((a, b) => a.revisionId.localeCompare(b.revisionId)),
    entities: [...entities].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Formation uses source-backed revisions, not an automatic user review queue. */
export class MemoryFormationService {
  readonly #running = new Map<string, Promise<MemoryEpisodeFormationResult>>();

  constructor(
    private readonly repository: MemoryRepository,
    private readonly recall: MemoryRecallPipeline,
    private readonly model: MemoryFormationRuntime,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly contextBudget: () => { maxTokens: number },
    private readonly resourceBudget: { maxReadBytes: number },
  ) {}

  enqueue(input: MemoryFormationIntake): MemoryFormationWorkRef {
    return this.repository.formation.enqueue(
      input,
      this.model.version,
      this.clock.now(),
    );
  }

  #availableProcessorVersion(): string | undefined {
    try {
      return this.model.version;
    } catch (error) {
      // A first launch or a removed profile has no processor yet. Keep work
      // unchanged until configuration is ready; storage/unknown errors surface.
      if (
        error instanceof ProviderError &&
        (error.code === "PROVIDER.INVALID_CONFIGURATION" ||
          error.code === "PROVIDER.PROFILE_NOT_FOUND")
      )
        return undefined;
      throw error;
    }
  }

  recoverForCurrentProcessor(): void {
    const version = this.#availableProcessorVersion();
    if (version !== undefined)
      this.repository.formation.retryFailedForProcessor(
        version,
        this.clock.now(),
      );
  }

  recoverProviderFailures(processorVersion: string): number {
    if (processorVersion !== this.#availableProcessorVersion()) return 0;
    return this.repository.formation.retryFailedForProvider(
      processorVersion,
      this.clock.now(),
    );
  }

  receipt(workId: string): MemoryEpisodeFormationResult | undefined {
    const work = this.repository.formation.work(workId);
    return work.status === "complete"
      ? this.#currentReceipt(
          {
            ...parseSchema(FormationResultSchema, work.result),
            processorVersion: work.processorVersion,
          },
          true,
        )
      : undefined;
  }

  form(
    workId: string,
    signal?: AbortSignal,
  ): Promise<MemoryEpisodeFormationResult> {
    const work = this.repository.formation.work(workId);
    const receipt = this.receipt(workId);
    if (receipt) return Promise.resolve(receipt);
    const running = this.#running.get(workId);
    if (running) return running;
    if (work.status === "failed")
      throw new Error(
        "Memory formation previously failed; retry after resolving its cause",
      );
    const processorVersion = this.model.version;
    let progress: Static<typeof FormationProgressSchema>;
    try {
      progress =
        work.result === undefined
          ? {
              version: "source-windows-v1",
              segmentBudget: this.contextBudget().maxTokens,
              cursor: { ordinal: 0, start: 0 },
              changes: [],
              lastRevisionIds: [],
              retrievalIncompleteReasons: [],
            }
          : parseSchema(FormationProgressSchema, work.result);
      const counts = this.repository.formation.sourceCounts(workId);
      if (
        !counts.primary ||
        !Number.isSafeInteger(progress.cursor.ordinal) ||
        !Number.isSafeInteger(progress.cursor.start) ||
        progress.cursor.ordinal > counts.primary + counts.context
      )
        throw new Error("Formation cursor is outside its source references");
      if (progress.cursor.start > 0) {
        let found = false;
        for (const source of this.repository.formation.primarySources(
          workId,
          progress.cursor.ordinal,
        )) {
          found =
            source.ordinal === progress.cursor.ordinal &&
            progress.cursor.start < source.length;
          break;
        }
        if (!found)
          throw new Error("Formation cursor is outside its primary source");
      }
    } catch (cause) {
      this.repository.formation.failPending(
        workId,
        work.errorCode ?? "formation_progress_unsupported",
        this.clock.now(),
      );
      throw new Error(
        "Unsupported Memory formation progress; original sources and result were retained",
        { cause },
      );
    }
    if (work.processorVersion !== processorVersion && work.attempt > 0) {
      progress.processorTransitions = [
        ...(progress.processorTransitions ?? []),
        {
          fromProcessorVersion: work.processorVersion,
          toProcessorVersion: processorVersion,
          atCursor: { ...progress.cursor },
          priorAttempt: work.attempt,
          ...(work.errorCode ? { priorErrorCode: work.errorCode } : {}),
          recordedAt: this.clock.now(),
        },
      ];
    }
    const execution = this.repository.formation.startWork(
      workId,
      processorVersion,
      progress,
      this.clock.now(),
    );
    if (!execution)
      throw new Error(
        "Memory formation is already running; recover interrupted work on startup",
      );
    const promise = this.#form(
      work.episode,
      execution,
      progress,
      signal,
    ).finally(() => this.#running.delete(workId));
    this.#running.set(workId, promise);
    return promise;
  }

  #checkExecution(execution: FormationExecution): void {
    this.repository.formation.assertRunning(execution);
    if (this.model.version !== execution.processorVersion)
      throw new Error(
        "Memory formation processor changed during a source episode",
      );
  }

  async #form(
    episode: MemoryFormationEpisode,
    execution: FormationExecution,
    progress: Static<typeof FormationProgressSchema>,
    signal?: AbortSignal,
  ): Promise<MemoryEpisodeFormationResult> {
    const { workId, processorVersion } = execution;
    const callSignal = signal ?? new AbortController().signal;
    const changedTargets = new Map<string, ChangedFormationTarget>();
    let bound: MemoryFormationModel | undefined;
    for (;;) {
      try {
        bound ??= await this.model.bind(
          {
            expectedProcessorVersion: processorVersion,
            assertInputCurrent: () => {
              callSignal.throwIfAborted();
              this.#checkExecution(execution);
            },
          },
          callSignal,
        );
        callSignal.throwIfAborted();
        this.#checkExecution(execution);
        const sourceEpisode = { ...episode };
        delete sourceEpisode.availableMemoryReferences;
        for await (const segment of segmentMemoryEpisode(
          this.repository.formation,
          { workId, episode: sourceEpisode },
          progress.segmentBudget,
          progress.cursor,
          callSignal,
        )) {
          callSignal.throwIfAborted();
          this.#checkExecution(execution);
          const scope = episode.personaId
            ? { personaId: episode.personaId }
            : { owner: "user" as const };
          const availableRefs = episode.availableMemoryReferences ?? [];
          const rebound = this.#rebindChangedTargets(
            [...changedTargets.values()],
            episode,
          );
          const previous = this.repository.recall.formationRevisionReferences(
            progress.lastRevisionIds,
          );
          const required = this.#readComparison(
            segment.episode.evidenceSourceIds,
            [...rebound, ...availableRefs, ...previous],
            scope,
          );
          const requiredItems = new Map(
            required.items.map((item) => [item.revisionId, item]),
          );
          const capacity = memoryCandidateCapacity(progress.segmentBudget);
          const primaryIds = new Set(segment.episode.evidenceSourceIds);
          const optionalIds = this.repository.recall
            .currentRevisionsForSources(
              segment.episode.sources
                .filter((source) => !primaryIds.has(source.id))
                .map((source) => source.id),
              scope,
              capacity + 1,
              this.clock.now(),
            )
            .filter((id) => !requiredItems.has(id));
          const optional = this.repository.recall.evidence(
            optionalIds.slice(0, capacity),
            this.clock.now(),
            memoryEvidenceProjection(
              progress.segmentBudget,
              Math.min(optionalIds.length, capacity),
            ),
          );
          let retrievalIncompleteReasons = this.recall.incompleteReasons(
            scope,
            episode,
          );
          if (optional.length < optionalIds.length)
            retrievalIncompleteReasons.push(
              "部分同来源记忆未能放入本次形成比较预算",
            );
          for (const ref of required.unavailable)
            retrievalIncompleteReasons.push(
              `实际供给记忆引用已失效：${ref.memoryId}/${ref.revisionId}`,
            );
          const suppliedReferences = availableRefs.filter(
            (ref) => !required.unavailable.includes(ref),
          );
          segment.episode.availableMemoryReferences = suppliedReferences;
          let material: MemoryFormationInput = {
            episode: segment.episode,
            sourceWindows: segment.sourceWindows,
            sourceCoverage: segment.sourceCoverage,
            retrievalIncompleteReasons,
            existing: [...requiredItems.values(), ...optional],
            entities: this.repository.recall.entities([
              ...new Set(
                [...requiredItems.values(), ...optional].flatMap(
                  (item) => item.entityIds,
                ),
              ),
            ]),
          };
          let currentItems = material.existing;
          let currentIds = this.repository.currentRevisionIds(
            currentItems.map((item) => item.revisionId),
          );
          const completedSummaries = new Set<string>();
          const dependencyReferences: MemoryEvidenceReference[] = [];
          let dependencyItems: MemoryEvidenceItem[] = [];
          const checkCurrent = () => {
            callSignal.throwIfAborted();
            this.#checkExecution(execution);
            // Check originals before the dependent summary: a real current
            // replacement must reach the existing typed reread path even when
            // it has simultaneously made that summary stale.
            if (dependencyItems.length)
              this.#checkComparison(
                dependencyItems,
                currentIds,
                scope,
                dependencyReferences,
              );
            this.#checkComparison(currentItems, currentIds, scope, [
              ...suppliedReferences,
              ...dependencyReferences,
            ]);
            if (
              this.repository.learning
                .evidenceSupply(dependencyItems)
                .some(
                  (row) =>
                    row.storedSourceCount !== row.suppliedSourceCount ||
                    row.unavailableSourceCount > 0 ||
                    row.omittedStoredSpanCount !== 0 ||
                    row.unavailableSpanCount > 0,
                )
            )
              throw new Error("Supplied formation dependency material changed");
          };
          const adopt = (input: MemoryFormationInput) => {
            material = input;
            currentItems = material.existing;
            currentIds = this.repository.currentRevisionIds(
              currentItems.map((item) => item.revisionId),
            );
          };
          const allocate = async () => {
            const result = await this.#allocate(
              bound!,
              material,
              new Set(requiredItems.keys()),
              checkCurrent,
              callSignal,
            );
            adopt(result.input);
            // Only summaries admitted by the original allocation introduce
            // parents. The complete adopted group is then necessary: neither
            // its summary nor its originals may silently disappear at final fit.
            const summaries = material.existing.filter(
              (item) =>
                item.derivation && !completedSummaries.has(item.revisionId),
            );
            if (!summaries.length) return result.prepared;
            const references = summaries.flatMap(
              (item) => item.derivation!.dependencies,
            );
            const complete = this.#readComparison(
              [],
              [
                ...suppliedReferences,
                ...[...requiredItems.values(), ...summaries].map((item) => ({
                  memoryId: item.memoryId,
                  revisionId: item.revisionId,
                  use: "history" as const,
                })),
                ...dependencyReferences,
                ...references,
              ],
              scope,
            );
            if (complete.unavailable.length)
              throw new Error(
                "An adopted formation dependency is no longer readable",
              );
            const parentIds = new Set(references.map((ref) => ref.revisionId));
            if (
              complete.items.some(
                (item) => parentIds.has(item.revisionId) && item.derivation,
              )
            )
              throw new TypeError(
                "Formation comparison requires direct non-derived dependencies",
              );
            for (const item of complete.items) {
              const previous = material.existing.find(
                (value) => value.revisionId === item.revisionId,
              );
              requiredItems.set(item.revisionId, {
                ...item,
                questionIds: [
                  ...new Set([
                    ...item.questionIds,
                    ...(previous?.questionIds ?? []),
                  ]),
                ],
              });
            }
            for (const ref of references)
              if (
                !dependencyReferences.some(
                  (previous) =>
                    previous.memoryId === ref.memoryId &&
                    previous.revisionId === ref.revisionId &&
                    previous.use === ref.use,
                )
              )
                dependencyReferences.push(ref);
            const allParentIds = new Set(
              dependencyReferences.map((ref) => ref.revisionId),
            );
            dependencyItems = [...requiredItems.values()].filter((item) =>
              allParentIds.has(item.revisionId),
            );
            for (const item of summaries)
              completedSummaries.add(item.revisionId);
            const existing = [
              ...requiredItems.values(),
              ...material.existing.filter(
                (item) => !requiredItems.has(item.revisionId),
              ),
            ];
            const entities = new Map(
              material.entities.map((entity) => [entity.id, entity]),
            );
            for (const entity of this.repository.recall.entities([
              ...new Set(existing.flatMap((item) => item.entityIds)),
            ]))
              entities.set(entity.id, entity);
            adopt({ ...material, existing, entities: [...entities.values()] });
            checkCurrent();
            const completed = await this.#allocate(
              bound!,
              material,
              new Set(requiredItems.keys()),
              checkCurrent,
              callSignal,
            );
            adopt(completed.input);
            return completed.prepared;
          };
          const generate = async (prepared: PreparedMemoryFormation) => {
            checkCurrent();
            try {
              const batch = await prepared.form(callSignal);
              checkCurrent();
              return parseSchema(MemoryFormationBatchSchema, batch);
            } catch (error) {
              checkCurrent();
              throw error;
            }
          };
          const initialPrepared = await allocate();
          let existing = material.existing;
          let entities = material.entities;
          retrievalIncompleteReasons =
            material.retrievalIncompleteReasons ?? [];
          const initialComparison = formationComparison(existing, entities);
          // Use revision position, not temporal applicability: a valid past
          // record can still be the current revision of an active Memory.
          // Retain actual earlier request baselines through F2/feedback: a
          // revision may change while Recall awaits. A fresh segment retry
          // constructs a fresh set, so already-historical proposals do not loop.
          const inputTargets = new Set(
            this.repository.currentRevisionIds(
              existing.map(({ revisionId }) => revisionId),
            ),
          );
          let batch = await generate(initialPrepared);
          if (batch.units.length) {
            const questions = batch.units.map((unit, position) => {
              if (unit.operation !== "support")
                return {
                  id: `formation-${String(position + 1)}`,
                  text: unit.content,
                };
              const target = existing.find(
                ({ revisionId }) => revisionId === unit.targetRevisionId,
              );
              if (!target)
                throw new TypeError(
                  "Formation support requires a supplied target revision",
                );
              return {
                id: `formation-${String(position + 1)}`,
                text: target.content,
              };
            });
            const evidence = await this.recall.recall(
              {
                purpose: "formation",
                query: "",
                questions,
                ...scope,
                contextBudget: this.contextBudget(),
              },
              signal,
              episode,
              undefined,
              this.repository.recall.resolveEntityNames(
                batch.entities.map(({ name }) => name),
              ),
            );
            retrievalIncompleteReasons = [
              ...new Set([
                ...retrievalIncompleteReasons,
                ...evidence.incompleteReasons,
              ]),
            ];
            // F1 may select an optional target. Its full persisted comparison
            // is necessary before Recall can alter that target's projection.
            checkCurrent();
            const selectedIds = new Set(
              batch.units.flatMap((unit) => [
                ...(unit.targetRevisionId ? [unit.targetRevisionId] : []),
                ...("priorDispositions" in unit
                  ? (unit.priorDispositions ?? []).flatMap((value) =>
                      value.revisionId ? [value.revisionId] : [],
                    )
                  : []),
                ...unit.links.map((link) => link.targetRevisionId),
              ]),
            );
            const promoted = existing.filter(
              (item) =>
                selectedIds.has(item.revisionId) &&
                !requiredItems.has(item.revisionId),
            );
            if (requiredItems.size || promoted.length) {
              const complete = this.#readComparison(
                [],
                [...requiredItems.values(), ...promoted].map((item) => ({
                  memoryId: item.memoryId,
                  revisionId: item.revisionId,
                  use: "history",
                })),
                scope,
              );
              if (complete.unavailable.length)
                throw new Error(
                  "A supplied formation target is no longer readable",
                );
              for (const item of complete.items)
                requiredItems.set(item.revisionId, item);
            }
            const compared = new Map(
              existing.map((item) => [item.revisionId, item]),
            );
            for (const item of evidence.items) {
              const necessary = requiredItems.get(item.revisionId);
              compared.set(
                item.revisionId,
                necessary
                  ? {
                      ...necessary,
                      questionIds: [
                        ...new Set([
                          ...necessary.questionIds,
                          ...item.questionIds,
                        ]),
                      ],
                    }
                  : item,
              );
            }
            for (const [id, item] of requiredItems)
              compared.set(id, {
                ...item,
                questionIds: [
                  ...new Set([
                    ...item.questionIds,
                    ...(compared.get(id)?.questionIds ?? []),
                  ]),
                ],
              });
            material = {
              ...material,
              retrievalIncompleteReasons,
              existing: [...requiredItems.keys()]
                .map((id) => compared.get(id)!)
                .concat(
                  [...compared.values()].filter(
                    (item) => !requiredItems.has(item.revisionId),
                  ),
                ),
              entities: this.repository.recall.entities([
                ...new Set([
                  ...[...compared.values()].flatMap((item) => item.entityIds),
                  ...this.repository.recall.resolveEntityNames(
                    batch.entities.flatMap(({ name, aliases }) => [
                      name,
                      ...aliases,
                    ]),
                  ),
                ]),
              ]),
            };
            currentItems = material.existing;
            // Do not relabel an earlier actual active target as historical
            // after Recall awaited. Preserve the segment's original baseline.
            currentIds = new Set([
              ...inputTargets,
              ...this.repository.currentRevisionIds(
                currentItems.map((item) => item.revisionId),
              ),
            ]);
            const secondPrepared = await allocate();
            existing = material.existing;
            entities = material.entities;
            retrievalIncompleteReasons =
              material.retrievalIncompleteReasons ?? [];
            if (
              !isDeepStrictEqual(
                initialComparison,
                formationComparison(existing, entities),
              )
            ) {
              this.#checkExecution(execution);
              for (const revisionId of this.repository.currentRevisionIds(
                existing.map(({ revisionId }) => revisionId),
              ))
                inputTargets.add(revisionId);
              batch = await generate(secondPrepared);
            }
          }
          signal?.throwIfAborted();
          const prepare = () =>
            this.#prepare(
              material.episode,
              batch,
              existing,
              entities,
              material.sourceWindows!,
              material.episode.evidenceSourceIds,
              inputTargets,
            );
          let apply: () => MemoryEpisodeFormationResult;
          try {
            apply = prepare();
          } catch (error) {
            if (!(error instanceof MemoryFormationValidationError)) throw error;
            this.#checkExecution(execution);
            for (const revisionId of this.repository.currentRevisionIds(
              existing.map(({ revisionId }) => revisionId),
            ))
              inputTargets.add(revisionId);
            const feedback = bound.prepare({
              ...material,
              validationFeedback: { proposal: batch, issues: error.issues },
            });
            checkCurrent();
            let measurement;
            try {
              measurement = await feedback.measureInput(callSignal);
            } catch (cause) {
              checkCurrent();
              throw cause;
            }
            checkCurrent();
            if (!fitsInputBudget(measurement.measurement, measurement.budget))
              throw new FormationContextError(
                "formation_input_limit",
                "Complete formation validation feedback exceeds the model input budget",
              );
            batch = await generate(feedback);
            signal?.throwIfAborted();
            this.#checkExecution(execution);
            apply = prepare();
          }
          this.repository.formation.transaction(() => {
            this.repository.formation.assertRunning(execution);
            const result = apply();
            progress.retrievalIncompleteReasons = [
              ...new Set([
                ...progress.retrievalIncompleteReasons,
                ...retrievalIncompleteReasons,
              ]),
            ];
            progress.changes.push(...result.changes);
            progress.lastRevisionIds = result.changes.map(
              ({ revisionId }) => revisionId,
            );
            progress.cursor = segment.nextCursor;
            this.repository.formation.saveProgress(
              execution,
              progress,
              this.clock.now(),
            );
          });
          changedTargets.clear();
        }
        const result = {
          changes: progress.changes,
          processorVersion,
          ...(progress.processorTransitions
            ? { processorTransitions: progress.processorTransitions }
            : {}),
          retrievalIncompleteReasons: progress.retrievalIncompleteReasons,
        };
        this.repository.formation.finish(execution, result, this.clock.now());
        return this.#currentReceipt(result);
      } catch (error) {
        if (
          error instanceof MemoryFormationInputChangedError &&
          !signal?.aborted
        ) {
          for (const target of error.targets)
            changedTargets.set(target.memoryId, target);
          // Only an observed new revision reaches here. Do not reset progress,
          // re-enqueue this work, or retain the abandoned comparison snapshot.
          continue;
        }
        if (signal?.aborted)
          this.repository.formation.suspend(execution, this.clock.now());
        else
          this.repository.formation.fail(
            execution,
            error instanceof ProviderError ||
              error instanceof FormationContextError
              ? error.code
              : "formation_failed",
            this.clock.now(),
          );
        throw error;
      }
    }
  }

  #rebindChangedTargets(
    targets: readonly ChangedFormationTarget[],
    episode: MemoryFormationEpisode,
  ): MemoryEvidenceReference[] {
    if (!targets.length) return [];
    const scope = episode.personaId
      ? { personaId: episode.personaId }
      : { owner: "user" as const };
    const current = this.repository.recall.formationCurrentTargets(
      targets.map((target) => target.memoryId),
      scope,
      this.clock.now(),
    );
    const byMemory = new Map(current.map((item) => [item.memoryId, item]));
    const references = targets.map((target) => {
      const item = byMemory.get(target.memoryId);
      if (
        !item ||
        item.type !== target.type ||
        item.owner !== (target.owner ?? "user") ||
        (item.personaId ?? undefined) !== target.personaId
      )
        throw new Error(
          "A changed formation target has incompatible identity or ownership",
        );
      return {
        memoryId: item.memoryId,
        revisionId: item.revisionId,
        use: "history" as const,
      };
    });
    if (
      this.repository.recall.validateEvidenceReferences(
        { personaId: episode.personaId ?? "", references, usage: "grounding" },
        this.clock.now(),
      ).length
    )
      throw new Error("A changed formation target is no longer readable");
    return references;
  }

  #checkComparison(
    items: readonly MemoryEvidenceItem[],
    activeIds: ReadonlySet<string>,
    scope: Pick<RecallPlan, "owner" | "personaId">,
    suppliedReferences: readonly MemoryEvidenceReference[],
  ) {
    const active = items.filter((item) => activeIds.has(item.revisionId));
    const now = this.clock.now();
    const current = this.repository.recall.formationCurrentTargets(
      active.map((item) => item.memoryId),
      scope,
      now,
    );
    const byMemory = new Map(current.map((item) => [item.memoryId, item]));
    const changed: ChangedFormationTarget[] = [];
    for (const item of active) {
      const actual = byMemory.get(item.memoryId);
      if (
        !actual ||
        actual.type !== item.type ||
        actual.owner !== (item.owner ?? "user") ||
        (actual.personaId ?? undefined) !== item.personaId
      )
        throw new Error("Memory revision changed while formation was running");
      if (actual.revisionId !== item.revisionId) changed.push(item);
    }
    if (changed.length) throw new MemoryFormationInputChangedError(changed);
    if (
      this.repository.recall.validateEvidenceReferences(
        {
          personaId: scope.personaId ?? "",
          references: [
            ...items.map((item) => ({
              memoryId: item.memoryId,
              revisionId: item.revisionId,
              use: "history" as const,
            })),
            ...suppliedReferences,
          ],
          expectedHistory: items,
        },
        now,
      ).length
    )
      throw new Error("Supplied formation comparison evidence changed");
  }

  #readComparison(
    primarySourceIds: readonly string[],
    references: readonly MemoryEvidenceReference[],
    scope: Pick<RecallPlan, "owner" | "personaId">,
  ) {
    return this.repository.recall.transaction(() => {
      const now = this.clock.now();
      const discovered =
        this.repository.recall.formationSourceComparisonReferences(
          primarySourceIds,
          scope,
          this.resourceBudget,
          now,
        );
      const fail = (cost: MemoryEvidenceReadCost): never => {
        throw new FormationContextError(
          "formation_resource_limit",
          `Complete formation comparison exceeds raw resource budget (${String(cost.rawValueBytes)} bytes, ${String(cost.rowCount)} rows)`,
        );
      };
      if (discovered.status === "resource_limit")
        return fail(discovered.readCost);
      const unavailable = this.repository.recall.validateEvidenceReferences(
        { personaId: scope.personaId ?? "", references },
        now,
      );
      const refs = [
        ...discovered.references,
        ...references.filter((ref) => !unavailable.includes(ref)),
      ];
      const ids = [...new Set(refs.map((ref) => ref.revisionId))];
      const entityCost =
        this.repository.recall.formationComparisonEntityReadCost(ids);
      const fixedCost = {
        rawValueBytes:
          discovered.readCost.rawValueBytes + entityCost.rawValueBytes,
        rowCount: discovered.readCost.rowCount + entityCost.rowCount,
      };
      const available =
        this.resourceBudget.maxReadBytes - fixedCost.rawValueBytes;
      if (available < 1) return fail(fixedCost);
      const resolved = resolveMemoryEvidence(
        this.repository.recall,
        {
          personaId: scope.personaId ?? "",
          references: refs,
          resourceBudget: { maxReadBytes: available },
        },
        now,
      );
      if (resolved.status === "unavailable")
        throw new Error(
          "A necessary formation comparison target is no longer available",
        );
      const readCost = {
        rawValueBytes:
          fixedCost.rawValueBytes + resolved.readCost.rawValueBytes,
        rowCount: fixedCost.rowCount + resolved.readCost.rowCount,
      };
      if (resolved.status === "resource_limit") return fail(readCost);
      return { items: resolved.items, unavailable, readCost };
    });
  }

  async #allocate(
    model: MemoryFormationModel,
    input: MemoryFormationInput,
    required: ReadonlySet<string>,
    check: () => void,
    signal: AbortSignal,
  ) {
    const mandatory = input.existing.filter((item) =>
      required.has(item.revisionId),
    );
    const optional = input.existing.filter(
      (item) => !required.has(item.revisionId),
    );
    const primary = new Set(input.episode.evidenceSourceIds);
    const context = input.episode.sources.filter(
      (source) => !primary.has(source.id),
    );
    const candidate = (memories: number, contexts: number) => {
      const retained = new Set(
        context.slice(0, contexts).map((source) => source.id),
      );
      const sources = input.episode.sources.filter(
        (source) => primary.has(source.id) || retained.has(source.id),
      );
      const included = new Set(sources.map((source) => source.id));
      const windows = input.sourceWindows!.filter((window) =>
        included.has(window.sourceId),
      );
      const existing = [...mandatory, ...optional.slice(0, memories)];
      const ids = new Set(existing.flatMap((item) => item.entityIds));
      // Resolved proposal entities are optional comparison material too, but
      // keeping their small identity rows preserves the existing F2 semantics.
      const extra = new Set(
        input.entities
          .filter(
            (entity) =>
              !input.existing.some((item) =>
                item.entityIds.includes(entity.id),
              ),
          )
          .map((entity) => entity.id),
      );
      const coverage = input.sourceCoverage!;
      const value: MemoryFormationInput = {
        ...input,
        episode: { ...input.episode, sources },
        sourceWindows: windows,
        sourceCoverage: {
          ...coverage,
          includedContextSourceCount: contexts,
          omittedContextSourceCount: coverage.contextSourceCount - contexts,
          truncatedContextSourceCount: windows.filter(
            (window) =>
              retained.has(window.sourceId) &&
              (window.start > 0 || window.end < window.totalLength),
          ).length,
        },
        existing,
        entities: input.entities.filter(
          (entity) => ids.has(entity.id) || extra.has(entity.id),
        ),
        retrievalIncompleteReasons: [
          ...new Set([
            ...(input.retrievalIncompleteReasons ?? []),
            ...(memories < optional.length
              ? ["部分可选记忆未能放入本次完整形成请求"]
              : []),
            ...(contexts < context.length
              ? ["部分辅助原文未能放入本次完整形成请求"]
              : []),
          ]),
        ],
      };
      return { input: value, prepared: model.prepare(value) };
    };
    const measure = async (value: ReturnType<typeof candidate>) => {
      check();
      try {
        const result = await value.prepared.measureInput(signal);
        check();
        return fitsInputBudget(result.measurement, result.budget);
      } catch (error) {
        check();
        throw error;
      }
    };
    const full = candidate(optional.length, context.length);
    if (await measure(full)) return full;
    // Search a prefix locally, then measure that exact final request. A count
    // disagreement halves the remaining prefix; never one network call per row.
    const fitPrefix = async (
      length: number,
      build: (n: number) => ReturnType<typeof candidate>,
    ) => {
      const base = build(0);
      if (!(await measure(base))) return undefined;
      let low = 0,
        high = length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const estimate = build(middle).prepared.estimateInput();
        if (fitsInputBudget(estimate.measurement, estimate.budget))
          low = middle;
        else high = middle - 1;
      }
      while (low > 0) {
        const value = build(low);
        if (await measure(value)) return value;
        low = Math.floor(low / 2);
      }
      return base;
    };
    const memories = await fitPrefix(optional.length, (n) =>
      candidate(n, context.length),
    );
    if (memories) return memories;
    const contexts = await fitPrefix(context.length, (n) => candidate(0, n));
    if (contexts) return contexts;
    throw new FormationContextError(
      "formation_input_limit",
      "Necessary source and complete formation comparison exceed the model input budget",
    );
  }

  #currentReceipt(
    result: Static<typeof FormationResultSchema>,
    replayed = false,
  ): MemoryEpisodeFormationResult {
    // The durable receipt describes what was committed then. A later manual
    // edit, archive or deletion must not be reported as a currently saved fact.
    // Keep the original receipt for idempotency; never re-form it on replay.
    const current = this.repository.currentRevisionIds(
      result.changes.map(({ revisionId }) => revisionId),
    );
    const unavailableChanges = result.changes.filter(
      ({ revisionId }) => !current.has(revisionId),
    );
    return {
      ...result,
      changes: result.changes.filter(({ revisionId }) =>
        current.has(revisionId),
      ),
      ...(replayed ? { replayed: true } : {}),
      ...(unavailableChanges.length ? { unavailableChanges } : {}),
    };
  }

  #prepare(
    episode: MemoryFormationMaterial,
    batch: MemoryFormationBatch,
    existing: MemoryEvidenceItem[],
    existingEntities: { id: string; name: string; kind: string }[],
    sourceWindows: readonly MemorySourceWindow[],
    evidenceSourceIds: readonly string[],
    inputTargets: ReadonlySet<string>,
  ): () => MemoryEpisodeFormationResult {
    if (JSON.stringify(redactBoundaryValue(batch)) !== JSON.stringify(batch))
      throw new TypeError("Formation metadata contains a detected secret");
    const sources = new Map(
      episode.sources.map((source) => [source.id, source]),
    );
    const targets = new Map(existing.map((item) => [item.revisionId, item]));
    const allowedEntities = new Set(existingEntities.map(({ id }) => id));
    const keys = new Map<string, string>();
    for (const entity of batch.entities) {
      if (keys.has(entity.key))
        throw new MemoryFormationValidationError([
          {
            unitIndex: null,
            field: "entities.key",
            message: "Formation entity keys must be unique",
          },
        ]);
      if (entity.existingId && !allowedEntities.has(entity.existingId))
        throw new MemoryFormationValidationError([
          {
            unitIndex: null,
            field: "entities.existingId",
            message: "Formation referred to an unavailable entity",
          },
        ]);
      keys.set(entity.key, entity.existingId ?? this.ids.generate());
    }
    const resolveEntity = (key: string): string => {
      const id = keys.get(key);
      if (!id)
        throw new FormationProposalError(
          "Formation entity reference has no declaration",
        );
      return id;
    };
    const assertPrimaryBasis = (
      semantics: MemoryRevisionSemantics | undefined,
      effectiveType: MemoryEvidenceItem["type"],
      primaryCitations: {
        source: MemoryFormationMaterial["sources"][number];
      }[],
      retainsObservedCommitment = false,
      createsContribution = false,
    ) => {
      if (!semantics) {
        if (!primaryCitations.some(({ source }) => source.speaker === "user"))
          throw new FormationProposalError(
            "An untyped manual record requires an actual user source for support",
          );
        return;
      }
      if (
        semantics.basis === "explicit_user_statement" &&
        !primaryCitations.some(({ source }) => source.speaker === "user")
      )
        throw new FormationProposalError(
          "Explicit user memory requires an actual user source",
        );
      // A persisted reply directly establishes the act of making or withdrawing
      // this character's promise. It does not establish that a promised action
      // happened; that still needs independent execution/environment evidence.
      const observedOwnCommitment =
        effectiveType === "commitment" &&
        semantics.kind === "commitment" &&
        semantics.owner === "character" &&
        semantics.personaId === episode.personaId &&
        (semantics.commitmentState === "proposed" ||
          semantics.commitmentState === "active" ||
          semantics.commitmentState === "cancelled") &&
        primaryCitations.some(
          ({ source }) =>
            source.speaker === "assistant" &&
            (source.type === "chat" || source.type === "voice"),
        );
      // This predicate records that concrete content was delivered in a reply.
      // Its text is not evidence that draft events or suggested actions happened.
      const observedOwnContribution =
        createsContribution &&
        semantics.predicate === "delivered_conversation" &&
        effectiveType === "event" &&
        semantics.kind === "episode" &&
        semantics.owner === "character" &&
        semantics.personaId === episode.personaId &&
        semantics.basis === "direct_observation" &&
        primaryCitations.some(
          ({ source }) =>
            source.speaker === "assistant" &&
            (source.type === "chat" || source.type === "voice"),
        );
      if (
        createsContribution &&
        semantics.predicate === "delivered_conversation" &&
        !observedOwnContribution
      )
        throw new FormationProposalError(
          "A delivered conversation requires this character's event/episode and an actual primary Chat or Voice reply",
        );
      if (
        semantics.basis === "direct_observation" &&
        !observedOwnCommitment &&
        !observedOwnContribution &&
        !retainsObservedCommitment &&
        !primaryCitations.some(
          ({ source }) =>
            source.speaker === "tool" || source.speaker === "environment",
        )
      )
        throw new FormationProposalError(
          "Direct observation requires tool or environment evidence, except this character's actual commitment or delivered conversation",
        );
      if (
        semantics.owner === "character" &&
        semantics.kind === "experience" &&
        (semantics.basis !== "direct_observation" ||
          !primaryCitations.some(
            ({ source }) => source.speaker === "tool" && source.type === "tool",
          ))
      )
        throw new FormationProposalError(
          "Completed character experience requires an actual tool source",
        );
      if (
        semantics.owner === "user" &&
        (effectiveType === "preference" || effectiveType === "profile") &&
        semantics.basis === "direct_observation"
      )
        throw new FormationProposalError(
          "Observed activity alone cannot establish user preferences or profile facts",
        );
    };
    let field = "targetRevisionId";
    const prepareUnit = (unit: MemoryFormationBatch["units"][number]) => {
      field = "targetRevisionId";
      const target = unit.targetRevisionId
        ? targets.get(unit.targetRevisionId)
        : undefined;
      if (
        (unit.operation !== "create" && !target) ||
        (unit.operation === "create" && unit.targetRevisionId)
      )
        throw new FormationProposalError(
          "Formation update requires a supplied target revision",
        );
      if (target && !inputTargets.has(target.revisionId))
        throw new FormationProposalError(
          "Formation update requires a target that was an active current revision in this model input",
        );
      field = "citations";
      const citations = unit.citations.map((citation) => {
        const source = sources.get(citation.sourceId);
        if (!source)
          throw new FormationProposalError(
            "Formation cited a source outside the current segment",
          );
        const window = sourceWindows.find(
          ({ sourceId }) => sourceId === source.id,
        );
        if (!window)
          throw new FormationProposalError(
            "Formation cited a source outside the current segment",
          );
        const start =
          window.start +
          quoteStart(source.content, citation.quote, citation.occurrence);
        return {
          source,
          start,
          end: start + citation.quote.length,
          quote: citation.quote,
        };
      });
      const primaryCitations = citations.filter(({ source }) =>
        evidenceSourceIds.includes(source.id),
      );
      if (!primaryCitations.length)
        throw new FormationProposalError(
          "Formation requires a supporting citation from this segment's primary sources",
        );

      if (unit.operation === "support") {
        if (
          target!.owner === "character" &&
          target!.personaId !== episode.personaId
        )
          throw new FormationProposalError(
            "Formation support is outside the current persona scope",
          );
        field = "citations.basis";
        assertPrimaryBasis(target!.semantics, target!.type, primaryCitations);
        field = "links";
        for (const link of unit.links)
          if (!targets.has(link.targetRevisionId))
            throw new FormationProposalError(
              "Formation linked an unavailable revision",
            );
        return {
          unit,
          citations,
          target,
          type: target!.type,
          semantics: undefined,
          entityIds: target!.entityIds,
          priorDispositions: [],
          retainedCitations: [],
        };
      }
      if (redactText(unit.content) !== unit.content)
        throw new TypeError("Formation content contains a detected secret");
      field = "semantics";
      const effectiveType = target?.type ?? unit.type;
      const semantics: MemoryRevisionSemantics = parseSchema(
        MemoryRevisionSemanticsSchema,
        {
          ...unit.semantics,
          ...(unit.semantics.subjectEntityId
            ? { subjectEntityId: resolveEntity(unit.semantics.subjectEntityId) }
            : {}),
          ...(unit.semantics.objectEntityId
            ? { objectEntityId: resolveEntity(unit.semantics.objectEntityId) }
            : {}),
        },
      );
      if (
        (semantics.owner === "character" &&
          (!episode.personaId || semantics.personaId !== episode.personaId)) ||
        (semantics.owner === "user" && semantics.personaId !== undefined)
      )
        throw new FormationProposalError(
          "Formation memory is outside the current user or persona scope",
        );
      if (CONSOLIDATION_KEYS.some((key) => key in semantics.qualifiers))
        throw new FormationProposalError(
          "Formation cannot author host-owned consolidation provenance",
        );
      if (semantics.kind === "reflection" && semantics.basis !== "inference")
        throw new FormationProposalError(
          "Reflection must remain an interpretation",
        );
      if (semantics.commitmentState && semantics.kind !== "commitment")
        throw new FormationProposalError(
          "Only commitment memories have commitment state",
        );
      if (
        semantics.occurredFrom &&
        semantics.occurredTo &&
        semantics.occurredTo < semantics.occurredFrom
      )
        throw new FormationProposalError("Occurrence time range is reversed");
      if (
        semantics.validFrom &&
        semantics.validTo &&
        semantics.validTo <= semantics.validFrom
      )
        throw new FormationProposalError("Validity range is empty or reversed");
      if (unit.operation !== "revise" && unit.retainedCitations !== undefined)
        throw new FormationProposalError(
          "Only revise can retain prior source citations",
        );
      if (unit.operation === "revise" && !unit.retainedCitations)
        throw new FormationProposalError(
          "Formation revise must select retained citations",
        );
      field = "retainedCitations";
      const retainedCitations = (unit.retainedCitations ?? []).map(
        ({ sourceIndex, spanIndex, quote, occurrence }) => {
          const source = target!.sourceRefs[sourceIndex];
          const span = source?.spans?.[spanIndex];
          if (!source || !span)
            throw new FormationProposalError(
              "Retained citation requires an actually supplied target source span",
            );
          const start = span.start + quoteStart(span.quote, quote, occurrence);
          return { source, span, start, end: start + quote.length, quote };
        },
      );
      field = "semantics.basis";
      // A user can clarify the date/conditions of the same prior speech act.
      // Its selected original quote is not new primary evidence or support.
      // Keep identity, occurrence and state fixed; new promises, withdrawal
      // and fulfillment still pass the original primary-source requirements.
      const retainsObservedCommitment =
        unit.operation === "revise" &&
        effectiveType === "commitment" &&
        semantics.kind === "commitment" &&
        semantics.owner === "character" &&
        semantics.personaId === episode.personaId &&
        semantics.basis === "direct_observation" &&
        (semantics.commitmentState === "proposed" ||
          semantics.commitmentState === "active" ||
          semantics.commitmentState === "cancelled") &&
        target?.semantics !== undefined &&
        (
          [
            "kind",
            "owner",
            "personaId",
            "basis",
            "subjectEntityId",
            "predicate",
            "objectEntityId",
            "objectValue",
            "occurredFrom",
            "occurredTo",
            "timePrecision",
            "commitmentState",
          ] as const
        ).every((key) => target.semantics![key] === semantics[key]) &&
        primaryCitations.some(({ source }) => source.speaker === "user") &&
        retainedCitations.some(({ source }) => {
          const metadata = this.repository.formation.getSourceMetadata(
            source.sourceId,
          );
          return (
            metadata?.speaker === "assistant" &&
            (metadata.type === "chat" || metadata.type === "voice")
          );
        });
      assertPrimaryBasis(
        semantics,
        effectiveType,
        primaryCitations,
        retainsObservedCommitment,
        unit.operation === "create",
      );
      field = "semantics";
      if (
        unit.operation === "create" &&
        existing.some(
          (item) =>
            item.current &&
            item.content === unit.content &&
            isDeepStrictEqual(item.semantics, semantics) &&
            isDeepStrictEqual(
              [...item.entityIds].sort(),
              [...unit.entityKeys.map(resolveEntity)].sort(),
            ),
        )
      )
        throw new FormationProposalError(
          "An identical supplied memory requires support instead of duplicate creation",
        );
      if (
        unit.operation === "revise" &&
        target?.semantics?.qualifiers["authoring"] === "user_edit" &&
        semantics.basis !== "explicit_user_statement"
      )
        throw new FormationProposalError(
          "An observation or interpretation cannot overwrite a manual user correction",
        );
      if (
        unit.operation === "revise" &&
        (target?.basis === "explicit_user_statement" ||
          target?.basis === "direct_observation") &&
        semantics.basis === "inference"
      )
        throw new FormationProposalError(
          "An interpretation cannot overwrite a user statement or direct observation",
        );
      if (
        target &&
        (target.owner !== semantics.owner ||
          target.personaId !== semantics.personaId)
      ) {
        const fromCurrentCharacter =
          target.owner === "character" &&
          target.personaId === episode.personaId &&
          semantics.owner === "user";
        const toCurrentCharacter =
          target.owner === "user" &&
          target.personaId === undefined &&
          semantics.owner === "character" &&
          semantics.personaId === episode.personaId;
        if (
          unit.operation !== "revise" ||
          unit.type !== "preference" ||
          target.type !== "preference" ||
          !episode.personaId ||
          !target.semantics ||
          !target.semantics.subjectEntityId ||
          target.semantics.subjectEntityId !== semantics.subjectEntityId ||
          !(fromCurrentCharacter || toCurrentCharacter) ||
          semantics.basis !== "explicit_user_statement" ||
          !primaryCitations.some(
            ({ source }) =>
              source.speaker === "user" &&
              !this.repository.hasMemorySource(target.memoryId, source.id),
          )
        )
          throw new FormationProposalError(
            "Formation scope changes require the same known preference subject and a new primary user statement for the current persona",
          );
      }
      field = "priorDispositions";
      const priorDispositions = new Map<string, MemoryPriorDisposition>();
      if (unit.operation !== "revise" && unit.priorDispositions)
        throw new FormationProposalError(
          "Only revise can author historical dispositions",
        );
      if (unit.operation === "revise") {
        if (!unit.priorDispositions?.length)
          throw new FormationProposalError(
            "Formation revise requires explicit prior dispositions",
          );
        for (const disposition of unit.priorDispositions) {
          // The disposition may select a precise clause of this unit's actual
          // primary citation. Compare original UTF-16 ranges, not quote length.
          // Repeated clauses must identify one position within those ranges.
          const matches = new Map<string, (typeof primaryCitations)[number]>();
          for (const citation of primaryCitations) {
            if (citation.source.id !== disposition.sourceId) continue;
            const window = sourceWindows.find(
              ({ sourceId }) => sourceId === citation.source.id,
            )!;
            for (
              let relative = citation.quote.indexOf(disposition.quote);
              relative >= 0;
              relative = citation.quote.indexOf(disposition.quote, relative + 1)
            ) {
              const start = citation.start + relative;
              const end = start + disposition.quote.length;
              if (
                start >= citation.start &&
                end <= citation.end &&
                citation.source.content.slice(
                  start - window.start,
                  end - window.start,
                ) === disposition.quote
              )
                matches.set(`${String(start)}:${String(end)}`, citation);
            }
          }
          const citation =
            matches.size === 1 ? [...matches.values()][0] : undefined;
          if (
            !citation ||
            ((disposition.scope === "all_prior" ||
              disposition.disposition === "corrected") &&
              citation.source.speaker !== "user")
          )
            throw new FormationProposalError(
              "Historical disposition requires exact primary evidence; correction or all-prior scope requires a user statement",
            );
          if (
            (disposition.scope === "all_prior" && disposition.revisionId) ||
            (disposition.scope === "revision" &&
              (!disposition.revisionId ||
                targets.get(disposition.revisionId)?.memoryId !==
                  target!.memoryId))
          )
            throw new FormationProposalError(
              "Historical disposition must identify this Memory or a supplied exact revision of it",
            );
          const revisionIds =
            disposition.scope === "all_prior"
              ? this.repository.revisionIdsFor(target!.memoryId)
              : [disposition.revisionId!];
          for (const revisionId of revisionIds) {
            const previous = priorDispositions.get(revisionId);
            if (previous && previous.disposition !== disposition.disposition)
              throw new FormationProposalError(
                "Historical dispositions conflict for one revision",
              );
            priorDispositions.set(revisionId, {
              revisionId,
              disposition: disposition.disposition,
            });
          }
        }
        if (!priorDispositions.has(target!.revisionId))
          throw new FormationProposalError(
            "Historical dispositions must include the immediate predecessor",
          );
      }
      field = "links";
      for (const link of unit.links)
        if (!targets.has(link.targetRevisionId))
          throw new FormationProposalError(
            "Formation linked an unavailable revision",
          );
      field = "entityKeys";
      const entityIds = unit.entityKeys.map(resolveEntity);
      return {
        unit,
        type: effectiveType,
        semantics,
        citations,
        retainedCitations,
        target,
        entityIds,
        priorDispositions: [...priorDispositions.values()],
      };
    };
    const prepared: ReturnType<typeof prepareUnit>[] = [];
    const issues: MemoryFormationValidationIssue[] = [];
    for (const [unitIndex, unit] of batch.units.entries()) {
      try {
        prepared.push(prepareUnit(unit));
      } catch (error) {
        if (!(error instanceof FormationProposalError)) throw error;
        issues.push({ unitIndex, field, message: error.message });
      }
    }
    const targetUnits = new Map<
      string,
      {
        unitIndex: number;
        operation: MemoryFormationBatch["units"][number]["operation"];
      }[]
    >();
    for (const [unitIndex, unit] of batch.units.entries()) {
      const target = unit.targetRevisionId
        ? targets.get(unit.targetRevisionId)
        : undefined;
      if (!target) continue;
      const units = targetUnits.get(target.memoryId) ?? [];
      units.push({ unitIndex, operation: unit.operation });
      targetUnits.set(target.memoryId, units);
    }
    for (const units of targetUnits.values()) {
      if (
        units.length < 2 ||
        !units.some(({ operation }) => operation === "revise")
      )
        continue;
      for (const { unitIndex } of units)
        issues.push({
          unitIndex,
          field: "targetRevisionId",
          message:
            "A revise must be the only update to its Memory in one proposal; combine its citations and changes in one unit",
        });
    }
    if (issues.length) throw new MemoryFormationValidationError(issues);

    return () =>
      this.repository.recall.transaction(() => {
        const now = this.clock.now();
        const changed = new Map<string, ChangedFormationTarget>();
        // Check every target before any write, so this batch cannot create its
        // own revision race. Deleted/archived/invalid targets remain failures.
        for (const { target, type, retainedCitations } of prepared) {
          if (target) {
            const detail = this.repository.requireDetail(target.memoryId);
            if (detail.memory.deletedAt || detail.memory.status !== "active")
              throw new Error(
                "Memory revision changed while formation was running",
              );
            if (detail.memory.type !== type)
              throw new TypeError(
                "Formation cannot change a memory's existing type or slot",
              );
            if (detail.memory.currentRevisionId !== target.revisionId)
              changed.set(target.memoryId, {
                memoryId: target.memoryId,
                type: target.type,
                ...(target.owner ? { owner: target.owner } : {}),
                ...(target.personaId ? { personaId: target.personaId } : {}),
              });
          }
          for (const { source, span } of retainedCitations)
            if (
              !this.repository.recall.hasSpan(
                target!.revisionId,
                source.sourceId,
                span.start,
                span.end,
                span.quote,
              )
            )
              throw new Error(
                "Retained citation source span changed while formation was running",
              );
        }
        if (changed.size)
          throw new MemoryFormationInputChangedError([...changed.values()]);
        for (const entity of batch.entities)
          this.repository.recall.putEntity(
            {
              id: keys.get(entity.key)!,
              name: redactText(entity.name),
              kind: entity.kind,
              aliases: entity.aliases.map(redactText),
            },
            now,
          );
        const changes: MemoryEpisodeFormationResult["changes"] = [];
        for (const {
          unit,
          semantics,
          citations,
          retainedCitations,
          target,
          entityIds,
          priorDispositions,
        } of prepared) {
          const sourceRecords: MemorySource[] = [
            ...new Map(
              [
                ...citations.map(({ source }) => source.id),
                ...retainedCitations.map(({ source }) => source.sourceId),
              ].map((sourceId) => [
                sourceId,
                this.repository.formation.sourceProvenance(sourceId),
              ]),
            ).values(),
          ];
          let memoryId: string;
          let revisionId: string;
          if (unit.operation === "support") {
            memoryId = target!.memoryId;
            revisionId = target!.revisionId;
            this.repository.attachEvidence(revisionId, sourceRecords);
          } else if (unit.operation === "revise") {
            if (!semantics)
              throw new TypeError("Formation revise requires semantics");
            memoryId = target!.memoryId;
            revisionId = this.ids.generate();
            this.repository.revise({
              predecessorRevisionId: target!.revisionId,
              priorDispositions,
              memoryId,
              revisionId,
              content: unit.content,
              sources: sourceRecords,
              reason: "根据新的原始证据修订",
              now,
              ...(semantics.validFrom
                ? { validFrom: semantics.validFrom }
                : {}),
              ...(semantics.validTo ? { validTo: semantics.validTo } : {}),
            });
            this.repository.recall.putSemantics(
              revisionId,
              semantics,
              entityIds,
            );
          } else {
            if (!semantics)
              throw new TypeError("Formation create requires semantics");
            memoryId = this.ids.generate();
            revisionId = this.ids.generate();
            this.repository.create({
              memoryId,
              revisionId,
              content: unit.content,
              type: unit.type,
              sources: sourceRecords,
              now,
              reason: "从原始情境形成",
              confidence: semantics.basis === "inference" ? 0.5 : 1,
              importance: 0.5,
              ...(semantics.validFrom
                ? { validFrom: semantics.validFrom }
                : {}),
              ...(semantics.validTo ? { validTo: semantics.validTo } : {}),
            });
            this.repository.recall.putSemantics(
              revisionId,
              semantics,
              entityIds,
            );
          }
          for (const citation of citations)
            this.repository.recall.addSpan(
              revisionId,
              citation.source.id,
              citation.start,
              citation.end,
              citation.quote,
            );
          for (const citation of retainedCitations)
            this.repository.recall.addSpan(
              revisionId,
              citation.source.sourceId,
              citation.start,
              citation.end,
              citation.quote,
            );
          for (const link of unit.links)
            this.repository.recall.link(
              revisionId,
              link.targetRevisionId,
              link.relation,
              sourceRecords[0]!.id,
            );
          this.repository.learning.enqueue(memoryId, now);
          changes.push({
            memoryId,
            revisionId,
            operation:
              unit.operation === "create"
                ? "created"
                : unit.operation === "revise"
                  ? "revised"
                  : "supported",
          });
        }
        const result = { changes };
        return result;
      });
  }
}
