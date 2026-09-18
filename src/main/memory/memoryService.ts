import type {
  MemoryCandidate,
  MemoryClaimSlot,
  MemoryCreateRequest,
  MemoryDetail,
  MemoryListRequest,
  MemoryProposalInput,
  MemoryReviseRequest,
  MemorySnapshot,
  MemorySource,
  MemoryType,
} from "../../shared/contracts/memory";
import type {
  EvidencePack,
  MemoryCanonicalSourceCandidate,
  MemoryCanonicalStorageStats,
  MemoryEvidenceReadRequest,
  MemoryEvidenceReference,
  MemoryEvidenceReferenceRequest,
  MemoryEvidenceResolution,
  MemoryFormationIntake,
  MemoryFormationWorkRef,
  MemoryFormationSource,
  RecallPlan,
} from "../../shared/contracts/memoryRecall";
import {
  MemoryFormationService,
  type MemoryEpisodeFormationResult,
} from "./memoryFormationService";
import {
  MemoryConsolidationService,
  type MemoryConsolidationRuntime,
} from "./memoryConsolidation";
import type { MemoryFormationRuntime } from "./memoryModels";
import {
  resolveMemoryEvidence,
  MemoryRecallPipeline,
  type MemoryRecallDependencies,
  type MemoryRecallOutputAllocation,
} from "./memoryRecallPipeline";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import { isTimeZoneId, isUtcTimestamp } from "../../shared/schemas/primitives";
import { memoryClaimDefinition } from "./memoryClaim";
import { MemoryError } from "./memoryError";
import type { MemoryRepository } from "./memoryRepository";
import type { RetrievalPipeline } from "./retrievalPipeline";
import type { ProviderRequestIdentity } from "../providers/providerError";

export interface MemoryProviderRecovery {
  readonly formationProcessorVersion: string;
  readonly consolidationProcessorVersion: string;
  readonly requestIdentity: ProviderRequestIdentity;
}

interface RevisionMetadataInput {
  readonly importantMoment?: boolean;
  readonly occursAt?: string | null;
  readonly timeZone?: string | null;
}

interface ResolvedRevisionMetadata {
  readonly importantMoment: boolean;
  readonly occursAt?: string;
  readonly timeZone?: string;
}

function revisionMetadataInput(input: object): RevisionMetadataInput {
  const importantMoment =
    "importantMoment" in input ? input.importantMoment : undefined;
  const occursAt = "occursAt" in input ? input.occursAt : undefined;
  const timeZone = "timeZone" in input ? input.timeZone : undefined;
  return {
    ...(typeof importantMoment === "boolean" ? { importantMoment } : {}),
    ...(typeof occursAt === "string" || occursAt === null ? { occursAt } : {}),
    ...(typeof timeZone === "string" || timeZone === null ? { timeZone } : {}),
  };
}

function resolvedRevisionMetadata(
  input: RevisionMetadataInput,
): ResolvedRevisionMetadata {
  return {
    importantMoment: input.importantMoment ?? false,
    ...(typeof input.occursAt === "string" && typeof input.timeZone === "string"
      ? { occursAt: input.occursAt, timeZone: input.timeZone }
      : {}),
  };
}

function resolveRevisionMetadata(
  type: MemoryType,
  input: RevisionMetadataInput,
  current?: ResolvedRevisionMetadata,
): ResolvedRevisionMetadata {
  const supportsEventTime = type === "event" || type === "commitment";
  if (!supportsEventTime && input.importantMoment) {
    throw new MemoryError(
      "MEMORY.CONFLICT",
      "只有事件或承诺可以标记为重要时刻。",
      false,
    );
  }
  if (
    !supportsEventTime &&
    (input.occursAt !== undefined || input.timeZone !== undefined)
  ) {
    throw new MemoryError(
      "MEMORY.CONFLICT",
      "只有事件或承诺可以记录发生时间。",
      false,
    );
  }
  if ((input.occursAt === undefined) !== (input.timeZone === undefined)) {
    throw new TypeError("occursAt and timeZone must be provided together");
  }
  if ((input.occursAt === null) !== (input.timeZone === null)) {
    throw new TypeError("occursAt and timeZone must be cleared together");
  }

  const importantMoment = supportsEventTime
    ? (input.importantMoment ?? current?.importantMoment ?? false)
    : false;
  if (input.occursAt === undefined && input.timeZone === undefined) {
    return {
      importantMoment,
      ...(current?.occursAt && current.timeZone
        ? { occursAt: current.occursAt, timeZone: current.timeZone }
        : {}),
    };
  }
  if (input.occursAt === null && input.timeZone === null) {
    return { importantMoment };
  }
  if (
    typeof input.occursAt !== "string" ||
    typeof input.timeZone !== "string"
  ) {
    throw new TypeError("occursAt and timeZone must be strings");
  }
  if (!isUtcTimestamp(input.occursAt)) {
    throw new TypeError("occursAt must be a canonical UTC timestamp");
  }
  if (!isTimeZoneId(input.timeZone)) {
    throw new TypeError("timeZone must be recognized by the packaged runtime");
  }
  return {
    importantMoment,
    occursAt: input.occursAt,
    timeZone: input.timeZone,
  };
}

function redactSources(sources: readonly MemorySource[]): MemorySource[] {
  return sources.map((source) => ({
    ...source,
    ...(source.label ? { label: redactText(source.label) } : {}),
  }));
}

export interface MemoryCognitionDependencies extends MemoryRecallDependencies {
  readonly formation: MemoryFormationRuntime;
  readonly consolidation?: MemoryConsolidationRuntime;
  readonly formationContextBudget: () => { maxTokens: number };
  readonly formationResourceBudget: { maxReadBytes: number };
}

export class MemoryService {
  readonly #recall: MemoryRecallPipeline | undefined;
  readonly #formation: MemoryFormationService | undefined;
  readonly #consolidation: MemoryConsolidationService | undefined;
  #changed: (memoryId: string) => void = () => undefined;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly retrieval: RetrievalPipeline,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly cognition?: MemoryCognitionDependencies,
  ) {
    if (cognition) {
      this.#recall = new MemoryRecallPipeline(
        repository.recall,
        cognition,
        clock,
      );
      if (cognition.consolidation)
        this.#consolidation = new MemoryConsolidationService(
          repository,
          this.#recall,
          cognition.consolidation,
          ids,
          clock,
          cognition.formationContextBudget,
        );
      this.#formation = new MemoryFormationService(
        repository,
        this.#recall,
        cognition.formation,
        ids,
        clock,
        cognition.formationContextBudget,
        cognition.formationResourceBudget,
      );
    }
  }

  #publishChange(memoryId: string): void {
    this.repository.learning.enqueue(memoryId, this.clock.now());
    this.#changed(memoryId);
  }

  async consolidatePending(
    signal?: AbortSignal,
    onError?: (error: unknown) => void,
    onDeferred?: () => void,
  ): Promise<number> {
    if (!this.#consolidation) return 0;
    const results = await this.#consolidation.drain(
      signal,
      (memoryId) => this.#publishChange(memoryId),
      onError,
      onDeferred,
    );
    return results.filter(({ disposition }) => disposition === "consolidated")
      .length;
  }

  retryFailedConsolidationWork(): void {
    this.repository.learning.retry(this.clock.now());
  }

  async recall(
    plan: RecallPlan,
    signal?: AbortSignal,
    consumer: "context" | "tool" = "context",
    allocation?: MemoryRecallOutputAllocation,
  ): Promise<EvidencePack> {
    if (!this.#recall)
      throw new Error("Memory recall dependencies are not configured");
    const evidence = await this.#recall.recall(
      plan,
      signal,
      undefined,
      allocation,
    );
    signal?.throwIfAborted();
    this.repository.recordUsages(
      evidence.items.map((item) => ({
        consumer,
        id: this.ids.generate(),
        memoryId: item.memoryId,
        revisionId: item.revisionId,
        usedAt: this.clock.now(),
      })),
    );
    signal?.throwIfAborted();
    return evidence;
  }

  validateEvidenceReferences(
    request: MemoryEvidenceReferenceRequest,
  ): MemoryEvidenceReference[] {
    return this.repository.recall.validateEvidenceReferences(
      request,
      this.clock.now(),
    );
  }

  resolveEvidence(
    request: MemoryEvidenceReadRequest,
  ): MemoryEvidenceResolution {
    return resolveMemoryEvidence(
      this.repository.recall,
      request,
      this.clock.now(),
    );
  }

  enqueueEpisode(episode: MemoryFormationIntake): MemoryFormationWorkRef {
    if (!this.#formation)
      throw new Error("Memory formation dependencies are not configured");
    return this.#formation.enqueue(episode);
  }

  pendingFormationWork(): Iterable<MemoryFormationWorkRef> {
    return this.repository.formation.pendingWork();
  }

  nextReclaimableSource(
    afterSourceId?: string,
  ): MemoryCanonicalSourceCandidate | undefined {
    return this.repository.formation.nextReclaimableSource(afterSourceId);
  }

  releaseCanonicalSource(sourceId: string): boolean {
    return this.repository.formation.releaseCanonicalSource(sourceId);
  }

  canonicalStorageStats(): MemoryCanonicalStorageStats {
    return this.repository.formation.canonicalStorageStats();
  }

  protectedActivitySourceIds(eventIds: readonly string[]): ReadonlySet<string> {
    return this.repository.formation.protectedActivitySourceIds(eventIds);
  }

  getFormationSourceMetadata(
    sourceId: string,
  ): Omit<MemoryFormationSource, "content"> | undefined {
    return this.repository.formation.getSourceMetadata(sourceId);
  }

  formationReceipt(workId: string): MemoryEpisodeFormationResult | undefined {
    if (!this.#formation)
      throw new Error("Memory formation dependencies are not configured");
    return this.#formation.receipt(workId);
  }

  getFormationSource(
    type: MemoryFormationSource["type"],
    referenceId: string,
  ): MemoryFormationSource | undefined {
    return this.repository.formation.getFormationSource(type, referenceId);
  }

  snapshottedActivitySourceIds(
    eventIds: readonly string[],
  ): ReadonlySet<string> {
    return this.repository.formation.snapshottedActivitySourceIds(eventIds);
  }

  async formEpisode(
    workId: string,
    signal?: AbortSignal,
  ): Promise<MemoryEpisodeFormationResult> {
    if (!this.#formation)
      throw new Error("Memory formation dependencies are not configured");
    const result = await this.#formation.form(workId, signal);
    for (const memoryId of new Set(
      result.changes.map((change) => change.memoryId),
    ))
      this.#publishChange(memoryId);
    return result;
  }

  indexPending(signal?: AbortSignal): Promise<number> {
    if (!this.#recall)
      throw new Error("Memory recall dependencies are not configured");
    return this.#recall.indexPending(signal);
  }

  recoverInterruptedWork(): void {
    this.repository.recall.recoverWork(this.clock.now());
    this.repository.formation.recover(this.clock.now());
    this.#formation?.recoverForCurrentProcessor();
    this.repository.learning.recover(this.clock.now());
    this.#consolidation?.recoverForCurrentProcessor();
  }

  retryFailedIndex(): void {
    if (!this.cognition)
      throw new Error("Memory recall dependencies are not configured");
    this.repository.recall.retryFailedIndex(
      this.cognition.embedding.modelKey,
      this.clock.now(),
    );
  }

  retryFailedFormationWork(workId?: string): void {
    this.repository.formation.retryFailed(this.clock.now(), workId);
  }

  recoverProviderFailures(recovery: MemoryProviderRecovery): number {
    return (
      (this.#formation?.recoverProviderFailures(
        recovery.formationProcessorVersion,
      ) ?? 0) +
      (this.#consolidation?.recoverProviderFailures(
        recovery.consolidationProcessorVersion,
        recovery.requestIdentity,
      ) ?? 0)
    );
  }

  setChangedListener(listener: (memoryId: string) => void): void {
    this.#changed = listener;
  }

  list(request: MemoryListRequest): MemorySnapshot {
    const memories = this.retrieval.search(request);
    const profile = request.asOf
      ? this.retrieval.search({
          asOf: request.asOf,
          includeDeleted: false,
          status: "active",
          type: "profile",
        })
      : this.repository.profileHits();
    return {
      candidates: request.asOf ? [] : this.repository.listPendingCandidates(),
      memories,
      profile,
    };
  }

  get(memoryId: string): MemoryDetail {
    return this.repository.requireDetail(memoryId);
  }

  findBySourceReference(referenceId: string): MemoryDetail | undefined {
    return this.repository.findDetailBySourceReference(referenceId);
  }

  create(request: MemoryCreateRequest): MemoryDetail {
    if (
      request.claimSlot &&
      memoryClaimDefinition(request.claimSlot).type !== request.type
    ) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "记忆类型与稳定字段不一致。",
        false,
      );
    }
    const revisionMetadata = resolveRevisionMetadata(
      request.type,
      revisionMetadataInput(request),
    );
    const created = this.repository.create({
      ...request,
      content: redactText(request.content),
      ...revisionMetadata,
      memoryId: this.ids.generate(),
      now: this.clock.now(),
      reason: redactText(request.reason),
      revisionId: this.ids.generate(),
      sources: redactSources(request.sources),
    });
    this.#publishChange(created.memory.id);
    return created;
  }

  revise(request: MemoryReviseRequest): MemoryDetail {
    const revised = this.repository.recall.transaction(() => {
      const current = this.repository.requireDetail(request.memoryId);
      const currentRevision = current.revisions.find(
        ({ id }) => id === current.memory.currentRevisionId,
      );
      if (!currentRevision) {
        throw new TypeError("Current memory revision is unavailable");
      }
      const now = this.clock.now();
      const previous = this.repository.recall.revisionScope(
        current.memory.currentRevisionId,
      );
      const revisionMetadata = resolveRevisionMetadata(
        current.memory.type,
        revisionMetadataInput(request),
        resolvedRevisionMetadata(currentRevision),
      );
      const detail = this.repository.revise({
        predecessorRevisionId: currentRevision.id,
        priorDispositions: [
          { revisionId: currentRevision.id, disposition: "unresolved" },
        ],
        ...(request.confidence === undefined
          ? {}
          : { confidence: request.confidence }),
        content: redactText(request.content),
        ...revisionMetadata,
        ...(request.importance === undefined
          ? {}
          : { importance: request.importance }),
        memoryId: request.memoryId,
        now,
        reason: redactText(request.reason),
        revisionId: this.ids.generate(),
        sources: redactSources(request.sources),
        ...(request.validFrom ? { validFrom: request.validFrom } : {}),
        ...(request.validTo ? { validTo: request.validTo } : {}),
      });
      if (previous) {
        // Manual editing changes the record; its prior truth remains unresolved.
        // Keep the known owner,
        // never the old inference, Tool success, entities or commitment state.
        // Explicit calendar fields remain owned by revisionMetadata above;
        // semantic validity changes only when this request supplies it.
        this.repository.recall.putSemantics(
          detail.memory.currentRevisionId,
          {
            kind: "claim",
            owner: previous.owner,
            ...(previous.owner === "character" && previous.personaId
              ? { personaId: previous.personaId }
              : {}),
            basis: "explicit_user_statement",
            qualifiers: { authoring: "user_edit" },
            ...(request.validFrom ? { validFrom: request.validFrom } : {}),
            ...(request.validTo ? { validTo: request.validTo } : {}),
          },
          [],
        );
      }
      return detail;
    });
    this.#publishChange(revised.memory.id);
    return revised;
  }

  setPinned(memoryId: string, pinned: boolean): MemoryDetail {
    return this.repository.setPinned(memoryId, pinned, this.clock.now());
  }

  archive(memoryId: string): MemoryDetail {
    const archived = this.repository.archive(memoryId, this.clock.now());
    this.#publishChange(memoryId);
    return archived;
  }

  delete(memoryId: string): MemoryDetail {
    const deleted = this.repository.softDelete(memoryId, this.clock.now());
    this.#publishChange(memoryId);
    return deleted;
  }

  restore(memoryId: string): MemoryDetail {
    const restored = this.repository.restore(memoryId, this.clock.now());
    this.#publishChange(memoryId);
    return restored;
  }

  purge(memoryId: string): void {
    this.repository.purge(memoryId);
    this.#publishChange(memoryId);
  }

  propose(input: MemoryProposalInput): MemoryCandidate {
    if (input.sourceIds.length !== input.sourceLabels.length) {
      throw new TypeError("Memory candidate sources and labels must align");
    }
    const superseded = input.supersedesMemoryId
      ? this.repository.getDetail(input.supersedesMemoryId, false)
      : undefined;
    const currentRevision = superseded?.revisions.find(
      ({ id }) => id === superseded.memory.currentRevisionId,
    );
    const revisionMetadata = resolveRevisionMetadata(
      input.type,
      revisionMetadataInput(input),
      currentRevision ? resolvedRevisionMetadata(currentRevision) : undefined,
    );
    return this.repository.propose({
      ...input,
      candidateId: this.ids.generate(),
      content: redactText(input.content),
      ...revisionMetadata,
      now: this.clock.now(),
      reason: redactText(input.reason),
      sourceLabels: input.sourceLabels.map(redactText),
    });
  }

  acceptCandidate(candidateId: string): MemoryDetail {
    const candidate = this.repository.requireCandidate(candidateId);
    const candidateMetadata = resolvedRevisionMetadata(
      revisionMetadataInput(candidate),
    );
    const now = this.clock.now();
    const sources = candidate.sourceIds.map((referenceId, index) => ({
      createdAt: now,
      id: this.ids.generate(),
      label: candidate.sourceLabels[index] ?? "记忆候选证据",
      referenceId,
      type: candidate.sourceType,
    }));
    if (candidate.claimOperation && candidate.supersedesMemoryId) {
      const predecessorRevisionId = this.repository.requireDetail(
        candidate.supersedesMemoryId,
      ).memory.currentRevisionId;
      const accepted = this.repository.acceptCandidateAsRevision(
        candidateId,
        {
          predecessorRevisionId,
          priorDispositions: [
            { revisionId: predecessorRevisionId, disposition: "unresolved" },
          ],
          confidence: candidate.confidence,
          content: candidate.content,
          importance: candidate.importance,
          memoryId: candidate.supersedesMemoryId,
          now,
          importantMoment: candidateMetadata.importantMoment,
          reason: candidate.reason,
          revisionId: this.ids.generate(),
          sources,
          ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
          ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
          ...(candidateMetadata.occursAt && candidateMetadata.timeZone
            ? {
                occursAt: candidateMetadata.occursAt,
                timeZone: candidateMetadata.timeZone,
              }
            : {}),
        },
        candidate.claimSlot,
      );
      this.#publishChange(accepted.memory.id);
      return accepted;
    }
    if (
      candidate.claimSlot &&
      memoryClaimDefinition(candidate.claimSlot).type !== candidate.type
    ) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "候选类型与稳定字段不一致。",
        false,
      );
    }
    const accepted = this.repository.acceptCandidate(candidateId, {
      ...(candidate.claimSlot ? { claimSlot: candidate.claimSlot } : {}),
      confidence: candidate.confidence,
      content: candidate.content,
      importance: candidate.importance,
      importantMoment: candidateMetadata.importantMoment,
      memoryId: this.ids.generate(),
      now,
      reason: candidate.reason,
      revisionId: this.ids.generate(),
      sources,
      ...(candidate.supersedesMemoryId
        ? { supersedesMemoryId: candidate.supersedesMemoryId }
        : {}),
      type: candidate.type,
      ...(candidateMetadata.occursAt && candidateMetadata.timeZone
        ? {
            occursAt: candidateMetadata.occursAt,
            timeZone: candidateMetadata.timeZone,
          }
        : {}),
      ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
      ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
    });
    this.#publishChange(accepted.memory.id);
    return accepted;
  }

  rejectCandidate(candidateId: string): MemoryCandidate {
    return this.repository.rejectCandidate(candidateId, this.clock.now());
  }

  confirmPreference(input: {
    readonly claimSlot: Extract<MemoryClaimSlot, `preference.${string}`>;
    readonly content: string;
    readonly reason: string;
    readonly sources: readonly MemorySource[];
  }): MemoryDetail {
    let current = this.repository.findDetailByClaimSlot(input.claimSlot);
    if (
      current &&
      (current.memory.deletedAt || current.memory.status === "archived")
    ) {
      current = this.restore(current.memory.id);
    }
    if (
      current &&
      !current.memory.deletedAt &&
      current.memory.status === "active"
    ) {
      return this.revise({
        confidence: 1,
        content: input.content,
        importance: current.memory.importance,
        memoryId: current.memory.id,
        reason: input.reason,
        sources: [...input.sources],
      });
    }
    if (current) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "Persona 偏好字段当前绑定到不可编辑的旧记忆。",
        false,
      );
    }
    return this.create({
      claimSlot: input.claimSlot,
      confidence: 1,
      content: input.content,
      importance: 0.5,
      reason: input.reason,
      sources: [...input.sources],
      type: "preference",
    });
  }

  discardPendingCandidate(candidateId: string): boolean {
    return this.repository.discardPendingCandidate(candidateId);
  }
}
