import type { Static } from "@sinclair/typebox";

import type {
  AgentSettingsSaveRequestSchema,
  AgentSettingsSaveResponseSchema,
  AgentSettingsSchema,
  BrowserActionResponseSchema,
  BrowserComputerSettingsSchema,
  CompanionInitiativeLevelSchema,
  CompanionInitiativeSettingsSaveRequestSchema,
  CompanionInitiativeSettingsSaveResponseSchema,
  CompanionInitiativeSettingsSchema,
  DataActionResponseSchema,
  DataSettingsSnapshotResponseSchema,
  DataSettingsSnapshotSchema,
  DataUsageCategoryIdSchema,
  DataUsageCategorySchema,
  SettingsSnapshotResponseSchema,
  SettingsSnapshotSchema,
  VoiceSettingsConfigSchema,
  VoiceSettingsSaveRequestSchema,
  VoiceSettingsSaveResponseSchema,
  VoiceSettingsSchema,
} from "../schemas/settings";

export const SETTINGS_CHANNELS = {
  getDataSnapshot: "settings.data.getSnapshot",
  getSnapshot: "settings.getSnapshot",
  importBrowserCookies: "settings.browser.importCookies",
  openDataDirectory: "settings.data.openDirectory",
  openManagedBrowser: "settings.browser.open",
  saveAgent: "settings.agent.save",
  saveCompanionInitiative: "settings.companionInitiative.save",
  saveVoice: "settings.voice.save",
} as const;

export type AgentSettings = Static<typeof AgentSettingsSchema>;
export type BrowserComputerSettings = Static<
  typeof BrowserComputerSettingsSchema
>;
export type CompanionInitiativeLevel = Static<
  typeof CompanionInitiativeLevelSchema
>;
export type CompanionInitiativeSettings = Static<
  typeof CompanionInitiativeSettingsSchema
>;
export const DEFAULT_COMPANION_INITIATIVE_SETTINGS = {
  importantMomentOutreachEnabled: false,
  importantMomentOutreachPrompted: false,
  level: "balanced",
  quietHours: {
    enabled: true,
    endMinute: 8 * 60,
    startMinute: 22 * 60,
  },
} as const satisfies CompanionInitiativeSettings;
export type CompanionInitiativeSettingsSaveRequest = Static<
  typeof CompanionInitiativeSettingsSaveRequestSchema
>;
export type CompanionInitiativeSettingsSaveResponse = Static<
  typeof CompanionInitiativeSettingsSaveResponseSchema
>;
export type DataUsageCategoryId = Static<typeof DataUsageCategoryIdSchema>;
export type DataUsageCategory = Static<typeof DataUsageCategorySchema>;
export type DataSettingsSnapshot = Static<typeof DataSettingsSnapshotSchema>;
export type DataSettingsSnapshotResponse = Static<
  typeof DataSettingsSnapshotResponseSchema
>;
export type DataActionResponse = Static<typeof DataActionResponseSchema>;
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
  getDataSnapshot(): Promise<DataSettingsSnapshotResponse>;
  getSnapshot(): Promise<SettingsSnapshotResponse>;
  importBrowserCookies(): Promise<BrowserActionResponse>;
  openManagedBrowser(): Promise<BrowserActionResponse>;
  openDataDirectory(): Promise<DataActionResponse>;
  saveAgent(
    request: AgentSettingsSaveRequest,
  ): Promise<AgentSettingsSaveResponse>;
  saveCompanionInitiative(
    request: CompanionInitiativeSettingsSaveRequest,
  ): Promise<CompanionInitiativeSettingsSaveResponse>;
  saveVoice(
    request: VoiceSettingsSaveRequest,
  ): Promise<VoiceSettingsSaveResponse>;
}
