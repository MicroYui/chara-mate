import { Type, type Static } from "@sinclair/typebox";
import type {
  EvidencePack,
  MemoryEvidenceItem,
  MemoryEvidenceReference,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { parseSchema } from "../../shared/schemas/validation";
import { redactBoundaryValue } from "../../shared/pure/redaction";
import { NonBlankStringSchema } from "../../shared/schemas/primitives";
import {
  collectModelTurn,
  type ModelProvider,
  type ModelRequest,
  type ModelContextLimits,
  type CollectedModelTurn,
  type ModelUsage,
} from "../agent/modelProvider";
import {
  restoreStructuredOutput,
  structuredOutputWireSchema,
} from "../agent/structuredOutput";
import {
  estimateInputBudget,
  fitsInputBudget,
  modelInputBudget,
  type InputBudgetEstimate,
} from "../providers/inputBudget";
import {
  ProviderError,
  type ProviderRequestIdentity,
} from "../providers/providerError";
import {
  MEMORY_CONSOLIDATION_PROCESSOR_VERSION,
  MEMORY_CONSOLIDATION_VERSION,
  type MemoryConsolidationWork,
} from "./memoryLearningRepository";
import {
  memoryEvidenceProjection,
  resolveMemoryEvidence,
  type MemoryRecallPipeline,
} from "./memoryRecallPipeline";
import type { MemoryRepository } from "./memoryRepository";

const closed = { additionalProperties: false } as const;
export const MemoryConsolidationOutputSchema = Type.Object(
  {
    disposition: Type.Union([
      Type.Literal("consolidate"),
      Type.Literal("retain_originals"),
    ]),
    reason: NonBlankStringSchema,
    content: Type.Optional(NonBlankStringSchema),
    account: Type.Optional(
      Type.Union([
        Type.Literal("episode_summary"),
        Type.Literal("bounded_pattern"),
      ]),
    ),
    dependencies: Type.Array(NonBlankStringSchema),
    citations: Type.Array(
      Type.Object(
        {
          revisionId: NonBlankStringSchema,
          sourceId: NonBlankStringSchema,
          quote: NonBlankStringSchema,
        },
        closed,
      ),
    ),
  },
  closed,
);
export type MemoryConsolidationOutput = Static<
  typeof MemoryConsolidationOutputSchema
>;
export interface MemoryConsolidationInput {
  anchorRevisionId: string;
  evidence: MemoryEvidenceItem[];
  existing?: MemoryEvidenceItem;
  support: {
    revisionId: string;
    sourceCount: number;
    distinctUserDays: number;
    distinctContexts: number;
  }[];
  coverage: {
    namespaceFormationIncomplete: boolean;
    retrieval: Pick<
      EvidencePack,
      "coverage" | "gaps" | "truncated" | "incompleteReasons"
    >;
    materialOmissions?: {
      revisionId: string;
      reason: "resource_limit" | "input_limit";
    }[];
    supplied: ReturnType<MemoryRepository["learning"]["evidenceSupply"]>;
    knownFormationConnections: ReturnType<
      MemoryRepository["formation"]["connectedIncompleteSources"]
    >;
  };
}
export interface ConsolidationExecution {
  readonly expectedProcessorVersion: string;
  readonly assertInputCurrent: (rejectedCause?: unknown) => void;
}

export interface MemoryConsolidationModel {
  readonly version: string;
  measureInput(
    input: MemoryConsolidationInput,
    execution: ConsolidationExecution,
    signal: AbortSignal,
  ): Promise<{ measurement: InputBudgetEstimate; budget: number }>;
  consolidate(
    input: MemoryConsolidationInput,
    execution: ConsolidationExecution,
    signal: AbortSignal,
  ): Promise<MemoryConsolidationOutput>;
}

/** One model binding belongs to one existing work attempt, never a shared cache. */
export interface MemoryConsolidationRuntime {
  readonly version: string;
  bind(
    execution: ConsolidationExecution,
    signal: AbortSignal,
  ): Promise<MemoryConsolidationModel>;
}

export class ModelMemoryConsolidation implements MemoryConsolidationModel {
  readonly version: string;
  constructor(
    private readonly provider: ModelProvider,
    private readonly modelId: string,
    private readonly limits: ModelContextLimits,
    private readonly onUsage?: (usage: ModelUsage) => void,
  ) {
    this.version = `${MEMORY_CONSOLIDATION_PROCESSOR_VERSION}:${modelId}`;
  }

  #assertExecution(
    execution: ConsolidationExecution,
    signal: AbortSignal,
    rejectedCause?: unknown,
  ) {
    signal.throwIfAborted();
    execution.assertInputCurrent(rejectedCause);
    if (execution.expectedProcessorVersion !== this.version)
      throw new Error(
        "Consolidation model does not match its expected processor",
      );
  }

  #request(input: MemoryConsolidationInput): ModelRequest {
    return {
      modelId: this.modelId,
      instructions:
        "Create at most one useful concise account of this companion's existing memories, without inventing new observations. Combine connected developments, preserve conditions, actors, uncertain causes, negative preferences, dates, promises, corrections, and the user's own expressed feelings. An interpretation must remain explicitly bounded by its evidence; do not infer emotions from silence or activity. Repeated sources are not independent support. episode_summary may connect events in one situation; bounded_pattern requires genuinely repeated independent user evidence across situations, and must describe the observed range without turning it into a universal trait. support.sourceCount counts distinct canonical raw-user sources used as primary Formation evidence for that revision and supplied here with citable spans. It is a count of candidate sources, not quotations or proven independent experiences; counts across revisions may overlap. bounded_pattern requires at least two such sources among its actual citations, a necessary structural condition, never sufficient semantic evidence. Replaying the same source, assistant restatement, later expressions of valuing an experience, or crossing UTC midnight do not establish a new occurrence. distinctUserDays counts UTC date buckets and distinctContexts counts all recorded non-empty PFC situation labels. Dates, Chat counts and labels neither prove nor disprove semantic independence; missing labels do not establish one shared situation, and distinct experiences can occur on the same day. Examine the full exact sources, times, conditions and counterexamples to judge real repetition and its limited scope; retain originals when this remains unclear. Evidence sourceCount and derivation metadata describe coverage, not confidence. Never consolidate unrelated facts just to reduce bytes. This output creates an inference, never changes an original fact or persona. Every dependency must be an exact supplied non-derived Revision and have an exact citation from that revision's supplied sourceRefs.spans. Include the anchor dependency. Coverage separates the namespace, retrieval, and actual supplied citation material. namespaceFormationIncomplete means some experiences in the library remain unformed; it alone does not show that these supplied dependencies lack evidence. retrieval lists question coverage, gaps and search caveats; library-wide caveats or an unexhausted search are not a statement that every supplied fact is unusable. supplied compares exact stored source/span tuples with what you actually see; a complete projection is not proof that every memory clause is supported. knownFormationConnections counts unfinished work touching an actually supplied source, as primary or context; you have not read that unfinished episode, and no connection does not prove no relevant unknown experience exists. Produce only a bounded account of the supplied, supported observations, never an exhaustive claim about the person. If a condition, actor, correction or source needed for that account is actually missing or ambiguous, choose retain_originals. An unrelated namespace gap alone should not prevent a clearly supported bounded account. If an existing account is supplied, revise only when the replacement retains every still-valid dependency and all important conditions of that account; otherwise retain_originals. Prefer retaining originals when compression loses useful distinctions or no coherent synthesis exists. Return disposition, a concise reason, optional content/account, dependencies and citations. No new entities, IDs, implied external action, or synthetic evidence. Do not answer the user. Return compact structured JSON.",
      input: [
        { role: "user", type: "message", content: JSON.stringify(input) },
      ],
      structuredOutput: {
        name: "memory_consolidation",
        schema: structuredOutputWireSchema(MemoryConsolidationOutputSchema),
      },
      toolNamespaces: [],
    };
  }

  async measureInput(
    input: MemoryConsolidationInput,
    execution: ConsolidationExecution,
    signal: AbortSignal,
  ): Promise<{ measurement: InputBudgetEstimate; budget: number }> {
    this.#assertExecution(execution, signal);
    const request = this.#request(input);
    let measurement: InputBudgetEstimate;
    try {
      measurement = await this.provider.measureInput(request, signal, {
        requireExact: true,
      });
    } catch (error) {
      this.#assertExecution(execution, signal, error);
      throw error;
    }
    this.#assertExecution(execution, signal);
    return {
      measurement,
      budget: modelInputBudget(this.limits, request.maxOutputTokens),
    };
  }

  async consolidate(
    input: MemoryConsolidationInput,
    execution: ConsolidationExecution,
    signal: AbortSignal,
  ): Promise<MemoryConsolidationOutput> {
    this.#assertExecution(execution, signal);
    let turn: CollectedModelTurn;
    try {
      turn = await collectModelTurn(
        this.provider.stream(this.#request(input), signal),
      );
    } catch (error) {
      this.#assertExecution(execution, signal, error);
      throw error;
    }
    try {
      this.#assertExecution(execution, signal);
    } finally {
      // A reported generation still cost tokens when its result became stale.
      // Count/metadata never enter this generation-usage callback.
      this.onUsage?.(turn.usage);
    }
    if (turn.status !== "completed")
      throw new Error("Consolidation was cancelled");
    return parseSchema(
      MemoryConsolidationOutputSchema,
      restoreStructuredOutput(
        MemoryConsolidationOutputSchema,
        JSON.parse(turn.text) as unknown,
      ),
    );
  }
}
class ConsolidationInputChangedError extends Error {
  constructor(
    readonly kind: "dependencies" | "quotes" | "target",
    message: string,
    readonly rejectedFailure?: unknown,
  ) {
    super(message);
    this.name = "ConsolidationInputChangedError";
  }
}

// Same selected raw-projection guard as COGNITION-DYNAMIC-ACTION-BUDGET.
// This does not bound the existing Recall Pack, JSON, total SQL work or heap.
const CONSOLIDATION_READ_BYTES = 16 * 1024 * 1024;

class ConsolidationMaterialLimitError extends Error {
  constructor(
    readonly code: "consolidation_resource_limit" | "consolidation_input_limit",
    message: string,
  ) {
    super(message);
    this.name = "ConsolidationMaterialLimitError";
  }
}

interface ConsolidationRecall {
  readonly pack: EvidencePack;
  readonly versions: ReadonlyMap<string, string | undefined>;
  readonly validReferences: ReadonlySet<string>;
  readonly validSpans: ReadonlySet<string>;
}

function spanKey(
  revisionId: string,
  sourceId: string,
  span: { start: number; end: number; quote: string },
): string {
  return JSON.stringify([
    revisionId,
    sourceId,
    span.start,
    span.end,
    span.quote,
  ]);
}

export interface MemoryConsolidationResult {
  workId: string;
  disposition: string;
  memoryId?: string;
  revisionId?: string;
  reason: string;
}

/** The only background consolidation owner: same Recall, immutable revisions,
 * ordinary durable work and transactional version checks, never a second store. */
export class MemoryConsolidationService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly recall: MemoryRecallPipeline,
    private readonly model: MemoryConsolidationRuntime,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly budget: () => { maxTokens: number },
  ) {}

  #availableProcessorVersion(): string | undefined {
    try {
      return this.model.version;
    } catch (error) {
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
      this.repository.learning.retryFailedForProcessor(
        version,
        this.clock.now(),
      );
  }

  recoverProviderFailures(
    processorVersion: string,
    requestIdentity: ProviderRequestIdentity,
  ): number {
    if (processorVersion !== this.#availableProcessorVersion()) return 0;
    return this.repository.learning.retryFailedForProvider(
      processorVersion,
      requestIdentity,
      this.clock.now(),
    );
  }

  /** Freeze the existing durable FIFO boundary; newly arriving work belongs to
   * the next drain. Each job retains its own context budget and commit checks. */
  async drain(
    signal?: AbortSignal,
    onChange?: (memoryId: string) => void,
    onError?: (error: unknown) => void,
    onDeferred?: () => void,
  ): Promise<MemoryConsolidationResult[]> {
    this.recoverForCurrentProcessor();
    if (this.#availableProcessorVersion() === undefined) return [];
    const result: MemoryConsolidationResult[] = [];
    const visited = new Set<string>();
    for (const group of this.repository.learning.pendingGroups()) {
      signal?.throwIfAborted();
      const members = group.filter(({ id }) => !visited.has(id));
      for (const { id } of members) visited.add(id);
      if (!members.length) continue;
      const outputs = await this.#runBatch(
        members,
        signal,
        onError,
        onChange,
        false,
        onDeferred,
      );
      result.push(...outputs);
    }
    return result;
  }

  async run(
    work: MemoryConsolidationWork,
    signal?: AbortSignal,
  ): Promise<MemoryConsolidationResult> {
    const results = await this.#runBatch(
      [work],
      signal,
      undefined,
      undefined,
      true,
    );
    return results[0]!;
  }

  #plan(anchor: MemoryEvidenceItem): RecallPlan {
    return {
      purpose: "reflection",
      query: anchor.content,
      questions: [
        {
          id: "developments",
          text: `与这段原始记忆有关的事件发展、限定、纠正和独立支持：${anchor.content}`,
        },
      ],
      ...(anchor.personaId
        ? {
            references: [
              {
                memoryId: anchor.memoryId,
                revisionId: anchor.revisionId,
                use: "current" as const,
              },
            ],
          }
        : {}),
      owner: anchor.owner!,
      ...(anchor.personaId ? { personaId: anchor.personaId } : {}),
      contextBudget: this.budget(),
    };
  }

  async #runBatch(
    works: readonly MemoryConsolidationWork[],
    signal?: AbortSignal,
    onError?: (error: unknown) => void,
    onChange?: (memoryId: string) => void,
    propagateError = false,
    onDeferred?: () => void,
  ): Promise<MemoryConsolidationResult[]> {
    signal ??= new AbortController().signal;
    signal?.throwIfAborted();
    const prepared = works.flatMap((work) => {
      const revision = this.repository.learning.anchor(work.subjectId);
      const anchor = revision
        ? this.repository.recall.evidence(
            [revision.revisionId],
            this.clock.now(),
            memoryEvidenceProjection(this.budget().maxTokens, 1),
          )[0]
        : undefined;
      return anchor?.owner && anchor.semantics && !anchor.derivation
        ? [{ work, plan: this.#plan(anchor) }]
        : [];
    });
    const results: MemoryConsolidationResult[] = [];
    // Existing input budget limits batching; it is not a semantic filter. Every
    // original work still runs, including a long or unmatched singleton.
    let cohort: typeof prepared = [];
    const cohorts: (typeof prepared)[] = [];
    const combined = (items: typeof prepared): RecallPlan => ({
      ...items[0]!.plan,
      query: items.map(({ plan }) => plan.query).join("\n"),
      questions: items.map(({ work, plan }) => ({
        id: work.id,
        text: plan.questions[0]!.text,
      })),
      ...(items[0]!.plan.personaId
        ? {
            references: items.flatMap(({ plan }) => plan.references ?? []),
          }
        : {}),
    });
    for (const item of prepared) {
      if (
        cohort.length &&
        (item.plan.owner !== cohort[0]!.plan.owner ||
          item.plan.personaId !== cohort[0]!.plan.personaId ||
          estimateInputBudget(combined([...cohort, item])).estimatedTokens >
            this.budget().maxTokens)
      ) {
        cohorts.push(cohort);
        cohort = [];
      }
      cohort.push(item);
    }
    if (cohort.length) cohorts.push(cohort);
    const supplied = new Map<
      string,
      {
        expected: RecallPlan;
        get: () => Promise<ConsolidationRecall>;
      }
    >();
    for (const group of cohorts) {
      const request = group.length === 1 ? group[0]!.plan : combined(group);
      let retrieval: Promise<ConsolidationRecall> | undefined;
      const read = () =>
        (retrieval ??= this.recall.recall(request, signal).then((pack) => ({
          pack,
          versions: new Map(
            pack.items.map((item) => [
              item.memoryId,
              this.repository.learning.snapshot(item.memoryId),
            ]),
          ),
          validReferences: new Set(
            pack.items
              .filter(
                (item) =>
                  !this.repository.recall.validateEvidenceReferences(
                    {
                      personaId: item.personaId ?? "",
                      references: [
                        {
                          memoryId: item.memoryId,
                          revisionId: item.revisionId,
                          use: item.current ? "current" : "history",
                        },
                      ],
                      usage: "grounding",
                    },
                    this.clock.now(),
                  ).length,
              )
              .map((item) => item.revisionId),
          ),
          validSpans: new Set(
            pack.items.flatMap((item) =>
              item.sourceRefs.flatMap((source) =>
                (source.spans ?? [])
                  .filter((span) =>
                    this.repository.recall.hasSpan(
                      item.revisionId,
                      source.sourceId,
                      span.start,
                      span.end,
                      span.quote,
                    ),
                  )
                  .map((span) =>
                    spanKey(item.revisionId, source.sourceId, span),
                  ),
              ),
            ),
          ),
        })));
      for (const { work, plan } of group) {
        supplied.set(work.id, {
          expected: plan,
          get: async () => {
            const recalled = await read();
            const { pack } = recalled;
            if (group.length === 1) return recalled;
            const items = pack.items
              .filter(({ questionIds }) => questionIds.includes(work.id))
              .map((item) => ({ ...item, questionIds: ["developments"] }));
            return {
              ...recalled,
              pack: {
                ...pack,
                items,
                coverage: pack.coverage
                  .filter(({ questionId }) => questionId === work.id)
                  .map((entry) => ({ ...entry, questionId: "developments" })),
                gaps: pack.gaps
                  .filter(({ questionId }) => questionId === work.id)
                  .map((entry) => ({ ...entry, questionId: "developments" })),
                estimatedTokens: estimateInputBudget(items).estimatedTokens,
              },
            };
          },
        });
      }
    }
    for (const work of works) {
      signal?.throwIfAborted();
      try {
        const output = await this.#runOne(work, signal, async (plan) => {
          const prepared = supplied.get(work.id);
          if (
            !prepared ||
            JSON.stringify(plan) !== JSON.stringify(prepared.expected)
          )
            throw new TypeError(
              "Consolidation prepared input is unavailable before grouped retrieval",
            );
          return prepared.get();
        });
        results.push(output);
        if (output.memoryId) onChange?.(output.memoryId);
        if (output.disposition === "source_changed") onDeferred?.();
      } catch (error) {
        if (signal?.aborted || propagateError) throw error;
        if (error instanceof ConsolidationInputChangedError) onDeferred?.();
        onError?.(error);
        results.push({
          workId: work.id,
          disposition:
            error instanceof ConsolidationInputChangedError
              ? "input_changed"
              : "failed",
          reason: error instanceof Error ? error.message : "巩固失败",
        });
      }
    }
    return results;
  }

  async #runOne(
    work: MemoryConsolidationWork,
    signal: AbortSignal,
    readRecall: (plan: RecallPlan) => Promise<ConsolidationRecall>,
  ): Promise<MemoryConsolidationResult> {
    signal?.throwIfAborted();
    const processorVersion = this.#availableProcessorVersion();
    if (processorVersion === undefined)
      return {
        workId: work.id,
        disposition: "not_ready",
        reason: "巩固模型尚未配置，保留原作业等待就绪",
      };
    const attempt = this.repository.learning.start(
      work.id,
      processorVersion,
      this.clock.now(),
    );
    if (attempt === undefined)
      return {
        workId: work.id,
        disposition: "not_pending",
        reason: "作业已由其他执行完成或领取",
      };
    const finish = (result: Omit<MemoryConsolidationResult, "workId">) => {
      const output = { workId: work.id, ...result };
      this.repository.learning.complete(
        work.id,
        attempt,
        output,
        this.clock.now(),
      );
      return output;
    };
    try {
      if (
        this.repository.learning.snapshot(work.subjectId) !== work.sourceVersion
      ) {
        this.repository.learning.enqueue(work.subjectId, this.clock.now());
        return finish({
          disposition: "source_changed",
          reason: "触发材料已更新，等待最新作业",
        });
      }
      const anchorId = this.repository.learning.anchor(
        work.subjectId,
      )!.revisionId;
      const anchor = this.repository.recall.evidence(
        [anchorId],
        this.clock.now(),
        memoryEvidenceProjection(this.budget().maxTokens, 1),
      )[0];
      if (!anchor?.semantics || anchor.derivation)
        return finish({
          disposition: "retain_originals",
          reason: "缺少可巩固的原始语义证据",
        });
      const recalled = await readRecall(this.#plan(anchor));
      // The anchor was read before Recall awaited its selector. Its version
      // cannot be replaced by the newer cohort receipt after that await.
      if (
        this.repository.learning.snapshot(work.subjectId) !== work.sourceVersion
      )
        throw new ConsolidationInputChangedError(
          "dependencies",
          "Consolidation anchor changed during retrieval",
        );
      const { pack, versions: recallVersions } = recalled;
      const selected = [
        anchor,
        ...pack.items.filter(
          (item) =>
            item.revisionId !== anchorId &&
            !item.derivation &&
            item.owner === anchor.owner &&
            item.personaId === anchor.personaId,
        ),
      ];
      // A later member can reuse the cohort's earlier Pack. Re-read it on the
      // next drain when its actual source version changed, before generation.
      if (
        selected.some(
          (item) =>
            recallVersions.has(item.memoryId) &&
            recallVersions.get(item.memoryId) !==
              this.repository.learning.snapshot(item.memoryId),
        )
      )
        throw new ConsolidationInputChangedError(
          "dependencies",
          "Consolidation grouped input changed before generation",
        );
      for (const item of selected) {
        const unavailable =
          this.repository.recall.validateEvidenceReferences(
            {
              personaId: anchor.personaId ?? "",
              references: [
                {
                  memoryId: item.memoryId,
                  revisionId: item.revisionId,
                  use: item.current ? "current" : "history",
                },
              ],
              usage: "grounding",
            },
            this.clock.now(),
          ).length > 0;
        if (unavailable) {
          if (recalled.validReferences.has(item.revisionId))
            throw new ConsolidationInputChangedError(
              "dependencies",
              "Consolidation grouped reference changed before generation",
            );
          throw new TypeError(
            "Consolidation input is unavailable before generation",
          );
        }
        for (const source of item.sourceRefs)
          for (const span of source.spans ?? []) {
            if (
              this.repository.recall.hasSpan(
                item.revisionId,
                source.sourceId,
                span.start,
                span.end,
                span.quote,
              )
            )
              continue;
            if (
              recalled.validSpans.has(
                spanKey(item.revisionId, source.sourceId, span),
              )
            )
              throw new ConsolidationInputChangedError(
                "quotes",
                "Consolidation grouped source quotes changed before generation",
              );
            throw new TypeError(
              "Consolidation source quote is unavailable before generation",
            );
          }
      }
      // Keep the existing target rule and Recall selection. Final input fitting
      // no longer hides an otherwise selected raw Revision from that rule.
      const targetMemoryIds = selected.map(({ memoryId }) => memoryId);
      const { target, previous, prior, required, material, materialOmissions } =
        this.repository.recall.transaction(() => {
          signal?.throwIfAborted();
          const now = this.clock.now();
          const target = this.repository.learning.derivedTarget(
            targetMemoryIds,
            anchor.owner!,
            anchor.personaId,
            now,
          );
          let rawValueBytes = 0;
          let rowCount = 0;
          const read = (references: readonly MemoryEvidenceReference[]) => {
            if (!references.length) return [];
            if (
              references.some(
                ({ use }) => use !== "current" && use !== "history",
              )
            )
              throw new TypeError("Consolidation dependency has no valid use");
            const request = {
              personaId: anchor.personaId ?? "",
              references,
              usage: "grounding" as const,
            };
            const remaining = CONSOLIDATION_READ_BYTES - rawValueBytes;
            if (remaining <= 0) {
              if (
                this.repository.recall.validateEvidenceReferences(request, now)
                  .length
              )
                throw new TypeError(
                  "Required consolidation reference is unavailable",
                );
              const cost = this.repository.recall.evidenceReadCost(
                references.map(({ revisionId }) => revisionId),
                now,
              );
              throw new ConsolidationMaterialLimitError(
                "consolidation_resource_limit",
                `Complete consolidation material needs ${rawValueBytes + cost.rawValueBytes} raw bytes across ${rowCount + cost.rowCount} rows; read allocation ${CONSOLIDATION_READ_BYTES}`,
              );
            }
            const resolved = resolveMemoryEvidence(
              this.repository.recall,
              { ...request, resourceBudget: { maxReadBytes: remaining } },
              now,
            );
            if (resolved.status === "unavailable")
              throw new TypeError(
                "Required consolidation reference is unavailable",
              );
            if (resolved.status === "resource_limit")
              throw new ConsolidationMaterialLimitError(
                "consolidation_resource_limit",
                `Complete consolidation material needs ${rawValueBytes + resolved.readCost.rawValueBytes} raw bytes across ${rowCount + resolved.readCost.rowCount} rows; read allocation ${CONSOLIDATION_READ_BYTES}`,
              );
            rawValueBytes += resolved.readCost.rawValueBytes;
            rowCount += resolved.readCost.rowCount;
            return resolved.items;
          };
          const first = read([
            {
              memoryId: anchor.memoryId,
              revisionId: anchorId,
              use: anchor.current ? "current" : "history",
            },
            ...(target ? [{ ...target, use: "current" as const }] : []),
          ]);
          const previous = target
            ? first.find(({ revisionId }) => revisionId === target.revisionId)
            : undefined;
          if (target && !previous?.derivation)
            throw new TypeError("Consolidation target has no live derivation");
          const prior = previous?.derivation?.dependencies ?? [];
          // Validate every exact reference/use, even when its body was read as
          // the anchor. Additional full bodies share one cumulative allocation.
          if (
            prior.some(({ use }) => use !== "current" && use !== "history") ||
            this.repository.recall.validateEvidenceReferences(
              {
                personaId: anchor.personaId ?? "",
                references: prior,
                usage: "grounding",
              },
              now,
            ).length
          )
            throw new TypeError(
              "Consolidation prior dependency is unavailable",
            );
          const readIds = new Set(first.map(({ revisionId }) => revisionId));
          const expanded = read(
            prior.filter(({ revisionId }) => !readIds.has(revisionId)),
          );
          const required = new Set([
            anchorId,
            ...prior.map(({ revisionId }) => revisionId),
          ]);
          const complete = [...first, ...expanded];
          const completeIds = new Set(
            complete.map(({ revisionId }) => revisionId),
          );
          const materialOmissions: NonNullable<
            MemoryConsolidationInput["coverage"]["materialOmissions"]
          > = [];
          let resourceLimited = false;
          // Required bodies are already allocated. Complete only this selection,
          // in its original order, with the same cumulative raw read allocation.
          for (const item of selected) {
            if (completeIds.has(item.revisionId)) continue;
            if (!resourceLimited) {
              try {
                complete.push(
                  ...read([
                    {
                      memoryId: item.memoryId,
                      revisionId: item.revisionId,
                      use: item.current ? "current" : "history",
                    },
                  ]),
                );
                completeIds.add(item.revisionId);
                continue;
              } catch (error) {
                if (
                  !(error instanceof ConsolidationMaterialLimitError) ||
                  error.code !== "consolidation_resource_limit"
                )
                  throw error;
                resourceLimited = true;
              }
            }
            materialOmissions.push({
              revisionId: item.revisionId,
              reason: "resource_limit",
            });
          }
          const full = complete.filter(
            ({ revisionId }) => revisionId !== previous?.revisionId,
          );
          if (
            full.some(
              (item) =>
                !item.semantics ||
                item.derivation ||
                item.owner !== anchor.owner ||
                item.personaId !== anchor.personaId,
            )
          )
            throw new TypeError(
              "Consolidation complete material changed scope",
            );
          const selectedById = new Map(
            selected.map((item) => [item.revisionId, item]),
          );
          const material = [
            ...new Map([
              ...selected
                .filter(({ revisionId }) => completeIds.has(revisionId))
                .map((item) => [item.revisionId, item] as const),
              ...full.map(
                (item) =>
                  [
                    item.revisionId,
                    {
                      ...item,
                      questionIds:
                        selectedById.get(item.revisionId)?.questionIds ?? [],
                    },
                  ] as const,
              ),
            ]).values(),
          ];
          return {
            target,
            previous,
            prior,
            material,
            required,
            materialOmissions,
          };
        });
      // Pure persisted history remains history even when that revision is still
      // current today. A mixed prior dependency retains its existing current
      // constraint. Validate all original uses while reading each body once.
      const dependencyUses = new Map(
        material.map((item) => [
          item.revisionId,
          item.current ? ("current" as const) : ("history" as const),
        ]),
      );
      const priorUses = new Map<string, MemoryEvidenceReference["use"]>();
      for (const reference of prior)
        if (priorUses.get(reference.revisionId) !== "current")
          priorUses.set(reference.revisionId, reference.use);
      for (const [revisionId, use] of priorUses)
        dependencyUses.set(revisionId, use);
      let evidence = material;
      const supportById = new Map(
        evidence.map((item) => {
          const support = this.repository.learning.support(
            [item.revisionId],
            this.clock.now(),
            item.sourceRefs
              .filter(({ spans }) => spans?.length)
              .map(({ sourceId }) => sourceId),
          );
          return [
            item.revisionId,
            {
              revisionId: item.revisionId,
              sourceCount: support.sourceCount,
              distinctUserDays: support.distinctUserDays,
              distinctContexts: support.distinctContexts,
            },
          ] as const;
        }),
      );
      const makeInput = (): MemoryConsolidationInput =>
        this.repository.recall.transaction(() => ({
          anchorRevisionId: anchorId,
          evidence,
          ...(previous ? { existing: previous } : {}),
          support: evidence.map(({ revisionId }) =>
            supportById.get(revisionId)!,
          ),
          coverage: {
            namespaceFormationIncomplete: this.repository.formation.incomplete({
              owner: anchor.owner!,
              ...(anchor.personaId ? { personaId: anchor.personaId } : {}),
            }),
            retrieval: {
              coverage: pack.coverage,
              gaps: pack.gaps,
              truncated: pack.truncated,
              incompleteReasons: pack.incompleteReasons,
            },
            ...(materialOmissions.length
              ? {
                  materialOmissions: materialOmissions.map((item) => ({
                    ...item,
                  })),
                }
              : {}),
            supplied: this.repository.learning.evidenceSupply(evidence),
            knownFormationConnections:
              this.repository.formation.connectedIncompleteSources(
                {
                  owner: anchor.owner!,
                  ...(anchor.personaId ? { personaId: anchor.personaId } : {}),
                },
                evidence.flatMap((item) =>
                  item.sourceRefs.map(({ sourceId }) => sourceId),
                ),
              ),
          },
        }));
      const snapshots = new Map(
        evidence.map((item) => [
          item.memoryId,
          this.repository.learning.snapshot(item.memoryId),
        ]),
      );
      const checkInputCurrent = () => {
        signal.throwIfAborted();
        if (
          this.repository.recall.validateEvidenceReferences(
            {
              personaId: anchor.personaId ?? "",
              references: [
                ...evidence.map((item): MemoryEvidenceReference => ({
                  memoryId: item.memoryId,
                  revisionId: item.revisionId,
                  use: item.current ? "current" : "history",
                })),
                ...prior,
              ],
              usage: "grounding",
            },
            this.clock.now(),
          ).length ||
          evidence.some(
            (item) =>
              this.repository.learning.snapshot(item.memoryId) !==
              snapshots.get(item.memoryId),
          )
        )
          throw new ConsolidationInputChangedError(
            "dependencies",
            "Consolidation dependencies changed during preparation or generation",
          );
        if (
          [...evidence, ...(previous ? [previous] : [])].some((item) =>
            item.sourceRefs.some((source) =>
              (source.spans ?? []).some(
                (span) =>
                  !this.repository.recall.hasSpan(
                    item.revisionId,
                    source.sourceId,
                    span.start,
                    span.end,
                    span.quote,
                  ),
              ),
            ),
          )
        )
          throw new ConsolidationInputChangedError(
            "quotes",
            "Consolidation source quotes changed during preparation or generation",
          );
        const currentTarget = this.repository.learning.derivedTarget(
          targetMemoryIds,
          anchor.owner!,
          anchor.personaId,
          this.clock.now(),
        );
        if (
          currentTarget?.memoryId !== target?.memoryId ||
          currentTarget?.revisionId !== target?.revisionId
        )
          throw new ConsolidationInputChangedError(
            "target",
            "Consolidation target changed during preparation or generation",
          );
      };
      const assertInputCurrent = (rejectedCause?: unknown) => {
        signal.throwIfAborted();
        try {
          checkInputCurrent();
        } catch (error) {
          signal.throwIfAborted();
          if (rejectedCause === undefined) throw error;
          if (error instanceof ConsolidationInputChangedError)
            throw new ConsolidationInputChangedError(
              error.kind,
              error.message,
              rejectedCause instanceof ConsolidationInputChangedError
                ? rejectedCause.rejectedFailure
                : rejectedCause,
            );
          // A read/validation exception is not proof of an input transition.
          // Preserve the actual rejected operation instead of inventing defer.
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Rethrow the actual rejection without replacing its identity.
          throw rejectedCause;
        }
      };
      assertInputCurrent();
      if (evidence.length < 2) {
        if (materialOmissions.length)
          throw new ConsolidationMaterialLimitError(
            "consolidation_resource_limit",
            `Complete read allocation leaves fewer than two original facts: ${JSON.stringify(materialOmissions)}`,
          );
        return finish({
          disposition: "retain_originals",
          reason: "只有一段原始证据，无需另造摘要",
        });
      }
      const execution = {
        expectedProcessorVersion: processorVersion,
        assertInputCurrent,
      };
      let model: MemoryConsolidationModel;
      try {
        model = await this.model.bind(execution, signal);
      } catch (error) {
        assertInputCurrent(error);
        throw error;
      }
      assertInputCurrent();
      let input = makeInput();
      for (;;) {
        let measured: Awaited<
          ReturnType<MemoryConsolidationModel["measureInput"]>
        >;
        try {
          measured = await model.measureInput(input, execution, signal);
        } catch (error) {
          assertInputCurrent(error);
          throw error;
        }
        // Stale input is never read as a false-fit, error or a retain decision.
        assertInputCurrent();
        if (fitsInputBudget(measured.measurement, measured.budget)) {
          if (evidence.length < 2)
            throw new ConsolidationMaterialLimitError(
              "consolidation_input_limit",
              "Complete request allocation leaves fewer than two original facts for consolidation",
            );
          break;
        }
        const removable = evidence.findLastIndex(
          ({ revisionId }) => !required.has(revisionId),
        );
        if (removable < 0)
          throw new ConsolidationMaterialLimitError(
            "consolidation_input_limit",
            `Complete required consolidation request does not fit: ${JSON.stringify(measured)}`,
          );
        materialOmissions.push({
          revisionId: evidence[removable]!.revisionId,
          reason: "input_limit",
        });
        evidence = evidence.filter((_, index) => index !== removable);
        input = makeInput();
      }
      let generated: MemoryConsolidationOutput;
      try {
        generated = await model.consolidate(input, execution, signal);
      } catch (error) {
        assertInputCurrent(error);
        throw error;
      }
      assertInputCurrent();
      const output = parseSchema(MemoryConsolidationOutputSchema, generated);
      if (
        JSON.stringify(redactBoundaryValue(output)) !== JSON.stringify(output)
      )
        throw new TypeError("Consolidation contains a detected secret");
      if (output.disposition === "retain_originals") {
        assertInputCurrent();
        return finish({
          disposition: "retain_originals",
          reason: output.reason,
        });
      }
      if (
        !output.content ||
        !output.account ||
        output.dependencies.length < 2 ||
        !output.dependencies.includes(anchorId) ||
        new Set(output.dependencies).size !== output.dependencies.length
      )
        throw new TypeError(
          "Consolidation must combine the anchor and distinct supplied facts",
        );
      const byId = new Map(evidence.map((item) => [item.revisionId, item]));
      const parents = output.dependencies.map((id) => {
        const item = byId.get(id);
        if (
          !item?.semantics ||
          item.derivation ||
          item.historyStatus === "corrected" ||
          item.historyStatus === "unresolved"
        )
          throw new TypeError("Unavailable consolidation dependency");
        return item;
      });
      if (
        previous?.derivation?.dependencies.some(
          ({ revisionId }) => !output.dependencies.includes(revisionId),
        )
      )
        throw new TypeError("Consolidation dropped a still-live dependency");
      const refs: MemoryEvidenceReference[] = parents.map((item) => ({
        memoryId: item.memoryId,
        revisionId: item.revisionId,
        use: dependencyUses.get(item.revisionId)!,
      }));
      const citations = output.citations.map((citation) => {
        if (!output.dependencies.includes(citation.revisionId))
          throw new TypeError("Consolidation citation has no dependency");
        const span = byId
          .get(citation.revisionId)
          ?.sourceRefs.find(({ sourceId }) => sourceId === citation.sourceId)
          ?.spans?.find(({ quote }) => quote === citation.quote);
        if (!span)
          throw new TypeError(
            "Consolidation requires an exact existing source span",
          );
        return { ...citation, ...span };
      });
      if (
        output.dependencies.some(
          (id) => !citations.some(({ revisionId }) => revisionId === id),
        )
      )
        throw new TypeError("Consolidation omitted a dependency's evidence");
      const support = this.repository.learning.support(
        output.dependencies,
        this.clock.now(),
        citations.map(({ sourceId }) => sourceId),
      );
      if (output.account === "bounded_pattern" && support.sourceCount < 2)
        throw new TypeError(
          "A bounded pattern requires at least two cited original user sources",
        );
      if (output.content === previous?.content) {
        assertInputCurrent();
        return finish({
          disposition: "retain_originals",
          reason: "已有相同摘要，无需另一次写入",
        });
      }
      return this.repository.recall.transaction(() => {
        signal?.throwIfAborted();
        assertInputCurrent();
        const now = this.clock.now(),
          memoryId = target?.memoryId ?? this.ids.generate(),
          revisionId = this.ids.generate();
        const sources = [
          ...new Map(
            citations.map(({ sourceId }) => [
              sourceId,
              this.repository.formation.sourceProvenance(sourceId),
            ]),
          ).values(),
        ];
        if (target)
          this.repository.revise({
            predecessorRevisionId: target.revisionId,
            priorDispositions: [
              { revisionId: target.revisionId, disposition: "unresolved" },
            ],
            memoryId,
            revisionId,
            content: output.content!,
            sources,
            reason: output.reason,
            now,
          });
        else
          this.repository.create({
            memoryId,
            revisionId,
            type: "agent_learning",
            content: output.content!,
            sources,
            reason: output.reason,
            now,
            confidence: 0.5,
            importance: 0.5,
          });
        this.repository.recall.putSemantics(
          revisionId,
          {
            kind: "reflection",
            basis: "inference",
            owner: anchor.owner!,
            ...(anchor.personaId ? { personaId: anchor.personaId } : {}),
            qualifiers: {
              consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
              consolidationDependencyCount: String(
                new Set(
                  citations.map(
                    (citation) => `${citation.revisionId}:${citation.sourceId}`,
                  ),
                ).size,
              ),
              account: output.account!,
            },
          },
          [...new Set(parents.flatMap(({ entityIds }) => entityIds))],
        );
        for (const citation of citations) {
          this.repository.recall.addSpan(
            revisionId,
            citation.sourceId,
            citation.start,
            citation.end,
            citation.quote,
          );
          this.repository.recall.link(
            revisionId,
            citation.revisionId,
            "derived_from",
            citation.sourceId,
            refs.find((ref) => ref.revisionId === citation.revisionId)!.use,
          );
        }
        if (target)
          this.repository.recall.link(
            revisionId,
            target.revisionId,
            "supersedes",
            sources[0]!.id,
          );
        return finish({
          disposition: "consolidated",
          memoryId,
          revisionId,
          reason: output.reason,
        });
      });
    } catch (error) {
      if (!signal?.aborted && error instanceof ConsolidationInputChangedError) {
        this.repository.learning.deferInputChange(
          work,
          attempt,
          {
            code: `consolidation_${error.kind}_changed`,
            message: error.message,
            ...(error.rejectedFailure === undefined
              ? {}
              : {
                  cause:
                    error.rejectedFailure instanceof ProviderError
                      ? {
                          code: error.rejectedFailure.code,
                          message: error.rejectedFailure.message,
                          retryable: error.rejectedFailure.retryable,
                          ...(error.rejectedFailure.requestIdentity
                            ? {
                                requestIdentity:
                                  error.rejectedFailure.requestIdentity,
                              }
                            : {}),
                        }
                      : {
                          message:
                            error.rejectedFailure instanceof Error
                              ? error.rejectedFailure.message
                              : "Consolidation operation rejected",
                        },
                }),
          },
          this.clock.now(),
        );
        throw error;
      }
      this.repository.learning.fail(
        work.id,
        attempt,
        {
          code: signal?.aborted
            ? "consolidation_interrupted"
            : error instanceof ConsolidationMaterialLimitError
              ? error.code
              : error instanceof ProviderError
                ? error.code
                : error instanceof TypeError || error instanceof SyntaxError
                  ? "consolidation_validation_failed"
                  : "consolidation_failed",
          message:
            error instanceof Error ? error.message : "Consolidation failed",
          ...(error instanceof ProviderError && error.requestIdentity
            ? { requestIdentity: error.requestIdentity }
            : {}),
        },
        this.clock.now(),
        signal?.aborted ?? false,
      );
      throw error;
    }
  }
}
