/**
 * The five real NFS executors (S3 N3.2 + N7.3, s3-nfs-executor-spec
 * §3.1–3.5).
 *
 * Replaces the inert `reference.echo` proof with imperative, per-verb NFS
 * export management driving the privileged `xinas-nfs-helper` via the typed
 * {@link NfsHelperClient} (N3.1) and recompiling the helper payload from the
 * RAW request spec through the shared, layer-neutral
 * {@link compileShareToExportEntry} (N1.1) — one compile, two importers (the
 * api PlanProvider previews the same diff; this executor authoritatively
 * applies it). `nfs-profile.update` (N7.3) follows the same principle with
 * the shared {@link deriveProfileServiceAction}: the restart flag is DERIVED
 * from the `{ profile, prior_profile }` operation spec, never stored — the
 * api derived the identical answer for the plan's risk preview.
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
import { compileShareToExportEntry, shareSpecToCompileInput } from '../../lib/nfs-exports.js';
import { deriveProfileServiceAction, type NfsProfileSpec } from '../../lib/nfs-profile.js';
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

/**
 * The raw `nfs-profile.update` spec the api forwards (§3.4): the FULL merged
 * NfsProfile spec to render plus the pre-patch spec (the current desired or
 * the ADR-0005 defaults), from which the restart flag and the rollback render
 * are both derived.
 */
interface RawProfileSpec {
  profile: NfsProfileSpec;
  prior_profile: NfsProfileSpec;
}

/** Stash key under which preflight captures the prior export entry (or null). */
const STASH_PRIOR_ENTRY = 'priorEntry';
/** Stash key under which preflight captures the prior idmap domain (or undefined). */
const STASH_PRIOR_DOMAIN = 'priorDomain';
/**
 * Stash marker `share.create`'s apply sets IMMEDIATELY before issuing
 * `add_export`. The TaskRunner invokes `rollback()` on ANY failed stage —
 * including preflight — so without this marker a preflight failure (e.g.
 * `EXPORT_PATH_IN_USE`: the path is ALREADY exported by someone else) would
 * roll back by deleting an export the task never created. Rollback only
 * issues `remove_export` when this marker is present.
 */
const STASH_ADD_EXPORT_ISSUED = 'addExportIssued';

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

/**
 * Narrow the opaque `ctx.spec` to `{ profile, prior_profile }` (both plain
 * objects), throwing a clear error if either is missing/malformed.
 */
function readProfileSpec(spec: unknown): RawProfileSpec {
  if (!isRecord(spec)) {
    throw new Error('nfs-executor: spec is not an object');
  }
  const { profile, prior_profile } = spec as { profile?: unknown; prior_profile?: unknown };
  if (!isRecord(profile) || Array.isArray(profile)) {
    throw new Error('nfs-executor: spec.profile must be an object (the FULL merged spec)');
  }
  if (!isRecord(prior_profile) || Array.isArray(prior_profile)) {
    throw new Error('nfs-executor: spec.prior_profile must be an object (the pre-patch spec)');
  }
  return spec as unknown as RawProfileSpec;
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
          const entry = compileShareToExportEntry(shareSpecToCompileInput(spec));
          ctx.emitOutput(`share.create: apply — add_export ${spec.path}`);
          // Mark BEFORE issuing the op: if add_export itself fails midway the
          // export may still have landed, so rollback must attempt removal.
          ctx.stash[STASH_ADD_EXPORT_ISSUED] = true;
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
      // The runner rolls back on ANY failed stage, including preflight. If
      // apply never issued add_export there is NOTHING this task created —
      // removing here would delete a PRE-EXISTING export (e.g. the
      // EXPORT_PATH_IN_USE preflight failure means someone else exports it).
      if (ctx.stash[STASH_ADD_EXPORT_ISSUED] !== true) {
        ctx.emitOutput(
          `share.create: rollback — apply never issued add_export for ${spec.path}; nothing to roll back`,
        );
        return;
      }
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
          const entry = compileShareToExportEntry(shareSpecToCompileInput(spec));
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
        try {
          await deps.helper.setIdmapDomain(prior);
        } catch (err) {
          // The helper rejects any domain without a '.' (INVALID_ARGUMENT) —
          // e.g. a stock `Domain = localdomain`. Rollback only runs when
          // preflight/apply FAILED, so the domain was never successfully
          // changed: leaving it as-is is harmless, not manual-recovery.
          if (err instanceof NfsHelperError && err.code === 'INVALID_ARGUMENT') {
            ctx.emitOutput(
              `nfs-idmap.set: rollback — prior domain '${prior}' is not restorable via the helper (no dot) — left as-is`,
            );
            return;
          }
          throw err;
        }
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
 * `nfs-profile.update` — render the four ADR-0005 effective NFS service files
 * from the FULL merged profile spec (§3.4, §6.2).
 *
 * preflight narrows the `{ profile, prior_profile }` spec (shape check, a
 * fail-before-change on garbage); apply derives the restart flag via the
 * shared {@link deriveProfileServiceAction} (restart iff a CHANGED dimension's
 * policy is 'restart' — the SAME derivation the api used for the plan's risk)
 * and `render_nfs_profile`s the merged spec, emitting the returned per-file
 * checksums. There is no verify stage: the render returns its own checksums
 * and the N7.2 observed NfsProfile collector confirms the effective files on
 * its next sweep. Rollback re-renders the PRIOR spec with the same derived
 * flag — if the forward change warranted a restart, restoring it does too.
 */
function buildNfsProfileUpdate(deps: NfsExecutorDeps): Executor {
  return {
    operation_kind: 'nfs-profile.update',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const { profile, prior_profile } = readProfileSpec(ctx.spec);
          const { restart, changed } = deriveProfileServiceAction(prior_profile, profile);
          ctx.emitOutput(
            `nfs-profile.update: preflight — spec ok (changed: ${
              changed.length > 0 ? changed.join(', ') : 'none'
            }; service action: ${restart ? 'restart' : 'reload'})`,
          );
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          const { profile, prior_profile } = readProfileSpec(ctx.spec);
          const { restart } = deriveProfileServiceAction(prior_profile, profile);
          ctx.emitOutput(
            `nfs-profile.update: apply — render_nfs_profile (restart=${String(restart)})`,
          );
          const result = await deps.helper.renderNfsProfile(profile, restart);
          for (const [file, checksum] of Object.entries(result.effective_files)) {
            ctx.emitOutput(`nfs-profile.update: rendered ${file} ${checksum}`);
          }
          ctx.emitOutput(
            `nfs-profile.update: nfs-server ${result.restarted ? 'restarted' : 'reloaded'}`,
          );
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      // A malformed spec means preflight already failed on the narrowing and
      // NOTHING was rendered — re-throwing here would only escalate a zero-
      // host-change failure to FAILED_MANUAL_RECOVERY_REQUIRED. Note + return.
      let narrowed: RawProfileSpec;
      try {
        narrowed = readProfileSpec(ctx.spec);
      } catch {
        ctx.emitOutput('nfs-profile.update: rollback — spec unreadable — nothing to re-render');
        return;
      }
      const { profile, prior_profile } = narrowed;
      // Same derived flag as the forward render: if the change warranted a
      // restart, restoring the prior set does too (§3.4).
      const { restart } = deriveProfileServiceAction(prior_profile, profile);
      ctx.emitOutput(
        `nfs-profile.update: rollback — re-render prior profile (restart=${String(restart)})`,
      );
      await deps.helper.renderNfsProfile(prior_profile, restart);
    },
  };
}

/**
 * Build the five real NFS executors over the injected deps. Returned as a flat
 * list so `wiring.ts` can register each on the {@link ExecutorRegistry}.
 */
export function buildNfsExecutors(deps: NfsExecutorDeps): Executor[] {
  return [
    buildShareCreate(deps),
    buildShareUpdate(deps),
    buildShareDelete(deps),
    buildNfsProfileUpdate(deps),
    buildNfsIdmapSet(deps),
  ];
}
