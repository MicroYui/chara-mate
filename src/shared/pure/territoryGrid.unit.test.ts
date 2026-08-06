import { describe, expect, it } from "vitest";

import {
  describeTerritoryItem,
  TERRITORY_SCENE_ORDER,
  TERRITORY_SCENES,
} from "../../main/territory/catalog";
import {
  blockedMovementCells,
  findTerritoryPath,
  isPlacementValid,
  placementCells,
  rotatedItemSize,
} from "./territoryGrid";

const timestamp = "2026-08-06T08:00:00.000Z" as const;

function sceneItems(sceneId: (typeof TERRITORY_SCENE_ORDER)[number]) {
  return TERRITORY_SCENES[sceneId].defaults.map((item) =>
    describeTerritoryItem({
      catalogId: item.catalogId,
      flipped: item.flipped ?? false,
      id: item.id,
      layer: item.layer,
      location: "scene",
      pinned: false,
      placedAt: timestamp,
      rotation: item.rotation ?? 0,
      sceneId,
      updatedAt: timestamp,
      x: item.x,
      y: item.y,
    }),
  );
}

describe("Territory nav grid", () => {
  it("keeps every built-in scene placement valid and non-overlapping", () => {
    for (const sceneId of TERRITORY_SCENE_ORDER) {
      const scene = TERRITORY_SCENES[sceneId];
      const items = sceneItems(sceneId);
      for (const item of items) {
        expect(
          isPlacementValid(
            scene.definition,
            item,
            item.x ?? 0,
            item.y ?? 0,
            item.rotation,
            items.filter(({ id }) => id !== item.id),
            scene.definition.entry,
          ),
          `${sceneId}/${item.id}`,
        ).toBe(true);
      }
    }
  });

  it("finds a deterministic route to the closest cell beside an obstacle", () => {
    const scene = TERRITORY_SCENES["forest-cabin"];
    const items = sceneItems("forest-cabin");
    const path = findTerritoryPath(
      scene.definition,
      scene.definition.entry,
      { x: 1, y: 4 },
      blockedMovementCells(items),
    );

    expect(path?.[0]).toEqual(scene.definition.entry);
    expect(path?.at(-1)).toEqual({ x: 1, y: 6 });
    const blocked = blockedMovementCells(items);
    expect(path?.every((point) => !blocked.has(`${point.x},${point.y}`))).toBe(
      true,
    );
  });

  it("uses one transform-aware footprint for rotation and collision", () => {
    const desk = sceneItems("forest-cabin").find(
      ({ catalogId }) => catalogId === "cabin-desk",
    );
    if (!desk) throw new Error("Missing desk fixture");

    expect(rotatedItemSize(desk, 90)).toEqual({ height: 3, width: 2 });
    expect(placementCells(desk, 4, 5, 90)).toHaveLength(6);
    expect(
      isPlacementValid(
        TERRITORY_SCENES["forest-cabin"].definition,
        desk,
        7,
        5,
        90,
        sceneItems("forest-cabin"),
        { x: 8, y: 6 },
      ),
    ).toBe(false);
  });
});
