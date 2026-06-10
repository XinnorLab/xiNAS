/**
 * Compile a desired NFS `Share` into an `/etc/exports`-style entry the
 * `xinas-nfs-helper` consumes (its `add_export`/`update_export` ops take
 * `{ path, clients: [{ host, options }] }` — exactly this output shape).
 *
 * Layer-neutral pure module (like `lib/canonical-json.ts` / `lib/nfs-export-id.ts`):
 * lives under `src/lib/*` and imports nothing from the api or state layers, so
 * BOTH the api PlanProvider (preview `diff`) and the agent Executor (authoritative
 * apply) can import the SAME compile implementation — one compile, two importers.
 *
 * It works from the REAL OpenAPI schema: a `ShareClient` is `{ pattern, options[] }`
 * — a RAW per-client option list that is AUTHORITATIVE. `sync` and `security_mode`
 * are Share-level; they fold in per-client ONLY when the client did not already
 * specify the corresponding token. Output ordering is FIXED and deduped
 * (first-occurrence order, NOT alphabetical) so the same Share always compiles to
 * a byte-identical entry — the determinism `plan_hash` depends on.
 *
 * (s3-nfs-executor-spec §4)
 */

/** One client of a desired Share — raw, authoritative option list. */
export interface ShareClientInput {
  pattern: string;
  options: string[];
}

/** The desired-state inputs this module needs from a Share (kept local — no api import). */
export interface ShareCompileInput {
  path: string;
  clients: ShareClientInput[];
  sync?: 'sync' | 'async';
  /** 'sys' | 'krb5' | 'krb5i' | 'krb5p'. 'sys' (or absent) emits no sec= token. */
  security_mode?: string;
}

/** One compiled client line: helper `host` + the final option list. */
export interface ExportEntryClient {
  host: string;
  options: string[];
}

/** The compiled export entry — the exact shape `add_export`/`update_export` consume. */
export interface ExportEntry {
  path: string;
  clients: ExportEntryClient[];
}

/** Dedupe preserving first-occurrence order (NOT alphabetical). */
function dedupePreservingOrder(opts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const opt of opts) {
    if (!seen.has(opt)) {
      seen.add(opt);
      out.push(opt);
    }
  }
  return out;
}

/** True if `opts` already carries any of `tokens` (exact match). */
function hasAny(opts: string[], tokens: readonly string[]): boolean {
  return opts.some((o) => tokens.includes(o));
}

/**
 * Compile one client: start from its authoritative `options[]`, fold in the
 * Share-level defaults in a FIXED order only when the client did not already
 * specify them, then dedupe preserving first-occurrence order.
 */
function compileClient(client: ShareClientInput, share: ShareCompileInput): ExportEntryClient {
  // 1. Client options are authoritative — start from them verbatim.
  const opts = [...client.options];

  // 2. sync/async — fold the Share-level value (default 'async') only if the
  //    client did not pick one. The client always wins (no duplicate token).
  if (!hasAny(opts, ['sync', 'async'])) {
    opts.push(share.sync ?? 'async');
  }

  // 3. security: sec= only for a non-'sys' mode and only if the client has no sec=.
  if (
    share.security_mode &&
    share.security_mode !== 'sys' &&
    !opts.some((o) => o.startsWith('sec='))
  ) {
    opts.push(`sec=${share.security_mode}`);
  }

  // 4. hardening default — no_subtree_check unless the client chose either subtree variant.
  if (!hasAny(opts, ['subtree_check', 'no_subtree_check'])) {
    opts.push('no_subtree_check');
  }

  // 5. Determinism: dedupe preserving the user's option order, then the folded defaults.
  return { host: client.pattern, options: dedupePreservingOrder(opts) };
}

/**
 * Turn a desired Share into the `/etc/exports`-style entry the nfs-helper
 * consumes. Each client is compiled independently; client order is preserved.
 */
export function compileShareToExportEntry(share: ShareCompileInput): ExportEntry {
  return {
    path: share.path,
    clients: share.clients.map((client) => compileClient(client, share)),
  };
}

/**
 * Project a raw Share operation spec (the shape the route forwards — a
 * superset of the compile inputs) onto {@link ShareCompileInput}. One
 * projection, two importers: the api PlanProvider (preview `diff`) and the
 * agent Executor (authoritative apply) both call this, so the compiled entry
 * is byte-identical on both sides. Conditional spread keeps absent optional
 * fields ABSENT (not `undefined`-valued) for canonical-JSON determinism.
 */
export function shareSpecToCompileInput(spec: {
  path: string;
  clients: Array<{ pattern: string; options: string[] }>;
  sync?: 'sync' | 'async';
  security_mode?: string;
}): ShareCompileInput {
  return {
    path: spec.path,
    clients: spec.clients.map((c) => ({ pattern: c.pattern, options: c.options })),
    ...(spec.sync !== undefined ? { sync: spec.sync } : {}),
    ...(spec.security_mode !== undefined ? { security_mode: spec.security_mode } : {}),
  };
}
