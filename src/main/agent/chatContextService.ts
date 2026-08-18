import type { Message } from "../../shared/contracts/chat";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { Clock } from "../../shared/pure/clock";
import {
  CONTEXT_COMPACTION_RATIO,
  estimatedInputTokens,
  resolvedInputBudget,
} from "./contextCompiler";
import {
  collectModelTurn,
  type ModelContextLimits,
  type ModelProvider,
} from "./modelProvider";
import { ProviderError } from "../providers/providerError";
import {
  CHAT_CONTEXT_SUMMARY_PREFIX,
  type ChatContextSnapshot,
} from "../chat/chatContext";
import type { ChatRepository } from "../chat/chatRepository";

interface MessageSegment {
  readonly messages: readonly Message[];
}

export interface ChatContextProjection {
  readonly compacted: boolean;
  readonly input: readonly JsonValue[];
  readonly messages: readonly Message[];
  readonly snapshot?: ChatContextSnapshot;
}

export interface PrepareChatContextRequest {
  readonly additionalInput?: readonly JsonValue[];
  readonly chatId: string;
  readonly force?: boolean;
  readonly limits: ModelContextLimits;
  readonly modelId: string;
  readonly provider: ModelProvider;
  readonly signal: AbortSignal;
}

function messageInput(message: Message): JsonValue {
  return {
    content: message.content,
    role: message.role,
    type: "message",
  };
}

function summaryInput(snapshot: ChatContextSnapshot): JsonValue | undefined {
  if (
    !snapshot.summary.trim() ||
    !snapshot.coveredThroughMessageId ||
    !snapshot.coveredThroughCreatedAt
  ) {
    return undefined;
  }
  return {
    content: [
      CHAT_CONTEXT_SUMMARY_PREFIX,
      `generation: ${snapshot.generation}`,
      `coveredThroughMessageId: ${snapshot.coveredThroughMessageId}`,
      snapshot.summary,
    ].join("\n"),
    role: "developer",
    type: "message",
  };
}

function segments(messages: readonly Message[]): MessageSegment[] {
  const values: MessageSegment[] = [];
  let currentKey: string | undefined;
  let current: Message[] = [];
  for (const message of messages) {
    const key = message.runId ?? `message:${message.id}`;
    if (current.length > 0 && key !== currentKey) {
      values.push({ messages: current });
      current = [];
    }
    currentKey = key;
    current.push(message);
  }
  if (current.length > 0) values.push({ messages: current });
  return values;
}

function transcript(messages: readonly Message[]): string {
  return messages
    .map(
      (message) =>
        `[${message.createdAt} ${message.role} messageId=${message.id}]\n${message.content}`,
    )
    .join("\n\n");
}

function summaryRequestInput(
  previousSummary: string,
  messages: readonly Message[],
): JsonValue[] {
  return [
    {
      content: [
        previousSummary.trim()
          ? `Previous authoritative summary:\n${previousSummary.trim()}`
          : "Previous authoritative summary: none.",
        `Completed Chat messages to incorporate:\n${transcript(messages)}`,
      ].join("\n\n"),
      role: "user",
      type: "message",
    },
  ];
}

function boundaryOf(segment: MessageSegment) {
  const message = segment.messages.at(-1);
  if (!message) throw new Error("Chat context segment is empty");
  return { createdAt: message.createdAt, messageId: message.id };
}

export class ChatContextService {
  constructor(
    private readonly chats: ChatRepository,
    private readonly clock: Clock,
  ) {}

  project(chatId: string): ChatContextProjection {
    const snapshot = this.chats.getContextSnapshot(chatId);
    const messages = this.chats.listContextMessages(
      chatId,
      snapshot?.coveredThroughMessageId && snapshot.coveredThroughCreatedAt
        ? {
            createdAt: snapshot.coveredThroughCreatedAt,
            messageId: snapshot.coveredThroughMessageId,
          }
        : undefined,
    );
    const summary = snapshot ? summaryInput(snapshot) : undefined;
    return {
      compacted: false,
      input: [...(summary ? [summary] : []), ...messages.map(messageInput)],
      messages,
      ...(snapshot ? { snapshot } : {}),
    };
  }

  recordUsage(input: {
    readonly chatId: string;
    readonly inputTokens: number;
    readonly modelId: string;
    readonly requestBytes: number;
  }): void {
    if (input.inputTokens <= 0 || input.requestBytes <= 0) return;
    this.chats.recordContextUsage({
      ...input,
      updatedAt: this.clock.now(),
    });
  }

  async prepare(
    request: PrepareChatContextRequest,
  ): Promise<ChatContextProjection> {
    let projection = this.project(request.chatId);
    const additionalInput = request.additionalInput ?? [];
    if (
      !request.force &&
      !this.#shouldCompact(
        projection,
        additionalInput,
        request.limits,
        request.modelId,
      )
    ) {
      return projection;
    }

    let compacted = false;
    let force = request.force === true;
    while (projection.messages.length > 0) {
      const grouped = segments(projection.messages);
      const targetCount = force
        ? grouped.length
        : this.#segmentsToCover(
            projection,
            grouped,
            additionalInput,
            request.limits,
            request.modelId,
          );
      if (targetCount <= 0) break;

      let remaining = targetCount;
      while (remaining > 0) {
        const current = projection.snapshot;
        const batchCount = this.#summaryBatchCount(
          current,
          grouped.slice(targetCount - remaining, targetCount),
          request.limits,
          request.modelId,
        );
        const batch = grouped.slice(
          targetCount - remaining,
          targetCount - remaining + batchCount,
        );
        const batchMessages = batch.flatMap((segment) => segment.messages);
        const summary = await this.#summarize(
          request.provider,
          request.modelId,
          current?.summary ?? "",
          batchMessages,
          request.signal,
        );
        const advanced = this.chats.advanceContextSnapshot({
          boundary: boundaryOf(batch.at(-1)!),
          chatId: request.chatId,
          expectedGeneration: current?.generation ?? 0,
          summary,
          updatedAt: this.clock.now(),
        });
        if (!advanced) {
          throw new ProviderError(
            "PROVIDER.REQUEST_FAILED",
            "会话上下文在整理时发生变化，请重试。",
            true,
          );
        }
        compacted = true;
        remaining -= batchCount;
        projection = this.project(request.chatId);
      }

      force = false;
      if (
        !this.#shouldCompact(
          projection,
          additionalInput,
          request.limits,
          request.modelId,
        )
      ) {
        break;
      }
    }

    return { ...projection, compacted };
  }

  #shouldCompact(
    projection: ChatContextProjection,
    additionalInput: readonly JsonValue[],
    limits: ModelContextLimits,
    modelId: string,
  ): boolean {
    const snapshot = projection.snapshot;
    const budget = resolvedInputBudget(limits);
    if (
      !snapshot ||
      !budget ||
      snapshot.lastModelId !== modelId ||
      snapshot.lastRequestBytes === undefined ||
      snapshot.lastInputTokens === undefined
    ) {
      return false;
    }
    return (
      estimatedInputTokens([...projection.input, ...additionalInput], {
        inputTokens: snapshot.lastInputTokens,
        requestBytes: snapshot.lastRequestBytes,
      }) >=
      budget * CONTEXT_COMPACTION_RATIO
    );
  }

  #segmentsToCover(
    projection: ChatContextProjection,
    grouped: readonly MessageSegment[],
    additionalInput: readonly JsonValue[],
    limits: ModelContextLimits,
    modelId: string,
  ): number {
    for (let count = 1; count <= grouped.length; count += 1) {
      const remainingMessages = grouped
        .slice(count)
        .flatMap((segment) => segment.messages);
      const candidate: ChatContextProjection = {
        ...projection,
        input: [
          ...(projection.snapshot && summaryInput(projection.snapshot)
            ? [summaryInput(projection.snapshot)!]
            : []),
          ...remainingMessages.map(messageInput),
        ],
        messages: remainingMessages,
      };
      if (!this.#shouldCompact(candidate, additionalInput, limits, modelId)) {
        return count;
      }
    }
    return grouped.length;
  }

  #summaryBatchCount(
    snapshot: ChatContextSnapshot | undefined,
    candidates: readonly MessageSegment[],
    limits: ModelContextLimits,
    modelId: string,
  ): number {
    if (candidates.length <= 1) return candidates.length;
    if (
      !snapshot ||
      snapshot.lastModelId !== modelId ||
      snapshot.lastRequestBytes === undefined ||
      snapshot.lastInputTokens === undefined
    ) {
      return 1;
    }
    const budget = resolvedInputBudget(limits);
    if (!budget) return 1;
    for (let count = candidates.length; count >= 1; count -= 1) {
      const input = summaryRequestInput(
        snapshot.summary,
        candidates.slice(0, count).flatMap((segment) => segment.messages),
      );
      const estimated = estimatedInputTokens(input, {
        inputTokens: snapshot.lastInputTokens,
        requestBytes: snapshot.lastRequestBytes,
      });
      if (estimated < budget * CONTEXT_COMPACTION_RATIO) return count;
    }
    return 1;
  }

  async #summarize(
    provider: ModelProvider,
    modelId: string,
    previousSummary: string,
    messages: readonly Message[],
    signal: AbortSignal,
  ): Promise<string> {
    const turn = await collectModelTurn(
      provider.stream(
        {
          input: summaryRequestInput(previousSummary, messages),
          instructions: [
            "You maintain CharaMate conversation working memory.",
            "Return only a concise factual summary of the supplied completed messages.",
            "Preserve user goals, constraints, durable conversational context, completed actions, important decisions, corrections, and unresolved questions.",
            "Do not invent facts, do not include credentials, and do not mention that summarization occurred.",
            "Use the language of the conversation. Organize the result under: Goals and context; Constraints and preferences; Completed actions and decisions; Unresolved items.",
          ].join("\n"),
          modelId,
          nativeWebSearch: false,
          toolNamespaces: [],
        },
        signal,
      ),
    );
    const summary = turn.text.trim();
    if (turn.status !== "completed" || !summary) {
      throw new ProviderError(
        "PROVIDER.REQUEST_FAILED",
        "模型没有完成会话上下文整理，请重试。",
        true,
      );
    }
    return summary;
  }
}
