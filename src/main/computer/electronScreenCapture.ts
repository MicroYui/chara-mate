import { desktopCapturer, screen } from "electron";

import type { ScreenCapture } from "./macosComputer";

export class ElectronScreenCapture implements ScreenCapture {
  async capturePrimaryDisplay(): Promise<Buffer> {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      thumbnailSize: {
        height: Math.round(display.size.height * display.scaleFactor),
        width: Math.round(display.size.width * display.scaleFactor),
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
    return source.thumbnail.toPNG();
  }
}
