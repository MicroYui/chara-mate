import type {
  ActivityCleanupResult,
  ActivityEpisode,
  ActivityEvent,
  ActivityEventDetails,
  ActivitySnapshot,
} from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import type { ScreenCapture } from "../computer/macosComputer";
import type { MemoryService } from "../memory/memoryService";
import type { ActivityAssetStore } from "./activityAssetStore";
import {
  createDailyDigest,
  createWeeklyDigest,
  distillEpisodes,
  EPISODE_MERGE_MS,
} from "./activityDistillation";
import { ActivityError } from "./activityError";
import type { ActivityRepository } from "./activityRepository";

const DAY_MS = 86_400_000;
const RETAINED_EPISODE_DAYS = 90;

function addDateDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function zonedDate(timestamp: Timestamp, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

function zonedMidnight(date: string, timeZone: string): Timestamp {
  const guess = Date.parse(`${date}T00:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date(guess));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const represented = Date.UTC(
    Number(values["year"]),
    Number(values["month"]) - 1,
    Number(values["day"]),
    Number(values["hour"]),
    Number(values["minute"]),
    Number(values["second"]),
  );
  return new Date(guess - (represented - guess)).toISOString();
}

function datePeriod(date: string, timeZone: string) {
  return {
    end: zonedMidnight(addDateDays(date, 1), timeZone),
    start: zonedMidnight(date, timeZone),
  };
}

function mondayOnOrBefore(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const weekday = value.getUTCDay();
  const distance = weekday === 0 ? 6 : weekday - 1;
  return addDateDays(date, -distance);
}

function redactEventDetails(
  details: ActivityEventDetails,
): ActivityEventDetails {
  if (details.source === "active_app") {
    return {
      ...(details.appId ? { appId: redactText(details.appId) } : {}),
      appName: redactText(details.appName),
      source: details.source,
      ...(details.windowTitle
        ? { windowTitle: redactText(details.windowTitle) }
        : {}),
    };
  }
  if (details.source === "managed_browser") {
    return {
      ...(details.action ? { action: redactText(details.action) } : {}),
      domain: redactText(details.domain),
      source: details.source,
      ...(details.title ? { title: redactText(details.title) } : {}),
      url: redactText(details.url),
    };
  }
  if (details.source === "screenshot") {
    return {
      ...details,
      ...(details.ocrText ? { ocrText: redactText(details.ocrText) } : {}),
      ...(details.summary ? { summary: redactText(details.summary) } : {}),
    };
  }
  if (details.source === "agent_run") {
    return {
      ...details,
      ...(details.summary ? { summary: redactText(details.summary) } : {}),
    };
  }
  return details;
}

export class ActivityService {
  #lastMaintenanceDate: string | undefined;
  #maintenanceInterval: ReturnType<typeof setInterval> | undefined;
  #maintenanceTask: Promise<void> | undefined;
  #pauseListeners = new Set<(paused: boolean) => void>();
  readonly timeZone: string;

  constructor(
    private readonly repository: ActivityRepository,
    private readonly memory: MemoryService,
    private readonly assets: ActivityAssetStore,
    private readonly capture: ScreenCapture,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ) {
    this.timeZone = timeZone;
  }

  async initialize(): Promise<void> {
    this.repository.initialize(this.clock.now());
    this.distill();
    await this.cleanup(false);
    this.#lastMaintenanceDate = zonedDate(this.clock.now(), this.timeZone);
  }

  startMaintenance(onError: (error: unknown) => void): void {
    if (this.#maintenanceInterval) return;
    this.#maintenanceInterval = setInterval(() => {
      if (this.#maintenanceTask) return;
      const task = this.#maintain();
      this.#maintenanceTask = task;
      void task.catch(onError).finally(() => {
        if (this.#maintenanceTask === task) this.#maintenanceTask = undefined;
      });
    }, EPISODE_MERGE_MS);
    this.#maintenanceInterval.unref?.();
  }

  async stopMaintenance(): Promise<void> {
    if (this.#maintenanceInterval) clearInterval(this.#maintenanceInterval);
    this.#maintenanceInterval = undefined;
    await this.#maintenanceTask;
  }

  isPaused(): boolean {
    return this.repository.getState().paused;
  }

  getSnapshot(date: string): ActivitySnapshot {
    const period = datePeriod(date, this.timeZone);
    const state = this.repository.getState();
    return {
      date,
      digests: this.repository.listDigests(period.start, period.end),
      episodes: this.repository.listEpisodes(period.start, period.end),
      ...(state.lastCleanupAt ? { lastCleanupAt: state.lastCleanupAt } : {}),
      paused: state.paused,
      rawBytes: this.repository.rawBytes(),
    };
  }

  getEpisode(episodeId: string): ActivityEpisode {
    const episode = this.repository.getEpisode(episodeId);
    if (!episode) {
      throw new ActivityError(
        "ACTIVITY.EPISODE_NOT_FOUND",
        "找不到这段活动。",
        false,
      );
    }
    return episode;
  }

  setPaused(paused: boolean): ActivitySnapshot {
    const now = this.clock.now();
    this.repository.setPaused(paused, now);
    for (const listener of this.#pauseListeners) listener(paused);
    return this.getSnapshot(zonedDate(now, this.timeZone));
  }

  onPauseChanged(listener: (paused: boolean) => void): () => void {
    this.#pauseListeners.add(listener);
    return () => this.#pauseListeners.delete(listener);
  }

  updateEpisode(
    episodeId: string,
    title: string,
    summary: string,
  ): ActivityEpisode {
    const episode = this.repository.updateEpisode(
      episodeId,
      redactText(title),
      redactText(summary),
      this.clock.now(),
    );
    if (!episode) {
      throw new ActivityError(
        "ACTIVITY.EPISODE_NOT_FOUND",
        "找不到这段活动。",
        false,
      );
    }
    return episode;
  }

  async deleteEpisode(episodeId: string): Promise<ActivitySnapshot> {
    const deleted = this.repository.deleteEpisode(episodeId);
    if (!deleted) {
      throw new ActivityError(
        "ACTIVITY.EPISODE_NOT_FOUND",
        "找不到这段活动。",
        false,
      );
    }
    await this.assets.remove(deleted.storageKeys);
    for (const candidateId of deleted.candidateIds) {
      this.memory.discardPendingCandidate(candidateId);
    }
    this.distill();
    return this.getSnapshot(zonedDate(deleted.startedAt, this.timeZone));
  }

  startEvent(
    details: ActivityEventDetails,
    actor: ActivityEvent["actor"],
  ): string | undefined {
    if (this.isPaused()) return undefined;
    const now = this.clock.now();
    const id = this.ids.generate();
    this.repository.insertEvent(
      { actor, details: redactEventDetails(details), id, startedAt: now },
      now,
    );
    return id;
  }

  finishEvent(eventId: string): void {
    this.repository.closeEvent(eventId, this.clock.now());
  }

  recordEvent(
    details: ActivityEventDetails,
    actor: ActivityEvent["actor"],
    startedAt = this.clock.now(),
    endedAt = startedAt,
  ): void {
    if (this.isPaused()) return;
    this.repository.insertEvent(
      {
        actor,
        details: redactEventDetails(details),
        endedAt,
        id: this.ids.generate(),
        startedAt,
      },
      this.clock.now(),
    );
  }

  async captureScreenshot(actor: ActivityEvent["actor"]): Promise<void> {
    if (this.isPaused()) return;
    const now = this.clock.now();
    const assetId = this.ids.generate();
    const asset = await this.assets.save(
      assetId,
      await this.capture.capturePrimaryDisplay(),
      now,
    );
    try {
      this.repository.insertScreenshot(
        asset,
        {
          actor,
          details: {
            artifactId: asset.id,
            height: asset.height,
            mediaType: asset.mediaType,
            source: "screenshot",
            storageKey: asset.storageKey,
            width: asset.width,
          },
          endedAt: now,
          id: this.ids.generate(),
          startedAt: now,
        },
        now,
      );
    } catch (error) {
      await this.assets.remove([asset.storageKey]);
      throw error;
    }
  }

  distill(): void {
    const now = this.clock.now();
    const runId = this.ids.generate();
    this.repository.beginDistillation(
      runId,
      new Date(Date.parse(now) - RETAINED_EPISODE_DAYS * DAY_MS).toISOString(),
      now,
      now,
    );
    try {
      this.#flushEpisodes(now);

      const today = zonedDate(now, this.timeZone);
      const pendingDates = new Set(
        this.repository
          .listEpisodesWithoutDailyDigest()
          .map(({ startedAt }) => zonedDate(startedAt, this.timeZone))
          .filter((date) => date < today),
      );
      for (const date of [...pendingDates].sort()) {
        const period = datePeriod(date, this.timeZone);
        const episodes = this.repository.listEpisodes(period.start, period.end);
        if (episodes.length === 0) continue;
        const digest = createDailyDigest(
          episodes,
          this.ids,
          now,
          period.start,
          period.end,
          this.timeZone,
        );
        this.repository.replaceDailyDigest(
          digest,
          new Map(episodes.map((episode) => [episode.id, episode.summary])),
        );
        this.repository.markDistilled(digest.episodeIds, now);
      }

      const currentMonday = mondayOnOrBefore(today);
      const completedWeeks = Math.ceil(RETAINED_EPISODE_DAYS / 7);
      for (let offset = completedWeeks; offset >= 1; offset -= 1) {
        const periodEndDate = addDateDays(currentMonday, -(offset - 1) * 7);
        const periodStartDate = addDateDays(periodEndDate, -7);
        const periodStart = zonedMidnight(periodStartDate, this.timeZone);
        const periodEnd = zonedMidnight(periodEndDate, this.timeZone);
        if (this.repository.hasDigest("weekly", periodStart, periodEnd))
          continue;
        const episodes = this.repository.listEpisodes(periodStart, periodEnd);
        if (episodes.length === 0) continue;
        const draft = createWeeklyDigest(
          episodes,
          this.ids,
          now,
          periodStart,
          periodEnd,
          this.timeZone,
        );
        const candidateIds = draft.proposals
          .filter(({ reason }) => !this.memory.hasCandidateReason(reason))
          .map((proposal) => this.memory.propose(proposal).id);
        const digest = { ...draft.digest, candidateIds };
        this.repository.insertDigest(
          digest,
          new Map(episodes.map((episode) => [episode.id, episode.summary])),
        );
      }
      this.repository.finishDistillation(runId, this.clock.now());
    } catch (error) {
      this.repository.finishDistillation(
        runId,
        this.clock.now(),
        redactText(
          error instanceof Error
            ? error.message
            : "Activity distillation failed",
        ),
      );
      throw error;
    }
  }

  #flushEpisodes(now: Timestamp): void {
    const cutoff = new Date(Date.parse(now) - EPISODE_MERGE_MS).toISOString();
    const pending = this.repository.listUndistilledEvents(cutoff);
    if (pending.length > 0) {
      this.repository.insertEpisodes(distillEpisodes(pending, this.ids, now));
    }
  }

  async #maintain(): Promise<void> {
    const now = this.clock.now();
    this.#flushEpisodes(now);
    const date = zonedDate(now, this.timeZone);
    if (date === this.#lastMaintenanceDate) return;
    this.distill();
    await this.cleanup(false);
    this.#lastMaintenanceDate = date;
  }

  async cleanup(immediate = true): Promise<ActivityCleanupResult> {
    const now = this.clock.now();
    const runId = this.ids.generate();
    this.repository.beginRetention(runId, now);
    try {
      const result = this.repository.cleanup(now, immediate);
      await this.assets.remove(result.storageKeys);
      await this.assets.sweep(this.repository.assetStorageKeys());
      const finishedAt = this.clock.now();
      this.repository.finishRetention(
        runId,
        finishedAt,
        result.deletedAssets,
        result.deletedEvents,
      );
      return {
        deletedAssets: result.deletedAssets,
        deletedEvents: result.deletedEvents,
        finishedAt,
      };
    } catch (error) {
      this.repository.finishRetention(
        runId,
        this.clock.now(),
        0,
        0,
        redactText(
          error instanceof Error ? error.message : "Activity cleanup failed",
        ),
      );
      throw error;
    }
  }
}
