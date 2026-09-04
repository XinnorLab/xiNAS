-- 006 (S15, docs/control-path/s15-mcp-mrtr-confirmation-spec.md §5, §6):
-- the persisted public plan and the MCP apply-confirmation records.
-- Additive only; version-gated by state/migrations.ts (each ALTER runs once).

-- The public Plan exactly as rendered to the client (JSON) + its own
-- sha256 over canonical JSON. NULL for plan_only rows created before 006;
-- such plans cannot be confirmed over MCP (PRECONDITION_FAILED
-- plan_predates_confirmation) — REST/CLI applies are unaffected.
ALTER TABLE tasks ADD COLUMN plan_document TEXT;
ALTER TABLE tasks ADD COLUMN plan_document_hash TEXT;

-- One row per MCP apply confirmation. The api is the sole writer. Timestamps
-- are epoch ms. request_state_nonce_hash is sha256(nonce) — the nonce itself
-- travels only inside the client-held requestState.
CREATE TABLE IF NOT EXISTS mcp_confirmations (
  confirmation_id          TEXT    PRIMARY KEY,
  status                   TEXT    NOT NULL
                             CHECK (status IN ('pending','approved','declined','cancelled','expired','consumed')),
  mode                     TEXT    NOT NULL CHECK (mode IN ('form','url')),
  principal                TEXT    NOT NULL,
  role                     TEXT    NOT NULL,
  tool_name                TEXT    NOT NULL,
  operation_kind           TEXT    NOT NULL,
  arguments_hash           TEXT    NOT NULL,
  plan_id                  TEXT    NOT NULL,
  plan_hash                TEXT    NOT NULL,
  plan_document_hash       TEXT    NOT NULL,
  idempotency_key          TEXT    NOT NULL,
  expected_revision        INTEGER NOT NULL,
  risk_level               TEXT    NOT NULL,
  rollback_model           TEXT    NOT NULL,
  request_state_nonce_hash TEXT    NOT NULL,
  round                    INTEGER NOT NULL DEFAULT 1,
  created_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  approved_at              INTEGER,
  approved_by              TEXT,
  approval_channel         TEXT,    -- verified: mcp_form | bearer | uds_break_glass
  approval_interface       TEXT,    -- untrusted UI label: web | rest
  declined_at              INTEGER,
  declined_by              TEXT,
  decision_reason          TEXT,
  consumed_at              INTEGER,
  consumed_task_id         TEXT,
  expired_reason           TEXT,
  correlation_id           TEXT    NOT NULL,
  request_id               TEXT    NOT NULL,
  node_id                  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_confirmations_principal_status_idx
  ON mcp_confirmations(principal, status);
CREATE INDEX IF NOT EXISTS mcp_confirmations_status_expires_idx
  ON mcp_confirmations(status, expires_at);
-- A task is produced by at most one confirmation (spec §6.1, §8.3).
CREATE UNIQUE INDEX IF NOT EXISTS mcp_confirmations_consumed_task_idx
  ON mcp_confirmations(consumed_task_id)
  WHERE consumed_task_id IS NOT NULL;
