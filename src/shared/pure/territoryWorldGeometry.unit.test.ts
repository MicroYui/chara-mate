import { describe, expect, it } from "vitest";

import {
  starterCollectionInstance,
  starterPlacedInstances,
  starterTerritoryDefinitions,
  territoryWorldFixtureIds,
} from "../../../tests/fixtures/territoryWorld";
import type {
  TerritoryDefinition,
  TerritoryInstance,
} from "../contracts/territoryWorld";
import { territoryInstanceLayout } from "./territoryWorldGeometry";

function maps(
  instances: TerritoryInstance[],
  definitions: TerritoryDefinition[],
) {
  return {
    instances: new Map(instances.map((value) => [value.id, value])),
    definitions: new Map(
      definitions.map((value) => [
        `${value.id}@${String(value.revision)}`,
        value,
      ]),
    ),
  };
}

describe("Territory declared layout geometry", () => {
  it("uses the same world origin and rectangle as the existing Canvas placement", () => {
    const graph = maps(
      structuredClone(starterPlacedInstances),
      structuredClone(starterTerritoryDefinitions),
    );
    const desk = graph.instances.get(territoryWorldFixtureIds.deskInstance)!;
    const lamp = graph.instances.get(territoryWorldFixtureIds.lampInstance)!;
    expect(
      territoryInstanceLayout(desk, graph.instances, graph.definitions),
    ).toEqual({
      status: "available",
      rootInstanceId: desk.id,
      rootGridPoint: { x: 6, y: 4 },
      originPx: { x: 144, y: 96 },
      sizePx: { width: 144, height: 96 },
    });
    expect(
      territoryInstanceLayout(lamp, graph.instances, graph.definitions),
    ).toEqual({
      status: "available",
      rootInstanceId: desk.id,
      rootGridPoint: { x: 6, y: 4 },
      originPx: { x: 202, y: 94 },
      sizePx: { width: 28, height: 36 },
    });
  });

  it("preserves nested quarter turns, flips and local offsets without treating root as display position", () => {
    const graph = maps(
      structuredClone(starterPlacedInstances),
      structuredClone(starterTerritoryDefinitions),
    );
    const desk = graph.instances.get(territoryWorldFixtureIds.deskInstance)!;
    const lamp = graph.instances.get(territoryWorldFixtureIds.lampInstance)!;
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
    const definition = graph.definitions.get("starter.amber-lamp@1")!;
    definition.transforms.rotations = [0, 90, 180, 270];
    definition.anchors = [
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
    graph.instances.set(child.id, child);
    expect(
      territoryInstanceLayout(lamp, graph.instances, graph.definitions),
    ).toEqual({
      status: "available",
      rootInstanceId: desk.id,
      rootGridPoint: { x: 2, y: 3 },
      originPx: { x: 118, y: 123 },
      sizePx: { width: 36, height: 28 },
    });
    expect(
      territoryInstanceLayout(child, graph.instances, graph.definitions),
    ).toEqual({
      status: "available",
      rootInstanceId: desk.id,
      rootGridPoint: { x: 2, y: 3 },
      originPx: { x: 130, y: 150 },
      sizePx: { width: 28, height: 36 },
    });
  });

  it.each([
    "missing_definition",
    "missing_parent",
    "missing_anchor",
    "invalid_attachment",
    "cyclic_attachment",
    "unplaced",
  ] as const)(
    "retains %s as unavailable without fabricated coordinates",
    (reason) => {
      const graph = maps(
        structuredClone(starterPlacedInstances),
        structuredClone(starterTerritoryDefinitions),
      );
      const lamp = graph.instances.get(territoryWorldFixtureIds.lampInstance)!;
      if (lamp.placement.kind !== "attachment")
        throw new Error("Invalid fixture");
      if (reason === "missing_definition") lamp.definition.revision = 2;
      if (reason === "missing_parent")
        graph.instances.delete(lamp.placement.parentInstanceId);
      if (reason === "missing_anchor") lamp.placement.anchorId = "missing";
      if (reason === "invalid_attachment")
        lamp.definition = { id: "starter.cabin-desk", revision: 1 };
      if (reason === "cyclic_attachment") {
        const desk = graph.instances.get(
          territoryWorldFixtureIds.deskInstance,
        )!;
        desk.placement = { ...lamp.placement, parentInstanceId: desk.id };
        const definition = graph.definitions.get("starter.cabin-desk@1")!;
        definition.placement = {
          mode: "attachment",
          allowedAnchors: ["tabletop"],
          attachmentAnchorPx: { x: 0, y: 0 },
        };
      }
      const result = territoryInstanceLayout(
        reason === "unplaced" ? starterCollectionInstance : lamp,
        graph.instances,
        graph.definitions,
      );
      expect(result).toMatchObject({
        status: "unavailable",
        reason,
      });
      expect(
        result.status === "unavailable" && result.referenceId.length > 0,
      ).toBe(true);
      expect(result).not.toHaveProperty("originPx");
      expect(result).not.toHaveProperty("rootGridPoint");
    },
  );
});
