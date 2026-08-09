import { createHash } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { nativeImage } from "electron";

import type { Timestamp } from "../../shared/contracts/primitives";
import type { ActivityAssetRecord } from "./activityRepository";

export class ActivityAssetStore {
  constructor(private readonly directory: string) {}

  async save(
    id: string,
    bytes: Buffer,
    createdAt: Timestamp,
  ): Promise<ActivityAssetRecord> {
    const image = nativeImage.createFromBuffer(bytes, { scaleFactor: 1 });
    if (image.isEmpty()) throw new Error("系统截图无法解码。");
    const png = image.toPNG();
    const size = image.getSize();
    const storageKey = `${id}.png`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, storageKey), png, { flag: "wx" });
    return {
      byteLength: png.byteLength,
      createdAt,
      height: size.height,
      id,
      mediaType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
      storageKey,
      width: size.width,
    };
  }

  resolve(record: ActivityAssetRecord): string {
    if (record.storageKey !== `${record.id}.png`) {
      throw new Error("Activity asset storage key is invalid");
    }
    return path.join(this.directory, record.storageKey);
  }

  async remove(storageKeys: readonly string[]): Promise<void> {
    await Promise.all(
      storageKeys.map((storageKey) =>
        unlink(path.join(this.directory, path.basename(storageKey))).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        ),
      ),
    );
  }

  async sweep(validStorageKeys: ReadonlySet<string>): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const orphans = entries.filter(
      (entry) => entry.endsWith(".png") && !validStorageKeys.has(entry),
    );
    await this.remove(orphans);
    return orphans.length;
  }
}
