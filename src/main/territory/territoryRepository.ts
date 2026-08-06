import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type {
  TerritoryFacing,
  TerritoryItem,
  TerritoryItemTarget,
  TerritoryRotation,
  TerritorySceneId,
  TerritorySceneTarget,
} from "../../shared/contracts/territory";
import type { TerritoryItemManifestV1 } from "../../shared/contracts/territoryItemManifest";
import type { Timestamp } from "../../shared/contracts/primitives";
import { TerritoryItemManifestV1Schema } from "../../shared/schemas/territoryItemManifest";
import { parseSchema } from "../../shared/schemas/validation";
import {
  getTerritoryItemDefinition,
  TERRITORY_COLLECTION_DEFAULTS,
  type TerritorySceneCatalogEntry,
} from "./catalog";
import { TerritoryError } from "./territoryError";

interface TerritorySceneRow {
  initialized_at: string;
  is_active: number;
  pet_facing: TerritoryFacing;
  pet_x: number;
  pet_y: number;
  scene_id: TerritorySceneId;
  updated_at: string;
}

interface TerritoryItemRow {
  asset_id: string | null;
  definition_id: string;
  definition_revision: number;
  flipped: number;
  grid_x: number | null;
  grid_y: number | null;
  item_id: string;
  location: "collection" | "scene";
  manifest_json: string;
  pinned: number;
  placed_at: string | null;
  placement_kind: "ground" | "surface" | null;
  rotation: TerritoryRotation;
  scene_id: TerritorySceneId | null;
  slot_id: string | null;
  support_item_id: string | null;
  updated_at: string;
}

interface TerritoryDefinitionRow {
  asset_id: string | null;
  manifest_json: string;
}

interface TerritoryAssetRow {
  asset_id: string;
  byte_length: number;
  created_at: string;
  height: number;
  media_type: "image/png";
  sha256: string;
  storage_key: string;
  width: number;
}

interface TerritoryIdentityRow {
  definition_id: string;
  definition_revision: number;
}

export interface TerritorySceneRecord {
  readonly initializedAt: Timestamp;
  readonly isActive: boolean;
  readonly petFacing: TerritoryFacing;
  readonly petX: number;
  readonly petY: number;
  readonly sceneId: TerritorySceneId;
  readonly updatedAt: Timestamp;
}

export type TerritoryItemRecord = TerritoryItem;

export interface TerritoryAssetRecord {
  readonly assetId: string;
  readonly byteLength: number;
  readonly createdAt: Timestamp;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly sha256: string;
  readonly storageKey: string;
  readonly width: number;
}

function mapScene(row: TerritorySceneRow): TerritorySceneRecord {
  return {
    initializedAt: row.initialized_at,
    isActive: row.is_active === 1,
    petFacing: row.pet_facing,
    petX: row.pet_x,
    petY: row.pet_y,
    sceneId: row.scene_id,
    updatedAt: row.updated_at,
  };
}

function parseManifest(serialized: string): TerritoryItemManifestV1 {
  return parseSchema(TerritoryItemManifestV1Schema, JSON.parse(serialized));
}

function mapTarget(row: TerritoryItemRow): TerritoryItemTarget {
  if (row.location === "collection") return { kind: "collection" };
  if (
    row.placement_kind === "ground" &&
    row.scene_id &&
    row.grid_x !== null &&
    row.grid_y !== null
  ) {
    return {
      kind: "ground",
      sceneId: row.scene_id,
      x: row.grid_x,
      y: row.grid_y,
    };
  }
  if (
    row.placement_kind === "surface" &&
    row.scene_id &&
    row.slot_id &&
    row.support_item_id
  ) {
    return {
      kind: "surface",
      sceneId: row.scene_id,
      slotId: row.slot_id,
      supportItemId: row.support_item_id,
    };
  }
  throw new Error(`Invalid Territory placement row: ${row.item_id}`);
}

function mapItem(row: TerritoryItemRow): TerritoryItemRecord {
  const manifest = parseManifest(row.manifest_json);
  const manifestAssetId =
    manifest.visual.source.kind === "asset"
      ? manifest.visual.source.assetId
      : null;
  if (
    manifest.definitionId !== row.definition_id ||
    manifest.revision !== row.definition_revision ||
    manifestAssetId !== row.asset_id
  ) {
    throw new Error(`Territory definition identity mismatch: ${row.item_id}`);
  }
  return {
    flipped: row.flipped === 1,
    id: row.item_id,
    manifest,
    pinned: row.pinned === 1,
    placedAt: row.placed_at,
    rotation: row.rotation,
    target: mapTarget(row),
    updatedAt: row.updated_at,
  };
}

const itemSelect = `
  SELECT i.item_id, i.definition_id, i.definition_revision,
         d.asset_id, d.manifest_json, p.location, p.scene_id, p.placement_kind,
         p.grid_x, p.grid_y, p.support_item_id, p.slot_id, p.rotation,
         p.flipped, p.pinned, p.placed_at, p.updated_at
  FROM territory_items i
  JOIN territory_item_definitions d
    ON d.definition_id = i.definition_id
   AND d.revision = i.definition_revision
  JOIN territory_placements p ON p.item_id = i.item_id
`;

export class TerritoryRepository {
  constructor(private readonly database: Database.Database) {}

  private ensureDefinition(
    manifest: TerritoryItemManifestV1,
    now: Timestamp,
  ): void {
    const assetId =
      manifest.visual.source.kind === "asset"
        ? manifest.visual.source.assetId
        : null;
    const serialized = JSON.stringify(manifest);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO territory_item_definitions (
           definition_id, revision, asset_id, manifest_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(manifest.definitionId, manifest.revision, assetId, serialized, now);
    const stored = this.database
      .prepare(
        `SELECT asset_id, manifest_json
         FROM territory_item_definitions
         WHERE definition_id = ? AND revision = ?`,
      )
      .get(manifest.definitionId, manifest.revision) as TerritoryDefinitionRow;
    if (
      stored.asset_id !== assetId ||
      !isDeepStrictEqual(parseManifest(stored.manifest_json), manifest)
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        "物件 definition revision 已存在且内容不同。",
        false,
      );
    }
  }

  private insertItem(
    itemId: string,
    manifest: TerritoryItemManifestV1,
    initialSceneId: TerritorySceneId | null,
    now: Timestamp,
  ): boolean {
    this.ensureDefinition(manifest, now);
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO territory_items (
           item_id, definition_id, definition_revision, initial_scene_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        manifest.definitionId,
        manifest.revision,
        initialSceneId,
        now,
      );
    const identity = this.database
      .prepare(
        `SELECT definition_id, definition_revision
         FROM territory_items
         WHERE item_id = ?`,
      )
      .get(itemId) as TerritoryIdentityRow;
    if (
      identity.definition_id !== manifest.definitionId ||
      identity.definition_revision !== manifest.revision
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_MANIFEST",
        "物件实例 ID 已存在且引用了不同 definition。",
        false,
      );
    }
    return result.changes === 1;
  }

  getActiveScene(): TerritorySceneRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT scene_id, is_active, pet_x, pet_y, pet_facing,
                initialized_at, updated_at
         FROM territory_scenes
         WHERE is_active = 1`,
      )
      .get() as TerritorySceneRow | undefined;
    return row ? mapScene(row) : undefined;
  }

  getItem(itemId: string): TerritoryItemRecord | undefined {
    const row = this.database
      .prepare(`${itemSelect} WHERE i.item_id = ?`)
      .get(itemId) as TerritoryItemRow | undefined;
    return row ? mapItem(row) : undefined;
  }

  getAsset(assetId: string): TerritoryAssetRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT asset_id, media_type, width, height, byte_length, sha256,
                storage_key, created_at
         FROM territory_assets
         WHERE asset_id = ?`,
      )
      .get(assetId) as TerritoryAssetRow | undefined;
    return row
      ? {
          assetId: row.asset_id,
          byteLength: row.byte_length,
          createdAt: row.created_at,
          height: row.height,
          mediaType: row.media_type,
          sha256: row.sha256,
          storageKey: row.storage_key,
          width: row.width,
        }
      : undefined;
  }

  listSceneItems(sceneId: TerritorySceneId): TerritoryItemRecord[] {
    return (
      this.database
        .prepare(
          `${itemSelect}
           WHERE p.location = 'scene' AND p.scene_id = ?
           ORDER BY p.placement_kind, p.grid_y, p.grid_x,
                    p.support_item_id, p.slot_id, i.item_id`,
        )
        .all(sceneId) as TerritoryItemRow[]
    ).map(mapItem);
  }

  listCollectionItems(): TerritoryItemRecord[] {
    return (
      this.database
        .prepare(
          `${itemSelect}
           WHERE p.location = 'collection'
           ORDER BY p.updated_at, i.item_id`,
        )
        .all() as TerritoryItemRow[]
    ).map(mapItem);
  }

  selectScene(
    entry: TerritorySceneCatalogEntry,
    now: Timestamp,
  ): TerritorySceneRecord {
    const transaction = this.database.transaction(() => {
      this.database.prepare("UPDATE territory_scenes SET is_active = 0").run();
      this.database
        .prepare(
          `INSERT INTO territory_scenes (
             scene_id, is_active, pet_x, pet_y, pet_facing,
             initialized_at, updated_at
           ) VALUES (?, 1, ?, ?, 'right', ?, ?)
           ON CONFLICT(scene_id) DO UPDATE SET
             is_active = 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          entry.definition.id,
          entry.definition.entry.x,
          entry.definition.entry.y,
          now,
          now,
        );

      const insertGroundPlacement = this.database.prepare(
        `INSERT OR IGNORE INTO territory_placements (
           item_id, location, scene_id, placement_kind, grid_x, grid_y,
           support_item_id, slot_id, rotation, flipped, pinned, placed_at,
           updated_at
         ) VALUES (?, 'scene', ?, 'ground', ?, ?, NULL, NULL, ?, ?, 0, ?, ?)`,
      );
      for (const item of entry.defaults) {
        const manifest = getTerritoryItemDefinition(item.definitionId);
        this.insertItem(item.id, manifest, entry.definition.id, now);
        insertGroundPlacement.run(
          item.id,
          entry.definition.id,
          item.x,
          item.y,
          item.rotation ?? 0,
          item.flipped ? 1 : 0,
          now,
          now,
        );
      }

      const insertCollectionPlacement = this.database.prepare(
        `INSERT OR IGNORE INTO territory_placements (
           item_id, location, scene_id, placement_kind, grid_x, grid_y,
           support_item_id, slot_id, rotation, flipped, pinned, placed_at,
           updated_at
         ) VALUES (?, 'collection', NULL, NULL, NULL, NULL, NULL, NULL,
                   0, 0, 0, NULL, ?)`,
      );
      for (const item of TERRITORY_COLLECTION_DEFAULTS) {
        const manifest = getTerritoryItemDefinition(item.definitionId);
        this.insertItem(item.id, manifest, null, now);
        insertCollectionPlacement.run(item.id, now);
      }
    });
    transaction();
    const selected = this.getActiveScene();
    if (!selected) throw new Error("Selected territory scene was not stored.");
    return selected;
  }

  installGeneratedCollectionItem(input: {
    readonly asset: Omit<TerritoryAssetRecord, "createdAt">;
    readonly itemId: string;
    readonly manifest: TerritoryItemManifestV1;
    readonly now: Timestamp;
  }): void {
    const transaction = this.database.transaction(() => {
      const { asset, itemId, manifest, now } = input;
      this.database
        .prepare(
          `INSERT OR IGNORE INTO territory_assets (
             asset_id, media_type, width, height, byte_length, sha256,
             storage_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.assetId,
          asset.mediaType,
          asset.width,
          asset.height,
          asset.byteLength,
          asset.sha256,
          asset.storageKey,
          now,
        );
      const storedAsset = this.getAsset(asset.assetId);
      if (
        !storedAsset ||
        !isDeepStrictEqual(
          {
            assetId: storedAsset.assetId,
            byteLength: storedAsset.byteLength,
            height: storedAsset.height,
            mediaType: storedAsset.mediaType,
            sha256: storedAsset.sha256,
            storageKey: storedAsset.storageKey,
            width: storedAsset.width,
          },
          asset,
        )
      ) {
        throw new TerritoryError(
          "TERRITORY.ASSET_CONFLICT",
          `图片资产 ${asset.assetId} 已存在且登记内容不同。`,
          false,
        );
      }

      const inserted = this.insertItem(itemId, manifest, null, now);
      if (inserted) {
        this.database
          .prepare(
            `INSERT INTO territory_placements (
               item_id, location, scene_id, placement_kind, grid_x, grid_y,
               support_item_id, slot_id, rotation, flipped, pinned, placed_at,
               updated_at
             ) VALUES (?, 'collection', NULL, NULL, NULL, NULL, NULL, NULL,
                       0, 0, 0, NULL, ?)`,
          )
          .run(itemId, now);
      }
    });
    transaction();
  }

  savePet(
    sceneId: TerritorySceneId,
    x: number,
    y: number,
    facing: TerritoryFacing,
    now: Timestamp,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE territory_scenes
         SET pet_x = ?, pet_y = ?, pet_facing = ?, updated_at = ?
         WHERE scene_id = ? AND is_active = 1`,
      )
      .run(x, y, facing, now, sceneId);
    if (result.changes !== 1)
      throw new Error("Active territory scene missing.");
  }

  placeItem(input: {
    readonly flipped: boolean;
    readonly itemId: string;
    readonly now: Timestamp;
    readonly rotation: TerritoryRotation;
    readonly target: TerritorySceneTarget;
  }): void {
    const target = input.target;
    const result =
      target.kind === "ground"
        ? this.database
            .prepare(
              `UPDATE territory_placements
               SET location = 'scene', scene_id = ?, placement_kind = 'ground',
                   grid_x = ?, grid_y = ?, support_item_id = NULL,
                   slot_id = NULL, rotation = ?, flipped = ?, placed_at = ?,
                   updated_at = ?
               WHERE item_id = ?`,
            )
            .run(
              target.sceneId,
              target.x,
              target.y,
              input.rotation,
              input.flipped ? 1 : 0,
              input.now,
              input.now,
              input.itemId,
            )
        : this.database
            .prepare(
              `UPDATE territory_placements
               SET location = 'scene', scene_id = ?, placement_kind = 'surface',
                   grid_x = NULL, grid_y = NULL, support_item_id = ?,
                   slot_id = ?, rotation = ?, flipped = ?, placed_at = ?,
                   updated_at = ?
               WHERE item_id = ?`,
            )
            .run(
              target.sceneId,
              target.supportItemId,
              target.slotId,
              input.rotation,
              input.flipped ? 1 : 0,
              input.now,
              input.now,
              input.itemId,
            );
    if (result.changes !== 1) throw new Error("Territory item missing.");
  }

  collectItem(itemId: string, now: Timestamp): void {
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE territory_placements
           SET location = 'collection', scene_id = NULL,
               placement_kind = NULL, grid_x = NULL, grid_y = NULL,
               support_item_id = NULL, slot_id = NULL, placed_at = NULL,
               updated_at = ?
           WHERE support_item_id = ?`,
        )
        .run(now, itemId);
      const result = this.database
        .prepare(
          `UPDATE territory_placements
           SET location = 'collection', scene_id = NULL,
               placement_kind = NULL, grid_x = NULL, grid_y = NULL,
               support_item_id = NULL, slot_id = NULL, placed_at = NULL,
               updated_at = ?
           WHERE item_id = ?`,
        )
        .run(now, itemId);
      if (result.changes !== 1) throw new Error("Territory item missing.");
    });
    transaction();
  }
}
