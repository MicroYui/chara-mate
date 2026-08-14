import { describe, expect, it } from "vitest";

import type {
  TerritoryInstance,
  TerritoryZoneView,
} from "../contracts/territoryWorld";
import {
  blockedTerritoryWorldCells,
  findTerritoryWorldPath,
  territoryInstanceFootprint,
  validateTerritoryZoneSpatialState,
} from "./territoryWorldGrid";
import {
  starterPlacedInstances,
  starterTerritoryZoneView,
  territoryWorldFixtureIds,
} from "../../../tests/fixtures/territoryWorld";

describe("Territory World grid", () => {
  it("derives collision and walks to the nearest reachable cell", () => {
    const blocked = blockedTerritoryWorldCells(starterTerritoryZoneView);
    expect(blocked.has("7,5")).toBe(true);

    const path = findTerritoryWorldPath(
      starterTerritoryZoneView.zone,
      { x: 8, y: 7 },
      { x: 7, y: 5 },
      blocked,
    );
    expect(path?.[0]).toEqual({ x: 8, y: 7 });
    const destination = path?.at(-1);
    expect(destination).toBeDefined();
    expect(
      destination
        ? Math.abs(destination.x - 7) + Math.abs(destination.y - 5)
        : undefined,
    ).toBe(1);
    expect(
      destination ? blocked.has(`${destination.x},${destination.y}`) : true,
    ).toBe(false);
  });

  it("accepts the starter composition", () => {
    expect(validateTerritoryZoneSpatialState(starterTerritoryZoneView)).toEqual(
      [],
    );
  });

  it("expands a macro floor tile across four atomic world cells", () => {
    expect(
      territoryInstanceFootprint(
        starterPlacedInstances[0]!,
        starterTerritoryZoneView.definitions[0]!,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it("allows visual overlap but detects physical collision overlap", () => {
    const duplicate: TerritoryInstance = {
      ...starterPlacedInstances[1]!,
      id: "30000000-0000-4000-8000-000000000099",
    };
    const view: TerritoryZoneView = {
      ...starterTerritoryZoneView,
      instances: [...starterTerritoryZoneView.instances, duplicate],
    };

    expect(validateTerritoryZoneSpatialState(view)).toContainEqual(
      expect.objectContaining({
        code: "COLLISION",
        instanceIds: [territoryWorldFixtureIds.deskInstance, duplicate.id],
      }),
    );
  });

  it("detects transformed footprints outside the Zone", () => {
    const desk: TerritoryInstance = {
      ...starterPlacedInstances[1]!,
      placement: {
        flipped: false,
        kind: "zone",
        offsetPx: { x: 0, y: 0 },
        point: { x: 15, y: 9 },
        rotation: 0,
        zoneId: territoryWorldFixtureIds.zone,
      },
    };
    const view: TerritoryZoneView = {
      ...starterTerritoryZoneView,
      instances: [starterPlacedInstances[0]!, desk, starterPlacedInstances[2]!],
    };

    expect(validateTerritoryZoneSpatialState(view)).toContainEqual(
      expect.objectContaining({
        code: "OUT_OF_BOUNDS",
        instanceIds: [desk.id],
      }),
    );
  });
});
