import { describe, expect, it, vi } from "vitest";

import {
  starterTerritoryCandidate,
  starterTerritorySnapshot,
} from "../../../tests/fixtures/territoryWorld";
import type {
  TerritoryChangeCandidate,
  TerritoryPetActionObservation,
} from "../../shared/contracts/territoryWorld";
import { ToolRegistry } from "../tools/toolRegistry";
import { TerritoryError } from "./territoryError";
import {
  registerTerritoryTools,
  TERRITORY_ACT_TOOL_NAME,
  TERRITORY_OBSERVE_TOOL_NAME,
} from "./territoryTools";

const readyCandidate: TerritoryChangeCandidate = {
  ...starterTerritoryCandidate,
  intent: "item",
  lockedInstanceIds: [],
  prompt: "长夜台灯：一盏小巧的黄铜工坊台灯",
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
      territory: {
        getSnapshot: () => snapshot(),
        observePetActions: vi.fn(),
        performPetAction: vi.fn(),
      },
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
        itemContent: {
          description: "留一盏灯，纪念完成项目的夜晚。",
          name: "长夜台灯",
        },
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
      territory: {
        getSnapshot: () => snapshot(),
        observePetActions: vi.fn(),
        performPetAction: vi.fn(),
      },
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

  it("observes the current revision and performs one host-validated action", async () => {
    const registry = new ToolRegistry();
    const observation: TerritoryPetActionObservation = {
      pet: starterTerritorySnapshot.pet,
      revisionId: starterTerritorySnapshot.world.currentRevision.id,
      targets: [
        {
          actions: ["move", "observe", "react"],
          capabilities: ["light", "inspectable"],
          description: "会在暮色里留下一圈暖光的小灯。",
          instanceId: "30000000-0000-4000-8000-000000000003",
          name: "琥珀桌灯",
          point: { x: 6, y: 4 },
          reachable: true,
        },
      ],
      zone: {
        bounds: { height: 12, width: 16, x: 0, y: 0 },
        id: starterTerritorySnapshot.world.activeZoneId,
        name: "暮色小屋",
      },
    };
    const observePetActions = vi.fn(() => observation);
    const performedSnapshot = {
      ...starterTerritorySnapshot,
      pet: {
        ...starterTerritorySnapshot.pet,
        behavior: "observing" as const,
        point: { x: 6, y: 6 },
      },
    };
    const performPetAction = vi.fn(() => ({
      action: "react" as const,
      path: [starterTerritorySnapshot.pet.point, { x: 6, y: 6 }],
      snapshot: performedSnapshot,
      targetInstanceId: observation.targets[0]!.instanceId,
    }));
    registerTerritoryTools(registry, {
      candidates: { create: vi.fn() },
      territory: {
        getSnapshot: () => snapshot(),
        observePetActions,
        performPetAction,
      },
    });

    const observed = await registry.execute(
      TERRITORY_OBSERVE_TOOL_NAME,
      {},
      executionContext(),
    );
    expect(observed).toMatchObject({
      modelContent: { revisionId: observation.revisionId },
      status: "success",
    });

    const context = executionContext();
    const acted = await registry.execute(
      TERRITORY_ACT_TOOL_NAME,
      {
        action: "react",
        expectedRevisionId: observation.revisionId,
        target: {
          instanceId: observation.targets[0]!.instanceId,
          kind: "instance",
        },
      },
      context,
    );
    expect(performPetAction).toHaveBeenCalledWith({
      action: "react",
      expectedRevisionId: observation.revisionId,
      target: {
        instanceId: observation.targets[0]!.instanceId,
        kind: "instance",
      },
    });
    expect(context.onDelta).toHaveBeenCalledWith("正在领地中回应…");
    expect(acted).toMatchObject({
      modelContent: {
        destination: { x: 6, y: 6 },
        petBehavior: "observing",
        status: "performed",
      },
      status: "success",
    });
    expect(
      registry
        .search("observe current Territory action")
        .map(({ descriptor }) => descriptor.name),
    ).toContain(TERRITORY_OBSERVE_TOOL_NAME);
  });

  it("returns revision conflicts as truthful Tool failures with a re-observe instruction", async () => {
    const registry = new ToolRegistry();
    registerTerritoryTools(registry, {
      candidates: { create: vi.fn() },
      territory: {
        getSnapshot: () => snapshot(),
        observePetActions: vi.fn(),
        performPetAction: vi.fn(() => {
          throw new TerritoryError(
            "TERRITORY.REVISION_CONFLICT",
            "领地刚刚发生了变化，请重新观察后再行动。",
            false,
          );
        }),
      },
    });

    const result = await registry.execute(
      TERRITORY_ACT_TOOL_NAME,
      {
        action: "move",
        expectedRevisionId: starterTerritorySnapshot.world.currentRevision.id,
        target: { kind: "point", point: { x: 1, y: 1 } },
      },
      executionContext(),
    );
    expect(result.error?.code).toBe("TERRITORY.REVISION_CONFLICT");
    expect(result.status).toBe("error");
    expect(result.modelContent).toBeTypeOf("object");
    expect(result.modelContent).not.toBeNull();
    expect(Array.isArray(result.modelContent)).toBe(false);
    if (
      typeof result.modelContent !== "object" ||
      result.modelContent === null ||
      Array.isArray(result.modelContent)
    ) {
      throw new TypeError("Expected structured Territory Tool output");
    }
    expect(result.modelContent["status"]).toBe("failed");
    expect(result.modelContent["nextAction"]).toContain(
      TERRITORY_OBSERVE_TOOL_NAME,
    );
  });
});
