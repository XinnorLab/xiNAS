/**
 * JCS-style canonical JSON: recursive key sort + no whitespace + UTF-8.
 *
 * Layer-neutral shared helper (lives under `src/lib/*` so both the api and
 * state layers may import it without a cross-layer reach). Feeds sha256 hashes
 * that MUST be byte-identical across processes:
 *   - the audit hash chain (`state/audit.ts`), and
 *   - the plan engine's `input_hash` / `plan_hash` (`api/plan/engine.ts`).
 *
 * A naive `Object.keys(x).sort()` loses nesting and silently breaks those
 * hashes when a nested payload's key order flips, so the sort is applied
 * recursively via the `JSON.stringify` replacer.
 *
 * The `!(v instanceof Buffer)` guard is the SUPERSET behavior: audit payloads
 * can carry binary `Buffer` values that must not be treated as plain objects to
 * key-sort, while plan inputs are always JSON specs + resolved revisions (no
 * Buffers), so the guard is simply inert there. Keeping the one guarded
 * implementation means both callers hash identically to their prior local copies
 * — this is a pure refactor with no observable hash change.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Buffer)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
