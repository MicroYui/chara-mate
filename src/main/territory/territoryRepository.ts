import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type {
  TerritoryFacing,
  TerritoryImageCandidate,
  TerritoryItem,
  TerritoryItemCandidate,
  TerritoryItemSource,
  TerritoryItemSourceKind,
  TerritoryItemVersion,
  TerritoryItemTarget,
  TerritoryRotation,
  TerritorySceneId,
  TerritorySceneTarget,
} from "../../shared/contracts/territory";
import type { TerritoryItemManifestV1 } from "../../shared/contracts/territoryItemManifest";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { AppError } from "../../shared/contracts/run";
import { serializeForPersistence } from "../db/persistenceBoundary";
import { AppErrorSchema } from "../../shared/schemas/error";
import {
  TerritoryImageCandidateContentSchema,
  TerritoryImageCandidateSchema,
  TerritoryItemCandidateSchema,
  TerritoryItemSourceSchema,
} from "../../shared/schemas/territory";
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

interface TerritoryVersionRow {
  created_at: string;
  definition_id: string;
  manifest_json: string;
  revision: number;
}

interface TerritoryItemSourceRow {
  item_id: string;
  label: string;
  occurred_at: string;
  revision_id: string | null;
  source_id: string;
  source_kind: TerritoryItemSourceKind;
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

interface TerritoryImageCandidateRow {
  accepted_item_id: string | null;
  candidate_id: string;
  created_at: string;
  error_json: string | null;
  item_candidate_id: string | null;
  operation: TerritoryImageCandidate["operation"];
  provider_profile_id: string;
  request_json: string;
  scene_id: TerritorySceneId;
  source_candidate_id: string | null;
  status: TerritoryImageCandidate["status"];
  updated_at: string;
}

interface TerritoryItemCandidateRow {
  accepted_item_id: string | null;
  candidate_id: string;
  created_at: string;
  description: string;
  name: string;
  primary_source_id: string;
  primary_source_kind: TerritoryItemSourceKind;
  sources_json: string;
  status: TerritoryItemCandidate["status"];
  suggested_scene_id: TerritorySceneId;
  updated_at: string;
  visual_prompt: string;
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

function mapItem(
  row: TerritoryItemRow,
  sources: TerritoryItemSource[],
  versions: TerritoryItemVersion[],
): TerritoryItemRecord {
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
    sources,
    target: mapTarget(row),
    updatedAt: row.updated_at,
    versions,
  };
}

function mapImageCandidate(
  row: TerritoryImageCandidateRow,
): TerritoryImageCandidate {
  const content = parseSchema(
    TerritoryImageCandidateContentSchema,
    JSON.parse(row.request_json),
  );
  return parseSchema(TerritoryImageCandidateSchema, {
    acceptedItemId: row.accepted_item_id,
    createdAt: row.created_at,
    ...content,
    error: row.error_json
      ? parseSchema(AppErrorSchema, JSON.parse(row.error_json))
      : null,
    id: row.candidate_id,
    itemCandidateId: row.item_candidate_id,
    operation: row.operation,
    providerProfileId: row.provider_profile_id,
    sceneId: row.scene_id,
    sourceCandidateId: row.source_candidate_id,
    status: row.status,
    updatedAt: row.updated_at,
  });
}

function mapItemCandidate(
  row: TerritoryItemCandidateRow,
): TerritoryItemCandidate {
  return parseSchema(TerritoryItemCandidateSchema, {
    createdAt: row.created_at,
    description: row.description,
    id: row.candidate_id,
    itemId: row.accepted_item_id,
    name: row.name,
    sources: JSON.parse(row.sources_json) as unknown,
    status: row.status,
    suggestedSceneId: row.suggested_scene_id,
    updatedAt: row.updated_at,
    visualPrompt: row.visual_prompt,
  });
}

const imageCandidateSelect = `
  SELECT candidate_id, provider_profile_id, scene_id, operation,
         source_candidate_id, item_candidate_id, request_json, status, error_json,
         accepted_item_id, created_at, updated_at
  FROM territory_image_candidates
`;

const itemCandidateSelect = `
  SELECT candidate_id, primary_source_kind, primary_source_id, name,
         description, visual_prompt, suggested_scene_id, sources_json,
         status, accepted_item_id, created_at, updated_at
  FROM territory_item_candidates
`;

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

  private hydrateItems(rows: TerritoryItemRow[]): TerritoryItemRecord[] {
    if (rows.length === 0) return [];
    const itemIds = new Set(rows.map((row) => row.item_id));
    const definitionIds = new Set(rows.map((row) => row.definition_id));
    const sourceRows = this.database
      .prepare(
        `SELECT item_id, source_kind, source_id, revision_id, label, occurred_at
         FROM territory_item_sources
         ORDER BY occurred_at, source_kind, source_id`,
      )
      .all() as TerritoryItemSourceRow[];
    const versionRows = this.database
      .prepare(
        `SELECT definition_id, revision, manifest_json, created_at
         FROM territory_item_definitions
         ORDER BY definition_id, revision DESC`,
      )
      .all() as TerritoryVersionRow[];

    const sourcesByItem = new Map<string, TerritoryItemSource[]>();
    for (const row of sourceRows) {
      if (!itemIds.has(row.item_id)) continue;
      const values = sourcesByItem.get(row.item_id) ?? [];
      values.push(
        parseSchema(TerritoryItemSourceSchema, {
          id: row.source_id,
          kind: row.source_kind,
          label: row.label,
          occurredAt: row.occurred_at,
          revisionId: row.revision_id,
        }),
      );
      sourcesByItem.set(row.item_id, values);
    }

    const versionsByDefinition = new Map<string, TerritoryVersionRow[]>();
    for (const row of versionRows) {
      if (!definitionIds.has(row.definition_id)) continue;
      const values = versionsByDefinition.get(row.definition_id) ?? [];
      values.push(row);
      versionsByDefinition.set(row.definition_id, values);
    }

    return rows.map((row) =>
      mapItem(
        row,
        sourcesByItem.get(row.item_id) ?? [],
        (versionsByDefinition.get(row.definition_id) ?? []).map((version) => ({
          active: version.revision === row.definition_revision,
          createdAt: version.created_at,
          manifest: parseManifest(version.manifest_json),
          revision: version.revision,
        })),
      ),
    );
  }

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
    return row ? this.hydrateItems([row])[0] : undefined;
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

  getItemCandidate(candidateId: string): TerritoryItemCandidate | undefined {
    const row = this.database
      .prepare(`${itemCandidateSelect} WHERE candidate_id = ?`)
      .get(candidateId) as TerritoryItemCandidateRow | undefined;
    return row ? mapItemCandidate(row) : undefined;
  }

  findItemCandidate(
    kind: TerritoryItemSourceKind,
    sourceId: string,
  ): TerritoryItemCandidate | undefined {
    const row = this.database
      .prepare(
        `${itemCandidateSelect}
         WHERE primary_source_kind = ? AND primary_source_id = ?`,
      )
      .get(kind, sourceId) as TerritoryItemCandidateRow | undefined;
    return row ? mapItemCandidate(row) : undefined;
  }

  listItemCandidates(): TerritoryItemCandidate[] {
    return (
      this.database
        .prepare(
          `${itemCandidateSelect}
           ORDER BY created_at DESC, candidate_id DESC`,
        )
        .all() as TerritoryItemCandidateRow[]
    ).map(mapItemCandidate);
  }

  saveItemCandidate(candidate: TerritoryItemCandidate): TerritoryItemCandidate {
    const primarySource = candidate.sources[0];
    if (!primarySource || candidate.status !== "pending") {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "新的领地候选必须包含来源并处于待生成状态。",
        false,
      );
    }
    this.database
      .prepare(
        `INSERT INTO territory_item_candidates (
           candidate_id, primary_source_kind, primary_source_id, name,
           description, visual_prompt, suggested_scene_id, sources_json,
           status, accepted_item_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
         ON CONFLICT(primary_source_kind, primary_source_id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           visual_prompt = excluded.visual_prompt,
           suggested_scene_id = excluded.suggested_scene_id,
           sources_json = excluded.sources_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        candidate.id,
        primarySource.kind,
        primarySource.id,
        candidate.name,
        candidate.description,
        candidate.visualPrompt,
        candidate.suggestedSceneId,
        serializeForPersistence(candidate.sources),
        candidate.createdAt,
        candidate.updatedAt,
      );
    const stored = this.findItemCandidate(primarySource.kind, primarySource.id);
    if (!stored) throw new Error("Territory item candidate was not stored.");
    return stored;
  }

  getImageCandidate(candidateId: string): TerritoryImageCandidate | undefined {
    const row = this.database
      .prepare(`${imageCandidateSelect} WHERE candidate_id = ?`)
      .get(candidateId) as TerritoryImageCandidateRow | undefined;
    return row ? mapImageCandidate(row) : undefined;
  }

  listImageCandidates(): TerritoryImageCandidate[] {
    return (
      this.database
        .prepare(
          `${imageCandidateSelect}
           ORDER BY created_at DESC, candidate_id DESC`,
        )
        .all() as TerritoryImageCandidateRow[]
    ).map(mapImageCandidate);
  }

  createImageCandidate(candidate: TerritoryImageCandidate): void {
    if (
      candidate.status !== "generating" ||
      candidate.error !== null ||
      candidate.acceptedItemId !== null
    ) {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "新的图片候选必须处于生成中状态。",
        false,
      );
    }
    const content = {
      description: candidate.description,
      editInstruction: candidate.editInstruction,
      name: candidate.name,
      sourceSnapshots: candidate.sourceSnapshots ?? [],
      structure: candidate.structure,
      visualPrompt: candidate.visualPrompt,
    };
    this.database
      .prepare(
        `INSERT INTO territory_image_candidates (
           candidate_id, provider_profile_id, scene_id, operation,
           source_candidate_id, item_candidate_id, request_json, status, error_json,
           accepted_item_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', NULL, NULL, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.providerProfileId,
        candidate.sceneId,
        candidate.operation,
        candidate.sourceCandidateId,
        candidate.itemCandidateId,
        serializeForPersistence(content),
        candidate.createdAt,
        candidate.updatedAt,
      );
  }

  markImageCandidateReady(candidateId: string, now: Timestamp): void {
    const result = this.database
      .prepare(
        `UPDATE territory_image_candidates
         SET status = 'ready', error_json = NULL, updated_at = ?
         WHERE candidate_id = ? AND status = 'generating'`,
      )
      .run(now, candidateId);
    if (result.changes !== 1) {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "图片候选当前不能完成生成。",
        false,
      );
    }
  }

  markImageCandidateFailed(
    candidateId: string,
    error: AppError,
    now: Timestamp,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE territory_image_candidates
         SET status = 'failed', error_json = ?, accepted_item_id = NULL,
             updated_at = ?
         WHERE candidate_id = ? AND status = 'generating'`,
      )
      .run(serializeForPersistence(error), now, candidateId);
    if (result.changes !== 1) {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "图片候选当前不能记录失败。",
        false,
      );
    }
  }

  retryImageCandidate(candidateId: string, now: Timestamp): void {
    const result = this.database
      .prepare(
        `UPDATE territory_image_candidates
         SET status = 'generating', error_json = NULL, updated_at = ?
         WHERE candidate_id = ? AND status = 'failed'`,
      )
      .run(now, candidateId);
    if (result.changes !== 1) {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "只有失败的图片候选可以重试。",
        false,
      );
    }
  }

  acceptImageCandidate(
    candidateId: string,
    itemId: string,
    now: Timestamp,
  ): void {
    const current = this.getImageCandidate(candidateId);
    if (!current) {
      throw new TerritoryError(
        "TERRITORY.CANDIDATE_NOT_FOUND",
        "找不到这个图片候选。",
        false,
      );
    }
    if (current.status === "accepted" && current.acceptedItemId === itemId) {
      return;
    }
    this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE territory_image_candidates
           SET status = 'accepted', accepted_item_id = ?, updated_at = ?
           WHERE candidate_id = ? AND status = 'ready'`,
        )
        .run(itemId, now, candidateId);
      if (result.changes !== 1) {
        const accepted = this.database
          .prepare(
            `SELECT status, accepted_item_id
             FROM territory_image_candidates WHERE candidate_id = ?`,
          )
          .get(candidateId) as
          { accepted_item_id: string | null; status: string } | undefined;
        if (
          accepted?.status === "accepted" &&
          accepted.accepted_item_id === itemId
        ) {
          return;
        }
        throw new TerritoryError(
          "TERRITORY.INVALID_CANDIDATE_STATE",
          "只有生成完成的图片候选可以加入收藏库。",
          false,
        );
      }

      if (!current.itemCandidateId) return;
      const sourceCandidate = this.getItemCandidate(current.itemCandidateId);
      if (!sourceCandidate) {
        throw new TerritoryError(
          "TERRITORY.CANDIDATE_NOT_FOUND",
          "找不到这个记忆物件候选。",
          false,
        );
      }
      const candidateResult = this.database
        .prepare(
          `UPDATE territory_item_candidates
           SET status = 'materialized', accepted_item_id = ?, updated_at = ?
           WHERE candidate_id = ? AND (
             status = 'pending' OR accepted_item_id = ?
           )`,
        )
        .run(itemId, now, sourceCandidate.id, itemId);
      if (candidateResult.changes !== 1) {
        throw new TerritoryError(
          "TERRITORY.INVALID_CANDIDATE_STATE",
          "这个来源已经对应另一个领地物件。",
          false,
        );
      }
      const insertSource = this.database.prepare(
        `INSERT INTO territory_item_sources (
           item_id, source_kind, source_id, revision_id, label,
           occurred_at, candidate_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, source_kind, source_id) DO UPDATE SET
           revision_id = excluded.revision_id,
           label = excluded.label,
           occurred_at = excluded.occurred_at,
           candidate_id = excluded.candidate_id`,
      );
      for (const source of current.sourceSnapshots ?? sourceCandidate.sources) {
        insertSource.run(
          itemId,
          source.kind,
          source.id,
          source.revisionId,
          source.label,
          source.occurredAt,
          sourceCandidate.id,
        );
      }
    })();
  }

  recoverInterruptedImageCandidates(error: AppError, now: Timestamp): number {
    return this.database
      .prepare(
        `UPDATE territory_image_candidates
         SET status = 'failed', error_json = ?, updated_at = ?
         WHERE status = 'generating'`,
      )
      .run(serializeForPersistence(error), now).changes;
  }

  listSceneItems(sceneId: TerritorySceneId): TerritoryItemRecord[] {
    const rows = this.database
      .prepare(
        `${itemSelect}
           WHERE p.location = 'scene' AND p.scene_id = ?
           ORDER BY p.placement_kind, p.grid_y, p.grid_x,
                    p.support_item_id, p.slot_id, i.item_id`,
      )
      .all(sceneId) as TerritoryItemRow[];
    return this.hydrateItems(rows);
  }

  listCollectionItems(): TerritoryItemRecord[] {
    const rows = this.database
      .prepare(
        `${itemSelect}
           WHERE p.location = 'collection'
           ORDER BY p.updated_at, i.item_id`,
      )
      .all() as TerritoryItemRow[];
    return this.hydrateItems(rows);
  }

  nextDefinitionRevision(definitionId: string): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
         FROM territory_item_definitions
         WHERE definition_id = ?`,
      )
      .get(definitionId) as { revision: number };
    return row.revision;
  }

  findDefinitionRevisionByAsset(
    definitionId: string,
    assetId: string,
  ): number | undefined {
    const row = this.database
      .prepare(
        `SELECT revision FROM territory_item_definitions
         WHERE definition_id = ? AND asset_id = ?`,
      )
      .get(definitionId, assetId) as { revision: number } | undefined;
    return row?.revision;
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

      this.ensureDefinition(manifest, now);
      const identity = this.database
        .prepare(
          `SELECT definition_id, definition_revision
           FROM territory_items
           WHERE item_id = ?`,
        )
        .get(itemId) as TerritoryIdentityRow | undefined;
      let inserted = false;
      if (!identity) {
        this.database
          .prepare(
            `INSERT INTO territory_items (
               item_id, definition_id, definition_revision, initial_scene_id,
               created_at
             ) VALUES (?, ?, ?, NULL, ?)`,
          )
          .run(itemId, manifest.definitionId, manifest.revision, now);
        inserted = true;
      } else if (identity.definition_id !== manifest.definitionId) {
        throw new TerritoryError(
          "TERRITORY.INVALID_MANIFEST",
          "物件实例 ID 已存在且引用了不同 definition。",
          false,
        );
      } else if (manifest.revision > identity.definition_revision) {
        this.database
          .prepare(
            `UPDATE territory_items SET definition_revision = ?
             WHERE item_id = ?`,
          )
          .run(manifest.revision, itemId);
      }
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

  selectItemVersion(itemId: string, revision: number): void {
    const result = this.database
      .prepare(
        `UPDATE territory_items
         SET definition_revision = ?
         WHERE item_id = ? AND EXISTS (
           SELECT 1 FROM territory_item_definitions d
           WHERE d.definition_id = territory_items.definition_id
             AND d.revision = ?
         )`,
      )
      .run(revision, itemId, revision);
    if (result.changes !== 1) {
      throw new TerritoryError(
        "TERRITORY.VERSION_NOT_FOUND",
        "找不到这个物件版本。",
        false,
      );
    }
  }

  setItemPinned(itemId: string, pinned: boolean, now: Timestamp): void {
    const result = this.database
      .prepare(
        `UPDATE territory_placements SET pinned = ?, updated_at = ?
         WHERE item_id = ?`,
      )
      .run(pinned ? 1 : 0, now, itemId);
    if (result.changes !== 1) throw new Error("Territory item missing.");
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
    readonly capacity: number;
    readonly flipped: boolean;
    readonly itemId: string;
    readonly now: Timestamp;
    readonly rotation: TerritoryRotation;
    readonly target: TerritorySceneTarget;
  }): void {
    this.database.transaction(() => {
      const target = input.target;
      const current = this.database
        .prepare(
          `SELECT location, scene_id FROM territory_placements
           WHERE item_id = ?`,
        )
        .get(input.itemId) as
        | { location: "collection" | "scene"; scene_id: string | null }
        | undefined;
      if (!current) throw new Error("Territory item missing.");

      if (
        current.location === "collection" ||
        current.scene_id !== target.sceneId
      ) {
        const count = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM territory_placements
             WHERE location = 'scene' AND scene_id = ?`,
          )
          .get(target.sceneId) as { count: number };
        if (count.count >= input.capacity) {
          const protectedSupportId =
            target.kind === "surface" ? target.supportItemId : input.itemId;
          const oldest = this.database
            .prepare(
              `SELECT item_id FROM territory_placements
               WHERE location = 'scene' AND scene_id = ? AND pinned = 0
                 AND item_id <> ? AND item_id <> ?
                 AND NOT EXISTS (
                   SELECT 1 FROM territory_placements child
                   WHERE child.support_item_id = territory_placements.item_id
                     AND child.pinned = 1
                 )
               ORDER BY placed_at, item_id
               LIMIT 1`,
            )
            .get(target.sceneId, input.itemId, protectedSupportId) as
            { item_id: string } | undefined;
          if (!oldest) {
            throw new TerritoryError(
              "TERRITORY.CAPACITY_PINNED",
              "场景已满，且现有物件都已置顶。请先收回或取消置顶一个物件。",
              false,
            );
          }
          this.database
            .prepare(
              `UPDATE territory_placements
               SET location = 'collection', scene_id = NULL,
                   placement_kind = NULL, grid_x = NULL, grid_y = NULL,
                   support_item_id = NULL, slot_id = NULL, placed_at = NULL,
                   updated_at = ?
               WHERE support_item_id = ?`,
            )
            .run(input.now, oldest.item_id);
          this.database
            .prepare(
              `UPDATE territory_placements
               SET location = 'collection', scene_id = NULL,
                   placement_kind = NULL, grid_x = NULL, grid_y = NULL,
                   support_item_id = NULL, slot_id = NULL, placed_at = NULL,
                   updated_at = ?
               WHERE item_id = ?`,
            )
            .run(input.now, oldest.item_id);
        }
      }

      const result =
        target.kind === "ground"
          ? this.database
              .prepare(
                `UPDATE territory_placements
                 SET location = 'scene', scene_id = ?, placement_kind = 'ground',
                     grid_x = ?, grid_y = ?, support_item_id = NULL,
                     slot_id = NULL, rotation = ?, flipped = ?,
                     placed_at = CASE
                       WHEN location = 'collection' THEN ? ELSE placed_at
                     END,
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
                     slot_id = ?, rotation = ?, flipped = ?,
                     placed_at = CASE
                       WHEN location = 'collection' THEN ? ELSE placed_at
                     END,
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
    })();
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
