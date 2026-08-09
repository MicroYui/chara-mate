import type {
  MemoryCandidate,
  MemoryClaimOperation,
  MemoryClaimSlot,
  MemoryCreateRequest,
  MemoryDetail,
  MemoryHit,
  MemoryListRequest,
  MemoryProposalInput,
  MemoryReviseRequest,
  MemorySnapshot,
  MemorySource,
  MemorySourceType,
  MemoryType,
} from "../../shared/contracts/memory";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import { memoryClaimDefinition } from "./memoryClaim";
import { MemoryError } from "./memoryError";
import type { MemoryRepository } from "./memoryRepository";
import type { RetrievalPipeline } from "./retrievalPipeline";

export type MemoryFormationBasis =
  "explicit_user_statement" | "inference" | "run_observation";

interface MemoryFormationBase {
  readonly allowedMemoryIds: readonly string[];
  readonly basis: MemoryFormationBasis;
  readonly content: string;
  readonly memoryId?: string;
  readonly operation: MemoryClaimOperation;
  readonly source: {
    readonly id: string;
    readonly label: string;
    readonly referenceId: string;
    readonly type: Extract<MemorySourceType, "chat" | "tool" | "voice">;
  };
  readonly validFrom?: string;
  readonly validTo?: string;
}

export type MemoryFormationInput = MemoryFormationBase &
  (
    | { readonly claimSlot: MemoryClaimSlot; readonly type?: never }
    | {
        readonly claimSlot?: never;
        readonly type: Extract<
          MemoryType,
          "commitment" | "event" | "procedure" | "project"
        >;
      }
  );

export type MemoryFormationResult =
  | {
      readonly memoryId: string;
      readonly outcome: "created" | "duplicate" | "revised";
      readonly revisionId: string;
    }
  | {
      readonly candidateId: string;
      readonly outcome: "candidate_created" | "candidate_duplicate";
    };

function normalizeFormedContent(content: string): string {
  return redactText(content).normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
}

function formationReason(basis: MemoryFormationBasis): string {
  switch (basis) {
    case "explicit_user_statement":
      return "用户在当前对话中明确说明";
    case "inference":
      return "当前对话中的推断，等待用户确认";
    case "run_observation":
      return "当前 Agent Run 的执行观察，等待用户确认";
  }
}

type FormationCandidateCause =
  | "ambiguous_identity"
  | "basis"
  | "collision"
  | "legacy_binding"
  | "missing_target"
  | "single_value_operation";

function formationCandidateReason(
  basis: MemoryFormationBasis,
  cause: FormationCandidateCause,
): string {
  if (cause === "basis") return formationReason(basis);
  switch (cause) {
    case "ambiguous_identity":
      return "本轮已加载其他同类稳定字段，等待确认这是新增字段而不是改口";
    case "collision":
      return "同一稳定字段已有不同内容，等待用户确认更新";
    case "legacy_binding":
      return "旧记忆尚未绑定稳定字段，等待用户确认后更新";
    case "missing_target":
      return "跨 Chat 更新未取得本轮合法目标，等待用户确认";
    case "single_value_operation":
      return "单值字段不能追加或移除，等待用户确认替换语义";
  }
}

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

  create(
    request: MemoryCreateRequest & { readonly claimSlot?: MemoryClaimSlot },
  ): MemoryDetail {
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
    const sources = candidate.sourceIds.map((referenceId, index) => ({
      createdAt: now,
      id: this.ids.generate(),
      label: candidate.sourceLabels[index] ?? "记忆候选证据",
      referenceId,
      type: candidate.sourceType,
    }));
    if (candidate.claimOperation && candidate.supersedesMemoryId) {
      return this.repository.acceptCandidateAsRevision(
        candidateId,
        {
          confidence: candidate.confidence,
          content: candidate.content,
          importance: candidate.importance,
          memoryId: candidate.supersedesMemoryId,
          now,
          reason: candidate.reason,
          revisionId: this.ids.generate(),
          sources,
          ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
          ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
        },
        candidate.claimSlot,
      );
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
    return this.repository.acceptCandidate(candidateId, {
      ...(candidate.claimSlot ? { claimSlot: candidate.claimSlot } : {}),
      confidence: candidate.confidence,
      content: candidate.content,
      importance: candidate.importance,
      memoryId: this.ids.generate(),
      now,
      reason: candidate.reason,
      revisionId: this.ids.generate(),
      sources,
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

  form(input: MemoryFormationInput): MemoryFormationResult {
    const content = normalizeFormedContent(input.content);
    if (!content) {
      throw new TypeError("Formed memory content must not be blank");
    }
    const direct = input.basis === "explicit_user_statement";
    const definition = input.claimSlot
      ? memoryClaimDefinition(input.claimSlot)
      : undefined;
    const type = definition?.type ?? input.type;
    if (!type) throw new TypeError("Memory formation type is unavailable");
    if (input.operation === "create" && input.memoryId) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "新建稳定事实时不能指定旧记忆 ID。",
        false,
      );
    }

    let providedTarget: MemoryDetail | undefined;
    if (input.memoryId) {
      if (!new Set(input.allowedMemoryIds).has(input.memoryId)) {
        throw new MemoryError(
          "MEMORY.CONFLICT",
          "模型提交的记忆不在当前 Run 的合法候选中。",
          false,
        );
      }
      providedTarget = this.repository.requireDetail(input.memoryId);
      if (
        providedTarget.memory.deletedAt ||
        providedTarget.memory.status !== "active"
      ) {
        throw new MemoryError(
          "MEMORY.INVALID_STATE",
          "只有当前有效的记忆可以自动更新。",
          false,
        );
      }
      if (providedTarget.memory.type !== type) {
        throw new MemoryError(
          "MEMORY.CONFLICT",
          "更新目标的类型与当前事实不一致。",
          false,
        );
      }
    }

    const slotTarget = input.claimSlot
      ? this.repository.findDetailByClaimSlot(input.claimSlot)
      : undefined;
    if (
      slotTarget &&
      (slotTarget.memory.deletedAt || slotTarget.memory.status !== "active")
    ) {
      throw new MemoryError(
        "MEMORY.INVALID_STATE",
        "这个稳定字段对应的记忆已归档，请先在 Memory 中处理。",
        false,
      );
    }
    if (
      providedTarget &&
      slotTarget &&
      providedTarget.memory.id !== slotTarget.memory.id
    ) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "模型提交的记忆 ID 与稳定字段对应的记忆不一致。",
        false,
      );
    }
    if (
      input.claimSlot &&
      providedTarget?.memory.claimSlot &&
      providedTarget.memory.claimSlot !== input.claimSlot
    ) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "模型提交的稳定字段与目标记忆不一致。",
        false,
      );
    }

    const comparisonTarget = providedTarget ?? slotTarget;
    const currentRevision = comparisonTarget?.revisions.find(
      ({ id }) => id === comparisonTarget.memory.currentRevisionId,
    );
    if (comparisonTarget && !currentRevision) {
      throw new TypeError("Current memory revision is unavailable");
    }
    if (
      comparisonTarget &&
      currentRevision &&
      normalizeFormedContent(currentRevision.content) === content
    ) {
      const pending = this.repository.findPendingCandidateByContent(content, {
        operation: input.operation,
        ...(input.claimSlot ? { slot: input.claimSlot } : {}),
        supersedesMemoryId: comparisonTarget.memory.id,
      });
      if (direct && pending) {
        this.repository.discardPendingCandidate(pending.id);
      }
      return {
        memoryId: comparisonTarget.memory.id,
        outcome: "duplicate",
        revisionId: currentRevision.id,
      };
    }

    if (input.operation === "create") {
      if (slotTarget) {
        return this.#proposeFormation(
          input,
          content,
          type,
          direct ? "collision" : "basis",
          slotTarget.memory.id,
        );
      }
      const allowedSet = new Set(input.allowedMemoryIds);
      const duplicate = this.repository.findActiveDetailByContent(content);
      if (duplicate) {
        if (
          input.claimSlot &&
          !duplicate.memory.claimSlot &&
          allowedSet.has(duplicate.memory.id)
        ) {
          return this.#proposeFormation(
            input,
            content,
            type,
            "legacy_binding",
            duplicate.memory.id,
          );
        }
        if (
          input.claimSlot &&
          duplicate.memory.claimSlot &&
          duplicate.memory.claimSlot !== input.claimSlot
        ) {
          return this.#proposeFormation(
            input,
            content,
            type,
            "ambiguous_identity",
          );
        }
        if (!input.claimSlot && duplicate.memory.type !== type) {
          return this.#proposeFormation(
            input,
            content,
            type,
            "ambiguous_identity",
          );
        }
        return {
          memoryId: duplicate.memory.id,
          outcome: "duplicate",
          revisionId: duplicate.memory.currentRevisionId,
        };
      }
      if (
        input.claimSlot &&
        input.allowedMemoryIds.some((memoryId) => {
          const allowed = this.repository.getDetail(memoryId, false);
          return (
            allowed?.memory.status === "active" &&
            allowed.memory.type === type &&
            allowed.memory.claimSlot !== undefined &&
            allowed.memory.claimSlot !== input.claimSlot
          );
        })
      ) {
        return this.#proposeFormation(
          input,
          content,
          type,
          "ambiguous_identity",
        );
      }
      if (!direct) {
        return this.#proposeFormation(input, content, type, "basis");
      }
      const created = this.create({
        confidence: 1,
        content,
        importance: 0.5,
        reason: formationReason(input.basis),
        sources: [
          {
            ...input.source,
            createdAt: this.clock.now(),
          },
        ],
        type,
        ...(input.claimSlot ? { claimSlot: input.claimSlot } : {}),
        ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        ...(input.validTo ? { validTo: input.validTo } : {}),
      });
      const pending = this.repository.findPendingCandidateByContent(content, {
        operation: input.operation,
        ...(input.claimSlot ? { slot: input.claimSlot } : {}),
      });
      if (pending) this.repository.discardPendingCandidate(pending.id);
      return {
        memoryId: created.memory.id,
        outcome: "created",
        revisionId: created.memory.currentRevisionId,
      };
    }

    if (!providedTarget) {
      return this.#proposeFormation(
        input,
        content,
        type,
        direct ? "missing_target" : "basis",
        slotTarget?.memory.id,
      );
    }
    if (input.claimSlot && !providedTarget.memory.claimSlot) {
      return this.#proposeFormation(
        input,
        content,
        type,
        "legacy_binding",
        providedTarget.memory.id,
      );
    }
    if (
      definition?.cardinality === "single" &&
      (input.operation === "append" || input.operation === "remove")
    ) {
      return this.#proposeFormation(
        input,
        content,
        type,
        "single_value_operation",
        providedTarget.memory.id,
      );
    }
    if (!direct) {
      return this.#proposeFormation(
        input,
        content,
        type,
        "basis",
        providedTarget.memory.id,
      );
    }

    const revised = this.revise({
      confidence: 1,
      content,
      memoryId: providedTarget.memory.id,
      reason: formationReason(input.basis),
      sources: [
        {
          ...input.source,
          createdAt: this.clock.now(),
        },
      ],
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validTo ? { validTo: input.validTo } : {}),
    });
    const pending = this.repository.findPendingCandidateByContent(content, {
      operation: input.operation,
      ...(input.claimSlot ? { slot: input.claimSlot } : {}),
      supersedesMemoryId: providedTarget.memory.id,
    });
    if (pending) this.repository.discardPendingCandidate(pending.id);
    return {
      memoryId: revised.memory.id,
      outcome: "revised",
      revisionId: revised.memory.currentRevisionId,
    };
  }

  #proposeFormation(
    input: MemoryFormationInput,
    content: string,
    type: Exclude<MemoryType, "activity_digest" | "agent_learning">,
    cause: FormationCandidateCause,
    supersedesMemoryId?: string,
  ): MemoryFormationResult {
    const existing = this.repository.findPendingCandidateByContent(content, {
      operation: input.operation,
      ...(input.claimSlot ? { slot: input.claimSlot } : {}),
      ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
    });
    if (existing) {
      return {
        candidateId: existing.id,
        outcome: "candidate_duplicate",
      };
    }
    const candidate = this.repository.propose({
      candidateId: this.ids.generate(),
      confidence: 0.5,
      content,
      formation: {
        operation: input.operation,
        ...(input.claimSlot ? { slot: input.claimSlot } : {}),
      },
      importance: 0.5,
      novelty: 1,
      now: this.clock.now(),
      reason: formationCandidateReason(input.basis, cause),
      sourceIds: [input.source.referenceId],
      sourceLabels: [redactText(input.source.label)],
      sourceType: input.source.type,
      ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
      type,
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validTo ? { validTo: input.validTo } : {}),
    });
    return { candidateId: candidate.id, outcome: "candidate_created" };
  }

  discardPendingCandidate(candidateId: string): boolean {
    return this.repository.discardPendingCandidate(candidateId);
  }
}
