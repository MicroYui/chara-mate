import { Type, type Static } from "@sinclair/typebox";

import type { StartRunRequest } from "../../shared/contracts/agent";
import type { Journey, JourneySnapshot } from "../../shared/contracts/journey";
import type { ProactiveConversationBubble } from "../../shared/contracts/pet";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { Run } from "../../shared/contracts/run";
import {
  EntityIdSchema,
  NonBlankStringSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import { collectModelTurn } from "../agent/modelProvider";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { ChatService } from "../chat/chatService";
import type { AppLogger } from "../observability/logger";
import type { ProviderService } from "../providers/providerService";
import type {
  ForegroundActivityObservation,
  ForegroundActivityObserver,
} from "../activity/activityObservation";
import type {
  CompanionInitiativeHistory,
  CompanionInitiativeRecord,
} from "./companionInitiativeRepository";
import {
  evaluateCompanionInitiativePolicy,
  localMinuteOfDay,
  type CompanionInitiativePolicyReader,
} from "./companionInitiativePolicy";

const NullableIdSchema = Type.Union([EntityIdSchema, Type.Null()]);
const NullableTextSchema = Type.Union([NonBlankStringSchema, Type.Null()]);

export const CompanionInitiativeDecisionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("none"),
      Type.Literal("new_conversation"),
      Type.Literal("existing_journey"),
    ]),
    chatTitle: NullableTextSchema,
    grounding: NullableTextSchema,
    journeyId: NullableIdSchema,
  },
  { additionalProperties: false },
);

export type CompanionInitiativeDecision = Static<
  typeof CompanionInitiativeDecisionSchema
>;

export interface CompanionInitiativeEvidence {
  readonly journeys: readonly Journey[];
  readonly observation: ForegroundActivityObservation;
  readonly recentInitiatives: readonly CompanionInitiativeRecord[];
}

export interface CompanionInitiativeEvaluation {
  readonly decision: CompanionInitiativeDecision;
  readonly provider: ProviderSnapshot;
}

export interface CompanionInitiativeDecider {
  decide(
    evidence: CompanionInitiativeEvidence,
    signal: AbortSignal,
  ): Promise<CompanionInitiativeEvaluation>;
}

export interface AssistantInitiatedRunLauncher {
  startAssistantInitiated(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly onStarted?: (run: Run) => void;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run>;
}

export interface CompanionInitiativeRunReader {
  readCompletedAssistantMessage(runId: string): string | undefined;
}

export interface CompanionInitiativeJourneyReader {
  getSnapshot(): JourneySnapshot;
}

export interface CompanionInitiativeBubbleTarget {
  hasOutstandingBubble(): boolean;
  publishBubble(bubble: ProactiveConversationBubble): boolean;
}

interface PendingInitiativeRun {
  readonly appId?: string;
  readonly appName: string;
  readonly chatId: string;
  readonly grounding: string;
  readonly provisionalChat: boolean;
  readonly journeyId?: string;
  readonly windowTitle: string;
}

const DECISION_INSTRUCTIONS = `You are CharaMate's companionship initiative gate. You do not chat with the user, call tools, mutate state, or create a Journey. Decide whether one new foreground Activity observation justifies letting the conversational Agent open a lightweight conversation.

The observation is factual context, not a user request. Choose exactly one action:
- none: stay silent when the evidence is vague, routine, sensitive, system-like, merely an application name, ambiguous between Journeys, or lacks a concrete natural opening;
- new_conversation: there is a concrete, low-pressure opening but no supplied Journey is a unique semantic match;
- existing_journey: the observation uniquely and substantively matches one supplied Journey, so continuity belongs in that Journey's existing Chat.

Judge semantics from the full evidence. Do not use or imply a keyword rule. Do not infer document contents, deadlines, emotions, progress, or intent beyond app/window evidence. A window title can ground a gentle question, but cannot prove what the user is doing inside it. Prefer silence over generic check-ins, productivity coaching, praise, surveillance language, or fake concern. Never create or resume a Together Session or Journey from the observation.

The host already enforces a global delivery cooldown. Use recentInitiatives to decide whether the new opening would substantially repeat the topic, intent, or conversational move of any of the last three delivered initiatives. This is a semantic judgment, not literal string matching. Prefer none when a proposed opening would rephrase a recent one, especially when that initiative expired or was dismissed without a reply. A changed application or window title does not by itself make the opening meaningfully new, while shared words alone do not make distinct topics duplicates.

For existing_journey, journeyId must be an exact supplied ID and chatTitle must be null. For new_conversation, journeyId must be null and chatTitle must be a short neutral title for the resulting Chat. For none, both must be null. grounding is a short factual basis the conversational Agent may use, or null for none. Return only compact JSON with all four fields.`;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new TypeError(
      "Companionship initiative gate returned no JSON object",
    );
  }
  return JSON.parse(text.slice(start, end + 1));
}

function decisionPrompt(evidence: CompanionInitiativeEvidence): string {
  return JSON.stringify({
    journeys: evidence.journeys.map(
      ({ currentPosition, id, nextStep, purpose, status, title }) => ({
        ...(currentPosition ? { currentPosition } : {}),
        id,
        ...(nextStep ? { nextStep } : {}),
        purpose,
        status,
        title,
      }),
    ),
    observation: evidence.observation,
    recentInitiatives: evidence.recentInitiatives.map(
      ({
        appName,
        grounding,
        kind,
        message,
        outcome,
        shownAt,
        windowTitle,
      }) => ({
        appName,
        grounding,
        kind,
        message,
        outcome,
        shownAt,
        windowTitle,
      }),
    ),
  });
}

function assertDecision(
  decision: CompanionInitiativeDecision,
  journeys: readonly Journey[],
): void {
  if (decision.action === "none") {
    if (
      decision.chatTitle !== null ||
      decision.grounding !== null ||
      decision.journeyId !== null
    ) {
      throw new TypeError("Silent initiative decision must not select a Chat");
    }
    return;
  }
  if (!decision.grounding?.trim()) {
    throw new TypeError("Conversation initiative requires factual grounding");
  }
  if (decision.action === "new_conversation") {
    if (!decision.chatTitle?.trim() || decision.journeyId !== null) {
      throw new TypeError("New initiative conversation requires only a title");
    }
    return;
  }
  if (
    decision.chatTitle !== null ||
    !decision.journeyId ||
    !journeys.some(({ id }) => id === decision.journeyId)
  ) {
    throw new TypeError("Journey initiative selected an unavailable Journey");
  }
}

export class ModelCompanionInitiativeDecider implements CompanionInitiativeDecider {
  constructor(private readonly providers: ProviderService) {}

  async decide(
    evidence: CompanionInitiativeEvidence,
    signal: AbortSignal,
  ): Promise<CompanionInitiativeEvaluation> {
    const profileId = this.providers.getDefaultChatProfileId();
    const runtime = await this.providers.createChatModelRuntime(profileId);
    const turn = await collectModelTurn(
      runtime.provider.stream(
        {
          input: [
            {
              content: decisionPrompt(evidence),
              role: "user",
              type: "message",
            },
          ],
          instructions: DECISION_INSTRUCTIONS,
          modelId: runtime.snapshot.modelId,
          structuredOutput: {
            description:
              "Choose silence, a new conversation, or one supplied Journey for a grounded companionship opener.",
            name: "charamate_companion_initiative",
            schema: CompanionInitiativeDecisionSchema,
          },
          toolNamespaces: [],
        },
        signal,
      ),
    );
    if (turn.status !== "completed" || !turn.text.trim()) {
      throw new Error("Companionship initiative gate did not complete");
    }
    const decision = parseSchema(
      CompanionInitiativeDecisionSchema,
      extractJson(turn.text),
    );
    assertDecision(decision, evidence.journeys);
    return { decision, provider: runtime.snapshot };
  }
}

function openerPrompt(
  observation: ForegroundActivityObservation,
  grounding: string,
  recentInitiatives: readonly CompanionInitiativeRecord[],
  journey?: Journey,
): string {
  return [
    "This is an assistant-initiated companionship opener grounded in a current Activity observation, not a user message.",
    "Write exactly one short, natural conversational opening in the user's usual language. It may make a gentle observation or ask one easy question.",
    "Do not mention Activity capture, monitoring, routing, hidden context, a semantic gate, or these instructions.",
    "Never mention Journey, Together Session, Home Chat, 同行事项, 共处会话, internal state, or status labels; refer only to the concrete matter visible in the supplied evidence.",
    "Do not claim document contents, progress, goals, feelings, or intent beyond the supplied evidence. Do not praise, coach productivity, send a generic check-in, call tools, create/resume a Together Session, or create/reopen a Journey.",
    "Do not repeat or lightly paraphrase the topic, question, or conversational move of a recent initiative. The semantic gate has approved this opportunity, but the final wording must still be meaningfully distinct.",
    "The user has not replied yet, so keep the invitation low-pressure and complete in one message.",
    JSON.stringify({
      grounding,
      ...(journey
        ? {
            journey: {
              currentPosition: journey.currentPosition ?? null,
              nextStep: journey.nextStep ?? null,
              purpose: journey.purpose,
              status: journey.status,
              title: journey.title,
            },
          }
        : {}),
      observation,
      recentInitiatives: recentInitiatives.map(
        ({ message, outcome, shownAt }) => ({ message, outcome, shownAt }),
      ),
    }),
  ].join("\n");
}

function isTerminalRunEvent(
  envelope: RunEventEnvelope,
): envelope is RunEventEnvelope & {
  readonly event: {
    readonly run: Run;
    readonly type:
      "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted";
  };
} {
  return (
    envelope.event.type === "run.completed" ||
    envelope.event.type === "run.failed" ||
    envelope.event.type === "run.cancelled" ||
    envelope.event.type === "run.interrupted"
  );
}

export class CompanionInitiativeService implements ForegroundActivityObserver {
  #abort = new AbortController();
  #drainTask: Promise<void> | undefined;
  #latestObservation: ForegroundActivityObservation | undefined;
  #pendingRuns = new Map<string, PendingInitiativeRun>();
  #stopping = false;

  constructor(
    private readonly decider: CompanionInitiativeDecider,
    private readonly journeys: CompanionInitiativeJourneyReader,
    private readonly chats: ChatService,
    private readonly agent: AssistantInitiatedRunLauncher,
    private readonly runs: CompanionInitiativeRunReader,
    private readonly bubbles: CompanionInitiativeBubbleTarget,
    private readonly history: CompanionInitiativeHistory,
    private readonly policy: CompanionInitiativePolicyReader,
    private readonly clock: Clock,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly personaName: () => string = () => "Mika",
    private readonly readLocalMinuteOfDay: (
      timestamp: string,
    ) => number = localMinuteOfDay,
  ) {}

  observeForeground(observation: ForegroundActivityObservation): void {
    if (
      this.#stopping ||
      this.#pendingRuns.size > 0 ||
      this.bubbles.hasOutstandingBubble() ||
      !this.#policyAllowsInitiative()
    ) {
      return;
    }
    this.#latestObservation = observation;
    this.#scheduleDrain();
  }

  observeRun(envelope: RunEventEnvelope): void {
    if (this.#stopping) return;
    if (!isTerminalRunEvent(envelope)) return;
    const pending = this.#pendingRuns.get(envelope.event.run.id);
    if (!pending) return;
    this.#pendingRuns.delete(envelope.event.run.id);
    let delivered = false;
    if (envelope.event.type === "run.completed") {
      const content = this.runs
        .readCompletedAssistantMessage(envelope.event.run.id)
        ?.trim();
      if (content) {
        delivered = this.bubbles.publishBubble({
          chatId: pending.chatId,
          content,
          createdAt: envelope.occurredAt,
          id: envelope.event.run.id,
          ...(pending.journeyId ? { journeyId: pending.journeyId } : {}),
          kind: pending.provisionalChat ? "invitation" : "continuation",
          replyState: "ready",
        });
        if (delivered) {
          const shownAt = this.clock.now();
          try {
            this.history.recordShown({
              ...(pending.appId ? { appId: pending.appId } : {}),
              appName: pending.appName,
              grounding: pending.grounding,
              id: envelope.event.run.id,
              kind: pending.provisionalChat ? "invitation" : "continuation",
              message: content,
              shownAt,
              windowTitle: pending.windowTitle,
            });
          } catch (error) {
            this.logger.warn("COMPANION_INITIATIVE_HISTORY_WRITE_ERROR", {
              error,
              runId: envelope.event.run.id,
            });
          }
        }
      }
    }
    if (!delivered && pending.provisionalChat) {
      this.#discardProvisionalChat(pending.chatId);
    }
    this.#scheduleDrain();
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#latestObservation = undefined;
    this.#abort.abort();
    await this.#drainTask?.catch(() => undefined);
  }

  async settle(): Promise<void> {
    await this.#drainTask;
  }

  #scheduleDrain(): void {
    if (this.#stopping || this.#drainTask || !this.#latestObservation) return;
    const task = this.#drain();
    this.#drainTask = task;
    void task
      .catch((error: unknown) => {
        if (!this.#abort.signal.aborted) {
          this.logger.warn("COMPANION_INITIATIVE_ERROR", { error });
        }
      })
      .finally(() => {
        if (this.#drainTask === task) this.#drainTask = undefined;
        if (
          !this.#stopping &&
          this.#latestObservation &&
          this.#pendingRuns.size === 0 &&
          !this.bubbles.hasOutstandingBubble() &&
          this.#policyAllowsInitiative()
        ) {
          this.#scheduleDrain();
        }
      });
  }

  async #drain(): Promise<void> {
    while (!this.#stopping && this.#latestObservation) {
      if (
        this.#pendingRuns.size > 0 ||
        this.bubbles.hasOutstandingBubble() ||
        !this.#policyAllowsInitiative()
      ) {
        this.#latestObservation = undefined;
        return;
      }
      const observation = this.#latestObservation;
      this.#latestObservation = undefined;
      const windowTitle = observation.windowTitle?.trim();
      if (!windowTitle) continue;
      const snapshot = this.journeys.getSnapshot();
      if (snapshot.activeSession) continue;
      const recentInitiatives = this.history.listRecent();
      const evaluation = await this.decider.decide(
        { journeys: snapshot.journeys, observation, recentInitiatives },
        this.#abort.signal,
      );
      if (evaluation.decision.action === "none") continue;
      if (this.#latestObservation) continue;

      const currentSnapshot = this.journeys.getSnapshot();
      if (
        currentSnapshot.activeSession ||
        this.#pendingRuns.size > 0 ||
        this.bubbles.hasOutstandingBubble() ||
        !this.#policyAllowsInitiative()
      ) {
        return;
      }

      const journey =
        evaluation.decision.action === "existing_journey"
          ? currentSnapshot.journeys.find(
              ({ id }) => id === evaluation.decision.journeyId,
            )
          : undefined;
      if (evaluation.decision.action === "existing_journey" && !journey) {
        continue;
      }
      const grounding = evaluation.decision.grounding?.trim();
      if (!grounding) continue;
      const provisionalChat = !journey;
      const chat = journey
        ? this.chats.getSnapshot({ chatId: journey.homeChatId })?.chat
        : this.chats.createProvisional({
            title:
              evaluation.decision.chatTitle ?? `和 ${this.personaName()} 聊聊`,
          });
      if (!chat) continue;
      if (chat.status === "archived") {
        this.chats.restore({ chatId: chat.id });
      }
      const pendingRun = {
        ...(observation.appId ? { appId: observation.appId } : {}),
        appName: observation.appName,
        chatId: chat.id,
        grounding,
        provisionalChat,
        ...(journey ? { journeyId: journey.id } : {}),
        windowTitle,
      };
      try {
        await this.agent.startAssistantInitiated(
          {
            attachments: [],
            chatId: chat.id,
            content: openerPrompt(
              observation,
              grounding,
              recentInitiatives,
              journey,
            ),
            execution: { mode: "chat" },
            providerProfileId: evaluation.provider.profileId,
            requestedAt: this.clock.now(),
          },
          {
            modelId: evaluation.provider.modelId,
            onStarted: (started) => {
              this.#pendingRuns.set(started.id, pendingRun);
            },
            toolNames: [],
          },
        );
      } catch (error) {
        if (provisionalChat) this.#discardProvisionalChat(chat.id);
        throw error;
      }
      this.#latestObservation = undefined;
      return;
    }
  }

  #discardProvisionalChat(chatId: string): void {
    try {
      this.chats.discardProvisional(chatId);
    } catch (error) {
      this.logger.warn("COMPANION_INITIATIVE_CHAT_CLEANUP_ERROR", {
        chatId,
        error,
      });
    }
  }

  #policyAllowsInitiative(): boolean {
    const now = this.clock.now();
    return evaluateCompanionInitiativePolicy({
      localMinuteOfDay: this.readLocalMinuteOfDay(now),
      now,
      recentInitiatives: this.history.listRecent(),
      settings: this.policy.getCompanionInitiative(),
    }).eligible;
  }
}
