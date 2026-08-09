import { FormatRegistry, Type } from "@sinclair/typebox";

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const UTC_TIMESTAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$";
export const UTC_TIMESTAMP_FORMAT = "charamate-utc-timestamp";
export const CALENDAR_DATE_FORMAT = "date";

const utcTimestampPattern = new RegExp(UTC_TIMESTAMP_PATTERN, "u");

export function isUtcTimestamp(value: string): boolean {
  if (!utcTimestampPattern.test(value)) {
    return false;
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return false;
  }

  const canonicalValue = value.includes(".")
    ? value
    : value.replace(/Z$/u, ".000Z");
  return new Date(milliseconds).toISOString() === canonicalValue;
}

export function isCalendarDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") {
    return false;
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

if (!FormatRegistry.Has(UTC_TIMESTAMP_FORMAT)) {
  FormatRegistry.Set(UTC_TIMESTAMP_FORMAT, isUtcTimestamp);
}
if (!FormatRegistry.Has(CALENDAR_DATE_FORMAT)) {
  FormatRegistry.Set(CALENDAR_DATE_FORMAT, isCalendarDate);
}

export const EntityIdSchema = Type.String({ pattern: UUID_PATTERN });

export const TimestampSchema = Type.String({
  format: UTC_TIMESTAMP_FORMAT,
  pattern: UTC_TIMESTAMP_PATTERN,
});

export const CalendarDateSchema = Type.String({
  format: CALENDAR_DATE_FORMAT,
});

export const SequenceSchema = Type.Integer({ minimum: 1 });

export const JsonValueSchema = Type.Recursive(
  (JsonValue) =>
    Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(JsonValue),
      Type.Record(Type.String(), JsonValue),
    ]),
  { $id: "JsonValue" },
);

export const JsonValueReferenceSchema = Type.Ref(JsonValueSchema);

export const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const NonBlankStringSchema = Type.String({
  minLength: 1,
  pattern: "\\S",
});
