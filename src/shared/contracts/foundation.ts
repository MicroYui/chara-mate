import type { Static } from "@sinclair/typebox";

import type { FoundationSnapshotSchema } from "../schemas/foundation";
import type { ChatApi } from "./chat";
import type { RunEventsApi } from "./ipc";
import type { PetManagementApi } from "./pet";
import type { ProviderApi } from "./provider";

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
  pet: PetManagementApi;
  provider: ProviderApi;
}

export interface CharaMateApi extends DesktopApi {
  chat: ChatApi;
  runEvents: RunEventsApi;
}
