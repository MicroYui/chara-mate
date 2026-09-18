import type {
  ActivityCleanupResult,
  ActivityDigest,
  ActivityEpisode,
  ActivityEvent,
  ActivityEventDetails,
  ActivitySnapshot,
  ActivityVisualReference,
  ActivityVisual,
  ActivityEventReference,
  ActivityVisualLookupRequest,
  ActivityVisualLookupResult,
} from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import {
  ActivityEventDetailsSchema,
  ActivityVisualLookupRequestSchema,
} from "../../shared/schemas/activity";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import {
  ActivityVisualEvidence,
  type ActivityVisualFrame,
  type ActivityVisualContext,
  type ActivityVisualResolution,
  type ActivityVisualObservation,
} from "./activityVisualEvidence";
import type { MemoryService } from "../memory/memoryService";
import type { ActivityAssetStore } from "./activityAssetStore";
import {
  createDailyDigest,
  createWeeklyDigest,
  distillEpisodes,
  EPISODE_MERGE_MS,
} from "./activityDistillation";
import {
  searchActivityEpisodes,
  type ActivitySearchRequest,
  type ActivitySearchResult,
} from "./activityRecall";
import { normalizeActivityPerception } from "./activeApplicationSource";
import { ActivityError } from "./activityError";
import type {
  ActivityRepository,
  ActivitySourceRetentionGuard,
} from "./activityRepository";

import type { ActivityVisualChange } from "./activityVisualSource";
import {
  ActivityObserveInputSchema,
  type ActivityObserveInput,
  type ActivityTextObservation,
} from "./activityObservation";

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
      ...normalizeActivityPerception(details),
      ...(details.lifecycle ? { lifecycle: details.lifecycle } : {}),
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
      ...normalizeActivityPerception(details),
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
  #sourceRetentionGuard: ActivitySourceRetentionGuard | undefined;
  readonly #visual: ActivityVisualEvidence;
  #visualChangeListener: ((change: ActivityVisualChange) => void) | undefined;
  #visualSupplier:
    | ((signal?: AbortSignal) => Promise<ActivityVisualFrame | undefined>)
    | undefined;
  #lastMaintenanceDate: string | undefined;
  #maintenanceInterval: ReturnType<typeof setInterval> | undefined;
  #maintenanceTask: Promise<void> | undefined;
  #maintenanceAbort: AbortController | undefined;
  #pauseListeners = new Set<(paused: boolean) => void>();
  #eventListener: ((event: ActivityEvent) => void) | undefined;

  setEventListener(
    listener: ((event: ActivityEvent) => void) | undefined,
  ): void {
    this.#eventListener = listener;
  }
  readonly timeZone: string;

  setSourceRetentionGuard(
    guard: ActivitySourceRetentionGuard | undefined,
  ): void {
    this.#sourceRetentionGuard = guard;
  }

  constructor(
    private readonly repository: ActivityRepository,
    private readonly memory: MemoryService,
    private readonly assets: ActivityAssetStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ) {
    this.timeZone = timeZone;
    this.#visual = new ActivityVisualEvidence(
      repository,
      assets,
      ids,
      clock,
      () => this.isPaused(),
      (event) => this.#eventListener?.(event),
    );
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
      const controller = new AbortController();
      this.#maintenanceAbort = controller;
      const task = this.#maintain(controller.signal);
      this.#maintenanceTask = task;
      void task
        .catch((error) => {
          if (error !== controller.signal.reason) onError(error);
        })
        .finally(() => {
          if (this.#maintenanceTask === task) this.#maintenanceTask = undefined;
          if (this.#maintenanceAbort === controller)
            this.#maintenanceAbort = undefined;
        });
    }, EPISODE_MERGE_MS);
    this.#maintenanceInterval.unref?.();
  }

  async stopMaintenance(): Promise<void> {
    if (this.#maintenanceInterval) clearInterval(this.#maintenanceInterval);
    this.#maintenanceInterval = undefined;
    const controller = this.#maintenanceAbort;
    controller?.abort();
    await this.#maintenanceTask?.catch((error) => {
      if (error !== controller?.signal.reason) throw error;
    });
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

  getDigest(digestId: string): ActivityDigest {
    const digest = this.repository.getDigest(digestId);
    if (!digest) {
      throw new ActivityError(
        "ACTIVITY.DIGEST_NOT_FOUND",
        "找不到这段周期摘要。",
        false,
      );
    }
    return digest;
  }

  search(request: ActivitySearchRequest): ActivitySearchResult {
    const now = this.clock.now();
    const periodEnd = request.periodEnd ?? now;
    const periodStart =
      request.periodStart ??
      new Date(
        Date.parse(periodEnd) - RETAINED_EPISODE_DAYS * DAY_MS,
      ).toISOString();
    if (Date.parse(periodStart) >= Date.parse(periodEnd)) {
      throw new TypeError("Activity search start must be before its end");
    }
    const query = request.query?.trim();
    return {
      observedBehaviorOnly: true,
      patterns: searchActivityEpisodes(
        this.repository.listEpisodes(periodStart, periodEnd),
        query,
        this.timeZone,
      ),
      periodEnd,
      periodStart,
      ...(query ? { query } : {}),
    };
  }

  async observe(
    request: ActivityObserveInput,
    fitsResult: (result: ActivityTextObservation) => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<ActivityTextObservation> {
    signal.throwIfAborted();
    const parsed = parseSchema(
      ActivityObserveInputSchema,
      structuredClone(request),
    );
    if (parsed.latest) {
      const latest = parsed.latest;
      latest.periodEnd = new Date(
        latest.periodEnd ?? this.clock.now(),
      ).toISOString();
      if (latest.periodStart)
        latest.periodStart = new Date(latest.periodStart).toISOString();
      if (latest.before)
        latest.before.startedAt = new Date(
          latest.before.startedAt,
        ).toISOString();
      const query = latest.query?.trim();
      if (query) latest.query = query;
      else delete latest.query;
      if (latest.periodStart && latest.periodStart > latest.periodEnd)
        throw new TypeError(
          "Activity observation start must not follow its end",
        );
    }
    const source = this.repository.readTextObservation(
      parsed,
      16 * 1024 * 1024,
    );
    const offset = parsed.reference?.offset ?? 0;
    const eventId = source?.id ?? parsed.reference?.eventId;
    const base = (
      status: ActivityTextObservation["status"],
    ): ActivityTextObservation => ({
      retainedOnly: true,
      liveScreen: false,
      paused: this.isPaused(),
      status,
      ...(eventId ? { reference: { eventId, offset } } : {}),
    });
    let changed: "missing" | "source_changed" | undefined;
    const changedError = new Error(
      "Retained Activity observation changed during result measurement",
    );
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!source) return;
      const state = this.repository.textObservationState(source);
      if (state !== "same") {
        changed = state === "missing" ? "missing" : "source_changed";
        throw changedError;
      }
    };
    const fits = async (
      result: ActivityTextObservation,
      checkSource = true,
    ) => {
      for (;;) {
        signal.throwIfAborted();
        result.paused = this.isPaused();
        let accepted: boolean;
        try {
          accepted = await fitsResult(result);
        } finally {
          signal.throwIfAborted();
        }
        if (checkSource) assertCurrent();
        // Pausing capture does not forbid retained reads. Measure the actual
        // returned pause state if it changed while the Provider was counting.
        if (result.paused === this.isPaused()) return accepted;
      }
    };
    const finish = async (
      result: ActivityTextObservation,
      checkSource = true,
    ) => {
      if (!(await fits(result, checkSource)))
        throw new RangeError("当前工作集无法容纳活动观察及其覆盖说明");
      return result;
    };
    try {
      if (!source) return await finish(base("missing"));
      const observation: NonNullable<ActivityTextObservation["observation"]> = {
        eventId: source.id,
        source: source.source,
        actor: source.actor,
        observedAt: source.startedAt,
        receivedAt: source.receivedAt,
        position: { startedAt: source.startedAt, eventId: source.id },
      };
      if (source.detailsJson === null)
        return await finish({ ...base("resource_limit"), observation });
      const details = parseSchema(
        ActivityEventDetailsSchema,
        JSON.parse(source.detailsJson),
      );
      if (
        details.source !== "active_app" &&
        details.source !== "managed_browser"
      )
        return await finish({ ...base("unavailable"), observation });
      observation.location = {
        ...(details.source === "active_app"
          ? {
              appName: details.appName,
              ...(details.appId ? { appId: details.appId } : {}),
              ...(details.windowTitle
                ? { windowTitle: details.windowTitle }
                : {}),
            }
          : {
              url: details.url,
              domain: details.domain,
              ...(details.title ? { windowTitle: details.title } : {}),
            }),
        ...(details.surface
          ? {
              surface: { id: details.surface.id, epoch: details.surface.epoch },
            }
          : {}),
      };
      const content = details.content;
      if (
        details.contentStatus === "protected" ||
        details.contentStatus === "unavailable" ||
        !content
      )
        return await finish({
          ...base(
            details.contentStatus === "protected" ? "protected" : "unavailable",
          ),
          observation,
        });
      const text = content.text;
      const segments = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(text);
      const boundary = (position: number) =>
        position === text.length ||
        segments.containing(position)?.index === position;
      if (offset > text.length || !boundary(offset))
        throw new RangeError(
          "Activity reference offset must be a retained UTF-16 character boundary",
        );
      const page = (end: number): ActivityTextObservation => ({
        ...base("available"),
        observation,
        content: {
          source: content.source,
          scope: content.scope,
          captureTruncated: content.truncated ? "reported" : "unknown",
          text: text.slice(offset, end),
          coverage: {
            offsetUnit: "utf16_code_unit",
            start: offset,
            end,
            total: text.length,
            storedTextComplete: offset === 0 && end === text.length,
          },
        },
        ...(end < text.length
          ? { next: { eventId: source.id, offset: end } }
          : {}),
      });
      const full = page(text.length);
      if (await fits(full)) return full;
      const unavailable = { ...base("input_limit"), observation };
      await finish(unavailable);
      let low = offset;
      let high = text.length - 1;
      let best: ActivityTextObservation | undefined;
      while (low < high) {
        let end = Math.ceil((low + high) / 2);
        if (!boundary(end)) end = segments.containing(end)!.index;
        if (end <= low) {
          const next = segments.containing(low)!;
          end = next.index + next.segment.length;
          if (end > high) break;
        }
        const candidate = page(end);
        if (await fits(candidate)) {
          best = candidate;
          low = end;
        } else high = end - 1;
      }
      // The final accepted object is measured again because intervening counts
      // can change the live request capacity and the paused projection.
      return await finish(best ?? unavailable);
    } catch (error) {
      if (error !== changedError || !changed) throw error;
      return finish(base(changed), false);
    }
  }

  setPaused(paused: boolean): ActivitySnapshot {
    const now = this.clock.now();
    this.repository.setPaused(paused, now);
    if (paused) this.#visual.setContext(undefined);
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
    return this.#visual.serializeAssets(async () => {
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
    });
  }

  startEvent(
    details: ActivityEventDetails,
    actor: ActivityEvent["actor"],
    startedAt = this.clock.now(),
  ): string | undefined {
    if (this.isPaused()) return undefined;
    const now = this.clock.now();
    const id = this.ids.generate();
    const event: ActivityEvent = {
      actor,
      details: redactEventDetails(details),
      id,
      startedAt,
    };
    this.repository.insertEvent(event, now);
    this.#eventListener?.(event);
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
  ): string | undefined {
    if (this.isPaused()) return;
    const id = this.ids.generate();
    const event: ActivityEvent = {
      actor,
      details: redactEventDetails(details),
      endedAt,
      id,
      startedAt,
    };
    this.repository.insertEvent(event, this.clock.now());
    this.#eventListener?.(event);
    return id;
  }

  getEvent(eventId: string): ActivityEvent | undefined {
    return this.repository.getEvent(eventId);
  }

  getEventSourceReference(
    eventId: string,
  ): Pick<ActivityEvent, "id" | "actor" | "startedAt"> | undefined {
    return this.repository.getEventSourceReference(eventId);
  }

  resolveEventReference(eventId: string): ActivityEventReference {
    const reference = this.repository.resolveEventReference(eventId);
    const event = this.repository.getEvent(eventId);
    if (!reference || !event)
      throw new ActivityError(
        "ACTIVITY.EVENT_NOT_FOUND",
        "这条原始活动已清理或不存在。",
        false,
      );
    return {
      event,
      date: zonedDate(reference.startedAt, this.timeZone),
      ...(reference.episodeId ? { episodeId: reference.episodeId } : {}),
    };
  }

  setVisualContext(context: ActivityVisualContext | undefined): void {
    this.#visual.setContext(context);
  }

  isCurrentVisualSource(
    source: Pick<ActivityVisualContext, "surface" | "actor">,
  ): boolean {
    return this.#visual.matchesSource(source.surface, source.actor);
  }

  stageVisualFrame(frame: ActivityVisualFrame): boolean {
    return this.#visual.stage(frame);
  }

  setVisualChangeListener(
    listener: ((change: ActivityVisualChange) => void) | undefined,
  ): void {
    this.#visualChangeListener = listener;
  }

  notifyVisualChanged(change: ActivityVisualChange): void {
    if (this.#visual.matchesSource(change.surface, change.actor))
      this.#visualChangeListener?.(change);
  }

  setVisualFrameSupplier(
    supplier:
      | ((signal?: AbortSignal) => Promise<ActivityVisualFrame | undefined>)
      | undefined,
  ): void {
    this.#visualSupplier = supplier;
  }

  async consumeLatestVisualEvidence(
    signal?: AbortSignal,
  ): Promise<ActivityVisualObservation | undefined> {
    if (this.isPaused()) return undefined;
    const frame = await this.#visualSupplier?.(signal);
    if (frame) this.#visual.stage(frame);
    return this.#visual.consume("frame", signal);
  }

  recordVisualFrame(
    frame: ActivityVisualFrame,
    trigger: ActivityVisual["trigger"],
    signal?: AbortSignal,
  ): Promise<ActivityVisualObservation | undefined> {
    if (!this.#visual.stage(frame)) return Promise.resolve(undefined);
    return this.#visual.consume(trigger, signal, true);
  }

  resolveVisualEvidence(
    reference: ActivityVisualReference,
    signal?: AbortSignal,
  ): Promise<ActivityVisualResolution> {
    return this.#visual.resolve(reference, signal);
  }

  async lookupVisualEvidence(
    request: ActivityVisualLookupRequest,
    resourceBudget: { readonly maxReadBytes: number },
    signal?: AbortSignal,
  ): Promise<ActivityVisualLookupResult> {
    signal?.throwIfAborted();
    const parsed = parseSchema(ActivityVisualLookupRequestSchema, request);
    const query = parsed.query?.trim();
    const effective = {
      ...structuredClone(parsed),
      periodEnd: new Date(parsed.periodEnd ?? this.clock.now()).toISOString(),
    };
    if (parsed.periodStart)
      effective.periodStart = new Date(parsed.periodStart).toISOString();
    if (query) effective.query = query;
    else delete effective.query;
    if (
      effective.periodStart &&
      Date.parse(effective.periodStart) > Date.parse(effective.periodEnd)
    )
      throw new TypeError("Visual lookup start must not follow its end");
    const result = await this.repository.lookupVisualEvidence(
      effective,
      resourceBudget,
      signal,
    );
    signal?.throwIfAborted();
    return result;
  }

  stopVisualCapture(): Promise<void> {
    return this.#visual.clear();
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
        const digest = createWeeklyDigest(
          episodes,
          this.ids,
          now,
          periodStart,
          periodEnd,
          this.timeZone,
        );
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

  async #maintain(signal?: AbortSignal): Promise<void> {
    const now = this.clock.now();
    this.#flushEpisodes(now);
    const date = zonedDate(now, this.timeZone);
    if (date === this.#lastMaintenanceDate) return;
    this.distill();
    await this.cleanup(false, signal);
    this.#lastMaintenanceDate = date;
  }

  async cleanup(
    immediate = true,
    signal?: AbortSignal,
  ): Promise<ActivityCleanupResult> {
    return this.#visual.serializeAssets(async () => {
      const now = this.clock.now();
      const runId = this.ids.generate();
      this.repository.beginRetention(runId, now);
      try {
        const result = await this.repository.cleanup(
          now,
          immediate,
          this.#sourceRetentionGuard
            ? (ids) => this.#sourceRetentionGuard?.(ids) ?? new Set(ids)
            : undefined,
          runId,
          signal,
        );
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
        const progress = this.repository.retentionProgress(runId);
        let failure = error;
        try {
          await this.assets.sweep(this.repository.assetStorageKeys());
        } catch (assetError) {
          failure = new AggregateError(
            [error, assetError],
            `${error instanceof Error ? error.message : "Activity cleanup failed"}; ${assetError instanceof Error ? assetError.message : "Activity asset cleanup failed"}`,
          );
        }
        this.repository.finishRetention(
          runId,
          this.clock.now(),
          progress.deletedAssets,
          progress.deletedEvents,
          redactText(
            failure instanceof Error
              ? failure.message
              : "Activity cleanup failed",
          ),
        );
        throw failure;
      }
    });
  }
}
