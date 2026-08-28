import type {
  EvolutionCandidate,
  EvolutionCandidateUpdateRequest,
  EvolutionChangedEvent,
  EvolutionListRequest,
  EvolutionProposal,
  EvolutionReview,
  EvolutionSnapshot,
} from "../../shared/contracts/evolution";
import type { RunItem } from "../../shared/contracts/run";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { ChatRepository } from "../chat/chatRepository";
import type { MemoryService } from "../memory/memoryService";
import type { AppLogger } from "../observability/logger";
import type { RunRepository } from "../agent/runRepository";
import { parseSkill, type SkillService } from "../extensions/skillService";
import { EvolutionError, toEvolutionAppError } from "./evolutionError";
import type { EvolutionRepository } from "./evolutionRepository";
import type {
  EvolutionCandidateGenerator,
  EvolutionReplayRunner,
  EvolutionReviewEvidence,
  GeneratedEvolutionCandidate,
} from "./evolutionReviewer";
import { EvolutionReviewSkippedError } from "./evolutionReviewer";
import { detectEvolutionTriggers } from "./evolutionTrigger";

export interface EvolutionPublisher {
  publish(event: EvolutionChangedEvent): void;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function loadedSkillIds(items: readonly RunItem[]): string[] {
  return items.flatMap((item) => {
    if (item.status !== "completed") return [];
    const input = record(item.input);
    if (input?.["toolName"] !== "skills.load") return [];
    const argumentsValue = record(input["arguments"]);
    const skillId = argumentsValue?.["skillId"];
    return typeof skillId === "string" ? [skillId] : [];
  });
}

function candidateReplayStatus(
  generated: GeneratedEvolutionCandidate,
): EvolutionCandidate["replayResult"]["status"] {
  return generated.proposal.kind === "skill_patch" ||
    generated.proposal.kind === "new_skill"
    ? "pending"
    : "not_required";
}

function assertProposalKind(candidate: EvolutionCandidate): void {
  if (candidate.kind !== candidate.proposal.kind) {
    throw new EvolutionError(
      "EVOLUTION.INVALID_CANDIDATE",
      "成长候选类型与 proposal 不一致。",
      false,
    );
  }
}

function assertSkillReplayCases(candidate: EvolutionCandidate): void {
  const isSkill =
    candidate.proposal.kind === "skill_patch" ||
    candidate.proposal.kind === "new_skill";
  if (!isSkill) return;
  if (
    !candidate.replayCases.some(({ scope }) => scope === "in_scope") ||
    !candidate.replayCases.some(({ scope }) => scope === "out_of_scope")
  ) {
    throw new EvolutionError(
      "EVOLUTION.INVALID_REPLAY",
      "Skill 候选必须包含同类与旁路 replay case。",
      false,
    );
  }
}

export class EvolutionService {
  #abortController = new AbortController();
  #drainPromise: Promise<void> | undefined;
  #replayQueue = new Set<string>();
  #stopping = false;

  constructor(
    private readonly repository: EvolutionRepository,
    private readonly runs: RunRepository,
    private readonly chats: ChatRepository,
    private readonly skills: SkillService,
    private readonly memory: MemoryService,
    private readonly generator: EvolutionCandidateGenerator,
    private readonly replayRunner: EvolutionReplayRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly publisher: EvolutionPublisher,
  ) {}

  initialize(): void {
    this.repository.recoverRunningReviews(this.clock.now());
    for (const skillId of this.repository.listActivatedSkillIds()) {
      this.synchronizeSkill(skillId);
    }
    for (const candidateId of this.repository.listPendingReplayCandidateIds()) {
      this.#replayQueue.add(candidateId);
    }
    this.#scheduleDrain();
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#abortController.abort();
    await this.#drainPromise?.catch(() => undefined);
  }

  observeRun(envelope: RunEventEnvelope): void {
    if (envelope.event.type !== "run.completed") return;
    const run = envelope.event.run;
    if (this.repository.getReviewByRun(run.id)) return;
    const items = this.runs.listRunItems(run.id);
    const messages = this.chats.listRunMessages(run.id);
    const usedSkillIds = loadedSkillIds(items);
    const decision = detectEvolutionTriggers({
      hasPriorToolSignature: (signature) =>
        this.repository.hasPriorToolSignature(signature, run.id),
      items,
      messages,
    });
    const now = this.clock.now();
    const queued = decision.triggers.length > 0;
    const review = this.repository.createReview(
      {
        chatId: run.chatId,
        ...(queued ? {} : { completedAt: now }),
        createdAt: now,
        id: this.ids.generate(),
        runId: run.id,
        status: queued ? "queued" : "skipped",
        triggers: [...decision.triggers],
        updatedAt: now,
      },
      decision.toolSignature,
    );
    this.skills.recordRunSuccess(usedSkillIds);
    this.#publishReview(review);
    if (queued) this.#scheduleDrain();
  }

  list(request: EvolutionListRequest): EvolutionSnapshot {
    return this.repository.list(request);
  }

  synchronizeSkill(skillId: string): EvolutionCandidate[] {
    const skill = this.skills.list().find(({ id }) => id === skillId);
    if (!skill) return this.detachDeletedSkill(skillId);
    const now = this.clock.now();
    const changed: EvolutionCandidate[] = [];
    for (const candidate of this.repository.listByActivatedSkill(skillId)) {
      let next: EvolutionCandidate | undefined;
      if (candidate.status === "active") {
        if (skill?.archived) {
          next = {
            ...candidate,
            archivedAt: now,
            pinned: skill.pinned,
            status: "archived",
            updatedAt: now,
          };
        } else if (skill.revision !== candidate.activatedSkillRevision) {
          next = { ...candidate, status: "stale", updatedAt: now };
        } else if (candidate.pinned !== skill.pinned) {
          next = { ...candidate, pinned: skill.pinned, updatedAt: now };
        }
      } else if (candidate.status === "archived" && skill) {
        if (!skill.archived) {
          const { archivedAt, ...withoutArchive } = candidate;
          void archivedAt;
          next = {
            ...withoutArchive,
            pinned: skill.pinned,
            status:
              skill.revision === candidate.activatedSkillRevision
                ? "active"
                : "stale",
            updatedAt: now,
          };
        } else if (candidate.pinned !== skill.pinned) {
          next = { ...candidate, pinned: skill.pinned, updatedAt: now };
        }
      }
      if (!next) continue;
      const persisted = this.repository.updateCandidate(next);
      changed.push(persisted);
      this.#publishCandidate(persisted);
    }
    return changed;
  }

  detachDeletedSkill(skillId: string): EvolutionCandidate[] {
    const now = this.clock.now();
    const changed: EvolutionCandidate[] = [];
    for (const candidate of this.repository.listByActivatedSkill(skillId)) {
      const {
        activatedSkillId,
        activatedSkillRevision,
        ...candidateWithoutSkill
      } = candidate;
      void activatedSkillId;
      void activatedSkillRevision;
      const deletedPatchReplacement =
        candidate.proposal.kind === "skill_patch"
          ? {
              kind: "new_skill" as const,
              proposal: {
                content: candidate.proposal.content,
                kind: "new_skill" as const,
                name: candidate.proposal.name,
              },
            }
          : {};
      const persisted = this.repository.updateCandidate({
        ...candidateWithoutSkill,
        ...deletedPatchReplacement,
        archivedAt: candidate.archivedAt ?? now,
        status: "archived",
        updatedAt: now,
      });
      changed.push(persisted);
      this.#publishCandidate(persisted);
    }
    return changed;
  }

  retryReview(runId: string): EvolutionReview {
    const current = this.repository.requireReviewByRun(runId);
    if (current.status !== "failed") {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有失败的 Review 可以重试。",
        false,
      );
    }
    const review = this.repository.resetReview(runId, this.clock.now());
    this.#publishReview(review);
    this.#scheduleDrain();
    return review;
  }

  dismissReview(runId: string): EvolutionReview {
    const current = this.repository.requireReviewByRun(runId);
    if (current.status !== "failed") {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有失败的 Review 可以关闭。",
        false,
      );
    }
    const completedAt = this.clock.now();
    const review = this.repository.updateReview({
      completedAt,
      runId,
      status: "skipped",
      updatedAt: completedAt,
    });
    this.#publishReview(review);
    return review;
  }

  acceptCandidate(candidateId: string): EvolutionCandidate {
    const candidate = this.repository.requireCandidate(candidateId);
    assertProposalKind(candidate);
    if (candidate.status !== "draft") {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有草稿候选可以接受。",
        false,
      );
    }
    this.#assertProposal(candidate.proposal);
    if (
      candidate.proposal.kind === "skill_patch" ||
      candidate.proposal.kind === "new_skill"
    ) {
      assertSkillReplayCases(candidate);
      const accepted = this.repository.updateCandidate({
        ...candidate,
        replayResult: { status: "pending" },
        status: "accepted",
        updatedAt: this.clock.now(),
      });
      this.#publishCandidate(accepted);
      this.#queueReplay(accepted.id);
      return accepted;
    }

    const now = this.clock.now();
    const existing = this.memory.findBySourceReference(candidate.id);
    const sources = candidate.sourceItemIds.map((sourceItemId) => ({
      createdAt: now,
      id: this.ids.generate(),
      label: `Experience Review · Run ${candidate.sourceRunIds[0] ?? ""} · Item ${sourceItemId}`,
      referenceId: candidate.id,
      type: "distillation" as const,
    }));
    const detail = existing
      ? existing
      : candidate.proposal.kind === "persona_preference"
        ? this.memory.confirmPreference({
            claimSlot: candidate.proposal.claimSlot as Extract<
              typeof candidate.proposal.claimSlot,
              `preference.${string}`
            >,
            content: candidate.proposal.content,
            reason: candidate.proposal.reason,
            sources,
          })
        : this.memory.create({
            confidence: 1,
            content: candidate.proposal.content,
            importance: 0.5,
            reason: candidate.proposal.reason,
            sources,
            type: candidate.proposal.memoryType,
          });
    const active = this.repository.updateCandidate({
      ...candidate,
      activatedAt: now,
      activatedMemoryId: detail.memory.id,
      replayResult: { status: "not_required" },
      status: "active",
      updatedAt: now,
    });
    this.#publishCandidate(active);
    return active;
  }

  rejectCandidate(candidateId: string): EvolutionCandidate {
    const candidate = this.repository.requireCandidate(candidateId);
    const rejectedAfterReplayFailure =
      candidate.status === "accepted" &&
      candidate.replayResult.status === "failed";
    if (candidate.status !== "draft" && !rejectedAfterReplayFailure) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有尚未激活的候选可以拒绝。",
        false,
      );
    }
    const rejected = this.repository.updateCandidate({
      ...candidate,
      status: "rejected",
      updatedAt: this.clock.now(),
    });
    this.#publishCandidate(rejected);
    return rejected;
  }

  updateCandidate(
    request: EvolutionCandidateUpdateRequest,
  ): EvolutionCandidate {
    const candidate = this.repository.requireCandidate(request.candidateId);
    const editableAfterReplayFailure =
      candidate.status === "accepted" &&
      candidate.replayResult.status === "failed";
    if (candidate.status !== "draft" && !editableAfterReplayFailure) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有未激活候选可以编辑。",
        false,
      );
    }
    if (request.proposal.kind !== candidate.kind) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_CANDIDATE",
        "编辑不能改变候选类型。",
        false,
      );
    }
    if (
      candidate.proposal.kind === "skill_patch" &&
      request.proposal.kind === "skill_patch" &&
      request.proposal.targetSkillId !== candidate.proposal.targetSkillId
    ) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_CANDIDATE",
        "编辑不能改变 Skill patch 的目标。",
        false,
      );
    }
    this.#assertProposal(request.proposal);
    const isSkill =
      request.proposal.kind === "skill_patch" ||
      request.proposal.kind === "new_skill";
    if (
      isSkill &&
      (!request.replayCases.some(({ scope }) => scope === "in_scope") ||
        !request.replayCases.some(({ scope }) => scope === "out_of_scope"))
    ) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_REPLAY",
        "Skill 候选必须保留同类与旁路 replay case。",
        false,
      );
    }
    if (!isSkill && request.replayCases.length > 0) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_REPLAY",
        "Memory 与 Persona 候选不能包含 Skill replay case。",
        false,
      );
    }
    const updated = this.repository.updateCandidate({
      ...candidate,
      proposal: request.proposal,
      rationale: request.rationale,
      replayCases: request.replayCases,
      replayResult: { status: isSkill ? "pending" : "not_required" },
      status: "draft",
      updatedAt: this.clock.now(),
    });
    this.#publishCandidate(updated);
    return updated;
  }

  retryReplay(candidateId: string): EvolutionCandidate {
    const candidate = this.repository.requireCandidate(candidateId);
    if (
      candidate.status !== "accepted" ||
      candidate.replayResult.status !== "failed"
    ) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有 replay 失败的已接受 Skill 候选可以重试。",
        false,
      );
    }
    this.#assertProposal(candidate.proposal);
    const pending = this.repository.updateCandidate({
      ...candidate,
      replayResult: { status: "pending" },
      updatedAt: this.clock.now(),
    });
    this.#publishCandidate(pending);
    this.#queueReplay(pending.id);
    return pending;
  }

  setCandidatePinned(candidateId: string, pinned: boolean): EvolutionCandidate {
    const candidate = this.repository.requireCandidate(candidateId);
    if (candidate.status !== "active") {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有已生效候选可以设置 pin。",
        false,
      );
    }
    if (candidate.activatedMemoryId) {
      this.memory.setPinned(candidate.activatedMemoryId, pinned);
    }
    if (candidate.activatedSkillId) {
      this.skills.setPinned(candidate.activatedSkillId, pinned);
    }
    const updated = this.repository.updateCandidate({
      ...candidate,
      pinned,
      updatedAt: this.clock.now(),
    });
    this.#publishCandidate(updated);
    return updated;
  }

  async archiveCandidate(candidateId: string): Promise<EvolutionCandidate> {
    const candidate = this.repository.requireCandidate(candidateId);
    if (candidate.status === "archived") return candidate;
    if (candidate.status === "accepted") {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "正在 replay 的候选不能归档。",
        false,
      );
    }
    if (candidate.status === "active" && candidate.activatedMemoryId) {
      this.memory.archive(candidate.activatedMemoryId);
    }
    if (candidate.status === "active" && candidate.activatedSkillId) {
      await this.skills.archive(candidate.activatedSkillId);
    }
    const now = this.clock.now();
    const archived = this.repository.updateCandidate({
      ...candidate,
      archivedAt: now,
      status: "archived",
      updatedAt: now,
    });
    this.#publishCandidate(archived);
    return archived;
  }

  async restoreCandidate(candidateId: string): Promise<EvolutionCandidate> {
    const candidate = this.repository.requireCandidate(candidateId);
    if (candidate.status !== "archived") {
      throw new EvolutionError(
        "EVOLUTION.INVALID_STATE",
        "只有已归档候选可以恢复。",
        false,
      );
    }
    if (candidate.activatedMemoryId) {
      this.memory.restore(candidate.activatedMemoryId);
    }
    let restoredSkillRevision: number | undefined;
    if (candidate.activatedSkillId && candidate.activatedSkillRevision) {
      const skill = await this.skills.restoreRevision(
        candidate.activatedSkillId,
        candidate.activatedSkillRevision,
      );
      restoredSkillRevision = skill.revision;
      for (const stale of this.repository.markActiveSkillCandidatesStale(
        skill.id,
        candidate.id,
        this.clock.now(),
      )) {
        this.#publishCandidate(stale);
      }
    }
    const { archivedAt, ...candidateWithoutArchive } = candidate;
    void archivedAt;
    const restored = this.repository.updateCandidate({
      ...candidateWithoutArchive,
      ...(restoredSkillRevision
        ? { activatedSkillRevision: restoredSkillRevision }
        : {}),
      status:
        candidate.activatedMemoryId || candidate.activatedSkillId
          ? "active"
          : "draft",
      updatedAt: this.clock.now(),
    });
    this.#publishCandidate(restored);
    return restored;
  }

  #scheduleDrain(): void {
    if (this.#stopping || this.#drainPromise) return;
    queueMicrotask(() => {
      if (this.#stopping || this.#drainPromise) return;
      this.#drainPromise = this.#drain().finally(() => {
        this.#drainPromise = undefined;
        if (
          !this.#stopping &&
          (this.repository.listQueuedReviews().length > 0 ||
            this.#replayQueue.size > 0)
        ) {
          this.#scheduleDrain();
        }
      });
    });
  }

  #queueReplay(candidateId: string): void {
    this.#replayQueue.add(candidateId);
    this.#scheduleDrain();
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      const review = this.repository.listQueuedReviews()[0];
      if (review) {
        await this.#processReview(review);
        continue;
      }
      const candidateId = this.#replayQueue.values().next().value;
      if (!candidateId) return;
      this.#replayQueue.delete(candidateId);
      await this.#processReplay(candidateId);
    }
  }

  async #reviewEvidence(
    review: EvolutionReview,
  ): Promise<EvolutionReviewEvidence> {
    const run = this.runs.getRun(review.runId);
    if (!run || run.status !== "completed") {
      throw new EvolutionError(
        "EVOLUTION.RUN_UNAVAILABLE",
        "Review 的完成 Run 不可用。",
        false,
      );
    }
    const items = this.runs.listRunItems(run.id);
    const messages = this.chats.listRunMessages(run.id);
    const loadedContents = await Promise.all(
      loadedSkillIds(items).map(async (skillId) => {
        const content = await this.skills.get(skillId);
        return { content: content.content, descriptor: content.skill };
      }),
    );
    return {
      items,
      loadedSkillContents: loadedContents,
      messages,
      run,
      skills: this.skills.list(),
      triggers: review.triggers,
    };
  }

  async #processReview(review: EvolutionReview): Promise<void> {
    const startedAt = this.clock.now();
    const running = this.repository.updateReview({
      runId: review.runId,
      startedAt,
      status: "running",
      updatedAt: startedAt,
    });
    this.#publishReview(running);
    try {
      const evidence = await this.#reviewEvidence(running);
      const generated = await this.generator.review(
        evidence,
        this.#abortController.signal,
      );
      const completedAt = this.clock.now();
      const pendingCandidates = generated.map(
        (draft) =>
          ({
            chatId: evidence.run.chatId,
            createdAt: completedAt,
            evidence: [...draft.evidence],
            id: this.ids.generate(),
            kind: draft.proposal.kind,
            pinned: false,
            proposal: draft.proposal,
            rationale: draft.rationale,
            replayCases: [...draft.replayCases],
            replayResult: { status: candidateReplayStatus(draft) },
            reviewId: running.id,
            sourceItemIds: [...draft.sourceItemIds],
            sourceRunIds: [evidence.run.id],
            status: "draft",
            updatedAt: completedAt,
          }) satisfies EvolutionCandidate,
      );
      const completed = this.repository.completeReview(
        running.runId,
        pendingCandidates,
        completedAt,
      );
      for (const candidate of completed.candidates) {
        this.#publishCandidate(candidate);
      }
      this.#publishReview(completed.review);
    } catch (error) {
      if (this.#stopping && this.#abortController.signal.aborted) return;
      if (!this.repository.getReviewByRun(running.runId)) return;
      const completedAt = this.clock.now();
      if (error instanceof EvolutionReviewSkippedError) {
        const skipped = this.repository.updateReview({
          completedAt,
          runId: running.runId,
          status: "skipped",
          updatedAt: completedAt,
        });
        this.#publishReview(skipped);
        return;
      }
      const failed = this.repository.updateReview({
        completedAt,
        error: toEvolutionAppError(error),
        runId: running.runId,
        status: "failed",
        updatedAt: completedAt,
      });
      this.#publishReview(failed);
      this.logger.warn("EVOLUTION_REVIEW_FAILED", {
        error,
        runId: running.runId,
      });
    }
  }

  async #processReplay(candidateId: string): Promise<void> {
    let candidate = this.repository.requireCandidate(candidateId);
    if (
      candidate.status !== "accepted" ||
      (candidate.replayResult.status !== "pending" &&
        candidate.replayResult.status !== "passed")
    ) {
      return;
    }
    try {
      const sourceRunId = candidate.sourceRunIds[0];
      const run = sourceRunId ? this.runs.getRun(sourceRunId) : undefined;
      if (!run) {
        throw new EvolutionError(
          "EVOLUTION.RUN_UNAVAILABLE",
          "Skill replay 的来源 Run 不可用。",
          false,
        );
      }
      if (candidate.replayResult.status === "pending") {
        candidate = this.repository.updateCandidate({
          ...candidate,
          replayResult: { status: "running" },
          updatedAt: this.clock.now(),
        });
        this.#publishCandidate(candidate);
        const replay = await this.replayRunner.replay(
          {
            proposal: candidate.proposal,
            replayCases: candidate.replayCases,
          },
          run,
          this.#abortController.signal,
        );
        const replayCompletedAt = this.clock.now();
        if (!replay.passed) {
          const failed = this.repository.updateCandidate({
            ...candidate,
            replayResult: {
              completedAt: replayCompletedAt,
              failureReason: replay.failureReason ?? "Skill replay 未通过。",
              status: "failed",
            },
            updatedAt: replayCompletedAt,
          });
          this.#publishCandidate(failed);
          return;
        }
        candidate = this.repository.updateCandidate({
          ...candidate,
          replayResult: { completedAt: replayCompletedAt, status: "passed" },
          updatedAt: replayCompletedAt,
        });
        this.#publishCandidate(candidate);
      }
      if (
        candidate.proposal.kind !== "skill_patch" &&
        candidate.proposal.kind !== "new_skill"
      ) {
        throw new EvolutionError(
          "EVOLUTION.INVALID_CANDIDATE",
          "只有 Skill 候选可以执行 replay。",
          false,
        );
      }
      const skill = await this.skills.saveFromEvolution({
        candidateId: candidate.id,
        content: candidate.proposal.content,
        name: candidate.proposal.name,
        ...(candidate.proposal.kind === "skill_patch"
          ? {
              targetContentSha256: candidate.proposal.targetContentSha256,
              targetRevision: candidate.proposal.targetRevision,
              targetSkillId: candidate.proposal.targetSkillId,
            }
          : {}),
      });
      if (candidate.pinned) this.skills.setPinned(skill.id, true);
      const completedAt = this.clock.now();
      const active = this.repository.updateCandidate({
        ...candidate,
        activatedAt: completedAt,
        activatedSkillId: skill.id,
        activatedSkillRevision: skill.revision,
        replayResult: { completedAt, status: "passed" },
        status: "active",
        updatedAt: completedAt,
      });
      for (const stale of this.repository.markActiveSkillCandidatesStale(
        skill.id,
        active.id,
        completedAt,
      )) {
        this.#publishCandidate(stale);
      }
      this.#publishCandidate(active);
      this.synchronizeSkill(skill.id);
    } catch (error) {
      if (this.#stopping && this.#abortController.signal.aborted) return;
      const current = this.repository.getCandidate(candidateId);
      if (!current) return;
      const completedAt = this.clock.now();
      const failed = this.repository.updateCandidate({
        ...current,
        replayResult: {
          completedAt,
          failureReason: toEvolutionAppError(error).message,
          status: "failed",
        },
        updatedAt: completedAt,
      });
      this.#publishCandidate(failed);
      this.logger.warn("EVOLUTION_REPLAY_FAILED", {
        candidateId,
        error,
      });
    }
  }

  #publishCandidate(candidate: EvolutionCandidate): void {
    this.publisher.publish({ candidate, type: "candidate.changed" });
  }

  #publishReview(review: EvolutionReview): void {
    this.publisher.publish({ review, type: "review.changed" });
  }

  #assertProposal(proposal: EvolutionProposal): void {
    if (
      proposal.kind === "persona_preference" &&
      !proposal.claimSlot.startsWith("preference.")
    ) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_CANDIDATE",
        "Persona 候选只能更新 preference.* 字段。",
        false,
      );
    }
    if (proposal.kind !== "skill_patch" && proposal.kind !== "new_skill") {
      return;
    }
    let metadata: ReturnType<typeof parseSkill>;
    try {
      metadata = parseSkill(proposal.content);
    } catch (error) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_SKILL",
        error instanceof Error ? error.message : "Skill 文档无效。",
        false,
      );
    }
    if (metadata.name !== proposal.name) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_SKILL",
        "Skill 名称与 SKILL.md frontmatter 不一致。",
        false,
      );
    }
    const skills = this.skills.list();
    if (proposal.kind === "new_skill") {
      if (
        skills.some(({ archived, name }) => !archived && name === proposal.name)
      ) {
        throw new EvolutionError(
          "EVOLUTION.DUPLICATE_SKILL",
          "已有同名 Skill；请使用 patch 候选。",
          false,
        );
      }
      return;
    }
    const target = skills.find(({ id }) => id === proposal.targetSkillId);
    if (
      !target ||
      target.source !== "user" ||
      target.readOnly ||
      target.archived ||
      target.pinned ||
      target.name !== proposal.name
    ) {
      throw new EvolutionError(
        "EVOLUTION.INVALID_SKILL_TARGET",
        "Skill patch 的目标不存在、不可修改或名称不一致。",
        false,
      );
    }
    if (
      target.revision !== proposal.targetRevision ||
      target.contentSha256 !== proposal.targetContentSha256
    ) {
      throw new EvolutionError(
        "EVOLUTION.STALE_SKILL_PATCH",
        "目标 Skill 已有更新；请基于当前版本重新生成或编辑候选。",
        false,
      );
    }
  }
}
