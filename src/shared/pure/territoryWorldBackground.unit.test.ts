import { describe, expect, it } from "vitest";

import { removeConnectedTerritoryWorldBackground } from "./territoryWorldBackground";

function bitmap(width: number, height: number, color: readonly number[]) {
  const result = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    result.set(color, index * 4);
  }
  return result;
}

function setPixel(
  target: Buffer,
  width: number,
  x: number,
  y: number,
  color: readonly number[],
) {
  target.set(color, (y * width + x) * 4);
}

function alpha(target: Buffer, width: number, x: number, y: number) {
  return target[(y * width + x) * 4 + 3];
}

describe("Territory World key background removal", () => {
  it("clears a mildly varied border while preserving the object", () => {
    const source = bitmap(5, 5, [252, 4, 249, 255]);
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        setPixel(source, 5, x, y, [42, 101, 172, 255]);
      }
    }
    setPixel(source, 5, 0, 2, [238, 16, 246, 255]);

    const result = removeConnectedTerritoryWorldBackground(source, 5, 5);

    expect(alpha(result, 5, 0, 0)).toBe(0);
    expect(alpha(result, 5, 0, 2)).toBe(0);
    expect([...result.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(alpha(result, 5, 2, 2)).toBe(255);
    expect(alpha(source, 5, 0, 0)).toBe(255);
  });

  it("clears key-colored background enclosed by the object", () => {
    const source = bitmap(5, 5, [250, 2, 250, 255]);
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        setPixel(source, 5, x, y, [38, 64, 91, 255]);
      }
    }
    setPixel(source, 5, 2, 2, [250, 2, 250, 255]);

    const result = removeConnectedTerritoryWorldBackground(source, 5, 5);

    expect(alpha(result, 5, 2, 2)).toBe(0);
  });

  it("keeps an enclosed berry-colored object detail", () => {
    const source = bitmap(5, 5, [250, 2, 250, 255]);
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        setPixel(source, 5, x, y, [38, 64, 91, 255]);
      }
    }
    setPixel(source, 5, 2, 2, [190, 20, 170, 255]);

    const result = removeConnectedTerritoryWorldBackground(source, 5, 5);

    expect(alpha(result, 5, 2, 2)).toBe(255);
  });

  it("rejects mismatched bitmap dimensions", () => {
    expect(() =>
      removeConnectedTerritoryWorldBackground(Buffer.alloc(4), 2, 2),
    ).toThrow("Unexpected native bitmap dimensions");
  });
});
