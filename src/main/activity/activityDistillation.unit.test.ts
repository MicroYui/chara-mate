import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../shared/contracts/activity";
import type { IdGenerator } from "../../shared/pure/id";
import { createWeeklyDigest, distillEpisodes } from "./activityDistillation";

const NOW = "2026-08-09T12:00:00.000Z";
const ids: IdGenerator = {
  generate: () => "44444444-4444-4444-8444-444444444444",
};

function screenshot(startedAt: string): ActivityEvent {
  return {
    actor: "user",
    details: {
      artifactId: "11111111-1111-4111-8111-111111111111",
      height: 800,
      mediaType: "image/png",
      source: "screenshot",
      storageKey: "11111111-1111-4111-8111-111111111111.png",
      width: 1280,
    },
    endedAt: startedAt,
    id: "22222222-2222-4222-8222-222222222222",
    startedAt,
  };
}

describe("activity distillation", () => {
  it("keeps a screenshot lifecycle bounded when no foreground event exists", () => {
    const [distilled] = distillEpisodes(
      [screenshot("2026-08-09T09:00:00.000Z")],
      ids,
      NOW,
    );

    expect(distilled).toMatchObject({
      episode: {
        eventCount: 1,
        screenshotStorageKeys: ["11111111-1111-4111-8111-111111111111.png"],
        sourceTypes: ["screenshot"],
        title: "屏幕记录",
      },
      eventIds: ["22222222-2222-4222-8222-222222222222"],
    });
    const secondDay = {
      ...distilled!.episode,
      endedAt: "2026-08-10T09:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
      startedAt: "2026-08-10T09:00:00.000Z",
    };
    expect(
      createWeeklyDigest(
        [distilled!.episode, secondDay],
        ids,
        NOW,
        "2026-08-04T16:00:00.000Z",
        "2026-08-11T16:00:00.000Z",
        "Asia/Shanghai",
      ).candidateIds,
    ).toEqual([]);
  });

  it("attaches the immediate screenshot to a browser-only observation", () => {
    const browser: ActivityEvent = {
      actor: "user",
      details: {
        domain: "example.com",
        source: "managed_browser",
        url: "https://example.com/docs",
      },
      endedAt: "2026-08-09T09:00:00.000Z",
      id: "33333333-3333-4333-8333-333333333333",
      startedAt: "2026-08-09T09:00:00.000Z",
    };

    const [distilled] = distillEpisodes(
      [browser, screenshot("2026-08-09T09:00:00.100Z")],
      ids,
      NOW,
    );

    expect(distilled).toMatchObject({
      episode: {
        domains: ["example.com"],
        eventCount: 2,
        sourceTypes: ["managed_browser", "screenshot"],
      },
      eventIds: [
        "33333333-3333-4333-8333-333333333333",
        "22222222-2222-4222-8222-222222222222",
      ],
    });
  });
});
