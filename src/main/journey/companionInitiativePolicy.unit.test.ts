import { describe, expect, it } from "vitest";

import type { CompanionInitiativeRecord } from "./companionInitiativeRepository";
import {
  evaluateCompanionInitiativePolicy,
  stepDownCompanionInitiativeLevel,
} from "./companionInitiativePolicy";

const now = "2026-08-31T04:00:00.000Z";

function record(
  minutesAgo: number,
  outcome: CompanionInitiativeRecord["outcome"],
): CompanionInitiativeRecord {
  return {
    appName: "Notes",
    grounding: "A document title is visible.",
    id: `00000000-0000-4000-8000-${String(minutesAgo).padStart(12, "0")}`,
    kind: "invitation",
    message: "还在整理这份内容吗？",
    outcome,
    shownAt: new Date(Date.parse(now) - minutesAgo * 60_000).toISOString(),
    sourceKind: "activity",
    updatedAt: now,
    windowTitle: "outline.md",
  };
}

const balanced = {
  importantMomentOutreachEnabled: false,
  importantMomentOutreachPrompted: false,
  level: "balanced",
  quietHours: { enabled: false, endMinute: 480, startMinute: 1320 },
} as const;

describe("companion initiative policy", () => {
  it("honors off and a quiet period that crosses midnight", () => {
    expect(
      evaluateCompanionInitiativePolicy({
        localMinuteOfDay: 720,
        now,
        recentInitiatives: [],
        settings: { ...balanced, level: "off" },
      }),
    ).toEqual({ eligible: false, reason: "level_off" });
    expect(
      evaluateCompanionInitiativePolicy({
        localMinuteOfDay: 7 * 60 + 59,
        now,
        recentInitiatives: [],
        settings: {
          ...balanced,
          quietHours: { enabled: true, endMinute: 480, startMinute: 1320 },
        },
      }),
    ).toEqual({ eligible: false, reason: "quiet_hours" });
  });

  it("applies a bounded linear backoff only to consecutive negative results", () => {
    expect(
      evaluateCompanionInitiativePolicy({
        localMinuteOfDay: 720,
        now,
        recentInitiatives: [record(130, "dismissed"), record(210, "expired")],
        settings: balanced,
      }),
    ).toEqual({ eligible: false, reason: "minimum_interval" });
    expect(
      evaluateCompanionInitiativePolicy({
        localMinuteOfDay: 720,
        now,
        recentInitiatives: [record(60, "replied"), record(130, "dismissed")],
        settings: balanced,
      }),
    ).toEqual({ eligible: true, reason: "eligible" });
    expect(
      evaluateCompanionInitiativePolicy({
        localMinuteOfDay: 720,
        now,
        recentInitiatives: [
          record(250, "dismissed"),
          record(310, "expired"),
          record(370, "dismissed"),
          record(430, "dismissed"),
        ],
        settings: balanced,
      }),
    ).toEqual({ eligible: true, reason: "eligible" });
  });

  it("steps down without turning a quiet preference into off", () => {
    expect(stepDownCompanionInitiativeLevel("lively")).toBe("balanced");
    expect(stepDownCompanionInitiativeLevel("balanced")).toBe("quiet");
    expect(stepDownCompanionInitiativeLevel("quiet")).toBe("quiet");
    expect(stepDownCompanionInitiativeLevel("off")).toBe("off");
  });
});
