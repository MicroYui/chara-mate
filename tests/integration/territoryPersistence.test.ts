import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { TerritoryRepository } from "../../src/main/territory/territoryRepository";
import { TerritoryService } from "../../src/main/territory/territoryService";
import { FakeClock } from "../fixtures/fakeClock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Territory deterministic persistence", () => {
  it("initializes once, routes around objects, persists edits, and reopens exactly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-territory-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "charamate.sqlite");
    const clock = new FakeClock("2026-08-06T08:00:00.000Z");
    const database = openApplicationDatabase(databasePath);
    const service = new TerritoryService(
      new TerritoryRepository(database),
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

    clock.advance(1_000);
    const movement = service.movePet({
      from: { x: 8, y: 6 },
      sceneId: "forest-cabin",
      x: 1,
      y: 4,
    });
    expect(movement.path[0]).toEqual({ x: 8, y: 6 });
    expect(movement.path.at(-1)).not.toEqual({ x: 1, y: 4 });
    expect(
      movement.path.some(({ x, y }) => x >= 1 && x <= 3 && y >= 4 && y <= 5),
    ).toBe(false);

    clock.advance(1_000);
    const rerouted = service.movePet({
      from: { x: 7, y: 6 },
      sceneId: "forest-cabin",
      x: 13,
      y: 7,
    });
    expect(rerouted.path[0]).toEqual({ x: 7, y: 6 });
    expect(rerouted.path.at(-1)).toEqual({ x: 13, y: 7 });
    expect(rerouted.snapshot.activeScene?.pet).toMatchObject({ x: 13, y: 7 });

    clock.advance(1_000);
    const collected = service.collectItem({
      itemId: "forest-cabin.rug",
      sceneId: "forest-cabin",
    });
    expect(collected.collection).toEqual([
      expect.objectContaining({
        id: "forest-cabin.rug",
        location: "collection",
        sceneId: null,
        x: null,
        y: null,
      }),
    ]);
    expect(collected.activeScene?.placements).toHaveLength(3);

    clock.advance(1_000);
    const placed = service.placeItem({
      flipped: true,
      itemId: "forest-cabin.rug",
      rotation: 90,
      sceneId: "forest-cabin",
      x: 9,
      y: 6,
    });
    expect(placed.collection).toHaveLength(0);
    expect(
      placed.activeScene?.placements.find(
        ({ id }) => id === "forest-cabin.rug",
      ),
    ).toMatchObject({ flipped: true, rotation: 90, x: 9, y: 6 });

    expect(() =>
      service.placeItem({
        flipped: false,
        itemId: "forest-cabin.desk",
        rotation: 0,
        sceneId: "forest-cabin",
        x: 1,
        y: 4,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TERRITORY.INVALID_PLACEMENT" }),
    );

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
           (SELECT COUNT(*) FROM territory_scenes WHERE is_active = 1) AS active`,
      )
      .get() as { active: number; items: number; scenes: number };
    expect(counts).toEqual({ active: 1, items: 8, scenes: 2 });
    database.close();

    const reopened = openApplicationDatabase(databasePath);
    const restored = new TerritoryService(
      new TerritoryRepository(reopened),
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

  it("keeps active-scene and collection invariants in SQLite", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-territory-invariants-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "db.sqlite"));
    const service = new TerritoryService(
      new TerritoryRepository(database),
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
