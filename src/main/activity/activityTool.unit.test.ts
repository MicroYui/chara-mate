import { describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/toolRegistry";
import {
  ACTIVITY_SEARCH_TOOL_NAME,
  registerActivityTool,
} from "./activityTool";

describe("Activity Agent Tool", () => {
  it("returns the compact observed projection and keeps the Tool deferred", async () => {
    const registry = new ToolRegistry();
    const search = vi.fn().mockReturnValue({
      observedBehaviorOnly: true,
      patterns: [
        {
          actor: "user",
          activeDays: 3,
          episodeCount: 4,
          firstSeenAt: "2026-08-01T01:00:00.000Z",
          kind: "app",
          label: "Visual Studio Code",
          lastSeenAt: "2026-08-03T02:00:00.000Z",
          totalMinutes: 180,
        },
      ],
      periodEnd: "2026-08-04T00:00:00.000Z",
      periodStart: "2026-08-01T00:00:00.000Z",
      query: "Visual Studio Code",
    });
    registerActivityTool(registry, { search, observe: vi.fn() });

    const result = await registry.execute(
      ACTIVITY_SEARCH_TOOL_NAME,
      { query: "Visual Studio Code" },
      {
        itemId: "item",
        onDelta: () => undefined,
        runId: "run",
        signal: new AbortController().signal,
      },
    );

    expect(search).toHaveBeenCalledWith({ query: "Visual Studio Code" });
    expect(result).toMatchObject({
      modelContent: {
        observedBehaviorOnly: true,
        patterns: [{ label: "Visual Studio Code" }],
      },
      status: "success",
      summary: "找到 1 条活动模式",
    });
    expect(
      registry.search("what software does the user usually use")[0]?.descriptor
        .name,
    ).toBe(ACTIVITY_SEARCH_TOOL_NAME);
  });
});
