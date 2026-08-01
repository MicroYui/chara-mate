import { Type } from "@sinclair/typebox";

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const UTC_TIMESTAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$";

export const EntityIdSchema = Type.String({ pattern: UUID_PATTERN });

export const TimestampSchema = Type.String({
  pattern: UTC_TIMESTAMP_PATTERN,
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
