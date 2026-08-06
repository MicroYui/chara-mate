import type {
  TerritoryItem,
  TerritoryPoint,
  TerritoryRotation,
  TerritorySceneDefinition,
} from "../contracts/territory";

const neighborOffsets = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
] as const;

function pointKey(point: TerritoryPoint): string {
  return `${String(point.x)},${String(point.y)}`;
}

function manhattan(left: TerritoryPoint, right: TerritoryPoint): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function isMaskCell(rows: readonly string[], point: TerritoryPoint): boolean {
  return rows[point.y]?.[point.x] === "1";
}

export function rotatedItemSize(
  item: Pick<TerritoryItem, "height" | "width">,
  rotation: TerritoryRotation,
): { readonly height: number; readonly width: number } {
  return rotation === 90 || rotation === 270
    ? { height: item.width, width: item.height }
    : { height: item.height, width: item.width };
}

export function placementCells(
  item: Pick<TerritoryItem, "height" | "width">,
  x: number,
  y: number,
  rotation: TerritoryRotation,
): TerritoryPoint[] {
  const size = rotatedItemSize(item, rotation);
  const cells: TerritoryPoint[] = [];
  for (let offsetY = 0; offsetY < size.height; offsetY += 1) {
    for (let offsetX = 0; offsetX < size.width; offsetX += 1) {
      cells.push({ x: x + offsetX, y: y + offsetY });
    }
  }
  return cells;
}

export function blockedMovementCells(
  placements: readonly TerritoryItem[],
): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const item of placements) {
    if (
      item.location !== "scene" ||
      !item.blocksMovement ||
      item.x === null ||
      item.y === null
    ) {
      continue;
    }
    for (const cell of placementCells(item, item.x, item.y, item.rotation)) {
      blocked.add(pointKey(cell));
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
  while (cameFrom.has(pointKey(cursor))) {
    cursor = cameFrom.get(pointKey(cursor)) as TerritoryPoint;
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
  const startKey = pointKey(start);
  const destinationKey = pointKey(destination);
  const open = new Map<string, TerritoryPoint>([[startKey, start]]);
  const cameFrom = new Map<string, TerritoryPoint>();
  const cost = new Map<string, number>([[startKey, 0]]);

  while (open.size > 0) {
    const current = [...open.values()].sort((left, right) => {
      const leftCost =
        (cost.get(pointKey(left)) ?? Number.POSITIVE_INFINITY) +
        manhattan(left, destination);
      const rightCost =
        (cost.get(pointKey(right)) ?? Number.POSITIVE_INFINITY) +
        manhattan(right, destination);
      return (
        leftCost - rightCost ||
        manhattan(left, destination) - manhattan(right, destination) ||
        left.y - right.y ||
        left.x - right.x
      );
    })[0];
    if (!current) break;

    const currentKey = pointKey(current);
    open.delete(currentKey);
    if (currentKey === destinationKey) {
      return reconstructPath(cameFrom, current);
    }

    for (const offset of neighborOffsets) {
      const neighbor = { x: current.x + offset.x, y: current.y + offset.y };
      const neighborKey = pointKey(neighbor);
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
        (!blocked.has(pointKey(point)) || pointKey(point) === pointKey(start))
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

export function isPlacementValid(
  scene: TerritorySceneDefinition,
  item: TerritoryItem,
  x: number,
  y: number,
  rotation: TerritoryRotation,
  placements: readonly TerritoryItem[],
  pet: TerritoryPoint,
): boolean {
  const requestedCells = placementCells(item, x, y, rotation);
  if (
    requestedCells.some(
      (cell) =>
        !isMaskCell(scene.placeableRows, cell) ||
        (item.blocksMovement && cell.x === pet.x && cell.y === pet.y),
    )
  ) {
    return false;
  }

  const occupied = new Set<string>();
  for (const other of placements) {
    if (
      other.id === item.id ||
      other.location !== "scene" ||
      other.x === null ||
      other.y === null
    ) {
      continue;
    }
    for (const cell of placementCells(
      other,
      other.x,
      other.y,
      other.rotation,
    )) {
      occupied.add(pointKey(cell));
    }
  }
  return requestedCells.every((cell) => !occupied.has(pointKey(cell)));
}
