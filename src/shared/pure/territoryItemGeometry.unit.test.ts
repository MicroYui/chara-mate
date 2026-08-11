import { describe, expect, it } from "vitest";

import type { TerritoryItemManifestV1 } from "../contracts/territoryItemManifest";
import { TERRITORY_ITEM_DEFINITIONS } from "../../main/territory/catalog";
import {
  isTerritoryAttachmentCompatible,
  isTerritorySurfacePlacementValid,
  rotatedTerritorySize,
  transformTerritoryGridCell,
  transformTerritoryPixelPoint,
  validateTerritoryItemManifestSemantics,
} from "./territoryItemGeometry";
import {
  territoryCupManifest,
  territoryDeskManifest,
  territoryHearthManifest,
  territoryRugManifest,
} from "../../../tests/fixtures/territoryItemManifests";

describe("Territory 2.5D item geometry", () => {
  it("transforms masks and anchors with one flip-then-rotate rule", () => {
    const size = { height: 2, width: 3 };
    expect(rotatedTerritorySize(size, 90)).toEqual({ height: 3, width: 2 });
    expect(
      [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ].map((cell) => transformTerritoryGridCell(cell, size, false, 90)),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
    ]);
    expect(
      transformTerritoryPixelPoint(
        { x: 36, y: 32 },
        { height: 96, width: 144 },
        true,
        90,
      ),
    ).toEqual({ x: 64, y: 108 });
  });

  it("accepts the structured rug, furniture, hearth, and cup examples", () => {
    for (const manifest of [
      territoryDeskManifest,
      territoryHearthManifest,
      territoryRugManifest,
      territoryCupManifest,
    ]) {
      expect(validateTerritoryItemManifestSemantics(manifest)).toEqual([]);
    }
  });

  it("keeps every built-in furniture and accessory manifest semantic", () => {
    expect(Object.keys(TERRITORY_ITEM_DEFINITIONS)).toHaveLength(19);
    for (const manifest of Object.values(TERRITORY_ITEM_DEFINITIONS)) {
      expect(
        validateTerritoryItemManifestSemantics(manifest),
        manifest.definitionId,
      ).toEqual([]);
    }
  });

  it("rejects masks or slots that violate the single-layer semantics", () => {
    const invalidRug: TerritoryItemManifestV1 = {
      ...territoryRugManifest,
      placement: {
        ...territoryRugManifest.placement,
        collisionCells: [{ x: 0, y: 0 }],
      },
      surfaceSlots: [territoryDeskManifest.surfaceSlots[0]!],
    };
    const invalidCup: TerritoryItemManifestV1 = {
      ...territoryCupManifest,
      placement: {
        ...territoryCupManifest.placement,
        attachmentAnchorPx: { x: 25, y: 29 },
      },
      surfaceSlots: [territoryDeskManifest.surfaceSlots[0]!],
    };
    const rugCodes = validateTerritoryItemManifestSemantics(invalidRug).map(
      ({ code }) => code,
    );
    expect(rugCodes).toContain("UNDERLAY_BLOCKS_MOVEMENT");
    expect(rugCodes).toContain("UNDERLAY_HAS_SLOTS");
    const cupCodes = validateTerritoryItemManifestSemantics(invalidCup).map(
      ({ code }) => code,
    );
    expect(cupCodes).toContain("SURFACE_ITEM_HAS_SLOTS");
    expect(cupCodes).toContain("ATTACHMENT_ANCHOR_OUTSIDE_VISUAL");
  });

  it("reports deterministic authoring errors for malformed furniture geometry", () => {
    const invalidDesk: TerritoryItemManifestV1 = {
      ...territoryDeskManifest,
      placement: {
        ...territoryDeskManifest.placement,
        collisionCells: [{ x: 2, y: 0 }],
        depthAnchorPx: { x: 145, y: 97 },
        occupancyCells: [
          { x: 0, y: 1 },
          { x: 0, y: 1 },
          { x: 3, y: 1 },
        ],
      },
      surfaceSlots: [
        territoryDeskManifest.surfaceSlots[0]!,
        {
          ...territoryDeskManifest.surfaceSlots[1]!,
          anchorPx: { x: 145, y: 97 },
          id: "left",
        },
      ],
      transforms: {
        ...territoryDeskManifest.transforms,
        rotations: [90],
      },
    };
    const codes = validateTerritoryItemManifestSemantics(invalidDesk).map(
      ({ code }) => code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "MISSING_CANONICAL_ROTATION",
        "DUPLICATE_SLOT_ID",
        "SLOT_ANCHOR_OUTSIDE_VISUAL",
        "DUPLICATE_CELL",
        "GROUND_CELL_OUT_OF_BOUNDS",
        "COLLISION_OUTSIDE_OCCUPANCY",
        "DEPTH_ANCHOR_OUTSIDE_VISUAL",
      ]),
    );
  });

  it("matches a surface item only to a compatible support-slot definition", () => {
    expect(
      isTerritoryAttachmentCompatible(
        territoryDeskManifest,
        "left",
        territoryCupManifest,
      ),
    ).toBe(true);
    expect(
      isTerritoryAttachmentCompatible(
        territoryDeskManifest,
        "missing",
        territoryCupManifest,
      ),
    ).toBe(false);
    expect(
      isTerritoryAttachmentCompatible(
        territoryRugManifest,
        "left",
        territoryCupManifest,
      ),
    ).toBe(false);

    const oversizedCup: TerritoryItemManifestV1 = {
      ...territoryCupManifest,
      visual: {
        ...territoryCupManifest.visual,
        sizePx: { height: 64, width: 64 },
      },
    };
    expect(
      isTerritoryAttachmentCompatible(
        territoryDeskManifest,
        "left",
        oversizedCup,
      ),
    ).toBe(false);
  });

  it("uses one surface-placement rule for available and occupied slots", () => {
    const timestamp = "2026-08-06T08:00:00.000Z" as const;
    const desk = {
      flipped: false,
      id: "forest-cabin.desk",
      manifest: territoryDeskManifest,
      pinned: false,
      placedAt: timestamp,
      rotation: 0 as const,
      sources: [],
      target: {
        kind: "ground" as const,
        sceneId: "forest-cabin" as const,
        x: 11,
        y: 4,
      },
      updatedAt: timestamp,
      versions: [
        {
          active: true,
          createdAt: timestamp,
          manifest: territoryDeskManifest,
          revision: 1,
        },
      ],
    };
    const cup = {
      flipped: false,
      id: "collection.cup",
      manifest: territoryCupManifest,
      pinned: false,
      placedAt: null,
      rotation: 0 as const,
      sources: [],
      target: { kind: "collection" as const },
      updatedAt: timestamp,
      versions: [
        {
          active: true,
          createdAt: timestamp,
          manifest: territoryCupManifest,
          revision: 1,
        },
      ],
    };
    const target = {
      kind: "surface" as const,
      sceneId: "forest-cabin" as const,
      slotId: "left",
      supportItemId: desk.id,
    };
    expect(isTerritorySurfacePlacementValid(cup, target, [desk])).toBe(true);
    expect(
      isTerritorySurfacePlacementValid(cup, target, [
        desk,
        {
          ...cup,
          id: "collection.other-cup",
          placedAt: timestamp,
          target,
        },
      ]),
    ).toBe(false);
    expect(
      isTerritorySurfacePlacementValid(
        cup,
        { ...target, sceneId: "seaside-room" },
        [desk],
      ),
    ).toBe(false);
  });
});
