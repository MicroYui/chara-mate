export const CURRENT_SCHEMA_VERSION = "4";

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

  CREATE TABLE IF NOT EXISTS window_placements (
    window_id TEXT PRIMARY KEY NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    is_maximized INTEGER NOT NULL CHECK (is_maximized IN (0, 1)),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS pet_character_state (
    state_id TEXT PRIMARY KEY NOT NULL CHECK (state_id = 'character'),
    active_pet_id TEXT,
    animation_speed REAL NOT NULL CHECK (
      animation_speed >= 0.1 AND animation_speed <= 1.5
    ),
    display_id TEXT,
    offset_x INTEGER NOT NULL,
    offset_y INTEGER NOT NULL,
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    scale REAL NOT NULL CHECK (scale >= 0.3 AND scale <= 1.5),
    facing TEXT NOT NULL CHECK (facing IN ('left', 'right')),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS territory_scenes (
    scene_id TEXT PRIMARY KEY NOT NULL CHECK (
      scene_id IN (
        'forest-cabin',
        'seaside-room',
        'city-rooftop',
        'star-workshop'
      )
    ),
    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
    pet_x INTEGER NOT NULL CHECK (pet_x >= 0),
    pet_y INTEGER NOT NULL CHECK (pet_y >= 0),
    pet_facing TEXT NOT NULL CHECK (pet_facing IN ('left', 'right')),
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS territory_assets (
    asset_id TEXT PRIMARY KEY NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type = 'image/png'),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    storage_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS territory_item_definitions (
    definition_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    asset_id TEXT REFERENCES territory_assets(asset_id),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (definition_id, revision),
    CHECK (
      (
        asset_id IS NULL AND
        json_extract(manifest_json, '$.visual.source.kind') = 'builtin'
      ) OR (
        asset_id IS NOT NULL AND
        json_extract(manifest_json, '$.visual.source.kind') = 'asset' AND
        json_extract(manifest_json, '$.visual.source.assetId') = asset_id
      )
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS territory_items (
    item_id TEXT PRIMARY KEY NOT NULL,
    definition_id TEXT NOT NULL,
    definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
    initial_scene_id TEXT REFERENCES territory_scenes(scene_id),
    created_at TEXT NOT NULL,
    FOREIGN KEY (definition_id, definition_revision)
      REFERENCES territory_item_definitions(definition_id, revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS territory_placements (
    item_id TEXT PRIMARY KEY NOT NULL
      REFERENCES territory_items(item_id) ON DELETE CASCADE,
    location TEXT NOT NULL CHECK (location IN ('scene', 'collection')),
    scene_id TEXT REFERENCES territory_scenes(scene_id),
    placement_kind TEXT CHECK (placement_kind IN ('ground', 'surface')),
    grid_x INTEGER CHECK (grid_x IS NULL OR grid_x >= 0),
    grid_y INTEGER CHECK (grid_y IS NULL OR grid_y >= 0),
    support_item_id TEXT REFERENCES territory_items(item_id),
    slot_id TEXT,
    rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
    flipped INTEGER NOT NULL CHECK (flipped IN (0, 1)),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    placed_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (
        location = 'scene' AND scene_id IS NOT NULL AND
        placed_at IS NOT NULL AND
        (
          (
            placement_kind = 'ground' AND
            grid_x IS NOT NULL AND grid_y IS NOT NULL AND
            support_item_id IS NULL AND slot_id IS NULL
          ) OR (
            placement_kind = 'surface' AND
            grid_x IS NULL AND grid_y IS NULL AND
            support_item_id IS NOT NULL AND slot_id IS NOT NULL AND
            support_item_id <> item_id
          )
        )
      ) OR (
        location = 'collection' AND scene_id IS NULL AND
        placement_kind IS NULL AND grid_x IS NULL AND grid_y IS NULL AND
        support_item_id IS NULL AND slot_id IS NULL AND placed_at IS NULL
      )
    )
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
    output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
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

  CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    phase TEXT NOT NULL CHECK (
      phase IN ('model', 'tool', 'approval', 'interrupted')
    ),
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    last_completed_sequence INTEGER NOT NULL CHECK (
      last_completed_sequence >= 0
    ),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    transport_json TEXT NOT NULL CHECK (json_valid(transport_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_connected_at TEXT,
    last_error_json TEXT CHECK (
      last_error_json IS NULL OR json_valid(last_error_json)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS skill_versions (
    skill_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    source TEXT NOT NULL CHECK (source IN ('workspace', 'user')),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    archived_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS agent_settings (
    settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'agent'),
    default_mode TEXT NOT NULL CHECK (default_mode IN ('chat', 'agent')),
    default_approval_mode TEXT NOT NULL CHECK (
      default_approval_mode IN (
        'request_approval',
        'auto_approve',
        'full_access'
      )
    ),
    working_directory TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS chats_updated_idx
    ON chats(status, updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS messages_chat_idx
    ON messages(chat_id, created_at, id);
  CREATE INDEX IF NOT EXISTS attachments_message_idx
    ON attachments(message_id, created_at, id);
  CREATE INDEX IF NOT EXISTS runs_chat_idx
    ON runs(chat_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_turn_per_chat_idx
    ON runs(chat_id)
    WHERE status IN ('queued', 'running', 'waiting_approval');
  CREATE INDEX IF NOT EXISTS run_items_run_idx
    ON run_items(run_id, sequence);
  CREATE INDEX IF NOT EXISTS tool_artifacts_item_idx
    ON tool_artifacts(run_item_id, position);
  CREATE INDEX IF NOT EXISTS approvals_run_idx
    ON approvals(run_id, requested_at, id);
  CREATE INDEX IF NOT EXISTS mcp_servers_enabled_idx
    ON mcp_servers(enabled, updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS skill_versions_active_idx
    ON skill_versions(skill_id, enabled, archived_at, revision DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS territory_one_active_scene_idx
    ON territory_scenes(is_active)
    WHERE is_active = 1;
  CREATE INDEX IF NOT EXISTS territory_placements_scene_idx
    ON territory_placements(scene_id, placement_kind, grid_y, grid_x, item_id);
  CREATE INDEX IF NOT EXISTS territory_placements_collection_idx
    ON territory_placements(location, updated_at, item_id);
  CREATE UNIQUE INDEX IF NOT EXISTS territory_one_item_per_surface_slot_idx
    ON territory_placements(support_item_id, slot_id)
    WHERE location = 'scene' AND placement_kind = 'surface';
`;
