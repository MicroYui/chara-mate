// Installs Pixi's static uniform synchronizers for a strict CSP (no unsafe-eval).
import "pixi.js/unsafe-eval";
import {
  Application,
  Container,
  Rectangle,
  type FederatedPointerEvent,
  type Texture,
} from "pixi.js";
import { useEffect, useRef, useState } from "react";

import type { PetDescriptor } from "../../../shared/contracts/pet";
import type {
  TerritoryActiveScene,
  TerritoryItem,
  TerritoryPoint,
  TerritorySceneTarget,
} from "../../../shared/contracts/territory";
import styles from "./TerritoryPage.module.css";
import {
  createTerritoryEnvironment,
  TERRITORY_SCENE_HEIGHT,
  TERRITORY_SCENE_WIDTH,
} from "./territoryArt";
import {
  renderTerritoryItemLayer,
  territoryPointFromEvent,
  type TerritoryItemTransform,
} from "./territoryItemLayer";
import {
  renderTerritoryPetLayer,
  type RenderedPetPosition,
  type TerritoryMovement,
} from "./territoryPetLayer";

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
    target: TerritorySceneTarget,
    transform: TerritoryItemTransform,
  ) => Promise<boolean>;
  readonly scene: TerritoryActiveScene;
  readonly selectedItem: TerritoryItem | null;
  readonly selectedTransform: TerritoryItemTransform;
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
    setRenderError(null);

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
      const point = territoryPointFromEvent(event, root);
      if (
        mode === "edit" &&
        selectedItem?.manifest.placement.mode === "ground"
      ) {
        void onPlaceRequest(
          selectedItem,
          {
            kind: "ground",
            sceneId: scene.definition.id,
            ...point,
          },
          selectedTransform,
        );
      } else if (mode === "explore") {
        onItemSelect(null);
        onMoveRequest(point);
      }
    });
    root.addChild(environment);

    delete runtime.app.canvas.dataset["territoryAssetIds"];
    delete runtime.app.canvas.dataset["territoryAssetFailures"];
    void renderTerritoryItemLayer({
      isCurrent: () => runtime.root === root,
      mode,
      onItemSelect,
      onMoveRequest,
      onPlaceRequest,
      root,
      scene,
      selectedItem,
      selectedTransform,
    })
      .then((result) => {
        if (!result || runtime.root !== root) return;
        if (result.renderedAssetIds.length > 0) {
          runtime.app.canvas.dataset["territoryAssetIds"] =
            result.renderedAssetIds.join(",");
        }
        if (result.failedAssetIds.length > 0) {
          runtime.app.canvas.dataset["territoryAssetFailures"] =
            result.failedAssetIds.join(",");
          setRenderError("部分领地物件图片无法读取，已显示占位图。");
        }
      })
      .catch(() => {
        if (runtime.root === root) setRenderError("无法渲染领地物件。");
      });

    fitScene(runtime);
    void renderTerritoryPetLayer({
      animationSpeed,
      movement,
      onMovementComplete,
      onPetPositionChange,
      pet: activePet,
      root,
      runtime,
      scene,
    })
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
