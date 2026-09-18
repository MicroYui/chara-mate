import type {
  EvidencePack,
  MemoryEvidenceItem,
  MemoryEvidenceReadRequest,
  MemoryEvidenceReferenceRequest,
  MemoryEvidenceResolution,
  MemoryFormationEpisode,
  RecallPlan,
  RecallQuestion,
} from "../../shared/contracts/memoryRecall";
import type { Clock } from "../../shared/pure/clock";
import { RecallPlanSchema } from "../../shared/schemas/memoryRecall";
import { parseSchema } from "../../shared/schemas/validation";
import { estimateInputBudget } from "../providers/inputBudget";
import type {
  MemoryEmbeddingProvider,
  MemoryEvidenceSelector,
  MemorySelection,
} from "./memoryModels";
import {
  memoryExpansionPlan,
  type MemoryEvidenceProjection,
  type MemoryRecallRepository,
} from "./memoryRecallRepository";
import type { MemoryVectorSearchPort } from "./memoryVectorSearchWorker";

export interface MemoryRecallDiagnostics {
  readonly purpose: RecallPlan["purpose"];
  readonly candidateBudget: number;
  readonly candidateLimit: number;
  readonly channels: {
    questionId?: string;
    channel: "reference" | "lexical" | "semantic" | "entity_time" | "relation";
    returned: number;
  }[];
  fusedCount: number;
  candidateCount: number;
  readonly selectorInputs: {
    candidateCount: number;
    estimatedTokens: number;
  }[];
  selectedCount: number;
  estimatedOutputTokens: number;
}

export interface MemoryRecallDependencies {
  readonly embedding: MemoryEmbeddingProvider;
  readonly selector: MemoryEvidenceSelector;
  readonly vectorSearch: MemoryVectorSearchPort;
  readonly onRecallDiagnostics?: (diagnostics: MemoryRecallDiagnostics) => void;
}

/** Final delivery is measured by its consumer; candidate work stays separate. */
export interface MemoryRecallOutputAllocation {
  readonly candidateBudgetTokens: number;
  readonly fits: (pack: EvidencePack) => Promise<boolean>;
}

function estimatedTokens(items: readonly MemoryEvidenceItem[]): number {
  return items.length ? estimateInputBudget(items).estimatedTokens : 0;
}

// This is a capacity upper bound derived from the smallest valid serialized
// evidence item, not a selected retrieval topK or a semantic quality threshold.
const MINIMUM_EVIDENCE: MemoryEvidenceItem = {
  memoryId: "00000000-0000-4000-8000-000000000000",
  revisionId: "00000000-0000-4000-8000-000000000000",
  type: "event",
  content: "x",
  entityIds: [],
  sourceRefs: [],
  recordedAt: "2000-01-01T00:00:00.000Z",
  current: true,
  historyStatus: "current",
  questionIds: [],
};
const ARRAY_FRAMING = estimateInputBudget([]).estimatedTokens;
const MINIMUM_ITEM_COST =
  estimateInputBudget([MINIMUM_EVIDENCE]).estimatedTokens - ARRAY_FRAMING + 1;
const MINIMUM_SOURCE_COST =
  estimateInputBudget([
    {
      sourceId: MINIMUM_EVIDENCE.memoryId,
      referenceId: MINIMUM_EVIDENCE.memoryId,
      type: "chat",
    },
  ]).estimatedTokens -
  ARRAY_FRAMING +
  1;

export function memoryCandidateCapacity(maxTokens: number): number {
  return Math.max(
    0,
    Math.floor((maxTokens - ARRAY_FRAMING + 1) / MINIMUM_ITEM_COST),
  );
}

export function memoryEvidenceProjection(
  maxTokens: number,
  itemCount: number,
  knownAt?: string,
): MemoryEvidenceProjection {
  const itemBudget = Math.floor(maxTokens / Math.max(1, itemCount));
  const sourceLimit = Math.max(1, Math.floor(itemBudget / MINIMUM_SOURCE_COST));
  // SQL shares this total quote payload allowance over the references actually
  // returned, rather than assuming every record has the maximum source count.
  return {
    sourceLimit,
    quoteBytes: maxTokens,
    ...(knownAt ? { knownAt } : {}),
  };
}

function compactEvidence(item: MemoryEvidenceItem): MemoryEvidenceItem {
  const first = item.sourceRefs[0];
  return {
    ...item,
    sourceCount: item.sourceCount ?? item.sourceRefs.length,
    sourceRefs: first
      ? [
          {
            sourceId: first.sourceId,
            referenceId: first.referenceId,
            type: first.type,
          },
        ]
      : [],
  };
}

function withEvidenceSource(
  item: MemoryEvidenceItem,
  source: MemoryEvidenceItem["sourceRefs"][number],
): MemoryEvidenceItem {
  const index = item.sourceRefs.findIndex(
    ({ sourceId }) => sourceId === source.sourceId,
  );
  return {
    ...item,
    sourceRefs:
      index < 0
        ? [...item.sourceRefs, source]
        : item.sourceRefs.map((prior, position) =>
            position === index ? source : prior,
          ),
  };
}

// The synchronous candidate fit and asynchronous final fit use the same
// statement-first / source-upgrade order. Each yielded projection is immutable
// to subsequent steps so a measured receipt is never changed afterwards.
function* evidenceFitSteps(
  items: readonly MemoryEvidenceItem[],
  retained: readonly MemoryEvidenceItem[] = [],
): Generator<MemoryEvidenceItem[], MemoryEvidenceItem[], boolean> {
  let result: MemoryEvidenceItem[] = retained.map((item) => ({
    ...item,
    sourceRefs: [...item.sourceRefs],
  }));
  const originals = new Map(items.map((item) => [item.revisionId, item]));
  // Allocate complete statements and one source reference before spending
  // remaining space on provenance. A frequently supported fact cannot crowd
  // out every other question merely by accumulating hundreds of references.
  for (const item of items) {
    const proposed = [...result, compactEvidence(item)];
    if (yield proposed) result = proposed;
  }
  for (let position = 0; position < result.length; position += 1) {
    const item = result[position]!;
    // Previously selected evidence keeps the exact projection already seen.
    const original = originals.get(item.revisionId);
    if (!original) continue;
    for (const source of original.sourceRefs) {
      const proposed = result.map((current, index) =>
        index === position ? withEvidenceSource(current, source) : current,
      );
      if (yield proposed) result = proposed;
      else break;
    }
  }
  return result;
}

export function fitMemoryEvidence(
  items: readonly MemoryEvidenceItem[],
  maxTokens: number,
  retained: readonly MemoryEvidenceItem[] = [],
): MemoryEvidenceItem[] {
  if (estimatedTokens(retained) > maxTokens)
    throw new RangeError("Retained memory evidence exceeds the context budget");
  const steps = evidenceFitSteps(items, retained);
  let step = steps.next();
  while (!step.done)
    step = steps.next(estimatedTokens(step.value) <= maxTokens);
  return step.value;
}

export function resolveMemoryEvidence(
  repository: MemoryRecallRepository,
  request: MemoryEvidenceReadRequest,
  now: string,
): MemoryEvidenceResolution {
  const maxReadBytes = request.resourceBudget.maxReadBytes;
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1)
    throw new RangeError(
      "Memory evidence read resource budget must be a positive integer",
    );
  return repository.transaction<MemoryEvidenceResolution>(() => {
    const unavailable = repository.validateEvidenceReferences(request, now);
    if (unavailable.length) return { status: "unavailable", unavailable };
    const ids = [
      ...new Set(request.references.map(({ revisionId }) => revisionId)),
    ];
    const readCost = repository.evidenceReadCost(ids, now);
    if (readCost.rawValueBytes > maxReadBytes)
      return { status: "resource_limit", readCost };
    // Mandatory references always receive the complete existing projection.
    // This call has neither source/quote truncation nor an optional token fit.
    const items = repository.evidence(ids, now);
    const present = new Set(items.map(({ revisionId }) => revisionId));
    const missing = request.references.filter(
      ({ revisionId }) => !present.has(revisionId),
    );
    if (missing.length) return { status: "unavailable", unavailable: missing };
    return { status: "resolved", items, readCost };
  });
}

/** Ordinary Recall's explicit-reference channel remains a bounded optional
 * projection. It does not implement the mandatory action read contract. */
function readRecallReferences(
  repository: MemoryRecallRepository,
  request: MemoryEvidenceReferenceRequest & {
    readonly contextBudget: { readonly maxTokens: number };
  },
  now: string,
) {
  const budget = request.contextBudget.maxTokens;
  if (!Number.isSafeInteger(budget) || budget < 1)
    throw new RangeError("Memory evidence budget must be a positive integer");
  return repository.transaction(() => {
    const unavailable = repository.validateEvidenceReferences(request, now);
    const unavailableSet = new Set(unavailable);
    const available = request.references.filter(
      (ref) => !unavailableSet.has(ref),
    );
    const ids = [...new Set(available.map(({ revisionId }) => revisionId))];
    const costs = repository.statementReadBytes(ids);
    const readIds: string[] = [];
    const capacity = memoryCandidateCapacity(budget);
    let remaining = budget;
    for (const id of ids) {
      const cost = costs.get(id);
      if (cost === undefined || cost > remaining || readIds.length >= capacity)
        continue;
      readIds.push(id);
      remaining -= cost;
    }
    const items = fitMemoryEvidence(
      repository.evidence(
        readIds,
        now,
        memoryEvidenceProjection(
          budget,
          readIds.length,
          request.retrieval?.timeScope?.knownAt,
        ),
      ),
      budget,
    );
    const kept = new Set(items.map(({ revisionId }) => revisionId));
    return {
      items,
      unavailable,
      omittedForBudget: available.filter(
        ({ revisionId }) => !kept.has(revisionId),
      ),
      estimatedTokens: items.length
        ? estimateInputBudget(items).estimatedTokens
        : 0,
    };
  });
}

function rankFusion(lists: readonly string[][]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  // Give each question/channel its next ranked candidate in the existing
  // list order. A shared result occupies one slot without gaining extra weight.
  const maximum = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < maximum; rank += 1) {
    for (const list of lists) {
      const id = list[rank];
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
  }
  return result;
}

export function memoryRecallQuestions(
  request: Pick<RecallPlan, "query"> & {
    readonly questions?: readonly RecallQuestion[];
  },
): RecallQuestion[] {
  const questions = request.questions?.length
    ? [...request.questions]
    : request.query.trim()
      ? [{ id: "memory-query", text: request.query }]
      : [];
  if (new Set(questions.map(({ id }) => id)).size !== questions.length)
    throw new TypeError("Recall questions must have distinct IDs");
  return questions;
}

function emptyPack(plan: Pick<RecallPlan, "questions">): EvidencePack {
  return {
    items: [],
    coverage: plan.questions.map(({ id }) => ({
      questionId: id,
      status: "missing",
      revisionIds: [],
    })),
    gaps: plan.questions.map(({ id }) => ({
      questionId: id,
      reason: "没有足够的相关证据",
    })),
    estimatedTokens: 0,
    truncated: false,
    incompleteReasons: [],
  };
}

export function unsearchedMemoryPack(
  questions: RecallQuestion[],
): EvidencePack {
  const reason =
    "当前工作集没有可用于回传记忆证据的空间，本次未执行检索；不能据此判断记忆不存在";
  return {
    ...emptyPack({ questions }),
    gaps: questions.map(({ id }) => ({ questionId: id, reason })),
    truncated: true,
    incompleteReasons: [reason],
  };
}

export class MemoryRecallPipeline {
  #indexing: Promise<number> | undefined;

  constructor(
    private readonly repository: MemoryRecallRepository,
    private readonly dependencies: MemoryRecallDependencies,
    private readonly clock: Clock,
  ) {}

  indexIncomplete(): boolean {
    return this.repository.indexIncomplete(
      this.dependencies.embedding.modelKey,
    );
  }

  incompleteReasons(
    scope: Pick<RecallPlan, "owner" | "personaId">,
    excludingFormation?: Pick<MemoryFormationEpisode, "id" | "version">,
  ): string[] {
    const reasons: string[] = [];
    if (this.indexIncomplete()) reasons.push("部分记忆的语义索引尚未完成");
    if (this.repository.formation.incomplete(scope, excludingFormation))
      reasons.push("部分经历尚未形成可检索记忆");
    return reasons;
  }

  indexPending(signal?: AbortSignal): Promise<number> {
    if (this.#indexing) return this.#indexing;
    const operation = this.#indexPending(signal).finally(() => {
      this.#indexing = undefined;
    });
    this.#indexing = operation;
    return operation;
  }

  async #indexPending(signal?: AbortSignal): Promise<number> {
    const embedding = this.dependencies.embedding;
    await this.repository.scheduleIndex(
      embedding.modelKey,
      this.clock.now(),
      signal,
    );
    let indexed = 0;
    for (const work of this.repository.indexWork(embedding.modelKey)) {
      signal?.throwIfAborted();
      if (!this.repository.startWork(work.id, this.clock.now())) continue;
      try {
        const chunks = await embedding.splitDocument(work.content, signal);
        signal?.throwIfAborted();
        const vectors = await embedding.embedDocuments(chunks, signal);
        if (
          this.repository.finishIndex(
            work,
            chunks,
            vectors,
            embedding.modelKey,
            embedding.dimensions,
            this.clock.now(),
          )
        )
          indexed += 1;
      } catch (error) {
        if (signal?.aborted)
          this.repository.suspendWork(work.id, this.clock.now());
        else
          this.repository.failWork(
            work.id,
            "embedding_failed",
            this.clock.now(),
          );
        throw error;
      }
    }
    return indexed;
  }

  async recall(
    request: RecallPlan,
    signal?: AbortSignal,
    excludingFormation?: Pick<MemoryFormationEpisode, "id" | "version">,
    allocation?: MemoryRecallOutputAllocation,
    candidateEntityIds: readonly string[] = [],
  ): Promise<EvidencePack> {
    // Host-proposed entities seed relevance; they are not global eligibility.
    const entityCandidates = [...new Set(candidateEntityIds)];
    const validated = parseSchema(RecallPlanSchema, request);
    const ids = [
      ...new Set([
        ...(validated.entityIds ?? []),
        ...this.repository.resolveEntityNames(validated.entityNames ?? []),
      ]),
    ];
    const questions = memoryRecallQuestions(validated);
    const plan: RecallPlan = {
      ...validated,
      questions,
      ...(ids.length ? { entityIds: ids } : {}),
    };
    const references = plan.references ?? [];
    if (references.length && !plan.personaId)
      throw new TypeError("Known memory reads require the active persona");
    if (references.length && !questions.length)
      throw new TypeError("Known memory reads require information questions");
    const result = emptyPack(plan);
    const incompleteBefore = this.incompleteReasons(plan, excludingFormation);
    const now = this.clock.now();
    const budget = plan.contextBudget.maxTokens;
    // Retrieval may inspect more evidence than the final context can carry.
    // This cap bounds candidate material, separately from the full request.
    const candidateBudget =
      allocation?.candidateBudgetTokens ?? Math.min(32_000, budget * 4);
    if (!Number.isSafeInteger(candidateBudget) || candidateBudget < 1)
      throw new RangeError(
        "Memory candidate budget must be a positive integer",
      );
    const candidateLimit = memoryCandidateCapacity(candidateBudget);
    const diagnostics: MemoryRecallDiagnostics = {
      purpose: plan.purpose,
      candidateBudget,
      candidateLimit,
      channels: [],
      fusedCount: 0,
      candidateCount: 0,
      selectorInputs: [],
      selectedCount: 0,
      estimatedOutputTokens: 0,
    };
    const withIncomplete = (pack: EvidencePack): EvidencePack => ({
      ...pack,
      incompleteReasons: [
        ...new Set([
          ...incompleteBefore,
          ...pack.incompleteReasons,
          ...this.incompleteReasons(plan, excludingFormation),
        ]),
      ],
    });
    const finish = (pack: EvidencePack) => {
      diagnostics.selectedCount = pack.items.length;
      diagnostics.estimatedOutputTokens = pack.estimatedTokens;
      this.dependencies.onRecallDiagnostics?.(diagnostics);
      return pack;
    };
    // Even an empty result carries coverage and formation/index gaps. No field
    // may be appended after its consumer has measured the complete wrapper.
    const complete = async () => {
      for (;;) {
        signal?.throwIfAborted();
        const pack = this.repository.transaction(() => withIncomplete(result));
        if (allocation) {
          const fits = await allocation.fits(pack);
          signal?.throwIfAborted();
          const current = this.repository.transaction(() =>
            withIncomplete(result),
          );
          if (JSON.stringify(pack) !== JSON.stringify(current)) continue;
          if (!fits)
            throw new RangeError("当前工作集无法容纳记忆检索结果及其缺口说明");
        }
        return finish(pack);
      }
    };
    if (!questions.length) return complete();
    if (candidateLimit === 0) {
      result.truncated = true;
      return complete();
    }
    const direct = references.length
      ? readRecallReferences(
          this.repository,
          {
            personaId: plan.personaId!,
            references,
            contextBudget: { maxTokens: candidateBudget },
          },
          now,
        )
      : undefined;
    const directIds = new Set(
      direct?.items.map(({ revisionId }) => revisionId),
    );
    if (direct) {
      diagnostics.channels.push({
        channel: "reference",
        returned: direct.items.length,
      });
      result.incompleteReasons.push(
        ...this.repository.unavailableDerivationReasons(
          direct.unavailable.map(({ revisionId }) => revisionId),
          this.clock.now(),
        ),
      );
      for (const ref of direct.unavailable)
        result.incompleteReasons.push(
          `已知记忆引用不可用：${ref.memoryId}/${ref.revisionId}`,
        );
      if (direct.omittedForBudget.length) {
        result.truncated = true;
        result.incompleteReasons.push(
          "部分已知记忆引用超出读取预算，未读取其内容",
        );
      }
    }
    const searchQuestions =
      references.length && !plan.query.trim() ? [] : questions;
    const lists: string[][] = [];
    const expandedIds = new Set<string>();
    for (const question of searchQuestions) {
      signal?.throwIfAborted();
      const lexical = this.repository.lexical(
        question.text,
        plan,
        candidateLimit,
        now,
      );
      lists.push(lexical);
      diagnostics.channels.push({
        questionId: question.id,
        channel: "lexical",
        returned: lexical.length,
      });
      let semantic: string[] = [];
      // The same scoped SQL proves this channel has no searchable rows. Do not
      // start an encoder merely to compare a query against an empty vector set.
      if (
        this.repository.hasIndexedVectors(
          plan,
          this.dependencies.embedding.modelKey,
          now,
        )
      ) {
        const vector = await this.dependencies.embedding.embedQuery(
          question.text,
          signal,
        );
        if (vector.length !== this.dependencies.embedding.dimensions)
          throw new TypeError("Query embedding dimension mismatch");
        const matches = await this.dependencies.vectorSearch.search(
          {
            query: vector,
            plan,
            modelKey: this.dependencies.embedding.modelKey,
            now,
            limit: candidateLimit,
          },
          signal,
        );
        semantic = matches.map(({ id }) => id);
      }
      lists.push(semantic);
      diagnostics.channels.push({
        questionId: question.id,
        channel: "semantic",
        returned: semantic.length,
      });
    }
    if (searchQuestions.length) {
      const structured = this.repository.structured(
        plan,
        candidateLimit,
        now,
        entityCandidates,
      );
      lists.push(structured);
      diagnostics.channels.push({
        channel: "entity_time",
        returned: structured.length,
      });
    }
    const fused = rankFusion(lists);
    diagnostics.fusedCount = fused.length;
    // Preserve the first candidate for each query/channel before filling the
    // remainder, so a single semantic hit cannot disappear behind repeated topics.
    const seeds = [
      ...new Set([
        ...directIds,
        ...lists.flatMap((list) => list.slice(0, 1)),
        ...fused,
      ]),
    ].slice(0, candidateLimit);
    const readEvidence = (ids: readonly string[], maxTokens: number) =>
      this.repository.evidence(
        ids,
        this.clock.now(),
        memoryEvidenceProjection(
          maxTokens,
          ids.length,
          plan.timeScope?.knownAt,
        ),
      );
    let candidates = fitMemoryEvidence(
      readEvidence(seeds, candidateBudget),
      candidateBudget,
    );
    diagnostics.candidateCount = candidates.length;
    if (seeds.length < fused.length) result.truncated = true;
    if (candidates.length < seeds.length) result.truncated = true;
    if (candidates.some((candidate) => !candidate.basis || !candidate.owner))
      result.incompleteReasons.push(
        "部分旧记录的来源语义未分类，不能推定为用户确认",
      );
    if (!candidates.length) return complete();

    const select = () => {
      diagnostics.selectorInputs.push({
        candidateCount: candidates.length,
        estimatedTokens: estimateInputBudget({ plan, candidates })
          .estimatedTokens,
      });
      return this.dependencies.selector.select({ plan, candidates }, signal);
    };
    const questionIds = new Set(questions.map(({ id }) => id));
    const selectedEvidence = (selection: MemorySelection) => {
      const available = new Map(
        candidates.map((candidate) => [candidate.revisionId, candidate]),
      );
      const selected = new Set<string>();
      return selection.selected.map((chosen) => {
        const candidate = available.get(chosen.revisionId);
        if (
          !candidate ||
          selected.has(chosen.revisionId) ||
          chosen.questionIds.length === 0 ||
          chosen.questionIds.some((id) => !questionIds.has(id))
        )
          throw new TypeError(
            "Selector returned an unavailable or duplicate memory reference",
          );
        selected.add(chosen.revisionId);
        return { ...candidate, questionIds: [...new Set(chosen.questionIds)] };
      });
    };
    let selection = await select();
    let ordered = selectedEvidence(selection);
    // A single source/relationship expansion supplies missing supporting
    // context. Further question-driven continuation belongs to the same Run.
    if (
      searchQuestions.length &&
      selection.coverage.some(
        ({ status }) => status === "missing" || status === "partial",
      )
    ) {
      const linked = this.repository.linked(
        candidates.map(({ revisionId }) => revisionId),
        plan,
        candidateLimit,
        now,
      );
      diagnostics.channels.push({
        channel: "relation",
        returned: linked.length,
      });
      const known = new Set(candidates.map(({ revisionId }) => revisionId));
      const selectedIds = new Set(ordered.map(({ revisionId }) => revisionId));
      const retained = candidates.filter(({ revisionId }) =>
        selectedIds.has(revisionId),
      );
      const unselected = candidates.filter(
        ({ revisionId }) => !selectedIds.has(revisionId),
      );
      const neighbors = readEvidence(
        [...new Set(linked)].filter((id) => !known.has(id)),
        candidateBudget,
      );
      // Both lanes keep their existing rank. At each equal rank, unseen linked
      // context gets its turn before an already inspected, unselected candidate.
      const competing: MemoryEvidenceItem[] = [];
      for (
        let index = 0;
        index < Math.max(neighbors.length, unselected.length);
        index += 1
      ) {
        const neighbor = neighbors[index];
        const previous = unselected[index];
        if (neighbor) competing.push(neighbor);
        if (previous) competing.push(previous);
      }
      const expanded = fitMemoryEvidence(
        competing.slice(0, candidateLimit - retained.length),
        candidateBudget,
        retained,
      );
      if (expanded.length < retained.length + competing.length) {
        result.truncated = true;
        result.incompleteReasons.push(
          "关联扩展候选已按上下文预算节选，尚未穷尽相关证据",
        );
      }
      // Unfit neighbors may have displaced old count slots without adding
      // evidence. Keep the original pool and selection unless a new revision
      // was actually admitted; a smaller old-only subset adds no information.
      const hasNewEvidence = expanded.some(
        ({ revisionId }) => !known.has(revisionId),
      );
      if (hasNewEvidence) {
        for (const { revisionId } of expanded)
          if (!known.has(revisionId)) expandedIds.add(revisionId);
        candidates = expanded;
        diagnostics.candidateCount = candidates.length;
        selection = await select();
        ordered = selectedEvidence(selection);
      }
    }
    signal?.throwIfAborted();
    const available = new Map(
      candidates.map((candidate) => [candidate.revisionId, candidate]),
    );
    const questionFirst = [
      ...new Set([
        ...questions.flatMap(
          ({ id }) =>
            ordered.find((item) => item.questionIds.includes(id)) ?? [],
        ),
        ...ordered,
      ]),
    ];
    const coverageMap = new Map(
      selection.coverage.map((coverage) => [coverage.questionId, coverage]),
    );
    if (
      coverageMap.size !== questions.length ||
      selection.coverage.length !== questions.length ||
      selection.coverage.some(({ questionId }) => !questionIds.has(questionId))
    )
      throw new TypeError(
        "Selector did not assess each recall question exactly once",
      );
    for (const coverage of selection.coverage)
      if (
        new Set(coverage.revisionIds).size !== coverage.revisionIds.length ||
        coverage.revisionIds.some((revisionId) => !available.has(revisionId))
      )
        throw new TypeError("Coverage refers to unavailable evidence");

    // Each read owns a synchronous transaction. No transaction spans an awaited
    // count. The second read checks the same selected revisions, never reruns a
    // Selector or substitutes a newer revision for its earlier selection.
    const readFinal = () =>
      this.repository.transaction(() => {
        const fresh = new Map(
          readEvidence(
            ordered.map(({ revisionId }) => revisionId),
            allocation ? candidateBudget : budget,
          ).map((item) => [item.revisionId, item]),
        );
        const stillEligible = this.repository.eligibleIds(
          ordered
            .filter(
              ({ revisionId }) =>
                !expandedIds.has(revisionId) && !directIds.has(revisionId),
            )
            .map(({ revisionId }) => revisionId),
          {
            ...plan,
            timeScope: { ...plan.timeScope, includeSuperseded: true },
          },
          this.clock.now(),
        );
        for (const id of this.repository.eligibleIds(
          ordered
            .filter(({ revisionId }) => expandedIds.has(revisionId))
            .map(({ revisionId }) => revisionId),
          memoryExpansionPlan(plan),
          this.clock.now(),
        ))
          stillEligible.add(id);
        const reasons = [...result.incompleteReasons];
        if (direct) {
          const unavailable = this.repository.validateEvidenceReferences(
            { personaId: plan.personaId!, references },
            this.clock.now(),
          );
          for (const ref of references)
            if (directIds.has(ref.revisionId) && !unavailable.includes(ref))
              stillEligible.add(ref.revisionId);
          if (unavailable.some(({ revisionId }) => directIds.has(revisionId)))
            reasons.push("读取期间已知记忆引用已改变，未替换为其它版本");
        }
        const items = questionFirst.flatMap((item) => {
          const current = fresh.get(item.revisionId);
          const becameHistorical =
            item.current &&
            current &&
            !current.current &&
            !references.some(
              (ref) =>
                ref.revisionId === item.revisionId && ref.use === "history",
            ) &&
            !plan.timeScope?.includeSuperseded &&
            !plan.timeScope?.knownAt;
          return current &&
            stillEligible.has(item.revisionId) &&
            !becameHistorical
            ? [{ ...current, questionIds: item.questionIds }]
            : [];
        });
        return {
          items,
          incompleteReasons: reasons,
          incompleteNow: this.incompleteReasons(plan, excludingFormation),
          changed: ordered.some(
            (item) =>
              !fresh.has(item.revisionId) ||
              (item.current && !fresh.get(item.revisionId)?.current),
          ),
        };
      });
    const buildPack = (
      items: MemoryEvidenceItem[],
      state: ReturnType<typeof readFinal>,
    ): EvidencePack => {
      const kept = new Map(items.map((item) => [item.revisionId, item]));
      const coverage = questions.map(({ id }) => {
        const selected = coverageMap.get(id)!;
        const revisionIds = selected.revisionIds.filter((revisionId) =>
          kept.get(revisionId)?.questionIds.includes(id),
        );
        const status =
          revisionIds.length === 0
            ? ("missing" as const)
            : revisionIds.length < selected.revisionIds.length &&
                selected.status === "supported"
              ? ("partial" as const)
              : selected.status;
        return { questionId: id, status, revisionIds };
      });
      const sourceTruncated = items.some(
        (item) =>
          (item.sourceCount ?? item.sourceRefs.length) > item.sourceRefs.length,
      );
      const deliveryOmitted =
        allocation !== undefined && items.length < state.items.length;
      const incompleteReasons = [
        ...incompleteBefore,
        ...state.incompleteReasons,
      ];
      if (sourceTruncated)
        incompleteReasons.push(
          "来源引用已按上下文预算节选，完整来源保留在记忆详情",
        );
      if (items.length < ordered.length && state.changed)
        incompleteReasons.push("检索期间相关记忆已改变，需重新核对当前事实");
      if (deliveryOmitted)
        incompleteReasons.push(
          "已检索，但部分记忆证据因当前工作集空间未供给；不能据此判断记忆不存在",
        );
      return {
        items,
        coverage,
        gaps: coverage
          .filter(({ status }) => status !== "supported")
          .map(({ questionId, status }) => ({
            questionId,
            reason:
              status === "conflicting"
                ? "相关记录存在尚未解决的冲突"
                : status === "partial"
                  ? "当前证据未覆盖问题的全部要点"
                  : allocation &&
                      state.items.some(
                        (item) =>
                          item.questionIds.includes(questionId) &&
                          !kept.has(item.revisionId),
                      )
                    ? "已检索，但本次未能供给相关记忆证据"
                    : "没有足够的相关证据",
          })),
        estimatedTokens: estimatedTokens(items),
        truncated:
          result.truncated || sourceTruncated || items.length < ordered.length,
        incompleteReasons: [
          ...new Set([...incompleteReasons, ...state.incompleteNow]),
        ],
      };
    };
    for (;;) {
      signal?.throwIfAborted();
      const state = readFinal();
      // Other consumers retain the existing numeric projection without consumer
      // measurements. The Tool consumer first tries its full bounded projection
      // without an items-only estimate veto, then uses evidenceFitSteps.
      if (!allocation)
        return finish(buildPack(fitMemoryEvidence(state.items, budget), state));
      let accepted: EvidencePack | undefined;
      let lastMeasuredItems: MemoryEvidenceItem[] | undefined;
      const accepts = async (items: MemoryEvidenceItem[]) => {
        const pack = buildPack(items, state);
        const fits = await allocation.fits(pack);
        signal?.throwIfAborted();
        lastMeasuredItems = items;
        if (fits) {
          accepted = pack;
        }
        return fits;
      };
      const full = state.items.map((item) => ({
        ...item,
        sourceCount: item.sourceCount ?? item.sourceRefs.length,
        sourceRefs: [...item.sourceRefs],
      }));
      if (!(await accepts(full))) {
        const steps = evidenceFitSteps(state.items);
        let step = steps.next();
        while (!step.done) step = steps.next(await accepts(step.value));
        // A rejected later trial may have observed new steering/less space.
        // Recheck the chosen subset against that current workset before return.
        if (step.value !== lastMeasuredItems) {
          const hadAcceptedSubset = accepted !== undefined;
          if (!(await accepts(step.value))) {
            accepted = undefined;
            if (hadAcceptedSubset) continue;
          }
        }
      }
      // Qualification, history status, visible source/derivation projection and
      // incomplete reasons are reread after the final await, even on rejection.
      const current = readFinal();
      if (JSON.stringify(state) !== JSON.stringify(current)) continue;
      if (!accepted)
        throw new RangeError("当前工作集无法容纳记忆检索结果及其缺口说明");
      return finish(accepted);
    }
  }
}
