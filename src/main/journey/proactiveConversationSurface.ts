import type { StartRunRequest } from "../../shared/contracts/agent";
import type { ChatStatus } from "../../shared/contracts/chat";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type {
  ProactiveConversationBubble,
  ProactiveConversationBubbleReplyRequest,
} from "../../shared/contracts/pet";
import type { Run } from "../../shared/contracts/run";
import {
  ProactiveConversationBubbleReplyRequestSchema,
  ProactiveConversationBubbleSchema,
} from "../../shared/schemas/pet";
import { parseSchema } from "../../shared/schemas/validation";
import type { CompanionInitiativeOutcome } from "./companionInitiativeRepository";

export interface InlineConversationChatStore {
  discardProvisional(chatId: string): boolean;
  establishProvisional(chatId: string): void;
  getStatus(chatId: string): ChatStatus | undefined;
  restore(chatId: string): void;
}

export interface InlineConversationAgent {
  startInlineConversation(
    request: StartRunRequest,
    options: { readonly onRunAllocated: (runId: string) => void },
  ): Promise<Run>;
}

export interface InlineConversationProvider {
  getDefaultChatProfileId(): string;
}

export interface InlineConversationRunReader {
  getRun(runId: string): Run | undefined;
  readCompletedAssistantMessage(runId: string): string | undefined;
}

export interface ProactiveConversationProjector {
  clear(bubbleId?: string): void;
  show(bubble: ProactiveConversationBubble): void;
}

export interface ProactiveConversationLifecycleObserver {
  recordOutcome(
    bubbleId: string,
    outcome: Exclude<CompanionInitiativeOutcome, "accepted">,
  ): void;
}

export const PROVISIONAL_CHAT_REPLY_WINDOW_MS = 20_000;

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

export class ProactiveConversationSurface {
  #bubble: ProactiveConversationBubble | undefined;
  #engaged = false;
  #expirationTimer: ReturnType<typeof setTimeout> | undefined;
  #replyRunId: string | undefined;

  constructor(
    private readonly chats: InlineConversationChatStore,
    private readonly agent: InlineConversationAgent,
    private readonly providers: InlineConversationProvider,
    private readonly runs: InlineConversationRunReader,
    private readonly projector: ProactiveConversationProjector,
    private readonly lifecycle?: ProactiveConversationLifecycleObserver,
    private readonly provisionalReplyWindowMs = PROVISIONAL_CHAT_REPLY_WINDOW_MS,
  ) {}

  current(): ProactiveConversationBubble | undefined {
    return this.#bubble;
  }

  hasOutstandingBubble(): boolean {
    return this.#bubble !== undefined;
  }

  publish(
    input: ProactiveConversationBubble,
    options: { readonly replace?: boolean } = {},
  ): boolean {
    const bubble = parseSchema(ProactiveConversationBubbleSchema, input);
    if (this.#bubble && (!options.replace || this.#engaged)) return false;
    if (this.#bubble) this.#releaseCurrent(false, "interrupted");
    this.#resetReply();
    this.#engaged = false;
    this.#bubble = bubble;
    this.projector.show(bubble);
    if (bubble.kind === "invitation") this.#scheduleExpiration(bubble.id);
    return true;
  }

  clear(bubbleId?: string): boolean {
    if (!this.#bubble || (bubbleId && this.#bubble.id !== bubbleId)) {
      return false;
    }
    this.#releaseCurrent(true, "dismissed");
    return true;
  }

  shutdown(): void {
    if (this.#bubble) this.#releaseCurrent(true, "interrupted");
    else this.#cancelExpiration();
  }

  async reply(input: ProactiveConversationBubbleReplyRequest): Promise<Run> {
    const request = parseSchema(
      ProactiveConversationBubbleReplyRequestSchema,
      input,
    );
    const bubble = this.#bubble;
    if (!bubble || bubble.id !== request.bubbleId) {
      throw new Error("The proactive conversation is no longer available");
    }
    if (bubble.replyState === "responding") {
      throw new Error("The proactive conversation is already responding");
    }
    const chatStatus = this.chats.getStatus(bubble.chatId);
    if (!chatStatus) {
      this.#update({ replyState: "failed" });
      throw new Error("The proactive conversation Chat no longer exists");
    }
    if (chatStatus === "archived") {
      this.chats.restore(bubble.chatId);
    }

    this.#engage();
    this.#update({ replyState: "responding" });
    const providerProfileId =
      this.runs.getRun(bubble.id)?.provider.profileId ??
      this.providers.getDefaultChatProfileId();
    try {
      const run = await this.agent.startInlineConversation(
        {
          attachments: [],
          chatId: bubble.chatId,
          content: request.content,
          execution: { mode: "chat" },
          providerProfileId,
          requestedAt: request.requestedAt,
        },
        {
          onRunAllocated: (runId) => {
            if (
              this.#bubble?.id !== bubble.id ||
              this.#bubble.replyState !== "responding"
            ) {
              throw new Error("The proactive conversation was closed");
            }
            this.#replyRunId = runId;
          },
        },
      );
      if (
        !this.#replyRunId &&
        this.#bubble?.id === bubble.id &&
        this.#bubble.replyState === "responding"
      ) {
        this.#replyRunId = run.id;
      }
      return run;
    } catch (error) {
      if (this.#bubble?.id === bubble.id) {
        this.#update({ replyState: "failed" });
      }
      this.#resetReply();
      throw error;
    }
  }

  observeRun(envelope: RunEventEnvelope): void {
    if (envelope.event.type === "run.started") {
      const run = envelope.event.run;
      if (run.id === this.#replyRunId) return;
      if (run.source === "voice" && this.#bubble?.chatId === run.chatId) {
        this.#engage();
        return;
      }
      if (this.#bubble?.chatId === run.chatId && this.#bubble.id !== run.id) {
        this.#releaseCurrent(true, "interrupted");
      }
      return;
    }

    const run = terminalRun(envelope);
    if (!run || run.id !== this.#replyRunId) return;
    this.#resetReply();
    if (!this.#bubble) return;
    const content =
      envelope.event.type === "run.completed"
        ? this.runs.readCompletedAssistantMessage(run.id)?.trim()
        : undefined;
    this.#update(
      content
        ? {
            content,
            createdAt: envelope.occurredAt,
            replyState: "ready",
          }
        : { replyState: "failed" },
    );
  }

  #resetReply(): void {
    this.#replyRunId = undefined;
  }

  #cancelExpiration(): void {
    if (this.#expirationTimer) clearTimeout(this.#expirationTimer);
    this.#expirationTimer = undefined;
  }

  #engage(): void {
    const bubble = this.#bubble;
    if (!bubble || this.#engaged) return;
    if (bubble.kind === "invitation") {
      this.chats.establishProvisional(bubble.chatId);
      this.#cancelExpiration();
      this.#bubble = { ...bubble, kind: "continuation" };
      this.projector.show(this.#bubble);
    }
    this.#engaged = true;
    this.lifecycle?.recordOutcome(bubble.id, "replied");
  }

  #releaseCurrent(
    clearProjection: boolean,
    outcome: Exclude<CompanionInitiativeOutcome, "accepted" | "replied">,
  ): void {
    const bubble = this.#bubble;
    if (!bubble) return;
    this.#cancelExpiration();
    this.#bubble = undefined;
    if (!this.#engaged) this.lifecycle?.recordOutcome(bubble.id, outcome);
    this.#engaged = false;
    this.#resetReply();
    if (clearProjection) this.projector.clear(bubble.id);
    if (bubble.kind === "invitation") {
      this.chats.discardProvisional(bubble.chatId);
    }
  }

  #scheduleExpiration(bubbleId: string): void {
    this.#cancelExpiration();
    this.#expirationTimer = setTimeout(() => {
      this.#expirationTimer = undefined;
      if (this.#bubble?.id === bubbleId) {
        this.#releaseCurrent(true, "expired");
      }
    }, this.provisionalReplyWindowMs);
    this.#expirationTimer.unref?.();
  }

  #update(
    patch: Partial<
      Pick<ProactiveConversationBubble, "content" | "createdAt" | "replyState">
    >,
  ): void {
    if (!this.#bubble) return;
    this.#bubble = { ...this.#bubble, ...patch };
    this.projector.show(this.#bubble);
  }
}
