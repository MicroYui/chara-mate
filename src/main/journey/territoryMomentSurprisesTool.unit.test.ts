import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COMPANION_INITIATIVE_SETTINGS,
  type CompanionInitiativeSettings,
} from "../../shared/contracts/settings";
import { ToolRegistry } from "../tools/toolRegistry";
import {
  registerTerritoryMomentSurprisesTool,
  TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
} from "./territoryMomentSurprisesTool";

const context = {
  itemId: "10000000-0000-4000-8000-000000000001",
  onDelta: () => undefined,
  runId: "10000000-0000-4000-8000-000000000002",
  signal: new AbortController().signal,
};

describe("companion.territory_moment_surprises", () => {
  it("persists only the explicit Territory preview permission", async () => {
    const saveCompanionInitiative = vi.fn(
      (settings: CompanionInitiativeSettings) => settings,
    );
    const registry = new ToolRegistry();
    registerTerritoryMomentSurprisesTool(registry, {
      getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      saveCompanionInitiative,
    });

    await expect(
      registry.execute(
        TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
        { enabled: true },
        context,
      ),
    ).resolves.toMatchObject({
      modelContent: { enabled: true },
      status: "success",
    });
    expect(saveCompanionInitiative).toHaveBeenCalledWith({
      ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      territoryMomentSurprisesEnabled: true,
      territoryMomentSurprisesPrompted: true,
    });
  });

  it("rejects inferred or hidden target data", async () => {
    const registry = new ToolRegistry();
    registerTerritoryMomentSurprisesTool(registry, {
      getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      saveCompanionInitiative: (settings) => settings,
    });

    await expect(
      registry.execute(
        TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
        { enabled: "probably" },
        context,
      ),
    ).rejects.toThrow(/Invalid arguments/u);
    await expect(
      registry.execute(
        TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
        { attachmentId: "hidden", enabled: false },
        context,
      ),
    ).rejects.toThrow(/Invalid arguments/u);
  });
});
