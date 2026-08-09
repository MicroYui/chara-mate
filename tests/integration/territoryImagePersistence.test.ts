import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import type { TerritoryImageProvider } from "../../src/main/providers/azureImageProvider";
import { ProviderError } from "../../src/main/providers/providerError";
import { TerritoryAssetStore } from "../../src/main/territory/territoryAssetStore";
import { TerritoryCandidateStore } from "../../src/main/territory/territoryCandidateStore";
import { TerritoryError } from "../../src/main/territory/territoryError";
import { TerritoryImageService } from "../../src/main/territory/territoryImageService";
import { TerritoryRepository } from "../../src/main/territory/territoryRepository";
import { TerritoryService } from "../../src/main/territory/territoryService";
import type { EntityId } from "../../src/shared/contracts/primitives";
import type { IdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import { createSolidPng } from "../fixtures/png";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

class SequenceIds implements IdGenerator {
  constructor(private readonly values: EntityId[]) {}

  generate(): EntityId {
    const value = this.values.shift();
    if (!value) throw new Error("Missing test ID");
    return value;
  }
}

async function createFixture(provider: TerritoryImageProvider) {
  const root = await mkdtemp(path.join(os.tmpdir(), "territory-image-flow-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "charamate.sqlite");
  const database = openApplicationDatabase(databasePath);
  const repository = new TerritoryRepository(database);
  const clock = new FakeClock("2026-08-08T12:00:00.000Z");
  const assets = new TerritoryAssetStore(
    path.join(root, "territory", "assets"),
    {
      normalize(source, size) {
        return createSolidPng(size.width, size.height, [
          source[0] ?? 0,
          74,
          158,
          255,
        ]);
      },
    },
  );
  const candidates = new TerritoryCandidateStore(
    path.join(root, "territory", "candidates"),
    { removeBackground: (source) => source },
  );
  const territory = new TerritoryService(repository, assets, clock);
  territory.selectScene({ sceneId: "forest-cabin" });
  const images = new TerritoryImageService(
    repository,
    candidates,
    territory,
    { createImageProvider: vi.fn().mockResolvedValue(provider) },
    new SequenceIds([
      "82db6a6a-6194-445e-8a2a-28e44be222be",
      "83e96c3f-9474-49c4-aab4-77f257210d1f",
    ]),
    clock,
  );
  return {
    candidates,
    database,
    databasePath,
    images,
    repository,
    root,
    territory,
  };
}

describe("Territory image candidate persistence", () => {
  it("generates, edits, confirms and restores through the single asset path", async () => {
    const providerPng = createSolidPng(8, 8, [226, 30, 190, 255]);
    const generate = vi.fn().mockResolvedValue(providerPng);
    const edit = vi.fn().mockResolvedValue(providerPng);
    const fixture = await createFixture({ edit, generate });

    const generated = await fixture.images.generate({
      description: "留一盏灯，纪念完成项目的夜晚。",
      name: "长夜台灯",
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: "forest-cabin",
      structure: {
        depthAnchorPx: { x: 72, y: 120 },
        footprintTiles: { height: 2, width: 3 },
        surfaceSlots: [
          {
            anchorPx: { x: 72, y: 54 },
            id: "center",
            maxItemSizePx: { height: 32, width: 32 },
          },
        ],
        visualSizePx: { height: 120, width: 144 },
      },
      visualPrompt: "一盏小巧的黄铜工坊台灯",
    });
    const generatedCandidate = generated.snapshot.imageCandidates.find(
      ({ id }) => id === generated.candidateId,
    );
    expect(generatedCandidate).toMatchObject({
      operation: "generate",
      status: "ready",
      structure: {
        footprintTiles: { height: 2, width: 3 },
        surfaceSlots: [{ id: "center" }],
        visualSizePx: { height: 120, width: 144 },
      },
    });
    expect(generated.snapshot.collection).toHaveLength(3);
    expect(generate).toHaveBeenCalledWith(
      expect.stringContaining("#ff00ff"),
      undefined,
    );

    const edited = await fixture.images.edit({
      candidateId: generated.candidateId,
      instruction: "把灯罩改成琥珀玻璃",
    });
    expect(edit).toHaveBeenCalledWith(
      providerPng,
      expect.stringContaining("把灯罩改成琥珀玻璃"),
      undefined,
    );
    expect(
      edited.snapshot.imageCandidates.find(
        ({ id }) => id === edited.candidateId,
      ),
    ).toMatchObject({
      operation: "edit",
      sourceCandidateId: generated.candidateId,
      status: "ready",
      structure: generatedCandidate?.structure,
    });

    const confirmed = await fixture.images.confirm({
      candidateId: edited.candidateId,
    });
    const itemId = `generated.${edited.candidateId}`;
    const installedItem = confirmed.snapshot.collection.find(
      ({ id }) => id === itemId,
    );
    expect(installedItem?.manifest).toMatchObject({
      name: "长夜台灯",
      placement: { gridSize: { height: 2, width: 3 } },
      surfaceSlots: [{ id: "center", kind: "tabletop" }],
      visual: { sizePx: { height: 120, width: 144 } },
    });
    expect(
      confirmed.snapshot.imageCandidates.find(
        ({ id }) => id === edited.candidateId,
      ),
    ).toMatchObject({ acceptedItemId: itemId, status: "accepted" });
    const installed = await readFile(
      path.join(fixture.root, "territory", "assets", itemId, "sprite.png"),
    );
    expect(installed.readUInt32BE(16)).toBe(144);
    expect(installed.readUInt32BE(20)).toBe(120);

    fixture.database.close();
    const reopened = openApplicationDatabase(fixture.databasePath);
    const restoredRepository = new TerritoryRepository(reopened);
    expect(
      restoredRepository.getImageCandidate(edited.candidateId),
    ).toMatchObject({
      acceptedItemId: itemId,
      status: "accepted",
      structure: { visualSizePx: { height: 120, width: 144 } },
    });
    expect(restoredRepository.getItem(itemId)).toMatchObject({ id: itemId });
    reopened.close();
  });

  it("keeps a failed candidate and the scene intact, then retries it", async () => {
    const providerPng = createSolidPng(8, 8, [226, 30, 190, 255]);
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError(
          "PROVIDER.RATE_LIMITED",
          "Provider 暂时限制了请求，请稍后重试。",
          true,
        ),
      )
      .mockResolvedValueOnce(providerPng);
    const fixture = await createFixture({
      edit: vi.fn().mockResolvedValue(providerPng),
      generate,
    });
    const before = fixture.territory.getSnapshot().activeScene?.placements;

    const failed = await fixture.images.generate({
      description: "一枚安静的小纪念。",
      name: "微光摆件",
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: "forest-cabin",
      visualPrompt: "一枚发出微光的小摆件",
    });
    expect(
      failed.snapshot.imageCandidates.find(
        ({ id }) => id === failed.candidateId,
      ),
    ).toMatchObject({
      error: { code: "PROVIDER.RATE_LIMITED", retryable: true },
      status: "failed",
    });
    expect(failed.snapshot.activeScene?.placements).toEqual(before);

    const retried = await fixture.images.retry({
      candidateId: failed.candidateId,
    });
    expect(
      retried.snapshot.imageCandidates.find(
        ({ id }) => id === failed.candidateId,
      ),
    ).toMatchObject({ error: null, status: "ready" });
    expect(retried.snapshot.activeScene?.placements).toEqual(before);
    expect(generate).toHaveBeenCalledTimes(2);
    fixture.database.close();
  });

  it("keeps a ready candidate when confirmation fails and accepts it on retry", async () => {
    const providerPng = createSolidPng(8, 8, [226, 30, 190, 255]);
    const fixture = await createFixture({
      edit: vi.fn().mockResolvedValue(providerPng),
      generate: vi.fn().mockResolvedValue(providerPng),
    });
    const generated = await fixture.images.generate({
      description: "确认失败也不会丢失的候选。",
      name: "可恢复摆件",
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: "forest-cabin",
      visualPrompt: "一件小巧的蓝色像素摆件",
    });
    vi.spyOn(fixture.territory, "installGeneratedItem").mockRejectedValueOnce(
      new TerritoryError(
        "TERRITORY.STORAGE_FAILED",
        "暂时无法安装图片资产。",
        true,
      ),
    );

    await expect(
      fixture.images.confirm({ candidateId: generated.candidateId }),
    ).rejects.toThrow("暂时无法安装图片资产");
    expect(
      fixture.repository.getImageCandidate(generated.candidateId),
    ).toMatchObject({ acceptedItemId: null, status: "ready" });

    const confirmed = await fixture.images.confirm({
      candidateId: generated.candidateId,
    });
    expect(
      confirmed.snapshot.imageCandidates.find(
        ({ id }) => id === generated.candidateId,
      ),
    ).toMatchObject({
      acceptedItemId: `generated.${generated.candidateId}`,
      status: "accepted",
    });
    fixture.database.close();
  });

  it("turns interrupted generating rows into retryable failures on startup", async () => {
    const providerPng = createSolidPng(8, 8, [226, 30, 190, 255]);
    const fixture = await createFixture({
      edit: vi.fn().mockResolvedValue(providerPng),
      generate: vi.fn().mockResolvedValue(providerPng),
    });
    fixture.repository.createImageCandidate({
      acceptedItemId: null,
      createdAt: "2026-08-08T11:00:00.000Z",
      description: "等待恢复的候选。",
      editInstruction: null,
      error: null,
      id: "4be214aa-78df-4082-a8d6-451a0588960b",
      name: "中断候选",
      operation: "generate",
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: "forest-cabin",
      sourceCandidateId: null,
      status: "generating",
      structure: null,
      updatedAt: "2026-08-08T11:00:00.000Z",
      visualPrompt: "一件等待恢复的像素摆件",
    });

    expect(fixture.images.recoverInterruptedCandidates()).toBe(1);
    expect(
      fixture.repository.getImageCandidate(
        "4be214aa-78df-4082-a8d6-451a0588960b",
      ),
    ).toMatchObject({
      error: {
        code: "TERRITORY.GENERATION_INTERRUPTED",
        retryable: true,
      },
      status: "failed",
    });
    fixture.database.close();
  });
});
