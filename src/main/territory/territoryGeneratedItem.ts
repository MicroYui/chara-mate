import type {
  TerritoryGeneratedItemStructure,
  TerritoryImageCandidate,
} from "../../shared/contracts/territory";
import type { TerritoryItemManifestV1 } from "../../shared/contracts/territoryItemManifest";
import { validateTerritoryItemManifestSemantics } from "../../shared/pure/territoryItemGeometry";
import { TerritoryError } from "./territoryError";

const DEFAULT_VISUAL_SIZE = { height: 96, width: 96 } as const;
const DEFAULT_FOOTPRINT = { height: 2, width: 2 } as const;

export function generatedTerritoryItemId(candidateId: string): string {
  return `generated.${candidateId}`;
}

export function memoryTerritoryItemId(candidateId: string): string {
  return `memory.${candidateId}`;
}

export function generatedStructureFromManifest(
  manifest: TerritoryItemManifestV1,
): TerritoryGeneratedItemStructure {
  const common = {
    flippable: manifest.transforms.flippable,
    rotations: manifest.transforms.rotations,
    visualSizePx: manifest.visual.sizePx,
  } as const;
  if (manifest.placement.mode === "surface") {
    return {
      ...common,
      attachmentAnchorPx: manifest.placement.attachmentAnchorPx,
      placement: "surface",
    };
  }
  return {
    ...common,
    depthAnchorPx: manifest.placement.depthAnchorPx,
    footprintTiles: manifest.placement.gridSize,
    placement:
      manifest.placement.plane === "underlay"
        ? "ground_underlay"
        : "ground_object",
    surfaceSlots: manifest.surfaceSlots.map(
      ({ anchorPx, id, maxItemSizePx }) => ({
        anchorPx,
        id,
        maxItemSizePx,
      }),
    ),
  };
}

export function createGeneratedTerritoryItemManifest(
  candidate: TerritoryImageCandidate,
  identity: {
    readonly assetId: string;
    readonly definitionId: string;
    readonly revision: number;
  } = {
    assetId: generatedTerritoryItemId(candidate.id),
    definitionId: generatedTerritoryItemId(candidate.id),
    revision: 1,
  },
): TerritoryItemManifestV1 {
  const structure = candidate.structure ?? {};
  const visualSize = structure.visualSizePx ?? DEFAULT_VISUAL_SIZE;
  const placementKind = structure.placement ?? "ground_object";
  const transforms: TerritoryItemManifestV1["transforms"] = {
    flippable: structure.flippable ?? true,
    rotations: structure.rotations ?? [0],
  };
  let manifest: TerritoryItemManifestV1;

  if (placementKind === "surface") {
    if (
      structure.depthAnchorPx ||
      structure.footprintTiles ||
      (structure.surfaceSlots?.length ?? 0) > 0
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        "桌面小物不能声明地面占地、深度锚点或承载插槽。",
        false,
      );
    }
    manifest = {
      definitionId: identity.definitionId,
      description: candidate.description,
      name: candidate.name,
      placement: {
        allowedSurfaceKinds: ["tabletop"],
        attachmentAnchorPx: structure.attachmentAnchorPx ?? {
          x: Math.floor(visualSize.width / 2),
          y: visualSize.height,
        },
        mode: "surface",
      },
      revision: identity.revision,
      schemaVersion: 1,
      surfaceSlots: [],
      transforms,
      visual: {
        sizePx: visualSize,
        source: { assetId: identity.assetId, kind: "asset" },
      },
    };
  } else {
    if (structure.attachmentAnchorPx) {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        "地面物件不能声明桌面附件锚点。",
        false,
      );
    }
    if (
      placementKind === "ground_underlay" &&
      (structure.surfaceSlots?.length ?? 0) > 0
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        "地面覆盖物不能提供承载插槽。",
        false,
      );
    }
    const gridSize = structure.footprintTiles ?? DEFAULT_FOOTPRINT;
    const occupancyRows =
      placementKind === "ground_underlay"
        ? Array.from({ length: gridSize.height }, (_, y) => y)
        : [gridSize.height - 1];
    const occupancyCells = occupancyRows.flatMap((y) =>
      Array.from({ length: gridSize.width }, (_, x) => ({ x, y })),
    );
    manifest = {
      definitionId: identity.definitionId,
      description: candidate.description,
      name: candidate.name,
      placement: {
        collisionCells: placementKind === "ground_object" ? occupancyCells : [],
        depthAnchorPx: structure.depthAnchorPx ?? {
          x: Math.floor(visualSize.width / 2),
          y: visualSize.height,
        },
        gridSize,
        mode: "ground",
        occupancyCells,
        plane: placementKind === "ground_object" ? "object" : "underlay",
      },
      revision: identity.revision,
      schemaVersion: 1,
      surfaceSlots: (structure.surfaceSlots ?? []).map((slot) => ({
        ...slot,
        kind: "tabletop" as const,
      })),
      transforms,
      visual: {
        sizePx: visualSize,
        source: { assetId: identity.assetId, kind: "asset" },
      },
    };
  }

  const issue = validateTerritoryItemManifestSemantics(manifest)[0];
  if (issue) {
    throw new TerritoryError(
      "TERRITORY.INVALID_MANIFEST",
      `物件结构参数无效：${issue.message}`,
      false,
    );
  }
  return manifest;
}
