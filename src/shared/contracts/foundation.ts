import type { Static } from "@sinclair/typebox";

import type { FoundationSnapshotSchema } from "../schemas/foundation";
import type { AgentApi } from "./agent";
import type { ActivityApi } from "./activity";
import type { AutomationApi } from "./automation";
import type { ChatApi } from "./chat";
import type { ExtensionsApi } from "./extensions";
import type { EvolutionApi } from "./evolution";
import type { LocalFilesApi } from "./files";
import type { RunEventsApi } from "./ipc";
import type { SettingsApi } from "./settings";
import type { PetManagementApi } from "./pet";
import type { PersonaApi } from "./persona";
import type { ProviderApi } from "./provider";
import type { TerritoryWorldApi } from "./territoryWorld";
import type { MemoryApi } from "./memory";
import type { JourneyApi } from "./journey";
import type { VoiceApi } from "./voice";
import type { VoiceWakeSettingsApi } from "./voiceWake";

export const FOUNDATION_CHANNELS = {
  getSnapshot: "app.foundation.getSnapshot",
  rendererReady: "app.foundation.rendererReady",
} as const;

export type FoundationSnapshot = Static<typeof FoundationSnapshotSchema>;

export interface FoundationApi {
  getSnapshot(): Promise<FoundationSnapshot>;
  markRendererReady(): void;
}

export interface ClipboardApi {
  writeText(value: string): Promise<void>;
}

export interface DesktopApi {
  activity: ActivityApi;
  automations: AutomationApi;
  clipboard: ClipboardApi;
  evolution: EvolutionApi;
  files: LocalFilesApi;
  foundation: FoundationApi;
  journey: JourneyApi;
  memory: MemoryApi;
  persona: PersonaApi;
  pet: PetManagementApi;
  provider: ProviderApi;
  settings: SettingsApi;
  territory: TerritoryWorldApi;
  voice: VoiceApi;
  voiceWake: VoiceWakeSettingsApi;
}

export interface CharaMateApi extends DesktopApi {
  agent: AgentApi;
  chat: ChatApi;
  extensions: ExtensionsApi;
  runEvents: RunEventsApi;
}
