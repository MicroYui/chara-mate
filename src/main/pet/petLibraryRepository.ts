import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  CodexPetManifest,
  PetDescriptor,
  PetManifest,
} from "../../shared/contracts/pet";
import { CodexPetManifestSchema } from "../../shared/schemas/pet";
import { parseSchema } from "../../shared/schemas/validation";
import { PetError } from "./petError";
import { readSpriteMetadata } from "./spriteMetadata";

interface InstalledPet {
  readonly descriptor: PetDescriptor;
  readonly directory: string;
  readonly manifest: PetManifest;
  readonly spritePath: string;
  readonly spriteFormat: "png" | "webp";
}

function pathIsInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeManifest(manifest: CodexPetManifest): PetManifest {
  return {
    ...manifest,
    spriteVersionNumber: manifest.spriteVersionNumber ?? 1,
  };
}

function expectedDimensions(version: PetManifest["spriteVersionNumber"]) {
  return {
    height: version === 2 ? 2288 : 1872,
    width: 1536,
  };
}

async function copyOptionalPreview(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  for (const fileName of ["preview.webp", "preview.png"]) {
    const candidate = path.join(sourceDirectory, fileName);
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile()) {
        await copyFile(candidate, path.join(destinationDirectory, fileName));
        return;
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
}

export class PetLibraryRepository {
  constructor(private readonly petsDirectory: string) {}

  private async readInstalledPet(directory: string): Promise<InstalledPet> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(path.join(directory, "pet.json"), "utf8"),
      );
    } catch {
      throw new PetError(
        "PET.INVALID_FORMAT",
        "pet.json 不存在或不是有效 JSON。",
        false,
      );
    }

    let manifest: PetManifest;
    try {
      manifest = normalizeManifest(parseSchema(CodexPetManifestSchema, parsed));
    } catch {
      throw new PetError(
        "PET.INVALID_FORMAT",
        "pet.json 不符合 Codex 桌宠格式。",
        false,
      );
    }

    const sourceDirectory = await realpath(directory);
    const unresolvedSpritePath = path.resolve(
      sourceDirectory,
      manifest.spritesheetPath,
    );
    let spritePath: string;
    try {
      spritePath = await realpath(unresolvedSpritePath);
    } catch {
      throw new PetError(
        "PET.INVALID_FORMAT",
        "pet.json 指向的 spritesheet 不存在。",
        false,
      );
    }
    if (!pathIsInside(sourceDirectory, spritePath)) {
      throw new PetError(
        "PET.INVALID_FORMAT",
        "spritesheetPath 必须位于桌宠目录内。",
        false,
      );
    }
    const spriteStat = await stat(spritePath);
    if (!spriteStat.isFile()) {
      throw new PetError(
        "PET.INVALID_FORMAT",
        "spritesheetPath 必须指向文件。",
        false,
      );
    }

    const metadata = readSpriteMetadata(await readFile(spritePath));
    const expected = expectedDimensions(manifest.spriteVersionNumber);
    if (
      metadata.width !== expected.width ||
      metadata.height !== expected.height
    ) {
      throw new PetError(
        "PET.INVALID_FORMAT",
        `v${String(manifest.spriteVersionNumber)} spritesheet 应为 ${String(expected.width)}×${String(expected.height)}，实际为 ${String(metadata.width)}×${String(metadata.height)}。`,
        false,
      );
    }

    return {
      descriptor: {
        description: manifest.description,
        displayName: manifest.displayName,
        id: manifest.id,
        spriteHeight: metadata.height,
        spriteUrl: `chara-mate-pet://asset/${manifest.id}/spritesheet.${metadata.format}`,
        spriteVersionNumber: manifest.spriteVersionNumber,
        spriteWidth: metadata.width,
      },
      directory: sourceDirectory,
      manifest,
      spritePath,
      spriteFormat: metadata.format,
    };
  }

  private async listInstalledPets(): Promise<InstalledPet[]> {
    await mkdir(this.petsDirectory, { recursive: true });
    const entries = await readdir(this.petsDirectory, { withFileTypes: true });
    const installed: InstalledPet[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        installed.push(
          await this.readInstalledPet(
            path.join(this.petsDirectory, entry.name),
          ),
        );
      } catch (error) {
        if (!(error instanceof PetError)) throw error;
      }
    }
    return installed.sort((left, right) =>
      left.descriptor.displayName.localeCompare(right.descriptor.displayName),
    );
  }

  async list(): Promise<PetDescriptor[]> {
    return (await this.listInstalledPets()).map(({ descriptor }) => descriptor);
  }

  async importFrom(sourceDirectory: string): Promise<PetDescriptor> {
    const source = await this.readInstalledPet(sourceDirectory);
    await mkdir(this.petsDirectory, { recursive: true });
    const existing = await this.listInstalledPets();
    if (
      existing.some(({ descriptor }) => descriptor.id === source.descriptor.id)
    ) {
      throw new PetError(
        "PET.ALREADY_EXISTS",
        `桌宠“${source.descriptor.displayName}”已经导入。`,
        false,
      );
    }

    const destination = path.join(this.petsDirectory, source.manifest.id);
    try {
      await stat(destination);
      throw new PetError(
        "PET.ALREADY_EXISTS",
        `桌宠目录 ${source.manifest.id} 已存在。`,
        false,
      );
    } catch (error) {
      if (error instanceof PetError) throw error;
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    const staging = path.join(
      this.petsDirectory,
      `.import-${source.manifest.id}-${randomUUID()}`,
    );
    await mkdir(staging);
    try {
      const spriteFileName = `spritesheet.${source.spriteFormat}`;
      await copyFile(source.spritePath, path.join(staging, spriteFileName));
      await copyOptionalPreview(source.directory, staging);
      const normalizedManifest: PetManifest = {
        ...source.manifest,
        spritesheetPath: spriteFileName,
      };
      await writeFile(
        path.join(staging, "pet.json"),
        `${JSON.stringify(normalizedManifest, null, 2)}\n`,
        "utf8",
      );
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      if (error instanceof PetError) throw error;
      throw new PetError(
        "PET.IMPORT_FAILED",
        "无法把桌宠复制到 CharaMate 数据目录。",
        false,
      );
    }

    return (await this.readInstalledPet(destination)).descriptor;
  }

  async resolveSpritePath(petId: string): Promise<string> {
    const pet = (await this.listInstalledPets()).find(
      ({ descriptor }) => descriptor.id === petId,
    );
    if (!pet) {
      throw new PetError("PET.NOT_FOUND", "找不到该桌宠。", false);
    }
    return pet.spritePath;
  }
}
