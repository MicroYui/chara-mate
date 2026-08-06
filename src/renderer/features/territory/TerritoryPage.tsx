import {
  Archive,
  FlipHorizontal2,
  Grid3X3,
  Map,
  PackageOpen,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type { PetDescriptor } from "../../../shared/contracts/pet";
import type {
  TerritoryApi,
  TerritoryItem,
  TerritoryPoint,
  TerritoryRotation,
  TerritorySceneId,
  TerritorySceneSummary,
  TerritorySnapshot,
} from "../../../shared/contracts/territory";
import styles from "./TerritoryPage.module.css";

const PixiTerritoryCanvas = lazy(async () => {
  const module = await import("./PixiTerritoryCanvas");
  return { default: module.PixiTerritoryCanvas };
});

interface TerritoryPageProps {
  readonly activePet: PetDescriptor | undefined;
  readonly animationSpeed: number;
  readonly api?: TerritoryApi;
}

interface ItemTransform {
  readonly flipped: boolean;
  readonly rotation: TerritoryRotation;
}

interface TerritoryMovement {
  readonly id: number;
  readonly path: readonly RenderedPetPosition[];
}

interface RenderedPetPosition {
  readonly x: number;
  readonly y: number;
}

function scenePreviewStyle(scene: TerritorySceneSummary): CSSProperties {
  return {
    "--scene-accent": scene.palette.accent,
    "--scene-floor": scene.palette.floor,
    "--scene-shadow": scene.palette.shadow,
    "--scene-sky": scene.palette.sky,
    "--scene-wall": scene.palette.wall,
  } as CSSProperties;
}

function ScenePreview({ scene }: { readonly scene: TerritorySceneSummary }) {
  return (
    <span className={styles["scenePreview"]} style={scenePreviewStyle(scene)}>
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function ScenePicker({
  activeSceneId,
  busy,
  onClose,
  onSelect,
  scenes,
}: {
  readonly activeSceneId: TerritorySceneId | null;
  readonly busy: boolean;
  readonly onClose?: () => void;
  readonly onSelect: (sceneId: TerritorySceneId) => void;
  readonly scenes: readonly TerritorySceneSummary[];
}) {
  return (
    <section
      className={styles["scenePicker"]}
      aria-labelledby="territory-first-title"
    >
      {onClose ? (
        <button
          className={styles["closePicker"]}
          type="button"
          aria-label="关闭场景选择"
          onClick={onClose}
        >
          <X aria-hidden="true" size={17} />
        </button>
      ) : null}
      <p className={styles["eyebrow"]}>Choose a place</p>
      <h2 id="territory-first-title">
        {activeSceneId ? "换一个地方看看" : "先选一处想停留的地方"}
      </h2>
      <p className={styles["pickerLead"]}>
        四个场景都已保存在本地，选择后立刻出现；之后的故事会慢慢为这里添上新的东西。
      </p>
      <div className={styles["sceneGrid"]}>
        {scenes.map((scene) => (
          <button
            key={scene.id}
            className={styles["sceneCard"]}
            data-active={scene.id === activeSceneId || undefined}
            disabled={busy}
            type="button"
            onClick={() => onSelect(scene.id)}
          >
            <ScenePreview scene={scene} />
            <span className={styles["sceneCardCopy"]}>
              <strong>{scene.name}</strong>
              <small>{scene.description}</small>
              <em>{scene.poem}</em>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function findItem(snapshot: TerritorySnapshot, itemId: string | null) {
  if (!itemId) return null;
  return (
    snapshot.activeScene?.placements.find(({ id }) => id === itemId) ??
    snapshot.collection.find(({ id }) => id === itemId) ??
    null
  );
}

function nextRotation(rotation: TerritoryRotation): TerritoryRotation {
  return ((rotation + 90) % 360) as TerritoryRotation;
}

export function TerritoryPage({
  activePet,
  animationSpeed,
  api = window.charaMate.territory,
}: TerritoryPageProps) {
  const [snapshot, setSnapshot] = useState<TerritorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"edit" | "explore">("explore");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedTransform, setSelectedTransform] = useState<ItemTransform>({
    flipped: false,
    rotation: 0,
  });
  const [movement, setMovement] = useState<TerritoryMovement | null>(null);
  const busyRef = useRef(false);
  const movementSequenceRef = useRef(0);
  const renderedPetPositionRef = useRef<RenderedPetPosition | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .getSnapshot()
      .then((response) => {
        if (!active) return;
        if (response.ok) {
          setSnapshot(response.value);
          const pet = response.value.activeScene?.pet;
          renderedPetPositionRef.current = pet ? { x: pet.x, y: pet.y } : null;
        } else setError(response.error.message);
      })
      .catch(() => {
        if (active) setError("无法读取领地，请重试。");
      });
    return () => {
      active = false;
    };
  }, [api]);

  const selectedItem = useMemo(
    () => (snapshot ? findItem(snapshot, selectedItemId) : null),
    [selectedItemId, snapshot],
  );

  const selectItem = useCallback(
    (itemId: string | null) => {
      setSelectedItemId(itemId);
      if (!snapshot || !itemId) return;
      const item = findItem(snapshot, itemId);
      if (item) {
        setSelectedTransform({
          flipped: item.flipped,
          rotation: item.rotation,
        });
      }
    },
    [snapshot],
  );

  const selectScene = async (sceneId: TerritorySceneId) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await api.selectScene({ sceneId });
      if (response.ok) {
        setSnapshot(response.value);
        const pet = response.value.activeScene?.pet;
        renderedPetPositionRef.current = pet ? { x: pet.x, y: pet.y } : null;
        setScenePickerOpen(false);
        setSelectedItemId(null);
        setMovement(null);
      } else {
        setError(response.error.message);
      }
    } catch {
      setError("无法打开这个场景，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const movePet = useCallback(
    (point: TerritoryPoint) => {
      const activeScene = snapshot?.activeScene;
      if (!activeScene || busyRef.current) return;
      const visualStart = renderedPetPositionRef.current ?? {
        x: activeScene.pet.x,
        y: activeScene.pet.y,
      };
      const from = {
        x: Math.max(
          0,
          Math.min(activeScene.definition.width - 1, Math.round(visualStart.x)),
        ),
        y: Math.max(
          0,
          Math.min(
            activeScene.definition.height - 1,
            Math.round(visualStart.y),
          ),
        ),
      };
      busyRef.current = true;
      setBusy(true);
      setError(null);
      void api
        .movePet({ from, sceneId: activeScene.definition.id, ...point })
        .then((response) => {
          if (!response.ok) {
            setError(response.error.message);
            return;
          }
          const first = response.value.path[0];
          const path =
            first &&
            (Math.abs(first.x - visualStart.x) > 0.001 ||
              Math.abs(first.y - visualStart.y) > 0.001)
              ? [visualStart, ...response.value.path]
              : response.value.path;
          setSnapshot(response.value.snapshot);
          if (path.length <= 1) {
            setMovement(null);
            return;
          }
          const id = movementSequenceRef.current + 1;
          movementSequenceRef.current = id;
          setMovement({ id, path });
        })
        .catch(() => setError("桌宠暂时走不到那里。"))
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [api, snapshot?.activeScene],
  );

  const trackPetPosition = useCallback((position: RenderedPetPosition) => {
    renderedPetPositionRef.current = { x: position.x, y: position.y };
  }, []);

  const placeItem = useCallback(
    async (
      item: TerritoryItem,
      point: TerritoryPoint,
      transform: ItemTransform,
    ): Promise<boolean> => {
      const sceneId = snapshot?.activeScene?.definition.id;
      if (!sceneId || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const response = await api.placeItem({
          flipped: transform.flipped,
          itemId: item.id,
          rotation: transform.rotation,
          sceneId,
          ...point,
        });
        if (!response.ok) {
          setError(response.error.message);
          return false;
        }
        setSnapshot(response.value);
        setSelectedItemId(item.id);
        setSelectedTransform(transform);
        return true;
      } catch {
        setError("无法保存这次布置，请重试。");
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, snapshot?.activeScene?.definition.id],
  );

  const collectItem = async (item: TerritoryItem) => {
    const sceneId = snapshot?.activeScene?.definition.id;
    if (!sceneId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await api.collectItem({ itemId: item.id, sceneId });
      if (response.ok) {
        setSnapshot(response.value);
        setSelectedItemId(item.id);
        setDrawerOpen(true);
      } else {
        setError(response.error.message);
      }
    } catch {
      setError("无法收回这个物件，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const transformSelected = (transform: ItemTransform) => {
    if (!selectedItem) return;
    setSelectedTransform(transform);
    if (
      selectedItem.location === "scene" &&
      selectedItem.x !== null &&
      selectedItem.y !== null
    ) {
      void placeItem(
        selectedItem,
        { x: selectedItem.x, y: selectedItem.y },
        transform,
      );
    }
  };

  const completeMovement = useCallback((id: number) => {
    setMovement((current) => {
      if (current?.id !== id) return current;
      return null;
    });
  }, []);

  if (!snapshot) {
    return (
      <section className={styles["loadingPage"]} aria-live="polite">
        {error ? <p role="alert">{error}</p> : <p>正在打开领地…</p>}
      </section>
    );
  }

  const activeScene = snapshot.activeScene;
  if (!activeScene) {
    return (
      <div className={styles["firstExperience"]}>
        {error ? (
          <div className={styles["errorBanner"]} role="alert">
            {error}
          </div>
        ) : null}
        <ScenePicker
          activeSceneId={null}
          busy={busy}
          onSelect={(sceneId) => void selectScene(sceneId)}
          scenes={snapshot.availableScenes}
        />
      </div>
    );
  }

  return (
    <section className={styles["territoryPage"]}>
      <div className={styles["territoryToolbar"]}>
        <div className={styles["sceneIdentity"]}>
          <span
            className={styles["sceneDot"]}
            style={{ background: activeScene.definition.palette.accent }}
          />
          <span>
            <strong>{activeScene.definition.name}</strong>
            <small>{activeScene.definition.poem}</small>
          </span>
        </div>
        <div className={styles["toolbarActions"]}>
          <div className={styles["modeSwitch"]} aria-label="领地模式">
            <button
              aria-pressed={mode === "explore"}
              type="button"
              onClick={() => setMode("explore")}
            >
              <Map aria-hidden="true" size={15} />
              游览
            </button>
            <button
              aria-pressed={mode === "edit"}
              type="button"
              onClick={() => {
                setMode("edit");
                setDrawerOpen(true);
              }}
            >
              <Grid3X3 aria-hidden="true" size={15} />
              布置
            </button>
          </div>
          <button
            className={styles["toolbarButton"]}
            type="button"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <PackageOpen aria-hidden="true" size={15} />
            收藏库
          </button>
          <button
            className={styles["toolbarButton"]}
            type="button"
            onClick={() => setScenePickerOpen(true)}
          >
            <Sparkles aria-hidden="true" size={15} />
            换场景
          </button>
        </div>
      </div>

      <div className={styles["sceneStage"]}>
        <Suspense
          fallback={
            <div className={styles["canvasLoading"]}>正在铺开像素场景…</div>
          }
        >
          <PixiTerritoryCanvas
            activePet={activePet}
            animationSpeed={animationSpeed}
            mode={mode}
            movement={movement}
            onItemSelect={selectItem}
            onMoveRequest={movePet}
            onMovementComplete={completeMovement}
            onPetPositionChange={trackPetPosition}
            onPlaceRequest={placeItem}
            scene={activeScene}
            selectedItem={selectedItem}
            selectedTransform={selectedTransform}
          />
        </Suspense>

        {!activePet ? (
          <div className={styles["petHint"]}>
            导入并选择桌宠后，它会出现在这束光的位置。
          </div>
        ) : null}

        {selectedItem ? (
          <article className={styles["itemDetail"]}>
            <button
              type="button"
              aria-label="关闭物件详情"
              onClick={() => selectItem(null)}
            >
              <X aria-hidden="true" size={14} />
            </button>
            <p>{selectedItem.location === "scene" ? "场景物件" : "收藏库"}</p>
            <h3>{selectedItem.name}</h3>
            <span>{selectedItem.description}</span>
            {mode === "edit" ? (
              <div className={styles["itemActions"]}>
                {selectedItem.rotatable ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      transformSelected({
                        ...selectedTransform,
                        rotation: nextRotation(selectedTransform.rotation),
                      })
                    }
                  >
                    <RotateCw aria-hidden="true" size={14} />
                    旋转
                  </button>
                ) : null}
                {selectedItem.flippable ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      transformSelected({
                        ...selectedTransform,
                        flipped: !selectedTransform.flipped,
                      })
                    }
                  >
                    <FlipHorizontal2 aria-hidden="true" size={14} />
                    翻转
                  </button>
                ) : null}
                {selectedItem.location === "scene" ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void collectItem(selectedItem)}
                  >
                    <Archive aria-hidden="true" size={14} />
                    收回
                  </button>
                ) : (
                  <span>选择高亮网格即可放入场景</span>
                )}
              </div>
            ) : null}
          </article>
        ) : null}

        {drawerOpen ? (
          <aside className={styles["collectionDrawer"]} aria-label="领地收藏库">
            <header>
              <span>
                <strong>收藏库</strong>
                <small>拖动场景物件，或选择物件后点击网格。</small>
              </span>
              <button
                type="button"
                aria-label="关闭收藏库"
                onClick={() => setDrawerOpen(false)}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            <section>
              <h3>场景中</h3>
              <div className={styles["itemList"]}>
                {activeScene.placements.map((item) => (
                  <button
                    key={item.id}
                    data-selected={item.id === selectedItemId || undefined}
                    type="button"
                    onClick={() => selectItem(item.id)}
                  >
                    <span
                      className={styles["itemSwatch"]}
                      data-kind={item.visual}
                    />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>已收回</h3>
              {snapshot.collection.length ? (
                <div className={styles["itemList"]}>
                  {snapshot.collection.map((item) => (
                    <button
                      key={item.id}
                      data-selected={item.id === selectedItemId || undefined}
                      type="button"
                      onClick={() => selectItem(item.id)}
                    >
                      <span
                        className={styles["itemSwatch"]}
                        data-kind={item.visual}
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>选择后点击场景中的高亮网格</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className={styles["emptyCollection"]}>
                  收回的物件会完整保存在这里。
                </p>
              )}
            </section>
          </aside>
        ) : null}

        {error ? (
          <div className={styles["errorBanner"]} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        ) : null}
      </div>

      {scenePickerOpen ? (
        <div className={styles["pickerOverlay"]}>
          <ScenePicker
            activeSceneId={activeScene.definition.id}
            busy={busy}
            onClose={() => setScenePickerOpen(false)}
            onSelect={(sceneId) => void selectScene(sceneId)}
            scenes={snapshot.availableScenes}
          />
        </div>
      ) : null}
    </section>
  );
}
