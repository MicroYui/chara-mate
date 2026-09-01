import {
  Archive,
  Box,
  Brush,
  Copy,
  Eye,
  EyeOff,
  FlipHorizontal2,
  Group,
  Hammer,
  Heart,
  History,
  Layers3,
  Lock,
  LockOpen,
  Map as MapIcon,
  PackageOpen,
  Pencil,
  Redo2,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Ungroup,
  WandSparkles,
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
} from "react";

import type { PetDescriptor } from "../../../shared/contracts/pet";
import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import type {
  TerritoryCandidateIntent,
  TerritoryChangeCandidate,
  TerritoryDefinition,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryLayer,
  TerritoryPetActionPerformed,
  TerritoryPetState,
  TerritoryRotation,
  TerritoryWorldApi,
  TerritoryWorldMutation,
  TerritoryWorldSnapshot,
  TerritoryZoneView,
} from "../../../shared/contracts/territoryWorld";
import {
  blockedTerritoryWorldCells,
  findTerritoryWorldPath,
} from "../../../shared/pure/territoryWorldGrid";
import styles from "./TerritoryWorldPage.module.css";
import type { TerritoryWorldPreviewAction } from "./PixiTerritoryWorldCanvas";
import type {
  TerritoryWorldMovement,
  TerritoryWorldRenderedPetPosition,
} from "./territoryWorldPetLayer";

const PixiTerritoryWorldCanvas = lazy(async () => {
  const module = await import("./PixiTerritoryWorldCanvas");
  return { default: module.PixiTerritoryWorldCanvas };
});

const layers: readonly TerritoryLayer[] = [
  "terrain",
  "underlay",
  "structure",
  "object",
  "attachment",
  "foreground",
  "effect",
];

const layerLabels: Record<TerritoryLayer, string> = {
  attachment: "挂接",
  effect: "光效",
  foreground: "前景",
  object: "物件",
  structure: "结构",
  terrain: "地形",
  underlay: "铺装",
};

const emptyPreviewActions: ReadonlyMap<string, TerritoryWorldPreviewAction> =
  new Map();

type Panel = "create" | "history" | "inspector" | "library" | "map" | null;

interface TerritoryPageProps {
  readonly activePet: PetDescriptor | undefined;
  readonly animationSpeed: number;
  readonly api?: TerritoryWorldApi;
  readonly focusCandidateId?: string;
  readonly onFocusConsumed?: () => void;
  readonly onOpenMemorySource?: (memoryId: string) => void;
  readonly providerApi?: Pick<ProviderApi, "listProfiles">;
}

function definitionKey(value: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${value.id}@${String(value.revision)}`;
}

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp));
}

function candidateStatusLabel(
  status: TerritoryChangeCandidate["status"],
): string {
  const labels: Record<TerritoryChangeCandidate["status"], string> = {
    applied: "已应用",
    cancelled: "已取消",
    draft: "待生成",
    failed: "生成失败",
    generating: "正在生成",
    ready: "可预览",
    stale: "需要重新生成",
  };
  return labels[status];
}

function petBehaviorLabel(behavior: TerritoryPetState["behavior"]): string {
  const labels: Record<TerritoryPetState["behavior"], string> = {
    idle: "正在领地里安静停留",
    observing: "正在好奇地观察四周",
    sitting: "正在坐下休息",
    sleeping: "正在安心睡觉",
    walking: "正在领地里走动",
  };
  return labels[behavior];
}

function findDefinition(
  definitions: readonly TerritoryDefinition[],
  instance: TerritoryInstance | null | undefined,
): TerritoryDefinition | null {
  if (!instance) return null;
  return (
    definitions.find(
      (definition) =>
        definition.id === instance.definition.id &&
        definition.revision === instance.definition.revision,
    ) ?? null
  );
}

function nextRotation(
  definition: TerritoryDefinition,
  current: TerritoryRotation,
): TerritoryRotation {
  const index = definition.transforms.rotations.indexOf(current);
  return (
    definition.transforms.rotations[
      (index + 1) % definition.transforms.rotations.length
    ] ?? 0
  );
}

function allRelatedInstanceIds(
  view: TerritoryZoneView,
  roots: ReadonlySet<string>,
): Set<string> {
  const result = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const instance of view.instances) {
      if (
        instance.placement.kind === "attachment" &&
        result.has(instance.placement.parentInstanceId) &&
        !result.has(instance.id)
      ) {
        result.add(instance.id);
        changed = true;
      }
    }
  }
  return result;
}

function candidatePreview(
  base: TerritoryZoneView,
  candidate: TerritoryChangeCandidate | undefined,
): {
  readonly actions: ReadonlyMap<string, TerritoryWorldPreviewAction>;
  readonly view: TerritoryZoneView;
} {
  if (!candidate?.changeSet || candidate.status !== "ready") {
    return { actions: new Map(), view: base };
  }
  const definitions = new Map(
    base.definitions.map((definition) => [
      definitionKey(definition),
      definition,
    ]),
  );
  const instances = new Map(
    base.instances.map((instance) => [instance.id, instance]),
  );
  let zone = base.zone;
  for (const mutation of candidate.changeSet.mutations) {
    if (mutation.kind === "definition.put") {
      definitions.set(definitionKey(mutation.definition), mutation.definition);
    } else if (
      mutation.kind === "instance.put" &&
      mutation.instance.status === "active" &&
      mutation.instance.placement.kind !== "collection" &&
      mutation.instance.placement.zoneId === base.zone.id
    ) {
      instances.set(mutation.instance.id, mutation.instance);
    } else if (mutation.kind === "instance.remove") {
      // Keep removed entities visible so the red deletion preview remains inspectable.
    } else if (
      mutation.kind === "zone.put" &&
      mutation.zone.id === base.zone.id
    ) {
      zone = mutation.zone;
    }
  }
  const actions = new Map<string, TerritoryWorldPreviewAction>();
  for (const group of candidate.previewGroups) {
    for (const instanceId of group.instanceIds) {
      actions.set(instanceId, { action: group.action, label: group.label });
    }
  }
  return {
    actions,
    view: {
      ...base,
      definitions: [...definitions.values()],
      instances: [...instances.values()],
      zone,
    },
  };
}

function ImageProfileSelect({
  onChange,
  profiles,
  value,
}: {
  readonly onChange: (value: string | null) => void;
  readonly profiles: readonly ProviderProfile[];
  readonly value: string | null;
}) {
  return (
    <label className={styles["field"]}>
      <span>图片 Provider</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">自动选择已配置的图片模型</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TerritoryPage({
  activePet,
  animationSpeed,
  api = window.charaMate.territory,
  focusCandidateId,
  onFocusConsumed,
  onOpenMemorySource,
  providerApi = window.charaMate.provider,
}: TerritoryPageProps) {
  const [snapshot, setSnapshot] = useState<TerritoryWorldSnapshot | null>(null);
  const [view, setView] = useState<TerritoryZoneView | null>(null);
  const [mode, setMode] = useState<"build" | "explore">("explore");
  const [panel, setPanel] = useState<Panel>(focusCandidateId ? "create" : null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | null
  >(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    focusCandidateId ?? null,
  );
  const [lastFocusCandidateId, setLastFocusCandidateId] =
    useState(focusCandidateId);
  const [visibleLayers, setVisibleLayers] = useState<Set<TerritoryLayer>>(
    new Set(layers),
  );
  const [search, setSearch] = useState("");
  const [showTrash, setShowTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movement, setMovement] = useState<TerritoryWorldMovement | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [candidateIntent, setCandidateIntent] =
    useState<TerritoryCandidateIntent>("item");
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfile[]>(
    [],
  );
  const [providerProfileId, setProviderProfileId] = useState<string | null>(
    null,
  );
  const [candidateInstruction, setCandidateInstruction] = useState("");
  const [previewSide, setPreviewSide] = useState<"after" | "before">("after");
  const [revealSource, setRevealSource] = useState<{
    readonly label: string;
    readonly occurredAt: string;
  } | null>(null);
  const [excludedChangeIds, setExcludedChangeIds] = useState<Set<string>>(
    new Set(),
  );
  const [editingDefinition, setEditingDefinition] = useState(false);
  const [storyCardExpanded, setStoryCardExpanded] = useState(false);
  const [definitionName, setDefinitionName] = useState("");
  const [definitionDescription, setDefinitionDescription] = useState("");
  const loadSequence = useRef(0);
  const movementSequence = useRef(0);
  const busyRef = useRef(false);
  const petMoveInFlight = useRef(false);
  const pendingPetMove = useRef<TerritoryGridPoint | null>(null);
  const drainPetMovesRef = useRef<() => void>(() => undefined);
  const renderedPetPosition = useRef<TerritoryWorldRenderedPetPosition | null>(
    null,
  );
  const snapshotRef = useRef<TerritoryWorldSnapshot | null>(null);
  const viewRef = useRef<TerritoryZoneView | null>(null);

  if (focusCandidateId !== lastFocusCandidateId) {
    setLastFocusCandidateId(focusCandidateId);
    if (focusCandidateId) {
      setSelectedCandidateId(focusCandidateId);
      setExcludedChangeIds(new Set());
      setPreviewSide("after");
      setPanel("create");
    }
  }

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const loadView = useCallback(
    async (nextSnapshot: TerritoryWorldSnapshot) => {
      const sequence = ++loadSequence.current;
      const response = await api.getZoneView({
        revisionId: nextSnapshot.world.currentRevision.id,
        zoneId: nextSnapshot.world.activeZoneId,
      });
      if (sequence !== loadSequence.current) return false;
      if (!response.ok) {
        setError(response.error.message);
        return false;
      }
      setView(response.value);
      renderedPetPosition.current = response.value.pet
        ? { ...response.value.pet.point }
        : null;
      return true;
    },
    [api],
  );

  const installSnapshot = useCallback(
    async (nextSnapshot: TerritoryWorldSnapshot, reload = true) => {
      setSnapshot(nextSnapshot);
      if (reload) await loadView(nextSnapshot);
    },
    [loadView],
  );

  useEffect(() => {
    let active = true;
    void api
      .getSnapshot()
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setSnapshot(response.value);
        await loadView(response.value);
      })
      .catch(() => {
        if (active) setError("无法读取领地 World，请重试。");
      });
    void providerApi.listProfiles().then((response) => {
      if (!active || !response.ok) return;
      setProviderProfiles(response.value);
      const configured = response.value.find(
        (profile) => "imageModel" in profile && profile.imageModel,
      );
      if (configured) setProviderProfileId(configured.id);
    });
    return () => {
      active = false;
    };
  }, [api, loadView, providerApi]);

  useEffect(
    () =>
      api.subscribeChanged((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        void loadView(nextSnapshot);
      }),
    [api, loadView],
  );

  const installPetMovement = useCallback(
    (
      path: TerritoryPetActionPerformed["path"],
      nextSnapshot: TerritoryWorldSnapshot,
    ) => {
      const currentView = viewRef.current;
      const currentSnapshot = snapshotRef.current;
      if (
        !currentView ||
        !currentSnapshot ||
        currentView.zone.id !== nextSnapshot.pet.zoneId ||
        currentView.revisionId !== nextSnapshot.world.currentRevision.id
      ) {
        setMovement(null);
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        void loadView(nextSnapshot);
        return;
      }

      const renderedFrom = {
        ...(renderedPetPosition.current ?? currentSnapshot.pet.point),
      };
      const renderedCell = {
        x: Math.max(
          0,
          Math.min(
            currentView.zone.bounds.width - 1,
            Math.round(renderedFrom.x),
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            currentView.zone.bounds.height - 1,
            Math.round(renderedFrom.y),
          ),
        ),
      };
      const destination = path.at(-1) ?? renderedCell;
      const reroutedPath = findTerritoryWorldPath(
        currentView.zone,
        renderedCell,
        destination,
        blockedTerritoryWorldCells(currentView),
      );
      const pathFromRenderedPosition = reroutedPath ?? path;
      const nextPath =
        pathFromRenderedPosition.length > 1
          ? [renderedFrom, ...pathFromRenderedPosition.slice(1)]
          : [renderedFrom, destination];
      snapshotRef.current = nextSnapshot;
      if (
        renderedFrom.x === destination.x &&
        renderedFrom.y === destination.y
      ) {
        setMovement(null);
      } else {
        movementSequence.current += 1;
        setMovement({ id: movementSequence.current, path: nextPath });
      }
      // Publish the persisted final state in the same render as the movement
      // path so the Pixi controller can animate from its actual screen point.
      setSnapshot(nextSnapshot);
    },
    [loadView],
  );

  useEffect(
    () =>
      api.subscribePetAction((event) => {
        installPetMovement(event.path, event.snapshot);
      }),
    [api, installPetMovement],
  );

  useEffect(() => {
    if (!focusCandidateId || !snapshot) return;
    onFocusConsumed?.();
  }, [focusCandidateId, onFocusConsumed, snapshot]);

  const selectedInstances = useMemo(
    () =>
      (view?.instances ?? []).filter(({ id: instanceId }) =>
        selectedIds.has(instanceId),
      ),
    [selectedIds, view?.instances],
  );
  const primaryInstance = selectedInstances[0] ?? null;
  const primaryDefinition = useMemo(
    () => findDefinition(snapshot?.definitions ?? [], primaryInstance),
    [primaryInstance, snapshot?.definitions],
  );
  const selectedCollectionInstance = useMemo(
    () =>
      snapshot?.collection.find(
        ({ id: instanceId }) => instanceId === selectedCollectionId,
      ) ?? null,
    [selectedCollectionId, snapshot?.collection],
  );
  const selectedCandidate = useMemo(
    () =>
      snapshot?.candidates.find(
        ({ id: candidateId }) => candidateId === selectedCandidateId,
      ),
    [selectedCandidateId, snapshot?.candidates],
  );
  const selectedMomentSource = useMemo(
    () =>
      selectedCandidate?.sources.find(
        (source) => source.kind === "chat_moment",
      ),
    [selectedCandidate],
  );
  const preview = useMemo(
    () => (view ? candidatePreview(view, selectedCandidate) : null),
    [selectedCandidate, view],
  );
  const showingCandidatePreview =
    selectedCandidate?.status === "ready" && previewSide === "after";

  const commit = useCallback(
    async (label: string, mutations: readonly TerritoryWorldMutation[]) => {
      if (!snapshot || mutations.length === 0 || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const baseRevisionId = snapshot.world.currentRevision.id;
      try {
        const response = await api.commitChangeSet({
          changeSet: {
            baseRevisionId,
            id: id(),
            label,
            mutations: [...mutations],
          },
        });
        if (!response.ok) {
          setError(response.error.message);
          return false;
        }
        setUndoStack((current) => [...current, baseRevisionId]);
        setRedoStack([]);
        await installSnapshot(response.value);
        return true;
      } catch {
        setError("领地修改没有保存，请重试。");
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, installSnapshot, snapshot],
  );

  const selectInstance = useCallback(
    (instanceId: string | null, additive: boolean) => {
      setSelectedCollectionId(null);
      setStoryCardExpanded(false);
      if (!instanceId) {
        setSelectedIds((current) => (current.size === 0 ? current : new Set()));
        setPanel((current) => (current === "inspector" ? null : current));
        return;
      }
      setSelectedIds((current) => {
        if (!additive) return new Set([instanceId]);
        const next = new Set(current);
        if (next.has(instanceId)) next.delete(instanceId);
        else next.add(instanceId);
        return next;
      });
      setPanel("inspector");
    },
    [],
  );

  const moveInstance = useCallback(
    async (instance: TerritoryInstance, point: TerritoryGridPoint) => {
      if (!view || instance.placement.kind !== "zone") return false;
      const roots = selectedIds.has(instance.id)
        ? selectedIds
        : new Set([instance.id]);
      const group = instance.groupId
        ? view.groups.find(({ id: groupId }) => groupId === instance.groupId)
        : undefined;
      const movingIds = new Set(group?.instanceIds ?? roots);
      const delta = {
        x: point.x - instance.placement.point.x,
        y: point.y - instance.placement.point.y,
      };
      const timestamp = now();
      const mutations: TerritoryWorldMutation[] = [];
      for (const candidate of view.instances) {
        if (!movingIds.has(candidate.id) || candidate.placement.kind !== "zone")
          continue;
        mutations.push({
          changeId: id(),
          instance: {
            ...candidate,
            placement: {
              ...candidate.placement,
              point: {
                x: candidate.placement.point.x + delta.x,
                y: candidate.placement.point.y + delta.y,
              },
            },
            updatedAt: timestamp,
          },
          kind: "instance.put",
        });
      }
      return commit(
        mutations.length > 1 ? "移动一组领地物件" : "移动领地物件",
        mutations,
      );
    },
    [commit, selectedIds, view],
  );

  const placeCollection = useCallback(
    async (point: TerritoryGridPoint) => {
      if (!snapshot || !view || !selectedCollectionInstance) return false;
      const definition = findDefinition(
        snapshot.definitions,
        selectedCollectionInstance,
      );
      if (!definition) return false;
      let placement: TerritoryInstance["placement"];
      if (definition.placement.mode === "attachment") {
        const definitions = new Map(
          view.definitions.map((candidate) => [
            definitionKey(candidate),
            candidate,
          ]),
        );
        const supports = view.instances
          .flatMap((candidate) => {
            const supportDefinition = definitions.get(
              definitionKey(candidate.definition),
            );
            if (!supportDefinition || candidate.placement.kind !== "zone")
              return [];
            return supportDefinition.anchors
              .filter((anchor) =>
                definition.placement.mode === "attachment"
                  ? definition.placement.allowedAnchors.includes(anchor.kind)
                  : false,
              )
              .map((anchor) => ({ anchor, candidate }));
          })
          .sort((left, right) => {
            const leftPoint =
              left.candidate.placement.kind === "zone"
                ? left.candidate.placement.point
                : point;
            const rightPoint =
              right.candidate.placement.kind === "zone"
                ? right.candidate.placement.point
                : point;
            const leftDistance =
              Math.abs(leftPoint.x - point.x) + Math.abs(leftPoint.y - point.y);
            const rightDistance =
              Math.abs(rightPoint.x - point.x) +
              Math.abs(rightPoint.y - point.y);
            return leftDistance - rightDistance;
          });
        const target = supports[0];
        if (!target) {
          setError("当前区域没有适合这个挂接物件的支撑点。");
          return false;
        }
        placement = {
          anchorId: target.anchor.id,
          flipped: false,
          kind: "attachment",
          offsetPx: { x: 0, y: 0 },
          parentInstanceId: target.candidate.id,
          rotation: 0,
          zoneId: view.zone.id,
        };
      } else {
        placement = {
          flipped: false,
          kind: "zone",
          offsetPx: { x: 0, y: 0 },
          point,
          rotation: definition.transforms.rotations[0] ?? 0,
          zoneId: view.zone.id,
        };
      }
      const timestamp = now();
      const mutations: TerritoryWorldMutation[] = [];
      if (definition.layer === "terrain") {
        for (const existing of view.instances) {
          const existingDefinition = findDefinition(view.definitions, existing);
          if (
            existingDefinition?.layer === "terrain" &&
            existing.placement.kind === "zone" &&
            existing.placement.point.x === point.x &&
            existing.placement.point.y === point.y
          ) {
            mutations.push({
              changeId: id(),
              instance: {
                ...existing,
                placement: { kind: "collection" },
                updatedAt: timestamp,
              },
              kind: "instance.put",
            });
          }
        }
      }
      mutations.push({
        changeId: id(),
        instance: {
          ...selectedCollectionInstance,
          placement,
          updatedAt: timestamp,
        },
        kind: "instance.put",
      });
      const accepted = await commit(`放置「${definition.name}」`, mutations);
      if (accepted) {
        setSelectedCollectionId(null);
        setSelectedIds(new Set([selectedCollectionInstance.id]));
        setPanel("inspector");
      }
      return accepted;
    },
    [commit, selectedCollectionInstance, snapshot, view],
  );

  const drainPetMoves = useCallback(() => {
    if (petMoveInFlight.current) return;
    petMoveInFlight.current = true;
    void (async () => {
      try {
        while (pendingPetMove.current) {
          const point = pendingPetMove.current;
          pendingPetMove.current = null;
          const currentSnapshot = snapshotRef.current;
          const currentView = viewRef.current;
          if (!currentSnapshot || !currentView?.pet) continue;
          const response = await api.movePet({
            from: currentSnapshot.pet.point,
            to: point,
            zoneId: currentView.zone.id,
          });
          if (!response.ok) {
            setError(response.error.message);
            continue;
          }

          const serverSnapshot = response.value.snapshot;
          const nextSnapshot = snapshotRef.current
            ? { ...snapshotRef.current, pet: serverSnapshot.pet }
            : serverSnapshot;
          installPetMovement(response.value.path, nextSnapshot);
        }
      } catch {
        setError("桌宠暂时走不到那里。");
      } finally {
        petMoveInFlight.current = false;
        if (pendingPetMove.current) {
          queueMicrotask(() => drainPetMovesRef.current());
        }
      }
    })();
  }, [api, installPetMovement]);

  useEffect(() => {
    drainPetMovesRef.current = drainPetMoves;
  }, [drainPetMoves]);

  const movePet = useCallback((point: TerritoryGridPoint) => {
    pendingPetMove.current = point;
    setError(null);
    drainPetMovesRef.current();
  }, []);

  const completeMovement = useCallback((movementId: number) => {
    if (movementSequence.current !== movementId) return;
    setMovement((current) => (current?.id === movementId ? null : current));
  }, []);

  const updateSelected = useCallback(
    async (
      label: string,
      update: (
        instance: TerritoryInstance,
        timestamp: string,
      ) => TerritoryInstance,
    ) => {
      if (!view || selectedIds.size === 0) return false;
      const timestamp = now();
      return commit(
        label,
        view.instances
          .filter(({ id: instanceId }) => selectedIds.has(instanceId))
          .map((instance) => ({
            changeId: id(),
            instance: update(instance, timestamp),
            kind: "instance.put" as const,
          })),
      );
    },
    [commit, selectedIds, view],
  );

  const collectSelected = useCallback(async () => {
    if (!view || selectedIds.size === 0) return;
    const related = allRelatedInstanceIds(view, selectedIds);
    const accepted = await updateSelected(
      "收回领地物件",
      (instance, timestamp) =>
        related.has(instance.id)
          ? {
              ...instance,
              placement: { kind: "collection" },
              updatedAt: timestamp,
            }
          : instance,
    );
    if (accepted) {
      setSelectedIds(new Set());
      setPanel("library");
    }
  }, [selectedIds, updateSelected, view]);

  const trashSelected = useCallback(async () => {
    if (!view || selectedIds.size === 0) return;
    const related = allRelatedInstanceIds(view, selectedIds);
    const timestamp = now();
    const accepted = await commit(
      "移入领地回收站",
      view.instances
        .filter(({ id: instanceId }) => related.has(instanceId))
        .map((instance) => ({
          changeId: id(),
          instance: {
            ...instance,
            status: "trashed" as const,
            trashedAt: timestamp,
            updatedAt: timestamp,
          },
          kind: "instance.put" as const,
        })),
    );
    if (accepted) {
      setSelectedIds(new Set());
      setPanel("library");
      setShowTrash(true);
    }
  }, [commit, selectedIds, view]);

  const recoverInstance = useCallback(
    async (instance: TerritoryInstance) => {
      const timestamp = now();
      const accepted = await commit(`恢复领地物件`, [
        {
          changeId: id(),
          instance: {
            ...instance,
            placement: { kind: "collection" },
            status: "active",
            trashedAt: null,
            updatedAt: timestamp,
          },
          kind: "instance.put",
        },
      ]);
      if (accepted) setShowTrash(false);
    },
    [commit],
  );

  const purgeInstance = useCallback(
    async (instance: TerritoryInstance) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const previousRevision = snapshot?.world.currentRevision.id;
      try {
        const response = await api.purgeInstance({ instanceId: instance.id });
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        if (previousRevision)
          setUndoStack((current) => [...current, previousRevision]);
        setRedoStack([]);
        await installSnapshot(response.value);
      } catch {
        setError("无法永久删除这个物件。");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, installSnapshot, snapshot?.world.currentRevision.id],
  );

  const duplicateSelected = useCallback(async () => {
    if (!primaryInstance || !primaryDefinition) return;
    const timestamp = now();
    const duplicate: TerritoryInstance = {
      ...primaryInstance,
      createdAt: timestamp,
      favorite: false,
      groupId: null,
      id: id(),
      locked: false,
      placement: { kind: "collection" },
      sources: [],
      updatedAt: timestamp,
    };
    const accepted = await commit(`复制「${primaryDefinition.name}」`, [
      { changeId: id(), instance: duplicate, kind: "instance.put" },
    ]);
    if (accepted) {
      setSelectedIds(new Set());
      setSelectedCollectionId(duplicate.id);
      setPanel("library");
    }
  }, [commit, primaryDefinition, primaryInstance]);

  const createGroup = useCallback(async () => {
    if (!view || selectedInstances.length < 2) return;
    const timestamp = now();
    const groupId = id();
    const instanceIds = selectedInstances.map(
      ({ id: instanceId }) => instanceId,
    );
    await commit("组合领地物件", [
      ...selectedInstances.map((instance) => ({
        changeId: id(),
        instance: { ...instance, groupId, updatedAt: timestamp },
        kind: "instance.put" as const,
      })),
      {
        changeId: id(),
        group: {
          createdAt: timestamp,
          id: groupId,
          instanceIds,
          locked: false,
          name: `组合 ${String(view.groups.length + 1)}`,
          template: false,
          updatedAt: timestamp,
          zoneId: view.zone.id,
        },
        kind: "group.put",
      },
    ]);
  }, [commit, selectedInstances, view]);

  const ungroupSelected = useCallback(async () => {
    if (!view) return;
    const groupIds = new Set(
      selectedInstances.flatMap(({ groupId }) => (groupId ? [groupId] : [])),
    );
    if (groupIds.size === 0) return;
    const timestamp = now();
    await commit("取消领地物件组合", [
      ...view.instances
        .filter(({ groupId }) => groupId && groupIds.has(groupId))
        .map((instance) => ({
          changeId: id(),
          instance: { ...instance, groupId: null, updatedAt: timestamp },
          kind: "instance.put" as const,
        })),
      ...[...groupIds].map((groupId) => ({
        changeId: id(),
        groupId,
        kind: "group.remove" as const,
      })),
    ]);
  }, [commit, selectedInstances, view]);

  const saveDefinition = useCallback(async () => {
    if (!snapshot || !primaryInstance || !primaryDefinition) return;
    const timestamp = now();
    const latestRevision = Math.max(
      ...snapshot.definitions
        .filter(({ id: definitionId }) => definitionId === primaryDefinition.id)
        .map(({ revision }) => revision),
    );
    const definition: TerritoryDefinition = {
      ...primaryDefinition,
      createdAt: timestamp,
      description:
        definitionDescription.trim() || primaryDefinition.description,
      name: definitionName.trim() || primaryDefinition.name,
      revision: latestRevision + 1,
    };
    const accepted = await commit(`编辑「${primaryDefinition.name}」`, [
      { changeId: id(), definition, kind: "definition.put" },
      ...selectedInstances
        .filter(
          ({ definition: reference }) =>
            reference.id === primaryDefinition.id &&
            reference.revision === primaryDefinition.revision,
        )
        .map((instance) => ({
          changeId: id(),
          instance: {
            ...instance,
            definition: { id: definition.id, revision: definition.revision },
            updatedAt: timestamp,
          },
          kind: "instance.put" as const,
        })),
    ]);
    if (accepted) setEditingDefinition(false);
  }, [
    commit,
    definitionDescription,
    definitionName,
    primaryDefinition,
    primaryInstance,
    selectedInstances,
    snapshot,
  ]);

  const selectDefinitionRevision = useCallback(
    async (revision: number) => {
      if (!primaryInstance || !primaryDefinition) return;
      await updateSelected("切换物件版本", (instance, timestamp) =>
        instance.definition.id === primaryDefinition.id
          ? {
              ...instance,
              definition: { id: primaryDefinition.id, revision },
              updatedAt: timestamp,
            }
          : instance,
      );
    },
    [primaryDefinition, primaryInstance, updateSelected],
  );

  const restoreFromStack = useCallback(
    async (direction: "redo" | "undo") => {
      if (!snapshot || busyRef.current) return;
      const source = direction === "undo" ? undoStack : redoStack;
      const target = source.at(-1);
      if (!target) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const response = await api.restoreRevision({ revisionId: target });
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        const currentRevision = snapshot.world.currentRevision.id;
        if (direction === "undo") {
          setUndoStack((current) => current.slice(0, -1));
          setRedoStack((current) => [...current, currentRevision]);
        } else {
          setRedoStack((current) => current.slice(0, -1));
          setUndoStack((current) => [...current, currentRevision]);
        }
        await installSnapshot(response.value);
      } catch {
        setError("无法恢复这个领地版本。");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, installSnapshot, redoStack, snapshot, undoStack],
  );

  const restoreRevision = useCallback(
    async (revisionId: string) => {
      if (!snapshot || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const currentRevision = snapshot.world.currentRevision.id;
      try {
        const response = await api.restoreRevision({ revisionId });
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setUndoStack((current) => [...current, currentRevision]);
        setRedoStack([]);
        await installSnapshot(response.value);
        setPanel(null);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, installSnapshot, snapshot],
  );

  const createCandidate = useCallback(async () => {
    if (!snapshot || !view || !prompt.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await api.createCandidate({
        baseRevisionId: snapshot.world.currentRevision.id,
        intent:
          candidateIntent === "selection" && selectedIds.size === 0
            ? "item"
            : candidateIntent,
        lockedInstanceIds: view.instances
          .filter(({ locked }) => locked)
          .map(({ id: instanceId }) => instanceId),
        prompt: prompt.trim(),
        providerProfileId,
        scope:
          candidateIntent === "expansion"
            ? {
                direction: "east",
                fromZoneId: view.zone.id,
                kind: "expansion",
              }
            : candidateIntent === "selection" && selectedIds.size > 0
              ? {
                  instanceIds: [...selectedIds],
                  kind: "entities",
                  zoneId: view.zone.id,
                }
              : { kind: "zone", zoneId: view.zone.id },
        sources: [],
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setSnapshot(response.value.snapshot);
      setSelectedCandidateId(response.value.candidateId);
      setPreviewSide("after");
      setPrompt("");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    api,
    candidateIntent,
    prompt,
    providerProfileId,
    selectedIds,
    snapshot,
    view,
  ]);

  const editCandidate = useCallback(async () => {
    if (!selectedCandidate || !candidateInstruction.trim() || busyRef.current)
      return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await api.editCandidate({
        candidateId: selectedCandidate.id,
        excludedChangeIds: [...excludedChangeIds],
        instruction: candidateInstruction.trim(),
        lockedInstanceIds: selectedCandidate.lockedInstanceIds,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setSnapshot(response.value.snapshot);
      setCandidateInstruction("");
      setPreviewSide("after");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [api, candidateInstruction, excludedChangeIds, selectedCandidate]);

  const cancelCandidate = useCallback(async () => {
    if (!selectedCandidate || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await api.cancelCandidate({
        candidateId: selectedCandidate.id,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setSnapshot(response.value.snapshot);
      setSelectedCandidateId(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [api, selectedCandidate]);

  const applyCandidate = useCallback(async () => {
    if (!selectedCandidate || !snapshot || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const previousRevision = snapshot.world.currentRevision.id;
    try {
      const response = await api.applyCandidate({
        candidateId: selectedCandidate.id,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setUndoStack((current) => [...current, previousRevision]);
      setRedoStack([]);
      const source = selectedCandidate.sources[0];
      if (source) {
        setRevealSource({ label: source.label, occurredAt: source.occurredAt });
      }
      await installSnapshot(response.value.snapshot);
      setSelectedCandidateId(null);
      setPanel(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [api, installSnapshot, selectedCandidate, snapshot]);

  const enterZone = useCallback(
    async (toZoneId: string) => {
      if (
        !snapshot ||
        busyRef.current ||
        toZoneId === snapshot.world.activeZoneId
      )
        return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const response = await api.enterZone({
          fromZoneId: snapshot.world.activeZoneId,
          toZoneId,
        });
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setSelectedIds(new Set());
        setSelectedCollectionId(null);
        setMovement(null);
        await installSnapshot(response.value);
        setPanel(null);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, installSnapshot, snapshot],
  );

  const filteredCollection = useMemo(() => {
    if (!snapshot) return [];
    const normalized = search.trim().toLocaleLowerCase();
    return snapshot.collection.filter((instance) => {
      const definition = findDefinition(snapshot.definitions, instance);
      return (
        definition &&
        (!normalized ||
          definition.name.toLocaleLowerCase().includes(normalized) ||
          definition.tags.some((tag) => tag.includes(normalized)))
      );
    });
  }, [search, snapshot]);

  if (!snapshot || !view || !preview) {
    return <div className={styles["loadingPage"]}>正在展开你的领地 World…</div>;
  }

  const latestDefinitionRevisions = primaryDefinition
    ? snapshot.definitions
        .filter(({ id: definitionId }) => definitionId === primaryDefinition.id)
        .sort((left, right) => right.revision - left.revision)
    : [];

  return (
    <section className={styles["territoryWorldPage"]}>
      <header className={styles["worldToolbar"]}>
        <div className={styles["worldIdentity"]}>
          <span className={styles["worldMark"]}>
            <MapIcon aria-hidden="true" size={17} />
          </span>
          <span>
            <strong>{view.zone.name}</strong>
            <small>
              {snapshot.world.name} · Revision{" "}
              {snapshot.world.currentRevision.sequence}
            </small>
          </span>
        </div>
        <div className={styles["modeSwitch"]} aria-label="领地模式">
          <button
            aria-pressed={mode === "explore"}
            type="button"
            onClick={() => {
              setMode("explore");
              setStoryCardExpanded(false);
              setSelectedCollectionId(null);
            }}
          >
            <Eye aria-hidden="true" size={14} /> 探索
          </button>
          <button
            aria-pressed={mode === "build"}
            type="button"
            onClick={() => {
              setMode("build");
              setStoryCardExpanded(false);
            }}
          >
            <Hammer aria-hidden="true" size={14} /> 建造
          </button>
        </div>
        <div className={styles["toolbarActions"]}>
          <button
            aria-label="撤销"
            disabled={busy || undoStack.length === 0}
            type="button"
            onClick={() => void restoreFromStack("undo")}
          >
            <Undo2 aria-hidden="true" size={15} />
          </button>
          <button
            aria-label="重做"
            disabled={busy || redoStack.length === 0}
            type="button"
            onClick={() => void restoreFromStack("redo")}
          >
            <Redo2 aria-hidden="true" size={15} />
          </button>
          <button
            aria-label="版本历史"
            data-active={panel === "history" || undefined}
            type="button"
            onClick={() => setPanel(panel === "history" ? null : "history")}
          >
            <History aria-hidden="true" size={15} />
          </button>
          <button
            className={styles["createButton"]}
            data-active={panel === "create" || undefined}
            type="button"
            onClick={() => setPanel(panel === "create" ? null : "create")}
          >
            <Sparkles aria-hidden="true" size={14} /> AI 创作
          </button>
        </div>
      </header>

      <div className={styles["worldWorkspace"]}>
        <Suspense
          fallback={
            <div className={styles["canvasLoading"]}>正在点亮领地…</div>
          }
        >
          <PixiTerritoryWorldCanvas
            activePet={activePet}
            animationSpeed={animationSpeed}
            assets={snapshot.assets}
            mode={mode}
            movement={movement}
            onInstanceMove={moveInstance}
            onMovementComplete={completeMovement}
            onPetMove={movePet}
            onPetPositionChange={(position) => {
              renderedPetPosition.current = position;
            }}
            onPlaceCollection={placeCollection}
            onSelectionChange={selectInstance}
            petState={snapshot.pet}
            previewActions={
              showingCandidatePreview ? preview.actions : emptyPreviewActions
            }
            selectedCollectionInstance={selectedCollectionInstance}
            selectedInstanceIds={selectedIds}
            view={showingCandidatePreview ? preview.view : view}
            visibleLayers={visibleLayers}
          />
        </Suspense>

        <div className={styles["ambientBadge"]}>
          <Sparkles aria-hidden="true" size={12} />
          {view.style.seasonTone} · {view.style.timeTone}
        </div>

        <nav className={styles["toolRail"]} aria-label="领地工具">
          <button
            aria-label="物件库"
            data-active={panel === "library" || undefined}
            type="button"
            onClick={() => {
              setPanel(panel === "library" ? null : "library");
              setMode("build");
            }}
          >
            <PackageOpen aria-hidden="true" size={17} />
          </button>
          <div className={styles["layerPopover"]}>
            <button aria-label="图层" type="button">
              <Layers3 aria-hidden="true" size={17} />
            </button>
            <div className={styles["layerMenu"]}>
              <strong>显示图层</strong>
              {layers.map((layer) => (
                <button
                  key={layer}
                  aria-pressed={visibleLayers.has(layer)}
                  type="button"
                  onClick={() =>
                    setVisibleLayers((current) => {
                      const next = new Set(current);
                      if (next.has(layer)) next.delete(layer);
                      else next.add(layer);
                      return next;
                    })
                  }
                >
                  {visibleLayers.has(layer) ? (
                    <Eye aria-hidden="true" size={13} />
                  ) : (
                    <EyeOff aria-hidden="true" size={13} />
                  )}
                  {layerLabels[layer]}
                </button>
              ))}
            </div>
          </div>
          <button
            aria-label="选择工具"
            data-active={selectedIds.size > 0 || undefined}
            type="button"
            onClick={() => {
              setMode("build");
              setStoryCardExpanded(false);
              setSelectedCollectionId(null);
            }}
          >
            <Box aria-hidden="true" size={17} />
          </button>
          <button
            aria-label="世界地图"
            disabled={snapshot.world.zones.length === 1}
            type="button"
            onClick={() => setPanel("map")}
          >
            <MapIcon aria-hidden="true" size={17} />
          </button>
        </nav>

        {selectedCandidate?.status === "ready" ? (
          <div className={styles["previewBanner"]}>
            <WandSparkles aria-hidden="true" size={15} />
            <span>
              <strong>正在预览 AI 变更</strong>
              <small>
                绿色新增、黄色移动或替换、红色删除；应用前不会改动 World。
              </small>
            </span>
            <div className={styles["previewSwitch"]} aria-label="预览对照">
              <button
                aria-pressed={previewSide === "before"}
                type="button"
                onClick={() => setPreviewSide("before")}
              >
                修改前
              </button>
              <button
                aria-pressed={previewSide === "after"}
                type="button"
                onClick={() => setPreviewSide("after")}
              >
                修改后
              </button>
            </div>
            <button
              disabled={busy}
              type="button"
              onClick={() => void applyCandidate()}
            >
              应用到领地
            </button>
          </div>
        ) : null}

        {mode === "build" ? (
          <div className={styles["buildDock"]}>
            <button
              className={styles["dockLibraryButton"]}
              type="button"
              onClick={() => setPanel("library")}
            >
              <PackageOpen aria-hidden="true" size={16} />
              <span>
                <strong>物件库</strong>
                <small>{snapshot.collection.length} 件 · 无数量上限</small>
              </span>
            </button>
            <div className={styles["quickItems"]}>
              {snapshot.collection.slice(0, 6).map((instance) => {
                const definition = findDefinition(
                  snapshot.definitions,
                  instance,
                );
                if (!definition) return null;
                return (
                  <button
                    key={instance.id}
                    data-selected={
                      instance.id === selectedCollectionId || undefined
                    }
                    title={definition.name}
                    type="button"
                    onClick={() => {
                      setSelectedCollectionId(
                        selectedCollectionId === instance.id
                          ? null
                          : instance.id,
                      );
                      setSelectedIds(new Set());
                    }}
                  >
                    <span data-layer={definition.layer} />
                    <small>{definition.name}</small>
                  </button>
                );
              })}
            </div>
            <button
              className={styles["dockCreateButton"]}
              type="button"
              onClick={() => setPanel("create")}
            >
              <Sparkles aria-hidden="true" size={16} /> 生成
            </button>
          </div>
        ) : (
          <div className={styles["exploreHint"]}>
            右键任意位置让桌宠走动，左键只查看物件故事
          </div>
        )}

        {panel ? (
          <aside
            aria-label={
              panel === "inspector" && mode === "explore"
                ? "物件故事卡"
                : "领地侧栏"
            }
            className={`${styles["sidePanel"]}${
              panel === "inspector" && mode === "explore"
                ? ` ${styles["exploreStoryCard"]}`
                : ""
            }`}
            data-expanded={
              panel === "inspector" && mode === "explore"
                ? storyCardExpanded
                : undefined
            }
            data-presentation={
              panel === "inspector" && mode === "explore" ? "compact" : "full"
            }
          >
            <header>
              <span>
                {panel === "library" ? (
                  <PackageOpen aria-hidden="true" size={16} />
                ) : null}
                {panel === "inspector" ? (
                  <Brush aria-hidden="true" size={16} />
                ) : null}
                {panel === "create" ? (
                  <Sparkles aria-hidden="true" size={16} />
                ) : null}
                {panel === "history" ? (
                  <History aria-hidden="true" size={16} />
                ) : null}
                {panel === "map" ? (
                  <MapIcon aria-hidden="true" size={16} />
                ) : null}
                <strong>
                  {panel === "library"
                    ? "物件库"
                    : panel === "inspector"
                      ? mode === "explore"
                        ? "物件故事"
                        : "物件检查器"
                      : panel === "create"
                        ? "AI 创作台"
                        : panel === "map"
                          ? "World 地图"
                          : "World 历史"}
                </strong>
              </span>
              <button
                aria-label={
                  panel === "inspector" && mode === "explore"
                    ? "关闭故事卡"
                    : "关闭侧栏"
                }
                type="button"
                onClick={() => {
                  setPanel(null);
                  setStoryCardExpanded(false);
                }}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>

            {panel === "library" ? (
              <div className={styles["libraryPanel"]}>
                <label className={styles["searchField"]}>
                  <Search aria-hidden="true" size={14} />
                  <input
                    aria-label="搜索物件"
                    placeholder="搜索名称或标签"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <div className={styles["libraryTabs"]}>
                  <button
                    aria-pressed={!showTrash}
                    type="button"
                    onClick={() => setShowTrash(false)}
                  >
                    收藏库 {snapshot.collection.length}
                  </button>
                  <button
                    aria-pressed={showTrash}
                    type="button"
                    onClick={() => setShowTrash(true)}
                  >
                    回收站 {snapshot.trash.length}
                  </button>
                </div>
                {!showTrash ? (
                  filteredCollection.length ? (
                    <div className={styles["libraryGrid"]}>
                      {filteredCollection.map((instance) => {
                        const definition = findDefinition(
                          snapshot.definitions,
                          instance,
                        );
                        if (!definition) return null;
                        return (
                          <button
                            key={instance.id}
                            data-selected={
                              instance.id === selectedCollectionId || undefined
                            }
                            type="button"
                            onClick={() => {
                              setSelectedCollectionId(instance.id);
                              setSelectedIds(new Set());
                              setMode("build");
                            }}
                          >
                            <span
                              className={styles["librarySwatch"]}
                              data-layer={definition.layer}
                            >
                              {instance.favorite ? (
                                <Heart aria-hidden="true" size={11} />
                              ) : null}
                            </span>
                            <strong>{definition.name}</strong>
                            <small>
                              {layerLabels[definition.layer]} · v
                              {definition.revision}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={styles["emptyState"]}>
                      没有符合条件的收藏物件。
                    </p>
                  )
                ) : snapshot.trash.length ? (
                  <div className={styles["trashList"]}>
                    {snapshot.trash.map((instance) => {
                      const definition = findDefinition(
                        snapshot.definitions,
                        instance,
                      );
                      if (!definition) return null;
                      return (
                        <article key={instance.id}>
                          <span
                            className={styles["librarySwatch"]}
                            data-layer={definition.layer}
                          />
                          <span>
                            <strong>{definition.name}</strong>
                            <small>
                              {instance.trashedAt
                                ? dateLabel(instance.trashedAt)
                                : "刚刚删除"}
                            </small>
                          </span>
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => void recoverInstance(instance)}
                          >
                            恢复
                          </button>
                          <button
                            className={styles["dangerButton"]}
                            disabled={busy}
                            type="button"
                            onClick={() => void purgeInstance(instance)}
                          >
                            永久删除
                          </button>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className={styles["emptyState"]}>回收站是空的。</p>
                )}
                {selectedCollectionInstance ? (
                  <div className={styles["placementTip"]}>
                    <Box aria-hidden="true" size={15} />
                    <span>
                      已拿起「
                      {
                        findDefinition(
                          snapshot.definitions,
                          selectedCollectionInstance,
                        )?.name
                      }
                      」
                      <small>
                        点击画布放置；挂接物件会吸附到最近的兼容锚点。
                      </small>
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {panel === "inspector" ? (
              primaryInstance && primaryDefinition ? (
                mode === "explore" ? (
                  <div className={styles["exploreStoryContent"]}>
                    <div className={styles["exploreStoryHeading"]}>
                      <span>
                        <Eye aria-hidden="true" size={12} />
                        {layerLabels[primaryDefinition.layer]}
                      </span>
                      <strong>{primaryDefinition.name}</strong>
                      <p>{primaryDefinition.description}</p>
                    </div>
                    <div
                      aria-label="物件摘要"
                      className={styles["exploreStorySummary"]}
                    >
                      <span>
                        <small>互动</small>
                        <strong>
                          {petBehaviorLabel(snapshot.pet.behavior)}
                        </strong>
                      </span>
                      <span>
                        <small>来源</small>
                        <strong>
                          {primaryInstance.sources.length
                            ? "记忆 / 活动"
                            : "领地创作"}
                        </strong>
                      </span>
                    </div>
                    {storyCardExpanded ? (
                      <div className={styles["exploreStoryDetails"]}>
                        <div className={styles["propertyList"]}>
                          <span>
                            <small>图层</small>
                            <strong>
                              {layerLabels[primaryDefinition.layer]}
                            </strong>
                          </span>
                          <span>
                            <small>定义版本</small>
                            <strong>v{primaryDefinition.revision}</strong>
                          </span>
                          <span>
                            <small>位置</small>
                            <strong>
                              {primaryInstance.placement.kind === "zone"
                                ? `${String(primaryInstance.placement.point.x)}, ${String(primaryInstance.placement.point.y)}`
                                : primaryInstance.placement.kind ===
                                    "attachment"
                                  ? "挂接"
                                  : "收藏库"}
                            </strong>
                          </span>
                          <span>
                            <small>查看方式</small>
                            <strong>左键故事 · 右键移动</strong>
                          </span>
                        </div>
                        {primaryInstance.sources.length ? (
                          <section className={styles["sourceList"]}>
                            <h3>形成它的故事</h3>
                            {primaryInstance.sources.map((source) => (
                              <button
                                key={`${source.kind}:${source.id}`}
                                type="button"
                                onClick={() => {
                                  if (source.kind === "memory")
                                    onOpenMemorySource?.(source.id);
                                }}
                              >
                                <strong>{source.label}</strong>
                                <small>
                                  {source.kind === "memory"
                                    ? "打开记忆"
                                    : "活动摘要"}{" "}
                                  · {dateLabel(source.occurredAt)}
                                </small>
                              </button>
                            ))}
                          </section>
                        ) : null}
                      </div>
                    ) : null}
                    <div className={styles["exploreStoryActions"]}>
                      <button
                        aria-expanded={storyCardExpanded}
                        type="button"
                        onClick={() =>
                          setStoryCardExpanded((expanded) => !expanded)
                        }
                      >
                        {storyCardExpanded ? "收起详情" : "展开详情"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMode("build");
                          setStoryCardExpanded(false);
                        }}
                      >
                        <Pencil aria-hidden="true" size={12} />
                        进入建造编辑
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles["inspectorPanel"]}>
                    <div
                      className={styles["inspectorHero"]}
                      data-layer={primaryDefinition.layer}
                    >
                      <span>{layerLabels[primaryDefinition.layer]}</span>
                      <strong>
                        {selectedInstances.length > 1
                          ? `${String(selectedInstances.length)} 件已选择`
                          : primaryDefinition.name}
                      </strong>
                      <small>{primaryDefinition.description}</small>
                    </div>
                    {editingDefinition ? (
                      <div className={styles["editDefinition"]}>
                        <label className={styles["field"]}>
                          <span>名称</span>
                          <input
                            value={definitionName}
                            onChange={(event) =>
                              setDefinitionName(event.target.value)
                            }
                          />
                        </label>
                        <label className={styles["field"]}>
                          <span>描述</span>
                          <textarea
                            rows={4}
                            value={definitionDescription}
                            onChange={(event) =>
                              setDefinitionDescription(event.target.value)
                            }
                          />
                        </label>
                        <div className={styles["formActions"]}>
                          <button
                            type="button"
                            onClick={() => setEditingDefinition(false)}
                          >
                            取消
                          </button>
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => void saveDefinition()}
                          >
                            保存新版本
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className={styles["propertyList"]}>
                          <span>
                            <small>图层</small>
                            <strong>
                              {layerLabels[primaryDefinition.layer]}
                            </strong>
                          </span>
                          <span>
                            <small>定义版本</small>
                            <strong>v{primaryDefinition.revision}</strong>
                          </span>
                          <span>
                            <small>位置</small>
                            <strong>
                              {primaryInstance.placement.kind === "zone"
                                ? `${String(primaryInstance.placement.point.x)}, ${String(primaryInstance.placement.point.y)}`
                                : primaryInstance.placement.kind ===
                                    "attachment"
                                  ? "挂接"
                                  : "收藏库"}
                            </strong>
                          </span>
                          <span>
                            <small>来源</small>
                            <strong>
                              {primaryInstance.sources.length
                                ? "记忆 / 活动"
                                : "领地创作"}
                            </strong>
                          </span>
                        </div>
                        {mode === "build" ? (
                          <>
                            <div className={styles["inspectorActions"]}>
                              <button
                                type="button"
                                onClick={() => {
                                  setDefinitionName(primaryDefinition.name);
                                  setDefinitionDescription(
                                    primaryDefinition.description,
                                  );
                                  setEditingDefinition(true);
                                }}
                              >
                                <Pencil aria-hidden="true" size={13} /> 编辑
                              </button>
                              <button
                                disabled={busy}
                                type="button"
                                onClick={() =>
                                  void updateSelected(
                                    primaryInstance.locked
                                      ? "解锁物件"
                                      : "锁定物件",
                                    (instance, timestamp) => ({
                                      ...instance,
                                      locked: !primaryInstance.locked,
                                      updatedAt: timestamp,
                                    }),
                                  )
                                }
                              >
                                {primaryInstance.locked ? (
                                  <LockOpen aria-hidden="true" size={13} />
                                ) : (
                                  <Lock aria-hidden="true" size={13} />
                                )}
                                {primaryInstance.locked ? "解锁" : "锁定"}
                              </button>
                              <button
                                disabled={busy}
                                type="button"
                                onClick={() =>
                                  void updateSelected(
                                    primaryInstance.favorite
                                      ? "取消收藏"
                                      : "收藏物件",
                                    (instance, timestamp) => ({
                                      ...instance,
                                      favorite: !primaryInstance.favorite,
                                      updatedAt: timestamp,
                                    }),
                                  )
                                }
                              >
                                <Heart aria-hidden="true" size={13} /> 收藏
                              </button>
                              {primaryDefinition.transforms.rotations.length >
                              1 ? (
                                <button
                                  disabled={busy}
                                  type="button"
                                  onClick={() =>
                                    void updateSelected(
                                      "旋转领地物件",
                                      (instance, timestamp) =>
                                        instance.placement.kind === "collection"
                                          ? instance
                                          : {
                                              ...instance,
                                              placement: {
                                                ...instance.placement,
                                                rotation: nextRotation(
                                                  primaryDefinition,
                                                  instance.placement.rotation,
                                                ),
                                              },
                                              updatedAt: timestamp,
                                            },
                                    )
                                  }
                                >
                                  <RotateCw aria-hidden="true" size={13} /> 旋转
                                </button>
                              ) : null}
                              {primaryDefinition.transforms.flippable ? (
                                <button
                                  disabled={busy}
                                  type="button"
                                  onClick={() =>
                                    void updateSelected(
                                      "翻转领地物件",
                                      (instance, timestamp) =>
                                        instance.placement.kind === "collection"
                                          ? instance
                                          : {
                                              ...instance,
                                              placement: {
                                                ...instance.placement,
                                                flipped:
                                                  !instance.placement.flipped,
                                              },
                                              updatedAt: timestamp,
                                            },
                                    )
                                  }
                                >
                                  <FlipHorizontal2
                                    aria-hidden="true"
                                    size={13}
                                  />{" "}
                                  翻转
                                </button>
                              ) : null}
                              <button
                                disabled={busy}
                                type="button"
                                onClick={() => void duplicateSelected()}
                              >
                                <Copy aria-hidden="true" size={13} /> 复制
                              </button>
                              {selectedInstances.length > 1 &&
                              selectedInstances.every(
                                ({ groupId }) => !groupId,
                              ) ? (
                                <button
                                  disabled={busy}
                                  type="button"
                                  onClick={() => void createGroup()}
                                >
                                  <Group aria-hidden="true" size={13} /> 组合
                                </button>
                              ) : null}
                              {selectedInstances.some(
                                ({ groupId }) => groupId,
                              ) ? (
                                <button
                                  disabled={busy}
                                  type="button"
                                  onClick={() => void ungroupSelected()}
                                >
                                  <Ungroup aria-hidden="true" size={13} />{" "}
                                  取消组合
                                </button>
                              ) : null}
                              <button
                                disabled={busy}
                                type="button"
                                onClick={() => void collectSelected()}
                              >
                                <Archive aria-hidden="true" size={13} /> 收回
                              </button>
                              <button
                                className={styles["dangerButton"]}
                                disabled={busy}
                                type="button"
                                onClick={() => void trashSelected()}
                              >
                                <Trash2 aria-hidden="true" size={13} /> 删除
                              </button>
                            </div>
                            {latestDefinitionRevisions.length > 1 ? (
                              <label className={styles["field"]}>
                                <span>切换 Definition 版本</span>
                                <select
                                  value={primaryDefinition.revision}
                                  onChange={(event) =>
                                    void selectDefinitionRevision(
                                      Number(event.target.value),
                                    )
                                  }
                                >
                                  {latestDefinitionRevisions.map(
                                    (definition) => (
                                      <option
                                        key={definition.revision}
                                        value={definition.revision}
                                      >
                                        v{definition.revision} ·{" "}
                                        {dateLabel(definition.createdAt)}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>
                            ) : null}
                          </>
                        ) : (
                          <div className={styles["scopeNote"]}>
                            <Eye aria-hidden="true" size={13} />
                            <span>
                              {petBehaviorLabel(snapshot.pet.behavior)}
                              <small>
                                探索时只展示故事和互动；进入建造后才能修改世界。
                              </small>
                            </span>
                            <button
                              type="button"
                              onClick={() => setMode("build")}
                            >
                              进入建造编辑
                            </button>
                          </div>
                        )}
                        {primaryInstance.sources.length ? (
                          <section className={styles["sourceList"]}>
                            <h3>形成它的故事</h3>
                            {primaryInstance.sources.map((source) => (
                              <button
                                key={`${source.kind}:${source.id}`}
                                type="button"
                                onClick={() => {
                                  if (source.kind === "memory")
                                    onOpenMemorySource?.(source.id);
                                }}
                              >
                                <strong>{source.label}</strong>
                                <small>
                                  {source.kind === "memory"
                                    ? "打开记忆"
                                    : "活动摘要"}{" "}
                                  · {dateLabel(source.occurredAt)}
                                </small>
                              </button>
                            ))}
                          </section>
                        ) : null}
                      </>
                    )}
                  </div>
                )
              ) : (
                <p className={styles["emptyState"]}>
                  在建造模式中选择一个或多个实体。
                </p>
              )
            ) : null}

            {panel === "create" ? (
              <div className={styles["createPanel"]}>
                <div className={styles["createIntro"]}>
                  <WandSparkles aria-hidden="true" size={19} />
                  <span>
                    <strong>描述你想看到的变化</strong>
                    <small>
                      可生成单件物品、重绘当前选择、完整生成整片区域，或继续扩建新的
                      Zone。
                    </small>
                  </span>
                </div>
                <label className={styles["field"]}>
                  <span>创作指令</span>
                  <textarea
                    rows={5}
                    placeholder="例如：把窗边改成雨夜植物角，保留书桌和桌灯，增加层次丰富的前景叶片与暖色反光。"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </label>
                <div className={styles["creationKinds"]} aria-label="创作类型">
                  {(
                    [
                      ["item", "新物件"],
                      ["selection", "重绘选择"],
                      ["zone", "改造区域"],
                      ["expansion", "扩建 Zone"],
                    ] as const
                  ).map(([intent, label]) => (
                    <button
                      key={intent}
                      aria-pressed={candidateIntent === intent}
                      disabled={
                        intent === "selection" && selectedIds.size === 0
                      }
                      type="button"
                      onClick={() => setCandidateIntent(intent)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <ImageProfileSelect
                  onChange={setProviderProfileId}
                  profiles={providerProfiles.filter(
                    (profile) => "imageModel" in profile,
                  )}
                  value={providerProfileId}
                />
                <div className={styles["scopeNote"]}>
                  <Lock aria-hidden="true" size={13} />
                  {candidateIntent === "selection" && selectedIds.size > 0
                    ? `只重绘当前选择的 ${String(selectedIds.size)} 件实体；锁定内容不会改变。`
                    : candidateIntent === "item"
                      ? "生成一个可继续编辑、复制和组合的新物件，并先在当前区域预览。"
                      : candidateIntent === "expansion"
                        ? `从「${view.zone.name}」向东扩建一个相连的新 Zone。`
                        : `为「${view.zone.name}」生成完整环境与 20 类独立可编辑陈设；锁定内容不会改变。`}
                </div>
                <button
                  className={styles["primaryAction"]}
                  disabled={busy || !prompt.trim()}
                  type="button"
                  onClick={() => void createCandidate()}
                >
                  <Sparkles aria-hidden="true" size={14} /> 生成可审阅预览
                </button>
                {snapshot.candidates.length ? (
                  <section className={styles["candidateList"]}>
                    <h3>创作记录</h3>
                    {snapshot.candidates.map((candidate) => (
                      <button
                        key={candidate.id}
                        data-selected={
                          candidate.id === selectedCandidateId || undefined
                        }
                        type="button"
                        onClick={() => {
                          setSelectedCandidateId(candidate.id);
                          setExcludedChangeIds(new Set());
                          setPreviewSide("after");
                        }}
                      >
                        <span data-status={candidate.status} />
                        <span>
                          <strong>{candidate.prompt}</strong>
                          <small>
                            {candidateStatusLabel(candidate.status)} ·{" "}
                            {dateLabel(candidate.updatedAt)}
                          </small>
                        </span>
                      </button>
                    ))}
                  </section>
                ) : null}
                {selectedCandidate ? (
                  <section className={styles["candidateDetail"]}>
                    <header>
                      <span>
                        <strong>
                          {candidateStatusLabel(selectedCandidate.status)}
                        </strong>
                        <small>
                          {selectedCandidate.previewGroups.length
                            ? `${String(selectedCandidate.previewGroups.length)} 组可审阅变更`
                            : "尚未产生 World 变更"}
                        </small>
                      </span>
                    </header>
                    {selectedMomentSource?.kind === "chat_moment" ? (
                      <div className={styles["momentSource"]}>
                        <strong>{selectedMomentSource.label}</strong>
                        <small>
                          来自 {dateLabel(selectedMomentSource.occurredAt)}
                          {selectedMomentSource.attachments.length
                            ? ` · ${selectedMomentSource.attachments
                                .map(({ displayName }) => displayName)
                                .join("、")}`
                            : ""}
                        </small>
                      </div>
                    ) : null}
                    {selectedCandidate.previewGroups.map((group, index) => {
                      const excluded = group.changeIds.every((changeId) =>
                        excludedChangeIds.has(changeId),
                      );
                      return (
                        <div
                          key={`${group.label}:${String(index)}`}
                          className={styles["previewGroup"]}
                          data-action={group.action}
                          data-excluded={excluded || undefined}
                        >
                          <span />
                          <strong>{group.label}</strong>
                          <small>{group.instanceIds.length} 件实体</small>
                          <button
                            type="button"
                            onClick={() =>
                              setExcludedChangeIds((current) => {
                                const next = new Set(current);
                                for (const changeId of group.changeIds) {
                                  if (excluded) next.delete(changeId);
                                  else next.add(changeId);
                                }
                                return next;
                              })
                            }
                          >
                            {excluded ? "恢复" : "排除"}
                          </button>
                        </div>
                      );
                    })}
                    {selectedCandidate.error ? (
                      <p className={styles["candidateError"]}>
                        {selectedCandidate.error.message}
                      </p>
                    ) : null}
                    {selectedCandidate.status !== "applied" &&
                    selectedCandidate.status !== "cancelled" ? (
                      <>
                        <label className={styles["field"]}>
                          <span>
                            {selectedMomentSource
                              ? "想换成什么感觉"
                              : "继续修改这版预览"}
                          </span>
                          <textarea
                            rows={3}
                            placeholder={
                              selectedMomentSource
                                ? "例如：更安静一点，保留夕阳的暖色。"
                                : "例如：保留灯光，把植物减少一半。"
                            }
                            value={candidateInstruction}
                            onChange={(event) =>
                              setCandidateInstruction(event.target.value)
                            }
                          />
                        </label>
                        <div className={styles["formActions"]}>
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => void cancelCandidate()}
                          >
                            {selectedMomentSource ? "这次不要" : "取消预览"}
                          </button>
                          <button
                            disabled={busy || !candidateInstruction.trim()}
                            type="button"
                            onClick={() => void editCandidate()}
                          >
                            {selectedMomentSource ? "换一种表达" : "重新生成"}
                          </button>
                          {selectedCandidate.status === "ready" ? (
                            <button
                              disabled={busy}
                              type="button"
                              onClick={() => void applyCandidate()}
                            >
                              {selectedMomentSource ? "放进领地" : "应用"}
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : null}

            {panel === "history" ? (
              <div className={styles["historyPanel"]}>
                <p>
                  每次手动布置和 AI 应用都会保存不可变版本。恢复历史会创建新
                  Revision，不会抹掉原记录。
                </p>
                <div className={styles["historyList"]}>
                  {[...snapshot.revisions].reverse().map((revision) => (
                    <article
                      key={revision.id}
                      data-current={
                        revision.id === snapshot.world.currentRevision.id ||
                        undefined
                      }
                    >
                      <span>
                        <strong>{revision.label}</strong>
                        <small>
                          {dateLabel(revision.createdAt)} · {revision.reason}
                        </small>
                      </span>
                      {revision.id === snapshot.world.currentRevision.id ? (
                        <em>当前</em>
                      ) : (
                        <button
                          disabled={busy}
                          type="button"
                          onClick={() => void restoreRevision(revision.id)}
                        >
                          恢复
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            {panel === "map" ? (
              <div className={styles["historyPanel"]}>
                <p>
                  每个 Zone 都是同一 World
                  的一部分。相连区域可直接进入，桌宠会从连接点继续生活。
                </p>
                <div className={styles["historyList"]}>
                  {snapshot.world.zones
                    .filter(({ status }) => status === "active")
                    .map((zone) => {
                      const current = zone.id === snapshot.world.activeZoneId;
                      const connected = snapshot.world.connections.some(
                        (connection) =>
                          (connection.fromZoneId ===
                            snapshot.world.activeZoneId &&
                            connection.toZoneId === zone.id) ||
                          (connection.toZoneId ===
                            snapshot.world.activeZoneId &&
                            connection.fromZoneId === zone.id),
                      );
                      return (
                        <article
                          key={zone.id}
                          data-current={current || undefined}
                        >
                          <span>
                            <strong>{zone.name}</strong>
                            <small>
                              {zone.kind} · {String(zone.bounds.width)} ×{" "}
                              {String(zone.bounds.height)} 格
                            </small>
                          </span>
                          {current ? (
                            <em>当前</em>
                          ) : (
                            <button
                              disabled={busy || !connected}
                              type="button"
                              onClick={() => void enterZone(zone.id)}
                            >
                              {connected ? "进入" : "未连接"}
                            </button>
                          )}
                        </article>
                      );
                    })}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}

        {revealSource ? (
          <div className={styles["memoryReveal"]} role="status">
            <span className={styles["memoryRevealGlow"]} />
            <Sparkles aria-hidden="true" size={18} />
            <span>
              <strong>一段共同经历落进了领地</strong>
              <small>
                {revealSource.label} · {dateLabel(revealSource.occurredAt)}
              </small>
            </span>
            <button type="button" onClick={() => setRevealSource(null)}>
              跳过演出
            </button>
          </div>
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
    </section>
  );
}
