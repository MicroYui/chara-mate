import type {
  MemoryCandidate,
  MemoryCreateRequest,
  MemoryDetail,
  MemoryHit,
  MemoryListRequest,
  MemoryProposalInput,
  MemoryReviseRequest,
  MemorySnapshot,
  MemorySource,
} from "../../shared/contracts/memory";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import type { MemoryRepository } from "./memoryRepository";
import type { RetrievalPipeline } from "./retrievalPipeline";

function redactSources(sources: readonly MemorySource[]): MemorySource[] {
  return sources.map((source) => ({
    ...source,
    ...(source.label ? { label: redactText(source.label) } : {}),
  }));
}

export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly retrieval: RetrievalPipeline,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

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

  search(
    request: MemoryListRequest,
    consumer: "context" | "tool",
    limit: number,
  ): MemoryHit[] {
    const hits = this.retrieval.search(
      {
        ...request,
        includeDeleted: false,
        includeInactive: false,
        status: "active",
      },
      limit,
    );
    const usedAt = this.clock.now();
    this.repository.recordUsages(
      hits.map((hit) => ({
        consumer,
        id: this.ids.generate(),
        memoryId: hit.memory.id,
        revisionId: hit.revision.id,
        usedAt,
      })),
    );
    return hits;
  }

  get(memoryId: string): MemoryDetail {
    return this.repository.requireDetail(memoryId);
  }

  create(request: MemoryCreateRequest): MemoryDetail {
    return this.repository.create({
      ...request,
      content: redactText(request.content),
      memoryId: this.ids.generate(),
      now: this.clock.now(),
      reason: redactText(request.reason),
      revisionId: this.ids.generate(),
      sources: redactSources(request.sources),
    });
  }

  revise(request: MemoryReviseRequest): MemoryDetail {
    return this.repository.revise({
      ...request,
      content: redactText(request.content),
      now: this.clock.now(),
      reason: redactText(request.reason),
      revisionId: this.ids.generate(),
      sources: redactSources(request.sources),
    });
  }

  setPinned(memoryId: string, pinned: boolean): MemoryDetail {
    return this.repository.setPinned(memoryId, pinned, this.clock.now());
  }

  archive(memoryId: string): MemoryDetail {
    return this.repository.archive(memoryId, this.clock.now());
  }

  delete(memoryId: string): MemoryDetail {
    return this.repository.softDelete(memoryId, this.clock.now());
  }

  restore(memoryId: string): MemoryDetail {
    return this.repository.restore(memoryId, this.clock.now());
  }

  purge(memoryId: string): void {
    this.repository.purge(memoryId);
  }

  propose(input: MemoryProposalInput): MemoryCandidate {
    if (input.sourceIds.length !== input.sourceLabels.length) {
      throw new TypeError("Memory candidate sources and labels must align");
    }
    return this.repository.propose({
      ...input,
      candidateId: this.ids.generate(),
      content: redactText(input.content),
      now: this.clock.now(),
      reason: redactText(input.reason),
      sourceLabels: input.sourceLabels.map(redactText),
    });
  }

  hasCandidateReason(reason: string): boolean {
    return this.repository.hasCandidateReason(reason);
  }

  acceptCandidate(candidateId: string): MemoryDetail {
    const candidate = this.repository.requireCandidate(candidateId);
    const now = this.clock.now();
    return this.repository.acceptCandidate(candidateId, {
      confidence: candidate.confidence,
      content: candidate.content,
      importance: candidate.importance,
      memoryId: this.ids.generate(),
      now,
      reason: candidate.reason,
      revisionId: this.ids.generate(),
      sources: candidate.sourceIds.map((referenceId, index) => ({
        createdAt: now,
        id: this.ids.generate(),
        label: candidate.sourceLabels[index] ?? "活动摘要证据",
        referenceId,
        type: candidate.sourceType,
      })),
      ...(candidate.supersedesMemoryId
        ? { supersedesMemoryId: candidate.supersedesMemoryId }
        : {}),
      type: candidate.type,
      ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
      ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
    });
  }

  rejectCandidate(candidateId: string): MemoryCandidate {
    return this.repository.rejectCandidate(candidateId, this.clock.now());
  }

  discardPendingCandidate(candidateId: string): boolean {
    return this.repository.discardPendingCandidate(candidateId);
  }
}
