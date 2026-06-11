/**
 * S6 network plan providers (ADR-0008 / s6-network-spec §4):
 * net.iface.update here in T6; net.pool.apply joins in T8 sharing
 * `gatherNetFacts`.
 *
 * The route injects the path id into the PATCH spec (the S4 pattern).
 * Plans carry:
 *  - per-resource DESIRED revision pins on every affected ResourceRef
 *    (engine-enforced freshness; pool's mixed-revision safety);
 *  - the NetworkConfig/99-xinas singleton lease + all touched ifaces in
 *    `lease_resources` (serializes every whole-file writer);
 *  - `desired_mutations` seeding ADOPTION rows for every managed
 *    interface not yet under desired state (Model R revertible);
 *  - an enriched spec with the FULL rendered 99-xinas.yaml + the
 *    `world_config_hash` pin the route/executor re-verify.
 */

import {
  type DesiredIfaceSpec,
  renderNetplan,
} from '../../../lib/net/render.js';
import {
  type IfaceUpdateSpec,
  type NetFacts,
  allocatePool,
  allocateTableId,
  parseIfaceUpdateSpec,
  parsePoolSpec,
  validateIfaceUpdate,
  validatePool,
} from '../../../lib/net/validate.js';
import { XINAS_NETPLAN } from '../../../lib/parse/netplan.js';
import { ApiException } from '../../errors.js';
import type { DesiredMutation, ResourceRef } from '../../tasks/types.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

interface ObservedIfaceRow {
  id?: string;
  status?: {
    driver?: string;
    rdma_capable?: boolean;
    netplan?: { addresses?: string[]; mtu?: number; pbr_table_id?: number };
    duplicates_detected_in?: string[];
  };
}

interface DesiredIfaceRow {
  id?: string;
  spec?: {
    addresses?: string[];
    mtu?: number;
    enabled?: boolean;
    pbr_table_id?: number;
  };
}

interface NetworkConfigRow {
  status?: {
    world_config_hash?: string;
    duplicates?: Record<string, string[]>;
  };
}

export interface NetGathered {
  /** Managed (mlx) interfaces, sorted by name. */
  managed: Array<{
    name: string;
    observed: ObservedIfaceRow;
    desired?: DesiredIfaceSpec;
    desiredRevision: number;
    stanza?: { addresses: string[]; mtu?: number; pbr_table_id?: number };
  }>;
  /** All observed interfaces by name (managed check / 404s). */
  observedByName: Map<string, ObservedIfaceRow>;
  world_config_hash: string | undefined;
  duplicates: Record<string, string[]>;
  hasNfsSessions: boolean;
}

export function gatherNetFacts(ctx: PlanContext): NetGathered {
  const observedByName = new Map<string, ObservedIfaceRow>();
  for (const row of ctx.kv.list<ObservedIfaceRow>({
    prefix: '/xinas/v1/observed/NetworkInterface/',
  })) {
    if (typeof row.value.id === 'string') observedByName.set(row.value.id, row.value);
  }

  const desiredByName = new Map<string, { spec: DesiredIfaceSpec; revision: number }>();
  for (const row of ctx.kv.list<DesiredIfaceRow>({
    prefix: '/xinas/v1/desired/NetworkInterface/',
  })) {
    const v = row.value;
    if (typeof v.id !== 'string' || v.spec === undefined) continue;
    desiredByName.set(v.id, {
      revision: row.revision,
      spec: {
        name: v.id,
        addresses: v.spec.addresses ?? [],
        ...(v.spec.mtu !== undefined ? { mtu: v.spec.mtu } : {}),
        enabled: v.spec.enabled !== false,
        pbr_table_id: v.spec.pbr_table_id ?? 0,
      },
    });
  }

  const managed: NetGathered['managed'] = [];
  for (const [name, observed] of [...observedByName.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const driver = observed.status?.driver ?? '';
    if (!driver.includes('mlx')) continue;
    const desired = desiredByName.get(name);
    const stanzaRaw = observed.status?.netplan;
    managed.push({
      name,
      observed,
      ...(desired !== undefined ? { desired: desired.spec } : {}),
      desiredRevision: desired?.revision ?? 0,
      ...(stanzaRaw !== undefined
        ? {
            stanza: {
              addresses: stanzaRaw.addresses ?? [],
              ...(stanzaRaw.mtu !== undefined ? { mtu: stanzaRaw.mtu } : {}),
              ...(stanzaRaw.pbr_table_id !== undefined
                ? { pbr_table_id: stanzaRaw.pbr_table_id }
                : {}),
            },
          }
        : {}),
    });
  }

  const config = ctx.kv.get<NetworkConfigRow>('/xinas/v1/observed/NetworkConfig/default');
  const sessions = ctx.kv.list<unknown>({ prefix: '/xinas/v1/observed/NfsSession/' });

  return {
    managed,
    observedByName,
    world_config_hash: config?.value.status?.world_config_hash,
    duplicates: config?.value.status?.duplicates ?? {},
    hasNfsSessions: sessions.length > 0,
  };
}

/** Desired key for an interface (the mutation/lease identity). */
const desiredKey = (name: string): string => `/xinas/v1/desired/NetworkInterface/${name}`;

/**
 * Resolve the FINAL desired rows for a plan: adopt every managed iface
 * lacking a desired row (stanza-preserved table ids; fresh allocation
 * when the stanza has none), and overlay `targetOverlay` onto the
 * target. Returns rows + which names were adopted.
 */
export function resolveDesiredRows(
  facts: NetGathered,
  targetName: string | null,
  targetOverlay: Partial<DesiredIfaceSpec>,
): { rows: DesiredIfaceSpec[]; adopted: string[] } {
  const used = new Set<number>();
  for (const m of facts.managed) {
    const t = m.desired?.pbr_table_id ?? m.stanza?.pbr_table_id;
    if (t !== undefined && t > 0) used.add(t);
  }

  const rows: DesiredIfaceSpec[] = [];
  const adopted: string[] = [];
  for (const m of facts.managed) {
    let base: DesiredIfaceSpec;
    if (m.desired !== undefined) {
      base = { ...m.desired };
    } else {
      const table = m.stanza?.pbr_table_id ?? allocateTableId(used) ?? 0;
      used.add(table);
      base = {
        name: m.name,
        addresses: m.stanza?.addresses ?? [],
        ...(m.stanza?.mtu !== undefined ? { mtu: m.stanza.mtu } : {}),
        enabled: true,
        pbr_table_id: table,
      };
      adopted.push(m.name);
    }
    if (m.name === targetName) {
      if (base.pbr_table_id === 0) {
        const table = allocateTableId(used) ?? 0;
        used.add(table);
        base.pbr_table_id = table;
      }
      base = {
        ...base,
        ...(targetOverlay.addresses !== undefined ? { addresses: targetOverlay.addresses } : {}),
        ...(targetOverlay.mtu !== undefined ? { mtu: targetOverlay.mtu } : {}),
        ...(targetOverlay.enabled !== undefined ? { enabled: targetOverlay.enabled } : {}),
      };
    }
    rows.push(base);
  }
  return { rows, adopted };
}

/** Build the validate-layer facts from the gathered state + final rows. */
export function toNetFacts(facts: NetGathered, finalRows: DesiredIfaceSpec[]): NetFacts {
  const desiredAddressByIface: Record<string, string[]> = {};
  const used = new Set<number>();
  for (const row of finalRows) {
    desiredAddressByIface[row.name] = row.addresses;
    if (row.pbr_table_id > 0) used.add(row.pbr_table_id);
  }
  return {
    managed: facts.managed.map((m) => ({
      name: m.name,
      ...(m.desired !== undefined ? { desired: m.desired } : {}),
      ...(m.stanza !== undefined
        ? { stanza: { file: XINAS_NETPLAN, ...m.stanza } }
        : {}),
    })),
    duplicates: facts.duplicates,
    usedTableIds: used,
    desiredAddressByIface,
  };
}

export const netIfaceUpdateProvider: PlanProvider = {
  operation_kind: 'net.iface.update',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    if (
      typeof rawSpec !== 'object' ||
      rawSpec === null ||
      typeof (rawSpec as { id?: unknown }).id !== 'string'
    ) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        'update spec must carry the target interface id',
        undefined,
        'PATCH /network/interfaces/{id} injects the id from the path.',
      );
    }
    const id = (rawSpec as { id: string }).id;

    let spec: IfaceUpdateSpec;
    try {
      spec = parseIfaceUpdateSpec(rawSpec);
    } catch (err) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        err instanceof Error ? err.message : String(err),
        undefined,
        'Send { addresses?, mtu?, enabled?, cleanup? } per ADR-0008.',
      );
    }

    const facts = gatherNetFacts(ctx);
    const observed = facts.observedByName.get(id);
    if (observed === undefined) {
      throw new ApiException(
        'NOT_FOUND',
        `interface ${id} not found in observed state`,
        undefined,
        'GET /network/interfaces lists the observed interfaces.',
      );
    }
    const target = facts.managed.find((m) => m.name === id);
    if (target === undefined) {
      throw new ApiException(
        'UNSUPPORTED',
        `interface ${id} is not xiNAS-managed (driver '${observed.status?.driver ?? 'unknown'}')`,
        { reason: 'iface_not_managed' },
        'Only RDMA-capable (mlx) interfaces are managed; management ethernet stays cloud-init/TUI-owned.',
      );
    }

    const { rows, adopted } = resolveDesiredRows(facts, id, spec);
    const blockers = validateIfaceUpdate(id, spec, toNetFacts(facts, rows));

    const warnings: Array<{ code: string; message: string }> = [];
    const targetDuplicates = facts.duplicates[id] ?? [];
    if (spec.cleanup === true && targetDuplicates.length > 0) {
      warnings.push({
        code: 'netplan_cleanup_planned',
        message: `the ${id} stanza will be removed from ${targetDuplicates.join(', ')} (audited repair)`,
      });
    }
    if (facts.hasNfsSessions) {
      warnings.push({
        code: 'nfs_sessions_may_drop',
        message:
          'active NFS sessions exist; changing interface addressing may interrupt clients mounted via this interface',
      });
    }

    const targetRow = rows.find((r) => r.name === id);
    const desiredMutations: DesiredMutation[] = [
      // adoption seeds for every other managed iface lacking a desired row
      ...adopted
        .filter((n) => n !== id)
        .map((n) => {
          const row = rows.find((r) => r.name === n);
          return {
            key: desiredKey(n),
            value: { kind: 'NetworkInterface', id: n, spec: { managed_by_xinas: true, ...row } },
          };
        }),
      // the target's updated row
      {
        key: desiredKey(id),
        value: { kind: 'NetworkInterface', id, spec: { managed_by_xinas: true, ...targetRow } },
      },
    ];

    const leaseResources: ResourceRef[] = [
      { kind: 'NetworkConfig', id: '99-xinas' },
      { kind: 'NetworkInterface', id },
      ...adopted
        .filter((n) => n !== id)
        .map((n): ResourceRef => ({ kind: 'NetworkInterface', id: n })),
    ];

    const render = renderNetplan(rows);
    const cleanupFiles =
      spec.cleanup === true && targetDuplicates.length > 0 ? { [id]: targetDuplicates } : {};

    return {
      affected_resources: [
        { kind: 'NetworkInterface', id, revision: target.desiredRevision },
      ],
      blockers,
      warnings,
      diff: {
        summary: `update ${id}: rewrite ${XINAS_NETPLAN} (full render), surgical flush, netplan apply`,
        stanza_before: target.desired ?? target.stanza ?? null,
        stanza_after: targetRow,
        ...(Object.keys(cleanupFiles).length > 0 ? { cleanup_files: cleanupFiles } : {}),
      },
      risk_level: 'changing_access',
      rollback_model: 'non_disruptive',
      state_revision_expected: target.desiredRevision,
      lease_resources: leaseResources,
      desired_mutations: desiredMutations,
      enriched_spec: {
        ...spec,
        id,
        desired: targetRow,
        render,
        ...(facts.world_config_hash !== undefined
          ? { world_config_hash: facts.world_config_hash }
          : {}),
        cleanup_files: cleanupFiles,
        surgical: { dev: id, pbr_table_id: targetRow?.pbr_table_id ?? 0 },
      },
    };
  },
};

/**
 * net.pool.apply (POST /network/ip-pool, S6 T8): re-allocate ADDRESSES
 * over every managed interface with the day-1 third-octet formula.
 * Existing pbr_table_ids persist (ADR-0008) — only adoption-fresh
 * interfaces get a new allocation. Every affected ResourceRef carries
 * its OWN desired revision (mixed-revision pools apply cleanly).
 */
export const netPoolApplyProvider: PlanProvider = {
  operation_kind: 'net.pool.apply',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    let spec: ReturnType<typeof parsePoolSpec>;
    try {
      spec = parsePoolSpec(rawSpec);
    } catch (err) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        err instanceof Error ? err.message : String(err),
        undefined,
        'Send { start, prefix, mtu?, cleanup? } per ADR-0008.',
      );
    }

    const facts = gatherNetFacts(ctx);
    // Base rows = adoption-resolved current state (no overlay target).
    const { rows: baseRows, adopted } = resolveDesiredRows(facts, null, {});
    const blockers = validatePool(spec, toNetFacts(facts, baseRows));

    // Address reallocation over the SORTED managed set (day-1 formula).
    const allocation =
      allocatePool(spec.start, spec.prefix, facts.managed.map((m) => m.name)) ?? {};
    const rows: DesiredIfaceSpec[] = baseRows.map((row) => ({
      ...row,
      addresses: allocation[row.name] !== undefined ? [allocation[row.name] as string] : row.addresses,
      ...(spec.mtu !== undefined ? { mtu: spec.mtu } : {}),
      enabled: true,
    }));

    const warnings: Array<{ code: string; message: string }> = [];
    const cleanupFiles: Record<string, string[]> = {};
    if (spec.cleanup === true) {
      for (const m of facts.managed) {
        const files = facts.duplicates[m.name];
        if (files !== undefined && files.length > 0) cleanupFiles[m.name] = files;
      }
      if (Object.keys(cleanupFiles).length > 0) {
        warnings.push({
          code: 'netplan_cleanup_planned',
          message: `managed stanzas will be removed from ${[...new Set(Object.values(cleanupFiles).flat())].join(', ')} (audited repair)`,
        });
      }
    }
    if (facts.hasNfsSessions) {
      warnings.push({
        code: 'nfs_sessions_may_drop',
        message:
          'active NFS sessions exist; re-addressing every managed interface will interrupt connected clients',
      });
    }

    const desiredMutations: DesiredMutation[] = rows.map((row) => ({
      key: desiredKey(row.name),
      value: { kind: 'NetworkInterface', id: row.name, spec: { managed_by_xinas: true, ...row } },
    }));

    // EVERY target pinned with its OWN desired revision (engine-enforced).
    const affected: ResourceRef[] = facts.managed.map((m) => ({
      kind: 'NetworkInterface',
      id: m.name,
      revision: m.desiredRevision,
    }));

    const leaseResources: ResourceRef[] = [
      { kind: 'NetworkConfig', id: '99-xinas' },
      ...facts.managed.map((m): ResourceRef => ({ kind: 'NetworkInterface', id: m.name })),
    ];

    const render = renderNetplan(rows);
    return {
      affected_resources: affected,
      blockers,
      warnings,
      diff: {
        summary: `pool ${spec.start}/${spec.prefix} over ${facts.managed.length} managed interface(s); tables preserved`,
        allocation,
        adopted,
        ...(Object.keys(cleanupFiles).length > 0 ? { cleanup_files: cleanupFiles } : {}),
      },
      risk_level: 'changing_access',
      rollback_model: 'non_disruptive',
      state_revision_expected: affected[0]?.revision ?? 0,
      lease_resources: leaseResources,
      desired_mutations: desiredMutations,
      enriched_spec: {
        ...spec,
        render,
        ...(facts.world_config_hash !== undefined
          ? { world_config_hash: facts.world_config_hash }
          : {}),
        cleanup_files: cleanupFiles,
        targets: rows
          .filter((r) => r.enabled)
          .map((r) => ({ dev: r.name, addresses: r.addresses, pbr_table_id: r.pbr_table_id })),
      },
    };
  },
};
