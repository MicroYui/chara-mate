import type { TerritoryLayer } from "../../../shared/contracts/territoryWorld";

const flatLayerDepth: Record<TerritoryLayer, number> = {
  attachment: 0,
  effect: 4_000,
  foreground: 0,
  object: 0,
  structure: 1_000,
  terrain: 100,
  underlay: 2_000,
};

export const TERRITORY_WORLD_SORTED_DEPTH_BASE = 100_000;
export const TERRITORY_WORLD_OVERLAY_DEPTH_BASE = 500_000;

export function territoryWorldFlatDepth(layer: TerritoryLayer): number {
  return flatLayerDepth[layer];
}

export function territoryWorldSortedDepth(
  footY: number,
  attachmentNesting = 0,
): number {
  return TERRITORY_WORLD_SORTED_DEPTH_BASE + footY + attachmentNesting / 100;
}

export function territoryWorldOverlayDepth(worldY: number): number {
  return TERRITORY_WORLD_OVERLAY_DEPTH_BASE + worldY;
}
