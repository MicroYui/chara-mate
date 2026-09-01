import { describe, expect, it } from "vitest";

import {
  TEXT_AGENT_BASE_INSTRUCTIONS,
  realtimeAgentInstructions,
} from "./agentInstructions";

describe("narrative agency instructions", () => {
  it("keeps explicit role-play inside the shared runtime and protects player control", () => {
    expect(TEXT_AGENT_BASE_INSTRUCTIONS).toContain(
      "keep it inside the ordinary Chat",
    );
    expect(TEXT_AGENT_BASE_INSTRUCTIONS).toContain(
      "The user alone controls their player character's actions, dialogue, decisions, and feelings",
    );
    expect(TEXT_AGENT_BASE_INSTRUCTIONS).toContain(
      "Fictional events are Chat-local context",
    );
    expect(TEXT_AGENT_BASE_INSTRUCTIONS).toContain(
      "does not prevent ordinary collaborative writing",
    );
  });

  it("uses the same boundary for Realtime voice", () => {
    const instructions = realtimeAgentInstructions({
      configured: "Speak naturally.",
      execution: { mode: "chat" },
      now: "2026-08-31T12:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });

    expect(instructions).toContain(
      "The user alone controls their player character's actions, dialogue, decisions, and feelings",
    );
    expect(instructions).toContain("never persist them through memory.record");
  });
});
