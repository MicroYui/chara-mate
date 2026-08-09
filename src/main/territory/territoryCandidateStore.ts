import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { TERRITORY_CANDIDATE_FILE_NAME } from "../../shared/pure/territoryAsset";
import { TerritoryError } from "./territoryError";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface TerritoryCandidateImageProcessor {
  removeBackground(source: Buffer): Buffer | Promise<Buffer>;
}

export interface TerritoryCandidateImages {
  read(candidateId: string): Promise<Buffer>;
  resolve(candidateId: string): Promise<string>;
  save(candidateId: string, source: Buffer): Promise<void>;
}

function processingError(message: string) {
  return new TerritoryError("TERRITORY.IMAGE_PROCESSING_FAILED", message, true);
}

export class TerritoryCandidateStore implements TerritoryCandidateImages {
  constructor(
    private readonly candidatesDirectory: string,
    private readonly processor: TerritoryCandidateImageProcessor,
  ) {}

  private candidateDirectory(candidateId: string): string {
    return path.join(this.candidatesDirectory, candidateId);
  }

  private candidatePath(candidateId: string): string {
    return path.join(
      this.candidateDirectory(candidateId),
      TERRITORY_CANDIDATE_FILE_NAME,
    );
  }

  async save(candidateId: string, source: Buffer): Promise<void> {
    let processed: Buffer;
    try {
      processed = await this.processor.removeBackground(source);
    } catch {
      throw processingError("生成图片无法解码或去除背景，请重试。");
    }
    if (
      processed.byteLength < PNG_SIGNATURE.byteLength ||
      !processed.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
    ) {
      throw processingError("去背景结果不是有效的 PNG 图片。");
    }

    const directory = this.candidateDirectory(candidateId);
    const destination = this.candidatePath(candidateId);
    const staging = path.join(directory, `.preview-${randomUUID()}.png`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(staging, processed, { flag: "wx" });
      await rename(staging, destination);
    } catch {
      await rm(staging, { force: true });
      throw processingError("无法保存图片候选，请重试。");
    }
  }

  async read(candidateId: string): Promise<Buffer> {
    try {
      return await readFile(this.candidatePath(candidateId));
    } catch {
      throw processingError("无法读取待编辑的图片候选，请重新生成。");
    }
  }

  async resolve(candidateId: string): Promise<string> {
    try {
      const candidate = this.candidatePath(candidateId);
      const candidateStat = await stat(candidate);
      if (!candidateStat.isFile()) throw new Error("Candidate is not a file.");
      return candidate;
    } catch {
      throw processingError("无法读取图片候选，请重新生成。");
    }
  }
}
