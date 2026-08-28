import type Database from "better-sqlite3";

import type {
  AgentSettings,
  VoiceSettingsConfig,
} from "../../shared/contracts/settings";
import type { Timestamp } from "../../shared/contracts/primitives";
import { AgentSettingsSchema } from "../../shared/schemas/settings";
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
  instructions: string;
  provider_profile_id: string;
  voice: VoiceSettingsConfig["voice"];
}

interface VoiceWakeSettingsRow {
  wake_enabled: 0 | 1;
}

export const DEFAULT_VOICE_INSTRUCTIONS =
  "使用用户当前使用的语言自然、简洁地回应，并在用户切换语言时跟随；中文使用简体中文。角色整体开朗、有温度，处理任务时保持清楚可靠。允许自然停顿，不朗读命令、代码、JSON 和日志；涉及工具执行时只用一句短话说明正在做什么。";

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

  getVoice(): VoiceSettingsConfig {
    const row = this.database
      .prepare(
        `SELECT provider_profile_id, voice, instructions, input_mode
         FROM voice_settings WHERE settings_id = 'voice'`,
      )
      .get() as VoiceSettingsRow | undefined;
    return parseSchema(
      VoiceSettingsConfigSchema,
      row
        ? {
            inputMode: row.input_mode,
            instructions: row.instructions,
            providerProfileId: row.provider_profile_id,
            voice: row.voice,
          }
        : {
            inputMode: "hands_free",
            instructions: DEFAULT_VOICE_INSTRUCTIONS,
            providerProfileId: DEFAULT_VOICE_PROVIDER_PROFILE_ID,
            voice: "verse",
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
           settings_id, provider_profile_id, voice, instructions,
           input_mode, updated_at
         ) VALUES (
           'voice', @providerProfileId, @voice, @instructions,
           @inputMode, @updatedAt
         )
         ON CONFLICT(settings_id) DO UPDATE SET
           provider_profile_id = excluded.provider_profile_id,
           voice = excluded.voice,
           instructions = excluded.instructions,
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
           settings_id, provider_profile_id, voice, instructions,
           input_mode, wake_enabled, updated_at
         ) VALUES (
           'voice', @providerProfileId, @voice, @instructions,
           @inputMode, @wakeEnabled, @updatedAt
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
