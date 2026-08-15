import { webcrypto } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Timestamp } from "../../shared/contracts/primitives";
import type { CapturedScreen } from "../computer/macosComputer";
import type { ActivityAssetRecord } from "./activityRepository";

export class ActivityAssetStore {
  constructor(private readonly directory: string) {}

  async save(
    id: string,
    capture: CapturedScreen,
    createdAt: Timestamp,
  ): Promise<ActivityAssetRecord> {
    if (capture.width <= 0 || capture.height <= 0) {
      throw new Error("系统截图尺寸无效。");
    }
    const storageKey = `${id}.png`;
    await mkdir(this.directory, { recursive: true });
    const digestTask = webcrypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(capture.bytes),
    );
    const [digest] = await Promise.all([
      digestTask,
      writeFile(path.join(this.directory, storageKey), capture.bytes, {
        flag: "wx",
      }),
    ]);
    return {
      byteLength: capture.bytes.byteLength,
      createdAt,
      height: capture.height,
      id,
      mediaType: capture.mediaType,
      sha256: Buffer.from(digest).toString("hex"),
      storageKey,
      width: capture.width,
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
