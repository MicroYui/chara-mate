import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSolidPng } from "../../../tests/fixtures/png";
import {
  TerritoryAssetStore,
  type TerritoryImageNormalizer,
} from "./territoryAssetStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const normalizer: TerritoryImageNormalizer = {
  normalize(source, size) {
    const red = source[0] ?? 0;
    return createSolidPng(size.width, size.height, [red, 80, 170, 255]);
  },
};

describe("TerritoryAssetStore", () => {
  it("normalizes, hashes, resolves, and idempotently reuses an owned PNG", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "territory-assets-"));
    temporaryDirectories.push(root);
    const sourcePath = path.join(root, "source.bin");
    await writeFile(sourcePath, Buffer.from([212]));
    const store = new TerritoryAssetStore(
      path.join(root, "assets"),
      normalizer,
    );

    const first = await store.prepareInstall({
      assetId: "asset.generated-cup.v1",
      size: { height: 28, width: 24 },
      sourceImagePath: sourcePath,
    });
    expect(first).toMatchObject({
      created: true,
      record: {
        assetId: "asset.generated-cup.v1",
        height: 28,
        mediaType: "image/png",
        storageKey: "asset.generated-cup.v1/sprite.png",
        width: 24,
      },
    });
    expect(first.record.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const resolved = await store.resolveAssetPath({
      ...first.record,
      createdAt: "2026-08-06T08:00:00.000Z",
    });
    expect(await readFile(resolved)).toEqual(
      createSolidPng(24, 28, [212, 80, 170, 255]),
    );

    await expect(
      store.prepareInstall({
        assetId: "asset.generated-cup.v1",
        size: { height: 28, width: 24 },
        sourceImagePath: sourcePath,
      }),
    ).resolves.toEqual({ ...first, created: false });
  });

  it("rejects conflicting bytes and removes only a newly created asset on rollback", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "territory-asset-conflict-"),
    );
    temporaryDirectories.push(root);
    const sourcePath = path.join(root, "source.bin");
    const store = new TerritoryAssetStore(
      path.join(root, "assets"),
      normalizer,
    );
    await writeFile(sourcePath, Buffer.from([12]));
    const installed = await store.prepareInstall({
      assetId: "asset.same-id.v1",
      size: { height: 16, width: 16 },
      sourceImagePath: sourcePath,
    });

    await writeFile(sourcePath, Buffer.from([99]));
    await expect(
      store.prepareInstall({
        assetId: "asset.same-id.v1",
        size: { height: 16, width: 16 },
        sourceImagePath: sourcePath,
      }),
    ).rejects.toMatchObject({ code: "TERRITORY.ASSET_CONFLICT" });

    await store.rollbackCreatedAsset(installed);
    await expect(
      store.resolveAssetPath({
        ...installed.record,
        createdAt: "2026-08-06T08:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("rejects relative paths and normalizer output with the wrong dimensions", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "territory-asset-invalid-"),
    );
    temporaryDirectories.push(root);
    const sourcePath = path.join(root, "source.bin");
    await writeFile(sourcePath, Buffer.from([1]));
    const store = new TerritoryAssetStore(path.join(root, "assets"), {
      normalize() {
        return createSolidPng(1, 1);
      },
    });

    await expect(
      store.prepareInstall({
        assetId: "asset.invalid.v1",
        size: { height: 8, width: 8 },
        sourceImagePath: "relative.png",
      }),
    ).rejects.toMatchObject({ code: "TERRITORY.INVALID_ASSET" });
    await expect(
      store.prepareInstall({
        assetId: "asset.invalid.v1",
        size: { height: 8, width: 8 },
        sourceImagePath: sourcePath,
      }),
    ).rejects.toMatchObject({ code: "TERRITORY.INVALID_ASSET" });
  });
});
