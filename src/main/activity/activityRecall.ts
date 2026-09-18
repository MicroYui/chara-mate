import type { ActivityEpisode } from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import { memorySearchTokens } from "../memory/memorySearchText";

export const ACTIVITY_SEARCH_LIMIT = 8;

export interface ActivitySearchRequest {
  readonly periodEnd?: Timestamp;
  readonly periodStart?: Timestamp;
  readonly query?: string;
}

export interface ActivitySearchResult {
  readonly observedBehaviorOnly: true;
  readonly patterns: readonly ActivitySearchPattern[];
  readonly periodEnd: Timestamp;
  readonly periodStart: Timestamp;
  readonly query?: string;
}

export interface ActivitySearchPattern {
  readonly actor: "user" | "unknown";
  readonly activeDays: number;
  readonly episodeCount: number;
  readonly firstSeenAt: Timestamp;
  readonly kind: "app" | "domain";
  readonly label: string;
  readonly lastSeenAt: Timestamp;
  readonly totalMinutes: number;
}

interface ActivityAggregate {
  actor: "user" | "unknown";
  activeDates: Set<string>;
  episodeCount: number;
  firstSeenAt: Timestamp;
  kind: ActivitySearchPattern["kind"];
  label: string;
  lastSeenAt: Timestamp;
  searchTokens: Set<string>;
  totalMilliseconds: number;
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

function normalizedLabel(label: string): string {
  return label.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function episodeIdentity(episode: ActivityEpisode):
  | {
      actor: "user" | "unknown";
      kind: ActivitySearchPattern["kind"];
      label: string;
    }
  | undefined {
  if (episode.actor !== "user" && episode.actor !== "unknown") return undefined;
  if (episode.domains[0]) {
    return { actor: episode.actor, kind: "domain", label: episode.domains[0] };
  }
  if (
    episode.appNames[0] &&
    episode.sourceTypes.some(
      (source) => source === "active_app" || source === "managed_browser",
    )
  ) {
    return { actor: episode.actor, kind: "app", label: episode.appNames[0] };
  }
  return undefined;
}

function episodeMilliseconds(episode: ActivityEpisode): number {
  return Math.max(
    0,
    Date.parse(episode.endedAt) - Date.parse(episode.startedAt),
  );
}

function roundedMinutes(milliseconds: number): number {
  return Math.max(1, Math.round(milliseconds / 60_000));
}

function addSearchTokens(target: Set<string>, text: string): void {
  for (const token of memorySearchTokens(
    text.replaceAll(/[^\p{L}\p{N}]+/gu, " "),
  )) {
    target.add(token);
  }
}

export function searchActivityEpisodes(
  episodes: readonly ActivityEpisode[],
  query: string | undefined,
  timeZone: string,
  limit = ACTIVITY_SEARCH_LIMIT,
): ActivitySearchPattern[] {
  const aggregates = new Map<string, ActivityAggregate>();
  for (const episode of episodes) {
    const identity = episodeIdentity(episode);
    if (!identity) continue;
    const key = `${episode.actor}:${identity.kind}:${normalizedLabel(identity.label)}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        actor: identity.actor,
        activeDates: new Set(),
        episodeCount: 0,
        firstSeenAt: episode.startedAt,
        kind: identity.kind,
        label: identity.label,
        lastSeenAt: episode.endedAt,
        searchTokens: new Set(),
        totalMilliseconds: 0,
      };
      aggregates.set(key, aggregate);
    }
    aggregate.activeDates.add(dateKey(episode.startedAt, timeZone));
    aggregate.episodeCount += 1;
    aggregate.totalMilliseconds += episodeMilliseconds(episode);
    if (episode.startedAt < aggregate.firstSeenAt) {
      aggregate.firstSeenAt = episode.startedAt;
    }
    if (episode.endedAt > aggregate.lastSeenAt) {
      aggregate.lastSeenAt = episode.endedAt;
    }
    addSearchTokens(
      aggregate.searchTokens,
      [identity.label, episode.title, episode.summary].join(" "),
    );
  }

  const queryTokens = memorySearchTokens(query?.trim() ?? "");
  return [...aggregates.values()]
    .map((aggregate) => ({
      actor: aggregate.actor,
      aggregate,
      score: queryTokens.reduce(
        (score, token) => score + (aggregate.searchTokens.has(token) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ score }) => queryTokens.length === 0 || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.aggregate.totalMilliseconds - left.aggregate.totalMilliseconds ||
        right.aggregate.activeDates.size - left.aggregate.activeDates.size ||
        left.aggregate.label.localeCompare(right.aggregate.label),
    )
    .slice(0, limit)
    .map(({ aggregate }) => ({
      actor: aggregate.actor,
      activeDays: aggregate.activeDates.size,
      episodeCount: aggregate.episodeCount,
      firstSeenAt: aggregate.firstSeenAt,
      kind: aggregate.kind,
      label: aggregate.label,
      lastSeenAt: aggregate.lastSeenAt,
      totalMinutes: roundedMinutes(aggregate.totalMilliseconds),
    }));
}
