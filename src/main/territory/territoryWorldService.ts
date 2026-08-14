import type {
  TerritoryCandidateIdRequest,
  TerritoryCandidateMutationResult,
  TerritoryCommitChangeSetRequest,
  TerritoryCreateChangeCandidateRequest,
  TerritoryEditChangeCandidateRequest,
  TerritoryEnterZoneRequest,
  TerritoryGetZoneViewRequest,
  TerritoryMovePetRequest,
  TerritoryMovePetResult,
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

export class TerritoryWorldService {
  constructor(
    private readonly repository: TerritoryWorldRepository,
    private readonly clock: Clock,
    private readonly candidates?: TerritoryWorldCandidateService,
    private readonly assets?: TerritoryWorldAssetStore,
  ) {}

  getSnapshot(): TerritoryWorldSnapshot {
    return this.repository.getSnapshot();
  }

  getZoneView(request: TerritoryGetZoneViewRequest): TerritoryZoneView {
    return this.repository.getZoneView(request);
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
    const zone = snapshot.world.zones.find(
      (candidate) => candidate.id === request.zoneId,
    );
    if (
      !zone ||
      zone.status !== "active" ||
      snapshot.world.activeZoneId !== zone.id ||
      snapshot.pet.zoneId !== zone.id
    ) {
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
    if (
      !request.interactionInstanceId &&
      (request.to.x >= zone.bounds.width || request.to.y >= zone.bounds.height)
    ) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "点击位置不在当前区域内。",
        false,
      );
    }

    const view = this.repository.getZoneView({
      revisionId: snapshot.world.currentRevision.id,
      zoneId: zone.id,
    });
    const blocked = blockedTerritoryWorldCells(view);
    const interaction = request.interactionInstanceId
      ? view.instances.find(({ id }) => id === request.interactionInstanceId)
      : undefined;
    const interactionDefinition = interaction
      ? view.definitions.find(
          ({ id, revision }) =>
            id === interaction.definition.id &&
            revision === interaction.definition.revision,
        )
      : undefined;
    if (
      request.interactionInstanceId &&
      (!interaction ||
        !interactionDefinition ||
        interaction.placement.kind === "collection")
    ) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "这个物件当前不能与桌宠互动。",
        false,
      );
    }
    const interactionOrigin =
      interaction?.placement.kind === "zone"
        ? interaction.placement.point
        : request.to;
    const targetPoints = interaction
      ? [
          ...new Map(
            territoryInstanceFootprint(interaction, interactionDefinition!)
              .flatMap((point) => [
                { x: point.x - 1, y: point.y },
                { x: point.x + 1, y: point.y },
                { x: point.x, y: point.y - 1 },
                { x: point.x, y: point.y + 1 },
              ])
              .filter(
                (point) =>
                  point.x >= 0 &&
                  point.y >= 0 &&
                  point.x < zone.bounds.width &&
                  point.y < zone.bounds.height &&
                  !blocked.has(`${String(point.x)},${String(point.y)}`),
              )
              .map((point) => [`${String(point.x)},${String(point.y)}`, point]),
          ).values(),
        ]
      : [request.to];
    const paths = targetPoints.flatMap((point) => {
      const candidate = findTerritoryWorldPath(
        zone,
        request.from,
        point,
        blocked,
      );
      return candidate ? [candidate] : [];
    });
    paths.sort(
      (left, right) =>
        left.length - right.length ||
        (left.at(-1)?.y ?? 0) - (right.at(-1)?.y ?? 0) ||
        (left.at(-1)?.x ?? 0) - (right.at(-1)?.x ?? 0),
    );
    const path = paths[0];
    const destination = path?.at(-1);
    if (!path || !destination) {
      throw new TerritoryError(
        "TERRITORY.NO_PATH",
        "桌宠暂时走不到那里。",
        false,
      );
    }
    let facing = snapshot.pet.facing;
    for (let index = path.length - 1; index > 0; index -= 1) {
      const current = path[index];
      const previous = path[index - 1];
      if (current && previous && current.x !== previous.x) {
        facing = current.x < previous.x ? "left" : "right";
        break;
      }
    }
    if (interaction) {
      facing = destination.x < interactionOrigin.x ? "right" : "left";
    }
    const behavior = interactionDefinition?.capabilities.includes("sleepable")
      ? "sleeping"
      : interactionDefinition?.capabilities.includes("seatable")
        ? "sitting"
        : interaction
          ? "observing"
          : "idle";
    this.repository.savePet({
      behavior,
      facing,
      point: destination,
      updatedAt: this.clock.now(),
      zoneId: zone.id,
    });
    return { path, snapshot: this.repository.getSnapshot() };
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
