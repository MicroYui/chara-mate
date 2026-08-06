// Installs Pixi's static uniform synchronizers for a strict CSP (no unsafe-eval).
import "pixi.js/unsafe-eval";
import {
  AnimatedSprite,
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Texture,
  type FederatedPointerEvent,
  type FrameObject,
} from "pixi.js";
import { useEffect, useRef, useState } from "react";

import type { PetDescriptor } from "../../../shared/contracts/pet";
import type {
  TerritoryActiveScene,
  TerritoryItem,
  TerritoryPoint,
  TerritoryRotation,
} from "../../../shared/contracts/territory";
import { isPlacementValid } from "../../../shared/pure/territoryGrid";
import {
  getPetAtlasFrames,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
} from "../../character/petAtlas";
import styles from "./TerritoryPage.module.css";
import {
  createTerritoryEnvironment,
  createTerritoryItemGraphic,
  TERRITORY_SCENE_HEIGHT,
  TERRITORY_SCENE_WIDTH,
  TERRITORY_TILE_SIZE,
} from "./territoryArt";

export interface TerritoryMovement {
  readonly id: number;
  readonly path: readonly RenderedPetPosition[];
}

interface RenderedPetPosition {
  readonly x: number;
  readonly y: number;
}

interface ItemTransform {
  readonly flipped: boolean;
  readonly rotation: TerritoryRotation;
}

interface PixiTerritoryCanvasProps {
  readonly activePet: PetDescriptor | undefined;
  readonly animationSpeed: number;
  readonly mode: "edit" | "explore";
  readonly movement: TerritoryMovement | null;
  readonly onItemSelect: (itemId: string | null) => void;
  readonly onMoveRequest: (point: TerritoryPoint) => void;
  readonly onMovementComplete: (movementId: number) => void;
  readonly onPetPositionChange: (position: RenderedPetPosition) => void;
  readonly onPlaceRequest: (
    item: TerritoryItem,
    point: TerritoryPoint,
    transform: ItemTransform,
  ) => Promise<boolean>;
  readonly scene: TerritoryActiveScene;
  readonly selectedItem: TerritoryItem | null;
  readonly selectedTransform: ItemTransform;
}

interface PixiRuntime {
  readonly app: Application;
  root: Container | undefined;
  textures: Texture[];
  tickerCallback: (() => void) | undefined;
}

function destroyRenderedScene(runtime: PixiRuntime): void {
  if (runtime.tickerCallback) {
    runtime.app.ticker.remove(runtime.tickerCallback);
    runtime.tickerCallback = undefined;
  }
  if (runtime.root) {
    runtime.app.stage.removeChild(runtime.root);
    runtime.root.destroy({ children: true });
    runtime.root = undefined;
  }
  for (const texture of runtime.textures) texture.destroy(false);
  runtime.textures = [];
}

function fitScene(runtime: PixiRuntime): void {
  const root = runtime.root;
  if (!root) return;
  const scale = Math.min(
    runtime.app.screen.width / TERRITORY_SCENE_WIDTH,
    runtime.app.screen.height / TERRITORY_SCENE_HEIGHT,
  );
  root.scale.set(scale);
  root.position.set(
    Math.round((runtime.app.screen.width - TERRITORY_SCENE_WIDTH * scale) / 2),
    Math.round(
      (runtime.app.screen.height - TERRITORY_SCENE_HEIGHT * scale) / 2,
    ),
  );
}

function reportPetPosition(
  runtime: PixiRuntime,
  movement: TerritoryMovement | null,
  position: RenderedPetPosition,
  onPetPositionChange: (position: RenderedPetPosition) => void,
): void {
  runtime.app.canvas.dataset["petGridX"] = String(position.x);
  runtime.app.canvas.dataset["petGridY"] = String(position.y);
  runtime.app.canvas.dataset["petMovementId"] = movement
    ? String(movement.id)
    : "idle";
  onPetPositionChange(position);
}

function pointFromEvent(
  event: FederatedPointerEvent,
  root: Container,
): TerritoryPoint {
  const point = event.getLocalPosition(root);
  return {
    x: Math.max(0, Math.min(15, Math.floor(point.x / TERRITORY_TILE_SIZE))),
    y: Math.max(0, Math.min(9, Math.floor(point.y / TERRITORY_TILE_SIZE))),
  };
}

function positionItem(
  container: Container,
  item: TerritoryItem,
  point: TerritoryPoint,
  rotation: TerritoryRotation,
): void {
  const baseWidth = item.width * TERRITORY_TILE_SIZE;
  const baseHeight = item.height * TERRITORY_TILE_SIZE;
  container.rotation = (rotation * Math.PI) / 180;
  if (rotation === 0) {
    container.position.set(
      point.x * TERRITORY_TILE_SIZE,
      point.y * TERRITORY_TILE_SIZE,
    );
  } else if (rotation === 90) {
    container.position.set(
      (point.x + item.height) * TERRITORY_TILE_SIZE,
      point.y * TERRITORY_TILE_SIZE,
    );
  } else if (rotation === 180) {
    container.position.set(
      point.x * TERRITORY_TILE_SIZE + baseWidth,
      point.y * TERRITORY_TILE_SIZE + baseHeight,
    );
  } else {
    container.position.set(
      point.x * TERRITORY_TILE_SIZE,
      (point.y + item.width) * TERRITORY_TILE_SIZE,
    );
  }
}

function createItemContainer(
  item: TerritoryItem,
  selected: boolean,
): Container {
  const outer = new Container();
  const inner = createTerritoryItemGraphic(item);
  if (item.flipped) {
    const width = item.width * TERRITORY_TILE_SIZE;
    inner.pivot.set(width / 2, 0);
    inner.position.set(width / 2, 0);
    inner.scale.x = -1;
  }
  outer.addChild(inner);
  if (selected) {
    const outline = new Graphics()
      .rect(
        2,
        2,
        item.width * TERRITORY_TILE_SIZE - 4,
        item.height * TERRITORY_TILE_SIZE - 4,
      )
      .stroke({ alpha: 0.92, color: "#f7e2a0", width: 3 });
    outer.addChild(outline);
  }
  return outer;
}

function drawPlacementGrid(
  root: Container,
  scene: TerritoryActiveScene,
  selectedItem: TerritoryItem | null,
  transform: ItemTransform,
): void {
  const grid = new Container();
  grid.eventMode = "none";
  grid.zIndex = 1000;
  for (let y = 0; y < scene.definition.height; y += 1) {
    for (let x = 0; x < scene.definition.width; x += 1) {
      if (scene.definition.placeableRows[y]?.[x] !== "1") continue;
      const valid = selectedItem
        ? isPlacementValid(
            scene.definition,
            selectedItem,
            x,
            y,
            transform.rotation,
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

async function addPetSprite(
  runtime: PixiRuntime,
  root: Container,
  scene: TerritoryActiveScene,
  pet: PetDescriptor | undefined,
  animationSpeed: number,
  movement: TerritoryMovement | null,
  onMovementComplete: (movementId: number) => void,
  onPetPositionChange: (position: RenderedPetPosition) => void,
): Promise<void> {
  const path = movement?.path.length ? movement.path : [scene.pet];
  const first = path[0] ?? scene.pet;
  if (!pet) {
    const glow = new Graphics()
      .circle(0, 0, 19)
      .fill({ alpha: 0.28, color: scene.definition.palette.accent });
    glow.circle(0, 0, 9).fill({ alpha: 0.9, color: "#fff2c3" });
    glow.position.set(
      (first.x + 0.5) * TERRITORY_TILE_SIZE,
      (first.y + 0.62) * TERRITORY_TILE_SIZE,
    );
    glow.zIndex = 200 + first.y;
    root.addChild(glow);
    reportPetPosition(runtime, movement, first, onPetPositionChange);
    if (movement) onMovementComplete(movement.id);
    return;
  }

  const running = path.length > 1;
  let facing = scene.pet.facing;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (previous && current && previous.x !== current.x) {
      facing = current.x < previous.x ? "left" : "right";
      break;
    }
  }
  const atlasTexture = await Assets.load<Texture>(pet.spriteUrl);
  if (runtime.root !== root) return;
  const atlasFrames = getPetAtlasFrames(
    running ? (facing === "left" ? "running-left" : "running-right") : "idle",
    pet.spriteVersionNumber,
  );
  const textures = atlasFrames.map(
    ({ column, row }) =>
      new Texture({
        frame: new Rectangle(
          column * PET_CELL_WIDTH,
          row * PET_CELL_HEIGHT,
          PET_CELL_WIDTH,
          PET_CELL_HEIGHT,
        ),
        source: atlasTexture.source,
      }),
  );
  runtime.textures.push(...textures);
  const frames: FrameObject[] = textures.map((texture, index) => ({
    texture,
    time: atlasFrames[index]?.durationMs ?? 140,
  }));
  const sprite = new AnimatedSprite({
    animationSpeed,
    autoPlay: frames.length > 1,
    loop: true,
    textures: frames,
  });
  sprite.anchor.set(0.5, 1);
  sprite.width = 82;
  sprite.height = 89;
  sprite.position.set(
    (first.x + 0.5) * TERRITORY_TILE_SIZE,
    (first.y + 1) * TERRITORY_TILE_SIZE,
  );
  sprite.zIndex = 200 + first.y + 0.5;
  root.addChild(sprite);
  reportPetPosition(runtime, movement, first, onPetPositionChange);

  if (!movement || path.length <= 1) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sprite.gotoAndStop(0);
    }
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const destination = path.at(-1) ?? first;
    sprite.position.set(
      (destination.x + 0.5) * TERRITORY_TILE_SIZE,
      (destination.y + 1) * TERRITORY_TILE_SIZE,
    );
    reportPetPosition(runtime, movement, destination, onPetPositionChange);
    onMovementComplete(movement.id);
    return;
  }

  const segmentDuration = 180 / Math.max(0.1, animationSpeed);
  let totalDuration = 0;
  const segments = path.slice(0, -1).map((from, index) => {
    const to = path[index + 1] ?? from;
    const duration =
      segmentDuration *
      Math.max(Math.abs(to.x - from.x) + Math.abs(to.y - from.y), 0.001);
    const startsAt = totalDuration;
    totalDuration += duration;
    return { duration, from, startsAt, to };
  });
  let elapsed = 0;
  const tick = () => {
    elapsed += runtime.app.ticker.deltaMS;
    const segment =
      segments.find(
        ({ duration, startsAt }) => elapsed < startsAt + duration,
      ) ?? segments.at(-1);
    if (!segment) return;
    const progress = Math.min(
      1,
      Math.max(0, (elapsed - segment.startsAt) / segment.duration),
    );
    const position = {
      x: segment.from.x + (segment.to.x - segment.from.x) * progress,
      y: segment.from.y + (segment.to.y - segment.from.y) * progress,
    };
    sprite.position.set(
      (position.x + 0.5) * TERRITORY_TILE_SIZE,
      (position.y + 1) * TERRITORY_TILE_SIZE,
    );
    sprite.zIndex = 200 + position.y + 0.5;
    reportPetPosition(runtime, movement, position, onPetPositionChange);
    if (elapsed >= totalDuration) {
      runtime.app.ticker.remove(tick);
      runtime.tickerCallback = undefined;
      onMovementComplete(movement.id);
    }
  };
  runtime.tickerCallback = tick;
  runtime.app.ticker.add(tick);
}

export function PixiTerritoryCanvas({
  activePet,
  animationSpeed,
  mode,
  movement,
  onItemSelect,
  onMoveRequest,
  onMovementComplete,
  onPetPositionChange,
  onPlaceRequest,
  scene,
  selectedItem,
  selectedTransform,
}: PixiTerritoryCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PixiRuntime | null>(null);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [petRendered, setPetRendered] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    let cancelled = false;
    let initialized = false;
    const observer = new ResizeObserver(() => {
      const runtime = runtimeRef.current;
      if (runtime?.app === app) fitScene(runtime);
    });
    void app
      .init({
        antialias: false,
        autoDensity: true,
        backgroundAlpha: 0,
        preference: "webgl",
        resolution: window.devicePixelRatio,
        resizeTo: host,
      })
      .then(() => {
        initialized = true;
        if (cancelled) {
          app.destroy(true, { children: true });
          return;
        }
        host.append(app.canvas);
        runtimeRef.current = {
          app,
          root: undefined,
          textures: [],
          tickerCallback: undefined,
        };
        observer.observe(host);
        setRuntimeGeneration((value) => value + 1);
      })
      .catch(() => {
        if (!cancelled) setRenderError("无法初始化领地渲染器。");
      });
    return () => {
      cancelled = true;
      observer.disconnect();
      const runtime = runtimeRef.current;
      if (runtime?.app === app) {
        destroyRenderedScene(runtime);
        runtimeRef.current = null;
      }
      if (initialized) app.destroy(true, { children: true });
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    destroyRenderedScene(runtime);
    const root = new Container();
    root.sortableChildren = true;
    runtime.root = root;
    runtime.app.stage.addChild(root);
    setPetRendered(false);

    const environment = createTerritoryEnvironment(scene.definition);
    environment.eventMode = "static";
    environment.hitArea = new Rectangle(
      0,
      0,
      TERRITORY_SCENE_WIDTH,
      TERRITORY_SCENE_HEIGHT,
    );
    environment.zIndex = 0;
    environment.on("pointertap", (event: FederatedPointerEvent) => {
      const point = pointFromEvent(event, root);
      if (mode === "edit" && selectedItem) {
        void onPlaceRequest(selectedItem, point, selectedTransform);
      } else if (mode === "explore") {
        onItemSelect(null);
        onMoveRequest(point);
      }
    });
    root.addChild(environment);

    if (mode === "edit") {
      drawPlacementGrid(root, scene, selectedItem, selectedTransform);
    }

    for (const item of scene.placements) {
      if (item.x === null || item.y === null) continue;
      const itemContainer = createItemContainer(
        item,
        item.id === selectedItem?.id,
      );
      itemContainer.hitArea = new Rectangle(
        0,
        0,
        item.width * TERRITORY_TILE_SIZE,
        item.height * TERRITORY_TILE_SIZE,
      );
      const originalPoint = { x: item.x, y: item.y };
      positionItem(itemContainer, item, originalPoint, item.rotation);
      itemContainer.zIndex =
        item.layer === 1 ? 100 + item.y : 200 + item.y + item.height - 0.25;
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
        startPoint = pointFromEvent(event, root);
        itemContainer.cursor = "grabbing";
      });
      itemContainer.on("globalpointermove", (event: FederatedPointerEvent) => {
        if (!dragging) return;
        const point = pointFromEvent(event, root);
        const delta = { x: point.x - startPoint.x, y: point.y - startPoint.y };
        latestPoint = {
          x: Math.max(0, Math.min(15, originalPoint.x + delta.x)),
          y: Math.max(0, Math.min(9, originalPoint.y + delta.y)),
        };
        moved ||=
          latestPoint.x !== originalPoint.x ||
          latestPoint.y !== originalPoint.y;
        positionItem(itemContainer, item, latestPoint, item.rotation);
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
        void onPlaceRequest(item, latestPoint, {
          flipped: item.flipped,
          rotation: item.rotation,
        }).then((accepted) => {
          if (accepted) {
            onItemSelect(item.id);
          } else {
            positionItem(itemContainer, item, originalPoint, item.rotation);
          }
        });
      };
      itemContainer.on("pointerup", finishDrag);
      itemContainer.on("pointerupoutside", finishDrag);
      root.addChild(itemContainer);
    }

    fitScene(runtime);
    setRenderError(null);
    void addPetSprite(
      runtime,
      root,
      scene,
      activePet,
      animationSpeed,
      movement,
      onMovementComplete,
      onPetPositionChange,
    )
      .then(() => {
        if (runtime.root === root) setPetRendered(Boolean(activePet));
      })
      .catch(() => {
        if (runtime.root === root) {
          setPetRendered(false);
          setRenderError("无法读取当前桌宠图像。");
        }
      });

    return () => {
      if (runtime.root === root) destroyRenderedScene(runtime);
    };
  }, [
    activePet,
    animationSpeed,
    mode,
    movement,
    onItemSelect,
    onMoveRequest,
    onMovementComplete,
    onPetPositionChange,
    onPlaceRequest,
    runtimeGeneration,
    scene,
    selectedItem,
    selectedTransform,
  ]);

  return (
    <div className={styles["canvasFrame"]}>
      <div
        ref={hostRef}
        className={styles["canvasHost"]}
        data-pet-render-ready={activePet && petRendered ? "true" : undefined}
        data-testid="territory-canvas"
        role="img"
        aria-label={`${scene.definition.name} 像素领地。${
          mode === "edit" ? "当前为布置模式。" : "点击地面可以移动桌宠。"
        }`}
      />
      {renderError ? (
        <p className={styles["canvasError"]} role="alert">
          {renderError}
        </p>
      ) : null}
    </div>
  );
}
