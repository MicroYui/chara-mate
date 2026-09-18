import { describe, expect, it, vi } from "vitest";

import { territoryInstanceLayout } from "../../shared/pure/territoryWorldGeometry";

import {
  starterTerritoryCandidate,
  starterTerritorySnapshot,
  starterTerritoryDefinitions,
  starterPlacedInstances,
} from "../../../tests/fixtures/territoryWorld";
import type {
  TerritoryChangeCandidate,
  TerritoryCreateChangeCandidateRequest,
  TerritoryPetActionObservation,
} from "../../shared/contracts/territoryWorld";
import type { RunItem } from "../../shared/contracts/run";
import type { JsonValue } from "../../shared/contracts/primitives";
import {
  runFixture,
  runItemFixture,
  FIXTURE_IDS,
} from "../../../tests/fixtures/foundationContracts";
import { ToolRegistry } from "../tools/toolRegistry";
import { TerritoryError } from "./territoryError";
import { openApplicationDatabase } from "../db/database";
import { createStarterTerritoryWorldSeed } from "./territoryStarterWorld";
import { TerritoryWorldRepository } from "./territoryWorldRepository";
import { TerritoryWorldService } from "./territoryWorldService";
import {
  registerTerritoryTools,
  territoryCreationToolResult,
  TERRITORY_ACT_TOOL_NAME,
  TERRITORY_OBSERVE_TOOL_NAME,
} from "./territoryTools";

function expandObservationGroups(modelContent: JsonValue) {
  const { nodeGroups, ...context } = JSON.parse(
    JSON.stringify(modelContent),
  ) as {
    nodeGroups: {
      shared: Record<string, unknown> & {
        placement: Record<string, unknown>;
        layout: Record<string, unknown>;
      };
      nodes: {
        instanceId: string;
        placement: Record<string, unknown>;
        layout: Record<string, unknown>;
      }[];
    }[];
  };
  return {
    ...context,
    nodes: nodeGroups.flatMap(({ shared, nodes }) =>
      nodes.map((node) => ({
        ...shared,
        ...node,
        placement: { ...shared.placement, ...node.placement },
        layout: { ...shared.layout, ...node.layout },
      })),
    ),
  };
}

const readyCandidate: TerritoryChangeCandidate = {
  ...starterTerritoryCandidate,
  appliedRevisionId: starterTerritorySnapshot.world.currentRevision.id,
  status: "applied",
  changeSet: {
    ...starterTerritoryCandidate.changeSet,
    mutations: [
      {
        changeId: FIXTURE_IDS.item,
        kind: "definition.put",
        definition: {
          ...starterTerritorySnapshot.definitions[0]!,
          name: "长夜台灯",
        },
      },
      ...starterTerritoryCandidate.changeSet.mutations,
    ],
  },
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
    itemId: FIXTURE_IDS.item,
    onDelta: vi.fn(),
    providerProfileId: "20000000-0000-4000-8000-000000000001",
    runId: FIXTURE_IDS.run,
    signal: new AbortController().signal,
  };
}

function runDependencies(messageId: string | undefined) {
  return {
    getRun: vi.fn(() => ({ ...runFixture, status: "running" as const })),
    getRunItem: vi.fn((): RunItem | undefined => ({
      ...runItemFixture,
      id: FIXTURE_IDS.item,
      runId: FIXTURE_IDS.run,
      kind: "tool_call" as const,
      status: "running" as const,
      sequence: 8,
    })),
    latestUserMessageId: vi.fn<
      (runId: string, beforeSequence?: number) => string | undefined
    >(() => messageId),
  };
}

describe("Territory World Agent Tool", () => {
  it("reports a collection result without claiming the item is in the room", () => {
    const candidate = structuredClone(readyCandidate);
    const instance = candidate.changeSet?.mutations.find(
      (mutation) => mutation.kind === "instance.put",
    );
    if (instance?.kind !== "instance.put") throw new Error("Missing fixture");
    instance.instance.placement = { kind: "collection" };
    expect(
      territoryCreationToolResult({
        candidateId: candidate.id,
        snapshot: snapshot(candidate),
      }),
    ).toMatchObject({
      modelContent: {
        worldRevisionChangedSinceCreation: false,
        placement: { kind: "collection" },
        status: "applied",
      },
      summary: "“长夜台灯”已放入收藏",
    });
  });

  it("returns an older completed creation honestly after the World changes", () => {
    const current = snapshot();
    const result = territoryCreationToolResult({
      candidateId: readyCandidate.id,
      snapshot: {
        ...current,
        world: {
          ...current.world,
          currentRevision: {
            ...current.world.currentRevision,
            id: FIXTURE_IDS.item,
          },
        },
      },
    });
    expect(result).toMatchObject({
      modelContent: {
        worldRevisionChangedSinceCreation: true,
        placement: null,
        status: "applied",
      },
      retryable: false,
      summary: "“长夜台灯”此前已完成，领地后来有了新变化",
    });
  });

  it("binds a real Run source and waits for the applied object", async () => {
    const registry = new ToolRegistry();
    const create = vi.fn().mockResolvedValue({
      candidateId: readyCandidate.id,
      snapshot: snapshot(),
    });
    registerTerritoryTools(registry, {
      runs: runDependencies(FIXTURE_IDS.message),
      candidates: { createAutonomousItem: create },
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
        sources: [
          {
            id: context.itemId,
            kind: "character_creation",
            label: "长夜台灯",
            occurredAt: runFixture.startedAt ?? runFixture.createdAt,
            personaRef: {
              personaId: runFixture.persona.personaId,
              revision: runFixture.persona.revision,
            },
            runId: context.runId,
          },
        ],
      },
      expect.any(Function),
      context.signal,
    );
    expect(context.onDelta).toHaveBeenCalledWith("正在创作“长夜台灯”…");
    expect(result).toMatchObject({
      modelContent: {
        candidateId: readyCandidate.id,
        status: "applied",
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
      runs: runDependencies(FIXTURE_IDS.message),
      candidates: {
        createAutonomousItem: vi.fn().mockResolvedValue({
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
      retryable: false,
      status: "error",
    });
  });

  it.each([
    { title: "an existing exchange", messageId: FIXTURE_IDS.message },
    { title: "a message-free autonomous Run", messageId: undefined },
  ])(
    "rejects a finished image after a new user message takes over $title",
    async ({ messageId }) => {
      const runs = runDependencies(messageId);
      let currentMessageId: string | undefined = messageId;
      runs.latestUserMessageId.mockImplementation((_runId, beforeSequence) =>
        beforeSequence === 8 ? messageId : currentMessageId,
      );
      let startImage!: () => void;
      let finishImage!: () => void;
      const imageStarted = new Promise<void>((resolve) => {
        startImage = resolve;
      });
      const imageFinished = new Promise<void>((resolve) => {
        finishImage = resolve;
      });
      let applied = false;
      const create = vi.fn(
        async (
          _request: TerritoryCreateChangeCandidateRequest,
          assertSourceValid: () => void,
        ) => {
          assertSourceValid();
          startImage();
          await imageFinished;
          // Mirrors CandidateService's final check immediately before committing.
          assertSourceValid();
          applied = true;
          return { candidateId: readyCandidate.id, snapshot: snapshot() };
        },
      );
      const registry = new ToolRegistry();
      registerTerritoryTools(registry, {
        runs,
        candidates: { createAutonomousItem: create },
        territory: {
          getSnapshot: () => snapshot(),
          observePetActions: vi.fn(),
          performPetAction: vi.fn(),
        },
      });
      const context = executionContext();
      const pending = registry.execute(
        "territory.generate_item",
        {
          name: "长夜台灯",
          description: "留一盏暖灯。",
          visualPrompt: "一盏黄铜小灯",
        },
        context,
      );
      await imageStarted;
      currentMessageId = "40000000-0000-4000-8000-000000000099";
      finishImage();
      const result = await pending;

      expect(runs.latestUserMessageId).toHaveBeenCalledWith(context.runId, 8);
      expect(runs.latestUserMessageId).toHaveBeenLastCalledWith(context.runId);
      expect(context.signal.aborted).toBe(false);
      expect(runs.getRun()?.status).toBe("running");
      expect(applied).toBe(false);
      expect(result).toMatchObject({
        status: "error",
        error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
      });
    },
  );

  it("allows an autonomous creation while both user-message boundaries remain absent", async () => {
    const runs = runDependencies(undefined);
    const registry = new ToolRegistry();
    const create = vi.fn(
      async (
        _request: TerritoryCreateChangeCandidateRequest,
        assertSourceValid: () => void,
      ) => {
        assertSourceValid();
        await Promise.resolve();
        assertSourceValid();
        return { candidateId: readyCandidate.id, snapshot: snapshot() };
      },
    );
    registerTerritoryTools(registry, {
      runs,
      candidates: { createAutonomousItem: create },
      territory: {
        getSnapshot: () => snapshot(),
        observePetActions: vi.fn(),
        performPetAction: vi.fn(),
      },
    });
    const result = await registry.execute(
      "territory.generate_item",
      {
        name: "长夜台灯",
        description: "留一盏暖灯。",
        visualPrompt: "一盏黄铜小灯",
      },
      executionContext(),
    );
    expect(result).toMatchObject({
      status: "success",
      modelContent: { status: "applied" },
    });
    expect(runs.latestUserMessageId).toHaveBeenCalledWith(FIXTURE_IDS.run, 8);
    expect(runs.latestUserMessageId).toHaveBeenLastCalledWith(FIXTURE_IDS.run);
  });

  it.each(["missing", "other_run"] as const)(
    "rejects a %s Tool Item before creating an image",
    async (failure) => {
      const runs = runDependencies(undefined);
      const item = runs.getRunItem()!;
      runs.getRunItem.mockReturnValue(
        failure === "missing"
          ? undefined
          : { ...item, runId: "40000000-0000-4000-8000-000000000098" },
      );
      const create = vi.fn();
      const registry = new ToolRegistry();
      registerTerritoryTools(registry, {
        runs,
        candidates: { createAutonomousItem: create },
        territory: {
          getSnapshot: () => snapshot(),
          observePetActions: vi.fn(),
          performPetAction: vi.fn(),
        },
      });
      const result = await registry.execute(
        "territory.generate_item",
        {
          name: "长夜台灯",
          description: "留一盏暖灯。",
          visualPrompt: "一盏黄铜小灯",
        },
        executionContext(),
      );
      expect(result).toMatchObject({
        status: "error",
        error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("observes the current revision and performs one host-validated action", async () => {
    const registry = new ToolRegistry();
    const observation: TerritoryPetActionObservation = {
      nodes: starterPlacedInstances.map((instance) => {
        const definition = starterTerritoryDefinitions.find(
          ({ id }) => id === instance.definition.id,
        )!;
        return {
          instanceId: instance.id,
          definition: instance.definition,
          placement: instance.placement,
          content: {
            status: "available" as const,
            name: definition.name,
            description: definition.description,
            layer: definition.layer,
            anchors: definition.anchors,
            visual: {
              sizePx: definition.visual.sizePx,
              attachmentAnchorPx:
                definition.placement.mode === "attachment"
                  ? definition.placement.attachmentAnchorPx
                  : null,
            },
          },
          layout: territoryInstanceLayout(
            instance,
            new Map(starterPlacedInstances.map((value) => [value.id, value])),
            new Map(
              starterTerritoryDefinitions.map((value) => [
                `${value.id}@${String(value.revision)}`,
                value,
              ]),
            ),
          ),
        };
      }),
      pet: starterTerritorySnapshot.pet,
      revisionId: starterTerritorySnapshot.world.currentRevision.id,
      targets: [
        {
          actions: ["move", "observe", "react"],
          capabilities: ["light", "inspectable"],
          instanceId: "30000000-0000-4000-8000-000000000003",
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
      runs: runDependencies(FIXTURE_IDS.message),
      candidates: { createAutonomousItem: vi.fn() },
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
    expect(expandObservationGroups(observed.modelContent)).toEqual(observation);

    const first = observation.nodes[0]!;
    const mixed: TerritoryPetActionObservation = {
      ...observation,
      nodes: [
        first,
        {
          ...first,
          instanceId: "81000000-0000-4000-8000-000000000002",
          definition: {
            ...first.definition,
            revision: first.definition.revision + 1,
          },
          placement: {
            kind: "attachment",
            zoneId: observation.zone.id,
            parentInstanceId: first.instanceId,
            anchorId: "missing-anchor",
            rotation: 90,
            flipped: true,
            offsetPx: { x: -12, y: 7 },
          },
          layout: {
            status: "unavailable",
            reason: "missing_anchor",
            referenceId: "missing-anchor",
          },
        },
        {
          ...first,
          instanceId: "81000000-0000-4000-8000-000000000003",
          content: { status: "unavailable", reason: "missing_definition" },
          layout: {
            status: "unavailable",
            reason: "missing_definition",
            referenceId: first.definition.id,
          },
        },
        { ...first, instanceId: "81000000-0000-4000-8000-000000000004" },
      ],
    };
    observePetActions.mockReturnValue(mixed);
    const mixedResult = await registry.execute(
      TERRITORY_OBSERVE_TOOL_NAME,
      {},
      executionContext(),
    );
    expect(expandObservationGroups(mixedResult.modelContent)).toEqual(mixed);

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

  it("supplies the entire starter room without repeating tile definitions", async () => {
    const database = openApplicationDatabase(":memory:");
    try {
      const now = "2026-09-01T08:00:00.000Z";
      const repository = new TerritoryWorldRepository(database, {
        generate: () => FIXTURE_IDS.message,
      });
      repository.ensureInitialized(createStarterTerritoryWorldSeed(now));
      const territory = new TerritoryWorldService(repository, {
        now: () => now,
      });
      const original = territory.observePetActions();
      const registry = new ToolRegistry();
      registerTerritoryTools(registry, {
        runs: runDependencies(FIXTURE_IDS.message),
        candidates: { createAutonomousItem: vi.fn() },
        territory,
      });
      const result = await registry.execute(
        TERRITORY_OBSERVE_TOOL_NAME,
        {},
        executionContext(),
      );
      expect(result.status).toBe("success");
      expect(original.nodes).toHaveLength(403);
      expect(original.targets).toHaveLength(39);
      expect(expandObservationGroups(result.modelContent)).toEqual(original);
      const text = JSON.stringify(result.modelContent);
      const floor = original.nodes.find(
        ({ definition }) => definition.id === "starter.cabin-floor",
      )!;
      if (floor.content.status !== "available")
        throw new Error("Starter floor is unavailable");
      expect(text.split(floor.content.description)).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("returns revision conflicts as truthful Tool failures with a re-observe instruction", async () => {
    const registry = new ToolRegistry();
    registerTerritoryTools(registry, {
      runs: runDependencies(FIXTURE_IDS.message),
      candidates: { createAutonomousItem: vi.fn() },
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
