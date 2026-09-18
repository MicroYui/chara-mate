import { describe, expect, it, vi } from "vitest";

import {
  starterTerritoryCandidate,
  starterTerritorySnapshot,
} from "../../../tests/fixtures/territoryWorld";
import { FIXTURE_IDS } from "../../../tests/fixtures/foundationContracts";
import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../shared/contracts/settings";
import { ToolRegistry } from "../tools/toolRegistry";
import { TerritoryError } from "./territoryError";
import {
  registerTerritoryMomentTool,
  TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
} from "./territoryMomentTool";

const context = {
  itemId: FIXTURE_IDS.item,
  onDelta: vi.fn(),
  runId: FIXTURE_IDS.run,
  signal: new AbortController().signal,
};
const proposal = {
  description: "分享结束后的松弛，被傍晚的光轻轻接住。",
  name: "散场后的余光",
  visualPrompt: "warm sunset light resting on a small glass ornament",
};

describe("territory.propose_moment", () => {
  it("waits for the same Run's real creation result", async () => {
    const registry = new ToolRegistry();
    const candidate = {
      ...starterTerritoryCandidate,
      intent: "item" as const,
      status: "applied" as const,
      appliedRevisionId: starterTerritorySnapshot.world.currentRevision.id,
      changeSet: {
        ...starterTerritoryCandidate.changeSet,
        mutations: [
          {
            changeId: FIXTURE_IDS.item,
            kind: "definition.put" as const,
            definition: {
              ...starterTerritorySnapshot.definitions[0]!,
              name: proposal.name,
            },
          },
          ...starterTerritoryCandidate.changeSet.mutations,
        ],
      },
    };
    const createForRun = vi.fn().mockResolvedValue({
      candidateId: candidate.id,
      snapshot: { ...starterTerritorySnapshot, candidates: [candidate] },
    });
    registerTerritoryMomentTool(
      registry,
      {
        getCompanionInitiative: () => ({
          ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
          territoryMomentSurprisesEnabled: true,
        }),
      },
      { createForRun },
    );
    await expect(
      registry.execute(TERRITORY_PROPOSE_MOMENT_TOOL_NAME, proposal, context),
    ).resolves.toMatchObject({
      modelContent: { status: "applied", name: proposal.name },
      status: "success",
    });
    expect(createForRun).toHaveBeenCalledWith(
      context.runId,
      context.itemId,
      proposal,
      context.signal,
    );
  });

  it("rejects disabled permission without creating anything", async () => {
    const registry = new ToolRegistry();
    const createForRun = vi.fn();
    registerTerritoryMomentTool(
      registry,
      { getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS },
      { createForRun },
    );
    await expect(
      registry.execute(TERRITORY_PROPOSE_MOMENT_TOOL_NAME, proposal, context),
    ).resolves.toMatchObject({
      modelContent: {
        accepted: false,
        reason: "territory_moment_surprises_disabled",
      },
      status: "rejected",
    });
    expect(createForRun).not.toHaveBeenCalled();
  });

  it("returns a source failure as an ordinary tool result so conversation can continue", async () => {
    const registry = new ToolRegistry();
    registerTerritoryMomentTool(
      registry,
      {
        getCompanionInitiative: () => ({
          ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
          territoryMomentSurprisesEnabled: true,
        }),
      },
      {
        createForRun: vi
          .fn()
          .mockRejectedValue(
            new TerritoryError(
              "TERRITORY.SOURCE_NOT_FOUND",
              "原消息已删除",
              false,
            ),
          ),
      },
    );
    await expect(
      registry.execute(TERRITORY_PROPOSE_MOMENT_TOOL_NAME, proposal, context),
    ).resolves.toMatchObject({
      modelContent: { status: "failed" },
      status: "error",
      retryable: false,
    });
  });

  it("reports cancellation before a candidate exists without a storage failure", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    registerTerritoryMomentTool(
      registry,
      {
        getCompanionInitiative: () => ({
          ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
          territoryMomentSurprisesEnabled: true,
        }),
      },
      {
        createForRun: vi.fn(() => {
          controller.abort();
          return Promise.reject(new DOMException("Cancelled", "AbortError"));
        }),
      },
    );
    await expect(
      registry.execute(TERRITORY_PROPOSE_MOMENT_TOOL_NAME, proposal, {
        ...context,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      modelContent: { status: "cancelled" },
      status: "cancelled",
      summary: "这次领地创作已取消。",
    });
  });
});
