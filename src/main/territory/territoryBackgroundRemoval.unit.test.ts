import { describe, expect, it } from "vitest";

import { removeConnectedImageBackground } from "./territoryBackgroundRemoval";

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

describe("connected Territory image background removal", () => {
  it("clears a mildly varied border background while preserving the object", () => {
    const source = bitmap(5, 5, [252, 4, 249, 255]);
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        setPixel(source, 5, x, y, [42, 101, 172, 255]);
      }
    }
    setPixel(source, 5, 0, 2, [238, 16, 246, 255]);

    const result = removeConnectedImageBackground(source, 5, 5);

    expect(alpha(result, 5, 0, 0)).toBe(0);
    expect(alpha(result, 5, 0, 2)).toBe(0);
    expect(alpha(result, 5, 2, 2)).toBe(255);
    expect(alpha(source, 5, 0, 0)).toBe(255);
  });

  it("does not punch out a background-colored detail enclosed by the object", () => {
    const source = bitmap(5, 5, [250, 2, 250, 255]);
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        setPixel(source, 5, x, y, [38, 64, 91, 255]);
      }
    }
    setPixel(source, 5, 2, 2, [250, 2, 250, 255]);

    const result = removeConnectedImageBackground(source, 5, 5);

    expect(alpha(result, 5, 2, 2)).toBe(255);
  });

  it("rejects a bitmap whose dimensions do not match its bytes", () => {
    expect(() => removeConnectedImageBackground(Buffer.alloc(4), 2, 2)).toThrow(
      "Unexpected native bitmap dimensions",
    );
  });
});
