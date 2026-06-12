/**
 * Pool plan providers (S9 T8, ADR-0011): create / modify / delete.
 *
 * Pools have NO desired model — the S4 imperative pattern applies
 * (review P1): `affected_resources` lists `Pool/<name>` WITHOUT a
 * revision (display only — the engine's affected freshness check is
 * desired-only), ONE `observed_freshness_ref` pins the observed Pool
 * row (revision 0 = absence pin for create), `lease_resources`
 * serializes writers, and the DELETE executor's live preflight is the
 * cross-resource guarantee (observed `referenced_by` may lag a
 * just-created array).
 */

import { ApiException } from '../../errors.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

const OBSERVED_POOL_PREFIX = '/xinas/v1/observed/Pool/';
const OBSERVED_DISK_PREFIX = '/xinas/v1/observed/Disk/';
const OBSERVED_ARRAY_PREFIX = '/xinas/v1/observed/XiraidArray/';

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(op: string, message: string): ApiException {
  return new ApiException('INVALID_ARGUMENT', `${op}: ${message}`);
}

function requireName(op: string, raw: unknown): string {
  const name = (raw as { name?: unknown })?.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw invalid(op, 'spec.name must match [A-Za-z0-9_-]{1,64}');
  }
  return name;
}

function requireDrives(op: string, raw: unknown, field: string): string[] {
  const drives = (raw as Record<string, unknown>)?.[field];
  if (!Array.isArray(drives) || drives.length === 0) {
    throw invalid(op, `spec.${field} must be a non-empty array of device paths`);
  }
  for (const d of drives) {
    if (typeof d !== 'string' || !d.startsWith('/dev/')) {
      throw invalid(op, `spec.${field}: every entry must be a /dev/... path`);
    }
  }
  return drives as string[];
}

function poolRow(
  ctx: PlanContext,
  name: string,
): { revision: number; status: { drives?: string[]; active?: boolean } } | null {
  const row = ctx.kv.get<{ status?: { drives?: string[]; active?: boolean } }>(
    `${OBSERVED_POOL_PREFIX}${name}`,
  );
  if (row === null) return null;
  return { revision: row.revision, status: row.value.status ?? {} };
}

function driveBlockers(ctx: PlanContext, drives: string[]): PlanResult['blockers'] {
  const blockers: PlanResult['blockers'] = [];
  const disksByPath = new Map<string, { safe_for_use?: boolean; system_disk?: boolean }>();
  for (const row of ctx.kv.list<{ status?: Record<string, unknown> }>({
    prefix: OBSERVED_DISK_PREFIX,
  })) {
    const status = row.value.status ?? {};
    if (typeof status.device_path === 'string') {
      disksByPath.set(status.device_path, status as never);
    }
  }
  for (const drive of drives) {
    const disk = disksByPath.get(drive);
    if (disk === undefined) continue; // unknown to observation — xiRAID validates at execute
    if (disk.system_disk === true) {
      blockers.push({ code: 'system_disk', message: `${drive} is the system disk` });
    } else if (disk.safe_for_use === false) {
      blockers.push({
        code: 'disk_not_safe',
        message: `${drive} is not safe for use (partitioned/mounted/array member)`,
      });
    }
  }
  return blockers;
}

function referencedBy(ctx: PlanContext, name: string): string[] {
  const out: string[] = [];
  for (const row of ctx.kv.list<{ id?: string; status?: { spare_pool?: string } }>({
    prefix: OBSERVED_ARRAY_PREFIX,
  })) {
    if (row.value.status?.spare_pool === name) out.push(row.value.id ?? 'unknown');
  }
  return out;
}

const base = (name: string, revision: number): Pick<
  PlanResult,
  'affected_resources' | 'observed_freshness_ref' | 'lease_resources' | 'warnings'
> => ({
  // Display only — no revision (review P1; the observed ref is the pin).
  affected_resources: [{ kind: 'Pool', id: name }],
  observed_freshness_ref: { kind: 'Pool', id: name, revision },
  lease_resources: [{ kind: 'Pool', id: name }],
  warnings: [],
});

export const poolCreateProvider: PlanProvider = {
  operation_kind: 'pool.create',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const name = requireName('pool.create', rawSpec);
    const drives = requireDrives('pool.create', rawSpec, 'drives');

    const existing = poolRow(ctx, name);
    const blockers: PlanResult['blockers'] = [];
    if (existing !== null) {
      blockers.push({ code: 'pool_already_exists', message: `pool '${name}' already exists` });
    }
    blockers.push(...driveBlockers(ctx, drives));

    return {
      ...base(name, existing?.revision ?? 0), // 0 = absence pin
      blockers,
      diff: { action: 'create', name, drives },
      risk_level: 'non_disruptive',
      rollback_model: 'reversible',
      enriched_spec: { intent: 'create', name, drives },
    };
  },
};

export const poolModifyProvider: PlanProvider = {
  operation_kind: 'pool.modify',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const name = requireName('pool.modify', rawSpec);
    const spec = rawSpec as {
      add_drives?: unknown;
      remove_drives?: unknown;
      active?: unknown;
    };
    const intents = [
      spec.add_drives !== undefined,
      spec.remove_drives !== undefined,
      spec.active !== undefined,
    ].filter(Boolean).length;
    if (intents !== 1) {
      throw invalid(
        'pool.modify',
        'exactly ONE of spec.add_drives, spec.remove_drives, spec.active is required',
      );
    }

    const existing = poolRow(ctx, name);
    const blockers: PlanResult['blockers'] = [];
    if (existing === null) {
      blockers.push({ code: 'pool_not_found', message: `no observed pool '${name}'` });
    }

    let intent: Record<string, unknown>;
    let diff: Record<string, unknown>;
    if (spec.add_drives !== undefined) {
      const drives = requireDrives('pool.modify', rawSpec, 'add_drives');
      blockers.push(...driveBlockers(ctx, drives));
      intent = { intent: 'add_drives', name, drives };
      diff = { action: 'add_drives', name, drives };
    } else if (spec.remove_drives !== undefined) {
      const drives = requireDrives('pool.modify', rawSpec, 'remove_drives');
      intent = { intent: 'remove_drives', name, drives };
      diff = { action: 'remove_drives', name, drives };
    } else {
      if (typeof spec.active !== 'boolean') {
        throw invalid('pool.modify', 'spec.active must be a boolean');
      }
      intent = { intent: spec.active ? 'activate' : 'deactivate', name };
      diff = { action: spec.active ? 'activate' : 'deactivate', name };
    }

    return {
      ...base(name, existing?.revision ?? 0),
      blockers,
      diff,
      risk_level: 'non_disruptive',
      rollback_model: 'reversible',
      enriched_spec: intent,
    };
  },
};

export const poolDeleteProvider: PlanProvider = {
  operation_kind: 'pool.delete',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const name = requireName('pool.delete', rawSpec);
    const existing = poolRow(ctx, name);

    const blockers: PlanResult['blockers'] = [];
    if (existing === null) {
      blockers.push({ code: 'pool_not_found', message: `no observed pool '${name}'` });
    } else {
      if (existing.status.active === true) {
        blockers.push({
          code: 'pool_active',
          message: `pool '${name}' is active — deactivate it first`,
        });
      }
      const refs = referencedBy(ctx, name);
      if (refs.length > 0) {
        blockers.push({
          code: 'pool_referenced',
          message: `pool '${name}' is the spare pool of: ${refs.join(', ')}`,
        });
      }
    }

    return {
      ...base(name, existing?.revision ?? 0),
      blockers,
      diff: { action: 'delete', name },
      risk_level: 'non_disruptive',
      rollback_model: 'reversible',
      enriched_spec: { intent: 'delete', name },
    };
  },
};
