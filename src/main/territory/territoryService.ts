import type {
  TerritoryCollectItemRequest,
  TerritoryFacing,
  TerritoryInstallGeneratedItemInput,
  TerritoryMovePetRequest,
  TerritoryMoveResult,
  TerritoryPlaceItemRequest,
  TerritorySceneId,
  TerritorySelectSceneRequest,
  TerritorySnapshot,
} from "../../shared/contracts/territory";
import type { TerritoryItemManifestV1 } from "../../shared/contracts/territoryItemManifest";
import type { Clock } from "../../shared/pure/clock";
import {
  isTerritorySurfacePlacementValid,
  validateTerritoryItemManifestSemantics,
} from "../../shared/pure/territoryItemGeometry";
import {
  blockedMovementCells,
  findTerritoryPath,
  isGroundPlacementValid,
} from "../../shared/pure/territoryGrid";
import { TerritoryInstallGeneratedItemInputSchema } from "../../shared/schemas/territory";
import { parseSchema } from "../../shared/schemas/validation";
import { getTerritoryScene, listTerritorySceneSummaries } from "./catalog";
import { TerritoryError } from "./territoryError";
import type { TerritoryAssetStore } from "./territoryAssetStore";
import type {
  TerritoryRepository,
  TerritorySceneRecord,
} from "./territoryRepository";

function requireTransform(
  manifest: TerritoryItemManifestV1,
  request: TerritoryPlaceItemRequest,
): void {
  if (!manifest.transforms.rotations.includes(request.rotation)) {
    throw new TerritoryError(
      "TERRITORY.INVALID_PLACEMENT",
      "这个物件不支持当前旋转方向。",
      false,
    );
  }
  if (!manifest.transforms.flippable && request.flipped) {
    throw new TerritoryError(
      "TERRITORY.INVALID_PLACEMENT",
      "这个物件不能翻转。",
      false,
    );
  }
}

export class TerritoryService {
  constructor(
    private readonly repository: TerritoryRepository,
    private readonly assets: TerritoryAssetStore,
    private readonly clock: Clock,
  ) {}

  private requireActiveScene(sceneId: TerritorySceneId): TerritorySceneRecord {
    const active = this.repository.getActiveScene();
    if (!active || active.sceneId !== sceneId) {
      throw new TerritoryError(
        "TERRITORY.SCENE_NOT_ACTIVE",
        "请先打开这个领地场景。",
        false,
      );
    }
    return active;
  }

  getSnapshot(): TerritorySnapshot {
    const active = this.repository.getActiveScene();
    return {
      activeScene: active
        ? {
            definition: getTerritoryScene(active.sceneId).definition,
            pet: {
              facing: active.petFacing,
              x: active.petX,
              y: active.petY,
            },
            placements: this.repository.listSceneItems(active.sceneId),
          }
        : null,
      availableScenes: listTerritorySceneSummaries(),
      collection: this.repository.listCollectionItems(),
      imageCandidates: this.repository.listImageCandidates(),
    };
  }

  selectScene(request: TerritorySelectSceneRequest): TerritorySnapshot {
    this.repository.selectScene(
      getTerritoryScene(request.sceneId),
      this.clock.now(),
    );
    return this.getSnapshot();
  }

  async installGeneratedItem(
    input: TerritoryInstallGeneratedItemInput,
  ): Promise<TerritorySnapshot> {
    const parsed = parseSchema(TerritoryInstallGeneratedItemInputSchema, input);
    const issues = validateTerritoryItemManifestSemantics(parsed.manifest);
    if (issues.length > 0) {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        `物件清单不完整：${issues[0]?.message ?? "请检查物件定义。"}`,
        false,
      );
    }
    if (parsed.manifest.visual.source.kind !== "asset") {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        "生成物件的 manifest 必须引用图片 assetId。",
        false,
      );
    }

    const prepared = await this.assets.prepareInstall({
      assetId: parsed.manifest.visual.source.assetId,
      size: parsed.manifest.visual.sizePx,
      sourceImagePath: parsed.sourceImagePath,
    });
    try {
      this.repository.installGeneratedCollectionItem({
        asset: prepared.record,
        itemId: parsed.itemId,
        manifest: parsed.manifest,
        now: this.clock.now(),
      });
    } catch (error) {
      try {
        await this.assets.rollbackCreatedAsset(prepared);
      } catch {
        throw new TerritoryError(
          "TERRITORY.STORAGE_FAILED",
          "领地图片已生成，但安装失败且无法清理临时资产。",
          true,
        );
      }
      if (error instanceof TerritoryError) throw error;
      throw new TerritoryError(
        "TERRITORY.STORAGE_FAILED",
        "无法保存生成的领地物件。",
        true,
      );
    }
    return this.getSnapshot();
  }

  movePet(request: TerritoryMovePetRequest): TerritoryMoveResult {
    const active = this.requireActiveScene(request.sceneId);
    const scene = getTerritoryScene(active.sceneId).definition;
    if (
      request.x >= scene.width ||
      request.y >= scene.height ||
      request.from.x >= scene.width ||
      request.from.y >= scene.height
    ) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "点击位置不在场景内。",
        false,
      );
    }
    if (scene.walkableRows[request.from.y]?.[request.from.x] !== "1") {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "桌宠当前不在可行走区域。",
        false,
      );
    }

    const placements = this.repository.listSceneItems(active.sceneId);
    const path = findTerritoryPath(
      scene,
      request.from,
      { x: request.x, y: request.y },
      blockedMovementCells(placements),
    );
    const destination = path?.at(-1);
    if (!path || !destination) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "桌宠暂时走不到那里。",
        false,
      );
    }

    let facing: TerritoryFacing = active.petFacing;
    for (let index = path.length - 1; index > 0; index -= 1) {
      const current = path[index];
      const previous = path[index - 1];
      if (current && previous && current.x !== previous.x) {
        facing = current.x < previous.x ? "left" : "right";
        break;
      }
    }
    if (path.length === 1 && request.x !== destination.x) {
      facing = request.x < destination.x ? "left" : "right";
    }

    this.repository.savePet(
      active.sceneId,
      destination.x,
      destination.y,
      facing,
      this.clock.now(),
    );
    return { path, snapshot: this.getSnapshot() };
  }

  placeItem(request: TerritoryPlaceItemRequest): TerritorySnapshot {
    const active = this.requireActiveScene(request.target.sceneId);
    const record = this.repository.getItem(request.itemId);
    if (!record) {
      throw new TerritoryError(
        "TERRITORY.ITEM_NOT_FOUND",
        "找不到这个领地物件。",
        false,
      );
    }
    if (
      record.target.kind !== "collection" &&
      record.target.sceneId !== active.sceneId
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_PLACEMENT",
        "请先把物件收回收藏库，再放到另一个场景。",
        false,
      );
    }

    requireTransform(record.manifest, request);
    const item = record;
    const placements = this.repository.listSceneItems(active.sceneId);
    if (request.target.kind === "ground") {
      if (
        record.manifest.placement.mode !== "ground" ||
        !isGroundPlacementValid(
          getTerritoryScene(active.sceneId).definition,
          item,
          request.target.x,
          request.target.y,
          request.rotation,
          request.flipped,
          placements,
          { x: active.petX, y: active.petY },
        )
      ) {
        throw new TerritoryError(
          "TERRITORY.INVALID_PLACEMENT",
          "这里放不下这个物件，请选择高亮网格。",
          false,
        );
      }
    } else {
      if (!isTerritorySurfacePlacementValid(item, request.target, placements)) {
        throw new TerritoryError(
          "TERRITORY.INVALID_PLACEMENT",
          "这个桌面插槽不能放置当前小物。",
          false,
        );
      }
    }

    this.repository.placeItem({
      flipped: request.flipped,
      itemId: record.id,
      now: this.clock.now(),
      rotation: request.rotation,
      target: request.target,
    });
    return this.getSnapshot();
  }

  collectItem(request: TerritoryCollectItemRequest): TerritorySnapshot {
    this.requireActiveScene(request.sceneId);
    const item = this.repository.getItem(request.itemId);
    if (!item) {
      throw new TerritoryError(
        "TERRITORY.ITEM_NOT_FOUND",
        "找不到这个领地物件。",
        false,
      );
    }
    if (
      item.target.kind === "collection" ||
      item.target.sceneId !== request.sceneId
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_PLACEMENT",
        "这个物件已经在收藏库里。",
        false,
      );
    }
    this.repository.collectItem(item.id, this.clock.now());
    return this.getSnapshot();
  }
}
