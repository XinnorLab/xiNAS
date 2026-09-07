-- 007 (S17, docs/control-path/s17-mcp-subscriptions-spec.md §7.1):
-- the operational-event journal and its producer-state side table.
-- Additive only; version-gated by state/migrations.ts.
--
-- `sequence` is INTEGER PRIMARY KEY AUTOINCREMENT on purpose: SQLite then
-- never reuses a value, even after rows are deleted by retention, which is
-- what makes a cursor ("everything up to sequence S") meaningful across
-- restarts. `payload` is the canonical JSON of the full EventEnvelope,
-- including `sequence`, so a read returns rows byte-for-byte as committed.
CREATE TABLE IF NOT EXISTS operational_events (
  sequence           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT    NOT NULL UNIQUE,
  controller_id      TEXT    NOT NULL,
  feed               TEXT    NOT NULL CHECK (feed IN ('raid','raid/progress','storage','nfs','nfs/sessions','system')),
  type               TEXT    NOT NULL,
  severity           TEXT    NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  detected_at        INTEGER NOT NULL,          -- epoch ms
  occurred_at        INTEGER,                   -- epoch ms, optional
  subject_kind       TEXT    NOT NULL,
  subject_id         TEXT    NOT NULL,
  dedupe_key         TEXT,
  cause_task_id      TEXT,
  cause_operation_id TEXT,
  payload            TEXT    NOT NULL           -- canonical JSON EventEnvelope
);

CREATE INDEX IF NOT EXISTS operational_events_feed_seq_idx ON operational_events(feed, sequence);
CREATE INDEX IF NOT EXISTS operational_events_detected_idx ON operational_events(detected_at);
CREATE INDEX IF NOT EXISTS operational_events_subject_idx ON operational_events(subject_kind, subject_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS operational_events_dedupe_idx ON operational_events(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Small producer state a previous-vs-current row compare cannot carry
-- (boot id, restore-pending set, debounce candidates, hysteresis levels,
-- per-kind freshness). Value is JSON.
CREATE TABLE IF NOT EXISTS operational_event_meta (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
