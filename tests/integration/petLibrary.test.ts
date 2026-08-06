import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { PetLibraryRepository } from "../../src/main/pet/petLibraryRepository";
import { PetService } from "../../src/main/pet/petService";
import { PetStateRepository } from "../../src/main/pet/petStateRepository";
import { FakeClock } from "../fixtures/fakeClock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function makeSourcePet(
  root: string,
  {
    folderName,
    id,
    version,
  }: { folderName: string; id: string; version: 1 | 2 },
): Promise<string> {
  const directory = path.join(root, folderName);
  await mkdir(directory, { recursive: true });
  const manifest = {
    description: `${id} test pet`,
    displayName: id === "linnea" ? "Linnea" : "Columbinya",
    id,
    ...(version === 2 ? { spriteVersionNumber: 2 } : {}),
    spritesheetPath: "atlas.png",
  };
  await writeFile(
    path.join(directory, "pet.json"),
    JSON.stringify(manifest),
    "utf8",
  );
  await writeFile(
    path.join(directory, "atlas.png"),
    pngHeader(1536, version === 2 ? 2288 : 1872),
  );
  return directory;
}

describe("Codex pet import and owned persistence", () => {
  it("imports v1/v2 by manifest ID, copies assets, and restores selection/scale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-pets-"));
    temporaryDirectories.push(root);
    const sources = path.join(root, "codex-pets");
    const ownedPets = path.join(root, "user-data", "pets");
    const linnea = await makeSourcePet(sources, {
      folderName: "linnea-2",
      id: "linnea",
      version: 1,
    });
    const columbinya = await makeSourcePet(sources, {
      folderName: "columbinya-2",
      id: "columbinya",
      version: 2,
    });
    const database = openApplicationDatabase(
      path.join(root, "user-data", "charamate.sqlite"),
    );
    const repository = new PetLibraryRepository(ownedPets);
    const service = new PetService(
      repository,
      new PetStateRepository(database),
      new FakeClock("2026-08-06T08:00:00.000Z"),
    );
    await service.initialize();

    await expect(service.importFrom(linnea)).resolves.toMatchObject({
      id: "linnea",
      spriteHeight: 1872,
      spriteVersionNumber: 1,
    });
    await expect(service.importFrom(columbinya)).resolves.toMatchObject({
      id: "columbinya",
      spriteHeight: 2288,
      spriteVersionNumber: 2,
    });
    await expect(service.setScale(0.3)).resolves.toMatchObject({
      activePetId: "columbinya",
      scale: 0.3,
    });
    await expect(service.setAnimationSpeed(0.1)).resolves.toMatchObject({
      animationSpeed: 0.1,
    });
    await expect(service.select("linnea")).resolves.toMatchObject({
      activePetId: "linnea",
    });
    service.setFacing("left");

    expect(
      JSON.parse(
        await readFile(path.join(ownedPets, "linnea", "pet.json"), "utf8"),
      ),
    ).toMatchObject({
      id: "linnea",
      spriteVersionNumber: 1,
      spritesheetPath: "spritesheet.png",
    });
    expect(
      JSON.parse(
        await readFile(path.join(ownedPets, "columbinya", "pet.json"), "utf8"),
      ),
    ).toMatchObject({
      id: "columbinya",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.png",
    });
    await rm(sources, { force: true, recursive: true });
    await expect(repository.list()).resolves.toHaveLength(2);

    const stateBeforeClose = new PetStateRepository(database).get();
    expect(stateBeforeClose).toMatchObject({
      activePetId: "linnea",
      animationSpeed: 0.1,
      facing: "left",
      height: 62,
      scale: 0.3,
      width: 58,
    });
    database.close();

    const reopened = openApplicationDatabase(
      path.join(root, "user-data", "charamate.sqlite"),
    );
    const restoredService = new PetService(
      repository,
      new PetStateRepository(reopened),
      new FakeClock("2026-08-06T08:01:00.000Z"),
    );
    await restoredService.initialize();
    await expect(restoredService.getCharacterSnapshot()).resolves.toMatchObject(
      {
        activePet: { id: "linnea", spriteVersionNumber: 1 },
        animationSpeed: 0.1,
        facing: "left",
        scale: 0.3,
      },
    );
    reopened.close();
  });

  it("rejects duplicate IDs, wrong atlas dimensions, and escaping paths", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-invalid-pets-"),
    );
    temporaryDirectories.push(root);
    const sources = path.join(root, "sources");
    const repository = new PetLibraryRepository(path.join(root, "owned"));
    const valid = await makeSourcePet(sources, {
      folderName: "valid-folder-name-does-not-match-id",
      id: "linnea",
      version: 1,
    });
    await repository.importFrom(valid);
    await expect(repository.importFrom(valid)).rejects.toMatchObject({
      code: "PET.ALREADY_EXISTS",
    });

    const wrongSize = await makeSourcePet(sources, {
      folderName: "wrong-size",
      id: "wrong-size",
      version: 2,
    });
    await writeFile(path.join(wrongSize, "atlas.png"), pngHeader(1536, 1872));
    await expect(repository.importFrom(wrongSize)).rejects.toMatchObject({
      code: "PET.INVALID_FORMAT",
    });

    const escaping = path.join(sources, "escaping");
    await mkdir(escaping);
    await writeFile(path.join(sources, "outside.png"), pngHeader(1536, 1872));
    await writeFile(
      path.join(escaping, "pet.json"),
      JSON.stringify({
        description: "escape",
        displayName: "Escape",
        id: "escape",
        spritesheetPath: "../outside.png",
      }),
      "utf8",
    );
    await expect(repository.importFrom(escaping)).rejects.toMatchObject({
      code: "PET.INVALID_FORMAT",
    });
  });
});
