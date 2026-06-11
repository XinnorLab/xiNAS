/**
 * Support-bundle redaction (S7 T7, ADR-0009 §Bundle).
 *
 * scrubSecrets runs over every TEXT artifact the bundle collects
 * (journal lines, config copies, the api staging file is structured
 * and pre-filtered). Patterns:
 *  - Bearer/Authorization tokens → `Bearer ***`
 *  - token/secret/password key-value assignments → `key=***`
 *
 * The raw `xicli license show` output never reaches the bundle at all
 * (parsed-only at the collection seam) — redaction is the second
 * fence, not the first.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // 'Authorization: Bearer <tok>' / 'Authorization: <tok>' / 'Bearer <tok>'
  // — longest alternative FIRST so the combined form is consumed whole.
  [/\b(Authorization:?\s+Bearer|Authorization:?|Bearer)\s+\S+/gi, '$1 ***'],
  // key=value and key: value forms for credential-ish keys
  [/\b(token|secret|password|passwd|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2***'],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Paths that must NEVER be collected (token material lives here). */
export const FORBIDDEN_CONFIG_PREFIXES = ['/etc/xinas-api', '/etc/xinas-agent'];

export function isForbiddenConfigPath(path: string): boolean {
  return FORBIDDEN_CONFIG_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Leak detector for the bundle's VERIFY stage: returns the matches a
 * scrub SHOULD have removed. Empty array = clean.
 */
export function findSecretLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const re of [
    /\b(?:Authorization:?\s+Bearer|Authorization:?|Bearer)\s+\S+/gi,
    /\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S+/gi,
  ]) {
    const m = text.match(re);
    if (m === null) continue;
    // a scrubbed credential ends in '***' (alternation backtracking makes
    // an inline lookahead unreliable here — post-filter instead)
    leaks.push(...m.filter((hit) => !hit.trimEnd().endsWith('***')));
  }
  return leaks;
}
