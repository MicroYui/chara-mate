import type {
  TerritoryDefinition,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryInstanceLayout,
  TerritoryRotation,
} from "../contracts/territoryWorld";
import { TERRITORY_WORLD_UNIT_PX } from "./territoryWorldScale";

interface TerritorySize {
  readonly height: number;
  readonly width: number;
}

interface TerritoryPixelPoint {
  readonly x: number;
  readonly y: number;
}

/** The declared layout rectangle, independent of viewport, pixels and collision. */
export function territoryInstanceLayout(
  instance: TerritoryInstance,
  instances: ReadonlyMap<string, TerritoryInstance>,
  definitions: ReadonlyMap<string, TerritoryDefinition>,
  seen = new Set<string>(),
): TerritoryInstanceLayout {
  if (seen.has(instance.id)) {
    return {
      status: "unavailable",
      reason: "cyclic_attachment",
      referenceId: instance.id,
    };
  }
  seen.add(instance.id);
  const definition = definitions.get(
    `${instance.definition.id}@${String(instance.definition.revision)}`,
  );
  if (!definition) {
    return {
      status: "unavailable",
      reason: "missing_definition",
      referenceId: instance.definition.id,
    };
  }
  const placement = instance.placement;
  if (placement.kind === "collection") {
    return {
      status: "unavailable",
      reason: "unplaced",
      referenceId: instance.id,
    };
  }
  const sizePx = rotatedTerritorySize(
    definition.visual.sizePx,
    placement.rotation,
  );
  if (placement.kind === "zone") {
    return {
      status: "available",
      rootInstanceId: instance.id,
      rootGridPoint: { ...placement.point },
      originPx: {
        x: placement.point.x * TERRITORY_WORLD_UNIT_PX + placement.offsetPx.x,
        y: placement.point.y * TERRITORY_WORLD_UNIT_PX + placement.offsetPx.y,
      },
      sizePx,
    };
  }
  const parent = instances.get(placement.parentInstanceId);
  if (!parent) {
    return {
      status: "unavailable",
      reason: "missing_parent",
      referenceId: placement.parentInstanceId,
    };
  }
  const parentDefinition = definitions.get(
    `${parent.definition.id}@${String(parent.definition.revision)}`,
  );
  if (!parentDefinition) {
    return {
      status: "unavailable",
      reason: "missing_definition",
      referenceId: parent.definition.id,
    };
  }
  const anchor = parentDefinition.anchors.find(
    ({ id }) => id === placement.anchorId,
  );
  if (!anchor) {
    return {
      status: "unavailable",
      reason: "missing_anchor",
      referenceId: placement.anchorId,
    };
  }
  if (definition.placement.mode !== "attachment") {
    return {
      status: "unavailable",
      reason: "invalid_attachment",
      referenceId: instance.id,
    };
  }
  const parentLayout = territoryInstanceLayout(
    parent,
    instances,
    definitions,
    seen,
  );
  if (parentLayout.status === "unavailable") return parentLayout;
  if (parent.placement.kind === "collection") {
    return {
      status: "unavailable",
      reason: "unplaced",
      referenceId: parent.id,
    };
  }
  const parentAnchor = transformTerritoryPixelPoint(
    anchor.anchorPx,
    parentDefinition.visual.sizePx,
    parent.placement.flipped,
    parent.placement.rotation,
  );
  const attachmentAnchor = transformTerritoryPixelPoint(
    definition.placement.attachmentAnchorPx,
    definition.visual.sizePx,
    placement.flipped,
    placement.rotation,
  );
  return {
    status: "available",
    rootInstanceId: parentLayout.rootInstanceId,
    rootGridPoint: parentLayout.rootGridPoint,
    originPx: {
      x:
        parentLayout.originPx.x +
        parentAnchor.x -
        attachmentAnchor.x +
        placement.offsetPx.x,
      y:
        parentLayout.originPx.y +
        parentAnchor.y -
        attachmentAnchor.y +
        placement.offsetPx.y,
    },
    sizePx,
  };
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
