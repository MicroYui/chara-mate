import { nativeImage } from "electron";

import { removeConnectedTerritoryWorldBackground } from "../../shared/pure/territoryWorldBackground";
import type { TerritoryWorldImageNormalizer } from "./territoryWorldAssetStore";

export class ElectronTerritoryWorldImageNormalizer implements TerritoryWorldImageNormalizer {
  normalize(
    source: Buffer,
    size: { readonly height: number; readonly width: number },
    options: { readonly removeBackground: boolean },
  ): Buffer {
    const decoded = nativeImage.createFromBuffer(source);
    if (decoded.isEmpty()) throw new Error("Image decode failed.");
    let normalized = decoded;
    if (options.removeBackground) {
      const decodedSize = decoded.getSize();
      const bitmap = removeConnectedTerritoryWorldBackground(
        decoded.toBitmap({ scaleFactor: 1 }),
        decodedSize.width,
        decodedSize.height,
      );
      normalized = nativeImage.createFromBitmap(bitmap, {
        height: decodedSize.height,
        scaleFactor: 1,
        width: decodedSize.width,
      });
      if (normalized.isEmpty())
        throw new Error("Image background removal failed.");
    }
    const resized = normalized.resize({
      height: size.height,
      quality: "best",
      width: size.width,
    });
    if (resized.isEmpty()) throw new Error("Image resize failed.");
    return resized.toPNG();
  }
}
