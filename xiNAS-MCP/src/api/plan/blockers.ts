/**
 * Plan blocker codes shared across the api layer.
 *
 * `dangerous_flag_required` is an **advisory** blocker: providers emit it on
 * a destructive plan so the diff says out loud what the apply will need, but
 * it never blocks on its own — `TaskEngine.apply` enforces the real
 * `dangerous: true` flag (S15 §3.4), so every apply path filters this code
 * out of its blocker re-check. It was a bare string literal in eleven places
 * (three route files, two providers, the engine and the MCP confirmation
 * service, on both the producing and the filtering side); one typo in a
 * filter would have silently blocked every destructive apply on that route.
 *
 * The one producer NOT importing this constant is `lib/fs/validate.ts`:
 * `lib/` is pure and imports nothing from `api/`, and adding the first
 * `lib/ → api/` edge to share a string is a worse trade than the literal.
 * `plan/blockers.test.ts` pins that literal against this constant instead.
 */
export const DANGEROUS_FLAG_REQUIRED = 'dangerous_flag_required' as const;
