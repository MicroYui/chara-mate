import type Database from "better-sqlite3";

import type { AgentSettings } from "../../shared/contracts/settings";
import type { Timestamp } from "../../shared/contracts/primitives";
import { AgentSettingsSchema } from "../../shared/schemas/settings";
import { parseSchema } from "../../shared/schemas/validation";

interface AgentSettingsRow {
  default_approval_mode: AgentSettings["defaultApprovalMode"];
  default_mode: AgentSettings["defaultMode"];
  updated_at: Timestamp;
  working_directory: string;
}

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
}
