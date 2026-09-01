import type {
  CompanionInitiativeLevel,
  CompanionInitiativeSettings,
} from "../../shared/contracts/settings";
import type { Timestamp } from "../../shared/contracts/primitives";
import type { CompanionInitiativeRecord } from "./companionInitiativeRepository";

const MINUTE_MS = 60_000;

export const COMPANION_INITIATIVE_ABSOLUTE_FLOOR_MS = 5 * MINUTE_MS;

export const COMPANION_INITIATIVE_LEVEL_INTERVAL_MS = {
  balanced: 60 * MINUTE_MS,
  lively: 15 * MINUTE_MS,
  quiet: 240 * MINUTE_MS,
} as const satisfies Record<Exclude<CompanionInitiativeLevel, "off">, number>;

export type CompanionInitiativePolicyReason =
  "eligible" | "level_off" | "minimum_interval" | "quiet_hours";

export interface CompanionInitiativePolicyDecision {
  readonly eligible: boolean;
  readonly reason: CompanionInitiativePolicyReason;
}

export interface CompanionInitiativePolicyReader {
  getCompanionInitiative(): CompanionInitiativeSettings;
}

export function stepDownCompanionInitiativeLevel(
  level: CompanionInitiativeLevel,
): CompanionInitiativeLevel {
  if (level === "lively") return "balanced";
  if (level === "balanced") return "quiet";
  return level;
}

function isQuietMinute(
  minuteOfDay: number,
  settings: CompanionInitiativeSettings,
): boolean {
  const { endMinute, startMinute } = settings.quietHours;
  if (!settings.quietHours.enabled) return false;
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function latestRecords(
  records: readonly CompanionInitiativeRecord[],
): readonly CompanionInitiativeRecord[] {
  return [...records]
    .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt))
    .slice(0, 3);
}

function consecutiveNegativeCount(
  records: readonly CompanionInitiativeRecord[],
): number {
  let count = 0;
  for (const record of latestRecords(records)) {
    if (record.outcome === "dismissed" || record.outcome === "expired") {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

export function evaluateCompanionInitiativePolicy(input: {
  readonly localMinuteOfDay: number;
  readonly now: Timestamp;
  readonly recentInitiatives: readonly CompanionInitiativeRecord[];
  readonly settings: CompanionInitiativeSettings;
}): CompanionInitiativePolicyDecision {
  if (input.settings.level === "off") {
    return { eligible: false, reason: "level_off" };
  }
  if (isQuietMinute(input.localMinuteOfDay, input.settings)) {
    return { eligible: false, reason: "quiet_hours" };
  }
  const latest = latestRecords(input.recentInitiatives)[0];
  if (!latest) return { eligible: true, reason: "eligible" };
  const acceptedAtMs = Date.parse(latest.acceptedAt);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(acceptedAtMs) || !Number.isFinite(nowMs)) {
    return { eligible: false, reason: "minimum_interval" };
  }
  const requiredInterval = Math.max(
    COMPANION_INITIATIVE_ABSOLUTE_FLOOR_MS,
    COMPANION_INITIATIVE_LEVEL_INTERVAL_MS[input.settings.level] *
      (1 + consecutiveNegativeCount(input.recentInitiatives)),
  );
  return nowMs - acceptedAtMs < requiredInterval
    ? { eligible: false, reason: "minimum_interval" }
    : { eligible: true, reason: "eligible" };
}

export function localMinuteOfDay(timestamp: Timestamp): number {
  const date = new Date(timestamp);
  return date.getHours() * 60 + date.getMinutes();
}
