import type Database from "better-sqlite3";

import type {
  TerritoryCatalogItemId,
  TerritoryFacing,
  TerritoryRotation,
  TerritorySceneId,
} from "../../shared/contracts/territory";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { TerritorySceneCatalogEntry } from "./catalog";

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
  catalog_id: TerritoryCatalogItemId;
  flipped: number;
  item_id: string;
  layer: number;
  location: "collection" | "scene";
  pinned: number;
  placed_at: string | null;
  rotation: TerritoryRotation;
  scene_id: TerritorySceneId | null;
  updated_at: string;
  grid_x: number | null;
  grid_y: number | null;
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

export interface TerritoryItemRecord {
  readonly catalogId: TerritoryCatalogItemId;
  readonly flipped: boolean;
  readonly id: string;
  readonly layer: number;
  readonly location: "collection" | "scene";
  readonly pinned: boolean;
  readonly placedAt: Timestamp | null;
  readonly rotation: TerritoryRotation;
  readonly sceneId: TerritorySceneId | null;
  readonly updatedAt: Timestamp;
  readonly x: number | null;
  readonly y: number | null;
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

function mapItem(row: TerritoryItemRow): TerritoryItemRecord {
  return {
    catalogId: row.catalog_id,
    flipped: row.flipped === 1,
    id: row.item_id,
    layer: row.layer,
    location: row.location,
    pinned: row.pinned === 1,
    placedAt: row.placed_at,
    rotation: row.rotation,
    sceneId: row.scene_id,
    updatedAt: row.updated_at,
    x: row.grid_x,
    y: row.grid_y,
  };
}

const itemSelect = `
  SELECT i.item_id, i.catalog_id, p.location, p.scene_id, p.grid_x,
         p.grid_y, p.layer, p.rotation, p.flipped, p.pinned, p.placed_at,
         p.updated_at
  FROM territory_items i
  JOIN territory_placements p ON p.item_id = i.item_id
`;

export class TerritoryRepository {
  constructor(private readonly database: Database.Database) {}

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

  listSceneItems(sceneId: TerritorySceneId): TerritoryItemRecord[] {
    return (
      this.database
        .prepare(
          `${itemSelect}
           WHERE p.location = 'scene' AND p.scene_id = ?
           ORDER BY p.layer, p.grid_y, p.grid_x, i.item_id`,
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

      const insertItem = this.database.prepare(
        `INSERT OR IGNORE INTO territory_items (
           item_id, catalog_id, initial_scene_id, created_at
         ) VALUES (?, ?, ?, ?)`,
      );
      const insertPlacement = this.database.prepare(
        `INSERT OR IGNORE INTO territory_placements (
           item_id, location, scene_id, grid_x, grid_y, layer, rotation,
           flipped, pinned, placed_at, updated_at
         ) VALUES (?, 'scene', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      );
      for (const item of entry.defaults) {
        insertItem.run(item.id, item.catalogId, entry.definition.id, now);
        insertPlacement.run(
          item.id,
          entry.definition.id,
          item.x,
          item.y,
          item.layer,
          item.rotation ?? 0,
          item.flipped ? 1 : 0,
          now,
          now,
        );
      }
    });
    transaction();
    const selected = this.getActiveScene();
    if (!selected) throw new Error("Selected territory scene was not stored.");
    return selected;
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
    readonly layer: number;
    readonly now: Timestamp;
    readonly rotation: TerritoryRotation;
    readonly sceneId: TerritorySceneId;
    readonly x: number;
    readonly y: number;
  }): void {
    const result = this.database
      .prepare(
        `UPDATE territory_placements
         SET location = 'scene', scene_id = ?, grid_x = ?, grid_y = ?,
             layer = ?, rotation = ?, flipped = ?, placed_at = ?, updated_at = ?
         WHERE item_id = ?`,
      )
      .run(
        input.sceneId,
        input.x,
        input.y,
        input.layer,
        input.rotation,
        input.flipped ? 1 : 0,
        input.now,
        input.now,
        input.itemId,
      );
    if (result.changes !== 1) throw new Error("Territory item missing.");
  }

  collectItem(itemId: string, now: Timestamp): void {
    const result = this.database
      .prepare(
        `UPDATE territory_placements
         SET location = 'collection', scene_id = NULL, grid_x = NULL,
             grid_y = NULL, updated_at = ?
         WHERE item_id = ?`,
      )
      .run(now, itemId);
    if (result.changes !== 1) throw new Error("Territory item missing.");
  }
}
