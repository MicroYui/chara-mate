import type { Static } from "@sinclair/typebox";

import type {
  AgentSettingsSaveRequestSchema,
  AgentSettingsSaveResponseSchema,
  AgentSettingsSchema,
  BrowserActionResponseSchema,
  BrowserComputerSettingsSchema,
  SettingsSnapshotResponseSchema,
  SettingsSnapshotSchema,
  VoiceSettingsConfigSchema,
  VoiceSettingsSaveRequestSchema,
  VoiceSettingsSaveResponseSchema,
  VoiceSettingsSchema,
} from "../schemas/settings";

export const SETTINGS_CHANNELS = {
  getSnapshot: "settings.getSnapshot",
  importBrowserCookies: "settings.browser.importCookies",
  openManagedBrowser: "settings.browser.open",
  saveAgent: "settings.agent.save",
  saveVoice: "settings.voice.save",
} as const;

export type AgentSettings = Static<typeof AgentSettingsSchema>;
export type BrowserComputerSettings = Static<
  typeof BrowserComputerSettingsSchema
>;
export type SettingsSnapshot = Static<typeof SettingsSnapshotSchema>;
export type VoiceSettingsConfig = Static<typeof VoiceSettingsConfigSchema>;
export type VoiceSettings = Static<typeof VoiceSettingsSchema>;
export type AgentSettingsSaveRequest = Static<
  typeof AgentSettingsSaveRequestSchema
>;
export type AgentSettingsSaveResponse = Static<
  typeof AgentSettingsSaveResponseSchema
>;
export type SettingsSnapshotResponse = Static<
  typeof SettingsSnapshotResponseSchema
>;
export type BrowserActionResponse = Static<typeof BrowserActionResponseSchema>;
export type VoiceSettingsSaveRequest = Static<
  typeof VoiceSettingsSaveRequestSchema
>;
export type VoiceSettingsSaveResponse = Static<
  typeof VoiceSettingsSaveResponseSchema
>;

export interface SettingsApi {
  getSnapshot(): Promise<SettingsSnapshotResponse>;
  importBrowserCookies(): Promise<BrowserActionResponse>;
  openManagedBrowser(): Promise<BrowserActionResponse>;
  saveAgent(
    request: AgentSettingsSaveRequest,
  ): Promise<AgentSettingsSaveResponse>;
  saveVoice(
    request: VoiceSettingsSaveRequest,
  ): Promise<VoiceSettingsSaveResponse>;
}
