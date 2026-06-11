/**
 * Network operation validation + allocations (S6 T3, ADR-0008).
 *
 * Pure: facts are injected by the api providers (observed + desired KV
 * state) and re-checkable by executors where live. Parsers are TOLERANT
 * of unknown keys (the enriched spec re-parses for the apply re-check,
 * the S4 pattern); identity rejection (`pbr_table_id` etc.) is the
 * ROUTE's job against the raw body.
 */

import type { NetplanStanza } from '../parse/netplan.js';
import type { DesiredIfaceSpec } from './render.js';

export interface Blocker {
  code: string;
  message: string;
}

/** Identity fields — immutable through PATCH (ADR-0008). */
export const NET_IDENTITY_FIELDS = ['pbr_table_id', 'managed_by_xinas', 'name'] as const;

export const PBR_TABLE_MIN = 100;
export const PBR_TABLE_MAX = 199;
const MTU_MIN = 1280; // IPv6 minimum
const MTU_MAX = 65520; // IB connected mode

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

export function isValidCidr(cidr: string): boolean {
  const [ip, prefixStr, extra] = cidr.split('/');
  if (extra !== undefined || ip === undefined || prefixStr === undefined) return false;
  const prefix = Number(prefixStr);
  return isValidIpv4(ip) && Number.isInteger(prefix) && prefix >= 1 && prefix <= 32;
}

// ---- spec parsers ----

export interface IfaceUpdateSpec {
  addresses?: string[];
  mtu?: number;
  enabled?: boolean;
  cleanup?: boolean;
}

export function parseIfaceUpdateSpec(input: unknown): IfaceUpdateSpec {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('update spec must be an object');
  }
  const o = input as Record<string, unknown>;
  if (o.addresses !== undefined) {
    if (!Array.isArray(o.addresses) || o.addresses.some((a) => typeof a !== 'string')) {
      throw new TypeError('spec.addresses must be an array of CIDR strings');
    }
  }
  if (o.mtu !== undefined && typeof o.mtu !== 'number') {
    throw new TypeError('spec.mtu must be a number');
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    throw new TypeError('spec.enabled must be a boolean');
  }
  if (o.addresses === undefined && o.mtu === undefined && o.enabled === undefined) {
    throw new TypeError('spec must carry at least one of addresses, mtu, enabled');
  }
  return input as IfaceUpdateSpec;
}

export interface PoolSpec {
  start: string;
  prefix: number;
  mtu?: number;
  cleanup?: boolean;
}

export function parsePoolSpec(input: unknown): PoolSpec {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('pool spec must be an object');
  }
  const o = input as Record<string, unknown>;
  if (typeof o.start !== 'string' || !isValidIpv4(o.start)) {
    throw new TypeError('spec.start must be an IPv4 address');
  }
  if (typeof o.prefix !== 'number' || !Number.isInteger(o.prefix) || o.prefix < 8 || o.prefix > 30) {
    throw new TypeError('spec.prefix must be an integer in [8, 30]');
  }
  if (o.mtu !== undefined && typeof o.mtu !== 'number') {
    throw new TypeError('spec.mtu must be a number');
  }
  return input as PoolSpec;
}

// ---- allocations ----

/** Lowest free PBR table id in [100, 199]; null when exhausted. */
export function allocateTableId(used: Set<number>): number | null {
  for (let id = PBR_TABLE_MIN; id <= PBR_TABLE_MAX; id++) {
    if (!used.has(id)) return id;
  }
  return null;
}

/**
 * Day-1 pool formula (net_controllers): interface[i] (sorted by name)
 * gets base.base.(startOctet + i).host/prefix. Overflow past 255 → null.
 */
export function allocatePool(
  start: string,
  prefix: number,
  ifaceNames: string[],
): Record<string, string> | null {
  const octets = start.split('.').map(Number);
  const [a, b, startThird, host] = octets;
  const out: Record<string, string> = {};
  const sorted = [...ifaceNames].sort();
  for (let i = 0; i < sorted.length; i++) {
    const third = (startThird ?? 0) + i;
    if (third > 255) return null;
    out[sorted[i] as string] = `${a}.${b}.${third}.${host}/${prefix}`;
  }
  return out;
}

// ---- per-op validation ----

/** Facts every network validator consumes (provider-gathered). */
export interface NetFacts {
  /** Managed (mlx) interfaces with whatever state exists for each. */
  managed: Array<{ name: string; desired?: DesiredIfaceSpec; stanza?: NetplanStanza }>;
  /** iface → foreign netplan files also defining it. */
  duplicates: Record<string, string[]>;
  /** Table ids already taken (desired ∪ adoption candidates). */
  usedTableIds: Set<number>;
  /** Desired/adopted CIDRs per OTHER interface (conflict check). */
  desiredAddressByIface: Record<string, string[]>;
}

function duplicateBlockers(
  targets: string[],
  facts: NetFacts,
  cleanup: boolean | undefined,
): Blocker[] {
  if (cleanup === true) return [];
  const blockers: Blocker[] = [];
  for (const name of targets) {
    const files = facts.duplicates[name];
    if (files !== undefined && files.length > 0) {
      blockers.push({
        code: 'duplicate_netplan_definition',
        message: `${name} is also defined in ${files.join(', ')} — netplan would merge the stanzas; re-plan with cleanup: true to repair`,
      });
    }
  }
  return blockers;
}

function addressBlockers(iface: string, addresses: string[], facts: NetFacts): Blocker[] {
  const blockers: Blocker[] = [];
  for (const cidr of addresses) {
    if (!isValidCidr(cidr)) {
      blockers.push({ code: 'addresses_invalid', message: `'${cidr}' is not a valid IPv4 CIDR` });
    }
  }
  for (const [other, cidrs] of Object.entries(facts.desiredAddressByIface)) {
    if (other === iface) continue;
    const clash = addresses.find((a) => cidrs.includes(a));
    if (clash !== undefined) {
      blockers.push({
        code: 'address_conflict',
        message: `${clash} is already assigned to ${other}`,
      });
    }
  }
  return blockers;
}

export function validateIfaceUpdate(
  iface: string,
  spec: IfaceUpdateSpec,
  facts: NetFacts,
): Blocker[] {
  const blockers: Blocker[] = [];
  blockers.push(...duplicateBlockers([iface], facts, spec.cleanup));
  if (spec.addresses !== undefined) {
    blockers.push(...addressBlockers(iface, spec.addresses, facts));
  }
  if (spec.mtu !== undefined && (spec.mtu < MTU_MIN || spec.mtu > MTU_MAX)) {
    blockers.push({
      code: 'mtu_invalid',
      message: `mtu ${spec.mtu} outside [${MTU_MIN}, ${MTU_MAX}]`,
    });
  }
  // A table is needed when the target has neither a desired row nor an
  // adoptable stanza carrying one.
  const entry = facts.managed.find((m) => m.name === iface);
  const hasTable =
    entry?.desired?.pbr_table_id !== undefined || entry?.stanza?.pbr_table_id !== undefined;
  if (!hasTable && allocateTableId(facts.usedTableIds) === null) {
    blockers.push({
      code: 'pbr_table_exhausted',
      message: 'no free PBR table id in [100, 199]',
    });
  }
  return blockers;
}

export function validatePool(spec: PoolSpec, facts: NetFacts): Blocker[] {
  const blockers: Blocker[] = [];
  if (facts.managed.length === 0) {
    blockers.push({
      code: 'no_managed_interfaces',
      message: 'no RDMA-capable (mlx) interfaces observed — nothing to allocate',
    });
    return blockers;
  }
  blockers.push(
    ...duplicateBlockers(
      facts.managed.map((m) => m.name),
      facts,
      spec.cleanup,
    ),
  );
  if (allocatePool(spec.start, spec.prefix, facts.managed.map((m) => m.name)) === null) {
    blockers.push({
      code: 'pool_overflow',
      message: `pool starting at ${spec.start} overflows the third octet for ${facts.managed.length} interface(s)`,
    });
  }
  if (spec.mtu !== undefined && (spec.mtu < MTU_MIN || spec.mtu > MTU_MAX)) {
    blockers.push({
      code: 'mtu_invalid',
      message: `mtu ${spec.mtu} outside [${MTU_MIN}, ${MTU_MAX}]`,
    });
  }
  // New ifaces (no desired row / stanza table) each need an allocation.
  const needTables = facts.managed.filter(
    (m) => m.desired?.pbr_table_id === undefined && m.stanza?.pbr_table_id === undefined,
  ).length;
  const free = Array.from(
    { length: PBR_TABLE_MAX - PBR_TABLE_MIN + 1 },
    (_v, i) => PBR_TABLE_MIN + i,
  ).filter((id) => !facts.usedTableIds.has(id)).length;
  if (needTables > free) {
    blockers.push({
      code: 'pbr_table_exhausted',
      message: `${needTables} interface(s) need PBR tables but only ${free} id(s) are free`,
    });
  }
  return blockers;
}
