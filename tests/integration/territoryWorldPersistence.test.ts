import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  TerritoryDefinition,
  TerritoryInstance,
  TerritoryWorldChangeSet,
  TerritoryWorldState,
} from "../../src/shared/contracts/territoryWorld";
import type { EntityId } from "../../src/shared/contracts/primitives";
import type { IdGenerator } from "../../src/shared/pure/id";
import { openApplicationDatabase } from "../../src/main/db/database";
import {
  TerritoryWorldRepository,
  type TerritoryWorldSeed,
} from "../../src/main/territory/territoryWorldRepository";
import { TerritoryWorldService } from "../../src/main/territory/territoryWorldService";
import { createStarterTerritoryWorldSeed } from "../../src/main/territory/territoryStarterWorld";
import { FakeClock } from "../fixtures/fakeClock";
import {
  starterCollectionInstance,
  starterPlacedInstances,
  starterTerritoryAssetPack,
  starterTerritoryAssets,
  starterTerritoryDefinitions,
  starterTerritoryRevision,
  starterTerritorySnapshot,
  starterTerritoryStyle,
  starterTerritoryZone,
  starterTrashedInstance,
  territoryWorldFixtureIds,
} from "../fixtures/territoryWorld";

class QueueIds implements IdGenerator {
  constructor(private readonly values: EntityId[]) {}

  generate(): EntityId {
    const value = this.values.shift();
    if (!value) throw new Error("No queued test ID");
    return value;
  }
}

const revisionIds = [
  "60000000-0000-4000-8000-000000000001",
  "60000000-0000-4000-8000-000000000002",
  "60000000-0000-4000-8000-000000000003",
  "60000000-0000-4000-8000-000000000004",
  "60000000-0000-4000-8000-000000000005",
  "60000000-0000-4000-8000-000000000006",
] as EntityId[];

const state: TerritoryWorldState = {
  activeZoneId: territoryWorldFixtureIds.zone,
  connections: [],
  groups: [],
  instances: [
    ...starterPlacedInstances,
    starterCollectionInstance,
    starterTrashedInstance,
  ],
  styles: [starterTerritoryStyle],
  zones: [starterTerritoryZone],
};

const seed: TerritoryWorldSeed = {
  assetPacks: [starterTerritoryAssetPack],
  assets: starterTerritoryAssets.map((asset) => ({
    asset,
    storageKey: `packaged/${asset.id}.png`,
  })),
  definitions: starterTerritoryDefinitions,
  name: starterTerritorySnapshot.world.name,
  pet: starterTerritorySnapshot.pet,
  revision: starterTerritoryRevision,
  state,
};

let temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories = [];
});

async function createRepository(seedOverride: TerritoryWorldSeed = seed) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "territory-world-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "chara-mate.sqlite");
  const database = openApplicationDatabase(databasePath);
  const repository = new TerritoryWorldRepository(
    database,
    new QueueIds([...revisionIds]),
  );
  repository.ensureInitialized(seedOverride);
  return { database, databasePath, repository };
}

function changeSet(
  mutation: TerritoryWorldChangeSet["mutations"][number],
  baseRevisionId: string = territoryWorldFixtureIds.revision,
): TerritoryWorldChangeSet {
  return {
    baseRevisionId,
    id: "61000000-0000-4000-8000-000000000001",
    label: "更新领地布置",
    mutations: [mutation],
  };
}

describe("Territory World persistence", () => {
  it("ships a complete editable starter World without waiting for generation", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "territory-starter-"),
    );
    temporaryDirectories.push(directory);
    const database = openApplicationDatabase(
      path.join(directory, "starter.sqlite"),
    );
    const repository = new TerritoryWorldRepository(
      database,
      new QueueIds([...revisionIds]),
    );
    repository.ensureInitialized(
      createStarterTerritoryWorldSeed("2026-08-13T08:00:00.000Z"),
    );

    const snapshot = repository.getSnapshot();
    const view = repository.getZoneView({
      revisionId: snapshot.world.currentRevision.id,
      zoneId: snapshot.world.activeZoneId,
    });
    expect(snapshot.world).toMatchObject({
      id: "territory",
      zones: [{ name: "住了很久的暮色小屋" }],
    });
    expect(snapshot.collection).toHaveLength(1);
    expect(view.instances).toHaveLength(403);
    expect([
      ...new Set(view.instances.map((instance) => instance.definition.id)),
    ]).toEqual(
      expect.arrayContaining([
        "starter.amber-lamp",
        "starter.astral-bookshelf",
        "starter.canopy-bed",
        "starter.cabin-floor",
        "starter.cabin-hearth",
        "starter.cabin-wall",
        "starter.coffee-table",
        "starter.great-moss-rug",
        "starter.lived-sofa",
        "starter.memory-mobile",
        "starter.sewing-table",
        "starter.window-glow",
        "starter.writing-desk",
      ]),
    );
    database.close();
  });

  it("adds one idempotent narrative revision for legacy system descriptions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "territory-narrative-"),
    );
    temporaryDirectories.push(directory);
    const database = openApplicationDatabase(
      path.join(directory, "narrative.sqlite"),
    );
    const repository = new TerritoryWorldRepository(
      database,
      new QueueIds([...revisionIds]),
    );
    const starter = createStarterTerritoryWorldSeed("2026-08-13T08:00:00.000Z");
    repository.ensureInitialized({
      ...starter,
      definitions: starter.definitions.map((definition) =>
        definition.id === "starter.cabin-wall"
          ? {
              ...definition,
              description:
                "整面可替换墙体，包含雨夜窗景、木梁、挂画区与窗台锚点。",
            }
          : definition,
      ),
    });

    expect(
      repository.ensurePoeticDescriptions("2026-08-28T08:00:00.000Z"),
    ).toBe(true);
    const upgraded = repository.getSnapshot();
    const currentWall = repository
      .getZoneView({
        revisionId: upgraded.world.currentRevision.id,
        zoneId: upgraded.world.activeZoneId,
      })
      .definitions.find(({ id }) => id === "starter.cabin-wall");
    expect(upgraded.world.currentRevision).toMatchObject({
      label: "补全领地物件故事",
      sequence: 2,
    });
    expect(currentWall).toMatchObject({ revision: 2 });
    expect(currentWall?.description).not.toContain("锚点");
    expect(
      repository.ensurePoeticDescriptions("2026-08-28T08:01:00.000Z"),
    ).toBe(false);
    expect(repository.getSnapshot().world.currentRevision.sequence).toBe(2);
    database.close();
  });

  it("initializes one persistent World and survives reopen", async () => {
    const { database, databasePath, repository } = await createRepository();

    expect(repository.getSnapshot()).toMatchObject({
      collection: [{ id: territoryWorldFixtureIds.collectionInstance }],
      trash: [{ id: territoryWorldFixtureIds.trashedInstance }],
      world: {
        activeZoneId: territoryWorldFixtureIds.zone,
        currentRevision: { sequence: 1 },
        id: "territory",
      },
    });
    expect(
      repository.getZoneView({
        revisionId: territoryWorldFixtureIds.revision,
        zoneId: territoryWorldFixtureIds.zone,
      }).instances,
    ).toHaveLength(3);
    database.close();

    const reopenedDatabase = openApplicationDatabase(databasePath);
    const reopened = new TerritoryWorldRepository(
      reopenedDatabase,
      new QueueIds([...revisionIds]),
    );
    reopened.ensureInitialized(seed);
    expect(reopened.getSnapshot().world.currentRevision.sequence).toBe(1);
    expect(reopened.getSnapshot().collection).toHaveLength(1);
    reopenedDatabase.close();
  });

  it("commits immutable revisions and restores by creating a new revision", async () => {
    const { database, repository } = await createRepository();
    const placed: TerritoryInstance = {
      ...starterCollectionInstance,
      placement: {
        flipped: false,
        kind: "zone",
        offsetPx: { x: 0, y: 0 },
        point: { x: 10, y: 6 },
        rotation: 0,
        zoneId: territoryWorldFixtureIds.zone,
      },
      updatedAt: "2026-08-13T09:00:00.000Z",
    };
    const committed = repository.commitChangeSet({
      changeSet: changeSet({
        changeId: "61000000-0000-4000-8000-000000000002",
        instance: placed,
        kind: "instance.put",
      }),
      now: "2026-08-13T09:00:00.000Z",
      reason: "direct",
    });

    expect(committed.world.currentRevision).toMatchObject({
      id: revisionIds[0],
      parentRevisionId: territoryWorldFixtureIds.revision,
      reason: "direct",
      sequence: 2,
    });
    expect(committed.collection).toHaveLength(0);
    expect(
      repository.getZoneView({
        revisionId: committed.world.currentRevision.id,
        zoneId: territoryWorldFixtureIds.zone,
      }).instances,
    ).toHaveLength(4);
    expect(
      repository.getZoneView({
        revisionId: territoryWorldFixtureIds.revision,
        zoneId: territoryWorldFixtureIds.zone,
      }).instances,
    ).toHaveLength(3);

    const restored = repository.restoreRevision(
      territoryWorldFixtureIds.revision,
      "2026-08-13T09:05:00.000Z",
      committed.world.currentRevision.id,
    );
    expect(restored.world.currentRevision).toMatchObject({
      id: revisionIds[1],
      parentRevisionId: revisionIds[0],
      reason: "restore",
      sequence: 3,
    });
    expect(restored.collection).toHaveLength(1);
    database.close();
  });

  it("rejects stale base revisions without changing current state", async () => {
    const { database, repository } = await createRepository();
    const stale = changeSet(
      {
        changeId: "61000000-0000-4000-8000-000000000003",
        instance: starterCollectionInstance,
        kind: "instance.put",
      },
      "10000000-0000-4000-8000-000000000099",
    );

    expect(() =>
      repository.commitChangeSet({
        changeSet: stale,
        now: "2026-08-13T09:00:00.000Z",
        reason: "direct",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TERRITORY.REVISION_CONFLICT" }),
    );
    expect(repository.getSnapshot().world.currentRevision.sequence).toBe(1);
    database.close();
  });

  it("supports trash, recover and permanent deletion without historical resurrection", async () => {
    const { database, repository } = await createRepository();
    const trashed: TerritoryInstance = {
      ...starterCollectionInstance,
      status: "trashed",
      trashedAt: "2026-08-13T09:00:00.000Z",
      updatedAt: "2026-08-13T09:00:00.000Z",
    };
    let snapshot = repository.commitChangeSet({
      changeSet: changeSet({
        changeId: "61000000-0000-4000-8000-000000000004",
        instance: trashed,
        kind: "instance.put",
      }),
      now: "2026-08-13T09:00:00.000Z",
      reason: "direct",
    });
    expect(snapshot.trash.map((item) => item.id)).toContain(
      starterCollectionInstance.id,
    );

    snapshot = repository.commitChangeSet({
      changeSet: changeSet(
        {
          changeId: "61000000-0000-4000-8000-000000000005",
          instance: {
            ...starterCollectionInstance,
            updatedAt: "2026-08-13T09:01:00.000Z",
          },
          kind: "instance.put",
        },
        snapshot.world.currentRevision.id,
      ),
      now: "2026-08-13T09:01:00.000Z",
      reason: "direct",
    });
    expect(snapshot.collection.map((item) => item.id)).toContain(
      starterCollectionInstance.id,
    );

    repository.commitChangeSet({
      changeSet: changeSet(
        {
          changeId: "61000000-0000-4000-8000-000000000006",
          instance: {
            ...trashed,
            trashedAt: "2026-08-13T09:02:00.000Z",
            updatedAt: "2026-08-13T09:02:00.000Z",
          },
          kind: "instance.put",
        },
        snapshot.world.currentRevision.id,
      ),
      now: "2026-08-13T09:02:00.000Z",
      reason: "direct",
    });
    snapshot = repository.purgeInstance(
      starterCollectionInstance.id,
      "2026-08-13T09:03:00.000Z",
    );
    expect(snapshot.collection).toHaveLength(0);
    expect(snapshot.trash.map((item) => item.id)).not.toContain(
      starterCollectionInstance.id,
    );

    snapshot = repository.restoreRevision(
      territoryWorldFixtureIds.revision,
      "2026-08-13T09:04:00.000Z",
      snapshot.world.currentRevision.id,
    );
    expect(snapshot.collection.map((item) => item.id)).not.toContain(
      starterCollectionInstance.id,
    );
    database.close();
  });

  it("rolls back a parent edit that would orphan an attachment", async () => {
    const { database, repository } = await createRepository();
    const desk = starterPlacedInstances[1]!;
    const trashedDesk: TerritoryInstance = {
      ...desk,
      status: "trashed",
      trashedAt: "2026-08-13T09:00:00.000Z",
      updatedAt: "2026-08-13T09:00:00.000Z",
    };

    expect(() =>
      repository.commitChangeSet({
        changeSet: changeSet({
          changeId: "61000000-0000-4000-8000-000000000007",
          instance: trashedDesk,
          kind: "instance.put",
        }),
        now: "2026-08-13T09:00:00.000Z",
        reason: "direct",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TERRITORY.CHANGESET_INVALID" }),
    );
    expect(repository.getSnapshot().world.currentRevision.sequence).toBe(1);
    database.close();
  });

  it("returns semantic viewport projections with attachment trees intact", async () => {
    const { database, repository } = await createRepository();
    const view = repository.getZoneView({
      revisionId: territoryWorldFixtureIds.revision,
      viewport: { height: 1, width: 1, x: 6, y: 4 },
      zoneId: territoryWorldFixtureIds.zone,
    });

    expect(view.instances.map((instance) => instance.id).sort()).toEqual(
      [
        territoryWorldFixtureIds.deskInstance,
        territoryWorldFixtureIds.lampInstance,
      ].sort(),
    );
    expect(view.definitions.map((definition) => definition.id).sort()).toEqual(
      ["starter.amber-lamp", "starter.cabin-desk"].sort(),
    );
    database.close();
  });

  it("persists one Preview candidate lifecycle and applies it atomically", async () => {
    const { database, repository } = await createRepository();
    const created = repository.createCandidate(
      {
        baseRevisionId: territoryWorldFixtureIds.revision,
        intent: "zone",
        lockedInstanceIds: [territoryWorldFixtureIds.deskInstance],
        prompt: "保留书桌，在旁边铺上星苔软毯。",
        providerProfileId: territoryWorldFixtureIds.provider,
        scope: { kind: "zone", zoneId: territoryWorldFixtureIds.zone },
        sources: [],
      },
      "2026-08-13T09:00:00.000Z",
    );
    expect(created.candidateId).toBe(revisionIds[0]);
    expect(created.snapshot.candidates[0]?.status).toBe("draft");

    repository.markCandidateGenerating(
      created.candidateId,
      "2026-08-13T09:00:01.000Z",
    );
    const placed: TerritoryInstance = {
      ...starterCollectionInstance,
      placement: {
        flipped: false,
        kind: "zone",
        offsetPx: { x: 0, y: 0 },
        point: { x: 10, y: 6 },
        rotation: 0,
        zoneId: territoryWorldFixtureIds.zone,
      },
      updatedAt: "2026-08-13T09:00:02.000Z",
    };
    const ready = repository.completeCandidate(
      created.candidateId,
      changeSet({
        changeId: "61000000-0000-4000-8000-000000000008",
        instance: placed,
        kind: "instance.put",
      }),
      [
        {
          action: "move",
          changeIds: ["61000000-0000-4000-8000-000000000008"],
          instanceIds: [starterCollectionInstance.id],
          label: "阅读角",
        },
      ],
      "2026-08-13T09:00:02.000Z",
    );
    expect(ready.candidates[0]).toMatchObject({
      id: created.candidateId,
      status: "ready",
    });

    const applied = repository.applyCandidate(
      created.candidateId,
      "2026-08-13T09:00:03.000Z",
    );
    expect(applied.world.currentRevision).toMatchObject({
      id: revisionIds[1],
      reason: "ai",
      sequence: 2,
    });
    expect(applied.candidates[0]).toMatchObject({
      appliedRevisionId: revisionIds[1],
      status: "applied",
    });
    expect(applied.collection).toHaveLength(0);
    database.close();
  });

  it("moves the pet through the accepted World and rejects stale movement", async () => {
    const { database, repository } = await createRepository();
    const service = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:00:00.000Z"),
    );
    const moved = service.movePet({
      from: { x: 8, y: 7 },
      to: { x: 7, y: 5 },
      zoneId: territoryWorldFixtureIds.zone,
    });
    expect(moved.path[0]).toEqual({ x: 8, y: 7 });
    expect(moved.snapshot.pet.point).toEqual(moved.path.at(-1));
    expect(moved.snapshot.pet.behavior).toBe("idle");
    expect(moved.snapshot.world.currentRevision.sequence).toBe(1);

    const interacted = service.movePet({
      from: moved.snapshot.pet.point,
      interactionInstanceId: territoryWorldFixtureIds.deskInstance,
      to: { x: 6, y: 4 },
      zoneId: territoryWorldFixtureIds.zone,
    });
    expect(interacted.snapshot.pet.behavior).toBe("observing");
    expect(interacted.snapshot.pet.point).not.toEqual({ x: 6, y: 5 });

    expect(() =>
      service.movePet({
        from: { x: 8, y: 7 },
        to: { x: 9, y: 7 },
        zoneId: territoryWorldFixtureIds.zone,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TERRITORY.REVISION_CONFLICT" }),
    );
    database.close();
  });

  it("observes compact affordances and resolves attached targets through their placed parent", async () => {
    const { database, repository } = await createRepository();
    const service = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:00:00.000Z"),
    );

    const observation = service.observePetActions();
    expect(observation).toMatchObject({
      pet: starterTerritorySnapshot.pet,
      revisionId: territoryWorldFixtureIds.revision,
      zone: { id: territoryWorldFixtureIds.zone },
    });
    expect(observation.targets).toContainEqual(
      expect.objectContaining({
        actions: ["move", "observe", "react"],
        instanceId: territoryWorldFixtureIds.lampInstance,
        reachable: true,
      }),
    );
    expect(
      observation.nodes.find(
        ({ instanceId }) =>
          instanceId === territoryWorldFixtureIds.lampInstance,
      ),
    ).toMatchObject({
      instanceId: territoryWorldFixtureIds.lampInstance,
      definition: { id: "starter.amber-lamp", revision: 1 },
      placement: {
        kind: "attachment",
        parentInstanceId: territoryWorldFixtureIds.deskInstance,
        anchorId: "top",
      },
      layout: {
        status: "available",
        rootInstanceId: territoryWorldFixtureIds.deskInstance,
        rootGridPoint: { x: 6, y: 4 },
        originPx: { x: 202, y: 94 },
        sizePx: { width: 28, height: 36 },
      },
    });
    expect(
      observation.nodes.map(({ instanceId }) => instanceId).sort(),
    ).toEqual(starterPlacedInstances.map(({ id }) => id).sort());
    expect(
      observation.targets.some(
        ({ instanceId }) =>
          instanceId === territoryWorldFixtureIds.floorInstance,
      ),
    ).toBe(false);
    database.close();
  });

  it("supplies the complete placed Zone and distinct wall-anchor layouts without making the wall actionable", async () => {
    const { database, repository } = await createRepository(
      createStarterTerritoryWorldSeed("2026-08-13T08:00:00.000Z"),
    );
    try {
      const service = new TerritoryWorldService(
        repository,
        new FakeClock("2026-08-13T10:00:00.000Z"),
      );
      const observation = service.observePetActions();
      const snapshot = repository.getSnapshot();
      const view = repository.getZoneView({
        revisionId: observation.revisionId,
        zoneId: observation.zone.id,
      });
      expect(
        observation.nodes.map(({ instanceId }) => instanceId).sort(),
      ).toEqual(view.instances.map(({ id }) => id).sort());
      expect(
        new Set(observation.nodes.map(({ instanceId }) => instanceId)).size,
      ).toBe(observation.nodes.length);
      expect(
        observation.nodes.some(({ instanceId }) =>
          snapshot.collection.some(({ id }) => id === instanceId),
        ),
      ).toBe(false);
      const wall = observation.nodes.find(
        ({ definition }) => definition.id === "starter.cabin-wall",
      )!;
      const photo = observation.nodes.find(
        ({ definition, placement }) =>
          definition.id === "starter.photo-frame" &&
          placement.kind === "attachment" &&
          placement.anchorId === "left-gallery",
      )!;
      const clock = observation.nodes.find(
        ({ definition }) => definition.id === "starter.slow-clock",
      )!;
      expect(wall.content.status).toBe("available");
      if (wall.content.status !== "available")
        throw new Error("wall definition unavailable");
      expect(wall.content.anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "left-gallery",
            anchorPx: { x: 180, y: 136 },
          }),
          expect.objectContaining({
            id: "right-gallery",
            anchorPx: { x: 878, y: 132 },
          }),
        ]),
      );
      expect(
        observation.targets.some(
          ({ instanceId }) => instanceId === wall.instanceId,
        ),
      ).toBe(false);
      expect(photo.layout).toEqual({
        status: "available",
        rootInstanceId: wall.instanceId,
        rootGridPoint: { x: 0, y: 0 },
        originPx: { x: 138, y: 76 },
        sizePx: { width: 48, height: 64 },
      });
      expect(clock.layout).toEqual({
        status: "available",
        rootInstanceId: wall.instanceId,
        rootGridPoint: { x: 0, y: 0 },
        originPx: { x: 746, y: 88 },
        sizePx: { width: 72, height: 72 },
      });
      expect(photo.placement).toMatchObject({
        kind: "attachment",
        parentInstanceId: wall.instanceId,
        anchorId: "left-gallery",
        offsetPx: { x: -18, y: 0 },
      });
    } finally {
      database.close();
    }
  });

  it.each(["missing_definition", "missing_parent"] as const)(
    "retains an unreadable %s projection without invented layout or reachability",
    async (reason) => {
      const { database, repository } = await createRepository();
      try {
        const view = repository.getZoneView({
          revisionId: territoryWorldFixtureIds.revision,
          zoneId: territoryWorldFixtureIds.zone,
        });
        // Inject an incomplete read projection; the persisted source remains intact.
        const read = vi.spyOn(repository, "getZoneView").mockReturnValue({
          ...view,
          definitions:
            reason === "missing_definition"
              ? view.definitions.filter(({ id }) => id !== "starter.amber-lamp")
              : view.definitions,
          instances:
            reason === "missing_parent"
              ? view.instances.filter(
                  ({ id }) => id !== territoryWorldFixtureIds.deskInstance,
                )
              : view.instances,
        });
        const service = new TerritoryWorldService(
          repository,
          new FakeClock("2026-08-13T10:00:00.000Z"),
        );
        const observation = service.observePetActions();
        const node = observation.nodes.find(
          ({ instanceId }) =>
            instanceId === territoryWorldFixtureIds.lampInstance,
        )!;
        expect(node.definition).toEqual({
          id: "starter.amber-lamp",
          revision: 1,
        });
        expect(node.placement).toMatchObject({
          kind: "attachment",
          parentInstanceId: territoryWorldFixtureIds.deskInstance,
        });
        expect(node.content.status).toBe(
          reason === "missing_definition" ? "unavailable" : "available",
        );
        expect(node.layout).toMatchObject({ status: "unavailable", reason });
        expect(node.layout).not.toHaveProperty("originPx");
        expect(node.layout).not.toHaveProperty("rootGridPoint");
        expect(
          observation.targets.some(
            ({ instanceId }) => instanceId === node.instanceId,
          ),
        ).toBe(false);
        read.mockRestore();
        expect(
          service
            .observePetActions()
            .nodes.find(({ instanceId }) => instanceId === node.instanceId)
            ?.layout.status,
        ).toBe("available");
      } finally {
        database.close();
      }
    },
  );

  it("rereads nested layout and Definition versions after a real parent transform while rejecting an old action revision", async () => {
    const graphSeed = structuredClone(seed);
    const desk = graphSeed.state.instances.find(
      ({ id }) => id === territoryWorldFixtureIds.deskInstance,
    )!;
    const lamp = graphSeed.state.instances.find(
      ({ id }) => id === territoryWorldFixtureIds.lampInstance,
    )!;
    if (desk.placement.kind !== "zone" || lamp.placement.kind !== "attachment")
      throw new Error("Invalid fixture");
    desk.placement = {
      ...desk.placement,
      point: { x: 2, y: 3 },
      offsetPx: { x: 5, y: -3 },
      flipped: true,
      rotation: 90,
    };
    lamp.placement = {
      ...lamp.placement,
      offsetPx: { x: 3, y: -4 },
      flipped: true,
      rotation: 90,
    };
    const deskDefinition = graphSeed.definitions.find(
      ({ id }) => id === desk.definition.id,
    )!;
    deskDefinition.capabilities = [];
    const lampDefinition = graphSeed.definitions.find(
      ({ id }) => id === lamp.definition.id,
    )!;
    lampDefinition.transforms.rotations = [0, 90, 180, 270];
    lampDefinition.anchors = [
      {
        id: "top",
        kind: "tabletop",
        anchorPx: { x: 6, y: 8 },
        maxItemSizePx: { width: 96, height: 48 },
      },
    ];
    const child: TerritoryInstance = {
      ...lamp,
      id: "30000000-0000-4000-8000-000000000007",
      placement: {
        ...lamp.placement,
        parentInstanceId: lamp.id,
        flipped: false,
        rotation: 180,
        offsetPx: { x: -2, y: 5 },
      },
    };
    graphSeed.state.instances.push(child);
    const { database, repository } = await createRepository(graphSeed);
    try {
      const service = new TerritoryWorldService(
        repository,
        new FakeClock("2026-08-13T10:00:00.000Z"),
      );
      const before = service.observePetActions();
      expect(
        before.targets.some(({ instanceId }) => instanceId === desk.id),
      ).toBe(false);
      expect(
        before.nodes.find(({ instanceId }) => instanceId === lamp.id)?.layout,
      ).toMatchObject({
        originPx: { x: 118, y: 123 },
        sizePx: { width: 36, height: 28 },
      });
      expect(
        before.nodes.find(({ instanceId }) => instanceId === child.id)?.layout,
      ).toMatchObject({ originPx: { x: 130, y: 150 } });
      const nextDefinition: TerritoryDefinition = {
        ...deskDefinition,
        revision: 2,
        anchors: [
          { ...deskDefinition.anchors[0]!, anchorPx: { x: 74, y: 34 } },
        ],
      };
      service.commitChangeSet({
        changeSet: {
          ...changeSet({
            changeId: "61000000-0000-4000-8000-000000000002",
            kind: "definition.put",
            definition: nextDefinition,
          }),
          mutations: [
            {
              changeId: "61000000-0000-4000-8000-000000000002",
              kind: "definition.put",
              definition: nextDefinition,
            },
            {
              changeId: "61000000-0000-4000-8000-000000000003",
              kind: "instance.put",
              instance: {
                ...desk,
                definition: { id: desk.definition.id, revision: 2 },
                placement: { ...desk.placement, point: { x: 3, y: 3 } },
              },
            },
          ],
        },
      });
      const after = service.observePetActions();
      expect(after.revisionId).not.toBe(before.revisionId);
      expect(
        after.nodes.find(({ instanceId }) => instanceId === desk.id)?.definition
          .revision,
      ).toBe(2);
      expect(
        after.nodes.find(({ instanceId }) => instanceId === lamp.id)?.layout,
      ).toMatchObject({
        rootGridPoint: { x: 3, y: 3 },
        originPx: { x: 142, y: 121 },
      });
      expect(
        after.nodes.find(({ instanceId }) => instanceId === child.id)?.layout,
      ).toMatchObject({ originPx: { x: 154, y: 148 } });
      expect(
        before.nodes.find(({ instanceId }) => instanceId === child.id)?.layout,
      ).toMatchObject({ originPx: { x: 130, y: 150 } });
      expect(() =>
        service.performPetAction({
          action: "observe",
          expectedRevisionId: before.revisionId,
          target: { kind: "instance", instanceId: lamp.id },
        }),
      ).toThrowError(
        expect.objectContaining({ code: "TERRITORY.REVISION_CONFLICT" }),
      );
    } finally {
      database.close();
    }
  });

  it("performs explicit sit and sleep actions, rejects stale revisions and never reports a blocked point as reached", async () => {
    const actionSeed: TerritoryWorldSeed = {
      ...seed,
      definitions: seed.definitions.map((definition) =>
        definition.id === "starter.cabin-desk"
          ? {
              ...definition,
              capabilities: ["inspectable", "seatable", "sleepable"],
            }
          : definition,
      ),
    };
    const { database, repository } = await createRepository(actionSeed);
    const emitted = vi.fn();
    const service = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:00:00.000Z"),
      undefined,
      undefined,
      emitted,
    );

    const sat = service.performPetAction({
      action: "sit",
      expectedRevisionId: territoryWorldFixtureIds.revision,
      target: {
        instanceId: territoryWorldFixtureIds.deskInstance,
        kind: "instance",
      },
    });
    expect(sat.snapshot.pet.behavior).toBe("sitting");
    expect(sat.targetInstanceId).toBe(territoryWorldFixtureIds.deskInstance);

    const slept = service.performPetAction({
      action: "sleep",
      expectedRevisionId: territoryWorldFixtureIds.revision,
      target: {
        instanceId: territoryWorldFixtureIds.deskInstance,
        kind: "instance",
      },
    });
    expect(slept.snapshot.pet.behavior).toBe("sleeping");
    expect(emitted).toHaveBeenCalledTimes(2);

    expect(() =>
      service.performPetAction({
        action: "move",
        expectedRevisionId: territoryWorldFixtureIds.revision,
        target: { kind: "point", point: { x: 6, y: 5 } },
      }),
    ).toThrowError(expect.objectContaining({ code: "TERRITORY.NO_PATH" }));
    expect(() =>
      service.performPetAction({
        action: "observe",
        expectedRevisionId: "10000000-0000-4000-8000-000000000099",
        target: {
          instanceId: territoryWorldFixtureIds.deskInstance,
          kind: "instance",
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TERRITORY.REVISION_CONFLICT" }),
    );

    const serviceWithClosedRenderer = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:01:00.000Z"),
      undefined,
      undefined,
      () => {
        throw new Error("Renderer closed");
      },
    );
    expect(
      serviceWithClosedRenderer.performPetAction({
        action: "observe",
        expectedRevisionId: territoryWorldFixtureIds.revision,
        target: {
          instanceId: territoryWorldFixtureIds.deskInstance,
          kind: "instance",
        },
      }).snapshot.pet.behavior,
    ).toBe("observing");
    database.close();
  });

  it("edits and cancels a stable Preview candidate ID", async () => {
    const { database, repository } = await createRepository();
    const service = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:00:00.000Z"),
    );
    const created = await service.createCandidate({
      baseRevisionId: territoryWorldFixtureIds.revision,
      intent: "zone",
      lockedInstanceIds: [territoryWorldFixtureIds.deskInstance],
      prompt: "把这个区域变成阅读角。",
      providerProfileId: territoryWorldFixtureIds.provider,
      scope: { kind: "zone", zoneId: territoryWorldFixtureIds.zone },
      sources: [],
    });
    const edited = await service.editCandidate({
      candidateId: created.candidateId,
      excludedChangeIds: [],
      instruction: "保留灯，也不要移动书桌。",
      lockedInstanceIds: [
        territoryWorldFixtureIds.deskInstance,
        territoryWorldFixtureIds.lampInstance,
      ],
    });
    expect(edited.candidateId).toBe(created.candidateId);
    expect(edited.snapshot.candidates[0]).toMatchObject({
      lockedInstanceIds: [
        territoryWorldFixtureIds.deskInstance,
        territoryWorldFixtureIds.lampInstance,
      ],
      status: "draft",
    });
    expect(repository.getCandidateWork(created.candidateId).edit).toMatchObject(
      {
        instruction: "保留灯，也不要移动书桌。",
      },
    );

    const cancelled = await service.cancelCandidate({
      candidateId: created.candidateId,
    });
    expect(cancelled.snapshot.candidates[0]?.status).toBe("cancelled");
    database.close();
  });
});
