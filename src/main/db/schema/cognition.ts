// Cognition owns these projections and validates cross-references in a transaction.
export const COGNITION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cognition_state (
  persona_id TEXT PRIMARY KEY REFERENCES personas(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  user_generation INTEGER NOT NULL CHECK (user_generation >= 0),
  focus_revision INTEGER NOT NULL CHECK (focus_revision >= 0),
  last_receipt_sequence INTEGER NOT NULL CHECK (last_receipt_sequence >= 0),
  analyzed_through_sequence INTEGER NOT NULL CHECK (analyzed_through_sequence >= 0),
  current_situation_id TEXT,
  committed_intent_id TEXT,
  next_wake_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cognition_evidence (
  receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('activity','message','run','memory','journey','territory','system')),
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL DEFAULT '',
  source_fragment TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL CHECK (actor IN ('user','agent','system','unknown')),
  kind TEXT NOT NULL CHECK (kind IN ('observation','utterance','effect','control','recollection')),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (persona_id, source_kind, source_id, source_revision, source_fragment, kind)
) STRICT;
CREATE INDEX IF NOT EXISTS cognition_evidence_original_lookup
  ON cognition_evidence(source_kind, source_id, source_fragment, persona_id);
CREATE INDEX IF NOT EXISTS cognition_evidence_persona_cursor_idx
  ON cognition_evidence(persona_id, receipt_sequence);
CREATE INDEX IF NOT EXISTS cognition_evidence_object_observed_idx
  ON cognition_evidence(
    persona_id,
    json_extract(payload_json,'$.object.key'),
    observed_at DESC,
    receipt_sequence DESC
  ) WHERE kind='observation';
CREATE INDEX IF NOT EXISTS cognition_evidence_current_user_idx
  ON cognition_evidence(persona_id, receipt_sequence DESC)
  WHERE actor='user' AND kind='utterance' AND source_kind!='memory';
CREATE INDEX IF NOT EXISTS cognition_evidence_latest_observation_idx
  ON cognition_evidence(persona_id, observed_at DESC, receipt_sequence DESC)
  WHERE actor IN ('user','unknown') AND kind='observation' AND json_extract(payload_json,'$.object') IS NOT NULL;
CREATE INDEX IF NOT EXISTS cognition_evidence_source_sequence_idx
  ON cognition_evidence(persona_id, source_kind,
    json_extract(payload_json,'$.sourceEpoch'), json_extract(payload_json,'$.sourceSequence') DESC)
  WHERE actor IN ('user','unknown') AND kind='observation';

CREATE TABLE IF NOT EXISTS cognition_situations (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('current','background','suspended','closed')),
  superseded_by TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cognition_situations_persona_status_idx
  ON cognition_situations(persona_id, status, updated_at);

-- Source-to-episode lookup projection, maintained with the owning situation.
CREATE TABLE IF NOT EXISTS cognition_episode_evidence (
  situation_id TEXT NOT NULL REFERENCES cognition_situations(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES cognition_evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (situation_id, episode_id, evidence_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cognition_episode_source_lookup
  ON cognition_episode_evidence(evidence_id, situation_id, episode_id);

-- Exact claim-source lookup, maintained in the same transaction as its situation.
CREATE TABLE IF NOT EXISTS cognition_claim_evidence (
  situation_id TEXT NOT NULL REFERENCES cognition_situations(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES cognition_evidence(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('supported','uncertain','disputed','superseded')),
  current_basis INTEGER NOT NULL CHECK (current_basis IN (0,1)),
  PRIMARY KEY (situation_id, claim_id, evidence_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cognition_claim_source_lookup
  ON cognition_claim_evidence(evidence_id, current_basis, situation_id, claim_id, state);

-- Pending cross-domain handoff; Memory work owns processing after atomic acknowledgement.
CREATE TABLE IF NOT EXISTS cognition_memory_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  situation_id TEXT NOT NULL REFERENCES cognition_situations(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (persona_id, situation_id, source_key)
) STRICT;
CREATE INDEX IF NOT EXISTS cognition_memory_handoffs_pending
  ON cognition_memory_handoffs(created_at, id);

CREATE TABLE IF NOT EXISTS cognition_intents (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  situation_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  owner TEXT NOT NULL CHECK (owner IN ('user','character')),
  basis TEXT NOT NULL CHECK (basis IN ('explicit_user','inferred_user','character')),
  status TEXT NOT NULL CHECK (status IN ('candidate','active','suspended','fulfilled','abandoned')),
  next_wake_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cognition_intents_persona_status_idx
  ON cognition_intents(persona_id, status, next_wake_at);
CREATE INDEX IF NOT EXISTS cognition_intents_situation_lookup
  ON cognition_intents(situation_id, persona_id, id);

CREATE TABLE IF NOT EXISTS cognition_decision_attempts (
  creation_sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','analyzing','awaiting_recall','ready','dispatched','settled','superseded','failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('user_turn','semantic_change','feedback','resume','character_due')),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  user_generation INTEGER NOT NULL CHECK (user_generation >= 0),
  dispatch_key TEXT NOT NULL UNIQUE,
  run_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cognition_attempts_persona_status_idx
  ON cognition_decision_attempts(persona_id, status, updated_at);
CREATE INDEX IF NOT EXISTS cognition_attempts_persona_creation_idx
  ON cognition_decision_attempts(persona_id, creation_sequence DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cognition_one_analysis_per_persona_idx
  ON cognition_decision_attempts(persona_id)
  WHERE status IN ('pending','analyzing','awaiting_recall','ready');
`;
