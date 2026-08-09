import type { JsonValue } from "../../shared/contracts/primitives";

export interface PreparedImageInput {
  readonly byteLength: number;
  readonly content: JsonValue;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly width: number;
}

export interface ImageInputProvider {
  prepare(source: string): Promise<PreparedImageInput>;
}

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

export class ElectronImageInputProvider implements ImageInputProvider {
  constructor(
    private readonly resolveSource: (source: string) => Promise<string>,
  ) {}

  async prepare(source: string): Promise<PreparedImageInput> {
    const resolved = await this.resolveSource(source);
    const { nativeImage } = await import("electron");
    const decoded = nativeImage.createFromPath(resolved);
    if (decoded.isEmpty()) {
      throw new ImageInputError("无法解码这张图片，请改用 PNG 或 JPEG。");
    }
    const { height, width } = decoded.getSize(1);
    if (width < 1 || height < 1) {
      throw new ImageInputError("图片尺寸无效。");
    }

    // Provider detail=auto owns token-sensitive scaling. Main normalizes the
    // decoded representation to a single scale-factor PNG without inventing a
    // product-wide pixel cap that may conflict with the selected model.
    const encoded = decoded.toPNG({ scaleFactor: 1 });
    if (encoded.byteLength === 0) {
      throw new ImageInputError("图片编码失败。");
    }
    return {
      byteLength: encoded.byteLength,
      content: {
        detail: "auto",
        image_url: `data:image/png;base64,${encoded.toString("base64")}`,
        type: "input_image",
      },
      height,
      mediaType: "image/png",
      width,
    };
  }
}
