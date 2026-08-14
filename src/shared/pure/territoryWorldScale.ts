/**
 * Territory coordinates are integer world units. A terrain/structure macro
 * tile spans two units, preserving the existing 48 px packaged art scale.
 */
export const TERRITORY_WORLD_UNIT_PX = 24;
export const TERRITORY_WORLD_MACRO_UNITS = 2;
export const TERRITORY_WORLD_MACRO_PX =
  TERRITORY_WORLD_UNIT_PX * TERRITORY_WORLD_MACRO_UNITS;

export function territoryWorldUnitsToPixels(units: number): number {
  return units * TERRITORY_WORLD_UNIT_PX;
}
