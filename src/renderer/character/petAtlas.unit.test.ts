import { describe, expect, it } from "vitest";

import {
  getDragAnimation,
  getPetAtlasFrames,
  normalizeLookDirection,
} from "./petAtlas";

describe("Codex pet atlas projection", () => {
  it("uses the documented standard rows and per-frame timing", () => {
    expect(getPetAtlasFrames("idle", 1)).toEqual([
      { column: 0, durationMs: 280, row: 0 },
      { column: 1, durationMs: 110, row: 0 },
      { column: 2, durationMs: 110, row: 0 },
      { column: 3, durationMs: 140, row: 0 },
      { column: 4, durationMs: 140, row: 0 },
      { column: 5, durationMs: 320, row: 0 },
    ]);
    expect(getPetAtlasFrames("review", 2).at(-1)).toEqual({
      column: 5,
      durationMs: 280,
      row: 8,
    });
    expect(getDragAnimation("left")).toBe("running-left");
    expect(getDragAnimation("right")).toBe("running-right");
  });

  it("maps all 16 v2 look directions across rows 9 and 10", () => {
    expect(normalizeLookDirection(0)).toBe(0);
    expect(normalizeLookDirection(337.5)).toBe(15);
    expect(normalizeLookDirection(-22.5)).toBe(15);
    expect(getPetAtlasFrames("look", 2, 0)).toEqual([
      { column: 0, durationMs: 280, row: 9 },
    ]);
    expect(getPetAtlasFrames("look", 2, 180)).toEqual([
      { column: 0, durationMs: 280, row: 10 },
    ]);
    expect(getPetAtlasFrames("look", 2, 337.5)).toEqual([
      { column: 7, durationMs: 280, row: 10 },
    ]);
  });

  it("falls back from look to idle for v1 atlases", () => {
    const hoverFrames = getPetAtlasFrames("look", 1, 180);
    const idleFrames = getPetAtlasFrames("idle", 1);
    expect(hoverFrames).toHaveLength(idleFrames.length * 3);
    expect(hoverFrames).toEqual([...idleFrames, ...idleFrames, ...idleFrames]);
  });
});
