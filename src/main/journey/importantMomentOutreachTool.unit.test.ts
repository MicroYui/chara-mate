import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COMPANION_INITIATIVE_SETTINGS,
  type CompanionInitiativeSettings,
} from "../../shared/contracts/settings";
import { ToolRegistry } from "../tools/toolRegistry";
import {
  IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
  registerImportantMomentOutreachTool,
} from "./importantMomentOutreachTool";

const context = {
  itemId: "10000000-0000-4000-8000-000000000001",
  onDelta: () => undefined,
  runId: "10000000-0000-4000-8000-000000000002",
  signal: new AbortController().signal,
};

describe("companion.important_moment_outreach", () => {
  it("persists an explicit category choice and records that the prompt was handled", async () => {
    const saveCompanionInitiative = vi.fn(
      (settings: CompanionInitiativeSettings) => settings,
    );
    const registry = new ToolRegistry();
    registerImportantMomentOutreachTool(registry, {
      getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      saveCompanionInitiative,
    });

    expect(
      registry.get(IMPORTANT_MOMENT_OUTREACH_TOOL_NAME)?.descriptor,
    ).toMatchObject({
      effect: "write",
      idempotency: "idempotent",
      namespace: "companion",
    });
    await expect(
      registry.execute(
        IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
        { enabled: true },
        context,
      ),
    ).resolves.toMatchObject({
      modelContent: { enabled: true },
      status: "success",
    });
    expect(saveCompanionInitiative).toHaveBeenCalledWith({
      ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      importantMomentOutreachEnabled: true,
      importantMomentOutreachPrompted: true,
    });
  });

  it("rejects non-boolean or additional fields", async () => {
    const registry = new ToolRegistry();
    registerImportantMomentOutreachTool(registry, {
      getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      saveCompanionInitiative: (settings) => settings,
    });

    await expect(
      registry.execute(
        IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
        { enabled: "yes" },
        context,
      ),
    ).rejects.toThrow(/Invalid arguments/u);
    await expect(
      registry.execute(
        IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
        { enabled: false, eventId: "hidden" },
        context,
      ),
    ).rejects.toThrow(/Invalid arguments/u);
  });
});
