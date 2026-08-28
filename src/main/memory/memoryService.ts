import type {
  MemoryCandidate,
  MemoryClaimOperation,
  MemoryClaimSlot,
  MemoryCreateRequest,
  MemoryDetail,
  MemoryHit,
  MemoryListRequest,
  MemoryProposalInput,
  MemoryResolveClaimRequest,
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
  readonly ambiguityMemoryIds?: readonly string[];
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

export interface MemoryContextSelection {
  readonly legacyUnkeyedCount: number;
  readonly queryMatches: readonly MemoryHit[];
  readonly queryRelevantMemoryIds: readonly string[];
  readonly stableProfile: readonly MemoryHit[];
}

export interface ActivityMemoryPatternInput {
  readonly content: string;
  readonly legacyReason: string;
  readonly reason: string;
  readonly sourceIds: readonly string[];
  readonly sourceLabels: readonly string[];
  readonly validFrom: string;
}

export interface ActivityMemoryPatternReconciliation {
  readonly links: readonly {
    readonly candidateId: string;
    readonly digestIds: readonly string[];
  }[];
  readonly removedCandidateIds: readonly string[];
}

function normalizeFormedContent(content: string): string {
  return redactText(content).normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function activityPatternReasonKey(reason: string): string {
  return reason.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function managedActivityPatternReason(reason: string): boolean {
  const key = activityPatternReasonKey(reason);
  return (
    key.startsWith("activity 跨周稳定行为候选：") ||
    key.startsWith("activity 跨日证据归纳：")
  );
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
    this.#recordUsages(hits, consumer);
    return hits;
  }

  selectContext(query: string, limit = 8): MemoryContextSelection {
    const stableProfile = this.repository.stableClaimHits();
    const stableIds = new Set(stableProfile.map(({ memory }) => memory.id));
    const rawQueryMatches = this.retrieval.search(
      {
        includeDeleted: false,
        includeInactive: false,
        ...(query.trim() ? { query } : {}),
        status: "active",
      },
      limit,
    );
    const queryMatches = rawQueryMatches
      .filter(({ memory }) => !stableIds.has(memory.id))
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
    this.#recordUsages([...stableProfile, ...queryMatches], "context");
    return {
      legacyUnkeyedCount: this.repository.countUnclaimedStableMemories(),
      queryMatches,
      queryRelevantMemoryIds: rawQueryMatches.map(({ memory }) => memory.id),
      stableProfile,
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

  reconcileActivityPatterns(
    patterns: readonly ActivityMemoryPatternInput[],
  ): ActivityMemoryPatternReconciliation {
    const decisions = this.repository.listCandidateDecisions({
      sourceType: "activity",
      type: "activity_digest",
    });
    const latestByReason = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      const reasonKey = activityPatternReasonKey(decision.candidate.reason);
      if (!latestByReason.has(reasonKey)) {
        latestByReason.set(reasonKey, decision);
      }
    }

    const retainedCandidateIds = new Set<string>();
    const removedCandidateIds = new Set<string>();
    const links: Array<{
      candidateId: string;
      digestIds: readonly string[];
    }> = [];

    for (const pattern of patterns) {
      if (pattern.sourceIds.length !== 2) {
        throw new TypeError(
          "Stable Activity patterns require exactly two Weekly Digest sources",
        );
      }
      if (pattern.sourceIds.length !== pattern.sourceLabels.length) {
        throw new TypeError("Activity pattern sources and labels must align");
      }
      const current = latestByReason.get(
        activityPatternReasonKey(pattern.reason),
      );
      const legacy = latestByReason.get(
        activityPatternReasonKey(pattern.legacyReason),
      );
      if (
        current?.candidate.status === "accepted" ||
        current?.candidate.status === "rejected"
      ) {
        continue;
      }
      if (
        !current &&
        (legacy?.candidate.status === "rejected" ||
          (legacy?.candidate.status === "accepted" && !legacy.acceptedMemoryId))
      ) {
        continue;
      }

      const targetMemoryId =
        legacy?.candidate.status === "accepted"
          ? legacy.acceptedMemoryId
          : undefined;
      if (targetMemoryId) {
        const target = this.repository.getDetail(targetMemoryId);
        if (
          !target ||
          target.memory.deletedAt ||
          target.memory.status !== "active"
        ) {
          continue;
        }
        const revision = target.revisions.find(
          ({ id }) => id === target.memory.currentRevisionId,
        );
        if (
          revision &&
          normalizeFormedContent(revision.content) ===
            normalizeFormedContent(pattern.content)
        ) {
          continue;
        }
      }

      const pending =
        current?.candidate.status === "pending" ? current.candidate : undefined;
      const pendingMatches =
        pending?.content === pattern.content &&
        sameStrings(pending.sourceIds, pattern.sourceIds) &&
        sameStrings(pending.sourceLabels, pattern.sourceLabels) &&
        pending.validFrom === pattern.validFrom &&
        pending.supersedesMemoryId === targetMemoryId &&
        (targetMemoryId
          ? pending.claimOperation === "replace"
          : !pending.claimOperation);
      if (pending && !pendingMatches) {
        if (this.repository.discardPendingCandidate(pending.id)) {
          removedCandidateIds.add(pending.id);
        }
      }
      if (!current && legacy?.candidate.status === "pending") {
        if (this.repository.discardPendingCandidate(legacy.candidate.id)) {
          removedCandidateIds.add(legacy.candidate.id);
        }
      }

      const candidate = pendingMatches
        ? pending
        : this.repository.propose({
            candidateId: this.ids.generate(),
            confidence: 0.6,
            content: pattern.content,
            ...(targetMemoryId
              ? { formation: { operation: "replace" as const } }
              : {}),
            importance: 0.5,
            novelty: 1,
            now: this.clock.now(),
            reason: pattern.reason,
            sourceIds: [...pattern.sourceIds],
            sourceLabels: pattern.sourceLabels.map(redactText),
            sourceType: "activity",
            ...(targetMemoryId ? { supersedesMemoryId: targetMemoryId } : {}),
            type: "activity_digest",
            validFrom: pattern.validFrom,
          });
      retainedCandidateIds.add(candidate.id);
      links.push({ candidateId: candidate.id, digestIds: pattern.sourceIds });
    }

    for (const decision of decisions) {
      const candidate = decision.candidate;
      if (
        candidate.status === "pending" &&
        managedActivityPatternReason(candidate.reason) &&
        !retainedCandidateIds.has(candidate.id) &&
        this.repository.discardPendingCandidate(candidate.id)
      ) {
        removedCandidateIds.add(candidate.id);
      }
    }

    return {
      links,
      removedCandidateIds: [...removedCandidateIds],
    };
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

  resolveClaim(request: MemoryResolveClaimRequest): MemoryDetail {
    const legacy = this.repository.requireDetail(request.memoryId);
    const definition = memoryClaimDefinition(request.claimSlot);
    if (definition.type !== legacy.memory.type) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "所选稳定字段与旧记忆类型不一致。",
        false,
      );
    }
    const owner = this.repository.findDetailByClaimSlot(request.claimSlot);
    if (owner && owner.memory.type !== definition.type) {
      throw new MemoryError(
        "MEMORY.CONFLICT",
        "稳定字段当前绑定了不兼容的记忆类型。",
        false,
      );
    }
    const now = this.clock.now();
    const references = owner
      ? [
          { id: owner.memory.id, label: "用户确认合并：现有稳定字段" },
          { id: legacy.memory.id, label: "用户确认合并：旧版未绑定记忆" },
        ]
      : [{ id: legacy.memory.id, label: "用户确认绑定：旧版未绑定记忆" }];
    return this.repository.resolveClaim({
      claimSlot: request.claimSlot,
      content: redactText(request.content),
      memoryId: request.memoryId,
      now,
      reason: owner
        ? "用户在 Memory 页面确认合并旧记忆"
        : "用户在 Memory 页面确认旧记忆字段",
      revisionId: this.ids.generate(),
      sources: references.map(({ id, label }) => ({
        createdAt: now,
        id: this.ids.generate(),
        label,
        referenceId: id,
        type: "user_edit" as const,
      })),
    });
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

    const allowedSet = new Set(input.allowedMemoryIds);
    let providedTarget: MemoryDetail | undefined;
    if (input.memoryId) {
      if (!allowedSet.has(input.memoryId)) {
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

    const resolvedTarget =
      providedTarget ??
      (slotTarget && allowedSet.has(slotTarget.memory.id)
        ? slotTarget
        : undefined);
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
        (input.ambiguityMemoryIds ?? input.allowedMemoryIds).some(
          (memoryId) => {
            const allowed = this.repository.getDetail(memoryId, false);
            return (
              allowed?.memory.status === "active" &&
              allowed.memory.type === type &&
              allowed.memory.claimSlot !== undefined &&
              allowed.memory.claimSlot !== input.claimSlot
            );
          },
        )
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

    if (!resolvedTarget) {
      return this.#proposeFormation(
        input,
        content,
        type,
        direct ? "missing_target" : "basis",
        slotTarget?.memory.id,
      );
    }
    if (input.claimSlot && !resolvedTarget.memory.claimSlot) {
      return this.#proposeFormation(
        input,
        content,
        type,
        "legacy_binding",
        resolvedTarget.memory.id,
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
        resolvedTarget.memory.id,
      );
    }
    if (!direct) {
      return this.#proposeFormation(
        input,
        content,
        type,
        "basis",
        resolvedTarget.memory.id,
      );
    }

    const revised = this.revise({
      confidence: 1,
      content,
      memoryId: resolvedTarget.memory.id,
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
      supersedesMemoryId: resolvedTarget.memory.id,
    });
    if (pending) this.repository.discardPendingCandidate(pending.id);
    return {
      memoryId: revised.memory.id,
      outcome: "revised",
      revisionId: revised.memory.currentRevisionId,
    };
  }

  #recordUsages(
    hits: readonly MemoryHit[],
    consumer: "context" | "tool",
  ): void {
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
