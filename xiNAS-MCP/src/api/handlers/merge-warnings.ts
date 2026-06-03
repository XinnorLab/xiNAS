import type { Warning } from '../envelope.js';

/**
 * Merge handler-local warnings with system-level warnings injected by
 * systemWarningsMiddleware. Called by sendOk() and errorMiddleware()
 * so every envelope — success or error — carries the combined set.
 *
 * System warnings (e.g., EXECUTOR_DEGRADED) appear after handler
 * warnings so the handler's intent is first in the array.
 *
 * De-duplicates by `code`, keeping the first occurrence of each code
 * so that a warning emitted by both a handler and the middleware
 * appears only once in the envelope.
 */
export function mergeWarnings(handlerWarnings: Warning[], systemWarnings: Warning[]): Warning[] {
  const combined = [...handlerWarnings, ...systemWarnings];
  const seen = new Set<string>();
  return combined.filter((w) => {
    if (seen.has(w.code)) return false;
    seen.add(w.code);
    return true;
  });
}
