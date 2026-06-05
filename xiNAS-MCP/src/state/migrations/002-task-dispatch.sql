-- S2 task engine: dispatch-tracking columns on `tasks` (ADR-0004,
-- s2-task-envelope-spec §9). Additive only.
--
-- Idempotency: the migrations runner (state/migrations.ts) gates by
-- schema_version, so this file is applied exactly once. SQLite does not
-- support `ADD COLUMN IF NOT EXISTS`, so the runner's version gate is what
-- guarantees these ALTERs do not run twice.

-- Opaque token the agent returns from `task.begin` when it accepts and starts
-- executing the task. NULL until the agent accepts; the S2 reconciler uses it
-- to tell "begin landed" from "begin never took" after a restart.
ALTER TABLE tasks ADD COLUMN agent_acceptance_id TEXT;

-- Per-task monotonic high-water mark for the progress receiver (later task):
-- a TaskProgressEvent with sequence <= this value is an idempotent replay.
ALTER TABLE tasks ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT 0;

-- Make `(task_id, stage_index)` a hard key: duplicate stage rows are then
-- impossible at the DB level. 001 created only a NON-unique lookup index on
-- these columns, so TaskStore.upsertStage relied on xinas-api being the single
-- SQLite writer (ADR-0002) for its no-duplicate guarantee. This index is the
-- defense-in-depth backstop that holds regardless of the writer model.
CREATE UNIQUE INDEX IF NOT EXISTS task_stages_unique_idx ON task_stages(task_id, stage_index);
