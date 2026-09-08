/**
 * NFS producer (S17 §8.5): service units, export rules, backing-filesystem
 * readiness and NFS-over-RDMA readiness, from the observed `SystemdUnit`,
 * `ExportRule`, `Filesystem`, `NfsProfile` and `NetworkInterface` rows plus
 * the desired `NfsProfile` / `NetworkInterface` rows (S6 amendment).
 *
 * `unitTransition` is shared with the system producer (S7 amendment): one
 * rule for every allow-listed unit; a `not-found` or `masked` unit never
 * transitions.
 */

import { decExportId } from '../../../lib/nfs-export-id.js';
import type { ChangeCtx, EngineKv, Producer, Row } from '../engine.js';
import { META_KEYS } from '../meta.js';
import { type FsView, fsReadiness, fsView } from './storage.js';

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ── units ──────────────────────────────────────────────────────────────

export const NFS_UNITS: ReadonlySet<string> = new Set([
  'nfs-server.service',
  'nfs-idmapd.service',
  'nfs-mountd.service',
]);

export interface UnitView {
  loadState: string | undefined;
  activeState: string | undefined;
  subState: string | undefined;
}

export function unitView(row: Row | null): UnitView | null {
  if (row === null) return null;
  const s = asRecord(row.status);
  return {
    loadState: typeof s.load_state === 'string' ? s.load_state : undefined,
    activeState: typeof s.active_state === 'string' ? s.active_state : undefined,
    subState: typeof s.sub_state === 'string' ? s.sub_state : undefined,
  };
}

export type UnitTransition =
  | { kind: 'unavailable'; reason: 'unit_failed' | 'unit_inactive' }
  | { kind: 'recovered'; reason?: undefined };

const DOWN_FROM_ACTIVE: ReadonlySet<string> = new Set(['inactive', 'deactivating']);
const RECOVERED_FROM: ReadonlySet<string> = new Set([
  'failed',
  'inactive',
  'activating',
  'deactivating',
]);

/** The service rule of spec §8.5, over two observed rows. */
export function unitTransition(previous: Row | null, current: Row | null): UnitTransition | null {
  const prev = unitView(previous);
  const cur = unitView(current);
  if (prev === null || cur === null) return null;
  if (prev.loadState !== 'loaded' || cur.loadState !== 'loaded') return null;
  if (prev.activeState === undefined || cur.activeState === undefined) return null;
  if (cur.activeState === 'failed' && prev.activeState !== 'failed') {
    return { kind: 'unavailable', reason: 'unit_failed' };
  }
  if (prev.activeState === 'active' && DOWN_FROM_ACTIVE.has(cur.activeState)) {
    return { kind: 'unavailable', reason: 'unit_inactive' };
  }
  if (cur.activeState === 'active' && RECOVERED_FROM.has(prev.activeState)) {
    return { kind: 'recovered' };
  }
  return null;
}

/** Emit the unavailable/recovered pair for one unit on one feed. */
export function emitUnitTransition(
  ctx: ChangeCtx,
  feed: 'nfs' | 'system',
  typePrefix: 'nfs.service' | 'system.service',
  transition: UnitTransition,
): void {
  const unit = ctx.id;
  const cur = unitView(ctx.current);
  const prev = unitView(ctx.previous);
  ctx.emit({
    feed,
    type: `${typePrefix}.${transition.kind}`,
    subject: { kind: 'SystemdUnit', id: unit },
    args: { unit },
    ...(transition.kind === 'unavailable'
      ? { reasonCode: transition.reason }
      : { previous: { severity: 'error', active_state: prev?.activeState } }),
    ...(transition.kind === 'unavailable' ? { previous: { active_state: prev?.activeState } } : {}),
    current: { active_state: cur?.activeState, sub_state: cur?.subState },
    details: {
      unit,
      ...(cur?.activeState !== undefined ? { activeState: cur.activeState } : {}),
      ...(cur?.subState !== undefined ? { subState: cur.subState } : {}),
      ...(cur?.loadState !== undefined ? { loadState: cur.loadState } : {}),
      observedAt: ctx.batch.observedAt,
    },
  });
}

function onUnitChange(ctx: ChangeCtx): void {
  if (!NFS_UNITS.has(ctx.id)) return;
  const t = unitTransition(ctx.previous, ctx.current);
  if (t !== null) emitUnitTransition(ctx, 'nfs', 'nfs.service', t);
}

// ── exports ────────────────────────────────────────────────────────────

interface RuleValue {
  options: string[];
  squash_mode?: string;
  anon_uid?: number;
  anon_gid?: number;
}

function exportPathOf(row: Row | null, id: string): string {
  const spec = asRecord(row?.spec);
  if (typeof spec.export_path === 'string' && spec.export_path.length > 0) return spec.export_path;
  return decExportId(id);
}

/** host_pattern → canonical comparison value (options sorted, de-duplicated). */
function rulesOf(row: Row | null): Map<string, RuleValue> {
  const out = new Map<string, RuleValue>();
  const rules = asRecord(row?.status).rules;
  if (!Array.isArray(rules)) return out;
  for (const r of rules) {
    const rec = asRecord(r);
    if (typeof rec.host_pattern !== 'string') continue;
    const options = Array.isArray(rec.options)
      ? [...new Set(rec.options.filter((o): o is string => typeof o === 'string'))].sort()
      : [];
    out.set(rec.host_pattern, {
      options,
      ...(typeof rec.squash_mode === 'string' ? { squash_mode: rec.squash_mode } : {}),
      ...(typeof rec.anon_uid === 'number' ? { anon_uid: rec.anon_uid } : {}),
      ...(typeof rec.anon_gid === 'number' ? { anon_gid: rec.anon_gid } : {}),
    });
  }
  return out;
}

const sameRule = (a: RuleValue, b: RuleValue): boolean => JSON.stringify(a) === JSON.stringify(b);

function emitExport(
  ctx: ChangeCtx,
  type: 'nfs.export.added' | 'nfs.export.changed' | 'nfs.export.removed',
  exportPath: string,
  hostPattern: string,
  previous: RuleValue | undefined,
  current: RuleValue | undefined,
): void {
  ctx.emit({
    feed: 'nfs',
    type,
    subject: { kind: 'ExportRule', id: exportPath },
    args: { exportPath, hostPattern },
    ...(previous !== undefined ? { previous: { ...previous } } : {}),
    ...(current !== undefined ? { current: { ...current } } : {}),
    details: { exportPath, hostPattern, observedAt: ctx.batch.observedAt },
  });
}

function onExportChange(ctx: ChangeCtx): void {
  const exportPath = exportPathOf(ctx.current ?? ctx.previous, ctx.id);
  const prev = rulesOf(ctx.previous);
  const cur = rulesOf(ctx.current);

  if (ctx.current === null) {
    if (ctx.previous === null) return;
    for (const [host, value] of prev)
      emitExport(ctx, 'nfs.export.removed', exportPath, host, value, undefined);
    ctx.meta.delete(META_KEYS.backingUnavailable(ctx.id));
    return;
  }
  if (ctx.previous === null) {
    if (ctx.baselineDone('ExportRule')) {
      for (const [host, value] of cur)
        emitExport(ctx, 'nfs.export.added', exportPath, host, undefined, value);
    }
    // Record the backing state silently: a transition is reported later.
    evaluateBacking(ctx, ctx.id, exportPath, false);
    return;
  }
  for (const [host, value] of cur) {
    const before = prev.get(host);
    if (before === undefined)
      emitExport(ctx, 'nfs.export.added', exportPath, host, undefined, value);
    else if (!sameRule(before, value))
      emitExport(ctx, 'nfs.export.changed', exportPath, host, before, value);
  }
  for (const [host, value] of prev) {
    if (!cur.has(host)) emitExport(ctx, 'nfs.export.removed', exportPath, host, value, undefined);
  }
  evaluateBacking(ctx, ctx.id, exportPath, true);
}

// ── backing readiness ──────────────────────────────────────────────────

const normalizeMountpoint = (m: string): string => (m.length > 1 ? m.replace(/\/+$/, '') : m);

/** The filesystem whose mountpoint is the longest path-boundary prefix of `exportPath`. */
export function coveringFilesystem(
  kv: EngineKv,
  exportPath: string,
): { id: string; view: FsView; mountpoint: string } | null {
  let best: { id: string; view: FsView; mountpoint: string } | null = null;
  for (const r of kv.list<Row>({ prefix: '/xinas/v1/observed/Filesystem/' })) {
    const v = fsView(r.value);
    if (v === null || v.mountpoint === undefined) continue;
    const m = normalizeMountpoint(v.mountpoint);
    const covers = exportPath === m || exportPath.startsWith(m === '/' ? '/' : `${m}/`);
    if (!covers) continue;
    if (best === null || m.length > best.mountpoint.length) {
      const id =
        typeof r.value.id === 'string' ? r.value.id : r.key.slice(r.key.lastIndexOf('/') + 1);
      best = { id, view: v, mountpoint: m };
    }
  }
  return best;
}

function evaluateBacking(
  ctx: ChangeCtx,
  exportId: string,
  exportPath: string,
  mayEmit: boolean,
): void {
  const covering = coveringFilesystem(ctx.kv, exportPath);
  if (covering === null) return; // no covering filesystem observed: unknown, not a fault
  const readiness = fsReadiness(covering.view);
  const key = META_KEYS.backingUnavailable(exportId);
  const was = ctx.meta.get<boolean>(key) === true;
  if (readiness.state === 'unknown') {
    // Neither the fault nor the recovery is proven: keep the last proven
    // state and say so where an operator can see it (never as a domain event).
    ctx.log('warn', 'event_source_incomplete', {
      kind: 'Filesystem',
      id: covering.id,
      exportPath,
      missing: readiness.missing,
      kept: was ? 'unavailable' : 'available',
    });
    return;
  }
  const now = readiness.state === 'unavailable';
  if (now === was) return;
  if (mayEmit) {
    ctx.emit({
      feed: 'nfs',
      type: now ? 'nfs.export.backing_unavailable' : 'nfs.export.backing_recovered',
      subject: { kind: 'ExportRule', id: exportPath },
      args: { exportPath },
      relatedResources: [{ kind: 'Filesystem', id: covering.id }],
      ...(readiness.state === 'unavailable'
        ? { reasonCode: readiness.reason }
        : { previous: { severity: 'error' } }),
      details: {
        exportPath,
        mountpoint: covering.mountpoint,
        filesystem: covering.id,
        ...(readiness.state === 'unavailable' ? { reason: readiness.reason } : {}),
        observedAt: ctx.batch.observedAt,
      },
    });
  }
  if (now) ctx.meta.set(key, true);
  else ctx.meta.delete(key);
}

/** A Filesystem change re-evaluates every export (small cardinality). */
function onFilesystemChangeForExports(ctx: ChangeCtx): void {
  if (ctx.previous === null) return; // a filesystem's first observation is not a transition
  for (const r of ctx.kv.list<Row>({ prefix: '/xinas/v1/observed/ExportRule/' })) {
    const exportId =
      typeof r.value.id === 'string'
        ? r.value.id
        : r.key.slice('/xinas/v1/observed/ExportRule/'.length);
    evaluateBacking(ctx, exportId, exportPathOf(r.value, exportId), true);
  }
}

// ── NFS over RDMA readiness ────────────────────────────────────────────

function evaluateRdma(ctx: ChangeCtx): void {
  const desired = ctx.kv.get<Row>('/xinas/v1/desired/NfsProfile/default');
  const rdma = asRecord(asRecord(desired?.value.spec).rdma);
  if (rdma.enabled !== true) return; // not configured: no event (reason not_configured)
  const observed = ctx.kv.get<Row>('/xinas/v1/observed/NfsProfile/default');
  if (observed === null) return; // listener state unknown
  const status = asRecord(observed.value.status);
  const listening = typeof status.rdma_listening === 'boolean' ? status.rdma_listening : null;
  const port = typeof status.rdma_port === 'number' ? status.rdma_port : undefined;

  const considered: string[] = [];
  const up: string[] = [];
  const undecided: string[] = [];
  for (const r of ctx.kv.list<Row>({ prefix: '/xinas/v1/observed/NetworkInterface/' })) {
    const id = typeof r.value.id === 'string' ? r.value.id : '';
    if (id.length === 0) continue;
    const s = asRecord(r.value.status);
    if (s.rdma_capable !== true) continue;
    if (ctx.kv.get(`/xinas/v1/desired/NetworkInterface/${id}`) === null) continue;
    considered.push(id);
    if (s.rdma_link_state === 'up') up.push(id);
    else if (s.rdma_link_state !== 'down') undecided.push(id);
  }
  if (considered.length === 0) return; // no managed RDMA interface observed: unknown

  const was = ctx.meta.get<boolean>(META_KEYS.rdmaUnavailable) === true;
  // Ready needs one proven path and a proven listener; unavailable needs a
  // proven-false listener or every path proven down. Anything else is not
  // a fact about the serving path and keeps the last proven state.
  let ready: boolean | null;
  if (listening === false) ready = false;
  else if (listening === null) ready = null;
  else if (up.length > 0) ready = true;
  else if (undecided.length === 0) ready = false;
  else ready = null;
  if (ready === null) {
    ctx.log('warn', 'event_source_incomplete', {
      kind: 'NfsProfile',
      id: 'default',
      missing: [
        ...(listening === null ? ['rdma_listening'] : []),
        ...undecided.map((id) => `NetworkInterface/${id}.rdma_link_state`),
      ],
      kept: was ? 'unavailable' : 'available',
    });
    return;
  }
  if (ready === !was) return;
  ctx.emit({
    feed: 'nfs',
    type: ready ? 'nfs.rdma.recovered' : 'nfs.rdma.unavailable',
    subject: { kind: 'SystemdUnit', id: 'nfs-server.service' },
    args: {},
    relatedResources: considered.map((id) => ({ kind: 'NetworkInterface', id })),
    ...(ready ? { previous: { severity: 'error' } } : {}),
    current: { listening: listening === true, interfaces_up: up },
    details: {
      listening: listening === true,
      interfaces: up,
      ...(port !== undefined ? { port } : {}),
      observedAt: ctx.batch.observedAt,
    },
  });
  if (ready) ctx.meta.delete(META_KEYS.rdmaUnavailable);
  else ctx.meta.set(META_KEYS.rdmaUnavailable, true);
}

function onRdmaInputChange(ctx: ChangeCtx): void {
  if (ctx.previous === null || ctx.current === null) return;
  evaluateRdma(ctx);
}

export const nfsProducer: Producer = {
  kinds: ['SystemdUnit', 'ExportRule', 'Filesystem', 'NfsProfile', 'NetworkInterface'],
  onChange(ctx) {
    switch (ctx.kind) {
      case 'SystemdUnit':
        onUnitChange(ctx);
        break;
      case 'ExportRule':
        onExportChange(ctx);
        break;
      case 'Filesystem':
        onFilesystemChangeForExports(ctx);
        break;
      case 'NfsProfile':
      case 'NetworkInterface':
        onRdmaInputChange(ctx);
        break;
      default:
        break;
    }
  },
};
