/**
 * xiraid.array.create plan provider (S3 T7, ADR-0006 §Per-operation
 * contracts / §Disk references).
 *
 * Preflight:
 *  1. Structurally narrow the request spec (junk → INVALID_ARGUMENT).
 *  2. Resolve member disk ids → device paths from observed Disk state and
 *     gather facts (existing array names, claimed disk ids).
 *  3. Run the shared lib/xiraid validation → blockers (the SAME rules the
 *     agent executor re-checks at apply).
 *  4. Return affected_resources = [ array (primary, FIRST), …member
 *     Disks ] so the apply txn leases the array name and serializes
 *     concurrent creates competing for the same disks.
 *
 * Freshness: the array does not exist yet, so state_revision_expected is
 * omitted (nothing to be stale against); disk TOCTOU is covered by the
 * disk leases + the executor preflight re-check (ADR-0006).
 *
 * The returned `enriched_spec` embeds the resolved `device_by_id` map —
 * the engine persists it on the plan_only task and forwards it verbatim
 * in task.begin, so the executor needs no KV access (ExecutorContext is
 * deliberately spec-only).
 */

import { toRaidCreateRequest, toRaidModifyRequest } from '../../../lib/xiraid/translate.js';
import {
  type CreateFacts,
  type ModifyFacts,
  type ResolvedDisk,
  parseCreateSpec,
  parseModifySpec,
  validateCreateSpec,
  validateModifySpec,
} from '../../../lib/xiraid/validate.js';
import { ApiException } from '../../errors.js';
import type { ResourceRef } from '../../tasks/types.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

interface ObservedDiskRow {
  id?: string;
  status?: {
    device_path?: string;
    safe_for_use?: boolean;
    system_disk?: boolean;
    mounted?: boolean;
  };
}

interface ObservedArrayRow {
  spec?: { name?: string; member_disk_ids?: string[]; spare_disk_ids?: string[] };
}

/** Observed Disk + XiraidArray facts every array provider needs. */
interface GatheredFacts {
  disks: ResolvedDisk[];
  existingArrayNames: string[];
  existingMemberDiskIds: Set<string>;
  /** name → that array's observed spare disk ids. */
  sparesByArray: Map<string, string[]>;
  deviceByDiskId: Map<string, string>;
}

function gatherFacts(ctx: PlanContext): GatheredFacts {
  const diskRows = ctx.kv.list<ObservedDiskRow>({ prefix: '/xinas/v1/observed/Disk/' });
  const disks: ResolvedDisk[] = [];
  for (const row of diskRows) {
    const v = row.value;
    const id = v.id;
    const path = v.status?.device_path;
    if (typeof id !== 'string' || typeof path !== 'string') continue;
    disks.push({
      id,
      device_path: path,
      safe_for_use: v.status?.safe_for_use === true,
      system_disk: v.status?.system_disk === true,
      mounted: v.status?.mounted === true,
    });
  }

  const arrayRows = ctx.kv.list<ObservedArrayRow>({ prefix: '/xinas/v1/observed/XiraidArray/' });
  const existingArrayNames: string[] = [];
  const existingMemberDiskIds = new Set<string>();
  const sparesByArray = new Map<string, string[]>();
  for (const row of arrayRows) {
    const s = row.value.spec;
    if (typeof s?.name === 'string') {
      existingArrayNames.push(s.name);
      sparesByArray.set(s.name, [...(s.spare_disk_ids ?? [])]);
    }
    for (const id of s?.member_disk_ids ?? []) existingMemberDiskIds.add(id);
    for (const id of s?.spare_disk_ids ?? []) existingMemberDiskIds.add(id);
  }

  return {
    disks,
    existingArrayNames,
    existingMemberDiskIds,
    sparesByArray,
    deviceByDiskId: new Map(disks.map((d) => [d.id, d.device_path])),
  };
}

export const xiraidArrayCreateProvider: PlanProvider = {
  operation_kind: 'xiraid.array.create',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    let spec: ReturnType<typeof parseCreateSpec>;
    try {
      spec = parseCreateSpec(rawSpec);
    } catch (err) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        err instanceof Error ? err.message : String(err),
        undefined,
        'Send a create-shaped spec: { name, level, member_disk_ids, ... } per ADR-0006.',
      );
    }

    const { disks, existingArrayNames, existingMemberDiskIds } = gatherFacts(ctx);
    const facts: CreateFacts = { disks, existingArrayNames, existingMemberDiskIds };
    const blockers = validateCreateSpec(spec, facts);

    // --- device resolution (members + spares, S4 T4) ---
    const byId = new Map(disks.map((d) => [d.id, d.device_path]));
    const spares = spec.spare_disk_ids ?? [];
    const allDiskIds = [...spec.member_disk_ids, ...spares];
    const deviceById: Record<string, string> = {};
    for (const id of allDiskIds) {
      const path = byId.get(id);
      if (path !== undefined) deviceById[id] = path;
    }
    const fullyResolved = allDiskIds.every((id) => deviceById[id] !== undefined);

    // Spares are leased like members: a concurrent create/modify competing
    // for the same spare disk serializes on the Disk lease.
    const affected: ResourceRef[] = [
      { kind: 'XiraidArray', id: spec.name },
      ...allDiskIds.map((id): ResourceRef => ({ kind: 'Disk', id })),
    ];

    return {
      affected_resources: affected,
      blockers,
      warnings: [],
      diff: {
        summary: `creates /dev/xi_${spec.name}, consumes ${Object.values(deviceById).join(', ') || '(unresolved disks)'}`,
        ...(fullyResolved
          ? { raid_create_request: toRaidCreateRequest(spec, new Map(Object.entries(deviceById))) }
          : {}),
      },
      risk_level: 'non_disruptive',
      rollback_model: 'non_disruptive',
      enriched_spec: { ...spec, device_by_id: deviceById },
    };
  },
};

/**
 * xiraid.array.modify plan provider (S4 T5, ADR-0006 §Modify).
 *
 * The route injects the path id into the spec ({ id, spare_disk_ids?,
 * tuning? }). Topology rejection (per-field UNSUPPORTED) is the ROUTE's
 * job against the raw PATCH body — parseModifySpec here is tolerant so
 * the apply-time re-check accepts the persisted enriched spec.
 *
 * The executor captures pool pre-state LIVE at its preflight (raid_show +
 * pool_show under the held leases) — more accurate than plan-time observed
 * state — so the enriched spec carries only { id, change, device_by_id }.
 */
export const xiraidArrayModifyProvider: PlanProvider = {
  operation_kind: 'xiraid.array.modify',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    if (typeof rawSpec !== 'object' || rawSpec === null || typeof (rawSpec as { id?: unknown }).id !== 'string') {
      throw new ApiException(
        'INVALID_ARGUMENT',
        'modify spec must carry the target array id',
        undefined,
        'PATCH /arrays/{id} injects the id; send { spec: { spare_disk_ids?, tuning? } }.',
      );
    }
    const id = (rawSpec as { id: string }).id;

    let change: ReturnType<typeof parseModifySpec>;
    try {
      change = parseModifySpec(rawSpec);
    } catch (err) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        err instanceof Error ? err.message : String(err),
        undefined,
        'Send a modify-shaped spec: { spare_disk_ids?, tuning? } per ADR-0006.',
      );
    }

    const facts = gatherFacts(ctx);
    const observed = ctx.kv.get(`/xinas/v1/observed/XiraidArray/${id}`);
    if (!observed || !facts.existingArrayNames.includes(id)) {
      throw new ApiException(
        'NOT_FOUND',
        `array ${id} not found in observed state`,
        undefined,
        'List arrays via GET /api/v1/arrays; modify targets an existing array.',
      );
    }
    const currentSpares = facts.sparesByArray.get(id) ?? [];

    const modifyFacts: ModifyFacts = {
      arrayName: id,
      disks: facts.disks,
      existingMemberDiskIds: facts.existingMemberDiskIds,
      ownSpareDiskIds: new Set(currentSpares),
    };
    const blockers = validateModifySpec(change, modifyFacts);

    // Disks touched by pool ops: the target set ∪ the current set (adds,
    // removes, and keeps all ride the lease).
    const targetSpares = change.spare_disk_ids;
    const touchedSpares =
      targetSpares !== undefined ? [...new Set([...targetSpares, ...currentSpares])] : [];
    const deviceById: Record<string, string> = {};
    for (const diskId of touchedSpares) {
      const path = facts.deviceByDiskId.get(diskId);
      if (path !== undefined) deviceById[diskId] = path;
    }

    const affected: ResourceRef[] = [
      { kind: 'XiraidArray', id },
      ...touchedSpares.map((d): ResourceRef => ({ kind: 'Disk', id: d })),
    ];

    return {
      affected_resources: affected,
      blockers,
      warnings: [],
      diff: {
        before: { spare_disk_ids: currentSpares, tuning: null /* not observed */ },
        after: {
          ...(targetSpares !== undefined ? { spare_disk_ids: targetSpares } : {}),
          ...(change.tuning !== undefined ? { tuning: change.tuning } : {}),
        },
        raid_modify_request: toRaidModifyRequest(id, {
          ...(change.tuning !== undefined ? { tuning: change.tuning } : {}),
        }),
      },
      risk_level: 'non_disruptive',
      rollback_model: 'non_disruptive',
      enriched_spec: { id, ...change, device_by_id: deviceById },
    };
  },
};
