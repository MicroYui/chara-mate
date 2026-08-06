import type {
  TerritoryItem,
  TerritoryRotation,
  TerritorySurfaceTarget,
} from "../contracts/territory";
import type {
  TerritoryGridCell,
  TerritoryItemManifestV1,
  TerritoryPixelPoint,
  TerritoryPositiveSize,
} from "../contracts/territoryItemManifest";

export type TerritoryItemManifestIssueCode =
  | "ATTACHMENT_ANCHOR_OUTSIDE_VISUAL"
  | "COLLISION_OUTSIDE_OCCUPANCY"
  | "DEPTH_ANCHOR_OUTSIDE_VISUAL"
  | "DUPLICATE_CELL"
  | "DUPLICATE_SLOT_ID"
  | "GROUND_CELL_OUT_OF_BOUNDS"
  | "MISSING_CANONICAL_ROTATION"
  | "SLOT_ANCHOR_OUTSIDE_VISUAL"
  | "SURFACE_ITEM_HAS_SLOTS"
  | "UNDERLAY_BLOCKS_MOVEMENT"
  | "UNDERLAY_HAS_SLOTS";

export interface TerritoryItemManifestIssue {
  readonly code: TerritoryItemManifestIssueCode;
  readonly message: string;
  readonly path: string;
}

function cellKey(cell: TerritoryGridCell): string {
  return `${String(cell.x)},${String(cell.y)}`;
}

function isPointInsideVisual(
  point: TerritoryPixelPoint,
  manifest: TerritoryItemManifestV1,
): boolean {
  const { sizePx } = manifest.visual;
  return (
    point.x >= 0 &&
    point.x <= sizePx.width &&
    point.y >= 0 &&
    point.y <= sizePx.height
  );
}

function duplicateCellIssues(
  cells: readonly TerritoryGridCell[],
  path: string,
): TerritoryItemManifestIssue[] {
  const seen = new Set<string>();
  const issues: TerritoryItemManifestIssue[] = [];
  cells.forEach((cell, index) => {
    const key = cellKey(cell);
    if (seen.has(key)) {
      issues.push({
        code: "DUPLICATE_CELL",
        message: "同一个 mask 不能重复声明网格单元。",
        path: `${path}/${String(index)}`,
      });
    }
    seen.add(key);
  });
  return issues;
}

export function rotatedTerritorySize(
  size: TerritoryPositiveSize,
  rotation: TerritoryRotation,
): TerritoryPositiveSize {
  return rotation === 90 || rotation === 270
    ? { height: size.width, width: size.height }
    : { height: size.height, width: size.width };
}

export function transformTerritoryGridCell(
  cell: TerritoryGridCell,
  size: TerritoryPositiveSize,
  flipped: boolean,
  rotation: TerritoryRotation,
): TerritoryGridCell {
  const canonical = flipped ? { x: size.width - 1 - cell.x, y: cell.y } : cell;
  if (rotation === 90) {
    return { x: size.height - 1 - canonical.y, y: canonical.x };
  }
  if (rotation === 180) {
    return {
      x: size.width - 1 - canonical.x,
      y: size.height - 1 - canonical.y,
    };
  }
  if (rotation === 270) {
    return { x: canonical.y, y: size.width - 1 - canonical.x };
  }
  return { x: canonical.x, y: canonical.y };
}

export function transformTerritoryPixelPoint(
  point: TerritoryPixelPoint,
  bounds: TerritoryPositiveSize,
  flipped: boolean,
  rotation: TerritoryRotation,
): TerritoryPixelPoint {
  const canonical = flipped ? { x: bounds.width - point.x, y: point.y } : point;
  if (rotation === 90) {
    return { x: bounds.height - canonical.y, y: canonical.x };
  }
  if (rotation === 180) {
    return {
      x: bounds.width - canonical.x,
      y: bounds.height - canonical.y,
    };
  }
  if (rotation === 270) {
    return { x: canonical.y, y: bounds.width - canonical.x };
  }
  return { x: canonical.x, y: canonical.y };
}

export function validateTerritoryItemManifestSemantics(
  manifest: TerritoryItemManifestV1,
): TerritoryItemManifestIssue[] {
  const issues: TerritoryItemManifestIssue[] = [];
  if (!manifest.transforms.rotations.includes(0)) {
    issues.push({
      code: "MISSING_CANONICAL_ROTATION",
      message: "旋转集合必须包含规范朝向 0。",
      path: "/transforms/rotations",
    });
  }

  const slotIds = new Set<string>();
  manifest.surfaceSlots.forEach((slot, index) => {
    if (slotIds.has(slot.id)) {
      issues.push({
        code: "DUPLICATE_SLOT_ID",
        message: "同一物件内的插槽 ID 必须唯一。",
        path: `/surfaceSlots/${String(index)}/id`,
      });
    }
    slotIds.add(slot.id);
    if (!isPointInsideVisual(slot.anchorPx, manifest)) {
      issues.push({
        code: "SLOT_ANCHOR_OUTSIDE_VISUAL",
        message: "插槽锚点必须位于物件视觉范围内。",
        path: `/surfaceSlots/${String(index)}/anchorPx`,
      });
    }
  });

  if (manifest.placement.mode === "surface") {
    if (manifest.surfaceSlots.length > 0) {
      issues.push({
        code: "SURFACE_ITEM_HAS_SLOTS",
        message: "v1 的插槽物件不能继续提供插槽。",
        path: "/surfaceSlots",
      });
    }
    if (!isPointInsideVisual(manifest.placement.attachmentAnchorPx, manifest)) {
      issues.push({
        code: "ATTACHMENT_ANCHOR_OUTSIDE_VISUAL",
        message: "附件锚点必须位于附件视觉范围内。",
        path: "/placement/attachmentAnchorPx",
      });
    }
    return issues;
  }

  const { collisionCells, gridSize, occupancyCells, plane } =
    manifest.placement;
  issues.push(
    ...duplicateCellIssues(occupancyCells, "/placement/occupancyCells"),
    ...duplicateCellIssues(collisionCells, "/placement/collisionCells"),
  );
  for (const [name, cells] of [
    ["occupancyCells", occupancyCells],
    ["collisionCells", collisionCells],
  ] as const) {
    cells.forEach((cell, index) => {
      if (cell.x >= gridSize.width || cell.y >= gridSize.height) {
        issues.push({
          code: "GROUND_CELL_OUT_OF_BOUNDS",
          message: "地面 mask 单元必须位于 gridSize 内。",
          path: `/placement/${name}/${String(index)}`,
        });
      }
    });
  }
  const occupied = new Set(occupancyCells.map(cellKey));
  collisionCells.forEach((cell, index) => {
    if (!occupied.has(cellKey(cell))) {
      issues.push({
        code: "COLLISION_OUTSIDE_OCCUPANCY",
        message: "碰撞 mask 必须是占用 mask 的子集。",
        path: `/placement/collisionCells/${String(index)}`,
      });
    }
  });
  if (plane === "underlay" && collisionCells.length > 0) {
    issues.push({
      code: "UNDERLAY_BLOCKS_MOVEMENT",
      message: "地面覆盖物不能阻挡角色行走。",
      path: "/placement/collisionCells",
    });
  }
  if (plane === "underlay" && manifest.surfaceSlots.length > 0) {
    issues.push({
      code: "UNDERLAY_HAS_SLOTS",
      message: "地面覆盖物不能提供承载插槽。",
      path: "/surfaceSlots",
    });
  }
  if (!isPointInsideVisual(manifest.placement.depthAnchorPx, manifest)) {
    issues.push({
      code: "DEPTH_ANCHOR_OUTSIDE_VISUAL",
      message: "深度锚点必须位于物件视觉范围内。",
      path: "/placement/depthAnchorPx",
    });
  }
  return issues;
}

export function isTerritoryAttachmentCompatible(
  support: TerritoryItemManifestV1,
  slotId: string,
  attachment: TerritoryItemManifestV1,
): boolean {
  if (
    support.placement.mode !== "ground" ||
    support.placement.plane !== "object" ||
    attachment.placement.mode !== "surface"
  ) {
    return false;
  }
  const slot = support.surfaceSlots.find(({ id }) => id === slotId);
  return Boolean(
    slot &&
    attachment.placement.allowedSurfaceKinds.includes(slot.kind) &&
    attachment.visual.sizePx.width <= slot.maxItemSizePx.width &&
    attachment.visual.sizePx.height <= slot.maxItemSizePx.height,
  );
}

export function isTerritorySurfacePlacementValid(
  item: TerritoryItem,
  target: TerritorySurfaceTarget,
  placements: readonly TerritoryItem[],
): boolean {
  const support = placements.find(({ id }) => id === target.supportItemId);
  if (
    item.id === target.supportItemId ||
    item.manifest.placement.mode !== "surface" ||
    !support ||
    support.target.kind !== "ground" ||
    support.target.sceneId !== target.sceneId ||
    !isTerritoryAttachmentCompatible(
      support.manifest,
      target.slotId,
      item.manifest,
    )
  ) {
    return false;
  }
  return !placements.some(
    (other) =>
      other.id !== item.id &&
      other.target.kind === "surface" &&
      other.target.supportItemId === target.supportItemId &&
      other.target.slotId === target.slotId,
  );
}
