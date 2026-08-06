import type {
  TerritoryCollectItemRequest,
  TerritoryFacing,
  TerritoryItem,
  TerritoryMovePetRequest,
  TerritoryMoveResult,
  TerritoryPlaceItemRequest,
  TerritorySceneId,
  TerritorySelectSceneRequest,
  TerritorySnapshot,
} from "../../shared/contracts/territory";
import type { Clock } from "../../shared/pure/clock";
import {
  describeTerritoryItem,
  getTerritoryScene,
  listTerritorySceneSummaries,
  type TerritoryCatalogItem,
  TERRITORY_ITEMS,
} from "./catalog";
import {
  blockedMovementCells,
  findTerritoryPath,
  isPlacementValid,
} from "../../shared/pure/territoryGrid";
import { TerritoryError } from "./territoryError";
import type {
  TerritoryItemRecord,
  TerritoryRepository,
  TerritorySceneRecord,
} from "./territoryRepository";

function mapItem(record: TerritoryItemRecord): TerritoryItem {
  return describeTerritoryItem({
    catalogId: record.catalogId,
    flipped: record.flipped,
    id: record.id,
    layer: record.layer,
    location: record.location,
    pinned: record.pinned,
    placedAt: record.placedAt,
    rotation: record.rotation,
    sceneId: record.sceneId,
    updatedAt: record.updatedAt,
    x: record.x,
    y: record.y,
  });
}

function requireTransform(
  definition: TerritoryCatalogItem,
  request: TerritoryPlaceItemRequest,
): void {
  if (!definition.rotatable && request.rotation !== 0) {
    throw new TerritoryError(
      "TERRITORY.INVALID_PLACEMENT",
      "这个物件不能旋转。",
      false,
    );
  }
  if (!definition.flippable && request.flipped) {
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
            placements: this.repository
              .listSceneItems(active.sceneId)
              .map(mapItem),
          }
        : null,
      availableScenes: listTerritorySceneSummaries(),
      collection: this.repository.listCollectionItems().map(mapItem),
    };
  }

  selectScene(request: TerritorySelectSceneRequest): TerritorySnapshot {
    this.repository.selectScene(
      getTerritoryScene(request.sceneId),
      this.clock.now(),
    );
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

    const placements = this.repository
      .listSceneItems(active.sceneId)
      .map(mapItem);
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
    const active = this.requireActiveScene(request.sceneId);
    const record = this.repository.getItem(request.itemId);
    if (!record) {
      throw new TerritoryError(
        "TERRITORY.ITEM_NOT_FOUND",
        "找不到这个领地物件。",
        false,
      );
    }
    if (record.location === "scene" && record.sceneId !== active.sceneId) {
      throw new TerritoryError(
        "TERRITORY.INVALID_PLACEMENT",
        "请先把物件收回收藏库，再放到另一个场景。",
        false,
      );
    }

    const definition = TERRITORY_ITEMS[record.catalogId];
    requireTransform(definition, request);
    const item = mapItem(record);
    const placements = this.repository
      .listSceneItems(active.sceneId)
      .map(mapItem);
    if (
      !isPlacementValid(
        getTerritoryScene(active.sceneId).definition,
        item,
        request.x,
        request.y,
        request.rotation,
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

    this.repository.placeItem({
      flipped: request.flipped,
      itemId: record.id,
      layer: record.layer,
      now: this.clock.now(),
      rotation: request.rotation,
      sceneId: active.sceneId,
      x: request.x,
      y: request.y,
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
    if (item.location !== "scene" || item.sceneId !== request.sceneId) {
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
