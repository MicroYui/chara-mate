export const CURRENT_SCHEMA_VERSION = "1";

export const METADATA_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT
`;

export const CURRENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    api_style TEXT NOT NULL CHECK (
      api_style IN ('openai-compatible', 'azure-openai')
    ),
    base_url TEXT NOT NULL,
    api_version TEXT,
    api_key_ref TEXT,
    chat_model TEXT,
    realtime_endpoint TEXT,
    realtime_model TEXT,
    image_generation_endpoint TEXT,
    image_model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      api_style = 'azure-openai' OR api_version IS NULL
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    pinned_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    execution_json TEXT NOT NULL CHECK (json_valid(execution_json)),
    provider_json TEXT NOT NULL CHECK (json_valid(provider_json)),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'running',
        'waiting_approval',
        'needs_input',
        'interrupted',
        'completed',
        'failed',
        'cancelled'
      )
    ),
    latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 0),
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    UNIQUE (id, chat_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    run_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    status TEXT NOT NULL CHECK (
      status IN ('streaming', 'completed', 'interrupted', 'failed', 'cancelled')
    ),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, chat_id),
    FOREIGN KEY (run_id, chat_id) REFERENCES runs(id, chat_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
      kind IN ('file', 'directory', 'image', 'audio', 'video')
    ),
    display_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    media_type TEXT,
    byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
    sha256 TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id, chat_id)
      REFERENCES messages(id, chat_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS run_items (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    kind TEXT NOT NULL CHECK (
      kind IN (
        'user_message',
        'assistant_message',
        'plan',
        'tool_call',
        'command',
        'file_change',
        'approval',
        'context_compaction',
        'error'
      )
    ),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'running',
        'waiting_approval',
        'completed',
        'failed',
        'cancelled',
        'interrupted'
      )
    ),
    input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
    display_output TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    UNIQUE (run_id, sequence),
    UNIQUE (id, run_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tool_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    run_item_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (
      kind IN ('file', 'directory', 'image', 'audio', 'video', 'log', 'data')
    ),
    display_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    media_type TEXT,
    byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
    sha256 TEXT,
    FOREIGN KEY (run_item_id, run_id)
      REFERENCES run_items(id, run_id) ON DELETE CASCADE,
    UNIQUE (run_item_id, position)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    parameter_summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')
    ),
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decision_reason TEXT,
    FOREIGN KEY (item_id, run_id)
      REFERENCES run_items(id, run_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
    PRIMARY KEY (run_id, sequence)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS chats_updated_idx
    ON chats(status, updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS messages_chat_idx
    ON messages(chat_id, created_at, id);
  CREATE INDEX IF NOT EXISTS attachments_message_idx
    ON attachments(message_id, created_at, id);
  CREATE INDEX IF NOT EXISTS runs_chat_idx
    ON runs(chat_id, created_at, id);
  CREATE INDEX IF NOT EXISTS run_items_run_idx
    ON run_items(run_id, sequence);
  CREATE INDEX IF NOT EXISTS tool_artifacts_item_idx
    ON tool_artifacts(run_item_id, position);
  CREATE INDEX IF NOT EXISTS approvals_run_idx
    ON approvals(run_id, requested_at, id);
`;
