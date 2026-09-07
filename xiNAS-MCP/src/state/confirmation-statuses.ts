/**
 * S15 Task 14 fix round 1 (F2) — the full `mcp_confirmations.status` union
 * and its terminal subset, owned by `state/` rather than
 * `api/mcp/confirmation/types.ts`. `state/gc.ts` needs
 * `TERMINAL_CONFIRMATION_STATUSES` to build its terminal-row prune
 * statement, and `state/` must never import from `api/` — `state/` is the
 * lower layer that `api/` depends on, never the reverse (this was, before
 * this fix, the only `state/` → `api/` edge in the tree).
 *
 * Mirrors the CHECK constraint on `mcp_confirmations.status` in
 * `state/migrations/006-mcp-confirmations.sql` — keep both in sync.
 * `api/mcp/confirmation/types.ts` re-exports both symbols below so every
 * existing importer (store.ts, service.ts, routes, tests) keeps working
 * unchanged.
 */
export const CONFIRMATION_STATUSES = [
  'pending',
  'approved',
  'declined',
  'cancelled',
  'expired',
  'consumed',
] as const;

export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const TERMINAL_CONFIRMATION_STATUSES: ReadonlySet<ConfirmationStatus> = new Set([
  'declined',
  'cancelled',
  'expired',
  'consumed',
]);
