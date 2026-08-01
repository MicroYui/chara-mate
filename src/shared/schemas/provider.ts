import { Type } from "@sinclair/typebox";

import { EntityIdSchema, NonBlankStringSchema } from "./primitives";

export const ProviderApiStyleSchema = Type.Union([
  Type.Literal("openai-compatible"),
  Type.Literal("azure-openai"),
]);

export const ProviderSnapshotSchema = Type.Object(
  {
    apiStyle: ProviderApiStyleSchema,
    modelId: NonBlankStringSchema,
    profileId: EntityIdSchema,
    profileName: NonBlankStringSchema,
  },
  { additionalProperties: false },
);
