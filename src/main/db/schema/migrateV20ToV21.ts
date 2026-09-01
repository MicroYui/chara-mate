import type Database from "better-sqlite3";

export function migrateV20ToV21(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_companion_devices (
        slot TEXT PRIMARY KEY NOT NULL CHECK (slot = 'android'),
        device_id TEXT NOT NULL UNIQUE,
        installation_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
        relay_origin TEXT NOT NULL CHECK (
          relay_origin GLOB 'https://*' AND instr(relay_origin, ' ') = 0
        ),
        credential_ref TEXT NOT NULL,
        protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
        notification_permission TEXT NOT NULL CHECK (
          notification_permission IN ('unknown', 'granted', 'denied')
        ),
        notifications_enabled INTEGER NOT NULL CHECK (
          notifications_enabled IN (0, 1)
        ),
        status_state TEXT NOT NULL CHECK (
          status_state IN ('online', 'offline', 'protocol_error')
        ),
        status_message TEXT,
        status_observed_at TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            status_state = 'protocol_error' AND status_message IS NOT NULL AND
            length(trim(status_message)) > 0
          ) OR
          (status_state IN ('online', 'offline') AND status_message IS NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS companion_mailbox_cursors (
        desktop_instance_id TEXT PRIMARY KEY NOT NULL,
        recipient_kind TEXT NOT NULL DEFAULT 'desktop' CHECK (
          recipient_kind = 'desktop'
        ),
        cursor TEXT NOT NULL CHECK (length(trim(cursor)) > 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS companion_share_imports (
        submission_id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL UNIQUE,
        payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('text', 'attachment')),
        relay_asset_id TEXT,
        cursor TEXT NOT NULL CHECK (length(trim(cursor)) > 0),
        state TEXT NOT NULL CHECK (state IN ('claimed', 'imported')),
        run_id TEXT UNIQUE,
        expires_at TEXT NOT NULL,
        chat_id TEXT,
        message_id TEXT,
        attachment_id TEXT,
        claimed_at TEXT NOT NULL,
        imported_at TEXT,
        relay_acked_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (source_kind = 'text' AND relay_asset_id IS NULL) OR
          (source_kind = 'attachment' AND relay_asset_id IS NOT NULL)
        ),
        CHECK (
          (
            state = 'claimed' AND chat_id IS NULL AND message_id IS NULL AND
            attachment_id IS NULL AND imported_at IS NULL AND
            relay_acked_at IS NULL
          ) OR (
            state = 'imported' AND run_id IS NOT NULL AND chat_id IS NOT NULL AND
            message_id IS NOT NULL AND imported_at IS NOT NULL AND
            (
              (source_kind = 'text' AND attachment_id IS NULL) OR
              (source_kind = 'attachment' AND attachment_id IS NOT NULL)
            )
          )
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS companion_message_projections (
        message_id TEXT PRIMARY KEY NOT NULL
          REFERENCES messages(id) ON DELETE CASCADE,
        surface TEXT NOT NULL CHECK (
          surface IN ('desktop_bubble', 'android_notification')
        ),
        device_id TEXT,
        envelope_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN (
            'selected', 'submitted', 'projected', 'acknowledged', 'failed'
          )
        ),
        selected_at TEXT NOT NULL,
        submitted_at TEXT,
        projected_at TEXT,
        acknowledged_at TEXT,
        failed_at TEXT,
        failure_message TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            surface = 'desktop_bubble' AND device_id IS NULL AND
            envelope_id IS NULL
          ) OR (
            surface = 'android_notification' AND device_id IS NOT NULL AND
            envelope_id IS NOT NULL
          )
        ),
        CHECK (
          (state <> 'submitted' OR surface = 'android_notification') AND
          (state <> 'projected' OR surface = 'desktop_bubble') AND
          (state <> 'acknowledged' OR surface = 'android_notification')
        ),
        CHECK (
          (state = 'failed' AND failed_at IS NOT NULL AND
           failure_message IS NOT NULL AND length(trim(failure_message)) > 0) OR
          (state <> 'failed' AND failed_at IS NULL AND failure_message IS NULL)
        ),
        CHECK (
          (
            state = 'selected' AND submitted_at IS NULL AND
            projected_at IS NULL AND acknowledged_at IS NULL
          ) OR (
            state = 'submitted' AND submitted_at IS NOT NULL AND
            projected_at IS NULL AND acknowledged_at IS NULL
          ) OR (
            state = 'projected' AND submitted_at IS NULL AND
            projected_at IS NOT NULL AND acknowledged_at IS NULL
          ) OR (
            state = 'acknowledged' AND submitted_at IS NOT NULL AND
            projected_at IS NULL AND acknowledged_at IS NOT NULL
          ) OR (state = 'failed' AND acknowledged_at IS NULL)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS companion_share_imports_device_time_idx
        ON companion_share_imports(device_id, state, claimed_at, submission_id);
      CREATE INDEX IF NOT EXISTS companion_share_imports_pending_ack_idx
        ON companion_share_imports(state, relay_acked_at, imported_at, submission_id);
      CREATE INDEX IF NOT EXISTS companion_message_projections_surface_state_idx
        ON companion_message_projections(surface, state, selected_at, message_id);
    `);
    database
      .prepare(
        "UPDATE app_metadata SET value = '21' WHERE key = 'schema_version' AND value = '20'",
      )
      .run();
  })();
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("Database migration produced foreign-key violations");
  }
}
