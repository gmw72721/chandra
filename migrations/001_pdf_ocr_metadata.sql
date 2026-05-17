CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS pdf_materials (
  material_id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  professor_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  material_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  full_pdf_bucket TEXT NOT NULL DEFAULT '',
  full_pdf_path TEXT NOT NULL DEFAULT '',
  full_pdf_uri TEXT NOT NULL DEFAULT '',
  full_pdf_mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  full_pdf_size BIGINT NOT NULL DEFAULT 0,
  full_pdf_sha256 TEXT,
  source_kind TEXT NOT NULL DEFAULT 'file',
  page_count INTEGER NOT NULL DEFAULT 0,
  character_count INTEGER NOT NULL DEFAULT 0,
  search_metadata_source TEXT NOT NULL DEFAULT 'postgres',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pdf_pages (
  id BIGSERIAL PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES pdf_materials(material_id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  professor_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  material_type TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  detected_page_label TEXT,
  document_title TEXT,
  chapter TEXT,
  section TEXT,
  section_title TEXT,
  page_type TEXT,
  language TEXT,
  structured_page_json JSONB,
  page_level_search_text TEXT NOT NULL DEFAULT '',
  page_level_summary TEXT NOT NULL DEFAULT '',
  extraction_confidence NUMERIC,
  extraction_warnings TEXT[] NOT NULL DEFAULT '{}',
  extraction_model TEXT,
  extraction_timestamp TIMESTAMPTZ,
  ingestion_version TEXT,
  embedding_source TEXT,
  embedding_dim INTEGER,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  full_pdf_bucket TEXT,
  full_pdf_path TEXT,
  full_pdf_uri TEXT,
  full_pdf_mime_type TEXT,
  full_pdf_size BIGINT,
  full_pdf_sha256 TEXT,
  page_asset_bucket TEXT,
  page_asset_path TEXT,
  page_asset_uri TEXT,
  page_asset_size BIGINT,
  page_asset_sha256 TEXT,
  page_asset_storage_bucket TEXT,
  page_asset_storage_path TEXT,
  page_asset_mime_type TEXT,
  page_asset_size_bytes BIGINT,
  page_asset_checksum_sha256 TEXT,
  text_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(page_level_search_text, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (material_id, page_number)
);

ALTER TABLE pdf_materials
  ADD COLUMN IF NOT EXISTS full_pdf_bucket TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS full_pdf_path TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS full_pdf_uri TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS full_pdf_mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  ADD COLUMN IF NOT EXISTS full_pdf_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS full_pdf_sha256 TEXT,
  DROP COLUMN IF EXISTS ocr_provider,
  DROP COLUMN IF EXISTS ocr_source,
  DROP COLUMN IF EXISTS ocr_confidence;

DROP INDEX IF EXISTS idx_pdf_pages_text_search;

ALTER TABLE pdf_pages
  DROP COLUMN IF EXISTS text_search;

ALTER TABLE pdf_pages
  ADD COLUMN IF NOT EXISTS detected_page_label TEXT,
  ADD COLUMN IF NOT EXISTS document_title TEXT,
  ADD COLUMN IF NOT EXISTS chapter TEXT,
  ADD COLUMN IF NOT EXISTS section TEXT,
  ADD COLUMN IF NOT EXISTS section_title TEXT,
  ADD COLUMN IF NOT EXISTS page_type TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS structured_page_json JSONB,
  ADD COLUMN IF NOT EXISTS page_level_search_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS page_level_summary TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS extraction_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS extraction_warnings TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS extraction_model TEXT,
  ADD COLUMN IF NOT EXISTS extraction_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingestion_version TEXT,
  ADD COLUMN IF NOT EXISTS embedding_source TEXT,
  ADD COLUMN IF NOT EXISTS embedding_dim INTEGER,
  ADD COLUMN IF NOT EXISTS full_pdf_bucket TEXT,
  ADD COLUMN IF NOT EXISTS full_pdf_path TEXT,
  ADD COLUMN IF NOT EXISTS full_pdf_uri TEXT,
  ADD COLUMN IF NOT EXISTS full_pdf_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS full_pdf_size BIGINT,
  ADD COLUMN IF NOT EXISTS full_pdf_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_bucket TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_path TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_uri TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_size BIGINT,
  ADD COLUMN IF NOT EXISTS page_asset_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS page_asset_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS page_asset_checksum_sha256 TEXT,
  DROP COLUMN IF EXISTS ocr_text,
  DROP COLUMN IF EXISTS ocr_provider,
  DROP COLUMN IF EXISTS ocr_source,
  DROP COLUMN IF EXISTS ocr_confidence,
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_dimensions,
  DROP COLUMN IF EXISTS embedding_model,
  DROP COLUMN IF EXISTS embedding_provider,
  DROP COLUMN IF EXISTS embedding_task_type,
  DROP COLUMN IF EXISTS embedding_created_at;

DROP TABLE IF EXISTS pdf_detected_problems;

ALTER TABLE pdf_pages
  ADD COLUMN text_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(page_level_search_text, ''))) STORED;

CREATE TABLE IF NOT EXISTS pdf_page_blocks (
  id BIGSERIAL PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES pdf_materials(material_id) ON DELETE CASCADE,
  page_id BIGINT NOT NULL REFERENCES pdf_pages(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  professor_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  reading_order INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  exact_text TEXT NOT NULL DEFAULT '',
  corrected_text TEXT NOT NULL DEFAULT '',
  math_latex TEXT[] NOT NULL DEFAULT '{}',
  math_ascii TEXT[] NOT NULL DEFAULT '{}',
  item_kind TEXT,
  item_number TEXT,
  item_label TEXT,
  canonical_item_id TEXT,
  searchable_keywords TEXT[] NOT NULL DEFAULT '{}',
  semantic_summary TEXT NOT NULL DEFAULT '',
  relationships JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC,
  ingestion_version TEXT NOT NULL DEFAULT 'gemini_structured_page_v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (material_id, page_number, block_id)
);

CREATE TABLE IF NOT EXISTS content_embeddings (
  id BIGSERIAL PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES pdf_materials(material_id) ON DELETE CASCADE,
  page_id BIGINT REFERENCES pdf_pages(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  professor_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('block', 'learning_object', 'page', 'section')),
  source_id TEXT NOT NULL,
  embedding_level TEXT NOT NULL CHECK (embedding_level IN ('block', 'learning_object', 'page', 'section')),
  embedding_text TEXT NOT NULL,
  embedding VECTOR(1536),
  embedding_dim INTEGER NOT NULL DEFAULT 1536,
  embedding_model TEXT,
  embedding_provider TEXT,
  embedding_source TEXT NOT NULL DEFAULT 'structured_page_json',
  embedding_task_type TEXT,
  embedding_created_at TIMESTAMPTZ,
  ingestion_version TEXT NOT NULL DEFAULT 'gemini_structured_page_v1',
  block_id TEXT,
  block_type TEXT,
  reading_order INTEGER,
  object_id TEXT,
  object_type TEXT,
  title TEXT,
  label TEXT,
  related_block_ids TEXT[] NOT NULL DEFAULT '{}',
  item_kind TEXT,
  item_number TEXT,
  item_label TEXT,
  canonical_item_id TEXT,
  section TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdf_materials_class_professor
  ON pdf_materials (class_id, professor_id);

CREATE INDEX IF NOT EXISTS idx_pdf_materials_material_type
  ON pdf_materials (class_id, material_type);

CREATE INDEX IF NOT EXISTS idx_pdf_materials_storage_object
  ON pdf_materials (storage_bucket, storage_path);

CREATE INDEX IF NOT EXISTS idx_pdf_materials_full_pdf_storage
  ON pdf_materials (full_pdf_bucket, full_pdf_path)
  WHERE full_pdf_path <> '';

CREATE INDEX IF NOT EXISTS idx_pdf_materials_title_search
  ON pdf_materials USING GIN (to_tsvector('english', coalesce(title, '')));

CREATE INDEX IF NOT EXISTS idx_pdf_pages_material_page
  ON pdf_pages (material_id, page_number);

CREATE INDEX IF NOT EXISTS idx_pdf_pages_page_asset_storage
  ON pdf_pages (page_asset_storage_bucket, page_asset_storage_path)
  WHERE page_asset_storage_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pdf_pages_canonical_page_asset_storage
  ON pdf_pages (page_asset_bucket, page_asset_path)
  WHERE page_asset_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pdf_pages_class_professor
  ON pdf_pages (class_id, professor_id);

CREATE INDEX IF NOT EXISTS idx_pdf_pages_text_search
  ON pdf_pages USING GIN (text_search);

CREATE INDEX IF NOT EXISTS idx_pdf_pages_structured_ingestion
  ON pdf_pages (material_id, ingestion_version);

CREATE INDEX IF NOT EXISTS idx_pdf_pages_structured_checksum_cache
  ON pdf_pages (page_asset_checksum_sha256, ingestion_version)
  WHERE structured_page_json IS NOT NULL
    AND page_asset_checksum_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pdf_page_blocks_page_order
  ON pdf_page_blocks (material_id, page_number, reading_order);

CREATE INDEX IF NOT EXISTS idx_pdf_page_blocks_item
  ON pdf_page_blocks (material_id, item_kind, item_number)
  WHERE item_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_embeddings_material_level
  ON content_embeddings (material_id, embedding_level);

CREATE INDEX IF NOT EXISTS idx_content_embeddings_class_professor
  ON content_embeddings (class_id, professor_id);

CREATE INDEX IF NOT EXISTS idx_content_embeddings_source
  ON content_embeddings (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_content_embeddings_hnsw
  ON content_embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
