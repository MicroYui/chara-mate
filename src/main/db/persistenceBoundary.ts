import type { Static, TSchema } from "@sinclair/typebox";

import { redactBoundaryValue } from "../../shared/pure/redaction";
import { parseSchema } from "../../shared/schemas/validation";

export function serializeForPersistence(value: unknown): string {
  const serialized = JSON.stringify(redactBoundaryValue(value));
  if (serialized === undefined) {
    throw new TypeError("Persistence boundary requires a serializable value");
  }
  return serialized;
}

export function sanitizeForPersistence<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  return parseSchema(schema, JSON.parse(serializeForPersistence(value)));
}
