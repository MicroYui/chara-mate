import { describe, expect, it } from "vitest";

import type { ActivityEpisode } from "../../shared/contracts/activity";
import {
  ACTIVITY_SEARCH_LIMIT,
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

  it("keeps unknown and user foreground durations separate and searchable", () => {
    const source = episode({
      actor: "unknown",
      appName: "Editor",
      id: "30000000-0000-4000-8000-000000000099",
      startedAt: "2026-08-04T01:00:00.000Z",
      endedAt: "2026-08-04T02:00:00.000Z",
    });
    const later = {
      ...source,
      id: "30000000-0000-4000-8000-000000000098",
      startedAt: "2026-08-11T01:00:00.000Z",
      endedAt: "2026-08-11T02:00:00.000Z",
    };
    const user = {
      ...source,
      actor: "user" as const,
      id: "30000000-0000-4000-8000-000000000097",
    };
    const result = searchActivityEpisodes(
      [source, later, user],
      "Editor",
      "Asia/Shanghai",
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "unknown",
          label: "Editor",
          activeDays: 2,
          totalMinutes: 120,
        }),
        expect.objectContaining({
          actor: "user",
          label: "Editor",
          activeDays: 1,
          totalMinutes: 60,
        }),
      ]),
    );
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
});
