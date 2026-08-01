import type { Static } from "@sinclair/typebox";

import type {
  ProviderApiStyleSchema,
  ProviderSnapshotSchema,
} from "../schemas/provider";

export type ProviderApiStyle = Static<typeof ProviderApiStyleSchema>;
export type ProviderSnapshot = Static<typeof ProviderSnapshotSchema>;
