import {
  Archive,
  BookOpen,
  FlipHorizontal2,
  Grid3X3,
  History,
  ImagePlus,
  Map,
  PackageOpen,
  Pin,
  PinOff,
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
import type { ProviderApi } from "../../../shared/contracts/provider";
import type {
  TerritoryApi,
  TerritoryItem,
  TerritoryItemCandidate,
  TerritoryPoint,
  TerritoryRotation,
  TerritorySceneTarget,
  TerritorySceneId,
  TerritorySceneSummary,
  TerritorySnapshot,
} from "../../../shared/contracts/territory";
import { territoryAssetUrl } from "../../../shared/pure/territoryAsset";
import styles from "./TerritoryPage.module.css";
import { TerritoryImagePanel } from "./TerritoryImagePanel";
import type { TerritoryItemTransform as ItemTransform } from "./territoryItemLayer";
import type {
  RenderedPetPosition,
  TerritoryMovement,
} from "./territoryPetLayer";

const PixiTerritoryCanvas = lazy(async () => {
  const module = await import("./PixiTerritoryCanvas");
  return { default: module.PixiTerritoryCanvas };
});

interface TerritoryPageProps {
  readonly activePet: PetDescriptor | undefined;
  readonly animationSpeed: number;
  readonly api?: TerritoryApi;
  readonly focusCandidateId?: string;
  readonly onFocusConsumed?: () => void;
  readonly onOpenMemorySource?: (memoryId: string) => void;
  readonly providerApi?: Pick<ProviderApi, "listProfiles">;
}

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp));
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

function nextRotation(
  item: TerritoryItem,
  rotation: TerritoryRotation,
): TerritoryRotation {
  const rotations = item.manifest.transforms.rotations;
  const index = rotations.indexOf(rotation);
  return rotations[(index + 1) % rotations.length] ?? 0;
}

function visualKey(item: TerritoryItem): string {
  const source = item.manifest.visual.source;
  return source.kind === "builtin" ? source.key : "generated-asset";
}

function itemKindLabel(item: TerritoryItem): string {
  if (item.target.kind === "collection") return "收藏库物件";
  return item.manifest.placement.mode === "surface" ? "桌面小物" : "场景物件";
}

function itemFormationTimestamp(item: TerritoryItem): string {
  return item.versions.reduce(
    (earliest, version) =>
      version.createdAt < earliest ? version.createdAt : earliest,
    item.versions[0]?.createdAt ?? item.updatedAt,
  );
}

function ItemSwatch({ item }: { readonly item: TerritoryItem }) {
  const source = item.manifest.visual.source;
  return (
    <span
      className={styles["itemSwatch"]}
      data-kind={visualKey(item)}
      data-placement={item.manifest.placement.mode}
      data-source={source.kind}
    >
      {source.kind === "asset" ? (
        <img
          alt=""
          aria-hidden="true"
          src={territoryAssetUrl(source.assetId)}
        />
      ) : null}
    </span>
  );
}

export function TerritoryPage({
  activePet,
  animationSpeed,
  api = window.charaMate.territory,
  focusCandidateId,
  onFocusConsumed,
  onOpenMemorySource,
  providerApi,
}: TerritoryPageProps) {
  const [snapshot, setSnapshot] = useState<TerritorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"edit" | "explore">("explore");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [imagePanelOpen, setImagePanelOpen] = useState(
    Boolean(focusCandidateId),
  );
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemCandidateId, setSelectedItemCandidateId] = useState<
    string | null
  >(focusCandidateId ?? null);
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
  const selectedItemCandidate = useMemo<TerritoryItemCandidate | undefined>(
    () =>
      snapshot?.itemCandidates.find(({ id }) => id === selectedItemCandidateId),
    [selectedItemCandidateId, snapshot?.itemCandidates],
  );

  useEffect(() => {
    if (!focusCandidateId || !snapshot) return;
    onFocusConsumed?.();
  }, [focusCandidateId, onFocusConsumed, snapshot]);

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
        if (
          item.target.kind === "collection" &&
          item.manifest.placement.mode === "surface"
        ) {
          setDrawerOpen(false);
        }
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
              ? response.value.path.length > 1
                ? [visualStart, ...response.value.path.slice(1)]
                : [visualStart, first]
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
      target: TerritorySceneTarget,
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
          target,
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

  const setItemPinned = async (item: TerritoryItem) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await api.setItemPinned({
        itemId: item.id,
        pinned: !item.pinned,
      });
      if (response.ok) setSnapshot(response.value);
      else setError(response.error.message);
    } catch {
      setError("无法更新物件置顶状态，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const selectItemVersion = async (itemId: string, revision: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await api.selectItemVersion({ itemId, revision });
      if (response.ok) setSnapshot(response.value);
      else setError(response.error.message);
    } catch {
      setError("无法切换这个物件版本，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openItemCandidate = (candidate: TerritoryItemCandidate) => {
    setSelectedItemCandidateId(candidate.id);
    setDrawerOpen(false);
    setImagePanelOpen(true);
  };

  const transformSelected = (transform: ItemTransform) => {
    if (!selectedItem) return;
    setSelectedTransform(transform);
    if (selectedItem.target.kind !== "collection") {
      void placeItem(selectedItem, selectedItem.target, transform);
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
            onClick={() => {
              setDrawerOpen(false);
              setSelectedItemCandidateId(null);
              setImagePanelOpen((open) => !open);
            }}
          >
            <ImagePlus aria-hidden="true" size={15} />
            生成物件
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
            <p>{itemKindLabel(selectedItem)}</p>
            <h3>{selectedItem.manifest.name}</h3>
            <span>{selectedItem.manifest.description}</span>
            <div className={styles["itemMeta"]}>
              <small>
                {selectedItem.manifest.visual.source.kind === "builtin"
                  ? "CharaMate 内置"
                  : "图片资产生成"}
              </small>
              {selectedItem.manifest.placement.mode === "surface" ? (
                <small>适用于桌面插槽</small>
              ) : selectedItem.manifest.surfaceSlots.length > 0 ? (
                <small>
                  {selectedItem.manifest.surfaceSlots.length} 个桌面插槽
                </small>
              ) : (
                <small>
                  {selectedItem.manifest.placement.plane === "underlay"
                    ? "可踩踏覆盖物"
                    : "脚点碰撞物件"}
                </small>
              )}
              <small>
                形成于 {dateLabel(itemFormationTimestamp(selectedItem))}
              </small>
            </div>
            {selectedItem.sources.length ? (
              <section className={styles["itemSources"]}>
                {selectedItem.sources.map((source) => (
                  <div key={`${source.kind}:${source.id}`}>
                    <span>
                      <small>
                        {source.kind === "memory"
                          ? "Memory 来源"
                          : "Activity 趋势"}
                        {" · "}
                        {dateLabel(source.occurredAt)}
                      </small>
                      <strong>{source.label}</strong>
                    </span>
                    {source.kind === "memory" && onOpenMemorySource ? (
                      <button
                        type="button"
                        onClick={() => onOpenMemorySource(source.id)}
                      >
                        <BookOpen aria-hidden="true" size={12} />在 Memory
                        中查看
                      </button>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}
            <div className={styles["itemActions"]}>
              <button
                disabled={busy}
                type="button"
                onClick={() => void setItemPinned(selectedItem)}
              >
                {selectedItem.pinned ? (
                  <PinOff aria-hidden="true" size={14} />
                ) : (
                  <Pin aria-hidden="true" size={14} />
                )}
                {selectedItem.pinned ? "取消置顶" : "置顶"}
              </button>
              {selectedItem.versions.length > 1 ? (
                <label className={styles["itemVersion"]}>
                  <History aria-hidden="true" size={13} />
                  <span>版本</span>
                  <select
                    aria-label="物件版本"
                    disabled={busy}
                    value={selectedItem.manifest.revision}
                    onChange={(event) =>
                      void selectItemVersion(
                        selectedItem.id,
                        Number(event.currentTarget.value),
                      )
                    }
                  >
                    {selectedItem.versions.map((version) => (
                      <option key={version.revision} value={version.revision}>
                        v{version.revision} · {dateLabel(version.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {mode === "edit" ? (
                <>
                  {selectedItem.manifest.transforms.rotations.length > 1 ? (
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        transformSelected({
                          ...selectedTransform,
                          rotation: nextRotation(
                            selectedItem,
                            selectedTransform.rotation,
                          ),
                        })
                      }
                    >
                      <RotateCw aria-hidden="true" size={14} />
                      旋转
                    </button>
                  ) : null}
                  {selectedItem.manifest.transforms.flippable ? (
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
                  {selectedItem.target.kind !== "collection" ? (
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => void collectItem(selectedItem)}
                    >
                      <Archive aria-hidden="true" size={14} />
                      收回
                    </button>
                  ) : (
                    <span>
                      {selectedItem.manifest.placement.mode === "surface"
                        ? "点击场景中发光的桌面插槽"
                        : "选择高亮网格即可放入场景"}
                    </span>
                  )}
                </>
              ) : null}
            </div>
          </article>
        ) : null}

        {imagePanelOpen ? (
          <TerritoryImagePanel
            api={api}
            candidates={snapshot.imageCandidates}
            {...(selectedItemCandidate
              ? { itemCandidate: selectedItemCandidate }
              : {})}
            onAccepted={() => {
              setImagePanelOpen(false);
              setSelectedItemCandidateId(null);
              setMode("edit");
              setDrawerOpen(true);
            }}
            onClose={() => {
              setImagePanelOpen(false);
              setSelectedItemCandidateId(null);
            }}
            onSnapshot={setSnapshot}
            providerApi={providerApi ?? window.charaMate.provider}
            sceneId={activeScene.definition.id}
          />
        ) : null}

        {drawerOpen ? (
          <aside className={styles["collectionDrawer"]} aria-label="领地收藏库">
            <header>
              <span>
                <strong>收藏库</strong>
                <small>
                  场景 {activeScene.placements.length}/{activeScene.capacity} ·
                  超出后最早且未置顶的物件会自动收回
                </small>
              </span>
              <button
                type="button"
                aria-label="关闭收藏库"
                onClick={() => setDrawerOpen(false)}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            {snapshot.itemCandidates.length ? (
              <section>
                <h3>记忆候选</h3>
                <div className={styles["itemList"]}>
                  {snapshot.itemCandidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => openItemCandidate(candidate)}
                    >
                      <span className={styles["memoryCandidateSwatch"]}>
                        <BookOpen aria-hidden="true" size={17} />
                      </span>
                      <span>
                        <strong>{candidate.name}</strong>
                        <small>
                          {candidate.status === "materialized"
                            ? "已有物件 · 生成新版本"
                            : "等待生成"}
                          {" · "}
                          {candidate.sources[0]?.label}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
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
                    <ItemSwatch item={item} />
                    <span>
                      <strong>{item.manifest.name}</strong>
                      <small>
                        {item.manifest.placement.mode === "surface"
                          ? "桌面小物 · 点击查看"
                          : item.manifest.surfaceSlots.length > 0
                            ? `${String(item.manifest.surfaceSlots.length)} 个桌面插槽`
                            : item.manifest.description}
                      </small>
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
                      <ItemSwatch item={item} />
                      <span>
                        <strong>{item.manifest.name}</strong>
                        <small>
                          {item.manifest.placement.mode === "surface"
                            ? "小插件 · 选择后点击桌面插槽"
                            : "选择后点击场景中的高亮网格"}
                        </small>
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
