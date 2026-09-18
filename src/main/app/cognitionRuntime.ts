import { randomUUID } from "node:crypto";

import type {
  ActivityEvent,
  ActivitySurface,
} from "../../shared/contracts/activity";
import type {
  CognitionEffect,
  CognitionDecisionAttempt,
  CognitionEvidenceInput,
  CognitionSourceRef,
} from "../../shared/contracts/cognition";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { MemoryRecall } from "../../shared/contracts/memoryRecall";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { Run, RunItem } from "../../shared/contracts/run";
import { RequestUserInputArgumentsSchema } from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import { toolAllowedInExecution } from "../agent/approvalPolicy";
import type { AgentRuntime } from "../agent/agentRuntime";
import type { RunRepository } from "../agent/runRepository";
import type { ChatRepository } from "../chat/chatRepository";
import type { ChatService } from "../chat/chatService";
import type { CompanionMessageProjectionService } from "../companion/companionMessageProjectionService";
import type { CognitionRepository } from "../cognition/cognitionRepository";
import type { CognitionService } from "../cognition/cognitionService";
import type {
  CognitionDispatchRequest,
  CognitionDispatchResult,
  CognitionRuntimePort,
} from "../cognition/cognitionTypes";
import type { CompanionInitiativeRepository } from "../journey/companionInitiativeRepository";
import {
  evaluateCompanionInitiativePolicy,
  localMinuteOfDay,
} from "../journey/companionInitiativePolicy";
import type { JourneyService } from "../journey/journeyService";
import type { ProactiveConversationSurface } from "../journey/proactiveConversationSurface";
import type { AppLogger } from "../observability/logger";
import type { ProviderService } from "../providers/providerService";
import type { SettingsRepository } from "./settingsRepository";
import type { ToolRegistry } from "../tools/toolRegistry";

const ACTIVE_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "needs_input",
] as const;
const TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
const CHARACTER_TOOLS = [
  "activity.observe",
  "memory.search",
  "memory.record",
  "companion.life",
  "territory.observe",
  "territory.act",
  "territory.generate_item",
];

export function projectCognitionMessage(
  input: {
    surface: Pick<ProactiveConversationSurface, "publish">;
    projector?: Pick<
      CompanionMessageProjectionService,
      "selectImportantMoment" | "markDesktopProjected" | "markDesktopFailed"
    >;
    isIdle: () => boolean;
  },
  bubble: Parameters<ProactiveConversationSurface["publish"]>[0],
  sourceKind: "activity" | "memory_event",
): boolean {
  const { projector, surface } = input;
  if (sourceKind !== "memory_event" || !bubble.messageId || !projector)
    return surface.publish(bubble);
  const selection = projector.selectImportantMoment(
    bubble.messageId,
    input.isIdle(),
  );
  if (
    selection.surface === "android_notification" ||
    !selection.shouldProjectDesktop
  )
    return selection.acceptedBySelectedSurface;
  const shown = surface.publish(bubble);
  if (shown) projector.markDesktopProjected(bubble.messageId);
  else
    projector.markDesktopFailed(
      bubble.messageId,
      "Desktop proactive bubble was unavailable.",
    );
  return shown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface CognitionRuntimeDependencies {
  readonly cognition: () => CognitionService;
  readonly repository: CognitionRepository;
  readonly runs: RunRepository;
  readonly agent: AgentRuntime;
  readonly chats: ChatService;
  readonly messages: ChatRepository;
  readonly memory: Pick<MemoryRecall, "validateEvidenceReferences">;
  readonly journeys: JourneyService;
  readonly providers: ProviderService;
  readonly tools: ToolRegistry;
  readonly persona: () => PersonaSnapshot;
  readonly surface: ProactiveConversationSurface;
  readonly projectMessage: (
    bubble: Parameters<ProactiveConversationSurface["publish"]>[0],
    sourceKind: "activity" | "memory_event",
  ) => boolean;
  readonly initiativeHistory: CompanionInitiativeRepository;
  readonly settings: SettingsRepository;
  readonly activeVoice: () => boolean;
  readonly lifePaused: () => boolean;
  readonly isCurrentVisualSource: (source: {
    surface: ActivitySurface;
    actor: ActivityEvent["actor"];
  }) => boolean;
  readonly clock: Clock;
  readonly logger: AppLogger;
}

/** Adapts existing product domains to Cognition. It never runs its own model or tools. */
export class CognitionRuntime implements CognitionRuntimePort {
  #sleeping = false;
  constructor(private readonly dependencies: CognitionRuntimeDependencies) {}

  availability(
    personaId: string,
    attempt?: CognitionDecisionAttempt,
    ownRunId?: string,
  ) {
    const { runs, repository, settings, initiativeHistory, clock } =
      this.dependencies;
    const active = runs
      .listRunsByStatus([...ACTIVE_STATUSES])
      .filter(({ id }) => id !== ownRunId);
    const characterRun = active.find((run) => {
      const attempt = repository.getAttemptForRun(run.id);
      return (
        attempt?.decision?.choices.find(
          ({ id }) => id === attempt.decision?.selectedChoiceId,
        )?.kind === "continue_character"
      );
    });
    // Waiting ordinary Runs retain their own question/approval, not global
    // execution ownership. A bound character Run remains resumable/cancellable.
    const activeUserRunIds = active
      .filter(
        ({ id, status }) =>
          id !== characterRun?.id &&
          (status === "queued" || status === "running"),
      )
      .map(({ id }) => id);
    const activeVoice = this.dependencies.activeVoice();
    const selected = attempt?.decision?.choices.find(
      ({ id }) => id === attempt.decision?.selectedChoiceId,
    );
    const selectedChatId = selected?.journeyId
      ? this.dependencies.journeys
          .getSnapshot()
          .journeys.find(({ id }) => id === selected.journeyId)?.homeChatId
      : selected?.chatId;
    const waiting = attempt?.decision?.selectedBasis.waitingInputContinuation;
    const mayContinueInput =
      !!attempt && this.waitingContinuationIsValid(attempt);
    const intent =
      selected?.kind === "continue_shared" && selected.intentId
        ? repository.getIntent(selected.intentId)
        : undefined;
    const requestRunIds = new Set(
      intent?.owner === "user" &&
        intent.basis === "explicit_user" &&
        intent.status === "active"
        ? intent.evidenceIds.flatMap((id) => {
            const source = repository.requestedContinuationRequest(id);
            return source?.actor === "user" &&
              source.kind === "utterance" &&
              source.source.kind === "run" &&
              source.source.revision === "completed"
              ? [source.source.id]
              : [];
          })
        : [],
    );
    const waitingIntentRunIds = active
      .filter(
        (run) =>
          run.status === "needs_input" &&
          run.persona.personaId === personaId &&
          requestRunIds.has(run.id),
      )
      .map(({ id }) => id);
    return {
      userEngaged: activeUserRunIds.length > 0 || activeVoice,
      activeUserRunIds,
      chatRuns: active.map((run) => {
        const item =
          run.status === "needs_input" && run.persona.personaId === personaId
            ? runs
                .listRunItems(run.id)
                .findLast(
                  ({ kind, status }) =>
                    kind === "input_request" && status === "waiting_input",
                )
            : undefined;
        return {
          runId: run.id,
          chatId: run.chatId,
          status: run.status,
          ...(item
            ? {
                waitingInput: {
                  itemId: item.id,
                  questions: parseSchema(
                    RequestUserInputArgumentsSchema,
                    item.input,
                  ).questions,
                },
              }
            : {}),
        };
      }),
      ...(selectedChatId ? { selectedChatId } : {}),
      ...(waitingIntentRunIds.length ? { waitingIntentRunIds } : {}),
      ...(mayContinueInput && waiting
        ? { continuableInput: { runId: waiting.runId, itemId: waiting.itemId } }
        : {}),
      ...(characterRun ? { activeCharacterRunId: characterRun.id } : {}),
      activeVoice,
      sleeping: this.#sleeping,
      hasOutstandingBubble: this.dependencies.surface.hasOutstandingBubble(),
      mayInitiateConversation: waiting
        ? mayContinueInput
        : attempt?.decision?.selectedBasis.requestedContinuation
          ? this.requestedContinuationIsValid(attempt)
          : evaluateCompanionInitiativePolicy({
              settings: settings.getCompanionInitiative(),
              recentInitiatives: initiativeHistory.listRecent(),
              localMinuteOfDay: localMinuteOfDay(clock.now()),
              now: clock.now(),
            }).eligible,
      characterTools: CHARACTER_TOOLS.flatMap((name) => {
        const tool = this.dependencies.tools.get(name);
        if (!tool || !toolAllowedInExecution({ mode: "chat" }, tool.descriptor))
          return [];
        const { summary, description, effect } = tool.descriptor;
        return [{ name, summary, description, effect }];
      }),
      mayActInTerritory:
        this.dependencies.persona().personaId === personaId &&
        !this.dependencies.lifePaused(),
    };
  }

  async dispatch(
    request: CognitionDispatchRequest,
  ): Promise<CognitionDispatchResult> {
    const { repository, runs, clock, chats, agent, providers } =
      this.dependencies;
    const existing = () => {
      const binding = repository.getAttemptByDispatchKey(request.dispatchKey);
      return binding?.runId ? runs.getRun(binding.runId) : undefined;
    };
    const accepted = (): CognitionDispatchResult | undefined => {
      const binding = repository.getAttemptByDispatchKey(
        request.dispatchKey,
      )?.contextContinuation;
      return binding && runs.getRun(binding.runId)
        ? { runId: binding.runId, continuedInputItemId: binding.itemId }
        : undefined;
    };
    const priorAcceptance = accepted();
    if (priorAcceptance) return priorAcceptance;
    const previous = existing();
    if (previous) return { runId: previous.id };
    request.signal.throwIfAborted();
    const persona = this.dependencies.persona();
    if (persona.personaId !== request.personaId)
      throw new Error("Cognition persona changed before dispatch");
    const attempt = repository.getAttempt(request.attemptId);
    if (!attempt) throw new Error("Cognition decision changed before dispatch");
    const freshness = this.actionFreshness(attempt);
    if (!freshness.current)
      throw new Error(
        `Cognition decision changed before dispatch: ${freshness.reason}`,
      );
    const journey = request.choice.journeyId
      ? this.dependencies.journeys
          .getSnapshot()
          .journeys.find(({ id }) => id === request.choice.journeyId)
      : undefined;
    const ownLife = request.choice.kind === "continue_character";
    let requestedChat = journey?.homeChatId ?? request.choice.chatId;
    if (ownLife && !requestedChat) {
      for (const runId of repository.characterRunIds(persona.personaId)) {
        const candidate = runs.getRun(runId);
        if (
          candidate &&
          this.dependencies.messages.getChat(candidate.chatId)?.status ===
            "active"
        ) {
          requestedChat = candidate.chatId;
          break;
        }
      }
    }
    // Model IDs are resolved against actual Chats, never trusted as a new Chat identity.
    const existingChat = requestedChat
      ? this.dependencies.messages.getChat(requestedChat)
      : undefined;
    if (requestedChat && !existingChat)
      throw new Error("Cognition selected an unavailable conversation");
    const chat =
      existingChat ??
      chats.createProvisional({
        title: ownLife
          ? `${persona.displayName} 的日常`
          : `和 ${persona.displayName} 聊聊`,
      });
    const provisional = !existingChat;
    const waiting = attempt.decision?.selectedBasis.waitingInputContinuation;
    if (waiting) {
      try {
        const result = await agent.continueWithCognitionContext({
          runId: waiting.runId,
          itemId: waiting.itemId,
          attemptId: attempt.id,
          requestedAt: clock.now(),
          signal: request.signal,
          prepareContext: request.prepareContext,
          assertCurrent: () => {
            request.signal.throwIfAborted();
            const current = repository.getAttempt(attempt.id);
            if (
              !current ||
              !this.waitingContinuationIsValid(current) ||
              this.dependencies.persona().revision !== persona.revision ||
              !this.actionFreshness(current).current
            )
              throw new Error(
                "Cognition waiting input changed before context acceptance",
              );
          },
          onAccepted: ({ resolvedAt }) => {
            repository.bindContextContinuation(
              request.dispatchKey,
              waiting.runId,
              waiting.itemId,
              resolvedAt,
            );
          },
        });
        return { runId: result.runId, continuedInputItemId: waiting.itemId };
      } catch (error) {
        const committed = accepted();
        if (committed) {
          this.dependencies.logger.error(
            "Environment context was accepted, but its event publication failed",
            { error, runId: waiting.runId, itemId: waiting.itemId },
          );
          return committed;
        }
        throw error;
      }
    }
    const profileId = providers.getDefaultChatProfileId();
    const provider = providers.createSnapshot(profileId);
    try {
      const run = await agent.startAssistantInitiated(
        {
          attachments: [],
          chatId: chat.id,
          execution: { mode: "chat" },
          content: [
            ownLife
              ? "Continue your own small virtual activity. Use actual tools; quiet completion is valid. This is not a user request."
              : attempt.decision?.selectedBasis.requestedContinuation
                ? "Fulfil the user's earlier explicit conditional request with one contribution in its original conversation. The current evidence establishes its condition. This does not authorize external actions or repeated openings."
                : "There is a grounded opportunity for companionship. Offer one natural, low-pressure contribution; this is not a user request or permission for external actions.",
            request.choice.instruction ?? request.choice.rationale,
            "An intended or generated result is not a placed result. Do not claim any action without a successful matching Tool receipt.",
          ].join("\n\n"),
          providerProfileId: profileId,
          requestedAt: clock.now(),
        },
        {
          modelId: provider.modelId,
          persona,
          prepareCognitionContext: request.prepareContext,
          ...(ownLife ? { quietCompletionAllowed: true as const } : {}),
          toolNames: ownLife
            ? CHARACTER_TOOLS
            : ["memory.search", "activity.search", "activity.observe"],
          allocation: {
            existing,
            bind: (runId) => {
              const current = repository.getAttempt(request.attemptId);
              if (
                !current ||
                this.dependencies.persona().revision !== persona.revision ||
                !this.actionFreshness(current, runId).current ||
                !this.dependencies.messages.getChat(chat.id)
              ) {
                throw new Error(
                  "Cognition decision changed during Run preparation",
                );
              }
              repository.bindDispatched(
                request.dispatchKey,
                runId,
                clock.now(),
              );
            },
          },
        },
      );
      if (provisional) {
        if (run.chatId !== chat.id) chats.discardProvisional(chat.id);
        else if (ownLife) chats.establishProvisional(chat.id);
      }
      return { runId: run.id };
    } catch (error) {
      // Another caller may have allocated this same dispatch while this caller
      // waited on the existing Chat's serialized Turn lock.
      const reserved = existing();
      if (reserved) {
        if (provisional && reserved.chatId !== chat.id)
          chats.discardProvisional(chat.id);
        return { runId: reserved.id };
      }
      if (provisional) chats.discardProvisional(chat.id);
      throw error;
    }
  }

  async yieldCharacterRun(
    personaId: string,
    continuingRunId?: string,
  ): Promise<void> {
    const { runs, repository, agent, clock } = this.dependencies;
    for (const run of runs.listRunsByStatus([...ACTIVE_STATUSES])) {
      if (run.persona.personaId !== personaId || run.id === continuingRunId)
        continue;
      const attempt = repository.getAttemptForRun(run.id);
      if (!attempt) continue;
      await agent.cancel({ runId: run.id, requestedAt: clock.now() });
    }
  }

  reconcileRun(runId: string) {
    const run = this.dependencies.runs.getRun(runId);
    if (!run)
      return { terminal: true, unsuccessful: "failed" as const, evidence: [] };
    if (TERMINAL_STATUSES.has(run.status)) this.publishCompleted(run);
    const attempt = this.dependencies.repository.getAttemptForRun(run.id);
    const hasMessage = this.dependencies.messages
      .listRunMessages(run.id)
      .some(
        ({ role, status, content }) =>
          role === "assistant" && status === "completed" && content.trim(),
      );
    const delivered = this.dependencies.repository.hasEvidence(
      run.persona.personaId,
      { kind: "run", id: run.id, revision: "surface:offered" },
      "observation",
    );
    return {
      ...(attempt?.decision?.selectedBasis.requestedContinuation &&
      run.status === "completed" &&
      hasMessage &&
      !delivered &&
      this.actionFreshness(attempt, undefined, false).current
        ? { deliveryPending: true }
        : {}),
      // Intermediate completed sentences do not complete a failed contribution.
      // Only a real offered surface consumes its one delivery.
      ...(!delivered &&
      TERMINAL_STATUSES.has(run.status) &&
      run.status !== "completed"
        ? {
            unsuccessful:
              run.status === "failed"
                ? ("failed" as const)
                : ("interrupted" as const),
          }
        : {}),
      terminal: TERMINAL_STATUSES.has(run.status),
      evidence: this.dependencies.runs.listRunItems(runId).flatMap((item) => {
        const value = this.itemEvidence(run, item);
        return value ? [value] : [];
      }),
    };
  }

  observeActivity(event: ActivityEvent): void {
    // Agent execution already publishes richer Tool evidence; do not double count this projection.
    if (event.details.source === "agent_run") return;
    const details = event.details;
    const source: CognitionSourceRef = { kind: "activity", id: event.id };
    const base = {
      id: randomUUID(),
      personaId: this.dependencies.persona().personaId,
      actor: event.actor,
      observedAt: event.startedAt,
      source,
    };
    if (details.source === "idle") {
      this.dependencies.cognition().ingest({
        ...base,
        kind: "observation",
        boundary: "idle",
        text: `Desktop activity is ${details.state === "started" ? "idle" : "active"}; this does not establish user intent or emotion.`,
      });
      return;
    }
    if (details.source === "screenshot") {
      const visual = details.visual;
      this.dependencies.cognition().ingest({
        ...base,
        kind: "observation",
        text: details.ocrText ?? details.summary ?? "",
        ...(visual
          ? {
              observedAt: visual.capturedAt,
              sourceEpoch: `visual:${visual.surface.id}:${visual.surface.epoch}`,
              sourceSequence: visual.sequence,
              source: { ...source, revision: visual.contentRevision },
              boundary: "content" as const,
              object: {
                key: `surface:${visual.surface.id}:${visual.surface.epoch}`,
                identity: "adapter" as const,
                appName: visual.surface.appName,
                ...(visual.surface.appId
                  ? { appId: visual.surface.appId }
                  : {}),
                ...(visual.surface.windowTitle
                  ? { title: visual.surface.windowTitle }
                  : {}),
              },
              visual: {
                eventId: event.id,
                artifactId: details.artifactId,
                contentRevision: visual.contentRevision,
                surface: visual.surface,
                capturedAt: visual.capturedAt,
                width: details.width,
                height: details.height,
                trigger: visual.trigger,
              },
            }
          : {}),
      });
      return;
    }
    const appName =
      details.source === "active_app" ? details.appName : "Managed browser";
    const title =
      details.source === "active_app" ? details.windowTitle : details.title;
    const url = details.source === "managed_browser" ? details.url : undefined;
    const appId = details.source === "active_app" ? details.appId : undefined;
    this.dependencies.cognition().ingest({
      ...base,
      kind: "observation",
      ...(details.boundary ? { boundary: details.boundary } : {}),
      ...(details.contentStatus
        ? {
            visibility: {
              status: details.contentStatus,
              ...(details.content
                ? {
                    source: details.content.source,
                    scope: details.content.scope,
                    ...(details.content.truncated
                      ? { truncated: true as const }
                      : {}),
                  }
                : {}),
            },
          }
        : {}),
      ...(details.interaction ? { interaction: details.interaction } : {}),
      ...(details.contentStatus === "protected"
        ? {}
        : {
            text: [
              details.source === "active_app" && details.lifecycle
                ? `Application lifecycle: ${details.lifecycle}.`
                : undefined,
              details.content?.text,
            ]
              .filter(Boolean)
              .join("\n"),
          }),
      object: {
        key: details.surface
          ? `surface:${details.surface.id}:${details.surface.epoch}`
          : (url ?? `${appId ?? appName}:${title ?? "untitled"}`),
        identity: details.surface ? "adapter" : "provisional",
        appName,
        ...(appId ? { appId } : {}),
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
      },
    });
  }

  control(
    control: "sleep" | "wake" | "persona_changed" | "user_stop",
    text?: string,
  ): void {
    if (control === "sleep") this.#sleeping = true;
    if (control === "wake") this.#sleeping = false;
    this.dependencies.cognition().ingest({
      id: randomUUID(),
      personaId: this.dependencies.persona().personaId,
      actor: control === "user_stop" ? "user" : "system",
      kind: "control",
      control,
      source: { kind: "system", id: randomUUID() },
      observedAt: this.dependencies.clock.now(),
      ...(text ? { text } : {}),
    });
  }

  observeBubbleOutcome(runId: string, outcome: string): void {
    const run = this.dependencies.runs.getRun(runId);
    if (!run) return;
    this.dependencies.cognition().observeFeedback({
      id: randomUUID(),
      personaId: run.persona.personaId,
      actor: "system",
      kind: "observation",
      source: { kind: "run", id: run.id, revision: `surface:${outcome}` },
      observedAt: this.dependencies.clock.now(),
      text: `Desktop conversation surface outcome: ${outcome}. A dismissal or expiry does not establish the user's feelings. A reply is grounded separately by the actual user message.`,
    });
  }

  observeRun(envelope: RunEventEnvelope): void {
    const run = this.dependencies.runs.getRun(envelope.streamId);
    if (!run) return;
    if ("item" in envelope.event) {
      const evidence = this.itemEvidence(run, envelope.event.item);
      if (evidence) this.dependencies.cognition().observeFeedback(evidence);
    }
    if (
      envelope.event.type === "run.completed" ||
      envelope.event.type === "run.failed" ||
      envelope.event.type === "run.cancelled" ||
      envelope.event.type === "run.interrupted"
    ) {
      this.dependencies.cognition().observeFeedback({
        id: randomUUID(),
        personaId: run.persona.personaId,
        actor: "system",
        kind: "observation",
        source: {
          kind: "run",
          id: run.id,
          fragment: "terminal",
          revision: run.status,
        },
        observedAt: envelope.occurredAt,
        text: `Run status: ${run.status}. Only its separate Tool receipts establish effects; completion does not prove the intended goal was achieved.`,
      });
      this.publishCompleted(run);
    }
  }

  restoreSurfaces(): void {
    for (const attempt of this.dependencies.repository.unfinishedAttempts(
      this.dependencies.persona().personaId,
    )) {
      if (!["dispatched", "settled"].includes(attempt.status) || !attempt.runId)
        continue;
      const run = this.dependencies.runs.getRun(attempt.runId);
      if (run && TERMINAL_STATUSES.has(run.status)) this.publishCompleted(run);
    }
  }

  private itemEvidence(
    run: Run,
    item: RunItem,
  ): CognitionEvidenceInput | undefined {
    if (item.status === "running") return undefined;
    const input = record(item.input);
    const source: CognitionSourceRef = {
      kind: "run",
      id: run.id,
      fragment: item.id,
      revision: item.status,
    };
    const base = {
      id: randomUUID(),
      personaId: run.persona.personaId,
      chatId: run.chatId,
      source,
      observedAt: item.endedAt ?? item.startedAt ?? run.createdAt,
    };
    if (
      item.kind === "user_message" &&
      typeof input?.["content"] === "string"
    ) {
      return {
        ...base,
        actor: "user",
        kind: "utterance",
        text: input["content"],
      };
    }
    if (
      item.kind === "assistant_message" &&
      item.status === "completed" &&
      item.displayOutput?.trim()
    ) {
      return {
        ...base,
        actor: "agent",
        kind: "utterance",
        text: item.displayOutput,
      };
    }
    const output = record(item.output);
    if (
      !output ||
      typeof output["status"] !== "string" ||
      typeof output["summary"] !== "string"
    )
      return undefined;
    const name =
      typeof input?.["toolName"] === "string"
        ? input["toolName"]
        : typeof input?.["name"] === "string"
          ? input["name"]
          : "tool";
    // Memory searches and planning are evidence operations, never virtual-world actions.
    const effect = this.dependencies.tools.get(name)?.descriptor.effect;
    const modelContent = record(output["modelContent"]);
    const status = output["status"];
    const outcome =
      status !== "success" || modelContent?.["applied"] === false
        ? "not_performed"
        : "performed";
    let worldChange: CognitionEffect["worldChange"];
    if (effect === "read" || status !== "success" || name.startsWith("memory."))
      worldChange = "unchanged";
    else if (name === "companion.life") worldChange = "planned";
    else if (
      name === "territory.act" &&
      modelContent?.["status"] === "performed"
    ) {
      worldChange =
        modelContent["action"] === "observe" ? "unchanged" : "modified";
    } else if (
      (name === "territory.generate_item" ||
        name === "territory.propose_moment") &&
      modelContent?.["status"] === "applied" &&
      modelContent["worldRevisionChangedSinceCreation"] !== true
    ) {
      const placement = record(modelContent["placement"]);
      if (placement?.["kind"] === "collection") worldChange = "collected";
      else if (placement) worldChange = "placed";
    }

    return {
      ...base,
      actor: "agent",
      kind: "effect",
      text: JSON.stringify({
        tool: name,
        status,
        summary: output["summary"],
        result: output["modelContent"],
      }),
      effect: {
        runId: run.id,
        itemId: item.id,
        ...(typeof input?.["callId"] === "string"
          ? { callId: input["callId"] }
          : {}),
        outcome,
        description: `${name}: ${output["summary"]}`,
        sourceRefs: [source],
        ...(worldChange ? { worldChange } : {}),
      },
    };
  }

  private actualContinuationRequest(
    attempt: CognitionDecisionAttempt,
    requestEvidenceId: string,
  ): Run | undefined {
    const { repository, runs, messages } = this.dependencies;
    const choice = attempt.decision?.choices.find(
      ({ id }) => id === attempt.decision?.selectedChoiceId,
    );
    if (
      !choice ||
      choice.kind !== "continue_shared" ||
      choice.executionScope !== "conversation" ||
      choice.timing !== "now"
    )
      return undefined;
    const intent = choice.intentId
      ? repository.getIntent(choice.intentId)
      : undefined;
    const evidence = repository.requestedContinuationRequest(requestEvidenceId);
    if (
      !intent ||
      intent.owner !== "user" ||
      intent.basis !== "explicit_user" ||
      intent.status !== "active" ||
      !intent.evidenceIds.includes(requestEvidenceId) ||
      !evidence ||
      evidence.actor !== "user" ||
      evidence.kind !== "utterance" ||
      evidence.source.kind !== "run" ||
      evidence.source.revision !== "completed" ||
      !evidence.source.fragment ||
      !evidence.chatId ||
      choice.chatId !== evidence.chatId ||
      !choice.evidenceIds.includes(evidence.id)
    )
      return undefined;
    const journey = choice.journeyId
      ? this.dependencies.journeys
          .getSnapshot()
          .journeys.find(({ id }) => id === choice.journeyId)
      : undefined;
    if (choice.journeyId && (!journey || journey.homeChatId !== choice.chatId))
      return undefined;
    const run = runs.getRun(evidence.source.id);
    const item = runs.getRunItem(evidence.source.fragment);
    const input = record(item?.input);
    const message =
      typeof input?.["messageId"] === "string"
        ? messages.getMessage(input["messageId"])
        : undefined;
    const matches = !!(
      run &&
      run.persona.personaId === attempt.personaId &&
      run.chatId === choice.chatId &&
      item?.runId === run.id &&
      item.kind === "user_message" &&
      item.status === "completed" &&
      typeof input?.["content"] === "string" &&
      repository.requestedContinuationTextMatches(
        evidence.id,
        input["content"],
      ) &&
      message?.role === "user" &&
      message.status === "completed" &&
      message.runId === run.id &&
      message.chatId === run.chatId &&
      message.content === input["content"] &&
      messages.getChat(run.chatId)?.status === "active"
    );
    return matches ? run : undefined;
  }
  private requestedContinuationIsValid(
    attempt: CognitionDecisionAttempt,
  ): boolean {
    const requested = attempt.decision?.selectedBasis.requestedContinuation;
    return (
      !!requested &&
      !!this.actualContinuationRequest(attempt, requested.requestEvidenceId) &&
      !this.dependencies.repository.requestedContinuationBinding(
        attempt.personaId,
        requested.requestEvidenceId,
        attempt.id,
      )
    );
  }

  private waitingContinuationIsValid(
    attempt: CognitionDecisionAttempt,
  ): boolean {
    const waiting = attempt.decision?.selectedBasis.waitingInputContinuation;
    if (!waiting || attempt.decision?.selectedBasis.requestedContinuation)
      return false;
    const run = this.actualContinuationRequest(
      attempt,
      waiting.requestEvidenceId,
    );
    const item = this.dependencies.runs.getRunItem(waiting.itemId);
    return (
      !!run &&
      run.id === waiting.runId &&
      run.source !== "voice" &&
      run.persona.revision === this.dependencies.persona().revision &&
      run.status === "needs_input" &&
      item?.runId === run.id &&
      item.kind === "input_request" &&
      item.status === "waiting_input"
    );
  }

  private actionFreshness(
    attempt: CognitionDecisionAttempt,
    ownRunId?: string,
    checkAvailability = true,
  ):
    | ReturnType<CognitionRepository["actionFreshness"]>
    | {
        current: false;
        reason:
          | "persona_changed"
          | "source_changed"
          | "memory_changed"
          | "chat_unavailable"
          | "runtime_unavailable";
        referenceId?: string;
      } {
    const { repository, clock, isCurrentVisualSource } = this.dependencies;
    const result = repository.actionFreshness(attempt, clock.now());
    if (!result.current) return result;
    if (this.dependencies.persona().personaId !== attempt.personaId)
      return { current: false, reason: "persona_changed" };
    const unavailable = this.dependencies.memory.validateEvidenceReferences(
      repository.actionRecollectionRequest(attempt),
    );
    if (unavailable.length > 0)
      return {
        current: false,
        reason: "memory_changed",
        referenceId: unavailable[0]!.revisionId,
      };
    const choice = attempt.decision?.choices.find(
      ({ id }) => id === attempt.decision?.selectedChoiceId,
    );
    if (!choice) return { current: false, reason: "missing_basis" };
    if (choice.chatId && !this.dependencies.messages.getChat(choice.chatId))
      return {
        current: false,
        reason: "chat_unavailable",
        referenceId: choice.chatId,
      };
    if (
      attempt.decision?.selectedBasis.requestedContinuation &&
      !this.requestedContinuationIsValid(attempt)
    )
      return {
        current: false,
        reason: "runtime_unavailable",
        referenceId: "requested_continuation_unavailable",
      };
    if (
      attempt.decision?.selectedBasis.waitingInputContinuation &&
      !this.waitingContinuationIsValid(attempt)
    )
      return {
        current: false,
        reason: "runtime_unavailable",
        referenceId: "waiting_input_continuation_unavailable",
      };
    const blocked = checkAvailability
      ? repository.choiceBlockReason(
          choice,
          attempt.personaId,
          this.availability(attempt.personaId, attempt, ownRunId),
        )
      : undefined;
    if (blocked)
      return {
        current: false,
        reason: "runtime_unavailable",
        referenceId: blocked,
      };
    // Check the source bound by the selected behavior even if the foreground has
    // since moved elsewhere. Historical image references have no current binding.
    for (const evidence of repository.actionVisualEvidence(attempt)) {
      if (
        evidence.visual &&
        (evidence.actor === "user" ||
          evidence.actor === "agent" ||
          evidence.actor === "unknown") &&
        !isCurrentVisualSource({
          surface: evidence.visual.surface,
          actor: evidence.actor,
        })
      ) {
        return {
          current: false,
          reason: "source_changed",
          referenceId: evidence.id,
        };
      }
    }
    return { current: true };
  }

  private publishCompleted(run: Run): void {
    const { repository, messages, initiativeHistory, clock, chats } =
      this.dependencies;
    const attempt = repository.getAttemptForRun(run.id);
    const choice = attempt?.decision?.choices.find(
      ({ id }) => id === attempt.decision?.selectedChoiceId,
    );
    if (!attempt || !choice || choice.kind === "continue_character") return;
    const source = {
      kind: "run",
      id: run.id,
      revision: "surface:offered",
    } as const;
    if (repository.hasEvidence(run.persona.personaId, source, "observation"))
      return;
    const message = messages
      .listRunMessages(run.id)
      .findLast(
        ({ role, status }) => role === "assistant" && status === "completed",
      );
    const content = message?.content.trim();
    if (
      run.status !== "completed" ||
      !content ||
      this.dependencies.persona().personaId !== run.persona.personaId ||
      this.dependencies.persona().revision !== run.persona.revision ||
      !this.actionFreshness(attempt).current
    ) {
      chats.discardProvisional(run.chatId);
      return;
    }
    const kind =
      choice.chatId || choice.journeyId ? "continuation" : "invitation";
    const opportunities = repository.choiceOpportunityEvidence(
      choice,
      run.persona.personaId,
    );
    let sourceKind: "activity" | "memory_event" = "activity";
    for (const evidence of opportunities)
      if (choice.evidenceIds.includes(evidence.id)) {
        sourceKind = "memory_event";
        break;
      }
    if (
      !this.dependencies.projectMessage(
        {
          chatId: run.chatId,
          messageId: message!.id,
          content,
          id: run.id,
          kind,
          replyState: "ready",
          createdAt: clock.now(),
          ...(choice.journeyId ? { journeyId: choice.journeyId } : {}),
        },
        sourceKind,
      )
    )
      return;
    initiativeHistory.recordAccepted({
      id: run.id,
      sourceKind,
      kind,
      grounding: choice.rationale,
      message: content,
      acceptedAt: clock.now(),
      appName: "CharaMate",
      windowTitle: "Current situation",
    });
    this.dependencies.cognition().observeFeedback({
      id: randomUUID(),
      personaId: run.persona.personaId,
      source,
      kind: "observation",
      actor: "system",
      observedAt: clock.now(),
      text: "The companion message was offered on the selected companion surface. This is not evidence of a user reply.",
    });
  }
}
