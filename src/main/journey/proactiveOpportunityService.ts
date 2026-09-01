import { Type, type Static } from "@sinclair/typebox";

import type { StartRunRequest } from "../../shared/contracts/agent";
import type { Chat, Message } from "../../shared/contracts/chat";
import type {
  MemoryDetail,
  MemoryHit,
  MemorySnapshot,
} from "../../shared/contracts/memory";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { ProactiveConversationBubble } from "../../shared/contracts/pet";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { Run, RunCancelRequest } from "../../shared/contracts/run";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { NonBlankStringSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import { collectModelTurn } from "../agent/modelProvider";
import type { AppLogger } from "../observability/logger";
import type { ProviderService } from "../providers/providerService";
import type {
  CompanionInitiativeHistory,
  CompanionInitiativeRecord,
} from "./companionInitiativeRepository";
import {
  evaluateCompanionInitiativePolicy,
  localMinuteOfDay,
  type CompanionInitiativePolicyReader,
} from "./companionInitiativePolicy";
import type {
  ProactiveOpportunity,
  ProactiveOpportunityRepository,
} from "./proactiveOpportunityRepository";

const MINUTE_MS = 60_000;
export const PROACTIVE_OPPORTUNITY_LEAD_MS = 30 * MINUTE_MS;

const ProactiveOpportunityDecisionSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("none"), Type.Literal("send")]),
    grounding: Type.Union([NonBlankStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

type ProactiveOpportunityDecision = Static<
  typeof ProactiveOpportunityDecisionSchema
>;

export interface ProactiveOpportunityEvaluation {
  readonly decision: ProactiveOpportunityDecision;
  readonly provider: ProviderSnapshot;
}

export interface ProactiveOpportunityEvidence {
  readonly idle: boolean | undefined;
  readonly memory: MemoryHit;
  readonly now: string;
  readonly recentInitiatives: readonly CompanionInitiativeRecord[];
  readonly recentMessages: readonly Message[];
}

export interface ProactiveOpportunityDecider {
  decide(
    evidence: ProactiveOpportunityEvidence,
    signal: AbortSignal,
  ): Promise<ProactiveOpportunityEvaluation>;
}

export interface ProactiveOpportunityMemoryReader {
  get(memoryId: string): MemoryDetail;
  list(request: { readonly type: "event" | "commitment" }): MemorySnapshot;
}

export interface ProactiveOpportunityChatReader {
  getChat(chatId: string): Chat | undefined;
  listMessages(chatId: string): Message[];
}

export interface ProactiveOpportunityRunReader {
  getRun(runId: string): Run | undefined;
  readCompletedAssistantMessage(
    runId: string,
  ): { readonly content: string; readonly id: string } | undefined;
}

export interface ProactiveOpportunityRunLauncher {
  cancel(request: RunCancelRequest): Promise<unknown>;
  startAssistantInitiated(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly onStarted?: (run: Run) => void;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run>;
}

export interface ProactiveOpportunityBubbleTarget {
  hasOutstandingBubble(): boolean;
  projectMessage(bubble: ProactiveConversationBubble): boolean;
}

export interface ProactiveOpportunityJourneyReader {
  hasActiveSession(): boolean;
}

export interface ProactiveOpportunityPersonaReader {
  getActiveSnapshot(): PersonaSnapshot;
}

const DECISION_INSTRUCTIONS = `You are CharaMate's important-moment initiative gate. You do not chat with the user, call tools, or mutate state. Decide whether one previously stated future event justifies one gentle message now.

The user already granted category-level permission, but permission never requires a message. Choose none when the source is no longer clearly relevant, the recent Chat already addressed the same moment, a new message would feel like an alarm or productivity prompt, or the evidence is insufficient. Choose send only when one brief, low-pressure, supportive message would naturally continue the exact Chat.

Use only the supplied Memory text, its explicit time, recent Chat messages, idle fact when available, and the last three proactive outcomes. Do not invent document contents, progress, success, failure, feelings, or intent. Do not use keyword rules. Prefer silence over repetition, generic check-ins, countdowns, commands, coaching, or surveillance language.

For send, grounding is one short factual reason the conversational Agent may use. For none, grounding must be null. Return only compact JSON with both fields.`;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new TypeError("Important-moment initiative gate returned no JSON");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function compactInitiative(record: CompanionInitiativeRecord) {
  return {
    acceptedAt: record.acceptedAt,
    grounding: record.grounding,
    message: record.message,
    outcome: record.outcome,
    sourceKind: record.sourceKind,
  };
}

export class ModelProactiveOpportunityDecider implements ProactiveOpportunityDecider {
  constructor(private readonly providers: ProviderService) {}

  async decide(
    evidence: ProactiveOpportunityEvidence,
    signal: AbortSignal,
  ): Promise<ProactiveOpportunityEvaluation> {
    const profileId = this.providers.getDefaultChatProfileId();
    const runtime = await this.providers.createChatModelRuntime(profileId);
    const turn = await collectModelTurn(
      runtime.provider.stream(
        {
          input: [
            {
              content: JSON.stringify({
                idle: evidence.idle ?? null,
                memory: {
                  content: evidence.memory.revision.content,
                  occursAt: evidence.memory.revision.occursAt,
                  timeZone: evidence.memory.revision.timeZone,
                  type: evidence.memory.memory.type,
                },
                now: evidence.now,
                recentInitiatives:
                  evidence.recentInitiatives.map(compactInitiative),
                recentMessages: evidence.recentMessages.map(
                  ({ content, createdAt, role }) => ({
                    content,
                    createdAt,
                    role,
                  }),
                ),
              }),
              role: "user",
              type: "message",
            },
          ],
          instructions: DECISION_INSTRUCTIONS,
          modelId: runtime.snapshot.modelId,
          structuredOutput: {
            description:
              "Choose silence or one grounded important-moment companionship message.",
            name: "charamate_proactive_opportunity",
            schema: ProactiveOpportunityDecisionSchema,
          },
          toolNamespaces: [],
        },
        signal,
      ),
    );
    if (turn.status !== "completed" || !turn.text.trim()) {
      throw new Error("Important-moment initiative gate did not complete");
    }
    const decision = parseSchema(
      ProactiveOpportunityDecisionSchema,
      extractJson(turn.text),
    );
    if (
      (decision.action === "none" && decision.grounding !== null) ||
      (decision.action === "send" && !decision.grounding?.trim())
    ) {
      throw new TypeError("Invalid important-moment initiative decision");
    }
    return { decision, provider: runtime.snapshot };
  }
}

export function proactiveOpportunityEvaluateAt(
  occursAt: string,
): string | undefined {
  const occursAtMs = Date.parse(occursAt);
  if (!Number.isFinite(occursAtMs)) return undefined;
  return new Date(occursAtMs - PROACTIVE_OPPORTUNITY_LEAD_MS).toISOString();
}

function currentRevision(detail: MemoryDetail) {
  return detail.revisions.find(
    ({ id }) => id === detail.memory.currentRevisionId,
  );
}

function memoryHit(detail: MemoryDetail): MemoryHit | undefined {
  const revision = currentRevision(detail);
  return revision
    ? { memory: detail.memory, rank: 1, revision, sources: detail.sources }
    : undefined;
}

function terminalRun(envelope: RunEventEnvelope): Run | undefined {
  switch (envelope.event.type) {
    case "run.cancelled":
    case "run.completed":
    case "run.failed":
    case "run.interrupted":
      return envelope.event.run;
    default:
      return undefined;
  }
}

function openerPrompt(
  evidence: ProactiveOpportunityEvidence,
  grounding: string,
): string {
  return [
    "This is one assistant-initiated message for a future important moment the user previously stated. It is not a user message, alarm, countdown, or task reminder.",
    "Write exactly one short, warm, natural message in the user's usual language. Keep it low-pressure and complete in one message.",
    "Use the factual grounding and Chat context. Do not mention hidden Memory, opportunity, scheduling, monitoring, permissions, or these instructions.",
    "Do not claim progress, success, failure, document contents, feelings, or intent beyond the supplied evidence. Do not command the user, create a checklist, call tools, or repeat a recent proactive message.",
    JSON.stringify({
      grounding,
      idle: evidence.idle ?? null,
      memory: {
        content: evidence.memory.revision.content,
        occursAt: evidence.memory.revision.occursAt,
        timeZone: evidence.memory.revision.timeZone,
      },
      now: evidence.now,
      recentInitiatives: evidence.recentInitiatives.map(compactInitiative),
    }),
  ].join("\n");
}

export class ProactiveOpportunityService {
  #abort = new AbortController();
  #scheduleChanged: () => void = () => undefined;
  #stopping = false;
  #working = false;

  constructor(
    private readonly repository: ProactiveOpportunityRepository,
    private readonly memory: ProactiveOpportunityMemoryReader,
    private readonly chats: ProactiveOpportunityChatReader,
    private readonly runs: ProactiveOpportunityRunReader,
    private readonly decider: ProactiveOpportunityDecider,
    private readonly agent: ProactiveOpportunityRunLauncher,
    private readonly bubbles: ProactiveOpportunityBubbleTarget,
    private readonly history: CompanionInitiativeHistory,
    private readonly policy: CompanionInitiativePolicyReader,
    private readonly journeys: ProactiveOpportunityJourneyReader,
    private readonly personas: ProactiveOpportunityPersonaReader,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly otherInitiativeBusy: () => boolean = () => false,
    private readonly hasOtherActiveRun: (
      excludeRunId?: string,
    ) => boolean = () => false,
    private readonly readIdle: () => boolean | undefined = () => undefined,
    private readonly readLocalMinuteOfDay: (
      timestamp: string,
    ) => number = localMinuteOfDay,
  ) {}

  setScheduleChangedListener(listener: () => void): void {
    this.#scheduleChanged = listener;
  }

  isBusy(): boolean {
    return this.#working || this.repository.listEvaluating().length > 0;
  }

  earliestNextRunAt(): string | undefined {
    return this.#stopping || this.isBusy()
      ? undefined
      : this.repository.earliestPendingAt();
  }

  initialize(): void {
    const now = this.clock.now();
    this.repository.resetUnstartedEvaluations(now);
    for (const opportunity of this.repository.listEvaluating()) {
      const run = opportunity.runId
        ? this.runs.getRun(opportunity.runId)
        : undefined;
      if (!run) {
        this.repository.resolve(opportunity.id, "failed", now);
        continue;
      }
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(run.status)
      ) {
        this.#finishRun(opportunity, run.status === "completed", now);
      }
    }
    this.reconcileAll();
  }

  shutdown(): void {
    this.#stopping = true;
    this.#abort.abort();
  }

  handlePermissionChanged(enabled: boolean): void {
    if (enabled) this.reconcileAll();
    else this.#cancelAllOpen(this.clock.now());
    this.#scheduleChanged();
  }

  handleMemoryChanged(memoryId: string, preferredChatId?: string): void {
    this.#reconcileMemory(memoryId, preferredChatId);
    this.#scheduleChanged();
  }

  reconcileAll(): void {
    const now = this.clock.now();
    if (!this.policy.getCompanionInitiative().importantMomentOutreachEnabled) {
      this.#cancelAllOpen(now);
      return;
    }
    const seen = new Set<string>();
    for (const type of ["event", "commitment"] as const) {
      for (const hit of this.memory.list({ type }).memories) {
        if (seen.has(hit.memory.id)) continue;
        seen.add(hit.memory.id);
        this.#reconcileHit(hit);
      }
    }
    for (const opportunity of this.repository.listOpen()) {
      if (!seen.has(opportunity.sourceMemoryId)) {
        this.#cancelOpenForMemory(opportunity.sourceMemoryId, now);
      }
    }
  }

  async runDue(now = this.clock.now()): Promise<void> {
    if (this.#stopping) return;
    this.reconcileAll();
    if (this.isBusy()) return;
    let opportunity = this.repository.claimNextDue(now);
    while (opportunity) {
      await this.#evaluate(opportunity);
      if (this.#stopping || this.isBusy()) return;
      opportunity = this.repository.claimNextDue(now);
    }
  }

  observeRun(envelope: RunEventEnvelope): void {
    const run = terminalRun(envelope);
    if (!run) return;
    const opportunity = this.repository.findByRunId(run.id);
    if (!opportunity) return;
    if (
      this.#stopping &&
      (envelope.event.type === "run.cancelled" ||
        envelope.event.type === "run.interrupted")
    ) {
      this.repository.releaseForRetry(opportunity.id, envelope.occurredAt);
      this.#scheduleChanged();
      return;
    }
    this.#finishRun(
      opportunity,
      envelope.event.type === "run.completed",
      envelope.occurredAt,
    );
    this.#scheduleChanged();
  }

  #reconcileMemory(memoryId: string, preferredChatId?: string): void {
    const now = this.clock.now();
    if (!this.policy.getCompanionInitiative().importantMomentOutreachEnabled) {
      this.#cancelOpenForMemory(memoryId, now);
      return;
    }
    try {
      const detail = this.memory.get(memoryId);
      const hit = memoryHit(detail);
      if (!hit) {
        this.#cancelOpenForMemory(memoryId, now);
        return;
      }
      this.#reconcileHit(hit, preferredChatId);
    } catch {
      this.#cancelOpenForMemory(memoryId, now);
    }
  }

  #reconcileHit(hit: MemoryHit, preferredChatId?: string): void {
    const now = this.clock.now();
    const revision = hit.revision;
    this.#cancelOpenForMemory(hit.memory.id, now, revision.id);
    if (
      hit.memory.status !== "active" ||
      hit.memory.deletedAt ||
      (hit.memory.type !== "event" && hit.memory.type !== "commitment") ||
      !revision.importantMoment ||
      !revision.occursAt ||
      !revision.timeZone
    ) {
      this.#cancelOpenForMemory(hit.memory.id, now);
      return;
    }
    const evaluateAt = proactiveOpportunityEvaluateAt(revision.occursAt);
    if (!evaluateAt || Date.parse(evaluateAt) < Date.parse(now)) return;
    const existing = this.repository.findLatestForMemory(hit.memory.id);
    const sourceIds = new Set(revision.sourceIds);
    const sourceChatId = [...hit.sources]
      .reverse()
      .find(
        (source) =>
          sourceIds.has(source.id) &&
          (source.type === "chat" || source.type === "voice") &&
          this.chats.getChat(source.referenceId),
      )?.referenceId;
    const targetChatId =
      preferredChatId ?? sourceChatId ?? existing?.targetChatId;
    if (!targetChatId || !this.chats.getChat(targetChatId)) return;
    const reason = "用户明确说明的未来重要事件";
    if (existing?.sourceRevisionId === revision.id) {
      if (existing.state === "cancelled") {
        this.repository.reopenCancelled(existing.id, {
          evaluateAt,
          now,
          reason,
          targetChatId,
        });
      }
      return;
    }
    this.repository.insert({
      evaluateAt,
      id: this.ids.generate(),
      now,
      reason,
      sourceMemoryId: hit.memory.id,
      sourceRevisionId: revision.id,
      targetChatId,
    });
  }

  #validEvidence(
    opportunity: ProactiveOpportunity,
    now: string,
  ): ProactiveOpportunityEvidence | undefined {
    const settings = this.policy.getCompanionInitiative();
    if (!settings.importantMomentOutreachEnabled) return undefined;
    let detail: MemoryDetail;
    try {
      detail = this.memory.get(opportunity.sourceMemoryId);
    } catch {
      return undefined;
    }
    const hit = memoryHit(detail);
    const revision = hit?.revision;
    if (
      !hit ||
      hit.memory.status !== "active" ||
      hit.memory.deletedAt ||
      hit.memory.currentRevisionId !== opportunity.sourceRevisionId ||
      !revision?.importantMoment ||
      !revision.occursAt ||
      !revision.timeZone ||
      Date.parse(revision.occursAt) <= Date.parse(now)
    ) {
      return undefined;
    }
    const chat = this.chats.getChat(opportunity.targetChatId);
    if (!chat || chat.status !== "active") return undefined;
    const policy = evaluateCompanionInitiativePolicy({
      localMinuteOfDay: this.readLocalMinuteOfDay(now),
      now,
      recentInitiatives: this.history.listRecent(),
      settings,
    });
    if (!policy.eligible) return undefined;
    if (
      this.journeys.hasActiveSession() ||
      this.bubbles.hasOutstandingBubble() ||
      this.otherInitiativeBusy() ||
      this.hasOtherActiveRun()
    ) {
      return undefined;
    }
    return {
      idle: this.readIdle(),
      memory: hit,
      now,
      recentInitiatives: this.history.listRecent(),
      recentMessages: this.chats
        .listMessages(opportunity.targetChatId)
        .filter(({ status }) => status === "completed")
        .slice(-8),
    };
  }

  async #evaluate(opportunity: ProactiveOpportunity): Promise<void> {
    if (this.#stopping) return;
    this.#working = true;
    try {
      const now = this.clock.now();
      const evidence = this.#validEvidence(opportunity, now);
      if (!evidence) {
        this.repository.resolve(opportunity.id, "silent", now);
        return;
      }
      const evaluation = await this.decider.decide(
        evidence,
        this.#abort.signal,
      );
      if (this.#stopping || this.#abort.signal.aborted) {
        this.repository.releaseForRetry(opportunity.id, this.clock.now());
        return;
      }
      if (evaluation.decision.action === "none") {
        this.repository.resolve(opportunity.id, "silent", this.clock.now());
        return;
      }
      const currentEvidence = this.#validEvidence(
        opportunity,
        this.clock.now(),
      );
      const grounding = evaluation.decision.grounding?.trim();
      if (!currentEvidence || !grounding) {
        this.repository.resolve(opportunity.id, "silent", this.clock.now());
        return;
      }
      let attached = false;
      const started = await this.agent.startAssistantInitiated(
        {
          attachments: [],
          chatId: opportunity.targetChatId,
          content: openerPrompt(currentEvidence, grounding),
          execution: { mode: "chat" },
          providerProfileId: evaluation.provider.profileId,
          requestedAt: this.clock.now(),
        },
        {
          modelId: evaluation.provider.modelId,
          onStarted: (run) => {
            if (this.#stopping || this.hasOtherActiveRun(run.id)) return;
            attached = this.repository.attachRun(
              opportunity.id,
              run.id,
              this.clock.now(),
            );
          },
          persona: this.personas.getActiveSnapshot(),
          toolNames: [],
        },
      );
      if (!attached) {
        try {
          await this.agent.cancel({
            requestedAt: this.clock.now(),
            runId: started.id,
          });
        } finally {
          if (this.#stopping) {
            this.repository.releaseForRetry(opportunity.id, this.clock.now());
          } else {
            this.repository.resolve(opportunity.id, "silent", this.clock.now());
          }
        }
      }
    } catch (error) {
      if (this.#stopping || this.#abort.signal.aborted) return;
      this.repository.resolve(opportunity.id, "failed", this.clock.now());
      if (!this.#abort.signal.aborted) {
        this.logger.warn("PROACTIVE_OPPORTUNITY_EVALUATION_ERROR", {
          error,
          opportunityId: opportunity.id,
        });
      }
    } finally {
      this.#working = false;
    }
  }

  #cancelOpenForMemory(
    memoryId: string,
    now: string,
    exceptRevisionId?: string,
  ): void {
    const evaluating = this.repository
      .listOpen()
      .filter(
        (opportunity) =>
          opportunity.state === "evaluating" &&
          opportunity.runId !== undefined &&
          opportunity.sourceMemoryId === memoryId &&
          opportunity.sourceRevisionId !== exceptRevisionId,
      );
    this.repository.cancelOpenForMemory(memoryId, now, exceptRevisionId);
    this.#cancelRuns(evaluating, now);
  }

  #cancelAllOpen(now: string): void {
    const evaluating = this.repository
      .listEvaluating()
      .filter((opportunity) => opportunity.runId !== undefined);
    this.repository.cancelAllOpen(now);
    this.#cancelRuns(evaluating, now);
  }

  #cancelRuns(
    opportunities: readonly ProactiveOpportunity[],
    requestedAt: string,
  ): void {
    for (const opportunity of opportunities) {
      if (!opportunity.runId) continue;
      void this.agent
        .cancel({ requestedAt, runId: opportunity.runId })
        .catch((error: unknown) => {
          this.logger.warn("PROACTIVE_OPPORTUNITY_RUN_CANCEL_ERROR", {
            error,
            opportunityId: opportunity.id,
            runId: opportunity.runId,
          });
        });
    }
  }

  #finishRun(
    opportunity: ProactiveOpportunity,
    completed: boolean,
    occurredAt: string,
  ): void {
    if (opportunity.state !== "evaluating") return;
    if (!completed) {
      this.repository.resolve(opportunity.id, "failed", occurredAt);
      return;
    }
    const message = opportunity.runId
      ? this.runs.readCompletedAssistantMessage(opportunity.runId)
      : undefined;
    if (!message?.content.trim()) {
      this.repository.resolve(opportunity.id, "silent", occurredAt);
      return;
    }
    if (this.#stopping) return;
    const evidence = this.#validEvidence(opportunity, occurredAt);
    if (!evidence) {
      this.repository.resolve(
        opportunity.id,
        "delivered",
        occurredAt,
        message.id,
      );
      return;
    }
    let accepted = false;
    try {
      accepted = this.bubbles.projectMessage({
        chatId: opportunity.targetChatId,
        content: message.content.trim(),
        createdAt: occurredAt,
        id: opportunity.runId!,
        kind: "continuation",
        messageId: message.id,
        replyState: "ready",
      });
    } catch (error) {
      this.logger.warn("PROACTIVE_OPPORTUNITY_BUBBLE_ERROR", {
        error,
        opportunityId: opportunity.id,
      });
    }
    if (accepted) {
      try {
        this.history.recordAccepted({
          acceptedAt: this.clock.now(),
          grounding: evidence.memory.revision.content,
          id: opportunity.runId!,
          kind: "continuation",
          message: message.content.trim(),
          sourceKind: "memory_event",
        });
      } catch (error) {
        this.logger.warn("PROACTIVE_OPPORTUNITY_HISTORY_WRITE_ERROR", {
          error,
          opportunityId: opportunity.id,
        });
        return;
      }
    }
    this.repository.resolve(
      opportunity.id,
      "delivered",
      occurredAt,
      message.id,
    );
  }
}
