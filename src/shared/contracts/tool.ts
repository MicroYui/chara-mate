import type { Static } from "@sinclair/typebox";

import type {
  ToolDescriptorSchema,
  ToolEffectSchema,
  ToolIdempotencySchema,
  ToolResultSchema,
  ToolResultStatusSchema,
  ToolSourceSchema,
} from "../schemas/tool";

export type ToolSource = Static<typeof ToolSourceSchema>;
export type ToolEffect = Static<typeof ToolEffectSchema>;
export type ToolIdempotency = Static<typeof ToolIdempotencySchema>;
export type ToolDescriptor = Static<typeof ToolDescriptorSchema>;
export type ToolResultStatus = Static<typeof ToolResultStatusSchema>;
export type ToolResult = Static<typeof ToolResultSchema>;
