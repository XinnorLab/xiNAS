/**
 * net.iface.update / net.pool.apply executors (S6 T7/T8, ADR-0008
 * §Apply sequences).
 *
 * Stages: preflight → render_write → flush (surgical for iface.update,
 * GLOBAL for pool.apply) → apply → verify.
 *
 *  - preflight re-hashes the LIVE netplan files against the plan's
 *    `world_config_hash` pin (the privilege-boundary half of the
 *    netplan_changed gate — the route checked the observed projection,
 *    this checks the files themselves), re-scans duplicates honoring the
 *    planned cleanup, and stashes EVERY netplan file's prior text into
 *    `ctx.stash` for rollback.
 *  - render_write writes the full plan-rendered 99-xinas.yaml, performs
 *    the PLANNED foreign-file cleanups (removed stanzas emitted as audit
 *    output), and validates with `netplan generate` BEFORE any kernel
 *    flush — an invalid merged config aborts with nothing touched.
 *  - the flush compensates netplan-apply's add-only behavior: surgical
 *    (one dev: its rule(s) by table, its table, its addresses) or global
 *    (tables 100–199 + every mlx dev).
 *
 * Rollback (executor owns the HOST half; the api reverts desired rows —
 * Model R): restore every stashed file byte-identical, re-validate,
 * re-flush the same scope, re-apply.
 */

import { renderNetplan } from '../../lib/net/render.js';
import { PBR_TABLE_MAX, PBR_TABLE_MIN } from '../../lib/net/validate.js';
import { XINAS_NETPLAN, netplanHashes, parseNetplanFiles } from '../../lib/parse/netplan.js';
import type { NetHost } from '../net/host.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';
import yaml from 'js-yaml';

interface UpdateEnriched {
  id: string;
  render: string;
  world_config_hash?: string;
  cleanup?: boolean;
  cleanup_files: Record<string, string[]>;
  surgical: { dev: string; pbr_table_id: number };
  desired?: { addresses?: string[]; enabled?: boolean };
}

function narrowUpdateSpec(ctx: ExecutorContext): UpdateEnriched {
  const raw = ctx.spec as Record<string, unknown> | null;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof raw.id !== 'string' ||
    typeof raw.render !== 'string' ||
    typeof raw.surgical !== 'object'
  ) {
    throw new Error('net.iface.update: spec is missing the plan-resolved id/render/surgical');
  }
  return raw as unknown as UpdateEnriched;
}

const STASH_FILES = 'net_prior_files';

/** Shared preflight body: hash gate + duplicate re-scan + file stash. */
async function netPreflight(
  ctx: ExecutorContext,
  host: NetHost,
  op: string,
  pinnedHash: string | undefined,
  cleanup: boolean | undefined,
  targets: string[],
): Promise<void> {
  const files = await host.readNetplanDir();

  if (pinnedHash !== undefined) {
    const live = netplanHashes(files).world_config_hash;
    if (live !== pinnedHash) {
      throw new Error(
        `preflight: the netplan file set changed since plan (live ${live.slice(0, 12)}… != planned ${pinnedHash.slice(0, 12)}…) — re-plan`,
      );
    }
  }

  if (cleanup !== true) {
    const { duplicates } = parseNetplanFiles(files);
    for (const name of targets) {
      const foreign = duplicates[name];
      if (foreign !== undefined && foreign.length > 0) {
        throw new Error(
          `preflight: ${name} is also defined in ${foreign.join(', ')} — re-plan with cleanup: true`,
        );
      }
    }
  }

  ctx.stash[STASH_FILES] = files;
  ctx.emitOutput(`preflight ok (${op}): ${Object.keys(files).length} netplan file(s) stashed`);
}

/** Remove iface keys from a foreign netplan file's text (audited cleanup). */
function cleanForeignFile(text: string, ifaces: string[]): { text: string; removed: string[] } {
  const doc = yaml.load(text) as { network?: { ethernets?: Record<string, unknown> } } | undefined;
  const ethernets = doc?.network?.ethernets;
  if (ethernets === undefined) return { text, removed: [] };
  const removed: string[] = [];
  for (const name of ifaces) {
    if (name in ethernets) {
      removed.push(`${name}: ${JSON.stringify(ethernets[name])}`);
      delete ethernets[name];
    }
  }
  return { text: yaml.dump(doc, { sortKeys: false }), removed };
}

/** Shared render_write body: 99-xinas + planned cleanups + generate. */
async function netRenderWrite(
  ctx: ExecutorContext,
  host: NetHost,
  render: string,
  cleanupFiles: Record<string, string[]>,
): Promise<void> {
  await host.writeNetplanFile(XINAS_NETPLAN, render);

  // planned foreign-file cleanups (iface → files)
  const byFile = new Map<string, string[]>();
  for (const [iface, files] of Object.entries(cleanupFiles)) {
    for (const file of files) {
      (byFile.get(file) ?? byFile.set(file, []).get(file))?.push(iface);
    }
  }
  const stashed = (ctx.stash[STASH_FILES] ?? {}) as Record<string, string>;
  for (const [file, ifaces] of byFile) {
    const prior = stashed[file];
    if (prior === undefined) continue;
    const { text, removed } = cleanForeignFile(prior, ifaces);
    await host.writeNetplanFile(file, text);
    for (const r of removed) {
      ctx.emitOutput(`cleanup ${file}: removed stanza ${r}`);
    }
  }

  // Validate the merged config BEFORE any kernel flush.
  await host.netplanGenerate();
  ctx.emitOutput(`wrote ${XINAS_NETPLAN} + ${byFile.size} cleanup(s); netplan generate ok`);
}

/** Surgical flush: one dev's rule(s), table, addresses. */
async function flushSurgical(
  ctx: ExecutorContext,
  host: NetHost,
  dev: string,
  tableId: number,
): Promise<void> {
  const rules = await host.ipRuleShow();
  for (const line of rules.split('\n')) {
    const m = /from (\S+) lookup (\d+)/.exec(line);
    if (m && Number(m[2]) === tableId) {
      await host.ipRuleDel(`from ${m[1]} lookup ${m[2]}`);
    }
  }
  await host.ipRouteFlushTable(tableId);
  await host.ipAddrFlush(dev);
  ctx.emitOutput(`surgical flush: ${dev} (table ${tableId})`);
}

/** Global flush: tables 100–199 + every mlx dev (the day-1 sequence). */
async function flushGlobal(ctx: ExecutorContext, host: NetHost): Promise<void> {
  const rules = await host.ipRuleShow();
  const seen = new Set<number>();
  for (const line of rules.split('\n')) {
    const m = /from (\S+) lookup (\d+)/.exec(line);
    if (m) {
      const table = Number(m[2]);
      if (table >= PBR_TABLE_MIN && table <= PBR_TABLE_MAX) {
        await host.ipRuleDel(`from ${m[1]} lookup ${m[2]}`);
        seen.add(table);
      }
    }
  }
  for (const table of seen) {
    await host.ipRouteFlushTable(table);
  }
  const devs = (await host.listSysClassNet()).filter((d) => d.driver.includes('mlx'));
  for (const d of devs) {
    await host.ipAddrFlush(d.name);
  }
  ctx.emitOutput(`global flush: ${seen.size} table(s), ${devs.length} mlx dev(s)`);
}

/** Shared rollback: restore stashed files, re-validate, re-flush, re-apply. */
async function netRollback(
  ctx: ExecutorContext,
  host: NetHost,
  op: string,
  flush: () => Promise<void>,
): Promise<void> {
  const stashed = ctx.stash[STASH_FILES] as Record<string, string> | undefined;
  if (stashed === undefined) {
    ctx.emitOutput(`rollback (${op}): no files stashed (preflight failed) — nothing changed`);
    return;
  }
  for (const [path, text] of Object.entries(stashed)) {
    await host.writeNetplanFile(path, text);
  }
  await host.netplanGenerate();
  await flush();
  await host.netplanApply();
  ctx.emitOutput(`rollback (${op}): ${Object.keys(stashed).length} file(s) restored + re-applied`);
}

/** Verify a dev's desired addresses are live (ip -j) + its rule exists. */
async function verifyDev(
  host: NetHost,
  dev: string,
  addresses: string[],
  tableId: number,
  enabled: boolean,
): Promise<void> {
  const parsed = JSON.parse(await host.ipAddrShow()) as Array<{
    ifname?: string;
    addr_info?: Array<{ local?: string; prefixlen?: number }>;
  }>;
  const entry = parsed.find((e) => e.ifname === dev);
  const live = (entry?.addr_info ?? []).map((a) => `${a.local}/${a.prefixlen}`);
  if (!enabled) return; // disabled iface: flushed is the desired end state
  for (const cidr of addresses) {
    if (!live.includes(cidr)) {
      throw new Error(
        `verify: ${dev} is missing ${cidr} after apply (live: ${live.join(', ') || 'none'})`,
      );
    }
  }
  if (addresses.length > 0) {
    const rules = await host.ipRuleShow();
    if (!rules.includes(`lookup ${tableId}`)) {
      throw new Error(`verify: no PBR rule for table ${tableId} after apply`);
    }
  }
}

export function makeNetIfaceUpdateExecutor(opts: { host: NetHost }): Executor {
  const host = opts.host;

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = narrowUpdateSpec(ctx);
      await netPreflight(ctx, host, 'net.iface.update', spec.world_config_hash, spec.cleanup, [
        spec.id,
      ]);
    },
  };

  const renderWrite: ExecutorStage = {
    name: 'render_write',
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = narrowUpdateSpec(ctx);
      await netRenderWrite(ctx, host, spec.render, spec.cleanup_files ?? {});
    },
  };

  const flushTarget: ExecutorStage = {
    name: 'flush_target',
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = narrowUpdateSpec(ctx);
      await flushSurgical(ctx, host, spec.surgical.dev, spec.surgical.pbr_table_id);
    },
  };

  const apply: ExecutorStage = {
    name: 'apply',
    async run(ctx: ExecutorContext): Promise<void> {
      await host.netplanApply();
      ctx.emitOutput('netplan apply ok');
    },
  };

  const verify: ExecutorStage = {
    name: 'verify',
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = narrowUpdateSpec(ctx);
      await verifyDev(
        host,
        spec.surgical.dev,
        spec.desired?.addresses ?? [],
        spec.surgical.pbr_table_id,
        spec.desired?.enabled !== false,
      );
      ctx.emitOutput(`verified: ${spec.surgical.dev} matches the desired state`);
    },
  };

  return {
    operation_kind: 'net.iface.update',
    stages: [preflight, renderWrite, flushTarget, apply, verify],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = narrowUpdateSpec(ctx);
      await netRollback(ctx, host, 'net.iface.update', () =>
        flushSurgical(ctx, host, spec.surgical.dev, spec.surgical.pbr_table_id),
      );
    },
  };
}

interface PoolEnriched {
  render: string;
  world_config_hash?: string;
  cleanup?: boolean;
  cleanup_files: Record<string, string[]>;
  targets: Array<{ dev: string; addresses: string[]; pbr_table_id: number }>;
}

function narrowPoolSpec(ctx: ExecutorContext): PoolEnriched {
  const raw = ctx.spec as Record<string, unknown> | null;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof raw.render !== 'string' ||
    !Array.isArray(raw.targets)
  ) {
    throw new Error('net.pool.apply: spec is missing the plan-resolved render/targets');
  }
  return raw as unknown as PoolEnriched;
}

export function makeNetPoolApplyExecutor(opts: { host: NetHost }): Executor {
  const host = opts.host;

  return {
    operation_kind: 'net.pool.apply',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = narrowPoolSpec(ctx);
          await netPreflight(
            ctx,
            host,
            'net.pool.apply',
            spec.world_config_hash,
            spec.cleanup,
            spec.targets.map((t) => t.dev),
          );
        },
      },
      {
        name: 'render_write',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = narrowPoolSpec(ctx);
          await netRenderWrite(ctx, host, spec.render, spec.cleanup_files ?? {});
        },
      },
      {
        name: 'flush_global',
        async run(ctx: ExecutorContext): Promise<void> {
          await flushGlobal(ctx, host);
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          await host.netplanApply();
          ctx.emitOutput('netplan apply ok');
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = narrowPoolSpec(ctx);
          for (const t of spec.targets) {
            await verifyDev(host, t.dev, t.addresses, t.pbr_table_id, true);
          }
          ctx.emitOutput(`verified: ${spec.targets.length} interface(s) match the pool`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      await netRollback(ctx, host, 'net.pool.apply', () => flushGlobal(ctx, host));
    },
  };
}

/** The render an executor would produce for given rows (test helper parity). */
export { renderNetplan };
