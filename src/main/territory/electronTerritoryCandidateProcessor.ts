import { nativeImage } from "electron";

import { removeConnectedImageBackground } from "./territoryBackgroundRemoval";
import type { TerritoryCandidateImageProcessor } from "./territoryCandidateStore";

export class ElectronTerritoryCandidateProcessor implements TerritoryCandidateImageProcessor {
  removeBackground(source: Buffer): Buffer {
    const image = nativeImage.createFromBuffer(source);
    if (image.isEmpty()) throw new Error("Image decode failed.");
    const size = image.getSize();
    const bitmap = image.toBitmap({ scaleFactor: 1 });
    const transparent = removeConnectedImageBackground(
      bitmap,
      size.width,
      size.height,
    );
    const processed = nativeImage.createFromBitmap(transparent, {
      height: size.height,
      scaleFactor: 1,
      width: size.width,
    });
    if (processed.isEmpty()) throw new Error("Image processing failed.");
    return processed.toPNG();
  }
}
