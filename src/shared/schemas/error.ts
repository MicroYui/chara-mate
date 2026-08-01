import { Type } from "@sinclair/typebox";

import { JsonValueReferenceSchema, NonBlankStringSchema } from "./primitives";

export const AppErrorSchema = Type.Object(
  {
    code: Type.String({ pattern: "^[A-Z][A-Z0-9_]*(?:\\.[A-Z0-9_]+)*$" }),
    details: Type.Optional(JsonValueReferenceSchema),
    message: NonBlankStringSchema,
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);
