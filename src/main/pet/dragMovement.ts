import type { PetDragPoint } from "../../shared/contracts/pet";

interface DragOriginBounds {
  readonly x: number;
  readonly y: number;
}

export interface DragMovement {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly nextX: number;
  readonly nextY: number;
  readonly stepDeltaX: number;
}

function isFiniteDragPoint(point: PetDragPoint): boolean {
  return Number.isFinite(point.screenX) && Number.isFinite(point.screenY);
}

export function calculateDragMovement(
  originBounds: DragOriginBounds,
  originPoint: PetDragPoint,
  previousPoint: PetDragPoint,
  point: PetDragPoint,
): DragMovement | null {
  if (
    !isFiniteDragPoint(originPoint) ||
    !isFiniteDragPoint(previousPoint) ||
    !isFiniteDragPoint(point)
  ) {
    return null;
  }
  const deltaX = point.screenX - originPoint.screenX;
  const deltaY = point.screenY - originPoint.screenY;
  const nextX = Math.round(originBounds.x + deltaX);
  const nextY = Math.round(originBounds.y + deltaY);
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return null;
  return {
    deltaX,
    deltaY,
    nextX,
    nextY,
    stepDeltaX: point.screenX - previousPoint.screenX,
  };
}
