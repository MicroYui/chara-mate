import { describe, expect, it } from "vitest";

import { calculateDragMovement } from "./dragMovement";

describe("Character drag movement", () => {
  it("keeps absolute placement anchored to drag start but faces by the latest step", () => {
    expect(
      calculateDragMovement(
        { x: 100, y: 200 },
        { screenX: 50, screenY: 60 },
        { screenX: 120, screenY: 80 },
        { screenX: 110, screenY: 90 },
      ),
    ).toEqual({
      deltaX: 60,
      deltaY: 30,
      nextX: 160,
      nextY: 230,
      stepDeltaX: -10,
    });
  });

  it("rejects transient non-finite pointer coordinates", () => {
    expect(
      calculateDragMovement(
        { x: 100, y: 200 },
        { screenX: 50, screenY: 60 },
        { screenX: 50, screenY: 60 },
        { screenX: Number.NaN, screenY: 90 },
      ),
    ).toBeNull();
    expect(
      calculateDragMovement(
        { x: 100, y: 200 },
        { screenX: 50, screenY: 60 },
        { screenX: 50, screenY: 60 },
        { screenX: 80, screenY: Number.POSITIVE_INFINITY },
      ),
    ).toBeNull();
  });
});
