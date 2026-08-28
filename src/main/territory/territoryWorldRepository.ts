import type Database from "better-sqlite3";
import type { Static, TSchema } from "@sinclair/typebox";

import type {
  TerritoryAsset,
  TerritoryAssetPack,
  TerritoryChangeCandidate,
  TerritoryCreateChangeCandidateRequest,
  TerritoryDefinition,
  TerritoryEditChangeCandidateRequest,
  TerritoryGetZoneViewRequest,
  TerritoryInstance,
  TerritoryPetState,
  TerritoryWorldChangeSet,
  TerritoryWorldRevisionSummary,
  TerritoryWorldSnapshot,
  TerritoryWorldState,
  TerritoryZoneView,
} from "../../shared/contracts/territoryWorld";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { AppError } from "../../shared/contracts/run";
import type { IdGenerator } from "../../shared/pure/id";
import { applyTerritoryWorldChangeSet } from "../../shared/pure/territoryWorldChanges";
import { validateTerritoryZoneSpatialState } from "../../shared/pure/territoryWorldGrid";
import {
  validateTerritoryWorldChangeSet,
  validateTerritoryWorldSnapshot,
  validateTerritoryZoneView,
} from "../../shared/pure/territoryWorldValidation";
import {
  TerritoryAssetPackSchema,
  TerritoryAssetSchema,
  TerritoryChangeCandidateSchema,
  TerritoryCreateChangeCandidateRequestSchema,
  TerritoryDefinitionSchema,
  TerritoryEditChangeCandidateRequestSchema,
  TerritoryPetStateSchema,
  TerritoryWorldChangeSetSchema,
  TerritoryWorldSnapshotSchema,
  TerritoryWorldStateSchema,
  TerritoryZoneViewSchema,
} from "../../shared/schemas/territoryWorld";
import { parseSchema } from "../../shared/schemas/validation";
import { serializeForPersistence } from "../db/persistenceBoundary";
import { TerritoryError } from "./territoryError";
import { legacyTerritoryNarrativeUpgrade } from "./territoryWorldNarrative";
import type { StoredTerritoryWorldAsset } from "./territoryWorldAssetStore";

interface WorldRow {
  created_at: string;
  current_revision_id: string;
  name: string;
  updated_at: string;
  world_id: "territory";
}

interface RevisionRow {
  created_at: string;
  label: string;
  parent_revision_id: string | null;
  reason: TerritoryWorldRevisionSummary["reason"];
  revision_id: string;
  sequence: number;
  state_json: string;
}

interface AssetRow {
  asset_id: string;
  byte_length: number;
  created_at: string;
  height: number;
  media_type: TerritoryAsset["mediaType"];
  origin: TerritoryAsset["origin"];
  sha256: string;
  storage_key: string;
  width: number;
}

interface JsonManifestRow {
  manifest_json: string;
}

interface CandidateRow {
  applied_revision_id: string | null;
  base_revision_id: string;
  candidate_id: string;
  change_set_json: string | null;
  created_at: string;
  edit_request_json: string | null;
  error_json: string | null;
  preview_groups_json: string;
  request_json: string;
  status: TerritoryChangeCandidate["status"];
  updated_at: string;
}

interface PetRow {
  behavior: TerritoryPetState["behavior"];
  facing: TerritoryPetState["facing"];
  pet_x: number;
  pet_y: number;
  updated_at: string;
  zone_id: string;
}

interface PurgedRow {
  instance_id: string;
}

export interface TerritorySeedAsset {
  readonly asset: TerritoryAsset;
  readonly storageKey: string;
}

export interface TerritoryWorldSeed {
  readonly assetPacks: readonly TerritoryAssetPack[];
  readonly assets: readonly TerritorySeedAsset[];
  readonly definitions: readonly TerritoryDefinition[];
  readonly name: string;
  readonly pet: TerritoryPetState;
  readonly revision: TerritoryWorldRevisionSummary;
  readonly state: TerritoryWorldState;
}

export interface TerritoryCommitInput {
  readonly appliedCandidateId?: string;
  readonly changeSet: TerritoryWorldChangeSet;
  readonly now: Timestamp;
  readonly pet?: TerritoryPetState;
  readonly reason: "ai" | "direct";
}

function parseJson<T extends TSchema>(schema: T, json: string): Static<T> {
  return parseSchema(schema, JSON.parse(json) as unknown);
}

function revisionSummary(row: RevisionRow): TerritoryWorldRevisionSummary {
  return {
    createdAt: row.created_at,
    id: row.revision_id,
    label: row.label,
    parentRevisionId: row.parent_revision_id,
    reason: row.reason,
    sequence: row.sequence,
  };
}

function definitionKey(definition: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${definition.id}@${String(definition.revision)}`;
}

function pointIntersectsViewport(
  point: { readonly x: number; readonly y: number },
  size: { readonly height: number; readonly width: number },
  viewport: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
): boolean {
  return (
    point.x < viewport.x + viewport.width &&
    point.x + size.width > viewport.x &&
    point.y < viewport.y + viewport.height &&
    point.y + size.height > viewport.y
  );
}

export class TerritoryWorldRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly ids: IdGenerator,
  ) {}

  nextId(): string {
    return this.ids.generate();
  }

  ensureInitialized(seed: TerritoryWorldSeed): void {
    const existing = this.database
      .prepare(
        "SELECT world_id FROM territory_worlds WHERE world_id = 'territory'",
      )
      .get() as { world_id: string } | undefined;
    if (existing) return;

    const initialize = this.database.transaction(() => {
      parseSchema(TerritoryWorldStateSchema, seed.state);
      parseSchema(TerritoryPetStateSchema, seed.pet);
      for (const entry of seed.assets) {
        parseSchema(TerritoryAssetSchema, entry.asset);
        this.database
          .prepare(
            `INSERT INTO territory_world_assets (
               asset_id, media_type, origin, width, height, byte_length,
               sha256, storage_key, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.asset.id,
            entry.asset.mediaType,
            entry.asset.origin,
            entry.asset.width,
            entry.asset.height,
            entry.asset.byteLength,
            entry.asset.sha256,
            entry.storageKey,
            entry.asset.createdAt,
          );
      }
      for (const pack of seed.assetPacks) {
        parseSchema(TerritoryAssetPackSchema, pack);
        this.database
          .prepare(
            `INSERT INTO territory_asset_pack_revisions (
               pack_id, revision, manifest_json, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            pack.id,
            pack.revision,
            serializeForPersistence(pack),
            pack.createdAt,
          );
      }
      for (const definition of seed.definitions) {
        parseSchema(TerritoryDefinitionSchema, definition);
        this.database
          .prepare(
            `INSERT INTO territory_definition_revisions (
               definition_id, revision, manifest_json, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            definition.id,
            definition.revision,
            serializeForPersistence(definition),
            definition.createdAt,
          );
      }
      this.database
        .prepare(
          `INSERT INTO territory_worlds (
             world_id, name, current_revision_id, created_at, updated_at
           ) VALUES ('territory', ?, ?, ?, ?)`,
        )
        .run(
          seed.name,
          seed.revision.id,
          seed.revision.createdAt,
          seed.revision.createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO territory_world_revisions (
             revision_id, world_id, sequence, parent_revision_id, label,
             reason, state_json, created_at
           ) VALUES (?, 'territory', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seed.revision.id,
          seed.revision.sequence,
          seed.revision.parentRevisionId,
          seed.revision.label,
          seed.revision.reason,
          serializeForPersistence(seed.state),
          seed.revision.createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO territory_world_pet_state (
             world_id, zone_id, pet_x, pet_y, facing, behavior, updated_at
           ) VALUES ('territory', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seed.pet.zoneId,
          seed.pet.point.x,
          seed.pet.point.y,
          seed.pet.facing,
          seed.pet.behavior,
          seed.pet.updatedAt,
        );
      this.syncSources(seed.state.instances);
      this.assertCurrentProjectionValid();
    });
    initialize();
  }

  ensurePoeticDescriptions(now: Timestamp): boolean {
    const snapshot = this.getSnapshot();
    const state = this.getCurrentState();
    const purged = this.listPurgedIds();
    const definitions = this.listDefinitions();
    const byKey = new Map(
      definitions.map((definition) => [definitionKey(definition), definition]),
    );
    const latestRevision = new Map<string, number>();
    for (const definition of definitions) {
      latestRevision.set(
        definition.id,
        Math.max(latestRevision.get(definition.id) ?? 0, definition.revision),
      );
    }
    const instancesByDefinition = new Map<string, TerritoryInstance[]>();
    for (const instance of state.instances) {
      if (purged.has(instance.id)) continue;
      const key = definitionKey(instance.definition);
      const instances = instancesByDefinition.get(key) ?? [];
      instances.push(instance);
      instancesByDefinition.set(key, instances);
    }

    const mutations: TerritoryWorldChangeSet["mutations"][number][] = [];
    for (const [key, instances] of instancesByDefinition) {
      const definition = byKey.get(key);
      if (!definition) continue;
      const content = legacyTerritoryNarrativeUpgrade(definition, instances);
      if (!content) continue;
      const nextDefinition: TerritoryDefinition = {
        ...definition,
        createdAt: now,
        description: content.description,
        name: content.name,
        revision:
          (latestRevision.get(definition.id) ?? definition.revision) + 1,
        tags: definition.id.startsWith("generated.")
          ? [...new Set([...definition.tags, "narrative-v1"])]
          : definition.tags,
      };
      latestRevision.set(definition.id, nextDefinition.revision);
      mutations.push({
        changeId: this.ids.generate(),
        definition: nextDefinition,
        kind: "definition.put",
      });
      for (const instance of instances) {
        mutations.push({
          changeId: this.ids.generate(),
          instance: {
            ...instance,
            definition: {
              id: nextDefinition.id,
              revision: nextDefinition.revision,
            },
            updatedAt: now,
          },
          kind: "instance.put",
        });
      }
    }
    if (mutations.length === 0) return false;
    this.commitChangeSet({
      changeSet: {
        baseRevisionId: snapshot.world.currentRevision.id,
        id: this.ids.generate(),
        label: "补全领地物件故事",
        mutations,
      },
      now,
      reason: "direct",
    });
    return true;
  }

  getSnapshot(): TerritoryWorldSnapshot {
    const world = this.requireWorld();
    const revisionRows = this.database
      .prepare(
        `SELECT revision_id, sequence, parent_revision_id, label, reason,
                state_json, created_at
           FROM territory_world_revisions
          WHERE world_id = 'territory'
          ORDER BY sequence DESC`,
      )
      .all() as RevisionRow[];
    const currentRow = revisionRows.find(
      (revision) => revision.revision_id === world.current_revision_id,
    );
    if (!currentRow) {
      throw new TerritoryError(
        "TERRITORY.REVISION_NOT_FOUND",
        "当前领地版本不存在。",
        false,
      );
    }
    const state = this.readState(currentRow);
    const purged = this.listPurgedIds();
    const instances = state.instances.filter(
      (instance) => !purged.has(instance.id),
    );
    const definitions = this.listDefinitions();
    const assets = this.listAssets();
    const assetPacks = this.listAssetPacks();
    const pet = this.requirePet();
    return parseSchema(TerritoryWorldSnapshotSchema, {
      assetPacks,
      assets,
      candidates: this.listCandidates(),
      collection: instances.filter(
        (instance) =>
          instance.status === "active" &&
          instance.placement.kind === "collection",
      ),
      definitions,
      pet,
      revisions: revisionRows.map(revisionSummary),
      styles: state.styles,
      trash: instances.filter((instance) => instance.status === "trashed"),
      world: {
        activeZoneId: state.activeZoneId,
        connections: state.connections,
        currentRevision: revisionSummary(currentRow),
        id: "territory",
        name: world.name,
        zones: state.zones,
      },
    });
  }

  getZoneView(request: TerritoryGetZoneViewRequest): TerritoryZoneView {
    const revision = this.requireRevision(request.revisionId);
    const state = this.readState(revision);
    const zone = state.zones.find(
      (candidate) => candidate.id === request.zoneId,
    );
    if (!zone) {
      throw new TerritoryError(
        "TERRITORY.ZONE_NOT_FOUND",
        "找不到这个领地区域。",
        false,
      );
    }
    const allDefinitions = this.listDefinitions();
    const definitions = new Map(
      allDefinitions.map((definition) => [
        definitionKey(definition),
        definition,
      ]),
    );
    const purged = this.listPurgedIds();
    const zoneInstances = state.instances.filter(
      (instance) =>
        !purged.has(instance.id) &&
        instance.status === "active" &&
        instance.placement.kind !== "collection" &&
        instance.placement.zoneId === zone.id,
    );
    const allById = new Map(
      zoneInstances.map((instance) => [instance.id, instance]),
    );
    const selected = new Set<string>();
    const rootPoint = (
      instance: TerritoryInstance,
    ): { x: number; y: number } | null => {
      let current: TerritoryInstance | undefined = instance;
      const visited = new Set<string>();
      while (current?.placement.kind === "attachment") {
        if (visited.has(current.id)) return null;
        visited.add(current.id);
        current = allById.get(current.placement.parentInstanceId);
      }
      return current?.placement.kind === "zone"
        ? current.placement.point
        : null;
    };
    for (const instance of zoneInstances) {
      if (!request.viewport) {
        selected.add(instance.id);
        continue;
      }
      const point = rootPoint(instance);
      const definition = definitions.get(definitionKey(instance.definition));
      if (!point || !definition) continue;
      const size =
        definition.placement.mode === "grid"
          ? {
              height:
                Math.max(
                  ...definition.placement.footprintCells.map((cell) => cell.y),
                ) + 1,
              width:
                Math.max(
                  ...definition.placement.footprintCells.map((cell) => cell.x),
                ) + 1,
            }
          : { height: 1, width: 1 };
      if (pointIntersectsViewport(point, size, request.viewport)) {
        selected.add(instance.id);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const instance of zoneInstances) {
        if (
          instance.placement.kind === "attachment" &&
          (selected.has(instance.id) ||
            selected.has(instance.placement.parentInstanceId))
        ) {
          if (!selected.has(instance.id)) {
            selected.add(instance.id);
            changed = true;
          }
          if (!selected.has(instance.placement.parentInstanceId)) {
            selected.add(instance.placement.parentInstanceId);
            changed = true;
          }
        }
      }
      for (const group of state.groups) {
        if (
          group.zoneId === zone.id &&
          group.instanceIds.some((instanceId) => selected.has(instanceId))
        ) {
          for (const instanceId of group.instanceIds) {
            if (!selected.has(instanceId)) {
              selected.add(instanceId);
              changed = true;
            }
          }
        }
      }
    }

    const instances = zoneInstances.filter((instance) =>
      selected.has(instance.id),
    );
    const referencedDefinitions = new Set(
      instances.map((instance) => definitionKey(instance.definition)),
    );
    const pet = this.requirePet();
    const petVisible =
      pet.zoneId === zone.id &&
      (!request.viewport ||
        pointIntersectsViewport(
          pet.point,
          { height: 1, width: 1 },
          request.viewport,
        ));
    const style = state.styles.find(
      (candidate) =>
        candidate.id === zone.styleProfile.id &&
        candidate.revision === zone.styleProfile.revision,
    );
    if (!style) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "区域引用的视觉风格版本不存在。",
        false,
      );
    }
    return parseSchema(TerritoryZoneViewSchema, {
      definitions: allDefinitions.filter((definition) =>
        referencedDefinitions.has(definitionKey(definition)),
      ),
      groups: state.groups.filter(
        (group) =>
          group.zoneId === zone.id &&
          group.instanceIds.every((instanceId) => selected.has(instanceId)),
      ),
      instances,
      pet: petVisible ? pet : null,
      revisionId: revision.revision_id,
      style,
      viewport: request.viewport ?? null,
      zone,
    });
  }

  commitChangeSet(input: TerritoryCommitInput): TerritoryWorldSnapshot {
    const commit = this.database.transaction(() => {
      const snapshot = this.getSnapshot();
      const views = snapshot.world.zones
        .filter((zone) => zone.status === "active")
        .map((zone) =>
          this.getZoneView({
            revisionId: snapshot.world.currentRevision.id,
            zoneId: zone.id,
          }),
        );
      const parsedChangeSet = parseSchema(
        TerritoryWorldChangeSetSchema,
        input.changeSet,
      );
      const issues = validateTerritoryWorldChangeSet(
        parsedChangeSet,
        snapshot,
        views,
      );
      if (issues.length > 0) {
        const first = issues[0]!;
        const code =
          first.code === "REVISION_CONFLICT"
            ? "TERRITORY.REVISION_CONFLICT"
            : "TERRITORY.CHANGESET_INVALID";
        throw new TerritoryError(code, first.message, false);
      }

      const currentRevision = this.requireRevision(
        snapshot.world.currentRevision.id,
      );
      const currentState = this.readState(currentRevision);
      const nextState = applyTerritoryWorldChangeSet(
        currentState,
        parsedChangeSet,
      );
      parseSchema(TerritoryWorldStateSchema, nextState);
      for (const mutation of parsedChangeSet.mutations) {
        if (mutation.kind === "definition.put") {
          this.database
            .prepare(
              `INSERT INTO territory_definition_revisions (
                 definition_id, revision, manifest_json, created_at
               ) VALUES (?, ?, ?, ?)`,
            )
            .run(
              mutation.definition.id,
              mutation.definition.revision,
              serializeForPersistence(mutation.definition),
              mutation.definition.createdAt,
            );
        } else if (mutation.kind === "asset-pack.put") {
          this.database
            .prepare(
              `INSERT INTO territory_asset_pack_revisions (
                 pack_id, revision, manifest_json, created_at
               ) VALUES (?, ?, ?, ?)`,
            )
            .run(
              mutation.assetPack.id,
              mutation.assetPack.revision,
              serializeForPersistence(mutation.assetPack),
              mutation.assetPack.createdAt,
            );
        }
      }
      const revisionId = this.ids.generate();
      this.database
        .prepare(
          `INSERT INTO territory_world_revisions (
             revision_id, world_id, sequence, parent_revision_id, label,
             reason, state_json, created_at
           ) VALUES (?, 'territory', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          currentRevision.sequence + 1,
          currentRevision.revision_id,
          parsedChangeSet.label,
          input.reason,
          serializeForPersistence(nextState),
          input.now,
        );
      this.database
        .prepare(
          `UPDATE territory_worlds
              SET current_revision_id = ?, updated_at = ?
            WHERE world_id = 'territory'`,
        )
        .run(revisionId, input.now);
      this.syncSources(nextState.instances);
      if (input.pet) this.savePet(input.pet);
      this.markOtherCandidatesStale(input.appliedCandidateId, input.now);
      if (input.appliedCandidateId) {
        const result = this.database
          .prepare(
            `UPDATE territory_change_candidates
                SET status = 'applied', applied_revision_id = ?, updated_at = ?
              WHERE candidate_id = ? AND status = 'ready'`,
          )
          .run(revisionId, input.now, input.appliedCandidateId);
        if (result.changes !== 1) {
          throw new TerritoryError(
            "TERRITORY.INVALID_CANDIDATE_STATE",
            "这个领地预览已经不能应用。",
            false,
          );
        }
      }
      this.assertCurrentProjectionValid();
    });
    commit();
    return this.getSnapshot();
  }

  restoreRevision(revisionId: string, now: Timestamp): TerritoryWorldSnapshot {
    const restore = this.database.transaction(() => {
      const world = this.requireWorld();
      const current = this.requireRevision(world.current_revision_id);
      const target = this.requireRevision(revisionId);
      const purged = this.listPurgedIds();
      const targetState = this.readState(target);
      targetState.instances = targetState.instances.filter(
        (instance) => !purged.has(instance.id),
      );
      const newRevisionId = this.ids.generate();
      this.database
        .prepare(
          `INSERT INTO territory_world_revisions (
             revision_id, world_id, sequence, parent_revision_id, label,
             reason, state_json, created_at
           ) VALUES (?, 'territory', ?, ?, ?, 'restore', ?, ?)`,
        )
        .run(
          newRevisionId,
          current.sequence + 1,
          current.revision_id,
          `恢复到「${target.label}」`,
          serializeForPersistence(targetState),
          now,
        );
      this.database
        .prepare(
          `UPDATE territory_worlds
              SET current_revision_id = ?, updated_at = ?
            WHERE world_id = 'territory'`,
        )
        .run(newRevisionId, now);
      this.syncSources(targetState.instances);
      this.markOtherCandidatesStale(undefined, now);
      this.assertCurrentProjectionValid();
    });
    restore();
    return this.getSnapshot();
  }

  purgeInstance(instanceId: string, now: Timestamp): TerritoryWorldSnapshot {
    const purge = this.database.transaction(() => {
      const snapshot = this.getSnapshot();
      const instance = snapshot.trash.find(
        (candidate) => candidate.id === instanceId,
      );
      if (!instance) {
        throw new TerritoryError(
          "TERRITORY.INSTANCE_NOT_TRASHED",
          "物件必须先进入回收站，才能永久删除。",
          false,
        );
      }
      this.database
        .prepare(
          `INSERT INTO territory_purged_instances (instance_id, purged_at)
           VALUES (?, ?)`,
        )
        .run(instanceId, now);
      const current = this.requireRevision(snapshot.world.currentRevision.id);
      const state = this.readState(current);
      state.instances = state.instances.filter(
        (candidate) => candidate.id !== instanceId,
      );
      state.groups = state.groups
        .map((group) => ({
          ...group,
          instanceIds: group.instanceIds.filter((id) => id !== instanceId),
        }))
        .filter((group) => group.instanceIds.length >= 2);
      const nextRevisionId = this.ids.generate();
      this.database
        .prepare(
          `INSERT INTO territory_world_revisions (
             revision_id, world_id, sequence, parent_revision_id, label,
             reason, state_json, created_at
           ) VALUES (?, 'territory', ?, ?, ?, 'direct', ?, ?)`,
        )
        .run(
          nextRevisionId,
          current.sequence + 1,
          current.revision_id,
          "永久删除领地物件",
          serializeForPersistence(state),
          now,
        );
      this.database
        .prepare(
          `UPDATE territory_worlds
              SET current_revision_id = ?, updated_at = ?
            WHERE world_id = 'territory'`,
        )
        .run(nextRevisionId, now);
      this.syncSources(state.instances);
      this.deleteCandidateProjectionsForInstance(instanceId);
      this.pruneUnreferencedDefinitionsAndAssets(state);
      this.markOtherCandidatesStale(undefined, now);
      this.assertCurrentProjectionValid();
    });
    purge();
    return this.getSnapshot();
  }

  savePet(pet: TerritoryPetState): void {
    parseSchema(TerritoryPetStateSchema, pet);
    const state = this.readState(
      this.requireRevision(this.requireWorld().current_revision_id),
    );
    const zone = state.zones.find(
      (candidate) =>
        candidate.id === pet.zoneId && candidate.status === "active",
    );
    if (
      !zone ||
      pet.point.x >= zone.bounds.width ||
      pet.point.y >= zone.bounds.height
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_PLACEMENT",
        "桌宠不能移动到这个位置。",
        false,
      );
    }
    this.database
      .prepare(
        `UPDATE territory_world_pet_state
            SET zone_id = ?, pet_x = ?, pet_y = ?, facing = ?, behavior = ?,
                updated_at = ?
          WHERE world_id = 'territory'`,
      )
      .run(
        pet.zoneId,
        pet.point.x,
        pet.point.y,
        pet.facing,
        pet.behavior,
        pet.updatedAt,
      );
  }

  getCurrentState(): TerritoryWorldState {
    return this.readState(
      this.requireRevision(this.requireWorld().current_revision_id),
    );
  }

  installAsset(record: StoredTerritoryWorldAsset): void {
    const asset = parseSchema(TerritoryAssetSchema, record.asset);
    const existing = this.getStoredAsset(asset.id);
    if (existing) {
      if (
        existing.storageKey !== record.storageKey ||
        JSON.stringify(existing.asset) !== JSON.stringify(asset)
      ) {
        throw new TerritoryError(
          "TERRITORY.ASSET_CONFLICT",
          `图片资产 ${asset.id} 已存在且登记内容不同。`,
          false,
        );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO territory_world_assets (
           asset_id, media_type, origin, width, height, byte_length,
           sha256, storage_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.id,
        asset.mediaType,
        asset.origin,
        asset.width,
        asset.height,
        asset.byteLength,
        asset.sha256,
        record.storageKey,
        asset.createdAt,
      );
  }

  getStoredAsset(assetId: string): StoredTerritoryWorldAsset | undefined {
    const row = this.database
      .prepare(
        `SELECT asset_id, media_type, origin, width, height, byte_length,
                sha256, storage_key, created_at
           FROM territory_world_assets
          WHERE asset_id = ?`,
      )
      .get(assetId) as AssetRow | undefined;
    if (!row) return undefined;
    return {
      asset: parseSchema(TerritoryAssetSchema, {
        byteLength: row.byte_length,
        createdAt: row.created_at,
        height: row.height,
        id: row.asset_id,
        mediaType: row.media_type,
        origin: row.origin,
        sha256: row.sha256,
        width: row.width,
      }),
      storageKey: row.storage_key,
    };
  }

  unregisterUnreferencedAsset(assetId: string): boolean {
    const referenced = this.database
      .prepare(
        `SELECT 1
           FROM territory_definition_revisions
          WHERE json_extract(manifest_json, '$.visual.assetId') = ?
          LIMIT 1`,
      )
      .get(assetId) as { 1: number } | undefined;
    if (referenced) return false;
    return (
      this.database
        .prepare("DELETE FROM territory_world_assets WHERE asset_id = ?")
        .run(assetId).changes === 1
    );
  }

  findInstanceBySource(
    kind: "activity_digest" | "memory",
    sourceId: string,
  ): TerritoryInstance | undefined {
    const purged = this.listPurgedIds();
    return this.getCurrentState().instances.find(
      (instance) =>
        !purged.has(instance.id) &&
        instance.sources.some(
          (source) => source.kind === kind && source.id === sourceId,
        ),
    );
  }

  findOpenCandidateBySource(
    kind: "activity_digest" | "memory",
    sourceId: string,
  ): TerritoryChangeCandidate | undefined {
    return this.listCandidates().find(
      (candidate) =>
        candidate.status !== "cancelled" &&
        candidate.status !== "applied" &&
        candidate.sources.some(
          (source) => source.kind === kind && source.id === sourceId,
        ),
    );
  }

  createCandidate(
    request: TerritoryCreateChangeCandidateRequest,
    now: Timestamp,
  ): { candidateId: string; snapshot: TerritoryWorldSnapshot } {
    const parsed = parseSchema(
      TerritoryCreateChangeCandidateRequestSchema,
      request,
    );
    const snapshot = this.getSnapshot();
    if (parsed.baseRevisionId !== snapshot.world.currentRevision.id) {
      throw new TerritoryError(
        "TERRITORY.REVISION_CONFLICT",
        "当前领地已经变化，请基于最新版本重新创建预览。",
        false,
      );
    }
    const candidateId = this.ids.generate();
    this.database
      .prepare(
        `INSERT INTO territory_change_candidates (
           candidate_id, base_revision_id, request_json, status,
           change_set_json, preview_groups_json, error_json,
           applied_revision_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'draft', NULL, '[]', NULL, NULL, ?, ?)`,
      )
      .run(
        candidateId,
        parsed.baseRevisionId,
        serializeForPersistence(parsed),
        now,
        now,
      );
    return { candidateId, snapshot: this.getSnapshot() };
  }

  editCandidate(
    request: TerritoryEditChangeCandidateRequest,
    now: Timestamp,
  ): { candidateId: string; snapshot: TerritoryWorldSnapshot } {
    const parsed = parseSchema(
      TerritoryEditChangeCandidateRequestSchema,
      request,
    );
    const candidate = this.requireCandidate(parsed.candidateId);
    if (
      candidate.status === "applied" ||
      candidate.status === "cancelled" ||
      candidate.status === "generating"
    ) {
      this.throwCandidateState(parsed.candidateId);
    }
    const row = this.requireCandidateRow(parsed.candidateId);
    const original = parseJson(
      TerritoryCreateChangeCandidateRequestSchema,
      row.request_json,
    );
    const nextRequest: TerritoryCreateChangeCandidateRequest = {
      ...original,
      lockedInstanceIds: parsed.lockedInstanceIds,
    };
    this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET request_json = ?, edit_request_json = ?, status = 'draft',
                change_set_json = NULL, preview_groups_json = '[]',
                error_json = NULL, applied_revision_id = NULL, updated_at = ?
          WHERE candidate_id = ?`,
      )
      .run(
        serializeForPersistence(nextRequest),
        serializeForPersistence(parsed),
        now,
        parsed.candidateId,
      );
    return { candidateId: parsed.candidateId, snapshot: this.getSnapshot() };
  }

  getCandidateWork(candidateId: string): {
    edit: TerritoryEditChangeCandidateRequest | null;
    request: TerritoryCreateChangeCandidateRequest;
  } {
    const row = this.requireCandidateRow(candidateId);
    return {
      edit:
        row.edit_request_json === null
          ? null
          : parseJson(
              TerritoryEditChangeCandidateRequestSchema,
              row.edit_request_json,
            ),
      request: parseJson(
        TerritoryCreateChangeCandidateRequestSchema,
        row.request_json,
      ),
    };
  }

  markCandidateGenerating(candidateId: string, now: Timestamp): void {
    const result = this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET status = 'generating', change_set_json = NULL,
                preview_groups_json = '[]', error_json = NULL,
                applied_revision_id = NULL, updated_at = ?
          WHERE candidate_id = ? AND status IN ('draft', 'failed', 'stale')`,
      )
      .run(now, candidateId);
    if (result.changes !== 1) this.throwCandidateState(candidateId);
  }

  setCandidateProviderProfile(
    candidateId: string,
    providerProfileId: string,
    now: Timestamp,
  ): void {
    const row = this.requireCandidateRow(candidateId);
    const request = parseJson(
      TerritoryCreateChangeCandidateRequestSchema,
      row.request_json,
    );
    this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET request_json = ?, updated_at = ?
          WHERE candidate_id = ? AND status = 'generating'`,
      )
      .run(
        serializeForPersistence({ ...request, providerProfileId }),
        now,
        candidateId,
      );
  }

  completeCandidate(
    candidateId: string,
    changeSet: TerritoryWorldChangeSet,
    previewGroups: TerritoryChangeCandidate["previewGroups"],
    now: Timestamp,
  ): TerritoryWorldSnapshot {
    const parsedChangeSet = parseSchema(
      TerritoryWorldChangeSetSchema,
      changeSet,
    );
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "generating")
      this.throwCandidateState(candidateId);
    const snapshot = this.getSnapshot();
    const nextStatus =
      candidate.baseRevisionId === snapshot.world.currentRevision.id
        ? "ready"
        : "stale";
    if (nextStatus === "ready") {
      const views = snapshot.world.zones
        .filter((zone) => zone.status === "active")
        .map((zone) =>
          this.getZoneView({
            revisionId: snapshot.world.currentRevision.id,
            zoneId: zone.id,
          }),
        );
      const issues = validateTerritoryWorldChangeSet(
        parsedChangeSet,
        snapshot,
        views,
      );
      if (issues.length > 0) {
        throw new TerritoryError(
          "TERRITORY.CHANGESET_INVALID",
          issues[0]!.message,
          false,
        );
      }
    }
    this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET status = ?, change_set_json = ?, preview_groups_json = ?,
                error_json = NULL, updated_at = ?
          WHERE candidate_id = ?`,
      )
      .run(
        nextStatus,
        serializeForPersistence(parsedChangeSet),
        serializeForPersistence(previewGroups),
        now,
        candidateId,
      );
    return this.getSnapshot();
  }

  failCandidate(
    candidateId: string,
    error: AppError,
    now: Timestamp,
  ): TerritoryWorldSnapshot {
    const result = this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET status = 'failed', change_set_json = NULL,
                preview_groups_json = '[]', error_json = ?, updated_at = ?
          WHERE candidate_id = ? AND status = 'generating'`,
      )
      .run(serializeForPersistence(error), now, candidateId);
    if (result.changes !== 1) this.throwCandidateState(candidateId);
    return this.getSnapshot();
  }

  recoverInterruptedCandidates(error: AppError, now: Timestamp): number {
    return this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET status = 'failed', change_set_json = NULL,
                preview_groups_json = '[]', error_json = ?, updated_at = ?
          WHERE status = 'generating'`,
      )
      .run(serializeForPersistence(error), now).changes;
  }

  cancelCandidate(candidateId: string, now: Timestamp): TerritoryWorldSnapshot {
    const result = this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET status = 'cancelled', change_set_json = NULL,
                preview_groups_json = '[]', error_json = NULL,
                updated_at = ?
          WHERE candidate_id = ?
            AND status IN ('draft', 'generating', 'ready', 'failed', 'stale')`,
      )
      .run(now, candidateId);
    if (result.changes !== 1) this.throwCandidateState(candidateId);
    return this.getSnapshot();
  }

  applyCandidate(candidateId: string, now: Timestamp): TerritoryWorldSnapshot {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "ready" || candidate.changeSet === null) {
      this.throwCandidateState(candidateId);
    }
    return this.commitChangeSet({
      appliedCandidateId: candidateId,
      changeSet: candidate.changeSet,
      now,
      reason: "ai",
    });
  }

  private requireWorld(): WorldRow {
    const row = this.database
      .prepare(
        `SELECT world_id, name, current_revision_id, created_at, updated_at
           FROM territory_worlds WHERE world_id = 'territory'`,
      )
      .get() as WorldRow | undefined;
    if (!row) {
      throw new TerritoryError(
        "TERRITORY.WORLD_NOT_FOUND",
        "领地世界尚未初始化。",
        false,
      );
    }
    return row;
  }

  private requireCandidate(candidateId: string): TerritoryChangeCandidate {
    const candidate = this.listCandidates().find(
      (entry) => entry.id === candidateId,
    );
    if (!candidate) {
      throw new TerritoryError(
        "TERRITORY.CANDIDATE_NOT_FOUND",
        "找不到这个领地预览。",
        false,
      );
    }
    return candidate;
  }

  private requireCandidateRow(candidateId: string): CandidateRow {
    const row = this.database
      .prepare(
        `SELECT candidate_id, base_revision_id, request_json,
                edit_request_json, status, change_set_json,
                preview_groups_json, error_json, applied_revision_id,
                created_at, updated_at
           FROM territory_change_candidates
          WHERE candidate_id = ?`,
      )
      .get(candidateId) as CandidateRow | undefined;
    if (!row) {
      throw new TerritoryError(
        "TERRITORY.CANDIDATE_NOT_FOUND",
        "找不到这个领地预览。",
        false,
      );
    }
    return row;
  }

  private throwCandidateState(candidateId: string): never {
    this.requireCandidate(candidateId);
    throw new TerritoryError(
      "TERRITORY.INVALID_CANDIDATE_STATE",
      "这个领地预览当前不能执行该操作。",
      false,
    );
  }

  private requireRevision(revisionId: string): RevisionRow {
    const row = this.database
      .prepare(
        `SELECT revision_id, sequence, parent_revision_id, label, reason,
                state_json, created_at
           FROM territory_world_revisions
          WHERE world_id = 'territory' AND revision_id = ?`,
      )
      .get(revisionId) as RevisionRow | undefined;
    if (!row) {
      throw new TerritoryError(
        "TERRITORY.REVISION_NOT_FOUND",
        "找不到这个领地历史版本。",
        false,
      );
    }
    return row;
  }

  private readState(revision: RevisionRow): TerritoryWorldState {
    return parseSchema(
      TerritoryWorldStateSchema,
      JSON.parse(revision.state_json) as unknown,
    );
  }

  private listAssets(): TerritoryAsset[] {
    const rows = this.database
      .prepare(
        `SELECT asset_id, media_type, origin, width, height, byte_length,
                sha256, created_at
           FROM territory_world_assets
          ORDER BY created_at, asset_id`,
      )
      .all() as AssetRow[];
    return rows.map((row) =>
      parseSchema(TerritoryAssetSchema, {
        byteLength: row.byte_length,
        createdAt: row.created_at,
        height: row.height,
        id: row.asset_id,
        mediaType: row.media_type,
        origin: row.origin,
        sha256: row.sha256,
        width: row.width,
      }),
    );
  }

  private listAssetPacks(): TerritoryAssetPack[] {
    return (
      this.database
        .prepare(
          `SELECT manifest_json FROM territory_asset_pack_revisions
           ORDER BY pack_id, revision`,
        )
        .all() as JsonManifestRow[]
    ).map((row) => parseJson(TerritoryAssetPackSchema, row.manifest_json));
  }

  private listDefinitions(): TerritoryDefinition[] {
    return (
      this.database
        .prepare(
          `SELECT manifest_json FROM territory_definition_revisions
           ORDER BY definition_id, revision`,
        )
        .all() as JsonManifestRow[]
    ).map((row) => parseJson(TerritoryDefinitionSchema, row.manifest_json));
  }

  private listCandidates(): TerritoryChangeCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT candidate_id, base_revision_id, request_json,
                edit_request_json, status,
                change_set_json, preview_groups_json, error_json,
                applied_revision_id, created_at, updated_at
           FROM territory_change_candidates
          ORDER BY updated_at DESC, candidate_id DESC`,
      )
      .all() as CandidateRow[];
    return rows.map((row) => {
      const request = parseJson(
        TerritoryCreateChangeCandidateRequestSchema,
        row.request_json,
      );
      return parseSchema(TerritoryChangeCandidateSchema, {
        appliedRevisionId: row.applied_revision_id,
        baseRevisionId: row.base_revision_id,
        changeSet:
          row.change_set_json === null
            ? null
            : parseJson(TerritoryWorldChangeSetSchema, row.change_set_json),
        createdAt: row.created_at,
        error:
          row.error_json === null
            ? null
            : (JSON.parse(row.error_json) as unknown),
        id: row.candidate_id,
        intent: request.intent,
        lockedInstanceIds: request.lockedInstanceIds,
        previewGroups: JSON.parse(row.preview_groups_json) as unknown,
        prompt: request.prompt,
        providerProfileId: request.providerProfileId,
        scope: request.scope,
        sources: request.sources,
        status: row.status,
        updatedAt: row.updated_at,
      });
    });
  }

  private requirePet(): TerritoryPetState {
    const row = this.database
      .prepare(
        `SELECT zone_id, pet_x, pet_y, facing, behavior, updated_at
           FROM territory_world_pet_state
          WHERE world_id = 'territory'`,
      )
      .get() as PetRow | undefined;
    if (!row) {
      throw new TerritoryError(
        "TERRITORY.STORAGE_FAILED",
        "领地桌宠状态不存在。",
        false,
      );
    }
    return parseSchema(TerritoryPetStateSchema, {
      behavior: row.behavior,
      facing: row.facing,
      point: { x: row.pet_x, y: row.pet_y },
      updatedAt: row.updated_at,
      zoneId: row.zone_id,
    });
  }

  private listPurgedIds(): Set<string> {
    const rows = this.database
      .prepare("SELECT instance_id FROM territory_purged_instances")
      .all() as PurgedRow[];
    return new Set(rows.map((row) => row.instance_id));
  }

  private syncSources(instances: readonly TerritoryInstance[]): void {
    this.database.prepare("DELETE FROM territory_instance_sources").run();
    const insert = this.database.prepare(
      `INSERT INTO territory_instance_sources (
         source_kind, source_id, instance_id, snapshot_json
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const instance of instances) {
      for (const source of instance.sources) {
        insert.run(
          source.kind,
          source.id,
          instance.id,
          serializeForPersistence(source),
        );
      }
    }
  }

  private markOtherCandidatesStale(
    appliedCandidateId: string | undefined,
    now: Timestamp,
  ): void {
    this.database
      .prepare(
        `UPDATE territory_change_candidates
            SET status = 'stale', updated_at = ?
          WHERE status IN ('draft', 'generating', 'ready')
            AND (? IS NULL OR candidate_id <> ?)`,
      )
      .run(now, appliedCandidateId ?? null, appliedCandidateId ?? null);
  }

  private deleteCandidateProjectionsForInstance(instanceId: string): void {
    const rows = this.database
      .prepare(
        `SELECT candidate_id, change_set_json
           FROM territory_change_candidates
          WHERE change_set_json IS NOT NULL`,
      )
      .all() as Array<{ candidate_id: string; change_set_json: string }>;
    const remove = this.database.prepare(
      "DELETE FROM territory_change_candidates WHERE candidate_id = ?",
    );
    for (const row of rows) {
      const changeSet = parseJson(
        TerritoryWorldChangeSetSchema,
        row.change_set_json,
      );
      const referencesInstance = changeSet.mutations.some((mutation) =>
        mutation.kind === "instance.put"
          ? mutation.instance.id === instanceId
          : mutation.kind === "instance.remove"
            ? mutation.instanceId === instanceId
            : false,
      );
      if (referencesInstance) remove.run(row.candidate_id);
    }
  }

  private pruneUnreferencedDefinitionsAndAssets(
    state: TerritoryWorldState,
  ): void {
    const referencedDefinitionIds = new Set(
      state.instances.map((instance) => instance.definition.id),
    );
    for (const candidate of this.listCandidates()) {
      for (const mutation of candidate.changeSet?.mutations ?? []) {
        if (mutation.kind === "instance.put") {
          referencedDefinitionIds.add(mutation.instance.definition.id);
        }
      }
    }
    const definitions = this.listDefinitions();
    const deleteDefinition = this.database.prepare(
      "DELETE FROM territory_definition_revisions WHERE definition_id = ?",
    );
    for (const definitionId of new Set(definitions.map(({ id }) => id))) {
      if (!referencedDefinitionIds.has(definitionId)) {
        deleteDefinition.run(definitionId);
      }
    }

    const referencedByDefinitions = new Set(
      this.listDefinitions().map((definition) => definition.visual.assetId),
    );
    const deleteAssetPack = this.database.prepare(
      "DELETE FROM territory_asset_pack_revisions WHERE pack_id = ?",
    );
    for (const packId of new Set(this.listAssetPacks().map(({ id }) => id))) {
      const revisions = this.listAssetPacks().filter(({ id }) => id === packId);
      const remainsInUse = revisions.some((pack) =>
        pack.assets.some(({ assetId }) => referencedByDefinitions.has(assetId)),
      );
      if (!remainsInUse) deleteAssetPack.run(packId);
    }

    const referencedAssetIds = new Set(referencedByDefinitions);
    for (const pack of this.listAssetPacks()) {
      for (const entry of pack.assets) referencedAssetIds.add(entry.assetId);
    }
    const deleteAsset = this.database.prepare(
      `DELETE FROM territory_world_assets
        WHERE asset_id = ? AND origin IN ('generated', 'edited')`,
    );
    for (const asset of this.listAssets()) {
      if (!referencedAssetIds.has(asset.id)) deleteAsset.run(asset.id);
    }
  }

  private assertCurrentProjectionValid(): void {
    const snapshot = this.getSnapshot();
    const snapshotIssues = validateTerritoryWorldSnapshot(snapshot);
    if (snapshotIssues.length > 0) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        snapshotIssues[0]!.message,
        false,
      );
    }
    for (const zone of snapshot.world.zones.filter(
      (candidate) => candidate.status === "active",
    )) {
      const view = this.getZoneView({
        revisionId: snapshot.world.currentRevision.id,
        zoneId: zone.id,
      });
      const issues = validateTerritoryZoneView(view, snapshot);
      if (issues.length > 0) {
        throw new TerritoryError(
          "TERRITORY.CHANGESET_INVALID",
          issues[0]!.message,
          false,
        );
      }
      const spatialIssues = validateTerritoryZoneSpatialState(view);
      if (spatialIssues.length > 0) {
        throw new TerritoryError(
          "TERRITORY.INVALID_PLACEMENT",
          spatialIssues[0]!.message,
          false,
        );
      }
    }
  }
}
