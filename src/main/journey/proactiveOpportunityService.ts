import { randomUUID } from "node:crypto";

import type { Chat } from "../../shared/contracts/chat";
import type { CognitionEvidenceInput } from "../../shared/contracts/cognition";
import type {
  MemoryDetail,
  MemoryHit,
  MemorySnapshot,
} from "../../shared/contracts/memory";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { AppLogger } from "../observability/logger";
import type { CompanionInitiativePolicyReader } from "./companionInitiativePolicy";
import type {
  ProactiveOpportunity,
  ProactiveOpportunityRepository,
} from "./proactiveOpportunityRepository";

/** The selected EXPERIENCE-ECHO-TIMING product rule, not a cognition constant. */
export const PROACTIVE_OPPORTUNITY_LEAD_MS = 30 * 60_000;

export interface ProactiveOpportunityMemoryReader {
  get(memoryId: string): MemoryDetail;
  list(request: { readonly type: "event" | "commitment" }): MemorySnapshot;
}

export interface ProactiveOpportunityServiceOptions {
  readonly repository: ProactiveOpportunityRepository;
  readonly memory: ProactiveOpportunityMemoryReader;
  readonly chats: { getChat(chatId: string): Chat | undefined };
  readonly cognition: { ingest(evidence: CognitionEvidenceInput): void };
  readonly policy: CompanionInitiativePolicyReader;
  readonly personas: { getActiveSnapshot(): PersonaSnapshot };
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Pick<AppLogger, "warn">;
}

export function proactiveOpportunityEvaluateAt(
  occursAt: string,
): string | undefined {
  const timestamp = Date.parse(occursAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp - PROACTIVE_OPPORTUNITY_LEAD_MS).toISOString()
    : undefined;
}

function memoryHit(detail: MemoryDetail): MemoryHit | undefined {
  const revision = detail.revisions.find(
    ({ id }) => id === detail.memory.currentRevisionId,
  );
  return revision
    ? { memory: detail.memory, rank: 1, revision, sources: detail.sources }
    : undefined;
}

/** Owns scheduled source facts only. Cognition owns relevance, interruption, Run and delivery. */
export class ProactiveOpportunityService {
  #scheduleChanged: () => void = () => undefined;
  #stopping = false;

  constructor(private readonly options: ProactiveOpportunityServiceOptions) {}

  setScheduleChangedListener(listener: () => void): void {
    this.#scheduleChanged = listener;
  }

  earliestNextRunAt(): string | undefined {
    return this.#stopping
      ? undefined
      : this.options.repository.earliestPendingAt();
  }

  initialize(): void {
    this.options.repository.resetUnstartedEvaluations(this.options.clock.now());
    this.reconcileAll();
    this.#scheduleChanged();
  }

  shutdown(): void {
    this.#stopping = true;
  }

  handlePermissionChanged(enabled: boolean): void {
    if (this.#stopping) return;
    if (enabled) {
      this.options.repository.resetUnstartedEvaluations(
        this.options.clock.now(),
      );
      this.reconcileAll();
    } else this.cancelOutstanding(() => true);
    this.#scheduleChanged();
  }

  handleMemoryChanged(memoryId: string, preferredChatId?: string): void {
    if (this.#stopping) return;
    // A new source change or restart can retry a failed persistence operation; no polling retry loop.
    this.options.repository.resetUnstartedEvaluations(this.options.clock.now());
    if (
      !this.options.policy.getCompanionInitiative()
        .importantMomentOutreachEnabled
    ) {
      this.cancelOutstanding((item) => item.sourceMemoryId === memoryId);
    } else {
      let hit: MemoryHit | undefined;
      try {
        hit = memoryHit(this.options.memory.get(memoryId));
      } catch {
        /* Deleted source. */
      }
      if (hit) this.reconcileHit(hit, preferredChatId);
      else this.cancelOutstanding((item) => item.sourceMemoryId === memoryId);
    }
    this.#scheduleChanged();
  }

  reconcileAll(): void {
    if (this.#stopping) return;
    if (
      !this.options.policy.getCompanionInitiative()
        .importantMomentOutreachEnabled
    ) {
      this.cancelOutstanding(() => true);
      return;
    }
    const seen = new Set<string>();
    for (const type of ["event", "commitment"] as const) {
      for (const hit of this.options.memory.list({ type }).memories) {
        if (seen.has(hit.memory.id)) continue;
        seen.add(hit.memory.id);
        this.reconcileHit(hit);
      }
    }
    this.cancelOutstanding((item) => !seen.has(item.sourceMemoryId));
  }

  runDue(now = this.options.clock.now()): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    this.reconcileAll();
    let opportunity = this.options.repository.claimNextDue(now);
    while (opportunity && !this.#stopping) {
      const hit = this.validSource(opportunity, now);
      if (!hit) {
        const id = opportunity.id;
        this.cancelOutstanding((item) => item.id === id);
      } else {
        try {
          this.emit(opportunity, "due", now, hit.revision.content);
          // NULL outcome means source published, never "message delivered" or "model chose quiet".
          this.options.repository.markPublished(opportunity.id, now);
        } catch (error) {
          // Keep evaluating for restart/source-change recovery; do not wake the scheduler at 0 ms.
          this.options.logger.warn("PROACTIVE_OPPORTUNITY_SOURCE_ERROR", {
            error,
            opportunityId: opportunity.id,
          });
        }
      }
      opportunity = this.options.repository.claimNextDue(now);
    }
    // AutomationScheduler will re-arm after runDue; never refresh it unconditionally here.
    return Promise.resolve();
  }

  private reconcileHit(hit: MemoryHit, preferredChatId?: string): void {
    const now = this.options.clock.now();
    const revision = hit.revision;
    this.cancelOutstanding(
      (item) =>
        item.sourceMemoryId === hit.memory.id &&
        item.sourceRevisionId !== revision.id,
    );
    if (!this.isFutureImportantSource(hit, now)) {
      this.cancelOutstanding((item) => item.sourceMemoryId === hit.memory.id);
      return;
    }
    const existing = this.options.repository.findLatestForMemory(hit.memory.id);
    // Existing due records survive restart during the selected pre-event window. Newly formed late
    // memories still do not create an immediate catch-up opportunity.
    const evaluateAt = proactiveOpportunityEvaluateAt(revision.occursAt!);
    if (!evaluateAt || evaluateAt < now) return;
    const sourceIds = new Set(revision.sourceIds);
    const sourceChatId = [...hit.sources]
      .reverse()
      .find(
        (source) =>
          sourceIds.has(source.id) &&
          (source.type === "chat" || source.type === "voice") &&
          this.options.chats.getChat(source.referenceId)?.status === "active",
      )?.referenceId;
    const targetChatId =
      preferredChatId ?? sourceChatId ?? existing?.targetChatId;
    if (
      !targetChatId ||
      this.options.chats.getChat(targetChatId)?.status !== "active"
    )
      return;
    const reason = "用户明确说明的未来重要事件";
    if (existing?.sourceRevisionId === revision.id) {
      if (existing.state === "cancelled")
        this.options.repository.reopenCancelled(existing.id, {
          evaluateAt,
          now,
          reason,
          targetChatId,
        });
      return;
    }
    this.options.repository.insert({
      evaluateAt,
      id: this.options.ids.generate(),
      now,
      reason,
      sourceMemoryId: hit.memory.id,
      sourceRevisionId: revision.id,
      targetChatId,
    });
  }

  private isFutureImportantSource(hit: MemoryHit, now: string): boolean {
    return (
      hit.memory.status === "active" &&
      !hit.memory.deletedAt &&
      (hit.memory.type === "event" || hit.memory.type === "commitment") &&
      hit.revision.importantMoment === true &&
      !!hit.revision.timeZone &&
      !!hit.revision.occursAt &&
      Date.parse(hit.revision.occursAt) > Date.parse(now)
    );
  }

  private validSource(
    opportunity: ProactiveOpportunity,
    now: string,
  ): MemoryHit | undefined {
    if (
      !this.options.policy.getCompanionInitiative()
        .importantMomentOutreachEnabled
    )
      return undefined;
    let hit: MemoryHit | undefined;
    try {
      hit = memoryHit(this.options.memory.get(opportunity.sourceMemoryId));
    } catch {
      return undefined;
    }
    return hit &&
      hit.revision.id === opportunity.sourceRevisionId &&
      this.isFutureImportantSource(hit, now) &&
      this.options.chats.getChat(opportunity.targetChatId)?.status === "active"
      ? hit
      : undefined;
  }

  private cancelOutstanding(
    predicate: (item: ProactiveOpportunity) => boolean,
  ): void {
    const now = this.options.clock.now();
    for (const item of this.options.repository.listOpen().filter(predicate)) {
      try {
        // Persist the invalidation before retiring the source. Crash replay deduplicates this tuple.
        this.emit(item, "cancelled", now);
        this.options.repository.cancel(item.id, now);
      } catch (error) {
        this.options.logger.warn("PROACTIVE_OPPORTUNITY_CANCEL_SOURCE_ERROR", {
          error,
          opportunityId: item.id,
        });
      }
    }
  }

  private emit(
    item: ProactiveOpportunity,
    status: "due" | "cancelled",
    now: string,
    content?: string,
  ): void {
    this.options.cognition.ingest({
      id: randomUUID(),
      personaId: this.options.personas.getActiveSnapshot().personaId,
      actor: "system",
      kind: "observation",
      chatId: item.targetChatId,
      observedAt: now,
      source: {
        kind: "memory",
        id: item.sourceMemoryId,
        revision: item.sourceRevisionId,
        fragment: `opportunity:${item.id}:${status}${status === "cancelled" ? `:${item.updatedAt}` : ""}`,
      },
      opportunity: {
        id: item.id,
        targetChatId: item.targetChatId,
        evaluateAt: item.evaluateAt,
        occursAt: new Date(
          Date.parse(item.evaluateAt) + PROACTIVE_OPPORTUNITY_LEAD_MS,
        ).toISOString(),
        status,
      },
      text:
        status === "due"
          ? `已到重要时刻的考虑窗口。以下是已保存的用户陈述，并非用户刚发的新消息：${content ?? ""}`
          : "这条重要时刻来源已撤销或失效；不得继续依赖旧记忆版本发起或投递。",
    });
  }
}
