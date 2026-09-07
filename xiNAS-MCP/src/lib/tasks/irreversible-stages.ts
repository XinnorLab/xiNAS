/**
 * Per operation kind: the stage at whose START the operation can no longer
 * be safely unwound, and the long-running stage whose progress cannot be
 * measured (S16 §9.2/§9.4, ADR-0012 §9).
 *
 * Both processes read this one table — the agent executor to declare
 * `irreversible_from`, the api's MCP projection to render the
 * point-of-no-return and long-stage notes — the `stage-names.ts` pattern,
 * so a name cannot drift between the two sides.
 */

export const IRREVERSIBLE_STAGE_BY_KIND: Readonly<Record<string, string>> = {
  'fs.create': 'mkfs',
};

/** Human verb for `statusMessage`: "cancellation can no longer safely stop <verb>". */
export const IRREVERSIBLE_STAGE_VERB: Readonly<Record<string, string>> = {
  'fs.create': 'formatting',
};

/** The stage that dominates the operation's duration and reports no progress. */
export const LONG_STAGE_BY_KIND: Readonly<Record<string, string>> = {
  'fs.create': 'mkfs',
};

export const LONG_STAGE_NOTE: Readonly<Record<string, string>> = {
  'fs.create': 'mkfs.xfs does not report a completion percentage',
};
