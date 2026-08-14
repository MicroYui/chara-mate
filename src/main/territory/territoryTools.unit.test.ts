import { describe, expect, it, vi } from "vitest";

import {
  starterTerritoryCandidate,
  starterTerritorySnapshot,
} from "../../../tests/fixtures/territoryWorld";
import type { TerritoryChangeCandidate } from "../../shared/contracts/territoryWorld";
import { ToolRegistry } from "../tools/toolRegistry";
import { registerTerritoryTools } from "./territoryTools";

const readyCandidate: TerritoryChangeCandidate = {
  ...starterTerritoryCandidate,
  intent: "item",
  lockedInstanceIds: [],
  prompt:
    "长夜台灯：留一盏灯，纪念完成项目的夜晚。视觉：一盏小巧的黄铜工坊台灯",
  scope: {
    kind: "zone",
    zoneId: starterTerritorySnapshot.world.activeZoneId,
  },
};

function snapshot(candidate: TerritoryChangeCandidate = readyCandidate) {
  return { ...starterTerritorySnapshot, candidates: [candidate] };
}

function executionContext() {
  return {
    itemId: "tool-item",
    onDelta: vi.fn(),
    providerProfileId: "20000000-0000-4000-8000-000000000001",
    runId: "run",
    signal: new AbortController().signal,
  };
}

describe("Territory World Agent Tool", () => {
  it("freezes the current World revision and creates one reviewable item candidate", async () => {
    const registry = new ToolRegistry();
    const create = vi.fn().mockResolvedValue({
      candidateId: readyCandidate.id,
      snapshot: snapshot(),
    });
    registerTerritoryTools(registry, {
      candidates: { create },
      territory: { getSnapshot: () => snapshot() },
    });
    const context = executionContext();

    const result = await registry.execute(
      "territory.generate_item",
      {
        description: "留一盏灯，纪念完成项目的夜晚。",
        name: "长夜台灯",
        visualPrompt: "一盏小巧的黄铜工坊台灯",
      },
      context,
    );

    expect(create).toHaveBeenCalledWith(
      {
        baseRevisionId: starterTerritorySnapshot.world.currentRevision.id,
        intent: "item",
        lockedInstanceIds: [],
        prompt: readyCandidate.prompt,
        providerProfileId: context.providerProfileId,
        scope: {
          kind: "zone",
          zoneId: starterTerritorySnapshot.world.activeZoneId,
        },
        sources: [],
      },
      context.signal,
    );
    expect(context.onDelta).toHaveBeenCalledWith(
      "正在生成“长夜台灯”的领地预览…",
    );
    expect(result).toMatchObject({
      modelContent: {
        candidateId: readyCandidate.id,
        status: "awaiting_confirmation",
      },
      status: "success",
    });
    expect(
      registry.search("generate a Territory decoration from a memory")[0]
        ?.descriptor.name,
    ).toBe("territory.generate_item");
  });

  it("returns the persisted provider failure and retry signal", async () => {
    const registry = new ToolRegistry();
    const failedCandidate: TerritoryChangeCandidate = {
      ...readyCandidate,
      changeSet: null,
      error: {
        code: "PROVIDER.RATE_LIMITED",
        message: "Provider 暂时限制了请求，请稍后重试。",
        retryable: true,
      },
      previewGroups: [],
      status: "failed",
    };
    registerTerritoryTools(registry, {
      candidates: {
        create: vi.fn().mockResolvedValue({
          candidateId: failedCandidate.id,
          snapshot: snapshot(failedCandidate),
        }),
      },
      territory: { getSnapshot: () => snapshot() },
    });

    const result = await registry.execute(
      "territory.generate_item",
      {
        description: "留一盏灯，纪念完成项目的夜晚。",
        name: "长夜台灯",
        visualPrompt: "一盏小巧的黄铜工坊台灯",
      },
      executionContext(),
    );

    expect(result).toMatchObject({
      modelContent: {
        candidateId: failedCandidate.id,
        retryAvailableInTerritory: true,
        status: "failed",
      },
      retryable: true,
      status: "error",
    });
  });
});
