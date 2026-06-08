/**
 * The four real NFS executors (S3 N3.2, s3-nfs-executor-spec §3.1–3.3, §3.5).
 *
 * Replaces the inert `reference.echo` proof with imperative, per-verb NFS
 * export management driving the privileged `xinas-nfs-helper` via the typed
 * {@link NfsHelperClient} (N3.1) and recompiling the helper payload from the
 * RAW request spec through the shared, layer-neutral
 * {@link compileShareToExportEntry} (N1.1) — one compile, two importers (the
 * api PlanProvider previews the same diff; this executor authoritatively
 * applies it).
 *
 * Each executor defines ONLY its domain stages (preflight/apply/verify) plus a
 * `rollback()`; the {@link TaskRunner} wraps them with the snapshot_before/after
 * captures and the failure→rollback→terminal taxonomy. The runner passes the
 * SAME {@link ExecutorContext} (so `ctx.stash`) to every stage and to rollback,
 * which is how a preflight stage threads the prior export rule / prior idmap
 * domain into the inverse rollback op.
 *
 * Dependencies are injected ({@link NfsExecutorDeps}) so the executors are
 * test-hermetic: tests pass a fake {@link NfsHelperClient} and a fake
 * `readIdmapDomain`; production wires the real helper client + the idmapd.conf
 * reader in `wiring.ts`.
 */
import { compileShareToExportEntry, type ShareCompileInput } from '../../lib/nfs-exports.js';
import {
  type HelperExportEntry,
  NfsHelperError,
  type NfsHelperClient,
} from './nfs-helper-client.js';
import type { Executor, ExecutorContext } from './types.js';

/** Injected deps so the executors are test-hermetic (fake helper + fake reader). */
export interface NfsExecutorDeps {
  /** Typed nfs-helper write/read client the executors drive. */
  helper: NfsHelperClient;
  /** Read the current /etc/idmapd.conf Domain (undefined if unset). Injected so tests fake it. */
  readIdmapDomain: () => Promise<string | undefined>;
}

/** The raw Share spec the api forwards (T9b) — narrowed defensively below. */
interface RawShareSpec {
  id: string;
  path: string;
  clients: Array<{ pattern: string; options: string[] }>;
  fsid?: string;
  security_mode?: string;
  sync?: 'sync' | 'async';
  rdma_enabled?: boolean;
  nfs_versions?: string[];
}

/** The raw idmap spec the api forwards for `nfs-idmap.set`. */
interface RawDomainSpec {
  domain: string;
}

/** Stash key under which preflight captures the prior export entry (or null). */
const STASH_PRIOR_ENTRY = 'priorEntry';
/** Stash key under which preflight captures the prior idmap domain (or undefined). */
const STASH_PRIOR_DOMAIN = 'priorDomain';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Narrow the opaque `ctx.spec` to a Share spec, throwing a clear error if its
 * shape is wrong (path must be a non-empty string; `clients` a non-empty array
 * of `{ pattern, options }`). For `share.delete` only `{ id, path }` is sent, so
 * `requireClients=false` skips the clients check.
 */
function readShareSpec(spec: unknown, requireClients = true): RawShareSpec {
  if (!isRecord(spec)) {
    throw new Error('nfs-executor: spec is not an object');
  }
  const { path } = spec as { path?: unknown };
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('nfs-executor: spec.path must be a non-empty string');
  }
  if (requireClients) {
    const { clients } = spec as { clients?: unknown };
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new Error('nfs-executor: spec.clients must be a non-empty array');
    }
    for (const c of clients) {
      if (
        !isRecord(c) ||
        typeof (c as { pattern?: unknown }).pattern !== 'string' ||
        !Array.isArray((c as { options?: unknown }).options)
      ) {
        throw new Error('nfs-executor: each spec.clients[] must be { pattern, options[] }');
      }
    }
  }
  return spec as unknown as RawShareSpec;
}

/** Narrow the opaque `ctx.spec` to a `{ domain }`, throwing if `domain` is missing. */
function readDomainSpec(spec: unknown): RawDomainSpec {
  if (!isRecord(spec) || typeof (spec as { domain?: unknown }).domain !== 'string') {
    throw new Error('nfs-executor: spec.domain must be a string');
  }
  return spec as unknown as RawDomainSpec;
}

/** Map a RawShareSpec onto the shared compiler's input (Share-level fields fold per-client). */
function toCompileInput(spec: RawShareSpec): ShareCompileInput {
  return {
    path: spec.path,
    clients: spec.clients.map((c) => ({ pattern: c.pattern, options: c.options })),
    ...(spec.sync !== undefined ? { sync: spec.sync } : {}),
    ...(spec.security_mode !== undefined ? { security_mode: spec.security_mode } : {}),
  };
}

/** Find the live export entry for `path` in a `list_exports` result, or null. */
function findEntry(entries: HelperExportEntry[], path: string): HelperExportEntry | null {
  return entries.find((e) => e.path === path) ?? null;
}

/**
 * Narrow a value stashed at preflight back to a {@link HelperExportEntry}, or
 * null if it is absent/not an entry (the preflight stashes `null` when the
 * export was not present, so rollback can distinguish "restore" from "no-op").
 */
function asPriorEntry(stashed: unknown): HelperExportEntry | null {
  if (
    isRecord(stashed) &&
    typeof (stashed as { path?: unknown }).path === 'string' &&
    Array.isArray((stashed as { clients?: unknown }).clients)
  ) {
    return stashed as unknown as HelperExportEntry;
  }
  return null;
}

/**
 * `share.create` — add a brand-new export.
 *
 * preflight blocks if the path is already exported (`EXPORT_PATH_IN_USE`, a
 * fail-before-change); apply compiles the Share and `add_export`s it
 * (creating the directory); verify confirms it is now listed; rollback removes
 * it (idempotent).
 */
function buildShareCreate(deps: NfsExecutorDeps): Executor {
  return {
    operation_kind: 'share.create',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          ctx.emitOutput(`share.create: preflight — checking export path ${spec.path}`);
          const existing = await deps.helper.listExports();
          if (findEntry(existing, spec.path) !== null) {
            ctx.emitOutput(`share.create: path ${spec.path} is already exported`);
            throw new Error(`EXPORT_PATH_IN_USE: ${spec.path} is already exported`);
          }
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          const entry = compileShareToExportEntry(toCompileInput(spec));
          ctx.emitOutput(`share.create: apply — add_export ${spec.path}`);
          await deps.helper.addExport(entry, { create_path: true, path_mode: '0755' });
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          const after = await deps.helper.listExports();
          if (findEntry(after, spec.path) === null) {
            throw new Error(`share.create: ${spec.path} not present after add_export`);
          }
          ctx.emitOutput(`share.create: verify — ${spec.path} is exported`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = readShareSpec(ctx.spec);
      ctx.emitOutput(`share.create: rollback — remove_export ${spec.path}`);
      try {
        await deps.helper.removeExport(spec.path);
      } catch (err) {
        // NOT_FOUND means add_export never committed the line (e.g. apply failed
        // before the write) — there is nothing to remove, so the rollback IS
        // complete. Swallow it so the runner reports FAILED_PARTIAL_ROLLED_BACK,
        // not FAILED_MANUAL_RECOVERY_REQUIRED. (Honors the §3.1 "idempotent"
        // contract; mirrors share.delete's apply NOT_FOUND handling.)
        if (err instanceof NfsHelperError && err.code === 'NOT_FOUND') {
          ctx.emitOutput(`share.create: rollback — ${spec.path} already absent (NOT_FOUND)`);
          return;
        }
        throw err;
      }
    },
  };
}

/**
 * `share.update` — patch an existing export's client rules.
 *
 * preflight captures the live prior entry into `ctx.stash`; apply recompiles
 * and `update_export`s the new clients; rollback restores the prior clients
 * (no-op if the export was absent at preflight).
 */
function buildShareUpdate(deps: NfsExecutorDeps): Executor {
  return {
    operation_kind: 'share.update',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          const existing = await deps.helper.listExports();
          const prior = findEntry(existing, spec.path);
          ctx.stash[STASH_PRIOR_ENTRY] = prior;
          ctx.emitOutput(
            `share.update: preflight — captured prior rules for ${spec.path} (${
              prior ? 'present' : 'absent'
            })`,
          );
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          const entry = compileShareToExportEntry(toCompileInput(spec));
          ctx.emitOutput(`share.update: apply — update_export ${spec.path}`);
          await deps.helper.updateExport(spec.path, { clients: entry.clients });
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          const after = await deps.helper.listExports();
          if (findEntry(after, spec.path) === null) {
            throw new Error(`share.update: ${spec.path} not present after update_export`);
          }
          ctx.emitOutput(`share.update: verify — ${spec.path} is exported`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = readShareSpec(ctx.spec);
      const prior = asPriorEntry(ctx.stash[STASH_PRIOR_ENTRY]);
      if (prior !== null) {
        ctx.emitOutput(`share.update: rollback — restore prior rules for ${spec.path}`);
        await deps.helper.updateExport(spec.path, { clients: prior.clients });
      } else {
        // Prior was absent — nothing to restore.
        ctx.emitOutput(`share.update: rollback — no prior rules to restore for ${spec.path}`);
      }
    },
  };
}

/**
 * `share.delete` — remove an existing export (the on-disk directory is kept).
 *
 * preflight captures the live prior entry into `ctx.stash`; apply
 * `remove_export`s the path, treating a `NOT_FOUND` helper error as
 * already-done (swallowed); rollback re-adds the captured prior entry (no-op if
 * there was none).
 */
function buildShareDelete(deps: NfsExecutorDeps): Executor {
  return {
    operation_kind: 'share.delete',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          // share.delete sends only { id, path } — clients are not required.
          const spec = readShareSpec(ctx.spec, false);
          const existing = await deps.helper.listExports();
          const prior = findEntry(existing, spec.path);
          ctx.stash[STASH_PRIOR_ENTRY] = prior;
          ctx.emitOutput(
            `share.delete: preflight — captured prior entry for ${spec.path} (${
              prior ? 'present' : 'absent'
            })`,
          );
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec, false);
          ctx.emitOutput(`share.delete: apply — remove_export ${spec.path}`);
          try {
            await deps.helper.removeExport(spec.path);
          } catch (err) {
            // A NOT_FOUND means the export is already gone — treat as done.
            if (err instanceof NfsHelperError && err.code === 'NOT_FOUND') {
              ctx.emitOutput(`share.delete: ${spec.path} already absent (NOT_FOUND) — done`);
              return;
            }
            throw err;
          }
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = readShareSpec(ctx.spec, false);
      const prior = asPriorEntry(ctx.stash[STASH_PRIOR_ENTRY]);
      if (prior !== null) {
        ctx.emitOutput(`share.delete: rollback — re-add prior entry for ${spec.path}`);
        await deps.helper.addExport(prior);
      } else {
        // Nothing was there to begin with — nothing to restore.
        ctx.emitOutput(`share.delete: rollback — no prior entry to restore for ${spec.path}`);
      }
    },
  };
}

/**
 * `nfs-idmap.set` — set the idmapd `Domain=` (observed-only; no desired row).
 *
 * preflight captures the prior domain (via the injected reader) into
 * `ctx.stash`; apply `set_idmapd_domain`s the new domain; rollback restores the
 * prior domain. If the prior domain was UNSET, rollback is a no-op and emits a
 * note — the runner then surfaces `FAILED_MANUAL_RECOVERY_REQUIRED` only if
 * rollback genuinely cannot restore (here it simply leaves the new domain in
 * place, which is the documented best-effort for a prior-unset idmap, §3.5).
 */
function buildNfsIdmapSet(deps: NfsExecutorDeps): Executor {
  return {
    operation_kind: 'nfs-idmap.set',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const prior = await deps.readIdmapDomain();
          ctx.stash[STASH_PRIOR_DOMAIN] = prior;
          ctx.emitOutput(
            `nfs-idmap.set: preflight — prior domain ${prior !== undefined ? `'${prior}'` : '(unset)'}`,
          );
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readDomainSpec(ctx.spec);
          ctx.emitOutput(`nfs-idmap.set: apply — set_idmapd_domain '${spec.domain}'`);
          await deps.helper.setIdmapDomain(spec.domain);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const prior = ctx.stash[STASH_PRIOR_DOMAIN];
      if (typeof prior === 'string') {
        ctx.emitOutput(`nfs-idmap.set: rollback — restore domain '${prior}'`);
        await deps.helper.setIdmapDomain(prior);
      } else {
        // The prior domain was unset; there is nothing to restore to. Leave the
        // new domain in place and emit a note (manual recovery if operators want
        // it cleared) — see §3.5.
        ctx.emitOutput(
          'nfs-idmap.set: rollback — prior domain was unset; cannot restore (left as-is)',
        );
      }
    },
  };
}

/**
 * Build the four real NFS executors over the injected deps. Returned as a flat
 * list so `wiring.ts` can register each on the {@link ExecutorRegistry}.
 */
export function buildNfsExecutors(deps: NfsExecutorDeps): Executor[] {
  return [
    buildShareCreate(deps),
    buildShareUpdate(deps),
    buildShareDelete(deps),
    buildNfsIdmapSet(deps),
  ];
}
