import type {
  TerritoryDefinition,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryZone,
  TerritoryZoneView,
} from "../contracts/territoryWorld";
import { transformTerritoryGridCell } from "./territoryWorldGeometry";

const neighborOffsets = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
] as const;

export interface TerritorySpatialIssue {
  readonly code: "COLLISION" | "OUT_OF_BOUNDS";
  readonly instanceIds: readonly string[];
  readonly message: string;
  readonly point: TerritoryGridPoint;
}

function pointKey(point: TerritoryGridPoint): string {
  return `${String(point.x)},${String(point.y)}`;
}

function definitionKey(definition: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${definition.id}@${String(definition.revision)}`;
}

function gridSize(definition: TerritoryDefinition): {
  height: number;
  width: number;
} {
  if (definition.placement.mode === "tile") {
    return definition.placement.span;
  }
  if (definition.placement.mode !== "grid") {
    return { height: 1, width: 1 };
  }
  return {
    height:
      Math.max(...definition.placement.footprintCells.map((cell) => cell.y)) +
      1,
    width:
      Math.max(...definition.placement.footprintCells.map((cell) => cell.x)) +
      1,
  };
}

function rectangleCells(width: number, height: number): TerritoryGridPoint[] {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
  }));
}

function transformedCells(
  cells: readonly TerritoryGridPoint[],
  definition: TerritoryDefinition,
  instance: TerritoryInstance,
): TerritoryGridPoint[] {
  if (instance.placement.kind !== "zone") return [];
  const placement = instance.placement;
  const size = gridSize(definition);
  return cells.map((cell) => {
    const transformed = transformTerritoryGridCell(
      cell,
      size,
      placement.flipped,
      placement.rotation,
    );
    return {
      x: placement.point.x + transformed.x,
      y: placement.point.y + transformed.y,
    };
  });
}

export function territoryInstanceFootprint(
  instance: TerritoryInstance,
  definition: TerritoryDefinition,
): TerritoryGridPoint[] {
  if (instance.placement.kind !== "zone") return [];
  if (definition.placement.mode === "grid") {
    return transformedCells(
      definition.placement.footprintCells,
      definition,
      instance,
    );
  }
  if (definition.placement.mode === "tile") {
    return transformedCells(
      rectangleCells(
        definition.placement.span.width,
        definition.placement.span.height,
      ),
      definition,
      instance,
    );
  }
  return [instance.placement.point];
}

export function territoryInstanceCollisionCells(
  instance: TerritoryInstance,
  definition: TerritoryDefinition,
): TerritoryGridPoint[] {
  if (instance.placement.kind !== "zone") return [];
  if (definition.placement.mode === "grid") {
    return transformedCells(
      definition.placement.collisionCells,
      definition,
      instance,
    );
  }
  if (definition.placement.mode === "tile" && definition.placement.collision) {
    return territoryInstanceFootprint(instance, definition);
  }
  return [];
}

export function validateTerritoryZoneSpatialState(
  view: TerritoryZoneView,
): TerritorySpatialIssue[] {
  const issues: TerritorySpatialIssue[] = [];
  const definitions = new Map(
    view.definitions.map((definition) => [
      definitionKey(definition),
      definition,
    ]),
  );
  const occupied = new Map<string, { instanceId: string; layer: string }>();
  const collisions = new Map<string, string>();
  for (const instance of view.instances) {
    const definition = definitions.get(definitionKey(instance.definition));
    if (!definition || instance.placement.kind !== "zone") continue;
    for (const point of territoryInstanceFootprint(instance, definition)) {
      if (
        point.x < 0 ||
        point.y < 0 ||
        point.x >= view.zone.bounds.width ||
        point.y >= view.zone.bounds.height
      ) {
        issues.push({
          code: "OUT_OF_BOUNDS",
          instanceIds: [instance.id],
          message: "物件占地超出 Zone 边界。",
          point,
        });
        continue;
      }
      const layerUsesExclusiveCells =
        definition.layer === "terrain" || definition.layer === "structure";
      if (!layerUsesExclusiveCells) continue;
      const key = `${definition.layer}:${pointKey(point)}`;
      const previous = occupied.get(key);
      if (previous) {
        issues.push({
          code: "COLLISION",
          instanceIds: [previous.instanceId, instance.id],
          message: "同一空间层的物件占地重叠。",
          point,
        });
      } else {
        occupied.set(key, { instanceId: instance.id, layer: definition.layer });
      }
    }
    for (const point of territoryInstanceCollisionCells(instance, definition)) {
      const key = pointKey(point);
      const previous = collisions.get(key);
      if (previous) {
        issues.push({
          code: "COLLISION",
          instanceIds: [previous, instance.id],
          message: "物件碰撞范围重叠。",
          point,
        });
      } else {
        collisions.set(key, instance.id);
      }
    }
  }
  if (view.pet) {
    const blockingInstance = collisions.get(pointKey(view.pet.point));
    if (blockingInstance) {
      issues.push({
        code: "COLLISION",
        instanceIds: [blockingInstance],
        message: "物件不能占用桌宠当前所在的位置。",
        point: view.pet.point,
      });
    }
  }
  return issues;
}

export function blockedTerritoryWorldCells(
  view: TerritoryZoneView,
): ReadonlySet<string> {
  const definitions = new Map(
    view.definitions.map((definition) => [
      definitionKey(definition),
      definition,
    ]),
  );
  const blocked = new Set<string>();
  for (const instance of view.instances) {
    const definition = definitions.get(definitionKey(instance.definition));
    if (!definition) continue;
    for (const point of territoryInstanceCollisionCells(instance, definition)) {
      blocked.add(pointKey(point));
    }
  }
  return blocked;
}

function insideZone(point: TerritoryGridPoint, zone: TerritoryZone): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < zone.bounds.width &&
    point.y < zone.bounds.height
  );
}

function manhattan(
  left: TerritoryGridPoint,
  right: TerritoryGridPoint,
): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function reconstructPath(
  cameFrom: ReadonlyMap<string, TerritoryGridPoint>,
  destination: TerritoryGridPoint,
): TerritoryGridPoint[] {
  const path = [destination];
  let cursor = destination;
  while (cameFrom.has(pointKey(cursor))) {
    cursor = cameFrom.get(pointKey(cursor)) as TerritoryGridPoint;
    path.push(cursor);
  }
  return path.reverse();
}

export function findTerritoryWorldPath(
  zone: TerritoryZone,
  start: TerritoryGridPoint,
  requestedDestination: TerritoryGridPoint,
  blocked: ReadonlySet<string>,
): TerritoryGridPoint[] | undefined {
  if (!insideZone(start, zone)) return undefined;
  const startKey = pointKey(start);
  const queue: TerritoryGridPoint[] = [start];
  const visited = new Set<string>([startKey]);
  const cameFrom = new Map<string, TerritoryGridPoint>();
  let best = start;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const currentDistance = manhattan(current, requestedDestination);
    const bestDistance = manhattan(best, requestedDestination);
    if (
      currentDistance < bestDistance ||
      (currentDistance === bestDistance &&
        (current.y < best.y || (current.y === best.y && current.x < best.x)))
    ) {
      best = current;
    }
    if (
      current.x === requestedDestination.x &&
      current.y === requestedDestination.y
    ) {
      return reconstructPath(cameFrom, current);
    }
    for (const offset of neighborOffsets) {
      const neighbor = { x: current.x + offset.x, y: current.y + offset.y };
      const key = pointKey(neighbor);
      if (
        visited.has(key) ||
        !insideZone(neighbor, zone) ||
        (key !== startKey && blocked.has(key))
      ) {
        continue;
      }
      visited.add(key);
      cameFrom.set(key, current);
      queue.push(neighbor);
    }
  }
  return reconstructPath(cameFrom, best);
}
