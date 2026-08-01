import type { Static } from "@sinclair/typebox";

import type { FoundationSnapshotSchema } from "../schemas/foundation";

export const FOUNDATION_CHANNELS = {
  getSnapshot: "app.foundation.getSnapshot",
  rendererReady: "app.foundation.rendererReady",
} as const;

export type FoundationSnapshot = Static<typeof FoundationSnapshotSchema>;

export interface FoundationApi {
  getSnapshot(): Promise<FoundationSnapshot>;
  markRendererReady(): void;
}

export interface DesktopApi {
  foundation: FoundationApi;
}
