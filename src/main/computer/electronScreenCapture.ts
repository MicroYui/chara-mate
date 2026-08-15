import { desktopCapturer, screen } from "electron";

import type {
  CapturedScreen,
  ScreenCapture,
  ScreenCaptureOptions,
} from "./macosComputer";

function pngDimensions(bytes: Buffer): { height: number; width: number } {
  if (bytes.byteLength < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("系统截图没有返回有效的 PNG。");
  }
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
}

export class ElectronScreenCapture implements ScreenCapture {
  async capturePrimaryDisplay(
    options: ScreenCaptureOptions = {},
  ): Promise<CapturedScreen> {
    const display = screen.getPrimaryDisplay();
    const scale = options.resolution === "logical" ? 1 : display.scaleFactor;
    const sources = await desktopCapturer.getSources({
      thumbnailSize: {
        height: Math.round(display.size.height * scale),
        width: Math.round(display.size.width * scale),
      },
      types: ["screen"],
    });
    const source =
      sources.find(
        ({ display_id: displayId }) => displayId === String(display.id),
      ) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("系统没有返回可用的屏幕画面。");
    }
    const bytes =
      options.resolution === "logical"
        ? source.thumbnail.toPNG({ scaleFactor: 1 })
        : source.thumbnail.toPNG();
    return {
      bytes,
      ...pngDimensions(bytes),
      mediaType: "image/png",
    };
  }
}
