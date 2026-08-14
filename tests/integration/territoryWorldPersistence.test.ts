import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
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

async function createRepository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "territory-world-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "chara-mate.sqlite");
  const database = openApplicationDatabase(databasePath);
  const repository = new TerritoryWorldRepository(
    database,
    new QueueIds([...revisionIds]),
  );
  repository.ensureInitialized(seed);
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
