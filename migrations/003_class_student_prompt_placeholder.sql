ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS student_prompt_placeholder TEXT NOT NULL DEFAULT '';
