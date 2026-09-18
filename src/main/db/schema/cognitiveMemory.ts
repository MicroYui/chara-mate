// Source semantics checked 2026-09-15: SQLite STRICT tables, FTS5, and
// transactional foreign-key behavior. These tables belong to Memory; vectors
// and search chunks are rebuildable projections of immutable revisions.
export const COGNITIVE_MEMORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entities (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_revision_semantics (
    revision_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('episode','claim','commitment','experience','reflection')),
    owner TEXT NOT NULL CHECK (owner IN ('user','character')),
    persona_id TEXT REFERENCES personas(id) ON DELETE CASCADE,
    basis TEXT NOT NULL CHECK (basis IN ('explicit_user_statement','direct_observation','inference')),
    occurred_from TEXT,
    occurred_to TEXT,
    time_precision TEXT CHECK (time_precision IN ('instant','day','month','year','range','unknown')),
    valid_from TEXT,
    valid_to TEXT,
    subject_entity_id TEXT REFERENCES memory_entities(id),
    predicate TEXT,
    object_entity_id TEXT REFERENCES memory_entities(id),
    object_value TEXT,
    qualifiers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(qualifiers_json)),
    commitment_state TEXT CHECK (commitment_state IN ('proposed','active','completed','cancelled')),
    CHECK (occurred_from IS NULL OR occurred_to IS NULL OR occurred_from <= occurred_to),
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to),
    CHECK (owner != 'character' OR persona_id IS NOT NULL)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_occurrence_lookup ON memory_revision_semantics(occurred_from, occurred_to);
  CREATE INDEX IF NOT EXISTS memory_validity_lookup ON memory_revision_semantics(valid_from, valid_to);
  CREATE INDEX IF NOT EXISTS memory_claim_lookup ON memory_revision_semantics(subject_entity_id, predicate, revision_id);

  CREATE TABLE IF NOT EXISTS memory_entity_aliases (
    entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
    normalized_alias TEXT NOT NULL,
    source_id TEXT REFERENCES memory_sources(id) ON DELETE CASCADE,
    PRIMARY KEY (entity_id, normalized_alias)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_alias_lookup ON memory_entity_aliases(normalized_alias, entity_id);

  CREATE TABLE IF NOT EXISTS memory_revision_entities (
    revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (revision_id, entity_id, role)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_entity_revisions ON memory_revision_entities(entity_id, revision_id);

  CREATE TABLE IF NOT EXISTS memory_revision_links (
    from_revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
    to_revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (relation IN ('supersedes','contradicts','caused_by','part_of','follows','derived_from')),
    evidence_source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
    dependency_use TEXT CHECK (dependency_use IN ('current','history')),
    CHECK ((relation='derived_from' AND dependency_use IS NOT NULL) OR (relation<>'derived_from' AND dependency_use IS NULL)),
    PRIMARY KEY (from_revision_id, to_revision_id, relation, evidence_source_id),
    CHECK (from_revision_id != to_revision_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_links_incoming ON memory_revision_links(to_revision_id, relation, from_revision_id);

  CREATE TABLE IF NOT EXISTS memory_revision_source_spans (
    revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
    span_start INTEGER NOT NULL CHECK (span_start >= 0),
    span_end INTEGER NOT NULL CHECK (span_end > span_start),
    quote TEXT NOT NULL,
    PRIMARY KEY (revision_id, source_id, span_start, span_end)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_search_chunks (
    id TEXT PRIMARY KEY NOT NULL,
    revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE (revision_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_chunk_embeddings (
    chunk_id TEXT NOT NULL REFERENCES memory_search_chunks(id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chunk_id, model_key),
    CHECK (length(vector) = dimensions * 4)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS memory_work (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('form','embed','reconcile')),
    subject_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    processor_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','failed','complete')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_code TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (kind, subject_id, source_version, processor_version)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_work_pending ON memory_work(status, updated_at, id);

  CREATE INDEX IF NOT EXISTS memory_unfinished_formation ON memory_work(
    json_extract(payload_json,'$.personaId')
  ) WHERE kind='form' AND status IN ('pending','running','failed');

  -- Canonical source text lives once, in exact UTF-16 windows. Jobs hold uses.
  CREATE TABLE IF NOT EXISTS memory_source_text_chunks (
    source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
    start_utf16 INTEGER NOT NULL CHECK (start_utf16 >= 0),
    content BLOB NOT NULL CHECK (length(content) > 0 AND length(content) % 2 = 0),
    PRIMARY KEY (source_id, start_utf16)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS memory_canonical_present
    ON memory_sources(id) WHERE raw_present=1;

  CREATE TABLE IF NOT EXISTS memory_work_sources (
    work_id TEXT NOT NULL REFERENCES memory_work(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    source_id TEXT NOT NULL REFERENCES memory_sources(id),
    is_primary INTEGER NOT NULL CHECK (is_primary IN (0,1)),
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (work_id, ordinal),
    UNIQUE (work_id, source_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS memory_work_source_reference
    ON memory_work_sources(source_id, work_id, is_primary, ordinal);
  CREATE INDEX IF NOT EXISTS memory_work_source_context
    ON memory_work_sources(work_id, is_primary, occurred_at DESC, source_id);
`;
