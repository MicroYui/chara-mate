import type {
  ActivityDigest,
  ActivityEpisode,
  ActivityEvent,
  ActivitySource,
} from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { IdGenerator } from "../../shared/pure/id";

export const EPISODE_MERGE_MS = 8 * 60 * 1_000;

interface EpisodeDraft {
  readonly actor: ActivityEvent["actor"];
  readonly appNames: Set<string>;
  readonly domains: Set<string>;
  endedAt: Timestamp;
  readonly eventIds: string[];
  readonly screenshotStorageKeys: Set<string>;
  readonly sourceTypes: Set<ActivitySource>;
  startedAt: Timestamp;
  readonly summaryParts: Set<string>;
  title: string;
}

export interface DistilledEpisode {
  readonly episode: ActivityEpisode;
  readonly eventIds: readonly string[];
}

function eventSource(event: ActivityEvent): ActivitySource {
  return event.details.source;
}

function eventSignature(event: ActivityEvent): string {
  const details = event.details;
  if (details.source === "active_app") {
    return `app:${details.appId ?? details.appName}:${details.windowTitle ?? ""}`;
  }
  if (details.source === "managed_browser") return `domain:${details.domain}`;
  if (details.source === "idle") return "idle";
  if (details.source === "agent_run") return "agent:CharaMate";
  return "screenshot";
}

function eventLabel(event: ActivityEvent): string {
  const details = event.details;
  if (details.source === "active_app") return details.appName;
  if (details.source === "managed_browser") return details.domain;
  if (details.source === "idle") return "空闲";
  if (details.source === "agent_run") return "CharaMate Agent";
  return "屏幕记录";
}

function startDraft(event: ActivityEvent): EpisodeDraft {
  return {
    actor: event.actor,
    appNames: new Set(),
    domains: new Set(),
    endedAt: event.endedAt ?? event.startedAt,
    eventIds: [],
    screenshotStorageKeys: new Set(),
    sourceTypes: new Set(),
    startedAt: event.startedAt,
    summaryParts: new Set(),
    title: eventLabel(event),
  };
}

function appendEvent(draft: EpisodeDraft, event: ActivityEvent): void {
  draft.eventIds.push(event.id);
  draft.sourceTypes.add(eventSource(event));
  const details = event.details;
  if (details.source !== "screenshot") {
    const endedAt = event.endedAt ?? event.startedAt;
    if (endedAt > draft.endedAt) draft.endedAt = endedAt;
  }
  if (details.source === "active_app") {
    draft.appNames.add(details.appName);
    if (details.windowTitle) draft.summaryParts.add(details.windowTitle);
  }
  if (details.source === "managed_browser") {
    draft.appNames.add("Managed Chromium");
    draft.domains.add(details.domain);
    if (details.title) draft.summaryParts.add(details.title);
  }
  if (details.source === "screenshot") {
    draft.screenshotStorageKeys.add(details.storageKey);
  }
  if (details.source === "agent_run" && details.summary) {
    draft.summaryParts.add(details.summary);
  }
}

function canMerge(previous: ActivityEvent, next: ActivityEvent): boolean {
  if (!previous.endedAt || !next.endedAt) return false;
  if (previous.actor !== next.actor) return false;
  if (eventSource(previous) === "idle" || eventSource(next) === "idle") {
    return false;
  }
  const gap = Date.parse(next.startedAt) - Date.parse(previous.endedAt);
  return (
    gap >= 0 &&
    gap <= EPISODE_MERGE_MS &&
    eventSignature(previous) === eventSignature(next)
  );
}

function summarize(draft: EpisodeDraft): string {
  const details = [...draft.summaryParts];
  return details.length > 0
    ? `${draft.title}：${details.join("；")}`
    : `${draft.title} 活动`;
}

export function distillEpisodes(
  events: readonly ActivityEvent[],
  ids: IdGenerator,
  now: Timestamp,
): DistilledEpisode[] {
  const primary = [...events]
    .filter(
      ({ details, endedAt }) =>
        details.source !== "screenshot" &&
        details.source !== "managed_browser" &&
        endedAt,
    )
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.id.localeCompare(right.id),
    );
  const screenshots = events.filter(
    ({ details }) => details.source === "screenshot",
  );
  const browserEvents = events.filter(
    ({ details }) => details.source === "managed_browser",
  );
  const drafts: EpisodeDraft[] = [];
  let previous: ActivityEvent | undefined;
  for (const event of primary) {
    let draft = drafts.at(-1);
    if (!draft || !previous || !canMerge(previous, event)) {
      draft = startDraft(event);
      drafts.push(draft);
    }
    appendEvent(draft, event);
    previous = event;
  }

  for (const browser of browserEvents) {
    let target = drafts.find(
      ({ actor, endedAt, startedAt }) =>
        actor === browser.actor &&
        browser.startedAt >= startedAt &&
        browser.startedAt <= endedAt,
    );
    if (!target) {
      target = startDraft(browser);
      drafts.push(target);
    }
    appendEvent(target, browser);
  }

  for (const screenshot of screenshots) {
    let target = drafts.find(
      ({ actor, endedAt, startedAt }) =>
        actor === screenshot.actor &&
        screenshot.startedAt >= startedAt &&
        screenshot.startedAt <= endedAt,
    );
    target ??= drafts
      .filter(
        ({ actor, endedAt, sourceTypes }) =>
          actor === screenshot.actor &&
          sourceTypes.has("managed_browser") &&
          Date.parse(screenshot.startedAt) >= Date.parse(endedAt) &&
          Date.parse(screenshot.startedAt) - Date.parse(endedAt) <=
            EPISODE_MERGE_MS,
      )
      .sort((left, right) => right.endedAt.localeCompare(left.endedAt))[0];
    if (!target) {
      target = startDraft(screenshot);
      drafts.push(target);
    }
    appendEvent(target, screenshot);
  }

  return drafts
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.title.localeCompare(right.title),
    )
    .map((draft) => {
      const episodeId = ids.generate();
      return {
        episode: {
          actor: draft.actor,
          appNames: [...draft.appNames].sort(),
          createdAt: now,
          domains: [...draft.domains].sort(),
          endedAt: draft.endedAt,
          eventCount: draft.eventIds.length,
          id: episodeId,
          screenshotStorageKeys: [...draft.screenshotStorageKeys].sort(),
          sourceTypes: [...draft.sourceTypes].sort(),
          startedAt: draft.startedAt,
          summary: summarize(draft),
          title: draft.title,
          updatedAt: now,
        },
        eventIds: draft.eventIds,
      };
    });
}

function dateKey(timestamp: Timestamp, timeZone: string): string {
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

function episodeLabel(episode: ActivityEpisode): string {
  return episode.domains[0] ?? episode.appNames[0] ?? episode.title;
}

function totalMinutes(episodes: readonly ActivityEpisode[]): number {
  return Math.max(
    1,
    Math.round(
      episodes.reduce(
        (sum, episode) =>
          sum + Date.parse(episode.endedAt) - Date.parse(episode.startedAt),
        0,
      ) / 60_000,
    ),
  );
}

function digestSummary(episodes: readonly ActivityEpisode[]): string {
  const groups = new Map<string, ActivityEpisode[]>();
  for (const episode of episodes) {
    const label = episodeLabel(episode);
    const values = groups.get(label) ?? [];
    values.push(episode);
    groups.set(label, values);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, values]) => `${label} ${totalMinutes(values)} 分钟`)
    .join("；");
}

export function createDailyDigest(
  episodes: readonly ActivityEpisode[],
  ids: IdGenerator,
  now: Timestamp,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  timeZone: string,
): ActivityDigest {
  return {
    candidateIds: [],
    createdAt: now,
    evidenceDays: new Set(
      episodes.map(({ startedAt }) => dateKey(startedAt, timeZone)),
    ).size,
    episodeIds: episodes.map(({ id }) => id),
    id: ids.generate(),
    kind: "daily",
    periodEnd,
    periodStart,
    summary: digestSummary(episodes),
    title: `${dateKey(periodStart, timeZone)} 活动摘要`,
  };
}

export function createWeeklyDigest(
  episodes: readonly ActivityEpisode[],
  ids: IdGenerator,
  now: Timestamp,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  timeZone: string,
): ActivityDigest {
  return {
    candidateIds: [],
    createdAt: now,
    evidenceDays: new Set(
      episodes.map(({ startedAt }) => dateKey(startedAt, timeZone)),
    ).size,
    episodeIds: episodes.map(({ id }) => id),
    id: ids.generate(),
    kind: "weekly",
    periodEnd,
    periodStart,
    summary: digestSummary(episodes),
    title: `${dateKey(periodStart, timeZone)} 起一周趋势`,
  };
}
