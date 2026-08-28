import { describe, expect, it } from "vitest";

import type {
  ActivityDigest,
  ActivityEpisode,
} from "../../shared/contracts/activity";
import {
  ACTIVITY_SEARCH_LIMIT,
  buildStableActivityPatterns,
  searchActivityEpisodes,
} from "./activityRecall";

function episode(input: {
  actor?: ActivityEpisode["actor"];
  appName?: string;
  domain?: string;
  endedAt: string;
  id: string;
  startedAt: string;
  summary?: string;
}): ActivityEpisode {
  return {
    actor: input.actor ?? "user",
    appNames: input.appName ? [input.appName] : [],
    createdAt: input.endedAt,
    domains: input.domain ? [input.domain] : [],
    endedAt: input.endedAt,
    eventCount: 1,
    id: input.id,
    screenshotStorageKeys: [],
    sourceTypes: input.domain ? ["managed_browser"] : ["active_app"],
    startedAt: input.startedAt,
    summary: input.summary ?? `${input.appName ?? input.domain} 活动`,
    title: input.appName ?? input.domain ?? "活动",
    updatedAt: input.endedAt,
  };
}

function weekly(input: {
  episodeIds: string[];
  id: string;
  periodEnd: string;
  periodStart: string;
}): ActivityDigest {
  return {
    candidateIds: [],
    createdAt: input.periodEnd,
    evidenceDays: 1,
    episodeIds: input.episodeIds,
    id: input.id,
    kind: "weekly",
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    summary: "Visual Studio Code 60 分钟",
    title: `${input.periodStart.slice(0, 10)} 起一周趋势`,
  };
}

describe("Activity recall", () => {
  it("returns bounded observed aggregates without raw evidence or IDs", () => {
    const episodes = Array.from({ length: 10 }, (_, index) =>
      episode({
        appName: `App ${String(index)}`,
        endedAt: `2026-08-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`,
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        startedAt: `2026-08-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
        summary: `private-window-title-${String(index)}`,
      }),
    );
    episodes.push(
      episode({
        actor: "agent",
        appName: "Agent Terminal",
        endedAt: "2026-08-12T02:00:00.000Z",
        id: "20000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-12T01:00:00.000Z",
      }),
    );

    const result = searchActivityEpisodes(episodes, undefined, "Asia/Shanghai");
    const serialized = JSON.stringify(result);

    expect(result).toHaveLength(ACTIVITY_SEARCH_LIMIT);
    expect(serialized.length).toBeLessThan(2_000);
    expect(serialized).not.toContain("private-window-title");
    expect(serialized).not.toContain("10000000-0000-4000");
    expect(serialized).not.toContain("Agent Terminal");
  });

  it("uses query evidence internally but only returns the aggregate label", () => {
    const result = searchActivityEpisodes(
      [
        episode({
          appName: "Visual Studio Code",
          endedAt: "2026-08-04T02:00:00.000Z",
          id: "30000000-0000-4000-8000-000000000001",
          startedAt: "2026-08-04T01:00:00.000Z",
          summary: "Visual Studio Code：CharaMate private workspace",
        }),
      ],
      "CharaMate",
      "Asia/Shanghai",
    );

    expect(result).toEqual([
      expect.objectContaining({ label: "Visual Studio Code" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private workspace");
  });

  it("creates one stable fact from exactly the latest two completed weeks", () => {
    const episodes = [
      episode({
        appName: "Visual Studio Code",
        endedAt: "2026-08-04T02:00:00.000Z",
        id: "40000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-04T01:00:00.000Z",
      }),
      episode({
        appName: "Visual Studio Code",
        endedAt: "2026-08-11T02:00:00.000Z",
        id: "40000000-0000-4000-8000-000000000002",
        startedAt: "2026-08-11T01:00:00.000Z",
      }),
      episode({
        appName: "Visual Studio Code",
        endedAt: "2026-08-18T02:00:00.000Z",
        id: "40000000-0000-4000-8000-000000000003",
        startedAt: "2026-08-18T01:00:00.000Z",
      }),
    ];
    const digests = [
      weekly({
        episodeIds: [episodes[0]!.id],
        id: "50000000-0000-4000-8000-000000000001",
        periodEnd: "2026-08-10T00:00:00.000Z",
        periodStart: "2026-08-03T00:00:00.000Z",
      }),
      weekly({
        episodeIds: [episodes[1]!.id],
        id: "50000000-0000-4000-8000-000000000002",
        periodEnd: "2026-08-17T00:00:00.000Z",
        periodStart: "2026-08-10T00:00:00.000Z",
      }),
      weekly({
        episodeIds: [episodes[2]!.id],
        id: "50000000-0000-4000-8000-000000000003",
        periodEnd: "2026-08-24T00:00:00.000Z",
        periodStart: "2026-08-17T00:00:00.000Z",
      }),
    ];

    const patterns = buildStableActivityPatterns(
      digests,
      episodes,
      "Asia/Shanghai",
    );

    expect(patterns).toEqual([
      expect.objectContaining({
        content:
          "用户在多个自然周持续使用 Visual Studio Code。这是观察到的使用习惯，不等同于用户明确表达的偏好。",
        sourceIds: [digests[1]!.id, digests[2]!.id],
      }),
    ]);
    expect(patterns[0]?.sourceLabels).toHaveLength(2);
    expect(patterns[0]?.sourceLabels.join(" ")).not.toContain(episodes[0]!.id);
  });
});
