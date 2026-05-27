-- Initial schema for the Phase 0 state store (ADR-0003, ADR-0004).
-- Single file; future migrations land as 002-*.sql, 003-*.sql, etc.

-- Schema version tracking. The migrations runner inserts one row per
-- applied migration.
CREATE TABLE IF NOT EXISTS schema_version (
  version       INTEGER PRIMARY KEY,
  filename      TEXT    NOT NULL,
  applied_at    INTEGER NOT NULL
);

-- Generic KV table backing every /xinas/v1/... key prefix.
-- value is a serialized JSON blob; the public API deserializes.
CREATE TABLE IF NOT EXISTS kv (
  key                TEXT    PRIMARY KEY,
  value              BLOB    NOT NULL,
  revision           INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,    -- epoch ms
  modified_at        INTEGER NOT NULL,    -- epoch ms
  owner              TEXT    NOT NULL,
  source             TEXT    NOT NULL,
  validation_status  TEXT    NOT NULL CHECK (validation_status IN ('valid','drift','invalid','pending'))
);

CREATE INDEX IF NOT EXISTS kv_prefix_idx ON kv(key);
CREATE INDEX IF NOT EXISTS kv_modified_idx ON kv(modified_at);

-- Tasks per ADR-0004. Executor lands in a later PR; the schema is here so
-- the API can read/write task records via the KV layer's structured helpers.
CREATE TABLE IF NOT EXISTS tasks (
  task_id                  TEXT    PRIMARY KEY,
  kind                     TEXT    NOT NULL,
  state                    TEXT    NOT NULL,
  plan_id                  TEXT,
  idempotency_key          TEXT,
  principal                TEXT    NOT NULL,
  client_type              TEXT    NOT NULL,
  request_id               TEXT    NOT NULL,
  correlation_id           TEXT    NOT NULL,
  input_hash               TEXT    NOT NULL,
  plan_hash                TEXT,
  result_hash              TEXT,
  state_revision_expected  INTEGER,
  state_revision_at_apply  INTEGER,
  risk_level               TEXT    NOT NULL,
  affected_resources       TEXT    NOT NULL,    -- JSON array
  snapshot_before          TEXT,
  snapshot_after           TEXT,
  cancel_requested_at      INTEGER,
  cancel_refused_reason    TEXT,
  error_code               TEXT,
  error_message            TEXT,
  remediation_hint         TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  terminal_at              INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_idx
  ON tasks(idempotency_key, principal)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_state_kind_idx ON tasks(state, kind);
CREATE INDEX IF NOT EXISTS tasks_plan_idx ON tasks(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at);

-- Per-stage logs. output_inline holds the chunk when size <= 64 KiB;
-- output_path is a relative path under /var/log/xinas/tasks/<task_id>/
-- when the chunk spilled.
CREATE TABLE IF NOT EXISTS task_stages (
  stage_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  stage_index       INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  output_inline     BLOB,
  output_path       TEXT,
  output_size_bytes INTEGER NOT NULL,
  error_code        TEXT,
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS task_stages_lookup_idx ON task_stages(task_id, stage_index);

-- Leases (per ADR-0003 rename; ADR-0004 names the table 'leases').
-- One holder per (resource_kind, resource_id).
CREATE TABLE IF NOT EXISTS leases (
  lease_id        TEXT    PRIMARY KEY,
  resource_kind   TEXT    NOT NULL,
  resource_id     TEXT    NOT NULL,
  task_id         TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  acquired_at     INTEGER NOT NULL,
  ttl_seconds     INTEGER NOT NULL,
  heartbeat_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS leases_resource_idx ON leases(resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS leases_task_idx ON leases(task_id);

-- Audit outbox (ADR-0003 §Atomic audit via outbox pattern).
-- Rows are inserted in the same SQLite transaction as the state change
-- they describe. A background drainer copies pending rows to the JSONL
-- file with fsync(), then flips drain_state and fills in durable_*.
CREATE TABLE IF NOT EXISTS audit_outbox (
  audit_seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_json      BLOB    NOT NULL,
  prev_hash       BLOB    NOT NULL,
  hash            BLOB    NOT NULL,
  queued_at       INTEGER NOT NULL,
  drain_state     TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (drain_state IN ('pending','durable')),
  durable_at      INTEGER,
  durable_file    TEXT,
  durable_offset  INTEGER
);

CREATE INDEX IF NOT EXISTS audit_outbox_pending_idx ON audit_outbox(drain_state, audit_seq)
  WHERE drain_state = 'pending';

-- Audit index for fast lookup of entries by request_id / operation_id /
-- task_id. Points into the JSONL once drained.
CREATE TABLE IF NOT EXISTS audit_index (
  request_id      TEXT,
  operation_id    TEXT,
  task_id         TEXT,
  audit_seq       INTEGER NOT NULL REFERENCES audit_outbox(audit_seq),
  durable_file    TEXT,
  durable_offset  INTEGER
);

CREATE INDEX IF NOT EXISTS audit_index_request_idx ON audit_index(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_index_operation_idx ON audit_index(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_index_task_idx ON audit_index(task_id) WHERE task_id IS NOT NULL;
