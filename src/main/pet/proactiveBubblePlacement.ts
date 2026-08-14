import type { CharacterBounds } from "./characterPlacement";

const BUBBLE_GAP = 8;
const BUBBLE_HEIGHT = 168;
const BUBBLE_WIDTH = 360;
const WORK_AREA_MARGIN = 8;

export interface ProactiveBubblePlacement {
  readonly bounds: CharacterBounds;
  readonly side: "above" | "below";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function placeProactiveBubble(
  petBounds: CharacterBounds,
  workArea: CharacterBounds,
): ProactiveBubblePlacement {
  const workAreaRight = workArea.x + workArea.width;
  const workAreaBottom = workArea.y + workArea.height;
  const petBottom = petBounds.y + petBounds.height;
  const availableAbove = Math.max(
    0,
    petBounds.y - (workArea.y + WORK_AREA_MARGIN) - BUBBLE_GAP,
  );
  const availableBelow = Math.max(
    0,
    workAreaBottom - WORK_AREA_MARGIN - petBottom - BUBBLE_GAP,
  );
  const side =
    availableAbove >= BUBBLE_HEIGHT || availableAbove >= availableBelow
      ? "above"
      : "below";
  const availableHeight = side === "above" ? availableAbove : availableBelow;
  const height = Math.max(1, Math.min(BUBBLE_HEIGHT, availableHeight));
  const width = Math.max(
    1,
    Math.min(BUBBLE_WIDTH, workArea.width - WORK_AREA_MARGIN * 2),
  );
  const petCenterX = petBounds.x + petBounds.width / 2;
  const x = Math.round(
    clamp(
      petCenterX - width / 2,
      workArea.x + WORK_AREA_MARGIN,
      workAreaRight - WORK_AREA_MARGIN - width,
    ),
  );
  const y =
    side === "above"
      ? petBounds.y - BUBBLE_GAP - height
      : petBottom + BUBBLE_GAP;
  return {
    bounds: { height, width, x, y },
    side,
  };
}
