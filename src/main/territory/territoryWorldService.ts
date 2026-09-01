import type {
  TerritoryCandidateIdRequest,
  TerritoryCandidateMutationResult,
  TerritoryCommitChangeSetRequest,
  TerritoryCreateChangeCandidateRequest,
  TerritoryDefinition,
  TerritoryEditChangeCandidateRequest,
  TerritoryEnterZoneRequest,
  TerritoryGetZoneViewRequest,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryMovePetRequest,
  TerritoryMovePetResult,
  TerritoryPerformPetActionRequest,
  TerritoryPetAction,
  TerritoryPetActionObservation,
  TerritoryPetActionPerformed,
  TerritoryPurgeInstanceRequest,
  TerritoryRestoreRevisionRequest,
  TerritoryWorldSnapshot,
  TerritoryZoneView,
} from "../../shared/contracts/territoryWorld";
import type { Clock } from "../../shared/pure/clock";
import {
  blockedTerritoryWorldCells,
  findTerritoryWorldPath,
  territoryInstanceFootprint,
} from "../../shared/pure/territoryWorldGrid";
import { TerritoryError } from "./territoryError";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";
import type {
  TerritoryWorldCandidateJob,
  TerritoryWorldCandidateService,
} from "./territoryWorldCandidateService";
import type { TerritoryWorldAssetStore } from "./territoryWorldAssetStore";

interface TerritoryPetMovePlan {
  readonly destination: TerritoryGridPoint;
  readonly facing: "left" | "right";
  readonly interactionDefinition: TerritoryDefinition | undefined;
  readonly path: readonly TerritoryGridPoint[];
}

function definitionKey(value: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${value.id}@${String(value.revision)}`;
}

function pointsEqual(
  left: TerritoryGridPoint | undefined,
  right: TerritoryGridPoint,
): boolean {
  return left?.x === right.x && left.y === right.y;
}

function actionsForDefinition(
  definition: TerritoryDefinition,
): TerritoryPetAction[] {
  const capabilities = new Set(definition.capabilities);
  const actions: TerritoryPetAction[] = ["move"];
  if (capabilities.has("inspectable") || capabilities.has("memory-reveal")) {
    actions.push("observe");
  }
  if (capabilities.has("seatable")) actions.push("sit");
  if (capabilities.has("sleepable")) actions.push("sleep");
  if (
    capabilities.has("light") ||
    capabilities.has("ambient-animation") ||
    capabilities.has("memory-reveal")
  ) {
    actions.push("react");
  }
  return actions;
}

export class TerritoryWorldService {
  constructor(
    private readonly repository: TerritoryWorldRepository,
    private readonly clock: Clock,
    private readonly candidates?: TerritoryWorldCandidateService,
    private readonly assets?: TerritoryWorldAssetStore,
    private readonly onPetAction?: (event: TerritoryPetActionPerformed) => void,
  ) {}

  getSnapshot(): TerritoryWorldSnapshot {
    return this.repository.getSnapshot();
  }

  getZoneView(request: TerritoryGetZoneViewRequest): TerritoryZoneView {
    return this.repository.getZoneView(request);
  }

  observePetActions(): TerritoryPetActionObservation {
    const snapshot = this.repository.getSnapshot();
    const { zone, view } = this.activeZoneContext(snapshot);
    const definitions = new Map(
      view.definitions.map((definition) => [
        definitionKey(definition),
        definition,
      ]),
    );
    const targets = view.instances.flatMap((instance) => {
      const definition = definitions.get(definitionKey(instance.definition));
      if (!definition || definition.capabilities.length === 0) return [];
      const root = this.resolvePlacedRoot(view, instance);
      if (!root) return [];
      const rootDefinition = definitions.get(definitionKey(root.definition));
      if (!rootDefinition || root.placement.kind !== "zone") return [];
      return [
        {
          actions: actionsForDefinition(definition),
          capabilities: [...definition.capabilities],
          description: definition.description,
          instanceId: instance.id,
          name: definition.name,
          point: { ...root.placement.point },
          reachable: Boolean(
            this.planPetMove(
              snapshot,
              {
                interactionInstanceId: instance.id,
                requireExactPoint: true,
              },
              { view, zone },
            ),
          ),
        },
      ];
    });
    return {
      pet: snapshot.pet,
      revisionId: snapshot.world.currentRevision.id,
      targets,
      zone: {
        bounds: zone.bounds,
        id: zone.id,
        name: zone.name,
      },
    };
  }

  performPetAction(
    request: TerritoryPerformPetActionRequest,
  ): TerritoryPetActionPerformed {
    const snapshot = this.repository.getSnapshot();
    if (snapshot.world.currentRevision.id !== request.expectedRevisionId) {
      throw new TerritoryError(
        "TERRITORY.REVISION_CONFLICT",
        "领地刚刚发生了变化，请重新观察后再行动。",
        false,
      );
    }
    this.activeZoneContext(snapshot);
    if (request.action === "move" && request.target.kind === "point") {
      const plan = this.planPetMove(snapshot, {
        point: request.target.point,
        requireExactPoint: true,
      });
      if (!plan) {
        throw new TerritoryError(
          "TERRITORY.NO_PATH",
          "桌宠暂时无法到达指定位置。",
          false,
        );
      }
      return this.commitPetAction(snapshot, request.action, plan, null);
    }
    if (request.target.kind !== "instance") {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "这个动作需要选择领地中的物件。",
        false,
      );
    }
    const targetInstanceId = request.target.instanceId;
    const { view } = this.activeZoneContext(snapshot);
    const instance = view.instances.find(({ id }) => id === targetInstanceId);
    const definition = instance
      ? view.definitions.find(
          (candidate) =>
            candidate.id === instance.definition.id &&
            candidate.revision === instance.definition.revision,
        )
      : undefined;
    if (!instance || !definition) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "这个物件已不在当前领地中，请重新观察。",
        false,
      );
    }
    if (!actionsForDefinition(definition).includes(request.action)) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        `“${definition.name}”不支持这个动作。`,
        false,
      );
    }
    const plan = this.planPetMove(snapshot, {
      interactionInstanceId: instance.id,
      requireExactPoint: true,
    });
    if (!plan) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        `桌宠暂时无法走到“${definition.name}”旁边。`,
        false,
      );
    }
    return this.commitPetAction(snapshot, request.action, plan, instance.id);
  }

  commitChangeSet(
    request: TerritoryCommitChangeSetRequest,
  ): TerritoryWorldSnapshot {
    return this.repository.commitChangeSet({
      changeSet: request.changeSet,
      now: this.clock.now(),
      reason: "direct",
    });
  }

  restoreRevision(
    request: TerritoryRestoreRevisionRequest,
  ): TerritoryWorldSnapshot {
    return this.repository.restoreRevision(
      request.revisionId,
      this.clock.now(),
    );
  }

  async purgeInstance(
    request: TerritoryPurgeInstanceRequest,
  ): Promise<TerritoryWorldSnapshot> {
    const before = this.repository.getSnapshot().assets;
    const snapshot = this.repository.purgeInstance(
      request.instanceId,
      this.clock.now(),
    );
    if (this.assets) {
      const remaining = new Set(snapshot.assets.map(({ id }) => id));
      await Promise.all(
        before
          .filter(
            ({ id, origin }) => origin !== "packaged" && !remaining.has(id),
          )
          .map(({ id }) => this.assets!.remove(id).catch(() => undefined)),
      );
    }
    return snapshot;
  }

  movePet(request: TerritoryMovePetRequest): TerritoryMovePetResult {
    const snapshot = this.repository.getSnapshot();
    const { zone } = this.activeZoneContext(snapshot);
    if (zone.id !== request.zoneId) {
      throw new TerritoryError(
        "TERRITORY.ZONE_NOT_FOUND",
        "请先打开这个领地区域。",
        false,
      );
    }
    if (
      snapshot.pet.point.x !== request.from.x ||
      snapshot.pet.point.y !== request.from.y
    ) {
      throw new TerritoryError(
        "TERRITORY.REVISION_CONFLICT",
        "桌宠已经移动，请从当前位置重试。",
        false,
      );
    }
    if (!request.interactionInstanceId && !this.insideZone(request.to, zone)) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "点击位置不在当前区域内。",
        false,
      );
    }
    const plan = this.planPetMove(snapshot, {
      ...(request.interactionInstanceId
        ? { interactionInstanceId: request.interactionInstanceId }
        : { point: request.to }),
      requireExactPoint: Boolean(request.interactionInstanceId),
    });
    if (!plan) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "桌宠暂时走不到那里。",
        false,
      );
    }
    const behavior = plan.interactionDefinition?.capabilities.includes(
      "sleepable",
    )
      ? "sleeping"
      : plan.interactionDefinition?.capabilities.includes("seatable")
        ? "sitting"
        : request.interactionInstanceId
          ? "observing"
          : "idle";
    this.repository.savePet({
      behavior,
      facing: plan.facing,
      point: plan.destination,
      updatedAt: this.clock.now(),
      zoneId: zone.id,
    });
    return { path: [...plan.path], snapshot: this.repository.getSnapshot() };
  }

  private activeZoneContext(snapshot: TerritoryWorldSnapshot): {
    readonly view: TerritoryZoneView;
    readonly zone: TerritoryWorldSnapshot["world"]["zones"][number];
  } {
    const zone = snapshot.world.zones.find(
      (candidate) => candidate.id === snapshot.world.activeZoneId,
    );
    if (!zone || zone.status !== "active" || snapshot.pet.zoneId !== zone.id) {
      throw new TerritoryError(
        "TERRITORY.ZONE_NOT_FOUND",
        "请先打开当前领地区域。",
        false,
      );
    }
    return {
      view: this.repository.getZoneView({
        revisionId: snapshot.world.currentRevision.id,
        zoneId: zone.id,
      }),
      zone,
    };
  }

  private commitPetAction(
    snapshot: TerritoryWorldSnapshot,
    action: TerritoryPetAction,
    plan: TerritoryPetMovePlan,
    targetInstanceId: string | null,
  ): TerritoryPetActionPerformed {
    const behavior =
      action === "sit"
        ? "sitting"
        : action === "sleep"
          ? "sleeping"
          : action === "observe" || action === "react"
            ? "observing"
            : "idle";
    this.repository.savePet({
      behavior,
      facing: plan.facing,
      point: plan.destination,
      updatedAt: this.clock.now(),
      zoneId: snapshot.world.activeZoneId,
    });
    const event: TerritoryPetActionPerformed = {
      action,
      path: [...plan.path],
      snapshot: this.repository.getSnapshot(),
      targetInstanceId,
    };
    try {
      this.onPetAction?.(event);
    } catch {
      // The persisted Territory action is authoritative; a closed Renderer
      // must not turn an already-applied action into a retryable Tool failure.
    }
    return event;
  }

  private insideZone(
    point: TerritoryGridPoint,
    zone: TerritoryWorldSnapshot["world"]["zones"][number],
  ): boolean {
    return (
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < zone.bounds.width &&
      point.y < zone.bounds.height
    );
  }

  private planPetMove(
    snapshot: TerritoryWorldSnapshot,
    request: {
      readonly interactionInstanceId?: string;
      readonly point?: TerritoryGridPoint;
      readonly requireExactPoint: boolean;
    },
    context?: {
      readonly view: TerritoryZoneView;
      readonly zone: TerritoryWorldSnapshot["world"]["zones"][number];
    },
  ): TerritoryPetMovePlan | undefined {
    const { view, zone } = context ?? this.activeZoneContext(snapshot);
    const definitions = new Map(
      view.definitions.map((definition) => [
        definitionKey(definition),
        definition,
      ]),
    );
    const blocked = blockedTerritoryWorldCells(view);
    const interaction = request.interactionInstanceId
      ? view.instances.find(({ id }) => id === request.interactionInstanceId)
      : undefined;
    const interactionDefinition = interaction
      ? definitions.get(definitionKey(interaction.definition))
      : undefined;
    if (
      request.interactionInstanceId &&
      (!interaction || !interactionDefinition)
    ) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "这个物件当前不能与桌宠互动。",
        false,
      );
    }
    const root = interaction
      ? this.resolvePlacedRoot(view, interaction)
      : undefined;
    const rootDefinition = root
      ? definitions.get(definitionKey(root.definition))
      : undefined;
    if (
      interaction &&
      (!root || !rootDefinition || root.placement.kind !== "zone")
    ) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "这个物件当前不能与桌宠互动。",
        false,
      );
    }
    if (request.point && !this.insideZone(request.point, zone))
      return undefined;
    const targetPoints =
      root && rootDefinition
        ? [
            ...new Map(
              territoryInstanceFootprint(root, rootDefinition)
                .flatMap((point) => [
                  { x: point.x - 1, y: point.y },
                  { x: point.x + 1, y: point.y },
                  { x: point.x, y: point.y - 1 },
                  { x: point.x, y: point.y + 1 },
                ])
                .filter(
                  (point) =>
                    this.insideZone(point, zone) &&
                    !blocked.has(`${String(point.x)},${String(point.y)}`),
                )
                .map((point) => [
                  `${String(point.x)},${String(point.y)}`,
                  point,
                ]),
            ).values(),
          ]
        : request.point
          ? [request.point]
          : [];
    const paths = targetPoints.flatMap((point) => {
      const candidate = findTerritoryWorldPath(
        zone,
        snapshot.pet.point,
        point,
        blocked,
      );
      if (!candidate) return [];
      if (
        (interaction || request.requireExactPoint) &&
        !pointsEqual(candidate.at(-1), point)
      ) {
        return [];
      }
      return [candidate];
    });
    paths.sort(
      (left, right) =>
        left.length - right.length ||
        (left.at(-1)?.y ?? 0) - (right.at(-1)?.y ?? 0) ||
        (left.at(-1)?.x ?? 0) - (right.at(-1)?.x ?? 0),
    );
    const path = paths[0];
    const destination = path?.at(-1);
    if (!path || !destination) return undefined;
    let facing = snapshot.pet.facing;
    for (let index = path.length - 1; index > 0; index -= 1) {
      const current = path[index];
      const previous = path[index - 1];
      if (current && previous && current.x !== previous.x) {
        facing = current.x < previous.x ? "left" : "right";
        break;
      }
    }
    if (root?.placement.kind === "zone") {
      facing = destination.x < root.placement.point.x ? "right" : "left";
    }
    return {
      destination,
      facing,
      interactionDefinition,
      path,
    };
  }

  private resolvePlacedRoot(
    view: TerritoryZoneView,
    instance: TerritoryInstance,
  ): TerritoryInstance | undefined {
    const instances = new Map(
      view.instances.map((candidate) => [candidate.id, candidate]),
    );
    const seen = new Set<string>();
    let current: TerritoryInstance | undefined = instance;
    while (current?.placement.kind === "attachment") {
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
      current = instances.get(current.placement.parentInstanceId);
    }
    return current?.placement.kind === "zone" ? current : undefined;
  }

  enterZone(request: TerritoryEnterZoneRequest): TerritoryWorldSnapshot {
    const snapshot = this.repository.getSnapshot();
    if (
      request.fromZoneId !== snapshot.world.activeZoneId ||
      snapshot.pet.zoneId !== request.fromZoneId
    ) {
      throw new TerritoryError(
        "TERRITORY.REVISION_CONFLICT",
        "当前打开的区域已经变化，请重试。",
        false,
      );
    }
    const connection = snapshot.world.connections.find(
      (candidate) =>
        (candidate.fromZoneId === request.fromZoneId &&
          candidate.toZoneId === request.toZoneId) ||
        (candidate.toZoneId === request.fromZoneId &&
          candidate.fromZoneId === request.toZoneId),
    );
    const zone = snapshot.world.zones.find(
      (candidate) =>
        candidate.id === request.toZoneId && candidate.status === "active",
    );
    if (!connection || !zone) {
      throw new TerritoryError(
        "TERRITORY.ZONE_NOT_FOUND",
        "这两个区域之间还没有可通行的连接。",
        false,
      );
    }
    const requestedPoint =
      connection.toZoneId === zone.id ? connection.to : connection.from;
    const view = this.repository.getZoneView({
      revisionId: snapshot.world.currentRevision.id,
      zoneId: zone.id,
    });
    const blocked = blockedTerritoryWorldCells(view);
    const candidates = Array.from(
      { length: zone.bounds.width * zone.bounds.height },
      (_, index) => ({
        x: index % zone.bounds.width,
        y: Math.floor(index / zone.bounds.width),
      }),
    ).sort((left, right) => {
      const leftDistance =
        Math.abs(left.x - requestedPoint.x) +
        Math.abs(left.y - requestedPoint.y);
      const rightDistance =
        Math.abs(right.x - requestedPoint.x) +
        Math.abs(right.y - requestedPoint.y);
      return (
        leftDistance - rightDistance || left.y - right.y || left.x - right.x
      );
    });
    const destination = candidates.find(
      (point) => !blocked.has(`${String(point.x)},${String(point.y)}`),
    );
    if (!destination) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "目标区域暂时没有可进入的位置。",
        false,
      );
    }
    const now = this.clock.now();
    return this.repository.commitChangeSet({
      changeSet: {
        baseRevisionId: snapshot.world.currentRevision.id,
        id: this.repository.nextId(),
        label: `进入「${zone.name}」`,
        mutations: [
          {
            changeId: this.repository.nextId(),
            kind: "active-zone.set",
            zoneId: zone.id,
          },
        ],
      },
      now,
      pet: {
        ...snapshot.pet,
        behavior: "idle",
        point: destination,
        updatedAt: now,
        zoneId: zone.id,
      },
      reason: "direct",
    });
  }

  async createCandidate(
    request: TerritoryCreateChangeCandidateRequest,
  ): Promise<TerritoryCandidateMutationResult> {
    if (!this.candidates) {
      return this.repository.createCandidate(request, this.clock.now());
    }
    return this.candidates.create(request);
  }

  beginCreateCandidate(
    request: TerritoryCreateChangeCandidateRequest,
  ): TerritoryWorldCandidateJob {
    if (!this.candidates) {
      const initial = this.repository.createCandidate(
        request,
        this.clock.now(),
      );
      return { completion: Promise.resolve(initial), initial };
    }
    return this.candidates.beginCreate(request);
  }

  async editCandidate(
    request: TerritoryEditChangeCandidateRequest,
  ): Promise<TerritoryCandidateMutationResult> {
    if (this.candidates) return this.candidates.edit(request);
    return this.repository.editCandidate(request, this.clock.now());
  }

  beginEditCandidate(
    request: TerritoryEditChangeCandidateRequest,
  ): TerritoryWorldCandidateJob {
    if (!this.candidates) {
      const initial = this.repository.editCandidate(request, this.clock.now());
      return { completion: Promise.resolve(initial), initial };
    }
    return this.candidates.beginEdit(request);
  }

  async cancelCandidate(
    request: TerritoryCandidateIdRequest,
  ): Promise<TerritoryCandidateMutationResult> {
    if (this.candidates) {
      return this.candidates.cancelCandidate(request.candidateId);
    }
    return {
      candidateId: request.candidateId,
      snapshot: this.repository.cancelCandidate(
        request.candidateId,
        this.clock.now(),
      ),
    };
  }

  applyCandidate(
    request: TerritoryCandidateIdRequest,
  ): TerritoryCandidateMutationResult {
    return {
      candidateId: request.candidateId,
      snapshot: this.repository.applyCandidate(
        request.candidateId,
        this.clock.now(),
      ),
    };
  }
}
