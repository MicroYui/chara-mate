import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { JsonValueSchema } from "./primitives";

export function parseSchemaWithoutCodeGeneration<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  const references = schema === JsonValueSchema ? [] : [JsonValueSchema];
  if (!Value.Check(schema, references, value)) {
    const firstError = Value.Errors(schema, references, value).First();
    throw new Error(
      `Schema ${schema.$id ?? "<anonymous>"} rejected value${firstError ? ` at ${firstError.path}: ${firstError.message}` : ""}`,
    );
  }

  return value;
}
