import { describe, expect, it } from "vitest";

import { placeProactiveBubble } from "./proactiveBubblePlacement";

const workArea = { height: 900, width: 1440, x: 0, y: 25 };

describe("placeProactiveBubble", () => {
  it("uses the open space above a pet near the bottom", () => {
    const pet = { height: 135, width: 125, x: 1200, y: 750 };
    const placement = placeProactiveBubble(pet, workArea);

    expect(placement.side).toBe("above");
    expect(placement.bounds.y + placement.bounds.height).toBeLessThan(pet.y);
    expect(placement.bounds.x).toBeGreaterThanOrEqual(workArea.x + 8);
  });

  it("flips below a pet near the top without overlapping it", () => {
    const pet = { height: 135, width: 125, x: 640, y: 33 };
    const placement = placeProactiveBubble(pet, workArea);

    expect(placement.side).toBe("below");
    expect(placement.bounds.y).toBeGreaterThanOrEqual(pet.y + pet.height + 8);
  });

  it("clamps the wider bubble at a screen edge", () => {
    const pet = { height: 135, width: 125, x: 1, y: 700 };
    const placement = placeProactiveBubble(pet, workArea);

    expect(placement.bounds.x).toBe(8);
    expect(placement.bounds.width).toBe(360);
  });

  it("shrinks into the larger side when neither side fits at full height", () => {
    const compactWorkArea = { height: 300, width: 600, x: -600, y: 0 };
    const pet = { height: 120, width: 120, x: -360, y: 80 };
    const placement = placeProactiveBubble(pet, compactWorkArea);

    expect(placement.side).toBe("below");
    expect(placement.bounds.height).toBe(84);
    expect(placement.bounds.y).toBe(208);
    expect(placement.bounds.y + placement.bounds.height).toBeLessThanOrEqual(
      compactWorkArea.y + compactWorkArea.height - 8,
    );
  });
});
