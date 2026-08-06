import type {
  TerritoryItem,
  TerritoryPoint,
  TerritoryRotation,
  TerritorySceneDefinition,
} from "../contracts/territory";
import type {
  TerritoryGridCell,
  TerritoryPositiveSize,
} from "../contracts/territoryItemManifest";
import { transformTerritoryGridCell } from "./territoryItemGeometry";

const neighborOffsets = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
] as const;

export function territoryPointKey(point: TerritoryPoint): string {
  return `${String(point.x)},${String(point.y)}`;
}

function manhattan(left: TerritoryPoint, right: TerritoryPoint): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function isMaskCell(rows: readonly string[], point: TerritoryPoint): boolean {
  return rows[point.y]?.[point.x] === "1";
}

export function transformedTerritoryMaskCells(
  cells: readonly TerritoryGridCell[],
  size: TerritoryPositiveSize,
  x: number,
  y: number,
  flipped: boolean,
  rotation: TerritoryRotation,
): TerritoryPoint[] {
  return cells.map((cell) => {
    const transformed = transformTerritoryGridCell(
      cell,
      size,
      flipped,
      rotation,
    );
    return { x: x + transformed.x, y: y + transformed.y };
  });
}

function groundMaskCells(
  item: TerritoryItem,
  mask: "collisionCells" | "occupancyCells",
): TerritoryPoint[] {
  if (
    item.target.kind !== "ground" ||
    item.manifest.placement.mode !== "ground"
  ) {
    return [];
  }
  return transformedTerritoryMaskCells(
    item.manifest.placement[mask],
    item.manifest.placement.gridSize,
    item.target.x,
    item.target.y,
    item.flipped,
    item.rotation,
  );
}

export function blockedMovementCells(
  placements: readonly TerritoryItem[],
): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const item of placements) {
    for (const cell of groundMaskCells(item, "collisionCells")) {
      blocked.add(territoryPointKey(cell));
    }
  }
  return blocked;
}

function reconstructPath(
  cameFrom: ReadonlyMap<string, TerritoryPoint>,
  destination: TerritoryPoint,
): TerritoryPoint[] {
  const path = [destination];
  let cursor = destination;
  while (cameFrom.has(territoryPointKey(cursor))) {
    cursor = cameFrom.get(territoryPointKey(cursor)) as TerritoryPoint;
    path.push(cursor);
  }
  return path.reverse();
}

function findPathToDestination(
  scene: TerritorySceneDefinition,
  start: TerritoryPoint,
  destination: TerritoryPoint,
  blocked: ReadonlySet<string>,
): TerritoryPoint[] | undefined {
  const startKey = territoryPointKey(start);
  const destinationKey = territoryPointKey(destination);
  const open = new Map<string, TerritoryPoint>([[startKey, start]]);
  const cameFrom = new Map<string, TerritoryPoint>();
  const cost = new Map<string, number>([[startKey, 0]]);

  while (open.size > 0) {
    const current = [...open.values()].sort((left, right) => {
      const leftCost =
        (cost.get(territoryPointKey(left)) ?? Number.POSITIVE_INFINITY) +
        manhattan(left, destination);
      const rightCost =
        (cost.get(territoryPointKey(right)) ?? Number.POSITIVE_INFINITY) +
        manhattan(right, destination);
      return (
        leftCost - rightCost ||
        manhattan(left, destination) - manhattan(right, destination) ||
        left.y - right.y ||
        left.x - right.x
      );
    })[0];
    if (!current) break;

    const currentKey = territoryPointKey(current);
    open.delete(currentKey);
    if (currentKey === destinationKey) {
      return reconstructPath(cameFrom, current);
    }

    for (const offset of neighborOffsets) {
      const neighbor = { x: current.x + offset.x, y: current.y + offset.y };
      const neighborKey = territoryPointKey(neighbor);
      if (
        !isMaskCell(scene.walkableRows, neighbor) ||
        (neighborKey !== startKey && blocked.has(neighborKey))
      ) {
        continue;
      }

      const nextCost = (cost.get(currentKey) ?? 0) + 1;
      if (nextCost >= (cost.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      cameFrom.set(neighborKey, current);
      cost.set(neighborKey, nextCost);
      open.set(neighborKey, neighbor);
    }
  }

  return undefined;
}

export function findTerritoryPath(
  scene: TerritorySceneDefinition,
  start: TerritoryPoint,
  requestedDestination: TerritoryPoint,
  blocked: ReadonlySet<string>,
): TerritoryPoint[] | undefined {
  const candidates: TerritoryPoint[] = [];
  for (let y = 0; y < scene.height; y += 1) {
    for (let x = 0; x < scene.width; x += 1) {
      const point = { x, y };
      if (
        isMaskCell(scene.walkableRows, point) &&
        (!blocked.has(territoryPointKey(point)) ||
          territoryPointKey(point) === territoryPointKey(start))
      ) {
        candidates.push(point);
      }
    }
  }
  candidates.sort(
    (left, right) =>
      manhattan(left, requestedDestination) -
        manhattan(right, requestedDestination) ||
      left.y - right.y ||
      left.x - right.x,
  );

  for (const candidate of candidates) {
    const path = findPathToDestination(scene, start, candidate, blocked);
    if (path) return path;
  }
  return undefined;
}

export function isGroundPlacementValid(
  scene: TerritorySceneDefinition,
  item: TerritoryItem,
  x: number,
  y: number,
  rotation: TerritoryRotation,
  flipped: boolean,
  placements: readonly TerritoryItem[],
  pet: TerritoryPoint,
): boolean {
  const placement = item.manifest.placement;
  if (placement.mode !== "ground") return false;

  const requestedCells = transformedTerritoryMaskCells(
    placement.occupancyCells,
    placement.gridSize,
    x,
    y,
    flipped,
    rotation,
  );
  const requestedCollisionCells = transformedTerritoryMaskCells(
    placement.collisionCells,
    placement.gridSize,
    x,
    y,
    flipped,
    rotation,
  );
  if (
    requestedCells.some((cell) => !isMaskCell(scene.placeableRows, cell)) ||
    requestedCollisionCells.some((cell) => cell.x === pet.x && cell.y === pet.y)
  ) {
    return false;
  }

  const occupiedOnSamePlane = new Set<string>();
  for (const other of placements) {
    if (
      other.id === item.id ||
      other.target.kind !== "ground" ||
      other.manifest.placement.mode !== "ground" ||
      other.manifest.placement.plane !== placement.plane
    ) {
      continue;
    }
    for (const cell of groundMaskCells(other, "occupancyCells")) {
      occupiedOnSamePlane.add(territoryPointKey(cell));
    }
  }
  return requestedCells.every(
    (cell) => !occupiedOnSamePlane.has(territoryPointKey(cell)),
  );
}
