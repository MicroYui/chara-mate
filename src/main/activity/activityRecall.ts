import type {
  ActivityDigest,
  ActivityEpisode,
} from "../../shared/contracts/activity";
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
  readonly activeDays: number;
  readonly episodeCount: number;
  readonly firstSeenAt: Timestamp;
  readonly kind: "app" | "domain";
  readonly label: string;
  readonly lastSeenAt: Timestamp;
  readonly totalMinutes: number;
}

export interface StableActivityPattern {
  readonly content: string;
  readonly label: string;
  readonly legacyReason: string;
  readonly reason: string;
  readonly sourceIds: readonly string[];
  readonly sourceLabels: readonly string[];
  readonly validFrom: Timestamp;
}

interface ActivityAggregate {
  activeDates: Set<string>;
  episodeCount: number;
  firstSeenAt: Timestamp;
  kind: ActivitySearchPattern["kind"];
  label: string;
  lastSeenAt: Timestamp;
  searchTokens: Set<string>;
  totalMilliseconds: number;
}

interface WeeklyObservation {
  readonly activeDays: number;
  readonly digest: ActivityDigest;
  readonly firstSeenAt: Timestamp;
  readonly label: string;
  readonly totalMinutes: number;
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

function episodeIdentity(
  episode: ActivityEpisode,
): { kind: ActivitySearchPattern["kind"]; label: string } | undefined {
  if (episode.actor !== "user") return undefined;
  if (episode.domains[0]) {
    return { kind: "domain", label: episode.domains[0] };
  }
  if (
    episode.appNames[0] &&
    episode.sourceTypes.some(
      (source) => source === "active_app" || source === "managed_browser",
    )
  ) {
    return { kind: "app", label: episode.appNames[0] };
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
    const key = `${identity.kind}:${normalizedLabel(identity.label)}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
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
      activeDays: aggregate.activeDates.size,
      episodeCount: aggregate.episodeCount,
      firstSeenAt: aggregate.firstSeenAt,
      kind: aggregate.kind,
      label: aggregate.label,
      lastSeenAt: aggregate.lastSeenAt,
      totalMinutes: roundedMinutes(aggregate.totalMilliseconds),
    }));
}

export function stableActivityPatternReason(label: string): string {
  return `Activity 跨周稳定行为候选：${label}`;
}

export function legacyActivityPatternReason(label: string): string {
  return `Activity 跨日证据归纳：${label}`;
}

export function buildStableActivityPatterns(
  weeklyDigests: readonly ActivityDigest[],
  episodes: readonly ActivityEpisode[],
  timeZone: string,
): StableActivityPattern[] {
  const episodesById = new Map(
    episodes.map((episode) => [episode.id, episode]),
  );
  const observations = new Map<string, WeeklyObservation[]>();

  for (const digest of weeklyDigests
    .filter(({ kind }) => kind === "weekly")
    .sort(
      (left, right) =>
        left.periodStart.localeCompare(right.periodStart) ||
        left.id.localeCompare(right.id),
    )) {
    const grouped = new Map<
      string,
      {
        dates: Set<string>;
        firstSeenAt: Timestamp;
        label: string;
        totalMilliseconds: number;
      }
    >();
    for (const episodeId of digest.episodeIds) {
      const episode = episodesById.get(episodeId);
      if (!episode) continue;
      const identity = episodeIdentity(episode);
      if (!identity) continue;
      const key = `${identity.kind}:${normalizedLabel(identity.label)}`;
      let group = grouped.get(key);
      if (!group) {
        group = {
          dates: new Set(),
          firstSeenAt: episode.startedAt,
          label: identity.label,
          totalMilliseconds: 0,
        };
        grouped.set(key, group);
      }
      group.dates.add(dateKey(episode.startedAt, timeZone));
      group.totalMilliseconds += episodeMilliseconds(episode);
      if (episode.startedAt < group.firstSeenAt) {
        group.firstSeenAt = episode.startedAt;
      }
    }
    for (const [key, group] of grouped) {
      const values = observations.get(key) ?? [];
      values.push({
        activeDays: group.dates.size,
        digest,
        firstSeenAt: group.firstSeenAt,
        label: group.label,
        totalMinutes: roundedMinutes(group.totalMilliseconds),
      });
      observations.set(key, values);
    }
  }

  return [...observations.values()]
    .filter((values) => values.length >= 2)
    .map((values): StableActivityPattern => {
      const selected = values.slice(-2);
      const label = selected.at(-1)!.label;
      return {
        content: `用户在多个自然周持续使用 ${label}。这是观察到的使用习惯，不等同于用户明确表达的偏好。`,
        label,
        legacyReason: legacyActivityPatternReason(label),
        reason: stableActivityPatternReason(label),
        sourceIds: selected.map(({ digest }) => digest.id),
        sourceLabels: selected.map(
          ({ activeDays, digest, totalMinutes }) =>
            `${digest.title}：${String(activeDays)} 天，${String(totalMinutes)} 分钟`,
        ),
        validFrom: selected[0]!.firstSeenAt,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}
