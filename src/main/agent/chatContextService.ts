import type { Message } from "../../shared/contracts/chat";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { Clock } from "../../shared/pure/clock";
import {
  resolvedInputBudget,
  shouldCompactContextInput,
  type ContextInputMeasurement,
} from "./contextCompiler";
import {
  collectModelTurn,
  type ModelContextLimits,
  type ModelProvider,
  type ModelRequest,
} from "./modelProvider";
import { materializeCognitionContextInput } from "./cognitionContext";
import { ProviderError } from "../providers/providerError";
import { fitsInputBudget } from "../providers/inputBudget";
import {
  CHAT_CONTEXT_SUMMARY_PREFIX,
  type ChatContextSnapshot,
} from "../chat/chatContext";
import type { ChatRepository } from "../chat/chatRepository";
import type { RunRepository } from "./runRepository";

interface ContextMessage extends Message {
  readonly assistantMessages?: readonly JsonValue[];
}

interface MessageSegment {
  readonly messages: readonly ContextMessage[];
}

export interface ChatContextProjection {
  readonly compacted: boolean;
  readonly input: readonly JsonValue[];
  readonly messages: readonly ContextMessage[];
  readonly snapshot?: ChatContextSnapshot;
}

export interface PrepareChatContextRequest {
  readonly additionalInput?: readonly JsonValue[];
  readonly chatId: string;
  readonly force?: boolean;
  readonly limits: ModelContextLimits;
  readonly modelId: string;
  readonly measureInput?: ContextInputMeasurement;
  readonly provider: ModelProvider;
  readonly signal: AbortSignal;
}

function messageInput(message: ContextMessage): readonly JsonValue[] {
  return (
    message.assistantMessages ?? [
      {
        content: message.content,
        role: message.role,
        type: "message",
      },
    ]
  );
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

function segments(messages: readonly ContextMessage[]): MessageSegment[] {
  const values: MessageSegment[] = [];
  let currentKey: string | undefined;
  let current: ContextMessage[] = [];
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

function transcript(messages: readonly ContextMessage[]): string {
  return messages
    .map(
      (message) =>
        `[${message.createdAt} ${message.role} messageId=${message.id}]\n${
          message.assistantMessages === undefined
            ? message.content
            : JSON.stringify({ assistantMessages: message.assistantMessages })
        }`,
    )
    .join("\n\n");
}

function summaryRequestInput(
  previousSummary: string,
  messages: readonly ContextMessage[],
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

function summaryRequest(
  modelId: string,
  previousSummary: string,
  messages: readonly ContextMessage[],
): ModelRequest {
  return {
    input: summaryRequestInput(previousSummary, messages),
    instructions: [
      "You maintain CharaMate conversation working memory.",
      "Return only a concise factual summary of the supplied completed messages.",
      "Preserve user goals, constraints, durable conversational context, completed actions, important decisions, corrections, and unresolved questions.",
      "Original assistant messages retain their Provider phase: commentary is progress, not proof of completion; final_answer is an answer label, not proof of a Tool effect. Missing or null phase is unknown. Preserve unresolved work without promoting progress into a completed action.",
      "Do not invent facts, do not include credentials, and do not mention that summarization occurred.",
      "Use the language of the conversation. Organize the result under: Goals and context; Constraints and preferences; Completed actions and decisions; Unresolved items.",
    ].join("\n"),
    modelId,
    nativeWebSearch: false,
    toolNamespaces: [],
  };
}

function oversizedContext(): ProviderError {
  return new ProviderError(
    "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
    "单段会话、当前输入或摘要超过可整理的输入预算，请缩短内容或分段提供。",
    false,
  );
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
    private readonly runs: RunRepository,
  ) {}

  project(chatId: string): ChatContextProjection {
    const snapshot = this.chats.getContextSnapshot(chatId);
    const messages = this.chats
      .listContextMessages(
        chatId,
        snapshot?.coveredThroughMessageId && snapshot.coveredThroughCreatedAt
          ? {
              createdAt: snapshot.coveredThroughCreatedAt,
              messageId: snapshot.coveredThroughMessageId,
            }
          : undefined,
      )
      .map((message): ContextMessage => {
        const assistantMessages =
          message.role === "assistant" && message.runId
            ? this.runs.getAssistantMessages(message.runId, message.id)
            : undefined;
        return {
          ...message,
          ...(assistantMessages === undefined ? {} : { assistantMessages }),
        };
      });
    const summary = snapshot ? summaryInput(snapshot) : undefined;
    return {
      compacted: false,
      input: [...(summary ? [summary] : []), ...messages.flatMap(messageInput)],
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
    request.signal.throwIfAborted();
    let projection = this.project(request.chatId);
    const additionalInput = request.additionalInput ?? [];
    const measurement: ContextInputMeasurement =
      request.measureInput ??
      ((input, options) =>
        request.provider.measureInput(
          {
            input: input.map(materializeCognitionContextInput),
            instructions: "",
            modelId: request.modelId,
            nativeWebSearch: false,
            toolNamespaces: [],
          },
          request.signal,
          options,
        ));
    const measure: ContextInputMeasurement = async (input, options) => {
      request.signal.throwIfAborted();
      const result = await measurement(input, options);
      request.signal.throwIfAborted();
      return result;
    };
    if (
      !request.force &&
      !(await this.#shouldCompact(
        projection,
        additionalInput,
        request.limits,
        request.modelId,
        measure,
      ))
    ) {
      return projection;
    }

    let compacted = false;
    let force = request.force === true;
    while (projection.messages.length > 0) {
      const grouped = segments(projection.messages);
      const targetCount = force
        ? grouped.length
        : await this.#segmentsToCover(
            projection,
            grouped,
            additionalInput,
            request.limits,
            request.modelId,
            measure,
          );
      if (targetCount <= 0) break;

      let remaining = targetCount;
      while (remaining > 0) {
        const current = projection.snapshot;
        const batchCount = await this.#summaryBatchCount(
          current,
          grouped.slice(targetCount - remaining, targetCount),
          request.limits,
          request.modelId,
          request.provider,
          request.signal,
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
          request.limits,
          request.signal,
        );
        request.signal.throwIfAborted();
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
        !(await this.#shouldCompact(
          projection,
          additionalInput,
          request.limits,
          request.modelId,
          measure,
        ))
      ) {
        break;
      }
    }

    if (
      !fitsInputBudget(
        await measure([...projection.input, ...additionalInput]),
        resolvedInputBudget(request.limits),
      )
    ) {
      throw oversizedContext();
    }
    return { ...projection, compacted };
  }

  async #shouldCompact(
    projection: ChatContextProjection,
    additionalInput: readonly JsonValue[],
    limits: ModelContextLimits,
    modelId: string,
    measure: ContextInputMeasurement,
  ): Promise<boolean> {
    const snapshot = projection.snapshot;
    const budget = resolvedInputBudget(limits);
    return shouldCompactContextInput(
      [...projection.input, ...additionalInput],
      budget,
      measure,
      snapshot?.lastModelId === modelId &&
        snapshot.lastRequestBytes !== undefined &&
        snapshot.lastInputTokens !== undefined
        ? {
            inputTokens: snapshot.lastInputTokens,
            requestBytes: snapshot.lastRequestBytes,
          }
        : undefined,
    );
  }

  async #segmentsToCover(
    projection: ChatContextProjection,
    grouped: readonly MessageSegment[],
    additionalInput: readonly JsonValue[],
    limits: ModelContextLimits,
    modelId: string,
    measure: ContextInputMeasurement,
  ): Promise<number> {
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
          ...remainingMessages.flatMap(messageInput),
        ],
        messages: remainingMessages,
      };
      if (
        !(await this.#shouldCompact(
          candidate,
          additionalInput,
          limits,
          modelId,
          measure,
        ))
      ) {
        return count;
      }
    }
    return grouped.length;
  }

  async #summaryBatchCount(
    snapshot: ChatContextSnapshot | undefined,
    candidates: readonly MessageSegment[],
    limits: ModelContextLimits,
    modelId: string,
    provider: ModelProvider,
    signal: AbortSignal,
  ): Promise<number> {
    const budget = resolvedInputBudget(limits);
    for (let count = candidates.length; count >= 1; count -= 1) {
      signal.throwIfAborted();
      const request = summaryRequest(
        modelId,
        snapshot?.summary ?? "",
        candidates.slice(0, count).flatMap((segment) => segment.messages),
      );
      const measurement = await provider.measureInput(request, signal);
      signal.throwIfAborted();
      if (fitsInputBudget(measurement, budget)) {
        return count;
      }
    }
    throw oversizedContext();
  }

  async #summarize(
    provider: ModelProvider,
    modelId: string,
    previousSummary: string,
    messages: readonly ContextMessage[],
    limits: ModelContextLimits,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const request = summaryRequest(modelId, previousSummary, messages);
    const measuredRequest = await provider.measureInput(request, signal);
    signal.throwIfAborted();
    if (!fitsInputBudget(measuredRequest, resolvedInputBudget(limits))) {
      throw oversizedContext();
    }
    const turn = await collectModelTurn(provider.stream(request, signal));
    signal.throwIfAborted();
    const summary = turn.text.trim();
    if (turn.status !== "completed" || !summary) {
      throw new ProviderError(
        "PROVIDER.REQUEST_FAILED",
        "模型没有完成会话上下文整理，请重试。",
        true,
      );
    }
    const measuredSummary = await provider.measureInput(
      summaryRequest(modelId, summary, []),
      signal,
    );
    signal.throwIfAborted();
    if (!fitsInputBudget(measuredSummary, resolvedInputBudget(limits))) {
      throw oversizedContext();
    }
    return summary;
  }
}
