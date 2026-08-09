import type Database from "better-sqlite3";

import type {
  ActivityDigest,
  ActivityEpisode,
  ActivityEvent,
  ActivitySource,
} from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import { ActivityEventDetailsSchema } from "../../shared/schemas/activity";
import { parseSchema } from "../../shared/schemas/validation";
import type { DistilledEpisode } from "./activityDistillation";

interface StateRow {
  last_cleanup_at: string | null;
  paused: number;
  updated_at: string;
}

interface EventRow {
  actor: ActivityEvent["actor"];
  details_json: string;
  ended_at: string | null;
  id: string;
  started_at: string;
}

interface EpisodeRow {
  actor: ActivityEpisode["actor"];
  app_names_json: string;
  created_at: string;
  digest_id: string | null;
  domains_json: string;
  ended_at: string;
  event_count: number;
  id: string;
  raw_cleared_at: string | null;
  screenshot_storage_keys_json: string;
  source_types_json: string;
  started_at: string;
  summary: string;
  title: string;
  updated_at: string;
}

interface DigestRow {
  candidate_ids_json: string;
  created_at: string;
  evidence_days: number;
  id: string;
  kind: ActivityDigest["kind"];
  period_end: string;
  period_start: string;
  summary: string;
  title: string;
}

interface EvidenceRow {
  digest_id: string;
  episode_id: string;
}

interface AssetRow {
  byte_length: number;
  created_at: string;
  id: string;
  storage_key: string;
}

interface FullAssetRow extends AssetRow {
  height: number;
  media_type: "image/png";
  sha256: string;
  width: number;
}

export interface ActivityAssetRecord {
  readonly byteLength: number;
  readonly createdAt: Timestamp;
  readonly height: number;
  readonly id: string;
  readonly mediaType: "image/png";
  readonly sha256: string;
  readonly storageKey: string;
  readonly width: number;
}

export interface ActivityState {
  readonly lastCleanupAt?: Timestamp;
  readonly paused: boolean;
  readonly updatedAt: Timestamp;
}

export interface ActivityCleanupPlanResult {
  readonly deletedAssets: number;
  readonly deletedEvents: number;
  readonly storageKeys: readonly string[];
}

function mapEvent(row: EventRow): ActivityEvent {
  return {
    actor: row.actor,
    details: parseSchema(
      ActivityEventDetailsSchema,
      JSON.parse(row.details_json),
    ),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    id: row.id,
    startedAt: row.started_at,
  };
}

function stringArray(serialized: string): string[] {
  const value = JSON.parse(serialized) as unknown;
  if (!Array.isArray(value)) {
    throw new TypeError("Activity string array is corrupt");
  }
  return (value as unknown[]).map((item) => {
    if (typeof item !== "string") {
      throw new TypeError("Activity string array is corrupt");
    }
    return item;
  });
}

function mapEpisode(
  row: EpisodeRow,
  existingAssets: Set<string>,
): ActivityEpisode {
  return {
    actor: row.actor,
    appNames: stringArray(row.app_names_json),
    createdAt: row.created_at,
    ...(row.digest_id ? { digestId: row.digest_id } : {}),
    domains: stringArray(row.domains_json),
    endedAt: row.ended_at,
    eventCount: row.event_count,
    id: row.id,
    ...(row.raw_cleared_at ? { rawClearedAt: row.raw_cleared_at } : {}),
    screenshotStorageKeys: stringArray(row.screenshot_storage_keys_json).filter(
      (storageKey) => existingAssets.has(storageKey),
    ),
    sourceTypes: stringArray(row.source_types_json) as ActivitySource[],
    startedAt: row.started_at,
    summary: row.summary,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

export class ActivityRepository {
  constructor(private readonly database: Database.Database) {}

  initialize(now: Timestamp): ActivityState {
    const interrupted = JSON.stringify({
      message: "Activity work was interrupted by the previous app exit",
    });
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO activity_state (
             state_id, paused, last_cleanup_at, updated_at
           ) VALUES ('activity', 0, NULL, ?)`,
        )
        .run(now);
      this.database
        .prepare(
          `UPDATE activity_events
           SET ended_at = started_at
           WHERE ended_at IS NULL`,
        )
        .run();
      for (const table of ["distillation_runs", "retention_runs"]) {
        this.database
          .prepare(
            `UPDATE ${table}
             SET status = 'failed', completed_at = ?, error_json = ?
             WHERE status = 'running'`,
          )
          .run(now, interrupted);
      }
    })();
    return this.getState();
  }

  getState(): ActivityState {
    const row = this.database
      .prepare(
        `SELECT paused, last_cleanup_at, updated_at
         FROM activity_state WHERE state_id = 'activity'`,
      )
      .get() as StateRow | undefined;
    if (!row) throw new Error("Activity state has not been initialized");
    return {
      ...(row.last_cleanup_at ? { lastCleanupAt: row.last_cleanup_at } : {}),
      paused: row.paused === 1,
      updatedAt: row.updated_at,
    };
  }

  setPaused(paused: boolean, now: Timestamp): ActivityState {
    this.database
      .prepare(
        `UPDATE activity_state SET paused = ?, updated_at = ?
         WHERE state_id = 'activity'`,
      )
      .run(paused ? 1 : 0, now);
    return this.getState();
  }

  beginDistillation(
    id: string,
    periodStart: Timestamp,
    periodEnd: Timestamp,
    startedAt: Timestamp,
  ): void {
    this.database
      .prepare(
        `INSERT INTO distillation_runs (
           id, period_start, period_end, status, started_at, completed_at,
           error_json
         ) VALUES (?, ?, ?, 'running', ?, NULL, NULL)`,
      )
      .run(id, periodStart, periodEnd, startedAt);
  }

  finishDistillation(id: string, completedAt: Timestamp, error?: string): void {
    this.database
      .prepare(
        `UPDATE distillation_runs
         SET status = ?, completed_at = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        error ? "failed" : "completed",
        completedAt,
        error ? JSON.stringify({ message: error }) : null,
        id,
      );
  }

  beginRetention(id: string, startedAt: Timestamp): void {
    this.database
      .prepare(
        `INSERT INTO retention_runs (
           id, status, deleted_assets, deleted_events, started_at,
           completed_at, error_json
         ) VALUES (?, 'running', 0, 0, ?, NULL, NULL)`,
      )
      .run(id, startedAt);
  }

  finishRetention(
    id: string,
    completedAt: Timestamp,
    deletedAssets: number,
    deletedEvents: number,
    error?: string,
  ): void {
    this.database
      .prepare(
        `UPDATE retention_runs
         SET status = ?, deleted_assets = ?, deleted_events = ?,
             completed_at = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        error ? "failed" : "completed",
        deletedAssets,
        deletedEvents,
        completedAt,
        error ? JSON.stringify({ message: error }) : null,
        id,
      );
  }

  insertAsset(asset: ActivityAssetRecord): void {
    this.database
      .prepare(
        `INSERT INTO activity_assets (
           id, storage_key, media_type, width, height, byte_length, sha256,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.id,
        asset.storageKey,
        asset.mediaType,
        asset.width,
        asset.height,
        asset.byteLength,
        asset.sha256,
        asset.createdAt,
      );
  }

  getAsset(assetId: string): ActivityAssetRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, storage_key, media_type, width, height, byte_length,
                sha256, created_at
         FROM activity_assets WHERE id = ?`,
      )
      .get(assetId) as FullAssetRow | undefined;
    return row
      ? {
          byteLength: row.byte_length,
          createdAt: row.created_at,
          height: row.height,
          id: row.id,
          mediaType: row.media_type,
          sha256: row.sha256,
          storageKey: row.storage_key,
          width: row.width,
        }
      : undefined;
  }

  insertEvent(event: ActivityEvent, createdAt: Timestamp): void {
    this.database
      .prepare(
        `INSERT INTO activity_events (
           id, actor, source, details_json, started_at, ended_at, episode_id,
           distilled_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        event.id,
        event.actor,
        event.details.source,
        JSON.stringify(event.details),
        event.startedAt,
        event.endedAt ?? null,
        createdAt,
      );
  }

  insertScreenshot(
    asset: ActivityAssetRecord,
    event: ActivityEvent,
    createdAt: Timestamp,
  ): void {
    this.database.transaction(() => {
      this.insertAsset(asset);
      this.insertEvent(event, createdAt);
    })();
  }

  closeEvent(eventId: string, endedAt: Timestamp): void {
    this.database
      .prepare(
        `UPDATE activity_events SET ended_at = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(endedAt, eventId);
  }

  listUndistilledEvents(before: Timestamp): ActivityEvent[] {
    return (
      this.database
        .prepare(
          `SELECT id, actor, details_json, started_at, ended_at
           FROM activity_events e
           WHERE e.episode_id IS NULL
             AND e.ended_at IS NOT NULL
             AND e.ended_at <= @before
             AND (
               e.source <> 'managed_browser'
               OR NOT EXISTS (
                 SELECT 1
                 FROM activity_events host
                 WHERE host.source NOT IN ('managed_browser', 'screenshot')
                   AND host.actor = e.actor
                   AND host.started_at <= e.started_at
                   AND (host.ended_at IS NULL OR host.ended_at >= e.started_at)
                   AND (host.ended_at IS NULL OR host.ended_at > @before)
               )
             )
           ORDER BY started_at, id`,
        )
        .all({ before }) as EventRow[]
    ).map(mapEvent);
  }

  insertEpisodes(values: readonly DistilledEpisode[]): void {
    const insert = this.database.prepare(
      `INSERT INTO activity_episodes (
         id, actor, title, summary, started_at, ended_at, source_types_json,
         app_names_json, domains_json, screenshot_storage_keys_json,
         event_count, digest_id, raw_cleared_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    const attach = this.database.prepare(
      `UPDATE activity_events SET episode_id = ?
       WHERE id = ? AND episode_id IS NULL`,
    );
    this.database.transaction(() => {
      for (const { episode, eventIds } of values) {
        insert.run(
          episode.id,
          episode.actor,
          episode.title,
          episode.summary,
          episode.startedAt,
          episode.endedAt,
          JSON.stringify(episode.sourceTypes),
          JSON.stringify(episode.appNames),
          JSON.stringify(episode.domains),
          JSON.stringify(episode.screenshotStorageKeys),
          episode.eventCount,
          episode.createdAt,
          episode.updatedAt,
        );
        for (const eventId of eventIds) attach.run(episode.id, eventId);
      }
    })();
  }

  listEpisodes(
    periodStart: Timestamp,
    periodEnd: Timestamp,
  ): ActivityEpisode[] {
    const rows = this.database
      .prepare(
        `SELECT id, actor, title, summary, started_at, ended_at, source_types_json,
                app_names_json, domains_json, screenshot_storage_keys_json,
                event_count, digest_id, raw_cleared_at, created_at, updated_at
         FROM activity_episodes
         WHERE started_at < ? AND ended_at >= ?
         ORDER BY started_at DESC, id DESC`,
      )
      .all(periodEnd, periodStart) as EpisodeRow[];
    return rows.map((row) => mapEpisode(row, this.#existingAssetKeys()));
  }

  listEpisodesWithoutDailyDigest(): ActivityEpisode[] {
    const rows = this.database
      .prepare(
        `SELECT id, actor, title, summary, started_at, ended_at,
                source_types_json, app_names_json, domains_json,
                screenshot_storage_keys_json, event_count, digest_id,
                raw_cleared_at, created_at, updated_at
         FROM activity_episodes
         WHERE digest_id IS NULL
         ORDER BY started_at, id`,
      )
      .all() as EpisodeRow[];
    const existingAssets = this.#existingAssetKeys();
    return rows.map((row) => mapEpisode(row, existingAssets));
  }

  getEpisode(episodeId: string): ActivityEpisode | undefined {
    const row = this.database
      .prepare(
        `SELECT id, actor, title, summary, started_at, ended_at, source_types_json,
                app_names_json, domains_json, screenshot_storage_keys_json,
                event_count, digest_id, raw_cleared_at, created_at, updated_at
         FROM activity_episodes WHERE id = ?`,
      )
      .get(episodeId) as EpisodeRow | undefined;
    return row ? mapEpisode(row, this.#existingAssetKeys()) : undefined;
  }

  updateEpisode(
    episodeId: string,
    title: string,
    summary: string,
    now: Timestamp,
  ): ActivityEpisode | undefined {
    const result = this.database
      .prepare(
        `UPDATE activity_episodes
         SET title = ?, summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, summary, now, episodeId);
    return result.changes === 1 ? this.getEpisode(episodeId) : undefined;
  }

  deleteEpisode(episodeId: string):
    | {
        readonly candidateIds: readonly string[];
        readonly startedAt: Timestamp;
        readonly storageKeys: readonly string[];
      }
    | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const digestRows = this.database
      .prepare(
        `SELECT d.id, d.candidate_ids_json
         FROM activity_digests d
         JOIN activity_digest_evidence e ON e.digest_id = d.id
         WHERE e.episode_id = ?`,
      )
      .all(episodeId) as Array<{ candidate_ids_json: string; id: string }>;
    const candidateIds = digestRows.flatMap(({ candidate_ids_json }) =>
      stringArray(candidate_ids_json),
    );
    const digestIds = digestRows.map(({ id }) => id);
    this.database.transaction(() => {
      for (const digestId of digestIds) {
        this.database
          .prepare(
            "UPDATE activity_episodes SET digest_id = NULL WHERE digest_id = ?",
          )
          .run(digestId);
        this.database
          .prepare("DELETE FROM activity_digests WHERE id = ?")
          .run(digestId);
      }
      this.database
        .prepare(
          `DELETE FROM activity_assets
           WHERE storage_key IN (
             SELECT value FROM json_each(?)
           )`,
        )
        .run(JSON.stringify(episode.screenshotStorageKeys));
      this.database
        .prepare("DELETE FROM activity_events WHERE episode_id = ?")
        .run(episodeId);
      this.database
        .prepare("DELETE FROM activity_episodes WHERE id = ?")
        .run(episodeId);
    })();
    return {
      candidateIds,
      startedAt: episode.startedAt,
      storageKeys: episode.screenshotStorageKeys,
    };
  }

  hasDigest(
    kind: ActivityDigest["kind"],
    periodStart: Timestamp,
    periodEnd: Timestamp,
  ): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM activity_digests
           WHERE kind = ? AND period_start = ? AND period_end = ?`,
        )
        .get(kind, periodStart, periodEnd),
    );
  }

  insertDigest(
    digest: ActivityDigest,
    evidenceLabels: ReadonlyMap<string, string>,
  ): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO activity_digests (
             id, kind, title, summary, period_start, period_end, evidence_days,
             candidate_ids_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          digest.id,
          digest.kind,
          digest.title,
          digest.summary,
          digest.periodStart,
          digest.periodEnd,
          digest.evidenceDays,
          JSON.stringify(digest.candidateIds),
          digest.createdAt,
        );
      const insertEvidence = this.database.prepare(
        `INSERT INTO activity_digest_evidence (
           digest_id, episode_id, evidence_label
         ) VALUES (?, ?, ?)`,
      );
      for (const episodeId of digest.episodeIds) {
        insertEvidence.run(
          digest.id,
          episodeId,
          evidenceLabels.get(episodeId) ?? "活动摘要证据",
        );
      }
      if (digest.kind === "daily") {
        const updateEpisode = this.database.prepare(
          `UPDATE activity_episodes SET digest_id = ? WHERE id = ?`,
        );
        for (const episodeId of digest.episodeIds) {
          updateEpisode.run(digest.id, episodeId);
        }
      }
    })();
  }

  replaceDailyDigest(
    digest: ActivityDigest,
    evidenceLabels: ReadonlyMap<string, string>,
  ): void {
    if (digest.kind !== "daily") {
      throw new TypeError("Only daily Activity digests can be replaced");
    }
    this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT id FROM activity_digests
           WHERE kind = 'daily' AND period_start = ? AND period_end = ?`,
        )
        .get(digest.periodStart, digest.periodEnd) as
        { id: string } | undefined;
      const digestId = existing?.id ?? digest.id;
      if (existing) {
        this.database
          .prepare(
            `UPDATE activity_digests
             SET title = ?, summary = ?, evidence_days = ?,
                 candidate_ids_json = ?
             WHERE id = ?`,
          )
          .run(
            digest.title,
            digest.summary,
            digest.evidenceDays,
            JSON.stringify(digest.candidateIds),
            digestId,
          );
        this.database
          .prepare("DELETE FROM activity_digest_evidence WHERE digest_id = ?")
          .run(digestId);
        this.database
          .prepare(
            "UPDATE activity_episodes SET digest_id = NULL WHERE digest_id = ?",
          )
          .run(digestId);
      } else {
        this.database
          .prepare(
            `INSERT INTO activity_digests (
               id, kind, title, summary, period_start, period_end,
               evidence_days, candidate_ids_json, created_at
             ) VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            digestId,
            digest.title,
            digest.summary,
            digest.periodStart,
            digest.periodEnd,
            digest.evidenceDays,
            JSON.stringify(digest.candidateIds),
            digest.createdAt,
          );
      }
      const insertEvidence = this.database.prepare(
        `INSERT INTO activity_digest_evidence (
           digest_id, episode_id, evidence_label
         ) VALUES (?, ?, ?)`,
      );
      const attachEpisode = this.database.prepare(
        "UPDATE activity_episodes SET digest_id = ? WHERE id = ?",
      );
      for (const episodeId of digest.episodeIds) {
        insertEvidence.run(
          digestId,
          episodeId,
          evidenceLabels.get(episodeId) ?? "活动摘要证据",
        );
        attachEpisode.run(digestId, episodeId);
      }
    })();
  }

  updateDigestCandidates(
    digestId: string,
    candidateIds: readonly string[],
  ): void {
    this.database
      .prepare(
        `UPDATE activity_digests SET candidate_ids_json = ? WHERE id = ?`,
      )
      .run(JSON.stringify(candidateIds), digestId);
  }

  listDigests(periodStart: Timestamp, periodEnd: Timestamp): ActivityDigest[] {
    const rows = this.database
      .prepare(
        `SELECT id, kind, title, summary, period_start, period_end,
                evidence_days, candidate_ids_json, created_at
         FROM activity_digests
         WHERE period_start < ? AND period_end > ?
         ORDER BY period_start DESC, kind DESC, id DESC`,
      )
      .all(periodEnd, periodStart) as DigestRow[];
    const evidenceRows = this.database
      .prepare(
        `SELECT digest_id, episode_id
         FROM activity_digest_evidence
         WHERE digest_id IN (SELECT id FROM activity_digests
           WHERE period_start < ? AND period_end > ?)
         ORDER BY digest_id, episode_id`,
      )
      .all(periodEnd, periodStart) as EvidenceRow[];
    const evidence = new Map<string, string[]>();
    for (const row of evidenceRows) {
      const ids = evidence.get(row.digest_id) ?? [];
      ids.push(row.episode_id);
      evidence.set(row.digest_id, ids);
    }
    return rows.map((row) => ({
      candidateIds: stringArray(row.candidate_ids_json),
      createdAt: row.created_at,
      evidenceDays: row.evidence_days,
      episodeIds: evidence.get(row.id) ?? [],
      id: row.id,
      kind: row.kind,
      periodEnd: row.period_end,
      periodStart: row.period_start,
      summary: row.summary,
      title: row.title,
    }));
  }

  markDistilled(episodeIds: readonly string[], now: Timestamp): void {
    const statement = this.database.prepare(
      `UPDATE activity_events SET distilled_at = ? WHERE episode_id = ?`,
    );
    this.database.transaction(() => {
      for (const episodeId of episodeIds) statement.run(now, episodeId);
    })();
  }

  rawBytes(): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM activity_assets",
      )
      .get() as { bytes: number };
    return row.bytes;
  }

  cleanup(now: Timestamp, immediate: boolean): ActivityCleanupPlanResult {
    const screenshotCutoff = immediate ? now : this.#daysBefore(now, 7);
    const eventCutoff = immediate ? now : this.#daysBefore(now, 30);
    const episodeCutoff = this.#daysBefore(now, 90);
    const assetRows = this.database
      .prepare(
        `SELECT DISTINCT a.id, a.storage_key, a.byte_length, a.created_at
         FROM activity_assets a
         JOIN activity_events e
           ON json_extract(e.details_json, '$.artifactId') = a.id
         WHERE a.created_at <= ? AND e.distilled_at IS NOT NULL
         ORDER BY a.created_at, a.id`,
      )
      .all(screenshotCutoff) as AssetRow[];
    const allAssets = this.database
      .prepare(
        `SELECT id, storage_key, byte_length, created_at
         FROM activity_assets ORDER BY created_at, id`,
      )
      .all() as AssetRow[];
    const screenshotEventRows = this.database
      .prepare(
        `SELECT id, json_extract(details_json, '$.artifactId') AS asset_id
         FROM activity_events
         WHERE source = 'screenshot' AND distilled_at IS NOT NULL`,
      )
      .all() as Array<{ asset_id: string; id: string }>;
    const eventIdsByAsset = new Map<string, string[]>();
    for (const row of screenshotEventRows) {
      const ids = eventIdsByAsset.get(row.asset_id) ?? [];
      ids.push(row.id);
      eventIdsByAsset.set(row.asset_id, ids);
    }
    const selected = new Map(assetRows.map((row) => [row.id, row]));
    let remainingBytes = allAssets.reduce(
      (sum, row) => sum + row.byte_length,
      0,
    );
    for (const row of assetRows) remainingBytes -= row.byte_length;
    const cap = 512 * 1024 * 1024;
    if (remainingBytes > cap) {
      const eligibleById = new Set(
        (
          this.database
            .prepare(
              `SELECT DISTINCT a.id
               FROM activity_assets a
               JOIN activity_events e
                 ON json_extract(e.details_json, '$.artifactId') = a.id
               WHERE e.distilled_at IS NOT NULL`,
            )
            .all() as Array<{ id: string }>
        ).map(({ id }) => id),
      );
      for (const row of allAssets) {
        if (remainingBytes <= cap) break;
        if (!eligibleById.has(row.id) || selected.has(row.id)) continue;
        selected.set(row.id, row);
        remainingBytes -= row.byte_length;
      }
    }

    const expiredEventIds = new Set(
      (
        this.database
          .prepare(
            `SELECT id FROM activity_events
             WHERE ended_at <= ? AND distilled_at IS NOT NULL`,
          )
          .all(eventCutoff) as Array<{ id: string }>
      ).map(({ id }) => id),
    );
    for (const assetId of selected.keys()) {
      for (const eventId of eventIdsByAsset.get(assetId) ?? []) {
        expiredEventIds.add(eventId);
      }
    }
    const deleteAsset = this.database.prepare(
      "DELETE FROM activity_assets WHERE id = ?",
    );
    const deleteEvent = this.database.prepare(
      "DELETE FROM activity_events WHERE id = ?",
    );
    this.database.transaction(() => {
      for (const assetId of selected.keys()) deleteAsset.run(assetId);
      for (const eventId of expiredEventIds) deleteEvent.run(eventId);
      this.database
        .prepare(
          `UPDATE activity_episodes
           SET raw_cleared_at = COALESCE(raw_cleared_at, ?), updated_at = ?
           WHERE NOT EXISTS (
             SELECT 1 FROM activity_events e WHERE e.episode_id = activity_episodes.id
           )`,
        )
        .run(now, now);
      this.database
        .prepare(
          `DELETE FROM activity_episodes
           WHERE ended_at <= ? AND raw_cleared_at IS NOT NULL`,
        )
        .run(episodeCutoff);
      this.database
        .prepare(
          `UPDATE activity_state SET last_cleanup_at = ?, updated_at = ?
           WHERE state_id = 'activity'`,
        )
        .run(now, now);
    })();
    return {
      deletedAssets: selected.size,
      deletedEvents: expiredEventIds.size,
      storageKeys: [...selected.values()].map(({ storage_key }) => storage_key),
    };
  }

  assetStorageKeys(): Set<string> {
    return this.#existingAssetKeys();
  }

  #existingAssetKeys(): Set<string> {
    return new Set(
      (
        this.database
          .prepare("SELECT storage_key FROM activity_assets")
          .all() as Array<{ storage_key: string }>
      ).map(({ storage_key }) => storage_key),
    );
  }

  #daysBefore(now: Timestamp, days: number): Timestamp {
    return new Date(Date.parse(now) - days * 86_400_000).toISOString();
  }
}
