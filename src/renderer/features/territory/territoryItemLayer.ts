import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  type FederatedPointerEvent,
  type Texture,
} from "pixi.js";

import type {
  TerritoryActiveScene,
  TerritoryItem,
  TerritoryPoint,
  TerritoryRotation,
  TerritorySceneTarget,
} from "../../../shared/contracts/territory";
import type { TerritoryPositiveSize } from "../../../shared/contracts/territoryItemManifest";
import { territoryAssetUrl } from "../../../shared/pure/territoryAsset";
import {
  isTerritorySurfacePlacementValid,
  rotatedTerritorySize,
  transformTerritoryPixelPoint,
} from "../../../shared/pure/territoryItemGeometry";
import { isGroundPlacementValid } from "../../../shared/pure/territoryGrid";
import {
  createTerritoryItemGraphic,
  TERRITORY_TILE_SIZE,
} from "./territoryArt";

export interface TerritoryItemTransform {
  readonly flipped: boolean;
  readonly rotation: TerritoryRotation;
}

interface ItemVisual {
  readonly content: Container;
  readonly outer: Container;
}

interface TerritoryItemLayerOptions {
  readonly isCurrent: () => boolean;
  readonly mode: "edit" | "explore";
  readonly onItemSelect: (itemId: string | null) => void;
  readonly onMoveRequest: (point: TerritoryPoint) => void;
  readonly onPlaceRequest: (
    item: TerritoryItem,
    target: TerritorySceneTarget,
    transform: TerritoryItemTransform,
  ) => Promise<boolean>;
  readonly root: Container;
  readonly scene: TerritoryActiveScene;
  readonly selectedItem: TerritoryItem | null;
  readonly selectedTransform: TerritoryItemTransform;
}

export interface TerritoryItemLayerResult {
  readonly failedAssetIds: readonly string[];
  readonly renderedAssetIds: readonly string[];
}

const OBJECT_DEPTH_BASE = 10_000;
const UNDERLAY_DEPTH_BASE = 1_000;
const EDIT_OVERLAY_DEPTH = 100_000;

export function territoryPointFromEvent(
  event: FederatedPointerEvent,
  root: Container,
): TerritoryPoint {
  const point = event.getLocalPosition(root);
  return {
    x: Math.max(0, Math.min(15, Math.floor(point.x / TERRITORY_TILE_SIZE))),
    y: Math.max(0, Math.min(9, Math.floor(point.y / TERRITORY_TILE_SIZE))),
  };
}

function applyQuarterTurn(
  container: Container,
  bounds: TerritoryPositiveSize,
  rotation: TerritoryRotation,
): void {
  container.rotation = (rotation * Math.PI) / 180;
  if (rotation === 90) {
    container.position.set(bounds.height, 0);
  } else if (rotation === 180) {
    container.position.set(bounds.width, bounds.height);
  } else if (rotation === 270) {
    container.position.set(0, bounds.width);
  }
}

function createItemVisual(
  item: TerritoryItem,
  selected: boolean,
  assetTextures: ReadonlyMap<string, Texture>,
): ItemVisual {
  const outer = new Container();
  const rotated = new Container();
  const content = new Container();
  const bounds = item.manifest.visual.sizePx;
  const source = item.manifest.visual.source;
  const graphic = createTerritoryItemGraphic(
    item,
    source.kind === "asset" ? assetTextures.get(source.assetId) : undefined,
  );
  content.addChild(graphic);
  if (selected) {
    const outline = new Graphics()
      .roundRect(1, 1, bounds.width - 2, bounds.height - 2, 5)
      .stroke({ alpha: 0.96, color: "#f7e2a0", width: 3 });
    content.addChild(outline);
  }
  if (item.flipped) {
    content.pivot.set(bounds.width / 2, 0);
    content.position.set(bounds.width / 2, 0);
    content.scale.x = -1;
  }
  rotated.addChild(content);
  applyQuarterTurn(rotated, bounds, item.rotation);
  outer.addChild(rotated);
  const rotatedSize = rotatedTerritorySize(bounds, item.rotation);
  outer.hitArea = new Rectangle(0, 0, rotatedSize.width, rotatedSize.height);
  return { content, outer };
}

async function loadTerritoryAssetTextures(
  items: readonly TerritoryItem[],
): Promise<{
  readonly failedAssetIds: readonly string[];
  readonly textures: ReadonlyMap<string, Texture>;
}> {
  const assetIds = [
    ...new Set(
      items.flatMap((item) =>
        item.manifest.visual.source.kind === "asset"
          ? [item.manifest.visual.source.assetId]
          : [],
      ),
    ),
  ].sort();
  const loaded = await Promise.all(
    assetIds.map(async (assetId) => {
      try {
        return {
          assetId,
          texture: await Assets.load<Texture>(territoryAssetUrl(assetId)),
        };
      } catch {
        return { assetId, texture: null };
      }
    }),
  );
  return {
    failedAssetIds: loaded
      .filter(({ texture }) => !texture)
      .map(({ assetId }) => assetId),
    textures: new Map(
      loaded.flatMap(({ assetId, texture }) =>
        texture ? [[assetId, texture] as const] : [],
      ),
    ),
  };
}

function attachmentLocalPosition(
  item: TerritoryItem,
  slotAnchor: TerritoryPoint,
): TerritoryPoint {
  if (item.manifest.placement.mode !== "surface") return slotAnchor;
  const anchor = transformTerritoryPixelPoint(
    item.manifest.placement.attachmentAnchorPx,
    item.manifest.visual.sizePx,
    item.flipped,
    item.rotation,
  );
  return { x: slotAnchor.x - anchor.x, y: slotAnchor.y - anchor.y };
}

function groundDepth(item: TerritoryItem): number {
  if (
    item.target.kind !== "ground" ||
    item.manifest.placement.mode !== "ground"
  ) {
    return OBJECT_DEPTH_BASE;
  }
  const placement = item.manifest.placement;
  if (placement.plane === "underlay") {
    return UNDERLAY_DEPTH_BASE + item.target.y;
  }
  const gridBounds = {
    height: placement.gridSize.height * TERRITORY_TILE_SIZE,
    width: placement.gridSize.width * TERRITORY_TILE_SIZE,
  };
  const anchor = transformTerritoryPixelPoint(
    placement.depthAnchorPx,
    gridBounds,
    item.flipped,
    item.rotation,
  );
  return OBJECT_DEPTH_BASE + item.target.y * TERRITORY_TILE_SIZE + anchor.y;
}

function slotWorldPosition(
  support: TerritoryItem,
  slotAnchor: TerritoryPoint,
): TerritoryPoint | null {
  if (support.target.kind !== "ground") return null;
  const transformed = transformTerritoryPixelPoint(
    slotAnchor,
    support.manifest.visual.sizePx,
    support.flipped,
    support.rotation,
  );
  return {
    x: support.target.x * TERRITORY_TILE_SIZE + transformed.x,
    y: support.target.y * TERRITORY_TILE_SIZE + transformed.y,
  };
}

function drawPlacementGrid(
  root: Container,
  scene: TerritoryActiveScene,
  selectedItem: TerritoryItem | null,
  transform: TerritoryItemTransform,
): void {
  if (selectedItem?.manifest.placement.mode === "surface") return;
  const grid = new Container();
  grid.eventMode = "none";
  grid.zIndex = EDIT_OVERLAY_DEPTH;
  for (let y = 0; y < scene.definition.height; y += 1) {
    for (let x = 0; x < scene.definition.width; x += 1) {
      if (scene.definition.placeableRows[y]?.[x] !== "1") continue;
      const valid = selectedItem
        ? isGroundPlacementValid(
            scene.definition,
            selectedItem,
            x,
            y,
            transform.rotation,
            transform.flipped,
            scene.placements,
            scene.pet,
          )
        : true;
      const cell = new Graphics()
        .rect(
          x * TERRITORY_TILE_SIZE + 1,
          y * TERRITORY_TILE_SIZE + 1,
          TERRITORY_TILE_SIZE - 2,
          TERRITORY_TILE_SIZE - 2,
        )
        .fill({
          alpha: valid ? 0.1 : 0.035,
          color: valid ? "#a9edba" : "#f08b88",
        })
        .stroke({
          alpha: valid ? 0.28 : 0.1,
          color: valid ? "#bff4ca" : "#f08b88",
          width: 1,
        });
      grid.addChild(cell);
    }
  }
  root.addChild(grid);
}

function drawSurfaceSlots(
  root: Container,
  scene: TerritoryActiveScene,
  selectedItem: TerritoryItem,
  transform: TerritoryItemTransform,
  onPlaceRequest: TerritoryItemLayerOptions["onPlaceRequest"],
): void {
  if (selectedItem.manifest.placement.mode !== "surface") return;
  for (const support of scene.placements) {
    if (support.target.kind !== "ground") continue;
    for (const slot of support.manifest.surfaceSlots) {
      const target = {
        kind: "surface" as const,
        sceneId: scene.definition.id,
        slotId: slot.id,
        supportItemId: support.id,
      };
      if (
        !isTerritorySurfacePlacementValid(
          selectedItem,
          target,
          scene.placements,
        )
      ) {
        continue;
      }
      const position = slotWorldPosition(support, slot.anchorPx);
      if (!position) continue;
      const marker = new Graphics()
        .circle(0, 0, 15)
        .fill({ alpha: 0.72, color: "#745ee8" })
        .circle(0, 0, 7)
        .fill({ alpha: 0.96, color: "#fff2be" })
        .circle(0, 0, 17)
        .stroke({ alpha: 0.95, color: "#ffffff", width: 2 });
      marker.position.set(position.x, position.y);
      marker.zIndex = EDIT_OVERLAY_DEPTH + 10;
      marker.eventMode = "static";
      marker.cursor = "pointer";
      marker.hitArea = new Rectangle(-22, -22, 44, 44);
      marker.on("pointertap", (event: FederatedPointerEvent) => {
        event.stopPropagation();
        void onPlaceRequest(selectedItem, target, transform);
      });
      root.addChild(marker);
    }
  }
}

function addGroundItems(
  options: TerritoryItemLayerOptions,
  assetTextures: ReadonlyMap<string, Texture>,
): void {
  const {
    mode,
    onItemSelect,
    onMoveRequest,
    onPlaceRequest,
    root,
    scene,
    selectedItem,
  } = options;
  const attachments = new Map<string, TerritoryItem[]>();
  for (const item of scene.placements) {
    if (item.target.kind !== "surface") continue;
    const current = attachments.get(item.target.supportItemId) ?? [];
    current.push(item);
    attachments.set(item.target.supportItemId, current);
  }

  for (const item of scene.placements) {
    if (
      item.target.kind !== "ground" ||
      item.manifest.placement.mode !== "ground"
    ) {
      continue;
    }
    const groundTarget = item.target;
    const itemVisual = createItemVisual(
      item,
      item.id === selectedItem?.id,
      assetTextures,
    );
    const itemContainer = itemVisual.outer;
    for (const attachment of attachments.get(item.id) ?? []) {
      if (
        attachment.target.kind !== "surface" ||
        attachment.manifest.placement.mode !== "surface"
      ) {
        continue;
      }
      const attachmentTarget = attachment.target;
      const slot = item.manifest.surfaceSlots.find(
        ({ id }) => id === attachmentTarget.slotId,
      );
      if (!slot) continue;
      const childVisual = createItemVisual(
        attachment,
        attachment.id === selectedItem?.id,
        assetTextures,
      );
      const childPosition = attachmentLocalPosition(attachment, slot.anchorPx);
      childVisual.outer.position.set(childPosition.x, childPosition.y);
      childVisual.outer.eventMode = "static";
      childVisual.outer.cursor = "pointer";
      childVisual.outer.on("pointerdown", (event: FederatedPointerEvent) => {
        event.stopPropagation();
      });
      childVisual.outer.on("pointerup", (event: FederatedPointerEvent) => {
        event.stopPropagation();
      });
      childVisual.outer.on("pointertap", (event: FederatedPointerEvent) => {
        event.stopPropagation();
        onItemSelect(attachment.id);
        if (mode === "explore") {
          onMoveRequest({ x: groundTarget.x, y: groundTarget.y });
        }
      });
      itemVisual.content.addChild(childVisual.outer);
    }

    const originalPoint = { x: groundTarget.x, y: groundTarget.y };
    itemContainer.position.set(
      originalPoint.x * TERRITORY_TILE_SIZE,
      originalPoint.y * TERRITORY_TILE_SIZE,
    );
    itemContainer.zIndex = groundDepth(item);
    itemContainer.eventMode = "static";
    itemContainer.cursor = mode === "edit" ? "grab" : "pointer";
    let dragging = false;
    let moved = false;
    let latestPoint = originalPoint;
    let startPoint = originalPoint;
    itemContainer.on("pointerdown", (event: FederatedPointerEvent) => {
      event.stopPropagation();
      if (mode !== "edit") return;
      dragging = true;
      moved = false;
      startPoint = territoryPointFromEvent(event, root);
      itemContainer.cursor = "grabbing";
    });
    itemContainer.on("globalpointermove", (event: FederatedPointerEvent) => {
      if (!dragging) return;
      const point = territoryPointFromEvent(event, root);
      const delta = {
        x: point.x - startPoint.x,
        y: point.y - startPoint.y,
      };
      latestPoint = {
        x: Math.max(0, Math.min(15, originalPoint.x + delta.x)),
        y: Math.max(0, Math.min(9, originalPoint.y + delta.y)),
      };
      moved ||=
        latestPoint.x !== originalPoint.x || latestPoint.y !== originalPoint.y;
      itemContainer.position.set(
        latestPoint.x * TERRITORY_TILE_SIZE,
        latestPoint.y * TERRITORY_TILE_SIZE,
      );
    });
    const finishDrag = (event: FederatedPointerEvent) => {
      event.stopPropagation();
      if (!dragging) {
        if (mode === "explore") {
          onItemSelect(item.id);
          onMoveRequest(originalPoint);
        }
        return;
      }
      dragging = false;
      itemContainer.cursor = "grab";
      if (!moved) {
        onItemSelect(item.id);
        return;
      }
      void onPlaceRequest(
        item,
        {
          kind: "ground",
          sceneId: scene.definition.id,
          ...latestPoint,
        },
        { flipped: item.flipped, rotation: item.rotation },
      ).then((accepted) => {
        if (accepted) {
          onItemSelect(item.id);
        } else {
          itemContainer.position.set(
            originalPoint.x * TERRITORY_TILE_SIZE,
            originalPoint.y * TERRITORY_TILE_SIZE,
          );
        }
      });
    };
    itemContainer.on("pointerup", finishDrag);
    itemContainer.on("pointerupoutside", finishDrag);
    root.addChild(itemContainer);
  }
}

export async function renderTerritoryItemLayer(
  options: TerritoryItemLayerOptions,
): Promise<TerritoryItemLayerResult | undefined> {
  const { mode, root, scene, selectedItem, selectedTransform } = options;
  if (mode === "edit") {
    drawPlacementGrid(root, scene, selectedItem, selectedTransform);
  }

  const { failedAssetIds, textures } = await loadTerritoryAssetTextures(
    scene.placements,
  );
  if (!options.isCurrent()) return undefined;
  addGroundItems(options, textures);
  if (mode === "edit" && selectedItem) {
    drawSurfaceSlots(
      root,
      scene,
      selectedItem,
      selectedTransform,
      options.onPlaceRequest,
    );
  }
  return {
    failedAssetIds,
    renderedAssetIds: [...textures.keys()].sort(),
  };
}
