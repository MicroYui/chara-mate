import { PetError } from "./petError";

export interface SpriteMetadata {
  readonly format: "png" | "webp";
  readonly height: number;
  readonly width: number;
}

function invalidSprite(): never {
  throw new PetError(
    "PET.INVALID_FORMAT",
    "spritesheet 必须是有效的 PNG 或 WebP 文件。",
    false,
  );
}

function readUint24LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

function readWebPSize(buffer: Buffer): SpriteMetadata {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const kind = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + length > buffer.length) invalidSprite();

    if (kind === "VP8X" && length >= 10) {
      return {
        format: "webp",
        height: readUint24LE(buffer, dataOffset + 7) + 1,
        width: readUint24LE(buffer, dataOffset + 4) + 1,
      };
    }

    if (kind === "VP8L" && length >= 5) {
      if (buffer[dataOffset] !== 0x2f) invalidSprite();
      const b1 = buffer[dataOffset + 1] ?? 0;
      const b2 = buffer[dataOffset + 2] ?? 0;
      const b3 = buffer[dataOffset + 3] ?? 0;
      const b4 = buffer[dataOffset + 4] ?? 0;
      return {
        format: "webp",
        height: ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1,
        width: (b1 | ((b2 & 0x3f) << 8)) + 1,
      };
    }

    if (kind === "VP8 " && length >= 10) {
      if (
        buffer[dataOffset + 3] !== 0x9d ||
        buffer[dataOffset + 4] !== 0x01 ||
        buffer[dataOffset + 5] !== 0x2a
      ) {
        invalidSprite();
      }
      return {
        format: "webp",
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
      };
    }

    offset = dataOffset + length + (length % 2);
  }

  return invalidSprite();
}

export function readSpriteMetadata(buffer: Buffer): SpriteMetadata {
  if (
    buffer.length >= 24 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    return {
      format: "png",
      height: buffer.readUInt32BE(20),
      width: buffer.readUInt32BE(16),
    };
  }

  if (
    buffer.length >= 20 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return readWebPSize(buffer);
  }

  return invalidSprite();
}
