import type {
  PetAnimation,
  PetFacing,
  PetSpriteVersion,
} from "../../shared/contracts/pet";

export const PET_CELL_WIDTH = 192;
export const PET_CELL_HEIGHT = 208;

export interface PetAtlasFrame {
  readonly column: number;
  readonly durationMs: number;
  readonly row: number;
}

const standardRows = {
  failed: { durations: [140, 140, 140, 140, 140, 140, 140, 240], row: 5 },
  idle: { durations: [280, 110, 110, 140, 140, 320], row: 0 },
  jumping: { durations: [140, 140, 140, 140, 280], row: 4 },
  review: { durations: [150, 150, 150, 150, 150, 280], row: 8 },
  running: { durations: [120, 120, 120, 120, 120, 220], row: 7 },
  "running-left": {
    durations: [120, 120, 120, 120, 120, 120, 120, 220],
    row: 2,
  },
  "running-right": {
    durations: [120, 120, 120, 120, 120, 120, 120, 220],
    row: 1,
  },
  waiting: { durations: [150, 150, 150, 150, 150, 260], row: 6 },
  waving: { durations: [140, 140, 140, 280], row: 3 },
} as const;

export function normalizeLookDirection(angleDegrees: number): number {
  const normalized = ((angleDegrees % 360) + 360) % 360;
  return Math.round(normalized / 22.5) % 16;
}

export function getPetAtlasFrames(
  animation: PetAnimation,
  version: PetSpriteVersion,
  lookAngleDegrees = 0,
): readonly PetAtlasFrame[] {
  if (animation === "look" && version === 2) {
    const direction = normalizeLookDirection(lookAngleDegrees);
    return [
      {
        column: direction % 8,
        durationMs: 280,
        row: 9 + Math.floor(direction / 8),
      },
    ];
  }

  const resolved = animation === "look" ? "idle" : animation;
  const row = standardRows[resolved];
  const cycleCount = animation === "look" && version === 1 ? 3 : 1;
  return Array.from({ length: cycleCount }, () =>
    row.durations.map((durationMs, column) => ({
      column,
      durationMs,
      row: row.row,
    })),
  ).flat();
}

export function getDragAnimation(facing: PetFacing): PetAnimation {
  return facing === "left" ? "running-left" : "running-right";
}

export function animationLoops(animation: PetAnimation): boolean {
  return [
    "idle",
    "running-left",
    "running-right",
    "running",
    "waiting",
  ].includes(animation);
}
