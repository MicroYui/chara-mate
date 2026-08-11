export const CURRENT_SCHEMA_VERSION = "9";

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

  CREATE TABLE IF NOT EXISTS territory_image_candidates (
    candidate_id TEXT PRIMARY KEY NOT NULL,
    provider_profile_id TEXT NOT NULL,
    scene_id TEXT NOT NULL CHECK (
      scene_id IN (
        'forest-cabin',
        'seaside-room',
        'city-rooftop',
        'star-workshop'
      )
    ),
    operation TEXT NOT NULL CHECK (operation IN ('generate', 'edit')),
    source_candidate_id TEXT REFERENCES territory_image_candidates(candidate_id),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    status TEXT NOT NULL CHECK (
      status IN ('generating', 'ready', 'failed', 'accepted')
    ),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    accepted_item_id TEXT REFERENCES territory_items(item_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (operation = 'generate' AND source_candidate_id IS NULL) OR
      (operation = 'edit' AND source_candidate_id IS NOT NULL)
    ),
    CHECK (
      (
        status IN ('generating', 'ready') AND
        error_json IS NULL AND accepted_item_id IS NULL
      ) OR (
        status = 'failed' AND
        error_json IS NOT NULL AND accepted_item_id IS NULL
      ) OR (
        status = 'accepted' AND
        error_json IS NULL AND accepted_item_id IS NOT NULL
      )
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    execution_json TEXT NOT NULL CHECK (json_valid(execution_json)),
    provider_json TEXT NOT NULL CHECK (json_valid(provider_json)),
    source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'voice')),
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

  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed')),
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'active' AND next_run_at IS NOT NULL) OR
      (state IN ('paused', 'completed') AND next_run_at IS NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    automation_id TEXT NOT NULL
      REFERENCES automations(id) ON DELETE CASCADE,
    automation_revision INTEGER NOT NULL CHECK (automation_revision >= 1),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
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
    chat_id TEXT REFERENCES chats(id),
    run_id TEXT UNIQUE,
    summary TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    requested_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id, chat_id) REFERENCES runs(id, chat_id),
    CHECK (run_id IS NULL OR chat_id IS NOT NULL),
    CHECK (json_extract(trigger_json, '$.kind') IN ('scheduled', 'manual')),
    CHECK (
      (
        json_extract(trigger_json, '$.kind') = 'scheduled' AND
        json_type(trigger_json, '$.scheduledFor') = 'text'
      ) OR (
        json_extract(trigger_json, '$.kind') = 'manual' AND
        json_type(trigger_json, '$.scheduledFor') IS NULL
      )
    ),
    CHECK (
      (status = 'queued' AND started_at IS NULL AND ended_at IS NULL) OR
      (
        status IN ('running', 'waiting_approval', 'needs_input') AND
        started_at IS NOT NULL AND ended_at IS NULL
      ) OR (
        status IN ('interrupted', 'completed', 'failed', 'cancelled') AND
        started_at IS NOT NULL AND ended_at IS NOT NULL
      )
    ),
    CHECK (
      (status = 'failed' AND error_json IS NOT NULL) OR
      (status <> 'failed' AND error_json IS NULL)
    )
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

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'profile',
        'preference',
        'project',
        'event',
        'procedure',
        'commitment',
        'activity_digest',
        'agent_learning'
      )
    ),
    status TEXT NOT NULL CHECK (
      status IN ('active', 'superseded', 'archived')
    ),
    current_revision_id TEXT NOT NULL,
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from TEXT,
    valid_to TEXT,
    pinned_at TEXT,
    superseded_by_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to),
    UNIQUE (id, current_revision_id),
    FOREIGN KEY (current_revision_id, id)
      REFERENCES memory_revisions(id, memory_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    source_type TEXT NOT NULL CHECK (
      source_type IN (
        'chat', 'voice', 'activity', 'tool', 'user_edit', 'distillation'
      )
    ),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (id, memory_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_sources (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'chat', 'voice', 'activity', 'tool', 'user_edit', 'distillation'
      )
    ),
    reference_id TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_revision_sources (
    revision_id TEXT NOT NULL
      REFERENCES memory_revisions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
    PRIMARY KEY (revision_id, source_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_usage (
    id TEXT PRIMARY KEY NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    consumer TEXT NOT NULL CHECK (consumer IN ('context', 'tool')),
    used_at TEXT NOT NULL,
    FOREIGN KEY (revision_id, memory_id)
      REFERENCES memory_revisions(id, memory_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'profile',
        'preference',
        'project',
        'event',
        'procedure',
        'commitment',
        'activity_digest',
        'agent_learning'
      )
    ),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
    source_labels_json TEXT NOT NULL CHECK (json_valid(source_labels_json)),
    source_type TEXT NOT NULL CHECK (
      source_type IN (
        'chat', 'voice', 'activity', 'tool', 'user_edit', 'distillation'
      )
    ),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    novelty REAL NOT NULL CHECK (novelty >= 0 AND novelty <= 1),
    valid_from TEXT,
    valid_to TEXT,
    supersedes_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    accepted_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_claims (
    memory_id TEXT PRIMARY KEY NOT NULL
      REFERENCES memories(id) ON DELETE CASCADE,
    claim_slot TEXT NOT NULL UNIQUE CHECK (
      claim_slot IN (
        'profile.name',
        'profile.pronouns',
        'profile.home_location',
        'profile.timezone',
        'profile.occupation',
        'profile.languages',
        'profile.birth_date',
        'preference.hobbies',
        'preference.likes',
        'preference.dislikes',
        'preference.response_style',
        'preference.communication_style',
        'preference.food',
        'preference.music',
        'preference.media',
        'preference.travel',
        'preference.schedule',
        'preference.tools'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_candidate_formation (
    candidate_id TEXT PRIMARY KEY NOT NULL
      REFERENCES memory_candidates(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (
      operation IN ('create', 'replace', 'append', 'remove')
    ),
    claim_slot TEXT CHECK (
      claim_slot IS NULL OR claim_slot IN (
        'profile.name',
        'profile.pronouns',
        'profile.home_location',
        'profile.timezone',
        'profile.occupation',
        'profile.languages',
        'profile.birth_date',
        'preference.hobbies',
        'preference.likes',
        'preference.dislikes',
        'preference.response_style',
        'preference.communication_style',
        'preference.food',
        'preference.music',
        'preference.media',
        'preference.travel',
        'preference.schedule',
        'preference.tools'
      )
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS profile_fields (
    memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (revision_id, memory_id)
      REFERENCES memory_revisions(id, memory_id) ON DELETE CASCADE
  ) STRICT;

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    tokens,
    memory_id UNINDEXED,
    revision_id UNINDEXED,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS activity_state (
    state_id TEXT PRIMARY KEY NOT NULL CHECK (state_id = 'activity'),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    last_cleanup_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity_assets (
    id TEXT PRIMARY KEY NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL CHECK (media_type = 'image/png'),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
    source TEXT NOT NULL CHECK (
      source IN (
        'active_app', 'managed_browser', 'screenshot', 'idle', 'agent_run'
      )
    ),
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    episode_id TEXT REFERENCES activity_episodes(id) ON DELETE SET NULL,
    distilled_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity_episodes (
    id TEXT PRIMARY KEY NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    source_types_json TEXT NOT NULL CHECK (json_valid(source_types_json)),
    app_names_json TEXT NOT NULL CHECK (json_valid(app_names_json)),
    domains_json TEXT NOT NULL CHECK (json_valid(domains_json)),
    screenshot_storage_keys_json TEXT NOT NULL CHECK (
      json_valid(screenshot_storage_keys_json)
    ),
    event_count INTEGER NOT NULL CHECK (event_count >= 1),
    digest_id TEXT,
    raw_cleared_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity_digests (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    evidence_days INTEGER NOT NULL CHECK (evidence_days >= 1),
    candidate_ids_json TEXT NOT NULL CHECK (json_valid(candidate_ids_json)),
    created_at TEXT NOT NULL,
    CHECK (period_start < period_end)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity_digest_evidence (
    digest_id TEXT NOT NULL REFERENCES activity_digests(id) ON DELETE CASCADE,
    episode_id TEXT NOT NULL,
    evidence_label TEXT NOT NULL CHECK (length(trim(evidence_label)) > 0),
    PRIMARY KEY (digest_id, episode_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS distillation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    CHECK (period_start < period_end)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS retention_runs (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    deleted_assets INTEGER NOT NULL CHECK (deleted_assets >= 0),
    deleted_events INTEGER NOT NULL CHECK (deleted_events >= 0),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
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
        'input_request',
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
        'waiting_input',
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
      phase IN ('model', 'tool', 'approval', 'input', 'interrupted')
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

  CREATE TABLE IF NOT EXISTS voice_settings (
    settings_id TEXT PRIMARY KEY NOT NULL CHECK (settings_id = 'voice'),
    provider_profile_id TEXT NOT NULL,
    voice TEXT NOT NULL CHECK (
      voice IN (
        'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'
      )
    ),
    instructions TEXT NOT NULL,
    input_mode TEXT NOT NULL CHECK (
      input_mode IN ('hands_free', 'push_to_talk')
    ),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS voice_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    provider_json TEXT NOT NULL CHECK (json_valid(provider_json)),
    voice TEXT NOT NULL CHECK (
      voice IN (
        'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'
      )
    ),
    instructions TEXT NOT NULL,
    input_mode TEXT NOT NULL CHECK (
      input_mode IN ('hands_free', 'push_to_talk')
    ),
    status TEXT NOT NULL CHECK (
      status IN ('connecting', 'active', 'interrupted', 'completed', 'failed')
    ),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    muted INTEGER NOT NULL CHECK (muted IN (0, 1)),
    protocol_session_id TEXT,
    last_run_id TEXT REFERENCES runs(id),
    created_at TEXT NOT NULL,
    connected_at TEXT,
    ended_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS voice_turns (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL
      REFERENCES voice_sessions(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    status TEXT NOT NULL CHECK (
      status IN ('listening', 'responding', 'completed', 'interrupted', 'failed')
    ),
    run_id TEXT REFERENCES runs(id),
    user_message_id TEXT REFERENCES messages(id),
    assistant_message_id TEXT REFERENCES messages(id),
    user_item_id TEXT,
    assistant_item_id TEXT,
    response_id TEXT,
    user_transcript TEXT NOT NULL,
    assistant_transcript TEXT NOT NULL,
    voice TEXT NOT NULL,
    instructions TEXT NOT NULL,
    interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1)),
    audio_end_ms INTEGER CHECK (audio_end_ms IS NULL OR audio_end_ms >= 0),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE (session_id, generation)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS chats_updated_idx
    ON chats(status, updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS messages_chat_idx
    ON messages(chat_id, created_at, id);
  CREATE INDEX IF NOT EXISTS attachments_message_idx
    ON attachments(message_id, created_at, id);
  CREATE INDEX IF NOT EXISTS memories_list_idx
    ON memories(deleted_at, status, type, pinned_at DESC, updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS memory_revisions_memory_idx
    ON memory_revisions(memory_id, created_at DESC, id);
  CREATE INDEX IF NOT EXISTS memory_revision_sources_source_idx
    ON memory_revision_sources(source_id, revision_id);
  CREATE INDEX IF NOT EXISTS memory_sources_reference_idx
    ON memory_sources(type, reference_id, id);
  CREATE INDEX IF NOT EXISTS memory_usage_memory_idx
    ON memory_usage(memory_id, used_at DESC, id);
  CREATE INDEX IF NOT EXISTS memory_candidates_status_idx
    ON memory_candidates(status, created_at DESC, id);
  CREATE INDEX IF NOT EXISTS activity_events_time_idx
    ON activity_events(started_at, id);
  CREATE INDEX IF NOT EXISTS activity_events_episode_idx
    ON activity_events(episode_id, started_at, id);
  CREATE INDEX IF NOT EXISTS activity_events_retention_idx
    ON activity_events(distilled_at, ended_at, id);
  CREATE INDEX IF NOT EXISTS activity_episodes_time_idx
    ON activity_episodes(started_at, ended_at, id);
  CREATE INDEX IF NOT EXISTS activity_episodes_retention_idx
    ON activity_episodes(raw_cleared_at, ended_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS activity_digests_period_idx
    ON activity_digests(kind, period_start, period_end);
  CREATE INDEX IF NOT EXISTS runs_chat_idx
    ON runs(chat_id, created_at, id);
  CREATE INDEX IF NOT EXISTS automations_state_next_idx
    ON automations(state, next_run_at, id);
  CREATE INDEX IF NOT EXISTS automation_runs_history_idx
    ON automation_runs(automation_id, requested_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_occurrence_idx
    ON automation_runs(
      automation_id,
      json_extract(trigger_json, '$.scheduledFor')
    )
    WHERE json_extract(trigger_json, '$.kind') = 'scheduled';
  CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_turn_per_chat_idx
    ON runs(chat_id)
    WHERE status IN ('queued', 'running', 'waiting_approval', 'needs_input');
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
  CREATE INDEX IF NOT EXISTS voice_sessions_chat_idx
    ON voice_sessions(chat_id, created_at DESC, id);
  CREATE INDEX IF NOT EXISTS voice_turns_session_idx
    ON voice_turns(session_id, generation, id);
  CREATE INDEX IF NOT EXISTS voice_turns_run_idx
    ON voice_turns(run_id, id);
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
  CREATE INDEX IF NOT EXISTS territory_image_candidates_created_idx
    ON territory_image_candidates(created_at DESC, candidate_id DESC);
`;
