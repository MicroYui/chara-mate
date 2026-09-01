import type Database from "better-sqlite3";

import type {
  AgentSettings,
  CompanionInitiativeSettings,
  VoiceSettingsConfig,
} from "../../shared/contracts/settings";
import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../shared/contracts/settings";
import type { Timestamp } from "../../shared/contracts/primitives";
import { AgentSettingsSchema } from "../../shared/schemas/settings";
import { CompanionInitiativeSettingsSchema } from "../../shared/schemas/settings";
import { VoiceSettingsConfigSchema } from "../../shared/schemas/settings";
import { parseSchema } from "../../shared/schemas/validation";

interface AgentSettingsRow {
  default_approval_mode: AgentSettings["defaultApprovalMode"];
  default_mode: AgentSettings["defaultMode"];
  updated_at: Timestamp;
  working_directory: string;
}

interface VoiceSettingsRow {
  input_mode: VoiceSettingsConfig["inputMode"];
  provider_profile_id: string;
}

interface VoiceWakeSettingsRow {
  wake_enabled: 0 | 1;
}

interface CompanionInitiativeSettingsRow {
  important_moment_outreach_enabled: 0 | 1;
  important_moment_outreach_prompted: 0 | 1;
  level: CompanionInitiativeSettings["level"];
  quiet_hours_enabled: 0 | 1;
  quiet_hours_end_minute: number;
  quiet_hours_start_minute: number;
  territory_moment_surprises_enabled: 0 | 1;
  territory_moment_surprises_prompted: 0 | 1;
}

const DEFAULT_VOICE_PROVIDER_PROFILE_ID =
  "d0197d17-a231-41e0-afe2-664791a531ec";

export class SettingsRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly defaultWorkingDirectory: string,
  ) {}

  getAgent(): AgentSettings {
    const row = this.database
      .prepare(
        `SELECT default_mode, default_approval_mode, working_directory, updated_at
         FROM agent_settings WHERE settings_id = 'agent'`,
      )
      .get() as AgentSettingsRow | undefined;
    return parseSchema(
      AgentSettingsSchema,
      row
        ? {
            defaultApprovalMode: row.default_approval_mode,
            defaultMode: row.default_mode,
            workingDirectory: row.working_directory,
          }
        : {
            defaultApprovalMode: "request_approval",
            defaultMode: "chat",
            workingDirectory: this.defaultWorkingDirectory,
          },
    );
  }

  saveAgent(settings: AgentSettings, updatedAt: Timestamp): AgentSettings {
    const value = parseSchema(AgentSettingsSchema, settings);
    this.database
      .prepare(
        `INSERT INTO agent_settings (
           settings_id, default_mode, default_approval_mode,
           working_directory, updated_at
         ) VALUES ('agent', @defaultMode, @defaultApprovalMode, @workingDirectory, @updatedAt)
         ON CONFLICT(settings_id) DO UPDATE SET
           default_mode = excluded.default_mode,
           default_approval_mode = excluded.default_approval_mode,
           working_directory = excluded.working_directory,
           updated_at = excluded.updated_at`,
      )
      .run({ ...value, updatedAt });
    return this.getAgent();
  }

  getCompanionInitiative(): CompanionInitiativeSettings {
    const row = this.database
      .prepare(
        `SELECT important_moment_outreach_enabled,
                important_moment_outreach_prompted, level,
                quiet_hours_enabled, quiet_hours_start_minute,
                quiet_hours_end_minute,
                territory_moment_surprises_enabled,
                territory_moment_surprises_prompted
         FROM companion_initiative_settings
         WHERE settings_id = 'companion'`,
      )
      .get() as CompanionInitiativeSettingsRow | undefined;
    return parseSchema(
      CompanionInitiativeSettingsSchema,
      row
        ? {
            importantMomentOutreachEnabled:
              row.important_moment_outreach_enabled === 1,
            importantMomentOutreachPrompted:
              row.important_moment_outreach_prompted === 1,
            level: row.level,
            quietHours: {
              enabled: row.quiet_hours_enabled === 1,
              endMinute: row.quiet_hours_end_minute,
              startMinute: row.quiet_hours_start_minute,
            },
            territoryMomentSurprisesEnabled:
              row.territory_moment_surprises_enabled === 1,
            territoryMomentSurprisesPrompted:
              row.territory_moment_surprises_prompted === 1,
          }
        : DEFAULT_COMPANION_INITIATIVE_SETTINGS,
    );
  }

  saveCompanionInitiative(
    settings: CompanionInitiativeSettings,
    updatedAt: Timestamp,
  ): CompanionInitiativeSettings {
    const value = parseSchema(CompanionInitiativeSettingsSchema, settings);
    this.database
      .prepare(
        `INSERT INTO companion_initiative_settings (
           settings_id, important_moment_outreach_enabled,
           important_moment_outreach_prompted, level,
           quiet_hours_enabled,
           quiet_hours_start_minute, quiet_hours_end_minute,
           territory_moment_surprises_enabled,
           territory_moment_surprises_prompted, updated_at
         ) VALUES (
           'companion', @importantMomentOutreachEnabled,
           @importantMomentOutreachPrompted, @level,
           @quietHoursEnabled,
           @quietHoursStartMinute, @quietHoursEndMinute,
           @territoryMomentSurprisesEnabled,
           @territoryMomentSurprisesPrompted, @updatedAt
         )
         ON CONFLICT(settings_id) DO UPDATE SET
           important_moment_outreach_enabled = excluded.important_moment_outreach_enabled,
           important_moment_outreach_prompted = excluded.important_moment_outreach_prompted,
           level = excluded.level,
           quiet_hours_enabled = excluded.quiet_hours_enabled,
           quiet_hours_start_minute = excluded.quiet_hours_start_minute,
           quiet_hours_end_minute = excluded.quiet_hours_end_minute,
           territory_moment_surprises_enabled = excluded.territory_moment_surprises_enabled,
           territory_moment_surprises_prompted = excluded.territory_moment_surprises_prompted,
           updated_at = excluded.updated_at`,
      )
      .run({
        importantMomentOutreachEnabled: value.importantMomentOutreachEnabled
          ? 1
          : 0,
        importantMomentOutreachPrompted: value.importantMomentOutreachPrompted
          ? 1
          : 0,
        level: value.level,
        quietHoursEnabled: value.quietHours.enabled ? 1 : 0,
        quietHoursEndMinute: value.quietHours.endMinute,
        quietHoursStartMinute: value.quietHours.startMinute,
        territoryMomentSurprisesEnabled: value.territoryMomentSurprisesEnabled
          ? 1
          : 0,
        territoryMomentSurprisesPrompted: value.territoryMomentSurprisesPrompted
          ? 1
          : 0,
        updatedAt,
      });
    return this.getCompanionInitiative();
  }

  getVoice(): VoiceSettingsConfig {
    const row = this.database
      .prepare(
        `SELECT provider_profile_id, input_mode
         FROM voice_settings WHERE settings_id = 'voice'`,
      )
      .get() as VoiceSettingsRow | undefined;
    return parseSchema(
      VoiceSettingsConfigSchema,
      row
        ? {
            inputMode: row.input_mode,
            providerProfileId: row.provider_profile_id,
          }
        : {
            inputMode: "hands_free",
            providerProfileId: DEFAULT_VOICE_PROVIDER_PROFILE_ID,
          },
    );
  }

  saveVoice(
    settings: VoiceSettingsConfig,
    updatedAt: Timestamp,
  ): VoiceSettingsConfig {
    const value = parseSchema(VoiceSettingsConfigSchema, settings);
    this.database
      .prepare(
        `INSERT INTO voice_settings (
           settings_id, provider_profile_id, input_mode, updated_at
         ) VALUES (
           'voice', @providerProfileId, @inputMode, @updatedAt
         )
         ON CONFLICT(settings_id) DO UPDATE SET
           provider_profile_id = excluded.provider_profile_id,
           input_mode = excluded.input_mode,
           updated_at = excluded.updated_at`,
      )
      .run({ ...value, updatedAt });
    return this.getVoice();
  }

  getVoiceWakeEnabled(): boolean {
    const row = this.database
      .prepare(
        "SELECT wake_enabled FROM voice_settings WHERE settings_id = 'voice'",
      )
      .get() as VoiceWakeSettingsRow | undefined;
    return row?.wake_enabled === 1;
  }

  saveVoiceWakeEnabled(enabled: boolean, updatedAt: Timestamp): boolean {
    const current = this.getVoice();
    this.database
      .prepare(
        `INSERT INTO voice_settings (
           settings_id, provider_profile_id, input_mode, wake_enabled,
           updated_at
         ) VALUES (
           'voice', @providerProfileId, @inputMode, @wakeEnabled, @updatedAt
         )
         ON CONFLICT(settings_id) DO UPDATE SET
           wake_enabled = excluded.wake_enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...current,
        updatedAt,
        wakeEnabled: enabled ? 1 : 0,
      });
    return this.getVoiceWakeEnabled();
  }
}
