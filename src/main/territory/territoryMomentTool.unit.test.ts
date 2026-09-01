import { describe, expect, it } from "vitest";

import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../shared/contracts/settings";
import { ToolRegistry } from "../tools/toolRegistry";
import {
  registerTerritoryMomentTool,
  TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
} from "./territoryMomentTool";

const context = {
  itemId: "10000000-0000-4000-8000-000000000001",
  onDelta: () => undefined,
  runId: "10000000-0000-4000-8000-000000000002",
  signal: new AbortController().signal,
};

describe("territory.propose_moment", () => {
  it("records an evidence-grounded proposal without generating or applying it", async () => {
    const registry = new ToolRegistry();
    registerTerritoryMomentTool(registry, {
      getCompanionInitiative: () => ({
        ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
        territoryMomentSurprisesEnabled: true,
      }),
    });

    await expect(
      registry.execute(
        TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
        {
          description: "分享结束后的松弛，被傍晚的光轻轻接住。",
          name: "散场后的余光",
          visualPrompt: "warm sunset light resting on a small glass ornament",
        },
        context,
      ),
    ).resolves.toMatchObject({
      modelContent: {
        accepted: true,
        proposal: { name: "散场后的余光" },
      },
      status: "success",
    });
  });

  it("rejects the proposal when the separate Territory permission is off", async () => {
    const registry = new ToolRegistry();
    registerTerritoryMomentTool(registry, {
      getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS,
    });

    await expect(
      registry.execute(
        TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
        {
          description: "普通描述",
          name: "普通物件",
          visualPrompt: "small object",
        },
        context,
      ),
    ).resolves.toMatchObject({
      modelContent: {
        accepted: false,
        reason: "territory_moment_surprises_disabled",
      },
      status: "rejected",
    });
  });
});
