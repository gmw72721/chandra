# Data Architecture

Chandra is now organized around a Postgres-first data model. Firebase still provides identity and file storage, while Firestore remains available for legacy fallback reads and presence compatibility during the cutover.

## Target Split

- Firebase Auth remains the identity provider. Firebase UID is stored on `accounts.firebase_uid` as the stable link to authenticated users.
- Firebase Storage and GCS remain the file/object store for uploaded class materials, PDF OCR inputs, generated OCR artifacts, and chat attachments.
- Postgres and Cloud SQL become the source of truth for application data, reporting, search metadata, quota accounting, audit history, and durable student/teacher workflows.
- Firestore remains available as a legacy fallback during migration. Client presence (`userPresence`) can stay in Firestore until a later phase replaces or narrows that path.

## Migration Status

Implemented phases:

- `migrations/002_core_app_tables.sql`, covering accounts, classes, roster/enrollment data, teacher invites, materials, upload/job metadata, conversations, messages, attachments, feedback, learning profiles, reviews, support notes, AI usage, audit/security records, rate limits, and lockouts.
- `frontend/lib/data/postgres.ts`, the shared `pg` pool/config/transaction helper for app data and health checks.
- Postgres-first modules under `frontend/lib/data/` for accounts, classes, materials, conversations, student records, usage accounting, operational logs, rate limits, lockouts, and teacher invites.
- Account/profile, class, roster, co-teacher, material metadata, conversation, message, attachment metadata, feedback, learning profile, support, review, usage, invite, audit/security, and chat-error workflows now try Postgres first.
- Firestore fallback code remains in place for legacy data and production rollback safety.
- API response shapes and UI contracts are intentionally unchanged.

## Existing PDF OCR Tables

The existing `pdf_materials`, `pdf_pages`, and `pdf_detected_problems` tables remain in place. They continue to serve searchable PDF OCR/page/problem metadata.

The core schema adds `materials` and keeps IDs aligned so `pdf_materials.material_id` maps directly to `materials.id`, while `pdf_materials.class_id` maps to `classes.id`. PDF OCR/search metadata remains in Postgres and is checked by `/api/health`.

## Applying SQL Migrations

Apply migrations in order against the Cloud SQL/Postgres database configured by `DATABASE_URL`, `CLOUD_SQL_POSTGRES_URL`, or `CHANDRA_CLOUD_SQL_POSTGRES_URL`:

```bash
psql "$DATABASE_URL" -f migrations/001_pdf_ocr_metadata.sql
psql "$DATABASE_URL" -f migrations/002_core_app_tables.sql
```

Use the Cloud SQL Auth Proxy or private network access when applying migrations from a local machine or CI runner. Re-running these migrations is safe for existing tables because they use `CREATE TABLE IF NOT EXISTS`, idempotent indexes, and guarded trigger creation.

## Legacy Backfill Plan

Backfill should be done as a controlled one-way import from Firestore into Postgres:

1. Export or page through Firestore collections in bounded batches.
2. Upsert `users` into `accounts`, then `classes`, `classes/{classId}/students`, co-teachers, materials/jobs, conversations/messages/attachments, feedback, profiles/revisions, reviews, support records, usage records, lockouts, logs, and invites.
3. Preserve original Firestore document IDs as Postgres primary keys where routes already expose those IDs.
4. Keep files in Firebase Storage/GCS and copy only metadata/storage keys into Postgres.
5. Run parity checks comparing record counts and sampled API responses.
6. Leave Firestore fallback enabled until production reads show no unexpected misses.

## Remaining Cleanup

Firestore code paths still exist for these reasons:

- `users`, `classes`, roster, materials, conversations, messages, attachments, feedback, learning profiles, reviews, support, usage, lockouts, logs, and invites: legacy fallback reads or write fallback when Postgres is not configured/unavailable.
- `userPresence`: optional realtime/presence data that is still Firestore-backed.
- Firebase Storage/GCS metadata references: files remain in object storage by design.
- Firestore security rules: retained while fallback reads and legacy clients still exist.

Once backfill and production parity are complete, the remaining cleanup is to remove Firestore fallback writes, narrow fallback reads to explicit archival/admin tooling, and keep Firestore only for presence if still needed.
