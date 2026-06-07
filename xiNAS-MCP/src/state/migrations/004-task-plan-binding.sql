-- S3 N0.1: persist two internal JSON columns on `tasks` (s3-task-engine §5.3).
-- Additive only.
--
-- plan_binding — plan-time data the apply step needs (e.g. the freshness ref the
-- plan observed). desired_rollback — the prior desired-KV values to revert on
-- apply failure (an array of {key, prior_value} / delete mutations). Both are
-- handled exactly like `spec` (migration 003): JSON text, NULL → omitted on read.
-- NULL for tasks created before 004.
--
-- Idempotency: the migrations runner (state/migrations.ts) gates by
-- schema_version, so each ALTER runs exactly once (SQLite has no
-- ADD COLUMN IF NOT EXISTS).
ALTER TABLE tasks ADD COLUMN plan_binding TEXT;
ALTER TABLE tasks ADD COLUMN desired_rollback TEXT;
