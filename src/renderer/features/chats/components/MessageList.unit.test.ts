import { describe, expect, it } from "vitest";

import { chatsFixture } from "../fixtures";
import type { ChatView } from "../types";
import { buildTimeline } from "./MessageList";

describe("MessageList timeline", () => {
  it("renders one Run after the latest steering message for that Run", () => {
    const base = chatsFixture.chats[0];
    if (!base) throw new Error("Missing Chat fixture");
    const run = base.runs[0];
    if (!run) throw new Error("Missing Run fixture");
    const steering = {
      attachments: [],
      record: {
        chatId: base.record.id,
        content: "追加方向",
        createdAt: "2026-08-01T08:00:00.000Z",
        id: "00000000-0000-4000-8000-000000000099",
        role: "user" as const,
        runId: run.record.id,
        status: "completed" as const,
        updatedAt: "2026-08-01T08:00:00.000Z",
      },
    };
    const chat: ChatView = {
      ...base,
      messages: [base.messages[0]!, steering, ...base.messages.slice(1)],
    };

    const timeline = buildTimeline(chat);
    const runEntries = timeline.filter(({ kind }) => kind === "run");
    const steeringIndex = timeline.findIndex(
      ({ id }) => id === steering.record.id,
    );
    const runIndex = timeline.findIndex(({ id }) => id === run.record.id);

    expect(runEntries).toHaveLength(1);
    expect(runIndex).toBe(steeringIndex + 1);
  });
});
