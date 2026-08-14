import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerritoryAsset } from "../../shared/contracts/territoryWorld";
import type { Timestamp } from "../../shared/contracts/primitives";
import { TERRITORY_ASSET_FILE_NAME } from "../../shared/pure/territoryAsset";
import { TerritoryError } from "./territoryError";

const ASSET_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface TerritoryWorldImageNormalizer {
  normalize(
    source: Buffer,
    size: { readonly height: number; readonly width: number },
    options: { readonly removeBackground: boolean },
  ): Buffer | Promise<Buffer>;
}

export interface StoredTerritoryWorldAsset {
  readonly asset: TerritoryAsset;
  readonly storageKey: string;
}

export interface PreparedTerritoryWorldAsset extends StoredTerritoryWorldAsset {
  readonly created: boolean;
}

function storageError(message: string, retryable: boolean): TerritoryError {
  return new TerritoryError("TERRITORY.STORAGE_FAILED", message, retryable);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPngSize(bytes: Buffer): {
  readonly height: number;
  readonly width: number;
} {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new TerritoryError(
      "TERRITORY.INVALID_ASSET",
      "生成结果不是有效的 PNG 图片。",
      false,
    );
  }
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export class TerritoryWorldAssetStore {
  constructor(
    private readonly directory: string,
    private readonly normalizer: TerritoryWorldImageNormalizer,
  ) {}

  private assetDirectory(assetId: string): string {
    return path.join(this.directory, assetId);
  }

  private assetPath(assetId: string): string {
    return path.join(this.assetDirectory(assetId), TERRITORY_ASSET_FILE_NAME);
  }

  async prepareInstall(input: {
    readonly assetId: string;
    readonly createdAt: Timestamp;
    readonly origin: "edited" | "generated";
    readonly removeBackground: boolean;
    readonly size: { readonly height: number; readonly width: number };
    readonly source: Buffer;
  }): Promise<PreparedTerritoryWorldAsset> {
    if (!ASSET_ID_PATTERN.test(input.assetId)) {
      throw new TerritoryError(
        "TERRITORY.INVALID_ASSET",
        "领地图片资产 ID 格式无效。",
        false,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await this.normalizer.normalize(input.source, input.size, {
        removeBackground: input.removeBackground,
      });
    } catch (error) {
      if (error instanceof TerritoryError) throw error;
      throw new TerritoryError(
        "TERRITORY.IMAGE_PROCESSING_FAILED",
        "生成图片无法解码或归一化。",
        true,
      );
    }
    const actual = readPngSize(bytes);
    if (
      actual.width !== input.size.width ||
      actual.height !== input.size.height
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_ASSET",
        "归一化图片尺寸与 Definition 不一致。",
        false,
      );
    }
    const storageKey = `${input.assetId}/${TERRITORY_ASSET_FILE_NAME}`;
    const prepared: PreparedTerritoryWorldAsset = {
      asset: {
        byteLength: bytes.byteLength,
        createdAt: input.createdAt,
        height: actual.height,
        id: input.assetId,
        mediaType: "image/png",
        origin: input.origin,
        sha256: sha256(bytes),
        width: actual.width,
      },
      created: false,
      storageKey,
    };
    const destination = this.assetPath(input.assetId);
    try {
      const existing = await readFile(destination);
      if (!existing.equals(bytes)) {
        throw new TerritoryError(
          "TERRITORY.ASSET_CONFLICT",
          `图片资产 ${input.assetId} 已存在且内容不同。`,
          false,
        );
      }
      return prepared;
    } catch (error) {
      if (error instanceof TerritoryError) throw error;
      if (!isMissing(error)) {
        throw storageError("无法读取已保存的 World 图片资产。", true);
      }
    }

    await mkdir(this.directory, { recursive: true });
    const staging = path.join(
      this.directory,
      `.install-${input.assetId}-${randomUUID()}`,
    );
    await mkdir(staging);
    try {
      await writeFile(path.join(staging, TERRITORY_ASSET_FILE_NAME), bytes, {
        flag: "wx",
      });
      await rename(staging, this.assetDirectory(input.assetId));
      return { ...prepared, created: true };
    } catch {
      await rm(staging, { force: true, recursive: true });
      try {
        const existing = await readFile(destination);
        if (existing.equals(bytes)) return prepared;
      } catch {
        // Preserve the original install failure.
      }
      throw storageError("无法保存 World 图片资产。", true);
    }
  }

  async rollback(prepared: PreparedTerritoryWorldAsset): Promise<void> {
    if (!prepared.created) return;
    await rm(this.assetDirectory(prepared.asset.id), {
      force: true,
      recursive: true,
    });
  }

  async remove(assetId: string): Promise<void> {
    if (!ASSET_ID_PATTERN.test(assetId)) return;
    await rm(this.assetDirectory(assetId), { force: true, recursive: true });
  }

  async resolve(record: StoredTerritoryWorldAsset): Promise<string> {
    const expected = `${record.asset.id}/${TERRITORY_ASSET_FILE_NAME}`;
    if (
      !ASSET_ID_PATTERN.test(record.asset.id) ||
      record.storageKey !== expected
    ) {
      throw new Error("Territory World asset storage key mismatch.");
    }
    const candidate = this.assetPath(record.asset.id);
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile())
      throw new Error("Territory World asset is missing.");
    return candidate;
  }

  async read(record: StoredTerritoryWorldAsset): Promise<Buffer> {
    return readFile(await this.resolve(record));
  }
}
