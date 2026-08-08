import type { Static } from "@sinclair/typebox";

import type {
  AgentSettingsSaveRequestSchema,
  AgentSettingsSaveResponseSchema,
  AgentSettingsSchema,
  BrowserActionResponseSchema,
  BrowserComputerSettingsSchema,
  SettingsSnapshotResponseSchema,
  SettingsSnapshotSchema,
} from "../schemas/settings";

export const SETTINGS_CHANNELS = {
  getSnapshot: "settings.getSnapshot",
  importBrowserCookies: "settings.browser.importCookies",
  openManagedBrowser: "settings.browser.open",
  saveAgent: "settings.agent.save",
} as const;

export type AgentSettings = Static<typeof AgentSettingsSchema>;
export type BrowserComputerSettings = Static<
  typeof BrowserComputerSettingsSchema
>;
export type SettingsSnapshot = Static<typeof SettingsSnapshotSchema>;
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

export interface SettingsApi {
  getSnapshot(): Promise<SettingsSnapshotResponse>;
  importBrowserCookies(): Promise<BrowserActionResponse>;
  openManagedBrowser(): Promise<BrowserActionResponse>;
  saveAgent(
    request: AgentSettingsSaveRequest,
  ): Promise<AgentSettingsSaveResponse>;
}
