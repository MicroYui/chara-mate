import { describe, expect, it } from "vitest";

import type { TerritoryItem } from "../contracts/territory";
import {
  getTerritoryItemDefinition,
  TERRITORY_SCENE_ORDER,
  TERRITORY_SCENES,
} from "../../main/territory/catalog";
import {
  blockedMovementCells,
  findTerritoryPath,
  isGroundPlacementValid,
  transformedTerritoryMaskCells,
} from "./territoryGrid";
import { rotatedTerritorySize } from "./territoryItemGeometry";

const timestamp = "2026-08-06T08:00:00.000Z" as const;

function sceneItems(sceneId: (typeof TERRITORY_SCENE_ORDER)[number]) {
  return TERRITORY_SCENES[sceneId].defaults.map((item): TerritoryItem => ({
    flipped: item.flipped ?? false,
    id: item.id,
    manifest: getTerritoryItemDefinition(item.definitionId),
    pinned: false,
    placedAt: timestamp,
    rotation: item.rotation ?? 0,
    target: { kind: "ground", sceneId, x: item.x, y: item.y },
    updatedAt: timestamp,
  }));
}

describe("Territory 2.5D nav grid", () => {
  it("keeps every built-in ground placement valid on its semantic plane", () => {
    for (const sceneId of TERRITORY_SCENE_ORDER) {
      const scene = TERRITORY_SCENES[sceneId];
      const items = sceneItems(sceneId);
      for (const item of items) {
        if (item.target.kind !== "ground") throw new Error("Expected ground");
        expect(
          isGroundPlacementValid(
            scene.definition,
            item,
            item.target.x,
            item.target.y,
            item.rotation,
            item.flipped,
            items.filter(({ id }) => id !== item.id),
            scene.definition.entry,
          ),
          `${sceneId}/${item.id}`,
        ).toBe(true);
      }
    }
  });

  it("walks straight behind the upper visual row of a desk", () => {
    const scene = TERRITORY_SCENES["forest-cabin"];
    const items = sceneItems("forest-cabin");
    const blocked = blockedMovementCells(items);
    const path = findTerritoryPath(
      scene.definition,
      { x: 10, y: 4 },
      { x: 14, y: 4 },
      blocked,
    );

    expect(blocked.has("11,4")).toBe(false);
    expect(blocked.has("11,5")).toBe(true);
    expect(path).toEqual([
      { x: 10, y: 4 },
      { x: 11, y: 4 },
      { x: 12, y: 4 },
      { x: 13, y: 4 },
      { x: 14, y: 4 },
    ]);
  });

  it("rotates the declared footprint mask instead of a whole rectangle", () => {
    const desk = sceneItems("forest-cabin").find(
      ({ manifest }) => manifest.definitionId === "builtin.cabin-desk",
    );
    if (!desk || desk.manifest.placement.mode !== "ground") {
      throw new Error("Missing desk fixture");
    }

    expect(rotatedTerritorySize(desk.manifest.placement.gridSize, 90)).toEqual({
      height: 3,
      width: 2,
    });
    expect(
      transformedTerritoryMaskCells(
        desk.manifest.placement.collisionCells,
        desk.manifest.placement.gridSize,
        4,
        5,
        false,
        90,
      ),
    ).toEqual([
      { x: 4, y: 5 },
      { x: 4, y: 6 },
      { x: 4, y: 7 },
    ]);
  });
});
