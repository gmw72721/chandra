CREATE TABLE IF NOT EXISTS agent_search_documents (
  id BIGSERIAL PRIMARY KEY,
  class_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  professor_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  gemini_document_id TEXT NOT NULL,
  gemini_chunk_id TEXT,
  chunk_type TEXT NOT NULL DEFAULT 'page',
  page_number INTEGER,
  parent_chunk_id TEXT,
  previous_chunk_id TEXT,
  next_chunk_id TEXT,
  layout_json JSONB,
  content_hash TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  indexed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_row_id, gemini_document_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_search_documents_class_teacher
  ON agent_search_documents (class_id, teacher_id, sync_status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_search_documents_material_page
  ON agent_search_documents (material_id, page_number)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_search_documents_gemini_document
  ON agent_search_documents (gemini_document_id)
  WHERE deleted_at IS NULL;
