import Ajv from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";

import { JsonValueSchema } from "./primitives";

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});
ajv.addSchema(JsonValueSchema);
const validators = new WeakMap<TSchema, ReturnType<typeof ajv.compile>>();
const jsonValueValidator = ajv.getSchema(JsonValueSchema.$id ?? "");
if (!jsonValueValidator) {
  throw new Error("JsonValue schema was not registered");
}
validators.set(JsonValueSchema, jsonValueValidator);

export function parseSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  const validate = validators.get(schema) ?? ajv.compile(schema);
  validators.set(schema, validate);

  if (!validate(value)) {
    throw new Error(
      `Schema ${schema.$id ?? "<anonymous>"} rejected value: ${ajv.errorsText(validate.errors)}`,
    );
  }

  return value;
}
