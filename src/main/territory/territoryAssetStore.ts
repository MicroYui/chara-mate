import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerritoryPositiveSize } from "../../shared/contracts/territoryItemManifest";
import { TERRITORY_ASSET_FILE_NAME } from "../../shared/pure/territoryAsset";
import { TerritoryError } from "./territoryError";
import type { TerritoryAssetRecord } from "./territoryRepository";

const ASSET_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface TerritoryImageNormalizer {
  normalize(
    source: Buffer,
    size: TerritoryPositiveSize,
  ): Buffer | Promise<Buffer>;
}

export interface PreparedTerritoryAsset {
  readonly created: boolean;
  readonly record: Omit<TerritoryAssetRecord, "createdAt">;
}

function invalidAsset(message: string): TerritoryError {
  return new TerritoryError("TERRITORY.INVALID_ASSET", message, false);
}

function readPngSize(bytes: Buffer): TerritoryPositiveSize {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw invalidAsset("图片归一化后不是有效的 PNG 文件。");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw invalidAsset("图片尺寸必须大于零。");
  }
  return { height, width };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export class TerritoryAssetStore {
  constructor(
    private readonly assetsDirectory: string,
    private readonly normalizer: TerritoryImageNormalizer,
  ) {}

  private assetDirectory(assetId: string): string {
    return path.join(this.assetsDirectory, assetId);
  }

  private assetPath(assetId: string): string {
    return path.join(this.assetDirectory(assetId), TERRITORY_ASSET_FILE_NAME);
  }

  async prepareInstall(input: {
    readonly assetId: string;
    readonly size: TerritoryPositiveSize;
    readonly sourceImagePath: string;
  }): Promise<PreparedTerritoryAsset> {
    if (!ASSET_ID_PATTERN.test(input.assetId)) {
      throw invalidAsset("图片资产 ID 格式无效。");
    }
    if (!path.isAbsolute(input.sourceImagePath)) {
      throw invalidAsset("图片资产必须使用绝对文件路径。");
    }

    let source: Buffer;
    try {
      const sourceStat = await stat(input.sourceImagePath);
      if (!sourceStat.isFile()) throw invalidAsset("图片资产必须指向文件。");
      source = await readFile(input.sourceImagePath);
    } catch (error) {
      if (error instanceof TerritoryError) throw error;
      throw invalidAsset("无法读取图片资产文件。");
    }

    let bytes: Buffer;
    try {
      bytes = await this.normalizer.normalize(source, input.size);
    } catch (error) {
      if (error instanceof TerritoryError) throw error;
      throw invalidAsset("图片资产无法解码或归一化。");
    }
    const actualSize = readPngSize(bytes);
    if (
      actualSize.width !== input.size.width ||
      actualSize.height !== input.size.height
    ) {
      throw invalidAsset("图片归一化结果与 manifest 的 sizePx 不一致。");
    }

    const digest = sha256(bytes);
    const storageKey = `${input.assetId}/${TERRITORY_ASSET_FILE_NAME}`;
    const record = {
      assetId: input.assetId,
      byteLength: bytes.byteLength,
      height: actualSize.height,
      mediaType: "image/png" as const,
      sha256: digest,
      storageKey,
      width: actualSize.width,
    };
    const destination = this.assetPath(input.assetId);
    try {
      const existing = await readFile(destination);
      if (sha256(existing) !== digest || !existing.equals(bytes)) {
        throw new TerritoryError(
          "TERRITORY.ASSET_CONFLICT",
          `图片资产 ${input.assetId} 已存在且内容不同。`,
          false,
        );
      }
      return { created: false, record };
    } catch (error) {
      if (error instanceof TerritoryError) throw error;
      if (!isMissing(error)) {
        throw new TerritoryError(
          "TERRITORY.STORAGE_FAILED",
          "无法读取已保存的领地图片资产。",
          true,
        );
      }
    }

    await mkdir(this.assetsDirectory, { recursive: true });
    const staging = path.join(
      this.assetsDirectory,
      `.install-${input.assetId}-${randomUUID()}`,
    );
    await mkdir(staging);
    try {
      await writeFile(path.join(staging, TERRITORY_ASSET_FILE_NAME), bytes, {
        flag: "wx",
      });
      await rename(staging, this.assetDirectory(input.assetId));
      return { created: true, record };
    } catch {
      await rm(staging, { force: true, recursive: true });
      try {
        const existing = await readFile(destination);
        if (sha256(existing) === digest && existing.equals(bytes)) {
          return { created: false, record };
        }
      } catch {
        // Report the failed install rather than this race-resolution read.
      }
      throw new TerritoryError(
        "TERRITORY.STORAGE_FAILED",
        "无法保存领地图片资产。",
        true,
      );
    }
  }

  async rollbackCreatedAsset(prepared: PreparedTerritoryAsset): Promise<void> {
    if (!prepared.created) return;
    await rm(this.assetDirectory(prepared.record.assetId), {
      force: true,
      recursive: true,
    });
  }

  async resolveAssetPath(record: TerritoryAssetRecord): Promise<string> {
    const expectedStorageKey = `${record.assetId}/${TERRITORY_ASSET_FILE_NAME}`;
    if (
      !ASSET_ID_PATTERN.test(record.assetId) ||
      record.storageKey !== expectedStorageKey
    ) {
      throw new Error("Territory asset storage key mismatch.");
    }
    const candidate = this.assetPath(record.assetId);
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      throw new Error("Territory asset path is not a file.");
    }
    return candidate;
  }
}
