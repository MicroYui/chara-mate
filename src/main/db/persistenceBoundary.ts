import { redactBoundaryValue } from "../../shared/pure/redaction";

export function serializeForPersistence(value: unknown): string {
  const serialized = JSON.stringify(redactBoundaryValue(value));
  if (serialized === undefined) {
    throw new TypeError("Persistence boundary requires a serializable value");
  }
  return serialized;
}
