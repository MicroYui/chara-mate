import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import type { TerritoryImageProvider } from "../../src/main/providers/azureImageProvider";
import { TerritoryAssetStore } from "../../src/main/territory/territoryAssetStore";
import {
  getTerritoryScene,
  TERRITORY_SCENE_ITEM_CAPACITY,
} from "../../src/main/territory/catalog";
import { TerritoryCandidateStore } from "../../src/main/territory/territoryCandidateStore";
import { TerritoryImageService } from "../../src/main/territory/territoryImageService";
import { TerritoryMemoryService } from "../../src/main/territory/territoryMemoryService";
import { TerritoryRepository } from "../../src/main/territory/territoryRepository";
import { TerritoryService } from "../../src/main/territory/territoryService";
import type { ActivityDigest } from "../../src/shared/contracts/activity";
import type { MemoryDetail } from "../../src/shared/contracts/memory";
import type { EntityId } from "../../src/shared/contracts/primitives";
import type { TerritoryItemManifestV1 } from "../../src/shared/contracts/territoryItemManifest";
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

const memoryId = "17bd6914-d46b-44ee-9776-c0aa07ae91cd";
const memoryRevisionId = "a640015a-bb31-4b8a-bf5e-bc95ba3546e7";
const refreshedMemoryRevisionId = "77d735b9-a7a2-4efc-bac0-c735ad7466fe";
const itemCandidateId = "1db5fa43-f4d8-48b5-895d-c490a87fedc3";
const duplicateCandidateId = "999cd9dc-0813-4e89-a6c1-e18477d44cef";
const refreshedCandidateId = "cc0c65fd-f6a1-4ddc-9234-b7824e881ab6";
const postMaterializedCandidateId = "1156dbd2-d996-4451-bd5e-b191fd98cfa2";
const activityCandidateId = "da9dd247-6b2a-4da0-8b92-87dd68ecad7a";
const imageCandidateV1 = "9739c926-183c-4442-9b19-e99dc51610ba";
const imageCandidateV2 = "29505622-dd8a-48af-bb16-9507209bb25e";
const digestId = "46d33e51-8c90-4931-9ed3-3d3808faac8a";

const memoryDetail: MemoryDetail = {
  memory: {
    confidence: 0.95,
    createdAt: "2026-08-05T08:00:00.000Z",
    currentRevisionId: memoryRevisionId,
    id: memoryId,
    importance: 0.9,
    status: "active",
    type: "project",
    updatedAt: "2026-08-05T08:00:00.000Z",
  },
  revisions: [
    {
      content: "一起完成了第一版 CharaMate。",
      createdAt: "2026-08-05T08:00:00.000Z",
      id: memoryRevisionId,
      memoryId,
      reason: "用户明确确认",
      sourceIds: [],
      sourceType: "user_edit",
    },
  ],
  sources: [],
  usages: [],
};

const refreshedMemoryDetail: MemoryDetail = {
  ...memoryDetail,
  memory: {
    ...memoryDetail.memory,
    currentRevisionId: refreshedMemoryRevisionId,
    updatedAt: "2026-08-08T10:00:30.000Z",
  },
  revisions: [
    {
      content: "一起完成了第一版 CharaMate，并开始打磨领地。",
      createdAt: "2026-08-08T10:00:30.000Z",
      id: refreshedMemoryRevisionId,
      memoryId,
      reason: "用户补充",
      sourceIds: [],
      sourceType: "user_edit",
    },
    ...memoryDetail.revisions,
  ],
};

const activityDigest: ActivityDigest = {
  candidateIds: [],
  createdAt: "2026-08-08T08:00:00.000Z",
  evidenceDays: 3,
  episodeIds: ["ca925a36-1668-4f1b-beb8-51f8031bdd54"],
  id: digestId,
  kind: "weekly",
  periodEnd: "2026-08-08T00:00:00.000Z",
  periodStart: "2026-08-01T00:00:00.000Z",
  summary: "连续三天都在完善 CharaMate 的核心体验。",
  title: "稳定推进的一周",
};

function createAssetStore(root: string): TerritoryAssetStore {
  return new TerritoryAssetStore(path.join(root, "territory", "assets"), {
    normalize(source, size) {
      return createSolidPng(size.width, size.height, [
        source[0] ?? 0,
        74,
        158,
        255,
      ]);
    },
  });
}

describe("Territory Memory persistence", () => {
  it("keeps one sourced item, immutable image versions and navigation evidence across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "territory-memory-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "charamate.sqlite");
    const database = openApplicationDatabase(databasePath);
    const clock = new FakeClock("2026-08-08T10:00:00.000Z");
    const repository = new TerritoryRepository(database);
    const territory = new TerritoryService(
      repository,
      createAssetStore(root),
      clock,
    );
    territory.selectScene({ sceneId: "forest-cabin" });
    const memoryGet = vi.fn().mockReturnValue(memoryDetail);
    const sourceService = new TerritoryMemoryService(
      repository,
      territory,
      { get: memoryGet },
      { getDigest: vi.fn().mockReturnValue(activityDigest) },
      new SequenceIds([
        itemCandidateId,
        duplicateCandidateId,
        refreshedCandidateId,
        postMaterializedCandidateId,
        activityCandidateId,
      ]),
      clock,
    );
    const sourceResult = sourceService.createSourceCandidate({
      source: { kind: "memory", memoryId },
    });
    const duplicateResult = sourceService.createSourceCandidate({
      source: { kind: "memory", memoryId },
    });
    expect(duplicateResult.candidateId).toBe(sourceResult.candidateId);

    const providerPng = createSolidPng(8, 8, [226, 30, 190, 255]);
    const provider: TerritoryImageProvider = {
      edit: vi.fn().mockResolvedValue(providerPng),
      generate: vi.fn().mockResolvedValue(providerPng),
    };
    const images = new TerritoryImageService(
      repository,
      new TerritoryCandidateStore(path.join(root, "territory", "candidates"), {
        removeBackground: (source) => source,
      }),
      territory,
      { createImageProvider: vi.fn().mockResolvedValue(provider) },
      new SequenceIds([imageCandidateV1, imageCandidateV2]),
      clock,
    );
    const semanticCandidate = sourceResult.snapshot.itemCandidates.find(
      ({ id }) => id === sourceResult.candidateId,
    );
    if (!semanticCandidate) throw new Error("Missing semantic candidate");

    const first = await images.generate({
      description: semanticCandidate.description,
      itemCandidateId: semanticCandidate.id,
      name: semanticCandidate.name,
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: semanticCandidate.suggestedSceneId,
      structure: {
        attachmentAnchorPx: { x: 48, y: 96 },
        placement: "surface",
      },
      visualPrompt: semanticCandidate.visualPrompt,
    });
    memoryGet.mockReturnValue(refreshedMemoryDetail);
    sourceService.createSourceCandidate({
      source: { kind: "memory", memoryId },
    });
    const firstConfirmed = await images.confirm({
      candidateId: first.candidateId,
    });
    expect(
      firstConfirmed.snapshot.collection.find(
        ({ id }) => id === `memory.${itemCandidateId}`,
      )?.sources,
    ).toMatchObject([
      {
        label: "一起完成了第一版 CharaMate。",
        revisionId: memoryRevisionId,
      },
    ]);
    const materializedDuplicate = sourceService.createSourceCandidate({
      source: { kind: "memory", memoryId },
    });
    expect(materializedDuplicate).toMatchObject({
      candidateId: itemCandidateId,
      snapshot: {
        itemCandidates: [
          {
            id: itemCandidateId,
            itemId: `memory.${itemCandidateId}`,
            status: "materialized",
          },
        ],
      },
    });
    clock.advance(1_000);
    const second = await images.generate({
      description: "把共同完成的第一版留成一盏更明亮的灯。",
      itemCandidateId: semanticCandidate.id,
      name: semanticCandidate.name,
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: semanticCandidate.suggestedSceneId,
      visualPrompt: "一盏更明亮的像素风纪念灯",
    });
    const confirmed = await images.confirm({ candidateId: second.candidateId });

    const itemId = `memory.${itemCandidateId}`;
    const item = confirmed.snapshot.collection.find(({ id }) => id === itemId);
    expect(item).toMatchObject({
      id: itemId,
      manifest: { revision: 2 },
      sources: [
        {
          id: memoryId,
          kind: "memory",
          label: "一起完成了第一版 CharaMate，并开始打磨领地。",
          revisionId: refreshedMemoryRevisionId,
        },
      ],
    });
    expect(
      item?.versions.map(({ active, revision }) => ({ active, revision })),
    ).toEqual([
      { active: true, revision: 2 },
      { active: false, revision: 1 },
    ]);
    expect(
      item?.versions.map(({ manifest }) => manifest.placement.mode),
    ).toEqual(["surface", "surface"]);
    expect(
      confirmed.snapshot.imageCandidates.find(
        ({ id }) => id === imageCandidateV2,
      )?.structure,
    ).toMatchObject({
      attachmentAnchorPx: { x: 48, y: 96 },
      placement: "surface",
    });
    expect(
      confirmed.snapshot.itemCandidates.find(
        ({ id }) => id === itemCandidateId,
      ),
    ).toMatchObject({ itemId, status: "materialized" });

    territory.selectItemVersion({ itemId, revision: 1 });
    territory.setItemPinned({ itemId, pinned: true });
    const activityResult = sourceService.createSourceCandidate({
      source: { digestId, kind: "activity_digest" },
    });
    expect(
      activityResult.snapshot.itemCandidates.find(
        ({ id }) => id === activityCandidateId,
      ),
    ).toMatchObject({
      sources: [{ id: digestId, kind: "activity_digest", revisionId: null }],
      status: "pending",
    });

    database.close();
    const reopened = openApplicationDatabase(databasePath);
    const restored = new TerritoryRepository(reopened).getItem(itemId);
    expect(restored).toMatchObject({
      manifest: { revision: 1 },
      pinned: true,
      sources: [{ id: memoryId, revisionId: refreshedMemoryRevisionId }],
    });
    expect(restored?.versions).toHaveLength(2);
    reopened.close();
  });

  it("returns the oldest unpinned item to collection and preserves every item definition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "territory-capacity-"));
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(
      path.join(root, "charamate.sqlite"),
    );
    const repository = new TerritoryRepository(database);
    const now = "2026-08-08T12:00:00.000Z";
    repository.selectScene(getTerritoryScene("forest-cabin"), now);
    for (const item of repository.listSceneItems("forest-cabin")) {
      repository.setItemPinned(item.id, true, now);
    }

    const install = (index: number) => {
      const itemId = `generated.capacity-${String(index)}`;
      const baseManifest: TerritoryItemManifestV1 = {
        definitionId: itemId,
        description: `容量物件 ${String(index)}`,
        name: `容量物件 ${String(index)}`,
        placement: {
          collisionCells: [{ x: 0, y: 0 }],
          depthAnchorPx: { x: 24, y: 48 },
          gridSize: { height: 1, width: 1 },
          mode: "ground",
          occupancyCells: [{ x: 0, y: 0 }],
          plane: "object",
        },
        revision: 1,
        schemaVersion: 1,
        surfaceSlots:
          index === 0
            ? [
                {
                  anchorPx: { x: 24, y: 20 },
                  id: "top",
                  kind: "tabletop",
                  maxItemSizePx: { height: 48, width: 48 },
                },
              ]
            : [],
        transforms: { flippable: false, rotations: [0] },
        visual: {
          sizePx: { height: 48, width: 48 },
          source: { assetId: itemId, kind: "asset" },
        },
      };
      const manifest: TerritoryItemManifestV1 =
        index === 1
          ? {
              ...baseManifest,
              placement: {
                allowedSurfaceKinds: ["tabletop"],
                attachmentAnchorPx: { x: 24, y: 48 },
                mode: "surface",
              },
              surfaceSlots: [],
            }
          : baseManifest;
      repository.installGeneratedCollectionItem({
        asset: {
          assetId: itemId,
          byteLength: 1,
          height: 48,
          mediaType: "image/png",
          sha256: "a".repeat(64),
          storageKey: `${itemId}/sprite.png`,
          width: 48,
        },
        itemId,
        manifest,
        now: new Date(Date.parse(now) + index + 1).toISOString(),
      });
      return itemId;
    };

    const generatedCount = TERRITORY_SCENE_ITEM_CAPACITY - 4;
    for (let index = 0; index < generatedCount; index += 1) {
      const itemId = install(index);
      repository.placeItem({
        capacity: TERRITORY_SCENE_ITEM_CAPACITY,
        flipped: false,
        itemId,
        now: new Date(Date.parse(now) + index + 100).toISOString(),
        rotation: 0,
        target:
          index === 1
            ? {
                kind: "surface",
                sceneId: "forest-cabin",
                slotId: "top",
                supportItemId: "generated.capacity-0",
              }
            : { kind: "ground", sceneId: "forest-cabin", x: 1, y: 8 },
      });
    }
    repository.setItemPinned(
      "generated.capacity-1",
      true,
      "2026-08-08T12:00:00.500Z",
    );
    expect(repository.listSceneItems("forest-cabin")).toHaveLength(
      TERRITORY_SCENE_ITEM_CAPACITY,
    );

    const overflowId = install(generatedCount);
    repository.placeItem({
      capacity: TERRITORY_SCENE_ITEM_CAPACITY,
      flipped: false,
      itemId: overflowId,
      now: "2026-08-08T12:01:00.000Z",
      rotation: 0,
      target: { kind: "ground", sceneId: "forest-cabin", x: 2, y: 8 },
    });
    expect(repository.getItem("generated.capacity-2")).toMatchObject({
      target: { kind: "collection" },
      versions: [{ revision: 1 }],
    });
    expect(repository.getItem("generated.capacity-0")).toMatchObject({
      target: { kind: "ground" },
    });
    expect(repository.getItem("generated.capacity-1")).toMatchObject({
      pinned: true,
      target: { kind: "surface", supportItemId: "generated.capacity-0" },
    });
    expect(repository.getAsset("generated.capacity-2")).toBeDefined();
    expect(repository.listSceneItems("forest-cabin")).toHaveLength(
      TERRITORY_SCENE_ITEM_CAPACITY,
    );

    for (const item of repository.listSceneItems("forest-cabin")) {
      repository.setItemPinned(item.id, true, "2026-08-08T12:02:00.000Z");
    }
    const blockedId = install(generatedCount + 1);
    expect(() =>
      repository.placeItem({
        capacity: TERRITORY_SCENE_ITEM_CAPACITY,
        flipped: false,
        itemId: blockedId,
        now: "2026-08-08T12:03:00.000Z",
        rotation: 0,
        target: { kind: "ground", sceneId: "forest-cabin", x: 3, y: 8 },
      }),
    ).toThrow("场景已满");
    expect(repository.getItem(blockedId)).toMatchObject({
      target: { kind: "collection" },
    });
    database.close();
  });
});
