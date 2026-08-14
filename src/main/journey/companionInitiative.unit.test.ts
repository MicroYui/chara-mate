import { describe, expect, it, vi } from "vitest";

import type { Chat } from "../../shared/contracts/chat";
import type { Journey, JourneySnapshot } from "../../shared/contracts/journey";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { Run } from "../../shared/contracts/run";
import type { Clock } from "../../shared/pure/clock";
import type { ChatService } from "../chat/chatService";
import type {
  ModelContextLimits,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import type { ProviderService } from "../providers/providerService";
import {
  CompanionInitiativeService,
  ModelCompanionInitiativeDecider,
  type AssistantInitiatedRunLauncher,
  type CompanionInitiativeDecider,
  type CompanionInitiativeEvaluation,
} from "./companionInitiative";

const NOW = "2026-08-13T09:00:00.000Z";
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const JOURNEY_CHAT_ID = "22222222-2222-4222-8222-222222222222";
const JOURNEY_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const PROFILE_ID = "66666666-6666-4666-8666-666666666666";

const providerSnapshot: ProviderSnapshot = {
  apiStyle: "openai-compatible",
  modelId: "gpt-example",
  profileId: PROFILE_ID,
  profileName: "Test provider",
};

const journey: Journey = {
  createdAt: NOW,
  currentPosition: "正在整理研究问题",
  homeChatId: JOURNEY_CHAT_ID,
  id: JOURNEY_ID,
  nextStep: "继续阅读相关论文",
  purpose: "完成未来几个月的毕业论文",
  status: "active",
  title: "毕业论文",
  updatedAt: NOW,
};

const observation = {
  appName: "Text Editor",
  eventId: EVENT_ID,
  observedAt: NOW,
  windowTitle: "thesis-outline.md",
};

class TextProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly output: string) {}

  resolveContextLimits(): Promise<ModelContextLimits> {
    return Promise.resolve({});
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    await Promise.resolve();
    signal.throwIfAborted();
    this.requests.push(request);
    yield { delta: this.output, type: "text.delta" };
    yield {
      responseId: "response-1",
      status: "completed",
      type: "response.completed",
      usage: { cachedInputTokens: 0, inputTokens: 20, outputTokens: 10 },
    };
  }
}

function providerServiceFor(provider: ModelProvider): ProviderService {
  return {
    createChatModelRuntime: () =>
      Promise.resolve({ provider, snapshot: providerSnapshot }),
    getDefaultChatProfileId: () => PROFILE_ID,
  } as unknown as ProviderService;
}

function chat(id: string, title: string): Chat {
  return {
    createdAt: NOW,
    id,
    status: "active",
    title,
    updatedAt: NOW,
  };
}

function run(chatId: string, status: Run["status"] = "running"): Run {
  return {
    chatId,
    createdAt: NOW,
    execution: { mode: "chat" },
    id: RUN_ID,
    latestSequence: 1,
    provider: providerSnapshot,
    source: "text",
    startedAt: NOW,
    status,
    ...(status === "completed" ? { endedAt: NOW } : {}),
  };
}

function completedEnvelope(chatId: string): RunEventEnvelope {
  return {
    event: { run: run(chatId, "completed"), type: "run.completed" },
    occurredAt: NOW,
    sequence: 3,
    streamId: RUN_ID,
  };
}

function startedEnvelope(
  chatId: string,
  runId = "99999999-9999-4999-8999-999999999999",
): RunEventEnvelope {
  return {
    event: {
      run: { ...run(chatId), id: runId },
      type: "run.started",
    },
    occurredAt: NOW,
    sequence: 1,
    streamId: runId,
  };
}

function userMessageEnvelope(
  runId = "99999999-9999-4999-8999-999999999999",
): RunEventEnvelope {
  return {
    event: {
      item: {
        artifacts: [],
        id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        kind: "user_message",
        runId,
        sequence: 2,
        startedAt: NOW,
        status: "running",
      },
      type: "item.started",
    },
    occurredAt: NOW,
    sequence: 2,
    streamId: runId,
  };
}

function snapshot(journeys: readonly Journey[] = []): JourneySnapshot {
  return { journeys: [...journeys], sessions: [] };
}

function serviceHarness(
  evaluation: CompanionInitiativeEvaluation,
  journeySnapshot = snapshot(),
) {
  const createdChats: Chat[] = [];
  const archivedChats: string[] = [];
  const discardedChats: string[] = [];
  const restoredChats: string[] = [];
  const existing = new Map<string, Chat>([
    [JOURNEY_CHAT_ID, chat(JOURNEY_CHAT_ID, "毕业论文")],
  ]);
  const chats = {
    archive: ({ chatId }: { readonly chatId: string }) => {
      archivedChats.push(chatId);
      const current = existing.get(chatId)!;
      const archived = {
        ...current,
        archivedAt: NOW,
        status: "archived" as const,
      };
      existing.set(chatId, archived);
      return archived;
    },
    createProvisional: ({ title }: { readonly title?: string }) => {
      const created = chat(CHAT_ID, title ?? "新对话");
      createdChats.push(created);
      existing.set(created.id, created);
      return created;
    },
    discardProvisional: (chatId: string) => {
      discardedChats.push(chatId);
      return existing.delete(chatId);
    },
    getSnapshot: ({ chatId }: { readonly chatId: string }) => {
      const value = existing.get(chatId);
      return value ? { chat: value } : null;
    },
    restore: ({ chatId }: { readonly chatId: string }) => {
      restoredChats.push(chatId);
      return existing.get(chatId)!;
    },
  } as unknown as ChatService;
  const decider = {
    decide: vi.fn(() => Promise.resolve(evaluation)),
  } satisfies CompanionInitiativeDecider;
  const launched: Array<{
    readonly content: string;
    readonly requestChatId: string;
    readonly toolNames: readonly string[] | undefined;
  }> = [];
  const agent: AssistantInitiatedRunLauncher = {
    startAssistantInitiated: (request, options) => {
      const started = run(request.chatId);
      launched.push({
        content: request.content,
        requestChatId: request.chatId,
        toolNames: options.toolNames,
      });
      options.onStarted?.(started);
      return Promise.resolve(started);
    },
  };
  const bubbles: Array<{
    readonly chatId: string;
    readonly content: string;
    readonly journeyId?: string;
  }> = [];
  let outstanding = false;
  const logger = { warn: vi.fn() };
  const service = new CompanionInitiativeService(
    decider,
    { getSnapshot: () => journeySnapshot },
    chats,
    agent,
    { readCompletedAssistantMessage: () => "你在整理这篇论文吗？" },
    {
      hasOutstandingBubble: () => outstanding,
      publishBubble: (bubble) => {
        outstanding = true;
        bubbles.push(bubble);
        return true;
      },
    },
    { now: () => NOW } satisfies Clock,
    logger,
  );
  return {
    archivedChats,
    bubbles,
    createdChats,
    decider,
    discardedChats,
    launched,
    logger,
    restoredChats,
    service,
    setOutstanding(value: boolean) {
      outstanding = value;
    },
  };
}

describe("ModelCompanionInitiativeDecider", () => {
  it("uses a tool-free structured semantic gate and accepts an exact Journey", async () => {
    const provider = new TextProvider(
      JSON.stringify({
        action: "existing_journey",
        chatTitle: null,
        grounding: "The active window title is thesis-outline.md.",
        journeyId: JOURNEY_ID,
      }),
    );
    const decider = new ModelCompanionInitiativeDecider(
      providerServiceFor(provider),
    );

    const evaluation = await decider.decide(
      { journeys: [journey], observation },
      new AbortController().signal,
    );

    expect(evaluation).toMatchObject({
      decision: { action: "existing_journey", journeyId: JOURNEY_ID },
      provider: providerSnapshot,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.toolNamespaces).toEqual([]);
    expect(provider.requests[0]?.structuredOutput).toMatchObject({
      name: "charamate_companion_initiative",
    });
    expect(provider.requests[0]?.instructions).toContain("Prefer silence");
    expect(JSON.stringify(provider.requests[0]?.input)).toContain(
      "thesis-outline.md",
    );
  });

  it("rejects an unavailable Journey instead of guessing a Chat", async () => {
    const provider = new TextProvider(
      JSON.stringify({
        action: "existing_journey",
        chatTitle: null,
        grounding: "A document is visible.",
        journeyId: "77777777-7777-4777-8777-777777777777",
      }),
    );
    const decider = new ModelCompanionInitiativeDecider(
      providerServiceFor(provider),
    );

    await expect(
      decider.decide(
        { journeys: [journey], observation },
        new AbortController().signal,
      ),
    ).rejects.toThrow("unavailable Journey");
  });

  it("keeps a vague observation silent without a fallback greeting", async () => {
    const provider = new TextProvider(
      JSON.stringify({
        action: "none",
        chatTitle: null,
        grounding: null,
        journeyId: null,
      }),
    );
    const decider = new ModelCompanionInitiativeDecider(
      providerServiceFor(provider),
    );

    await expect(
      decider.decide(
        {
          journeys: [journey],
          observation: { ...observation, windowTitle: "Untitled" },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ decision: { action: "none" } });
  });
});

describe("CompanionInitiativeService", () => {
  it("creates a normal Chat Run and projects its real assistant message", async () => {
    const fixture = serviceHarness({
      decision: {
        action: "new_conversation",
        chatTitle: "论文随聊",
        grounding: "The window title is thesis-outline.md.",
        journeyId: null,
      },
      provider: providerSnapshot,
    });

    fixture.service.observeForeground(observation);
    await fixture.service.settle();

    expect(fixture.createdChats).toEqual([
      expect.objectContaining({ id: CHAT_ID, title: "论文随聊" }),
    ]);
    expect(fixture.launched).toEqual([
      expect.objectContaining({ requestChatId: CHAT_ID, toolNames: [] }),
    ]);
    expect(fixture.launched[0]?.content).toContain(
      "assistant-initiated companionship opener",
    );
    expect(fixture.bubbles).toEqual([]);

    fixture.service.observeRun(completedEnvelope(CHAT_ID));
    expect(fixture.bubbles).toMatchObject([
      {
        chatId: CHAT_ID,
        content: "你在整理这篇论文吗？",
        kind: "invitation",
      },
    ]);
  });

  it("routes a matching observation to the Journey Home Chat without resuming state", async () => {
    const journeySnapshot = snapshot([journey]);
    const fixture = serviceHarness(
      {
        decision: {
          action: "existing_journey",
          chatTitle: null,
          grounding: "The window title is thesis-outline.md.",
          journeyId: JOURNEY_ID,
        },
        provider: providerSnapshot,
      },
      journeySnapshot,
    );

    fixture.service.observeForeground(observation);
    await fixture.service.settle();

    expect(fixture.createdChats).toEqual([]);
    expect(fixture.launched[0]?.requestChatId).toBe(JOURNEY_CHAT_ID);
    expect(journeySnapshot).toEqual(snapshot([journey]));

    fixture.service.observeRun(completedEnvelope(JOURNEY_CHAT_ID));
    expect(fixture.bubbles).toMatchObject([
      {
        chatId: JOURNEY_CHAT_ID,
        content: "你在整理这篇论文吗？",
        journeyId: JOURNEY_ID,
        kind: "continuation",
      },
    ]);
  });

  it("does not evaluate while a Session or another bubble is active", async () => {
    const activeSnapshot: JourneySnapshot = {
      activeSession: {
        chatId: JOURNEY_CHAT_ID,
        createdAt: NOW,
        id: "88888888-8888-4888-8888-888888888888",
        journeyId: JOURNEY_ID,
        status: "active",
        title: "一起整理论文",
        updatedAt: NOW,
      },
      journeys: [journey],
      sessions: [],
    };
    const activeFixture = serviceHarness(
      {
        decision: {
          action: "new_conversation",
          chatTitle: "不应创建",
          grounding: "Visible title",
          journeyId: null,
        },
        provider: providerSnapshot,
      },
      activeSnapshot,
    );
    activeFixture.service.observeForeground(observation);
    await activeFixture.service.settle();
    expect(activeFixture.decider.decide).not.toHaveBeenCalled();

    const bubbleFixture = serviceHarness({
      decision: {
        action: "new_conversation",
        chatTitle: "不应创建",
        grounding: "Visible title",
        journeyId: null,
      },
      provider: providerSnapshot,
    });
    bubbleFixture.setOutstanding(true);
    bubbleFixture.service.observeForeground(observation);
    await bubbleFixture.service.settle();
    expect(bubbleFixture.decider.decide).not.toHaveBeenCalled();
  });

  it("does not start another opener after one is ignored until the user engages", async () => {
    const fixture = serviceHarness({
      decision: {
        action: "new_conversation",
        chatTitle: "论文随聊",
        grounding: "The window title is thesis-outline.md.",
        journeyId: null,
      },
      provider: providerSnapshot,
    });

    fixture.service.observeForeground(observation);
    await fixture.service.settle();
    fixture.service.observeRun(completedEnvelope(CHAT_ID));
    fixture.setOutstanding(false);

    fixture.service.observeForeground({
      ...observation,
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await fixture.service.settle();
    expect(fixture.decider.decide).toHaveBeenCalledOnce();

    fixture.service.observeRun(startedEnvelope(CHAT_ID));
    fixture.service.observeForeground({
      ...observation,
      eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    await fixture.service.settle();
    expect(fixture.decider.decide).toHaveBeenCalledOnce();

    fixture.service.observeRun(userMessageEnvelope());
    fixture.service.observeForeground({
      ...observation,
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await fixture.service.settle();
    expect(fixture.decider.decide).toHaveBeenCalledTimes(2);
  });

  it("archives a new empty Chat when its proactive Run fails", async () => {
    const fixture = serviceHarness({
      decision: {
        action: "new_conversation",
        chatTitle: "论文随聊",
        grounding: "The window title is thesis-outline.md.",
        journeyId: null,
      },
      provider: providerSnapshot,
    });

    fixture.service.observeForeground(observation);
    await fixture.service.settle();
    fixture.service.observeRun({
      event: {
        run: { ...run(CHAT_ID), endedAt: NOW, status: "failed" },
        type: "run.failed",
      },
      occurredAt: NOW,
      sequence: 3,
      streamId: RUN_ID,
    });

    expect(fixture.discardedChats).toEqual([CHAT_ID]);
    expect(fixture.bubbles).toEqual([]);
  });
});
