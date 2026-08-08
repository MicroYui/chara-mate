import path from "node:path";

import type { PetDescriptor } from "../../shared/contracts/pet";
import type { AppLogger } from "../observability/logger";
import type { PetLibraryRepository } from "./petLibraryRepository";

export const BUNDLED_PET_IDS = ["columbinya", "linnea"] as const;

interface BundledPetRuntimePaths {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}

export function bundledPetsDirectory({
  appPath,
  isPackaged,
  resourcesPath,
}: BundledPetRuntimePaths): string {
  return isPackaged
    ? path.join(resourcesPath, "default-pets")
    : path.join(appPath, "resources", "default-pets");
}

export async function installBundledPets(
  library: Pick<PetLibraryRepository, "ensureInstalledFrom">,
  sourceRoot: string,
  logger: Pick<AppLogger, "warn">,
): Promise<PetDescriptor[]> {
  const installed: PetDescriptor[] = [];
  for (const petId of BUNDLED_PET_IDS) {
    try {
      installed.push(
        await library.ensureInstalledFrom(path.join(sourceRoot, petId)),
      );
    } catch {
      logger.warn("BUNDLED_PET_INSTALL_FAILED", { petId });
    }
  }
  return installed;
}
