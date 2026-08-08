import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { bundledPetsDirectory, installBundledPets } from "./bundledPets";

describe("bundled pets", () => {
  it("resolves source assets from the app in development and resources when packaged", () => {
    expect(
      bundledPetsDirectory({
        appPath: "/workspace/chara-mate",
        isPackaged: false,
        resourcesPath: "/application/resources",
      }),
    ).toBe(path.join("/workspace/chara-mate", "resources", "default-pets"));
    expect(
      bundledPetsDirectory({
        appPath: "/application/resources/app.asar",
        isPackaged: true,
        resourcesPath: "/application/resources",
      }),
    ).toBe(path.join("/application/resources", "default-pets"));
  });

  it("installs both known assets independently so one failure does not hide the other", async () => {
    const ensureInstalledFrom = vi.fn((source: string) => {
      const id = path.basename(source);
      if (id === "linnea") {
        return Promise.reject(new Error("missing test asset"));
      }
      return Promise.resolve({
        description: "bundled",
        displayName: "Columbinya",
        id,
        spriteHeight: 2288,
        spriteUrl: `chara-mate-pet://asset/${id}/spritesheet.webp`,
        spriteVersionNumber: 2 as const,
        spriteWidth: 1536,
      });
    });
    const logger = { warn: vi.fn() };

    await expect(
      installBundledPets(
        { ensureInstalledFrom },
        "/application/resources/default-pets",
        logger,
      ),
    ).resolves.toMatchObject([{ id: "columbinya" }]);
    expect(ensureInstalledFrom).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("BUNDLED_PET_INSTALL_FAILED", {
      petId: "linnea",
    });
  });
});
