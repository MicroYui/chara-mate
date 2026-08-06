import { describe, expect, it } from "vitest";

import { readSpriteMetadata } from "./spriteMetadata";

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

describe("pet spritesheet metadata", () => {
  it("reads v1 PNG dimensions without decoding image pixels", () => {
    expect(readSpriteMetadata(pngHeader(1536, 1872))).toEqual({
      format: "png",
      height: 1872,
      width: 1536,
    });
  });

  it("reads v2 extended WebP dimensions", () => {
    expect(readSpriteMetadata(webpVp8xHeader(1536, 2288))).toEqual({
      format: "webp",
      height: 2288,
      width: 1536,
    });
  });

  it("rejects data that is neither PNG nor WebP", () => {
    expect(() => readSpriteMetadata(Buffer.from("not-an-image"))).toThrow(
      /PNG|WebP/u,
    );
  });
});
