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
  ocr_provider TEXT NOT NULL,
  ocr_source TEXT NOT NULL,
  ocr_confidence NUMERIC,
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
  ocr_text TEXT NOT NULL DEFAULT '',
  ocr_provider TEXT NOT NULL,
  ocr_source TEXT NOT NULL,
  ocr_confidence NUMERIC,
  embedding VECTOR(768),
  embedding_dimensions INTEGER,
  embedding_model TEXT,
  embedding_provider TEXT,
  embedding_task_type TEXT,
  embedding_created_at TIMESTAMPTZ,
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
  text_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(ocr_text, ''))) STORED,
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
  ADD COLUMN IF NOT EXISTS full_pdf_sha256 TEXT;

ALTER TABLE pdf_pages
  ADD COLUMN IF NOT EXISTS embedding VECTOR(768),
  ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_provider TEXT,
  ADD COLUMN IF NOT EXISTS embedding_task_type TEXT,
  ADD COLUMN IF NOT EXISTS embedding_created_at TIMESTAMPTZ,
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
  ADD COLUMN IF NOT EXISTS page_asset_checksum_sha256 TEXT;

CREATE TABLE IF NOT EXISTS pdf_detected_problems (
  id BIGSERIAL PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES pdf_materials(material_id) ON DELETE CASCADE,
  page_id BIGINT NOT NULL REFERENCES pdf_pages(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  professor_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  material_type TEXT NOT NULL,
  problem_number TEXT NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  problem_text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  confidence NUMERIC,
  ocr_provider TEXT NOT NULL,
  ocr_source TEXT NOT NULL,
  embedding VECTOR(768),
  embedding_dimensions INTEGER,
  embedding_model TEXT,
  embedding_provider TEXT,
  embedding_task_type TEXT,
  embedding_created_at TIMESTAMPTZ,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  text_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(problem_text, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pdf_detected_problems
  ADD COLUMN IF NOT EXISTS embedding VECTOR(768),
  ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_provider TEXT,
  ADD COLUMN IF NOT EXISTS embedding_task_type TEXT,
  ADD COLUMN IF NOT EXISTS embedding_created_at TIMESTAMPTZ;

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

CREATE INDEX IF NOT EXISTS idx_pdf_pages_embedding_hnsw
  ON pdf_pages USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pdf_detected_problems_material_problem
  ON pdf_detected_problems (material_id, problem_number);

CREATE INDEX IF NOT EXISTS idx_pdf_detected_problems_class_professor
  ON pdf_detected_problems (class_id, professor_id);

CREATE INDEX IF NOT EXISTS idx_pdf_detected_problems_page_range
  ON pdf_detected_problems (material_id, page_start, page_end);

CREATE INDEX IF NOT EXISTS idx_pdf_detected_problems_text_search
  ON pdf_detected_problems USING GIN (text_search);

CREATE INDEX IF NOT EXISTS idx_pdf_detected_problems_embedding_hnsw
  ON pdf_detected_problems USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
