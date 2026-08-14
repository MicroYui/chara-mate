import { describe, expect, it } from "vitest";

import {
  TERRITORY_WORLD_OVERLAY_DEPTH_BASE,
  TERRITORY_WORLD_SORTED_DEPTH_BASE,
  territoryWorldFlatDepth,
  territoryWorldOverlayDepth,
  territoryWorldSortedDepth,
} from "./territoryWorldDepth";

describe("Territory World depth plane", () => {
  it("sorts the pet and scene objects on the same foot-y plane", () => {
    const furnitureBehind = territoryWorldSortedDepth(240);
    const pet = territoryWorldSortedDepth(264);
    const furnitureInFront = territoryWorldSortedDepth(288);

    expect(furnitureBehind).toBeLessThan(pet);
    expect(pet).toBeLessThan(furnitureInFront);
    expect(pet).toBe(TERRITORY_WORLD_SORTED_DEPTH_BASE + 264);
  });

  it("keeps attachments with their parent without jumping a spatial row", () => {
    const parent = territoryWorldSortedDepth(240);
    const attachment = territoryWorldSortedDepth(240, 1);

    expect(attachment).toBeGreaterThan(parent);
    expect(attachment).toBeLessThan(territoryWorldSortedDepth(241));
  });

  it("keeps flat backgrounds behind sorted actors and overlays in front", () => {
    const wall = territoryWorldFlatDepth("structure");
    const pet = territoryWorldSortedDepth(0);
    const curtain = territoryWorldOverlayDepth(0);

    expect(wall).toBeLessThan(pet);
    expect(curtain).toBe(TERRITORY_WORLD_OVERLAY_DEPTH_BASE);
    expect(curtain).toBeGreaterThan(pet);
  });
});
