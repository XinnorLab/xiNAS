/**
 * s8-clients-spec §5.1 — observed-read degraded honesty.
 *
 * An observed-read list route returns [] when its backing collector is
 * errored; silent, that is indistinguishable from "genuinely none". This
 * helper produces a DEGRADED_BACKEND_UNAVAILABLE warning off the captured
 * per-collector health map (the same map the node degrades on): an errored
 * collector serializes as `error: <reason>`; `running` / `stubbed` are
 * healthy. No tracker (read-only contexts) → no warning.
 */

import type { ApiContext } from '../context.js';
import type { Warning } from '../envelope.js';

export function degradedCollectorWarnings(ctx: ApiContext, kind: string): Warning[] {
  const health = ctx.tracker?.currentSnapshot().collectors[kind];
  if (typeof health === 'string' && health.startsWith('error')) {
    return [
      {
        code: 'DEGRADED_BACKEND_UNAVAILABLE',
        message: `${kind} observation is degraded (${health}); the list may be empty or stale.`,
      },
    ];
  }
  return [];
}
