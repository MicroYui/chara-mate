import Ajv from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});
const validators = new WeakMap<TSchema, ReturnType<typeof ajv.compile>>();

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
