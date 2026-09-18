// Installs Pixi's static uniform synchronizers for a strict CSP (no unsafe-eval).
import "pixi.js/unsafe-eval";
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  type FederatedPointerEvent,
  type Texture,
} from "pixi.js";
import { useEffect, useRef, useState } from "react";

import type { PetDescriptor } from "../../../shared/contracts/pet";
import type {
  TerritoryAsset,
  TerritoryDefinition,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryLayer,
  TerritoryPetState,
  TerritoryZoneView,
} from "../../../shared/contracts/territoryWorld";
import { territoryAssetUrl } from "../../../shared/pure/territoryAsset";
import {
  territoryInstanceLayout,
  transformTerritoryPixelPoint,
} from "../../../shared/pure/territoryWorldGeometry";
import {
  TERRITORY_WORLD_MACRO_UNITS,
  TERRITORY_WORLD_UNIT_PX,
} from "../../../shared/pure/territoryWorldScale";
import styles from "./TerritoryWorldPage.module.css";
import { createTerritoryWorldDefinitionGraphic } from "./territoryWorldArt";
import {
  territoryWorldFlatDepth,
  territoryWorldOverlayDepth,
  territoryWorldSortedDepth,
} from "./territoryWorldDepth";
import {
  renderTerritoryWorldPetLayer,
  type TerritoryWorldMovement,
  type TerritoryWorldPetRuntime,
  type TerritoryWorldRenderedPetPosition,
} from "./territoryWorldPetLayer";

export interface TerritoryWorldPreviewAction {
  readonly action: "add" | "delete" | "move" | "replace";
  readonly label: string;
}

interface PixiTerritoryWorldCanvasProps {
  readonly activePet: PetDescriptor | undefined;
  readonly animationSpeed: number;
  readonly assets: readonly TerritoryAsset[];
  readonly mode: "build" | "explore";
  readonly movement: TerritoryWorldMovement | null;
  readonly onInstanceMove: (
    instance: TerritoryInstance,
    point: TerritoryGridPoint,
  ) => Promise<boolean>;
  readonly onPlaceCollection: (point: TerritoryGridPoint) => Promise<boolean>;
  readonly onPetMove: (point: TerritoryGridPoint) => void;
  readonly onMovementComplete: (movementId: number) => void;
  readonly onPetPositionChange: (
    position: TerritoryWorldRenderedPetPosition,
  ) => void;
  readonly onSelectionChange: (
    instanceId: string | null,
    additive: boolean,
  ) => void;
  readonly previewActions: ReadonlyMap<string, TerritoryWorldPreviewAction>;
  readonly petState: TerritoryPetState;
  readonly selectedCollectionInstance: TerritoryInstance | null;
  readonly selectedInstanceIds: ReadonlySet<string>;
  readonly view: TerritoryZoneView;
  readonly visibleLayers: ReadonlySet<TerritoryLayer>;
}

interface WorldCanvasRuntime extends TerritoryWorldPetRuntime {
  camera: Container | undefined;
  panX: number;
  panY: number;
  root: Container | undefined;
  userZoom: number;
}

function definitionKey(value: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${value.id}@${String(value.revision)}`;
}

function destroyWorld(runtime: WorldCanvasRuntime): void {
  runtime.petController?.destroy();
  runtime.petController = undefined;
  if (runtime.camera) {
    runtime.app.stage.removeChild(runtime.camera);
    runtime.camera.destroy({ children: true });
    runtime.camera = undefined;
    runtime.root = undefined;
  }
}

function fitWorld(
  runtime: WorldCanvasRuntime,
  width: number,
  height: number,
): void {
  const camera = runtime.camera;
  if (!camera) return;
  const availableWidth = Math.max(1, runtime.app.screen.width - 48);
  const availableHeight = Math.max(1, runtime.app.screen.height - 48);
  const fit = Math.min(availableWidth / width, availableHeight / height);
  const nativeScale = fit < 1 ? 1 : Math.min(1.25, fit);
  const scale = Math.max(0.35, Math.min(2.4, nativeScale * runtime.userZoom));
  const centeredX = (runtime.app.screen.width - width * scale) / 2;
  const centeredY = (runtime.app.screen.height - height * scale) / 2;
  const keepVisible = 72;
  runtime.panX = Math.max(
    keepVisible - width * scale - centeredX,
    Math.min(runtime.app.screen.width - keepVisible - centeredX, runtime.panX),
  );
  runtime.panY = Math.max(
    keepVisible - height * scale - centeredY,
    Math.min(runtime.app.screen.height - keepVisible - centeredY, runtime.panY),
  );
  camera.scale.set(scale);
  camera.position.set(
    Math.round(centeredX + runtime.panX),
    Math.round(centeredY + runtime.panY),
  );
  runtime.app.canvas.dataset["worldZoom"] = scale.toFixed(2);
  runtime.app.canvas.dataset["worldPan"] =
    `${String(Math.round(runtime.panX))},${String(Math.round(runtime.panY))}`;
}

function pointFromEvent(
  event: FederatedPointerEvent,
  root: Container,
  width: number,
  height: number,
): TerritoryGridPoint {
  const point = event.getLocalPosition(root);
  return {
    x: Math.max(
      0,
      Math.min(width - 1, Math.floor(point.x / TERRITORY_WORLD_UNIT_PX)),
    ),
    y: Math.max(
      0,
      Math.min(height - 1, Math.floor(point.y / TERRITORY_WORLD_UNIT_PX)),
    ),
  };
}

function applyQuarterTurn(
  container: Container,
  definition: TerritoryDefinition,
  instance: TerritoryInstance,
): void {
  if (instance.placement.kind === "collection") return;
  const { rotation } = instance.placement;
  const bounds = definition.visual.sizePx;
  container.rotation = (rotation * Math.PI) / 180;
  if (rotation === 90) container.position.set(bounds.height, 0);
  else if (rotation === 180)
    container.position.set(bounds.width, bounds.height);
  else if (rotation === 270) container.position.set(0, bounds.width);
}

function visualDepth(
  instance: TerritoryInstance,
  definition: TerritoryDefinition,
  origin: { readonly x: number; readonly y: number },
  instances: ReadonlyMap<string, TerritoryInstance>,
  definitions: ReadonlyMap<string, TerritoryDefinition>,
  seen = new Set<string>(),
): number {
  if (definition.visual.depthMode === "flat") {
    return territoryWorldFlatDepth(definition.layer);
  }
  if (definition.visual.depthMode === "overlay") {
    return territoryWorldOverlayDepth(origin.y);
  }
  if (instance.placement.kind === "attachment" && !seen.has(instance.id)) {
    seen.add(instance.id);
    const parent = instances.get(instance.placement.parentInstanceId);
    const parentDefinition = parent
      ? definitions.get(definitionKey(parent.definition))
      : undefined;
    const parentLayout = parent
      ? territoryInstanceLayout(parent, instances, definitions)
      : null;
    if (parent && parentDefinition && parentLayout?.status === "available") {
      return (
        visualDepth(
          parent,
          parentDefinition,
          parentLayout.originPx,
          instances,
          definitions,
          seen,
        ) + 0.01
      );
    }
  }
  const placement = instance.placement;
  const depthAnchor =
    placement.kind === "collection"
      ? definition.visual.depthAnchorPx
      : transformTerritoryPixelPoint(
          definition.visual.depthAnchorPx,
          definition.visual.sizePx,
          placement.flipped,
          placement.rotation,
        );
  return territoryWorldSortedDepth(origin.y + depthAnchor.y);
}

function selectionOutline(
  definition: TerritoryDefinition,
  selected: boolean,
  preview: TerritoryWorldPreviewAction | undefined,
): Graphics | null {
  if (!selected && !preview) return null;
  const size = definition.visual.sizePx;
  const color = preview
    ? preview.action === "delete"
      ? "#ff7d78"
      : preview.action === "move" || preview.action === "replace"
        ? "#f7c86c"
        : "#79e2a6"
    : "#f8e3a1";
  return new Graphics()
    .roundRect(
      1,
      1,
      Math.max(2, size.width - 2),
      Math.max(2, size.height - 2),
      6,
    )
    .fill({ alpha: selected ? 0.055 : 0.025, color })
    .stroke({ alpha: 0.96, color, width: selected ? 3 : 2 });
}

function drawGrid(root: Container, width: number, height: number): void {
  const grid = new Graphics();
  for (let x = 0; x <= width; x += 1) {
    const macro = x % TERRITORY_WORLD_MACRO_UNITS === 0;
    grid
      .moveTo(x * TERRITORY_WORLD_UNIT_PX, 0)
      .lineTo(x * TERRITORY_WORLD_UNIT_PX, height * TERRITORY_WORLD_UNIT_PX)
      .stroke({
        alpha: macro ? 0.22 : 0.08,
        color: "#f4ead7",
        width: macro ? 1.5 : 1,
      });
  }
  for (let y = 0; y <= height; y += 1) {
    const macro = y % TERRITORY_WORLD_MACRO_UNITS === 0;
    grid
      .moveTo(0, y * TERRITORY_WORLD_UNIT_PX)
      .lineTo(width * TERRITORY_WORLD_UNIT_PX, y * TERRITORY_WORLD_UNIT_PX)
      .stroke({
        alpha: macro ? 0.22 : 0.08,
        color: "#f4ead7",
        width: macro ? 1.5 : 1,
      });
  }
  grid.eventMode = "none";
  grid.zIndex = 90_000;
  root.addChild(grid);
}

async function loadGeneratedTextures(
  assets: readonly TerritoryAsset[],
  definitions: readonly TerritoryDefinition[],
): Promise<{
  readonly failures: readonly string[];
  readonly textures: ReadonlyMap<string, Texture>;
}> {
  const generatedAssetIds = new Set(
    assets.filter(({ origin }) => origin !== "packaged").map(({ id }) => id),
  );
  const assetIds = [
    ...new Set(
      definitions
        .map(({ visual }) => visual.assetId)
        .filter((id) => generatedAssetIds.has(id)),
    ),
  ];
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
    failures: loaded
      .filter(({ texture }) => texture === null)
      .map(({ assetId }) => assetId),
    textures: new Map(
      loaded.flatMap(({ assetId, texture }) =>
        texture ? [[assetId, texture] as const] : [],
      ),
    ),
  };
}

export function PixiTerritoryWorldCanvas({
  activePet,
  animationSpeed,
  assets,
  mode,
  movement,
  onInstanceMove,
  onMovementComplete,
  onPetMove,
  onPetPositionChange,
  onPlaceCollection,
  onSelectionChange,
  petState,
  previewActions,
  selectedCollectionInstance,
  selectedInstanceIds,
  view,
  visibleLayers,
}: PixiTerritoryWorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<WorldCanvasRuntime | null>(null);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [sceneGeneration, setSceneGeneration] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [petReady, setPetReady] = useState(false);
  const handlersRef = useRef({
    onInstanceMove,
    onMovementComplete,
    onPetMove,
    onPetPositionChange,
    onPlaceCollection,
    onSelectionChange,
  });
  const movementRef = useRef(movement);
  const petStateRef = useRef(petState);

  useEffect(() => {
    handlersRef.current = {
      onInstanceMove,
      onMovementComplete,
      onPetMove,
      onPetPositionChange,
      onPlaceCollection,
      onSelectionChange,
    };
  }, [
    onInstanceMove,
    onMovementComplete,
    onPetMove,
    onPetPositionChange,
    onPlaceCollection,
    onSelectionChange,
  ]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    let cancelled = false;
    let initialized = false;
    const observer = new ResizeObserver(() => {
      const runtime = runtimeRef.current;
      if (!runtime || runtime.app !== app) return;
      fitWorld(
        runtime,
        view.zone.bounds.width * TERRITORY_WORLD_UNIT_PX,
        view.zone.bounds.height * TERRITORY_WORLD_UNIT_PX,
      );
    });
    const onWheel = (event: WheelEvent) => {
      const runtime = runtimeRef.current;
      if (!runtime || runtime.app !== app) return;
      event.preventDefault();
      runtime.userZoom = Math.max(
        0.65,
        Math.min(2.4, runtime.userZoom * (event.deltaY > 0 ? 0.92 : 1.08)),
      );
      fitWorld(
        runtime,
        view.zone.bounds.width * TERRITORY_WORLD_UNIT_PX,
        view.zone.bounds.height * TERRITORY_WORLD_UNIT_PX,
      );
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    let panPointerId: number | null = null;
    let panClientX = 0;
    let panClientY = 0;
    const onPanStart = (event: PointerEvent) => {
      if (event.button !== 1 && !(event.button === 0 && event.shiftKey)) return;
      const runtime = runtimeRef.current;
      if (!runtime || runtime.app !== app) return;
      panPointerId = event.pointerId;
      panClientX = event.clientX;
      panClientY = event.clientY;
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    const onPanMove = (event: PointerEvent) => {
      if (panPointerId !== event.pointerId) return;
      const runtime = runtimeRef.current;
      if (!runtime || runtime.app !== app) return;
      runtime.panX += event.clientX - panClientX;
      runtime.panY += event.clientY - panClientY;
      panClientX = event.clientX;
      panClientY = event.clientY;
      fitWorld(
        runtime,
        view.zone.bounds.width * TERRITORY_WORLD_UNIT_PX,
        view.zone.bounds.height * TERRITORY_WORLD_UNIT_PX,
      );
      event.preventDefault();
      event.stopPropagation();
    };
    const onPanEnd = (event: PointerEvent) => {
      if (panPointerId !== event.pointerId) return;
      panPointerId = null;
      if (host.hasPointerCapture(event.pointerId)) {
        host.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
    };
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
        host.addEventListener("wheel", onWheel, { passive: false });
        host.addEventListener("contextmenu", onContextMenu);
        host.addEventListener("pointerdown", onPanStart, true);
        host.addEventListener("pointermove", onPanMove, true);
        host.addEventListener("pointerup", onPanEnd, true);
        host.addEventListener("pointercancel", onPanEnd, true);
        runtimeRef.current = {
          app,
          camera: undefined,
          panX: 0,
          petController: undefined,
          panY: 0,
          root: undefined,
          userZoom: 1,
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
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("pointerdown", onPanStart, true);
      host.removeEventListener("pointermove", onPanMove, true);
      host.removeEventListener("pointerup", onPanEnd, true);
      host.removeEventListener("pointercancel", onPanEnd, true);
      const runtime = runtimeRef.current;
      if (runtime?.app === app) {
        destroyWorld(runtime);
        runtimeRef.current = null;
      }
      if (initialized) app.destroy(true, { children: true });
    };
  }, [view.zone.bounds.height, view.zone.bounds.width]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    destroyWorld(runtime);
    const camera = new Container();
    const root = new Container();
    root.sortableChildren = true;
    camera.addChild(root);
    runtime.camera = camera;
    runtime.root = root;
    runtime.app.stage.addChild(camera);
    setRenderError(null);
    setPetReady(false);

    const worldWidth = view.zone.bounds.width * TERRITORY_WORLD_UNIT_PX;
    const worldHeight = view.zone.bounds.height * TERRITORY_WORLD_UNIT_PX;
    const backdrop = new Graphics()
      .roundRect(0, 0, worldWidth, worldHeight, 4)
      .fill({ color: view.style.palette.dark });
    backdrop.eventMode = "static";
    backdrop.hitArea = new Rectangle(0, 0, worldWidth, worldHeight);
    backdrop.zIndex = 0;
    backdrop.on("pointertap", (event: FederatedPointerEvent) => {
      const point = pointFromEvent(
        event,
        root,
        view.zone.bounds.width,
        view.zone.bounds.height,
      );
      if (mode === "explore") {
        handlersRef.current.onSelectionChange(null, false);
        if (event.button === 2) handlersRef.current.onPetMove(point);
      } else if (selectedCollectionInstance) {
        void handlersRef.current.onPlaceCollection(point);
      } else {
        handlersRef.current.onSelectionChange(null, false);
      }
    });
    root.addChild(backdrop);

    if (mode === "build")
      drawGrid(root, view.zone.bounds.width, view.zone.bounds.height);

    const definitions = new Map(
      view.definitions.map((definition) => [
        definitionKey(definition),
        definition,
      ]),
    );
    const instances = new Map(
      view.instances.map((instance) => [instance.id, instance]),
    );
    let disposed = false;
    void loadGeneratedTextures(assets, view.definitions)
      .then(({ failures, textures }) => {
        if (disposed || runtime.root !== root) return;
        if (failures.length > 0) {
          runtime.app.canvas.dataset["territoryAssetFailures"] =
            failures.join(",");
          setRenderError("部分生成物件无法读取，已显示可操作的占位图。");
        } else {
          delete runtime.app.canvas.dataset["territoryAssetFailures"];
        }
        if (textures.size > 0) {
          runtime.app.canvas.dataset["territoryAssetIds"] = [
            ...textures.keys(),
          ].join(",");
        } else {
          delete runtime.app.canvas.dataset["territoryAssetIds"];
        }

        for (const instance of view.instances) {
          const definition = definitions.get(
            definitionKey(instance.definition),
          );
          if (!definition || !visibleLayers.has(definition.layer)) continue;
          const layout = territoryInstanceLayout(
            instance,
            instances,
            definitions,
          );
          if (layout.status !== "available") continue;
          const origin = layout.originPx;
          const outer = new Container();
          const rotated = new Container();
          const content = new Container();
          content.addChild(
            createTerritoryWorldDefinitionGraphic(definition, view.style, {
              ...(textures.get(definition.visual.assetId)
                ? { texture: textures.get(definition.visual.assetId)! }
                : {}),
              variant:
                instance.placement.kind === "zone"
                  ? instance.placement.point.x + instance.placement.point.y
                  : 0,
            }),
          );
          const outline = selectionOutline(
            definition,
            selectedInstanceIds.has(instance.id),
            previewActions.get(instance.id),
          );
          if (outline) content.addChild(outline);
          if (
            instance.placement.kind !== "collection" &&
            instance.placement.flipped
          ) {
            content.pivot.set(definition.visual.sizePx.width / 2, 0);
            content.position.set(definition.visual.sizePx.width / 2, 0);
            content.scale.x = -1;
          }
          rotated.addChild(content);
          applyQuarterTurn(rotated, definition, instance);
          outer.addChild(rotated);
          outer.position.set(origin.x, origin.y);
          outer.zIndex = visualDepth(
            instance,
            definition,
            origin,
            instances,
            definitions,
          );

          const rotatedSize = layout.sizePx;
          const hitArea = new Rectangle(
            0,
            0,
            rotatedSize.width,
            rotatedSize.height,
          );
          outer.hitArea = hitArea;
          const canInteract =
            definition.layer !== "effect" && definition.layer !== "foreground";
          outer.eventMode = canInteract ? "static" : "none";
          outer.cursor =
            mode === "build" &&
            !instance.locked &&
            instance.placement.kind === "zone"
              ? "grab"
              : "pointer";
          let dragging = false;
          let moved = false;
          let startPoint: TerritoryGridPoint | null = null;
          let nextPoint: TerritoryGridPoint | null = null;
          const originalOrigin = { ...origin };
          outer.on("pointerdown", (event: FederatedPointerEvent) => {
            event.stopPropagation();
            if (
              mode !== "build" ||
              instance.locked ||
              instance.placement.kind !== "zone" ||
              definition.layer === "terrain" ||
              definition.layer === "structure"
            ) {
              return;
            }
            dragging = true;
            moved = false;
            startPoint = pointFromEvent(
              event,
              root,
              view.zone.bounds.width,
              view.zone.bounds.height,
            );
            nextPoint = instance.placement.point;
            outer.cursor = "grabbing";
          });
          outer.on("globalpointermove", (event: FederatedPointerEvent) => {
            if (
              !dragging ||
              !startPoint ||
              instance.placement.kind !== "zone"
            ) {
              return;
            }
            const current = pointFromEvent(
              event,
              root,
              view.zone.bounds.width,
              view.zone.bounds.height,
            );
            nextPoint = {
              x: Math.max(
                0,
                Math.min(
                  view.zone.bounds.width - 1,
                  instance.placement.point.x + current.x - startPoint.x,
                ),
              ),
              y: Math.max(
                0,
                Math.min(
                  view.zone.bounds.height - 1,
                  instance.placement.point.y + current.y - startPoint.y,
                ),
              ),
            };
            moved ||=
              nextPoint.x !== instance.placement.point.x ||
              nextPoint.y !== instance.placement.point.y;
            outer.position.set(
              nextPoint.x * TERRITORY_WORLD_UNIT_PX +
                instance.placement.offsetPx.x,
              nextPoint.y * TERRITORY_WORLD_UNIT_PX +
                instance.placement.offsetPx.y,
            );
          });
          const finish = (event: FederatedPointerEvent) => {
            event.stopPropagation();
            if (!dragging) {
              if (mode === "explore") {
                if (event.button === 2) {
                  handlersRef.current.onSelectionChange(null, false);
                  handlersRef.current.onPetMove(
                    pointFromEvent(
                      event,
                      root,
                      view.zone.bounds.width,
                      view.zone.bounds.height,
                    ),
                  );
                } else if (definition.layer === "terrain") {
                  handlersRef.current.onSelectionChange(null, false);
                } else {
                  handlersRef.current.onSelectionChange(instance.id, false);
                }
              } else {
                handlersRef.current.onSelectionChange(
                  instance.id,
                  event.metaKey || event.ctrlKey,
                );
              }
              return;
            }
            dragging = false;
            outer.cursor = "grab";
            if (!moved || !nextPoint) {
              handlersRef.current.onSelectionChange(
                instance.id,
                event.metaKey || event.ctrlKey,
              );
              return;
            }
            void handlersRef.current
              .onInstanceMove(instance, nextPoint)
              .then((accepted) => {
                if (!accepted)
                  outer.position.set(originalOrigin.x, originalOrigin.y);
              });
          };
          outer.on("pointerup", finish);
          outer.on("pointerupoutside", finish);
          root.addChild(outer);
        }

        runtime.app.canvas.dataset["territoryRenderStrategy"] =
          "zone-projection+direct-tree+asset-cache";

        fitWorld(runtime, worldWidth, worldHeight);
        setSceneGeneration((value) => value + 1);
      })
      .catch(() => {
        if (!disposed && runtime.root === root)
          setRenderError("无法渲染领地物件。");
      });

    fitWorld(runtime, worldWidth, worldHeight);
    return () => {
      disposed = true;
      if (runtime.root === root) destroyWorld(runtime);
    };
  }, [
    assets,
    mode,
    previewActions,
    runtimeGeneration,
    selectedCollectionInstance,
    selectedInstanceIds,
    view,
    visibleLayers,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const root = runtime?.root;
    if (!runtime || !root || sceneGeneration === 0) return;
    let disposed = false;
    runtime.petController?.destroy();
    runtime.petController = undefined;
    setPetReady(false);
    const initialPosition =
      movementRef.current?.path[0] ?? petStateRef.current.point;
    void renderTerritoryWorldPetLayer({
      accent: view.style.palette.accent,
      animationSpeed,
      initialPosition,
      onMovementComplete: (movementId) =>
        handlersRef.current.onMovementComplete(movementId),
      onPetPositionChange: (position) =>
        handlersRef.current.onPetPositionChange(position),
      pet: activePet,
      root,
      runtime,
    })
      .then((controller) => {
        if (disposed || runtime.root !== root) {
          controller.destroy();
          return;
        }
        runtime.petController = controller;
        runtime.app.canvas.dataset["petControllerMounts"] = String(
          Number(runtime.app.canvas.dataset["petControllerMounts"] ?? 0) + 1,
        );
        controller.retarget(movementRef.current, petStateRef.current);
        setPetReady(true);
      })
      .catch(() => {
        if (!disposed && runtime.root === root) {
          setRenderError("无法读取当前桌宠图像。");
        }
      });
    return () => {
      disposed = true;
      runtime.petController?.destroy();
      runtime.petController = undefined;
    };
  }, [activePet, animationSpeed, sceneGeneration, view.style.palette.accent]);

  useEffect(() => {
    movementRef.current = movement;
    petStateRef.current = petState;
    runtimeRef.current?.petController?.retarget(movement, petState);
  }, [movement, petState]);

  return (
    <div className={styles["worldCanvasFrame"]}>
      <div
        ref={hostRef}
        className={styles["worldCanvasHost"]}
        data-pet-render-ready={activePet && petReady ? "true" : undefined}
        data-testid="territory-world-canvas"
        role="img"
        aria-label={`${view.zone.name} 领地。${
          mode === "build"
            ? "当前为建造模式，可以选择或拖动物件。"
            : "当前为探索模式，右键移动桌宠，左键只选择和查看。"
        }`}
      />
      <div className={styles["canvasLegend"]} aria-hidden="true">
        <span>
          {mode === "build"
            ? "拖动布置 · Shift 拖动画布 · 滚轮缩放"
            : "右键移动 · 左键查看 · Shift 拖动画布 · 滚轮缩放"}
        </span>
      </div>
      {renderError ? (
        <p className={styles["canvasError"]} role="alert">
          {renderError}
        </p>
      ) : null}
    </div>
  );
}
