export interface ModelTimeContext {
  readonly now: string;
  readonly timeZone: string | null;
  readonly localDateTime: string | null;
}

function systemTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** A model-step calendar anchor, never a source's historical location or time zone. */
export function modelTimeContext(
  now = new Date().toISOString(),
  timeZone: string | null = systemTimeZone(),
): ModelTimeContext {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime()))
    throw new RangeError("Model time context requires a valid timestamp");
  if (!timeZone) return { now, timeZone: null, localDateTime: null };
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    return {
      now,
      timeZone: formatter.resolvedOptions().timeZone,
      localDateTime: `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}.${parts["fractionalSecond"]}`,
    };
  } catch {
    return { now, timeZone: null, localDateTime: null };
  }
}

export const MODEL_TIME_INSTRUCTIONS =
  "timeContext is this model step's current calendar anchor, not a user statement or historical source evidence. Interpret current relative dates such as today in that time zone when known. For an older source, relative wording belongs to its recorded occurrence, never the later processing date. The current system time zone does not establish the source author's historical location or time zone. Use an explicitly recorded source/event time zone when supplied; otherwise preserve uncertain local-calendar wording and unknown UTC bounds. Comparing ISO UTC date portions alone does not establish a local midnight crossing.";

export function modelTimeInstructions(context: ModelTimeContext): string {
  return `Current timestamp: ${context.now}. User system time zone: ${context.timeZone ?? "unknown"}. Current local date and time: ${context.localDateTime ?? "unknown"}.\n${MODEL_TIME_INSTRUCTIONS}`;
}
