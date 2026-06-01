import type { Warning } from '../envelope.js';

/**
 * Merge handler-local warnings with system-level warnings injected by
 * systemWarningsMiddleware. Called by sendOk() and errorMiddleware()
 * so every envelope — success or error — carries the combined set.
 *
 * System warnings (e.g., EXECUTOR_DEGRADED) appear after handler
 * warnings so the handler's intent is first in the array.
 */
export function mergeWarnings(handlerWarnings: Warning[], systemWarnings: Warning[]): Warning[] {
  if (systemWarnings.length === 0) return handlerWarnings;
  if (handlerWarnings.length === 0) return systemWarnings;
  return [...handlerWarnings, ...systemWarnings];
}
