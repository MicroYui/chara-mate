import { describe, expect, it } from "vitest";

import type { PetStoredState } from "../../shared/contracts/pet";
import {
  captureCharacterPlacement,
  restoreCharacterBounds,
} from "./characterPlacement";

const state: PetStoredState = {
  activePetId: null,
  animationSpeed: 0.75,
  displayId: "secondary",
  facing: "right",
  height: 208,
  offsetX: 80,
  offsetY: 90,
  scale: 1,
  updatedAt: "2026-08-06T00:00:00.000Z",
  width: 192,
};

const displays = [
  {
    id: "primary",
    workArea: { height: 900, width: 1440, x: 0, y: 0 },
  },
  {
    id: "secondary",
    workArea: { height: 1080, width: 1920, x: -1920, y: -120 },
  },
] as const;

describe("Character window display-relative placement", () => {
  it("restores DIP offsets on the same display, including negative origins", () => {
    expect(restoreCharacterBounds(state, displays, "primary")).toEqual({
      height: 208,
      width: 192,
      x: -1840,
      y: -30,
    });
  });

  it("falls back to the primary display and clamps after a display is removed", () => {
    expect(
      restoreCharacterBounds(
        { ...state, offsetX: 5000, offsetY: -30 },
        [displays[0]],
        "primary",
      ),
    ).toEqual({
      height: 208,
      width: 192,
      x: 1248,
      y: 0,
    });
  });

  it("captures global bounds as a display ID plus work-area-relative DIP offsets", () => {
    expect(
      captureCharacterPlacement(
        { height: 260, width: 240, x: -1680, y: 40 },
        displays[1],
      ),
    ).toEqual({
      displayId: "secondary",
      height: 260,
      offsetX: 240,
      offsetY: 160,
      width: 240,
    });
  });
});
