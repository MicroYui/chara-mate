import type { Static } from "@sinclair/typebox";

import type {
  EntityIdSchema,
  JsonValueSchema,
  TimestampSchema,
} from "../schemas/primitives";

export type EntityId = Static<typeof EntityIdSchema>;
export type Timestamp = Static<typeof TimestampSchema>;
export type JsonValue = Static<typeof JsonValueSchema>;
