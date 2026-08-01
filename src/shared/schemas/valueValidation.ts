import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function parseSchemaWithoutCodeGeneration<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  if (!Value.Check(schema, value)) {
    const firstError = Value.Errors(schema, value).First();
    throw new Error(
      `Schema ${schema.$id ?? "<anonymous>"} rejected value${firstError ? ` at ${firstError.path}: ${firstError.message}` : ""}`,
    );
  }

  return value;
}
