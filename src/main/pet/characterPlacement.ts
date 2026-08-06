import type { PetStoredState } from "../../shared/contracts/pet";

export interface CharacterBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface CharacterDisplay {
  readonly id: string | number;
  readonly workArea: CharacterBounds;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function restoreCharacterBounds(
  state: PetStoredState,
  displays: readonly CharacterDisplay[],
  primaryDisplayId: string | number,
): CharacterBounds {
  const display =
    displays.find(({ id }) => String(id) === state.displayId) ??
    displays.find(({ id }) => String(id) === String(primaryDisplayId)) ??
    displays[0];

  if (!display) {
    return {
      height: state.height,
      width: state.width,
      x: state.offsetX,
      y: state.offsetY,
    };
  }

  const width = Math.min(state.width, display.workArea.width);
  const height = Math.min(state.height, display.workArea.height);
  return {
    height,
    width,
    x:
      display.workArea.x +
      clamp(state.offsetX, 0, Math.max(0, display.workArea.width - width)),
    y:
      display.workArea.y +
      clamp(state.offsetY, 0, Math.max(0, display.workArea.height - height)),
  };
}

export function captureCharacterPlacement(
  bounds: CharacterBounds,
  display: CharacterDisplay,
): Pick<
  PetStoredState,
  "displayId" | "height" | "offsetX" | "offsetY" | "width"
> {
  return {
    displayId: String(display.id),
    height: bounds.height,
    offsetX: bounds.x - display.workArea.x,
    offsetY: bounds.y - display.workArea.y,
    width: bounds.width,
  };
}
