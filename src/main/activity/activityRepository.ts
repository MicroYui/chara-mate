import type Database from "better-sqlite3";
import { setImmediate } from "node:timers/promises";

import type {
  ActivityDigest,
  ActivityEpisode,
  ActivityEvent,
  ActivitySource,
  ActivityVisualLookupRequest,
  ActivityVisualLookupResult,
  ActivityVisualMatch,
} from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import {
  ActivityEventDetailsSchema,
  ActivityVisualReferenceSchema,
} from "../../shared/schemas/activity";
import { parseSchema } from "../../shared/schemas/validation";
import type { DistilledEpisode } from "./activityDistillation";
import type { ActivityObserveInput } from "./activityObservation";

export interface ActivityTextSource {
  readonly id: string;
  readonly actor: ActivityEvent["actor"];
  readonly source: ActivitySource;
  readonly startedAt: Timestamp;
  readonly receivedAt: Timestamp;
  readonly detailsJson: string | null;
}

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

/** The integration owner protects sources still needed by Cognition or Memory. */
export type ActivitySourceRetentionGuard = (
  eventIds: readonly string[],
) => ReadonlySet<string>;

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

  getEvent(id: string): ActivityEvent | undefined {
    const row = this.database
      .prepare(
        "SELECT id, actor, details_json, started_at, ended_at FROM activity_events WHERE id = ?",
      )
      .get(id) as EventRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  readTextObservation(
    request: ActivityObserveInput,
    maxReadBytes: number,
  ): ActivityTextSource | undefined {
    const conditions: string[] = [];
    const bindings: Record<string, string | number> = { maxReadBytes };
    if (request.reference) {
      conditions.push("id = @eventId");
      bindings["eventId"] = request.reference.eventId;
    } else {
      const latest = request.latest!;
      conditions.push("source IN ('active_app', 'managed_browser')");
      if (latest.periodStart) {
        conditions.push("started_at >= @periodStart");
        bindings["periodStart"] = latest.periodStart;
      }
      if (latest.periodEnd) {
        conditions.push("started_at <= @periodEnd");
        bindings["periodEnd"] = latest.periodEnd;
      }
      if (latest.before) {
        conditions.push("(started_at, id) < (@beforeTime, @beforeId)");
        bindings["beforeTime"] = latest.before.startedAt;
        bindings["beforeId"] = latest.before.eventId;
      }
      if (latest.surface) {
        conditions.push(
          "json_extract(details_json, '$.surface.id') = @surfaceId",
          "json_extract(details_json, '$.surface.epoch') = @surfaceEpoch",
        );
        bindings["surfaceId"] = latest.surface.id;
        bindings["surfaceEpoch"] = latest.surface.epoch;
      }
      if (latest.query) {
        const paths = [
          "appName",
          "appId",
          "windowTitle",
          "title",
          "url",
          "domain",
          "surface.appName",
          "surface.appId",
          "surface.windowTitle",
        ];
        conditions.push(
          `(${paths.map((field) => `instr(COALESCE(json_extract(details_json, '$.${field}'), ''), @query) > 0`).join(" OR ")})`,
        );
        bindings["query"] = latest.query;
      }
    }
    // Select the newest location match before inspecting availability or size.
    // The raw body crosses the SQLite boundary only when it fits the local read guard.
    return this.database
      .prepare(
        `
      WITH candidate AS (
        SELECT id, actor, source, started_at, created_at, details_json
        FROM activity_events WHERE ${conditions.join(" AND ")}
        ORDER BY started_at DESC, id DESC LIMIT 1
      )
      SELECT id, actor, source, started_at AS startedAt, created_at AS receivedAt,
        CASE WHEN length(CAST(details_json AS BLOB)) + length(CAST(id AS BLOB))
          + length(CAST(actor AS BLOB)) + length(CAST(source AS BLOB))
          + length(CAST(started_at AS BLOB)) + length(CAST(created_at AS BLOB)) <= @maxReadBytes
        THEN details_json END AS detailsJson
      FROM candidate
    `,
      )
      .get(bindings) as ActivityTextSource | undefined;
  }

  textObservationState(
    source: ActivityTextSource,
  ): "same" | "missing" | "changed" {
    const row = this.database
      .prepare(
        `
      SELECT CASE WHEN actor = @actor AND source = @source
        AND started_at = @startedAt AND created_at = @receivedAt
        AND (@detailsJson IS NULL OR details_json = @detailsJson)
        THEN 1 ELSE 0 END AS same
      FROM activity_events WHERE id = @id
    `,
      )
      .get({ ...source }) as { same: number } | undefined;
    return row ? (row.same === 1 ? "same" : "changed") : "missing";
  }

  async lookupVisualEvidence(
    request: ActivityVisualLookupRequest & { readonly periodEnd: Timestamp },
    resourceBudget: { readonly maxReadBytes: number },
    signal?: AbortSignal,
  ): Promise<ActivityVisualLookupResult> {
    signal?.throwIfAborted();
    const { maxReadBytes } = resourceBudget;
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 0)
      throw new RangeError(
        "Visual lookup requires a non-negative raw-read budget",
      );
    const conditions = [
      "source = 'screenshot'",
      "started_at <= @periodEnd",
      "json_type(details_json, '$.visual') = 'object'",
    ];
    const bindings: Record<string, string> = { periodEnd: request.periodEnd };
    if (request.periodStart) {
      conditions.push("started_at >= @periodStart");
      bindings["periodStart"] = request.periodStart;
    }
    if (request.surface) {
      conditions.push(
        "json_extract(details_json, '$.visual.surface.id') = @surfaceId",
        "json_extract(details_json, '$.visual.surface.epoch') = @surfaceEpoch",
      );
      bindings["surfaceId"] = request.surface.id;
      bindings["surfaceEpoch"] = request.surface.epoch;
    }
    if (request.query) {
      conditions.push(`(
        instr(COALESCE(json_extract(details_json, '$.visual.surface.appName'), ''), @query) > 0
        OR instr(COALESCE(json_extract(details_json, '$.visual.surface.windowTitle'), ''), @query) > 0
        OR instr(COALESCE(json_extract(details_json, '$.ocrText'), ''), @query) > 0
        OR EXISTS (
          SELECT 1 FROM json_each(details_json, '$.visual.ocr.lines') AS line
          WHERE instr(json_extract(line.value, '$.text'), @query) > 0
        )
      )`);
      bindings["query"] = request.query;
    }
    const prepare = (hasBefore: boolean) =>
      this.database.prepare(`
        WITH candidate AS (
          SELECT json_object(
            'actor', actor,
            'position', json_object('startedAt', started_at, 'eventId', id),
            'reference', json_object(
              'eventId', id,
              'artifactId', json_extract(details_json, '$.artifactId'),
              'contentRevision', json_extract(details_json, '$.visual.contentRevision'),
              'surface', json_extract(details_json, '$.visual.surface'),
              'capturedAt', json_extract(details_json, '$.visual.capturedAt'),
              'width', json_extract(details_json, '$.width'),
              'height', json_extract(details_json, '$.height'),
              'trigger', json_extract(details_json, '$.visual.trigger')
            )
          ) AS match_json
          FROM activity_events
          WHERE ${conditions.join(" AND ")}
            ${hasBefore ? "AND (started_at, id) < (@beforeTime, @beforeId)" : ""}
          ORDER BY started_at DESC, id DESC LIMIT 1
        )
        SELECT length(CAST(match_json AS BLOB)) AS read_bytes,
          CASE WHEN length(CAST(match_json AS BLOB)) <= @remaining
            THEN match_json END AS match_json
        FROM candidate
      `);
    const first = request.before ? undefined : prepare(false);
    const next = prepare(true);
    const observations: ActivityVisualMatch[] = [];
    let before = request.before;
    let readBytes = 0;
    for (;;) {
      signal?.throwIfAborted();
      // Each get completes before yielding. The time/id key moves past returned
      // rows; no SQLite iterator or transaction is held across the await below.
      const row = (before ? next : first!).get({
        ...bindings,
        remaining: maxReadBytes - readBytes,
        ...(before
          ? { beforeTime: before.startedAt, beforeId: before.eventId }
          : {}),
      }) as { read_bytes: number; match_json: string | null } | undefined;
      signal?.throwIfAborted();
      const base = {
        request,
        observations,
        readBytes,
        loaded: false as const,
        retainedOnly: true as const,
        order: "newest_first" as const,
      };
      if (!row) return { ...base, complete: true };
      if (row.match_json === null)
        return {
          ...base,
          complete: false,
          omittedReason: "read_budget",
          // A zero-row page repeats its original cursor. Never skip the first
          // unreturned match, including when one reference exceeds the budget.
          continuation: { ...request, ...(before ? { before } : {}) },
        };
      const match = JSON.parse(row.match_json) as ActivityVisualMatch;
      const reference = parseSchema(
        ActivityVisualReferenceSchema,
        match.reference,
      );
      observations.push({ ...match, reference });
      readBytes += row.read_bytes;
      before = match.position;
      await setImmediate(undefined, signal ? { signal } : undefined);
      signal?.throwIfAborted();
    }
  }

  getEventSourceReference(
    id: string,
  ): Pick<ActivityEvent, "id" | "actor" | "startedAt"> | undefined {
    return this.database
      .prepare(
        `SELECT id, actor, started_at AS startedAt FROM activity_events WHERE id = ?`,
      )
      .get(id) as Pick<ActivityEvent, "id" | "actor" | "startedAt"> | undefined;
  }

  resolveEventReference(
    eventId: string,
  ): { startedAt: string; episodeId?: string } | undefined {
    const row = this.database
      .prepare(
        `SELECT e.started_at, p.id AS episode_id
      FROM activity_events e LEFT JOIN activity_episodes p ON p.id = e.episode_id
      WHERE e.id = ?`,
      )
      .get(eventId) as
      { started_at: string; episode_id: string | null } | undefined;
    return row
      ? {
          startedAt: row.started_at,
          ...(row.episode_id ? { episodeId: row.episode_id } : {}),
        }
      : undefined;
  }

  findAssetByHash(hash: string): ActivityAssetRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT id FROM activity_assets WHERE sha256 = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(hash) as { id: string } | undefined;
    return row ? this.getAsset(row.id) : undefined;
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
    const storageKeys: string[] = [];
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
        .prepare("DELETE FROM activity_events WHERE episode_id = ?")
        .run(episodeId);
      const removed = this.database
        .prepare(
          `DELETE FROM activity_assets
        WHERE storage_key IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM activity_events e
            WHERE CAST(json_extract(e.details_json, '$.artifactId') AS TEXT) = activity_assets.id)
        RETURNING storage_key`,
        )
        .all(JSON.stringify(episode.screenshotStorageKeys)) as Array<{
        storage_key: string;
      }>;
      storageKeys.push(...removed.map((row) => row.storage_key));
      this.database
        .prepare("DELETE FROM activity_episodes WHERE id = ?")
        .run(episodeId);
    })();
    return {
      candidateIds,
      startedAt: episode.startedAt,
      storageKeys,
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

  getDigest(digestId: string): ActivityDigest | undefined {
    const row = this.database
      .prepare(
        `SELECT id, kind, title, summary, period_start, period_end,
                evidence_days, candidate_ids_json, created_at
         FROM activity_digests
         WHERE id = ?`,
      )
      .get(digestId) as DigestRow | undefined;
    if (!row) return undefined;
    const episodeIds = (
      this.database
        .prepare(
          `SELECT episode_id FROM activity_digest_evidence
           WHERE digest_id = ? ORDER BY episode_id`,
        )
        .all(digestId) as Array<{ episode_id: string }>
    ).map(({ episode_id }) => episode_id);
    return {
      candidateIds: stringArray(row.candidate_ids_json),
      createdAt: row.created_at,
      evidenceDays: row.evidence_days,
      episodeIds,
      id: row.id,
      kind: row.kind,
      periodEnd: row.period_end,
      periodStart: row.period_start,
      summary: row.summary,
      title: row.title,
    };
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

  async cleanup(
    now: Timestamp,
    immediate: boolean,
    guard?: ActivitySourceRetentionGuard,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<ActivityCleanupPlanResult> {
    const rangeSize = 1000;
    const screenshotCutoff = immediate ? now : this.#daysBefore(now, 7);
    const eventCutoff = immediate ? now : this.#daysBefore(now, 30);
    const episodeCutoff = this.#daysBefore(now, 90);
    const result = {
      deletedAssets: 0,
      deletedEvents: 0,
      storageKeys: [] as string[],
    };
    const empty = (): ActivityCleanupPlanResult => ({
      deletedAssets: 0,
      deletedEvents: 0,
      storageKeys: [],
    });
    signal?.throwIfAborted();
    if (!guard) {
      this.database.transaction(() =>
        this.#finishCleanup(now, episodeCutoff),
      )();
      return result;
    }
    const commit = (operation: () => ActivityCleanupPlanResult) => {
      signal?.throwIfAborted();
      const delta = this.database.transaction(() => {
        const value = operation();
        if (runId && (value.deletedAssets || value.deletedEvents))
          this.database
            .prepare(
              `UPDATE retention_runs
            SET deleted_assets=deleted_assets+?, deleted_events=deleted_events+?
            WHERE id=? AND status='running'`,
            )
            .run(value.deletedAssets, value.deletedEvents, runId);
        return value;
      })();
      result.deletedAssets += delta.deletedAssets;
      result.deletedEvents += delta.deletedEvents;
      result.storageKeys.push(...delta.storageKeys);
    };
    type ReferenceRow = {
      id: string;
      asset_id: string | null;
      distilled_at: string | null;
    };
    const deleteEvents = this.database.prepare(
      `DELETE FROM activity_events WHERE id IN (SELECT value FROM json_each(?))`,
    );
    const unreferenced = this.database
      .prepare(`SELECT a.id,a.storage_key FROM activity_assets a
      WHERE a.id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (
        SELECT 1 FROM activity_events e
        WHERE CAST(json_extract(e.details_json,'$.artifactId') AS TEXT)=a.id)`);
    const deleteAssets = this.database.prepare(
      `DELETE FROM activity_assets WHERE id IN (SELECT value FROM json_each(?))`,
    );
    const releaseAssets = (
      ids: readonly string[],
    ): ActivityCleanupPlanResult => {
      if (!ids.length) return empty();
      const rows = unreferenced.all(JSON.stringify(ids)) as Array<{
        id: string;
        storage_key: string;
      }>;
      if (!rows.length) return empty();
      const deletedAssets = deleteAssets.run(
        JSON.stringify(rows.map((row) => row.id)),
      ).changes;
      return {
        deletedAssets,
        deletedEvents: 0,
        storageKeys: rows.map((row) => row.storage_key),
      };
    };
    const retire = (
      rows: readonly ReferenceRow[],
    ): ActivityCleanupPlanResult => {
      const retained = guard(rows.map((row) => row.id));
      signal?.throwIfAborted();
      const eligible = rows.filter(
        (row) => row.distilled_at !== null && !retained.has(row.id),
      );
      if (!eligible.length) return empty();
      const deletedEvents = deleteEvents.run(
        JSON.stringify(eligible.map((row) => row.id)),
      ).changes;
      const released = releaseAssets([
        ...new Set(
          eligible.flatMap((row) => (row.asset_id ? [row.asset_id] : [])),
        ),
      ]);
      return { ...released, deletedEvents };
    };
    // Each source owns its retention age. Another reference keeps the file,
    // but does not extend this source's lifetime after its consumers release it.
    const highWater = (
      this.database
        .prepare(`SELECT id FROM activity_events ORDER BY id DESC LIMIT 1`)
        .get() as { id: string } | undefined
    )?.id;
    let cursor = "";
    if (highWater)
      while (true) {
        let lastId: string | undefined;
        commit(() => {
          const rows = this.database
            .prepare(
              `SELECT id,source,started_at,ended_at,distilled_at,
            CAST(json_extract(details_json,'$.artifactId') AS TEXT) AS asset_id
          FROM activity_events WHERE id>? AND id<=? ORDER BY id LIMIT ?`,
            )
            .all(cursor, highWater, rangeSize) as Array<
            ReferenceRow & {
              source: string;
              started_at: string;
              ended_at: string | null;
            }
          >;
          lastId = rows.at(-1)?.id;
          const eligible = rows.filter(
            (row) =>
              row.distilled_at !== null &&
              (row.source === "screenshot"
                ? row.started_at <= screenshotCutoff
                : row.ended_at !== null && row.ended_at <= eventCutoff),
          );
          return eligible.length ? retire(eligible) : empty();
        });
        if (!lastId) break;
        cursor = lastId;
        await setImmediate();
      }
    // Recover asset rows left without references, including interruption after
    // earlier retirement. PNG removal remains owned by the serial service queue.
    const assetHighWater = (
      this.database
        .prepare(`SELECT id FROM activity_assets ORDER BY id DESC LIMIT 1`)
        .get() as { id: string } | undefined
    )?.id;
    cursor = "";
    if (assetHighWater)
      while (true) {
        let lastId: string | undefined;
        commit(() => {
          const rows = this.database
            .prepare(
              `SELECT id FROM activity_assets WHERE id>? AND id<=? ORDER BY id LIMIT ?`,
            )
            .all(cursor, assetHighWater, rangeSize) as Array<{ id: string }>;
          lastId = rows.at(-1)?.id;
          return releaseAssets(rows.map((row) => row.id));
        });
        if (!lastId) break;
        cursor = lastId;
        await setImmediate();
      }
    // Capacity admission is a bounded conservative preflight. It is never a
    // permission cache: every retiring page calls the live guard again.
    type AssetCursor = { created_at: string; id: string };
    const capacityHighWater = this.database
      .prepare(
        `SELECT created_at,id FROM activity_assets ORDER BY created_at DESC,id DESC LIMIT 1`,
      )
      .get() as AssetCursor | undefined;
    const assetPage = this.database
      .prepare(`SELECT created_at,id FROM activity_assets
      WHERE (created_at,id)>(?,?) AND (created_at,id)<=(?,?)
      ORDER BY created_at,id LIMIT ?`);
    const referencePage = this.database
      .prepare(`SELECT id,distilled_at,? AS asset_id FROM activity_events
      WHERE CAST(json_extract(details_json,'$.artifactId') AS TEXT)=? AND id>? AND id<=?
      ORDER BY id LIMIT ?`);
    const retireCapacityAsset = async (assetId: string) => {
      signal?.throwIfAborted();
      const upper = (
        this.database
          .prepare(
            `SELECT id FROM activity_events
        WHERE CAST(json_extract(details_json,'$.artifactId') AS TEXT)=? ORDER BY id DESC LIMIT 1`,
          )
          .get(assetId) as { id: string } | undefined
      )?.id;
      if (!upper) return;
      let admission = true;
      cursor = "";
      while (true) {
        let lastId: string | undefined;
        this.database.transaction(() => {
          signal?.throwIfAborted();
          const rows = referencePage.all(
            assetId,
            assetId,
            cursor,
            upper,
            rangeSize,
          ) as ReferenceRow[];
          lastId = rows.at(-1)?.id;
          const retained = rows.length
            ? guard(rows.map((row) => row.id))
            : new Set<string>();
          signal?.throwIfAborted();
          if (
            rows.some(
              (row) => row.distilled_at === null || retained.has(row.id),
            )
          )
            admission = false;
        })();
        if (!admission || !lastId) break;
        cursor = lastId;
        await setImmediate();
      }
      if (!admission) return;
      cursor = "";
      while (true) {
        let lastId: string | undefined;
        let capacitySatisfied = false;
        commit(() => {
          if (this.rawBytes() <= 512 * 1024 * 1024) {
            capacitySatisfied = true;
            return empty();
          }
          const rows = referencePage.all(
            assetId,
            assetId,
            cursor,
            upper,
            rangeSize,
          ) as ReferenceRow[];
          lastId = rows.at(-1)?.id;
          return rows.length ? retire(rows) : empty();
        });
        if (capacitySatisfied || !lastId) break;
        cursor = lastId;
        await setImmediate();
      }
    };
    let capacityCursor: AssetCursor = { created_at: "", id: "" };
    while (capacityHighWater) {
      signal?.throwIfAborted();
      if (this.rawBytes() <= 512 * 1024 * 1024) break;
      const rows = assetPage.all(
        capacityCursor.created_at,
        capacityCursor.id,
        capacityHighWater.created_at,
        capacityHighWater.id,
        rangeSize,
      ) as AssetCursor[];
      const last = rows.at(-1);
      if (!last) break;
      let capacitySatisfied = false;
      for (const row of rows) {
        signal?.throwIfAborted();
        if (this.rawBytes() <= 512 * 1024 * 1024) {
          capacitySatisfied = true;
          break;
        }
        await retireCapacityAsset(row.id);
        // Even a protected first reference or a disappeared asset must yield.
        await setImmediate();
      }
      if (capacitySatisfied) break;
      capacityCursor = last;
    }
    signal?.throwIfAborted();
    this.database.transaction(() => this.#finishCleanup(now, episodeCutoff))();
    return result;
  }

  retentionProgress(runId: string): {
    deletedAssets: number;
    deletedEvents: number;
  } {
    const row = this.database
      .prepare(
        `SELECT deleted_assets,deleted_events FROM retention_runs WHERE id=?`,
      )
      .get(runId) as
      { deleted_assets: number; deleted_events: number } | undefined;
    if (!row) throw new Error("Activity retention run is unavailable");
    return {
      deletedAssets: row.deleted_assets,
      deletedEvents: row.deleted_events,
    };
  }

  #finishCleanup(now: Timestamp, episodeCutoff: Timestamp): void {
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
