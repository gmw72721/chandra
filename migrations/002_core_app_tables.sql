CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_normalized TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'assistant', 'system')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  legacy_class_id TEXT,
  legacy_class_ids TEXT[] NOT NULL DEFAULT '{}',
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_normalized
  ON accounts (email_normalized);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  teacher_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  join_code TEXT UNIQUE,
  student_chat_enabled BOOLEAN NOT NULL DEFAULT true,
  student_prompt_placeholder TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  theme_color TEXT NOT NULL DEFAULT '',
  answer_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  privacy_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_format JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  tutor_access JSONB NOT NULL DEFAULT '{}'::jsonb,
  behavior_title TEXT NOT NULL DEFAULT '',
  behavior_instructions TEXT NOT NULL DEFAULT '',
  default_assignment_context TEXT NOT NULL DEFAULT '',
  opening_message TEXT NOT NULL DEFAULT '',
  refusal_style TEXT NOT NULL DEFAULT '',
  student_facing_instructions TEXT NOT NULL DEFAULT '',
  firestore_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_classes_teacher_id
  ON classes (teacher_id);

CREATE INDEX IF NOT EXISTS idx_classes_join_code
  ON classes (join_code)
  WHERE join_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS class_enrollments (
  id BIGSERIAL PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  student_email TEXT NOT NULL DEFAULT '',
  student_email_normalized TEXT GENERATED ALWAYS AS (lower(student_email)) STORED,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'removed')),
  chat_blocked BOOLEAN NOT NULL DEFAULT false,
  firestore_document_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_enrollments_class_student
  ON class_enrollments (class_id, student_id)
  WHERE student_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_enrollments_class_student_email
  ON class_enrollments (class_id, student_email_normalized)
  WHERE student_email <> '';

CREATE TABLE IF NOT EXISTS co_teachers (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'removed')),
  invited_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (class_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_co_teachers_teacher_id
  ON co_teachers (teacher_id);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  material_type TEXT NOT NULL DEFAULT '',
  source_mode TEXT NOT NULL DEFAULT 'pasted',
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'failed', 'deleted')),
  active_for_students BOOLEAN NOT NULL DEFAULT false,
  citations_required BOOLEAN NOT NULL DEFAULT false,
  teacher_only BOOLEAN NOT NULL DEFAULT false,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('primary', 'normal', 'low')),
  file_name TEXT,
  content_type TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  character_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  storage_bucket TEXT,
  storage_path TEXT,
  storage_uri TEXT,
  file_url TEXT,
  search_metadata_source TEXT NOT NULL DEFAULT 'firestore',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_materials_class_status
  ON materials (class_id, status);

CREATE INDEX IF NOT EXISTS idx_materials_storage_object
  ON materials (storage_bucket, storage_path)
  WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS material_jobs (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  detail TEXT NOT NULL DEFAULT '',
  error TEXT,
  completed_chunks INTEGER,
  total_chunks INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_material_jobs_class_updated
  ON material_jobs (class_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS material_upload_sessions (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,
  teacher_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'cancelled', 'expired')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_material_upload_sessions_class
  ON material_upload_sessions (class_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  student_email TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL DEFAULT '',
  teacher_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  teacher_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  assignment TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conversations_class_student
  ON conversations (class_id, student_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_class_updated
  ON conversations (class_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'assistant', 'system')),
  content TEXT NOT NULL DEFAULT '',
  model_id TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieval_confidence JSONB,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  structured_output JSONB,
  debug_info JSONB,
  langgraph_trace JSONB,
  learning_strategy_telemetry JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('image', 'pdf')),
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  storage_bucket TEXT,
  storage_path TEXT,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('uploading', 'ready', 'failed')),
  extracted_text TEXT,
  page_count INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, message_id) REFERENCES messages(conversation_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_conversation
  ON message_attachments (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS student_feedback (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  student_email TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('general', 'prompted', 'usage_request')),
  prompt_reason TEXT,
  rating TEXT,
  comment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved')),
  teacher_note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_feedback_class_status
  ON student_feedback (class_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS student_learning_profiles (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  student_email TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL DEFAULT '',
  active_profile JSONB,
  draft_profile JSONB,
  confidence TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  disabled BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_learning_profiles_class_student
  ON student_learning_profiles (class_id, student_id)
  WHERE student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS learning_profile_revisions (
  id BIGSERIAL PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES student_learning_profiles(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  revision_type TEXT NOT NULL CHECK (revision_type IN ('draft_generated', 'draft_saved', 'approved', 'disabled', 'cleared')),
  previous_profile JSONB,
  next_profile JSONB,
  confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_profile_revisions_profile
  ON learning_profile_revisions (profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_reviews (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'needs_follow_up', 'resolved')),
  teacher_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS student_support (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  student_email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  chat_blocked BOOLEAN NOT NULL DEFAULT false,
  support_notes TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_support_class_student
  ON student_support (class_id, student_id)
  WHERE student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_usage_reservations (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  student_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher')),
  provider TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_total_tokens INTEGER NOT NULL DEFAULT 0,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_total_tokens INTEGER,
  bucket_ids TEXT[] NOT NULL DEFAULT '{}',
  request_bucket_ids TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_reservations_user_created
  ON ai_usage_reservations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  reservation_id TEXT REFERENCES ai_usage_reservations(id) ON DELETE SET NULL,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher')),
  provider TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'failed', 'adjusted')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_created
  ON ai_usage_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_anchors (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  anchor_at TIMESTAMPTZ NOT NULL,
  day_anchor_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  week_anchor_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, student_id)
);

ALTER TABLE ai_usage_anchors
  ADD COLUMN IF NOT EXISTS day_anchor_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS week_anchor_at TIMESTAMPTZ;

UPDATE ai_usage_anchors
SET day_anchor_at = COALESCE(day_anchor_at, anchor_at),
  week_anchor_at = COALESCE(week_anchor_at, anchor_at)
WHERE day_anchor_at IS NULL OR week_anchor_at IS NULL;

ALTER TABLE ai_usage_anchors
  ALTER COLUMN day_anchor_at SET NOT NULL,
  ALTER COLUMN day_anchor_at SET DEFAULT now(),
  ALTER COLUMN week_anchor_at SET NOT NULL,
  ALTER COLUMN week_anchor_at SET DEFAULT now();

CREATE TABLE IF NOT EXISTS ai_usage_buckets (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('student', 'ip')),
  scope_hash TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('fiveMinute', 'hour', 'day', 'week')),
  limit_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  actual_input_tokens INTEGER NOT NULL DEFAULT 0,
  actual_output_tokens INTEGER NOT NULL DEFAULT 0,
  actual_total_tokens INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_buckets_scope_period
  ON ai_usage_buckets (scope, scope_hash, period, bucket_key);

CREATE TABLE IF NOT EXISTS ai_usage_request_buckets (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
  scope TEXT NOT NULL CHECK (scope IN ('student', 'teacherPreview', 'class')),
  scope_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day', 'week')),
  day_bucket TEXT NOT NULL,
  limit_requests INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_total_tokens INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage_request_buckets
  ADD COLUMN IF NOT EXISTS period TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day', 'week'));

UPDATE ai_usage_request_buckets
SET period = 'week'
WHERE id LIKE '%\_week\_%' ESCAPE '\';

DROP INDEX IF EXISTS idx_ai_usage_request_buckets_scope_day;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_request_buckets_scope_period
  ON ai_usage_request_buckets (scope, scope_hash, provider, model_id, period, day_bucket);

CREATE TABLE IF NOT EXISTS ai_usage_allowances (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  day_bucket TEXT NOT NULL,
  extra_tokens INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  granted_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_allowances_class_student_day
  ON ai_usage_allowances (class_id, student_id, day_bucket)
  WHERE class_id IS NOT NULL AND student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  actor_role TEXT,
  event_type TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  route TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  route TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_created
  ON security_events (created_at DESC);

CREATE TABLE IF NOT EXISTS chat_error_references (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  provider TEXT,
  model_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_key TEXT NOT NULL,
  limit_count INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limits_namespace_key_window
  ON rate_limits (namespace, key_hash, window_key);

CREATE TABLE IF NOT EXISTS abuse_lockouts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  locked_until TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  table_name TEXT;
  trigger_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts',
    'classes',
    'class_enrollments',
    'co_teachers',
    'materials',
    'material_jobs',
    'material_upload_sessions',
    'conversations',
    'messages',
    'message_attachments',
    'student_feedback',
    'student_learning_profiles',
    'conversation_reviews',
    'student_support',
    'ai_usage_reservations',
    'ai_usage_anchors',
    'ai_usage_buckets',
    'ai_usage_request_buckets',
    'ai_usage_allowances',
    'chat_error_references',
    'rate_limits',
    'abuse_lockouts'
  ]
  LOOP
    trigger_name := 'set_' || table_name || '_updated_at';
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trigger_name) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('pdf_materials') IS NOT NULL THEN
    COMMENT ON TABLE pdf_materials IS
      'Structured PDF metadata table. material_id is intentionally named to align with materials.id after the materials backfill.';
    COMMENT ON COLUMN pdf_materials.class_id IS
      'Intended to align with classes.id after the classes backfill.';
    COMMENT ON COLUMN pdf_materials.material_id IS
      'Intended to align with materials.id after the materials backfill.';
  END IF;
END $$;

-- Future validated constraints after Postgres material/class backfill:
-- ALTER TABLE pdf_materials
--   ADD CONSTRAINT pdf_materials_material_id_materials_fk
--   FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE;
-- ALTER TABLE pdf_materials
--   ADD CONSTRAINT pdf_materials_class_id_classes_fk
--   FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE;
