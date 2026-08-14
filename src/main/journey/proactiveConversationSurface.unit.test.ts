import { describe, expect, it, vi } from "vitest";

import type { ProactiveConversationBubble } from "../../shared/contracts/pet";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { Run } from "../../shared/contracts/run";
import {
  ProactiveConversationSurface,
  type InlineConversationAgent,
} from "./proactiveConversationSurface";

const NOW = "2026-08-14T03:00:00.000Z";
const LATER = "2026-08-14T03:00:02.000Z";
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN_RUN_ID = "22222222-2222-4222-8222-222222222222";
const REPLY_RUN_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_ID = "55555555-5555-4555-8555-555555555555";
const FALLBACK_PROFILE_ID = "66666666-6666-4666-8666-666666666666";

const provider: ProviderSnapshot = {
  apiStyle: "openai-compatible",
  modelId: "gpt-example",
  profileId: PROFILE_ID,
  profileName: "Conversation provider",
};

const bubble: ProactiveConversationBubble = {
  chatId: CHAT_ID,
  content: "你在整理实验设计吗？",
  createdAt: NOW,
  id: ORIGIN_RUN_ID,
  kind: "continuation",
  replyState: "ready",
};

function run(
  id: string,
  status: Run["status"] = "running",
  source: Run["source"] = "text",
): Run {
  return {
    chatId: CHAT_ID,
    createdAt: NOW,
    execution: { mode: "chat" },
    id,
    latestSequence: status === "running" ? 1 : 4,
    provider,
    source,
    startedAt: NOW,
    status,
    ...(status === "running" ? {} : { endedAt: LATER }),
  };
}

function envelope(
  id: string,
  type: "run.started" | "run.completed" | "run.failed",
  source: Run["source"] = "text",
): RunEventEnvelope {
  const status =
    type === "run.started"
      ? "running"
      : type === "run.completed"
        ? "completed"
        : "failed";
  return {
    event: { run: run(id, status, source), type },
    occurredAt: type === "run.started" ? NOW : LATER,
    sequence: type === "run.started" ? 1 : 4,
    streamId: id,
  };
}

function harness(chatStatus: "active" | "archived" = "active") {
  const shown: ProactiveConversationBubble[] = [];
  const cleared: Array<string | undefined> = [];
  const discardProvisional = vi.fn(() => true);
  const establishProvisional = vi.fn();
  const restore = vi.fn();
  const completedAssistantMessages = new Map<string, string>();
  const originRuns = new Map<string, Run>([
    [ORIGIN_RUN_ID, run(ORIGIN_RUN_ID, "completed")],
  ]);
  const startInlineConversation = vi.fn<
    InlineConversationAgent["startInlineConversation"]
  >((_request, options) => {
    options.onRunAllocated(REPLY_RUN_ID);
    return Promise.resolve(run(REPLY_RUN_ID));
  });
  const surface = new ProactiveConversationSurface(
    {
      discardProvisional,
      establishProvisional,
      getStatus: () => chatStatus,
      restore,
    },
    { startInlineConversation },
    { getDefaultChatProfileId: () => FALLBACK_PROFILE_ID },
    {
      getRun: (runId) => originRuns.get(runId),
      readCompletedAssistantMessage: (runId) =>
        completedAssistantMessages.get(runId),
    },
    {
      clear: (bubbleId) => {
        cleared.push(bubbleId);
      },
      show: (next) => {
        shown.push(next);
      },
    },
  );
  return {
    cleared,
    completedAssistantMessages,
    discardProvisional,
    establishProvisional,
    originRuns,
    restore,
    shown,
    startInlineConversation,
    surface,
  };
}

describe("ProactiveConversationSurface", () => {
  it("expires an unanswered new-Chat invitation and discards its provisional history", () => {
    vi.useFakeTimers();
    try {
      const fixture = harness();
      const invitation = { ...bubble, kind: "invitation" as const };
      expect(fixture.surface.publish(invitation)).toBe(true);

      vi.advanceTimersByTime(19_999);
      expect(fixture.surface.current()).toEqual(invitation);
      expect(fixture.discardProvisional).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(fixture.surface.current()).toBeUndefined();
      expect(fixture.cleared).toEqual([invitation.id]);
      expect(fixture.discardProvisional).toHaveBeenCalledWith(CHAT_ID);
      expect(fixture.establishProvisional).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("establishes the same provisional Chat on the first text reply and cancels expiry", async () => {
    vi.useFakeTimers();
    try {
      const fixture = harness();
      fixture.surface.publish({ ...bubble, kind: "invitation" });

      await fixture.surface.reply({
        bubbleId: bubble.id,
        content: "我正准备改实验设计。",
        requestedAt: NOW,
      });

      expect(fixture.establishProvisional).toHaveBeenCalledWith(CHAT_ID);
      expect(fixture.surface.current()).toMatchObject({
        chatId: CHAT_ID,
        kind: "continuation",
        replyState: "responding",
      });
      vi.advanceTimersByTime(20_000);
      expect(fixture.surface.current()).toBeDefined();
      expect(fixture.discardProvisional).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats starting Voice from an invitation as engagement", () => {
    vi.useFakeTimers();
    try {
      const fixture = harness();
      fixture.surface.publish({ ...bubble, kind: "invitation" });

      fixture.surface.observeRun(
        envelope(OTHER_RUN_ID, "run.started", "voice"),
      );

      expect(fixture.establishProvisional).toHaveBeenCalledWith(CHAT_ID);
      expect(fixture.surface.current()).toMatchObject({
        kind: "continuation",
      });
      vi.advanceTimersByTime(20_000);
      expect(fixture.surface.current()).toBeDefined();
      expect(fixture.discardProvisional).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs every inline turn in the exact bound Chat and returns the assistant reply to the same bubble", async () => {
    const fixture = harness();
    expect(fixture.surface.publish(bubble)).toBe(true);

    await expect(
      fixture.surface.reply({
        bubbleId: bubble.id,
        content: "对，正在改实验变量。",
        requestedAt: NOW,
      }),
    ).resolves.toMatchObject({ id: REPLY_RUN_ID });

    expect(fixture.startInlineConversation).toHaveBeenCalledOnce();
    expect(fixture.startInlineConversation.mock.calls[0]?.[0]).toEqual({
      attachments: [],
      chatId: CHAT_ID,
      content: "对，正在改实验变量。",
      execution: { mode: "chat" },
      providerProfileId: PROFILE_ID,
      requestedAt: NOW,
    });
    expect(fixture.surface.current()).toMatchObject({
      chatId: CHAT_ID,
      id: ORIGIN_RUN_ID,
      replyState: "responding",
    });

    fixture.surface.observeRun(envelope(REPLY_RUN_ID, "run.started"));
    fixture.completedAssistantMessages.set(
      REPLY_RUN_ID,
      "你打算如何控制这个变量？",
    );
    fixture.surface.observeRun(envelope(REPLY_RUN_ID, "run.completed"));

    expect(fixture.surface.current()).toEqual({
      ...bubble,
      content: "你打算如何控制这个变量？",
      createdAt: LATER,
      replyState: "ready",
    });
    expect(fixture.cleared).toEqual([]);
    expect(fixture.shown.at(-1)).toEqual(fixture.surface.current());
  });

  it("restores an archived bound Chat and uses the default profile only when the origin Run is unavailable", async () => {
    const fixture = harness("archived");
    fixture.originRuns.clear();
    fixture.surface.publish(bubble);

    await fixture.surface.reply({
      bubbleId: bubble.id,
      content: "继续聊吧。",
      requestedAt: NOW,
    });

    expect(fixture.restore).toHaveBeenCalledWith(CHAT_ID);
    expect(
      fixture.startInlineConversation.mock.calls[0]?.[0].providerProfileId,
    ).toBe(FALLBACK_PROFILE_ID);
  });

  it("does not let a new initiative replace an engaged conversation and closes only for the exact bubble", async () => {
    const fixture = harness();
    fixture.surface.publish(bubble);
    await fixture.surface.reply({
      bubbleId: bubble.id,
      content: "先把这轮聊完。",
      requestedAt: NOW,
    });
    const replacement = {
      ...bubble,
      content: "这是另一件事。",
      id: OTHER_RUN_ID,
      replyState: "ready" as const,
    };

    expect(fixture.surface.publish(replacement, { replace: true })).toBe(false);
    expect(fixture.surface.clear(OTHER_RUN_ID)).toBe(false);
    expect(fixture.surface.clear(bubble.id)).toBe(true);
    expect(fixture.cleared).toEqual([bubble.id]);
  });

  it("marks the bubble failed instead of inventing a second surface when its Run fails", async () => {
    const fixture = harness();
    fixture.surface.publish(bubble);
    await fixture.surface.reply({
      bubbleId: bubble.id,
      content: "再试一次。",
      requestedAt: NOW,
    });

    fixture.surface.observeRun(envelope(REPLY_RUN_ID, "run.failed"));

    expect(fixture.surface.current()).toMatchObject({
      chatId: CHAT_ID,
      id: ORIGIN_RUN_ID,
      replyState: "failed",
    });
  });

  it("hands the Chat back to the full surface if another Run starts there", () => {
    const fixture = harness();
    fixture.surface.publish(bubble);

    fixture.surface.observeRun(envelope(OTHER_RUN_ID, "run.started"));

    expect(fixture.surface.current()).toBeUndefined();
    expect(fixture.cleared).toEqual([bubble.id]);
  });

  it("keeps the bubble transport alive when Voice starts in its bound Chat", () => {
    const fixture = harness();
    fixture.surface.publish(bubble);

    fixture.surface.observeRun(envelope(OTHER_RUN_ID, "run.started", "voice"));

    expect(fixture.surface.current()).toEqual(bubble);
    expect(fixture.cleared).toEqual([]);
  });
});
