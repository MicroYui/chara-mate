import { describe, expect, it } from "vitest";

import type { TerritoryImageCandidate } from "../../shared/contracts/territory";
import { validateTerritoryItemManifestSemantics } from "../../shared/pure/territoryItemGeometry";
import { createGeneratedTerritoryItemManifest } from "./territoryGeneratedItem";
import { buildTerritoryImagePrompt } from "./territoryImagePrompt";

const candidate: TerritoryImageCandidate = {
  acceptedItemId: null,
  createdAt: "2026-08-08T10:00:00.000Z",
  description: "留一盏灯，纪念完成项目的夜晚。",
  editInstruction: null,
  error: null,
  id: "fd1d16b9-2e66-4c52-90c5-042d2ee81434",
  itemCandidateId: null,
  name: "长夜台灯",
  operation: "generate",
  providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
  sceneId: "forest-cabin",
  sourceCandidateId: null,
  status: "generating",
  structure: null,
  updatedAt: "2026-08-08T10:00:00.000Z",
  visualPrompt: "一盏小巧的黄铜工坊台灯",
};

describe("Territory image prompt and generated manifest", () => {
  it("freezes the scene style, isolated background and tile scale", () => {
    const prompt = buildTerritoryImagePrompt(candidate);
    const manifest = createGeneratedTerritoryItemManifest(candidate);

    expect(prompt).toContain("warm woodland cabin");
    expect(prompt).toContain("#ff00ff");
    expect(prompt).toContain(candidate.visualPrompt);
    expect(manifest.visual.sizePx).toEqual({ height: 96, width: 96 });
    expect(manifest.visual.source).toEqual({
      assetId: `generated.${candidate.id}`,
      kind: "asset",
    });
    expect(validateTerritoryItemManifestSemantics(manifest)).toEqual([]);
  });

  it("includes the requested change only on the Edit path", () => {
    const prompt = buildTerritoryImagePrompt({
      ...candidate,
      editInstruction: "把灯罩改成琥珀玻璃",
      operation: "edit",
      sourceCandidateId: candidate.id,
    });

    expect(prompt).toContain("Edit only the provided object");
    expect(prompt).toContain("把灯罩改成琥珀玻璃");
  });

  it("compiles explicit visual, footprint, depth and slot parameters", () => {
    const customized = {
      ...candidate,
      structure: {
        depthAnchorPx: { x: 72, y: 120 },
        flippable: false,
        footprintTiles: { height: 2, width: 3 },
        placement: "ground_object" as const,
        rotations: [0, 90],
        surfaceSlots: [
          {
            anchorPx: { x: 42, y: 54 },
            id: "left",
            maxItemSizePx: { height: 32, width: 32 },
          },
          {
            anchorPx: { x: 102, y: 54 },
            id: "right",
            maxItemSizePx: { height: 32, width: 32 },
          },
        ],
        visualSizePx: { height: 120, width: 144 },
      },
    } satisfies TerritoryImageCandidate;

    const manifest = createGeneratedTerritoryItemManifest(customized);

    expect(manifest.visual.sizePx).toEqual({ height: 120, width: 144 });
    expect(manifest.transforms).toEqual({
      flippable: false,
      rotations: [0, 90],
    });
    expect(manifest.surfaceSlots).toEqual([
      expect.objectContaining({ id: "left", kind: "tabletop" }),
      expect.objectContaining({ id: "right", kind: "tabletop" }),
    ]);
    expect(manifest.placement).toMatchObject({
      collisionCells: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      depthAnchorPx: { x: 72, y: 120 },
      gridSize: { height: 2, width: 3 },
      mode: "ground",
      plane: "object",
    });
    expect(buildTerritoryImagePrompt(customized)).toContain(
      "can hold 2 small decorations",
    );
    expect(validateTerritoryItemManifestSemantics(manifest)).toEqual([]);
  });

  it("derives a compact surface item without ground-only fields", () => {
    const manifest = createGeneratedTerritoryItemManifest({
      ...candidate,
      structure: {
        attachmentAnchorPx: { x: 24, y: 48 },
        placement: "surface",
        visualSizePx: { height: 48, width: 48 },
      },
    });

    expect(manifest.placement).toEqual({
      allowedSurfaceKinds: ["tabletop"],
      attachmentAnchorPx: { x: 24, y: 48 },
      mode: "surface",
    });
    expect(manifest.surfaceSlots).toEqual([]);
    expect(validateTerritoryItemManifestSemantics(manifest)).toEqual([]);
  });

  it("uses the whole declared footprint for a non-blocking underlay", () => {
    const manifest = createGeneratedTerritoryItemManifest({
      ...candidate,
      structure: {
        footprintTiles: { height: 2, width: 3 },
        placement: "ground_underlay",
      },
    });

    expect(manifest.placement).toMatchObject({
      collisionCells: [],
      occupancyCells: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      plane: "underlay",
    });
  });

  it("rejects slots on a ground underlay before calling the Provider", () => {
    expect(() =>
      createGeneratedTerritoryItemManifest({
        ...candidate,
        structure: {
          placement: "ground_underlay",
          surfaceSlots: [
            {
              anchorPx: { x: 48, y: 48 },
              id: "center",
              maxItemSizePx: { height: 32, width: 32 },
            },
          ],
        },
      }),
    ).toThrow("地面覆盖物不能提供承载插槽");
  });
});
