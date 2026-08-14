import type {
  TerritoryGridPoint,
  TerritoryRotation,
} from "../contracts/territoryWorld";

interface TerritorySize {
  readonly height: number;
  readonly width: number;
}

interface TerritoryPixelPoint {
  readonly x: number;
  readonly y: number;
}

export function rotatedTerritorySize(
  size: TerritorySize,
  rotation: TerritoryRotation,
): TerritorySize {
  return rotation === 90 || rotation === 270
    ? { height: size.width, width: size.height }
    : { height: size.height, width: size.width };
}

export function transformTerritoryGridCell(
  cell: TerritoryGridPoint,
  size: TerritorySize,
  flipped: boolean,
  rotation: TerritoryRotation,
): TerritoryGridPoint {
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
  bounds: TerritorySize,
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
