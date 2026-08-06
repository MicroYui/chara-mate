import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import {
  TerritoryAssetStore,
  type TerritoryImageNormalizer,
} from "../../src/main/territory/territoryAssetStore";
import { TerritoryRepository } from "../../src/main/territory/territoryRepository";
import { TerritoryService } from "../../src/main/territory/territoryService";
import { FakeClock } from "../fixtures/fakeClock";
import { createSolidPng } from "../fixtures/png";
import {
  territoryCupManifest,
  territoryDeskManifest,
  territoryRugManifest,
} from "../fixtures/territoryItemManifests";

const temporaryDirectories: string[] = [];

const imageNormalizer: TerritoryImageNormalizer = {
  normalize(source, size) {
    return createSolidPng(size.width, size.height, [
      source[0] ?? 0,
      74,
      158,
      255,
    ]);
  },
};

function createAssetStore(root: string): TerritoryAssetStore {
  return new TerritoryAssetStore(
    path.join(root, "territory", "assets"),
    imageNormalizer,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Territory deterministic 2.5D persistence", () => {
  it("persists masks, surface attachments, generated manifests, and exact reopen state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-territory-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "charamate.sqlite");
    const clock = new FakeClock("2026-08-06T08:00:00.000Z");
    const database = openApplicationDatabase(databasePath);
    const assets = createAssetStore(root);
    const service = new TerritoryService(
      new TerritoryRepository(database),
      assets,
      clock,
    );

    expect(service.getSnapshot()).toMatchObject({
      activeScene: null,
      availableScenes: [
        { id: "forest-cabin" },
        { id: "seaside-room" },
        { id: "city-rooftop" },
        { id: "star-workshop" },
      ],
      collection: [],
    });

    const initialized = service.selectScene({ sceneId: "forest-cabin" });
    expect(initialized.activeScene).toMatchObject({
      definition: { id: "forest-cabin" },
      pet: { facing: "right", x: 8, y: 6 },
    });
    expect(initialized.activeScene?.placements).toHaveLength(4);
    expect(initialized.collection.map(({ id }) => id)).toEqual([
      "collection.ceramic-cup",
      "collection.folded-letter",
      "collection.tiny-succulent",
    ]);

    clock.advance(1_000);
    const behindDesk = service.movePet({
      from: { x: 10, y: 4 },
      sceneId: "forest-cabin",
      x: 14,
      y: 4,
    });
    expect(behindDesk.path).toEqual([
      { x: 10, y: 4 },
      { x: 11, y: 4 },
      { x: 12, y: 4 },
      { x: 13, y: 4 },
      { x: 14, y: 4 },
    ]);

    clock.advance(1_000);
    const attachedCup = service.placeItem({
      flipped: false,
      itemId: "collection.ceramic-cup",
      rotation: 0,
      target: {
        kind: "surface",
        sceneId: "forest-cabin",
        slotId: "left",
        supportItemId: "forest-cabin.desk",
      },
    });
    expect(
      attachedCup.activeScene?.placements.find(
        ({ id }) => id === "collection.ceramic-cup",
      )?.target,
    ).toEqual({
      kind: "surface",
      sceneId: "forest-cabin",
      slotId: "left",
      supportItemId: "forest-cabin.desk",
    });
    expect(() =>
      service.placeItem({
        flipped: false,
        itemId: "collection.folded-letter",
        rotation: 0,
        target: {
          kind: "surface",
          sceneId: "forest-cabin",
          slotId: "left",
          supportItemId: "forest-cabin.desk",
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TERRITORY.INVALID_PLACEMENT" }),
    );

    clock.advance(1_000);
    service.placeItem({
      flipped: false,
      itemId: "collection.folded-letter",
      rotation: 0,
      target: {
        kind: "surface",
        sceneId: "forest-cabin",
        slotId: "right",
        supportItemId: "forest-cabin.desk",
      },
    });
    const rotatedDesk = service.placeItem({
      flipped: true,
      itemId: "forest-cabin.desk",
      rotation: 90,
      target: {
        kind: "ground",
        sceneId: "forest-cabin",
        x: 11,
        y: 4,
      },
    });
    expect(
      rotatedDesk.activeScene?.placements.find(
        ({ id }) => id === "forest-cabin.desk",
      ),
    ).toMatchObject({ flipped: true, rotation: 90 });
    expect(
      rotatedDesk.activeScene?.placements.find(
        ({ id }) => id === "collection.ceramic-cup",
      )?.target,
    ).toMatchObject({ supportItemId: "forest-cabin.desk" });
    const movedDesk = service.placeItem({
      flipped: false,
      itemId: "forest-cabin.desk",
      rotation: 0,
      target: {
        kind: "ground",
        sceneId: "forest-cabin",
        x: 8,
        y: 6,
      },
    });
    expect(
      movedDesk.activeScene?.placements.find(
        ({ id }) => id === "collection.folded-letter",
      )?.target,
    ).toMatchObject({ supportItemId: "forest-cabin.desk" });

    clock.advance(1_000);
    const collectedDesk = service.collectItem({
      itemId: "forest-cabin.desk",
      sceneId: "forest-cabin",
    });
    expect(
      collectedDesk.collection
        .filter(({ id }) =>
          [
            "forest-cabin.desk",
            "collection.ceramic-cup",
            "collection.folded-letter",
          ].includes(id),
        )
        .every(({ target }) => target.kind === "collection"),
    ).toBe(true);

    clock.advance(1_000);
    const generatedSourcePath = path.join(root, "generated-cup.png");
    await writeFile(generatedSourcePath, Buffer.from([214]));
    const installed = await service.installGeneratedItem({
      itemId: "generated.ceramic-cup",
      manifest: territoryCupManifest,
      sourceImagePath: generatedSourcePath,
    });
    expect(
      installed.collection.find(({ id }) => id === "generated.ceramic-cup"),
    ).toMatchObject({
      manifest: {
        definitionId: "generated.ceramic-cup",
        visual: {
          source: { assetId: "asset.ceramic-cup.v1", kind: "asset" },
        },
      },
      target: { kind: "collection" },
    });
    await expect(
      service.installGeneratedItem({
        itemId: "generated.ceramic-cup",
        manifest: territoryCupManifest,
        sourceImagePath: generatedSourcePath,
      }),
    ).resolves.toEqual(installed);
    await expect(
      service.installGeneratedItem({
        itemId: "generated.ceramic-cup",
        manifest: {
          ...territoryCupManifest,
          definitionId: "generated.conflicting-cup",
          visual: {
            ...territoryCupManifest.visual,
            source: {
              assetId: "asset.conflicting-cup.v1",
              kind: "asset",
            },
          },
        },
        sourceImagePath: generatedSourcePath,
      }),
    ).rejects.toMatchObject({ code: "TERRITORY.INVALID_MANIFEST" });

    clock.advance(1_000);
    const seaside = service.selectScene({ sceneId: "seaside-room" });
    expect(seaside.activeScene?.definition.id).toBe("seaside-room");
    expect(
      seaside.activeScene?.placements.some(
        ({ id }) => id === "seaside-room.bed",
      ),
    ).toBe(true);
    clock.advance(1_000);
    service.selectScene({ sceneId: "forest-cabin" });
    const beforeClose = service.getSnapshot();

    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM territory_scenes) AS scenes,
           (SELECT COUNT(*) FROM territory_items) AS items,
           (SELECT COUNT(*) FROM territory_item_definitions) AS definitions,
           (SELECT COUNT(*) FROM territory_assets) AS assets,
           (SELECT COUNT(*) FROM territory_scenes WHERE is_active = 1) AS active`,
      )
      .get() as {
      active: number;
      assets: number;
      definitions: number;
      items: number;
      scenes: number;
    };
    expect(counts).toEqual({
      active: 1,
      assets: 1,
      definitions: 12,
      items: 12,
      scenes: 2,
    });
    database.close();

    const reopened = openApplicationDatabase(databasePath);
    const restored = new TerritoryService(
      new TerritoryRepository(reopened),
      createAssetStore(root),
      new FakeClock("2026-08-06T09:00:00.000Z"),
    );
    expect(restored.getSnapshot()).toEqual(beforeClose);

    restored.selectScene({ sceneId: "forest-cabin" });
    expect(
      reopened
        .prepare(
          `SELECT COUNT(*) AS count
           FROM territory_items
           WHERE initial_scene_id = 'forest-cabin'`,
        )
        .get(),
    ).toEqual({ count: 4 });
    reopened.close();
  });

  it("installs generated underlay, slotted support, and attachment manifests through one asset path", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-generated-territory-items-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "db.sqlite"));
    const service = new TerritoryService(
      new TerritoryRepository(database),
      createAssetStore(root),
      new FakeClock("2026-08-06T08:00:00.000Z"),
    );
    service.selectScene({ sceneId: "forest-cabin" });
    const generatedRug = {
      ...territoryRugManifest,
      definitionId: "generated.walkable-rug",
      name: "生成地毯",
      visual: {
        ...territoryRugManifest.visual,
        source: { assetId: "asset.walkable-rug.v1", kind: "asset" as const },
      },
    };
    const generatedTable = {
      ...territoryDeskManifest,
      definitionId: "generated.slot-table",
      name: "生成插槽桌",
      visual: {
        ...territoryDeskManifest.visual,
        source: { assetId: "asset.slot-table.v1", kind: "asset" as const },
      },
    };
    const generatedCup = {
      ...territoryCupManifest,
      definitionId: "generated.slot-cup",
      name: "生成杯子",
      visual: {
        ...territoryCupManifest.visual,
        source: { assetId: "asset.slot-cup.v1", kind: "asset" as const },
      },
    };
    for (const [index, item] of [
      { id: "generated.walkable-rug", manifest: generatedRug },
      { id: "generated.slot-table", manifest: generatedTable },
      { id: "generated.slot-cup", manifest: generatedCup },
    ].entries()) {
      const sourceImagePath = path.join(root, `${item.id}.png`);
      await writeFile(sourceImagePath, Buffer.from([80 + index]));
      await service.installGeneratedItem({
        itemId: item.id,
        manifest: item.manifest,
        sourceImagePath,
      });
    }

    service.placeItem({
      flipped: false,
      itemId: "generated.walkable-rug",
      rotation: 0,
      target: {
        kind: "ground",
        sceneId: "forest-cabin",
        x: 2,
        y: 7,
      },
    });
    service.placeItem({
      flipped: false,
      itemId: "generated.slot-table",
      rotation: 0,
      target: {
        kind: "ground",
        sceneId: "forest-cabin",
        x: 2,
        y: 7,
      },
    });
    const placed = service.placeItem({
      flipped: false,
      itemId: "generated.slot-cup",
      rotation: 0,
      target: {
        kind: "surface",
        sceneId: "forest-cabin",
        slotId: "left",
        supportItemId: "generated.slot-table",
      },
    });
    expect(
      placed.activeScene?.placements
        .filter(({ id }) => id.startsWith("generated."))
        .map(({ id, target }) => ({ id, target })),
    ).toEqual([
      {
        id: "generated.slot-table",
        target: { kind: "ground", sceneId: "forest-cabin", x: 2, y: 7 },
      },
      {
        id: "generated.walkable-rug",
        target: { kind: "ground", sceneId: "forest-cabin", x: 2, y: 7 },
      },
      {
        id: "generated.slot-cup",
        target: {
          kind: "surface",
          sceneId: "forest-cabin",
          slotId: "left",
          supportItemId: "generated.slot-table",
        },
      },
    ]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM territory_assets").get(),
    ).toEqual({ count: 3 });
    database.close();
  });

  it("keeps scene targets and surface slot cardinality constrained in SQLite", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-territory-invariants-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "db.sqlite"));
    const service = new TerritoryService(
      new TerritoryRepository(database),
      createAssetStore(root),
      new FakeClock("2026-08-06T08:00:00.000Z"),
    );
    service.selectScene({ sceneId: "star-workshop" });

    expect(() =>
      database
        .prepare(
          `UPDATE territory_placements
           SET location = 'collection', scene_id = 'star-workshop'
           WHERE item_id = 'star-workshop.crystal'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE territory_placements
           SET placement_kind = 'surface', grid_x = NULL, grid_y = NULL,
               support_item_id = NULL, slot_id = NULL
           WHERE item_id = 'star-workshop.crystal'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO territory_scenes (
             scene_id, is_active, pet_x, pet_y, pet_facing,
             initialized_at, updated_at
           ) VALUES (
             'forest-cabin', 1, 8, 6, 'right',
             '2026-08-06T08:00:00.000Z', '2026-08-06T08:00:00.000Z'
           )`,
        )
        .run(),
    ).toThrow();
    database.close();
  });
});
