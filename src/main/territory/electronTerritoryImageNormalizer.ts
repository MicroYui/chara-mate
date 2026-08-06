import { nativeImage } from "electron";

import type { TerritoryPositiveSize } from "../../shared/contracts/territoryItemManifest";
import type { TerritoryImageNormalizer } from "./territoryAssetStore";

export class ElectronTerritoryImageNormalizer implements TerritoryImageNormalizer {
  normalize(source: Buffer, size: TerritoryPositiveSize): Buffer {
    const decoded = nativeImage.createFromBuffer(source);
    if (decoded.isEmpty()) throw new Error("Image decode failed.");
    const resized = decoded.resize({
      height: size.height,
      quality: "best",
      width: size.width,
    });
    if (resized.isEmpty()) throw new Error("Image resize failed.");
    return resized.toPNG();
  }
}
