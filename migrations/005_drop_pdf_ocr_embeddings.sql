DROP INDEX IF EXISTS idx_pdf_pages_embedding_hnsw;
DROP INDEX IF EXISTS idx_pdf_detected_problems_embedding_hnsw;

ALTER TABLE IF EXISTS pdf_pages
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_dimensions,
  DROP COLUMN IF EXISTS embedding_model,
  DROP COLUMN IF EXISTS embedding_provider,
  DROP COLUMN IF EXISTS embedding_task_type,
  DROP COLUMN IF EXISTS embedding_created_at;

ALTER TABLE IF EXISTS pdf_detected_problems
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_dimensions,
  DROP COLUMN IF EXISTS embedding_model,
  DROP COLUMN IF EXISTS embedding_provider,
  DROP COLUMN IF EXISTS embedding_task_type,
  DROP COLUMN IF EXISTS embedding_created_at;
