/**
 * Storage producer (S17 §8.4): filesystem definitions, mount lifecycle,
 * read-only transitions and capacity thresholds with hysteresis, from the
 * observed `Filesystem` row (S5 amendment: `mounted`, `mount_unit_state`,
 * `effective_mount_options`, `size_bytes`, `free_bytes`).
 */

import type { ChangeCtx, EngineConfig, Producer, Row } from '../engine.js';
import { META_KEYS } from '../meta.js';
import type { Severity } from '../types.js';

export interface FsView {
  mountpoint: string | undefined;
  backingDevice: string | undefined;
  mounted: boolean | null;
  unitState: string | undefined;
  /** `ro` in the effective mount options; null when the options are not observed. */
  readOnly: boolean | null;
  size: number | null;
  free: number | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function fsView(row: Row | null): FsView | null {
  if (row === null) return null;
  const s = asRecord(row.status);
  const options = Array.isArray(s.effective_mount_options)
    ? s.effective_mount_options.filter((o): o is string => typeof o === 'string')
    : null;
  return {
    mountpoint: typeof s.mountpoint === 'string' ? s.mountpoint : undefined,
    backingDevice: typeof s.backing_device === 'string' ? s.backing_device : undefined,
    mounted: typeof s.mounted === 'boolean' ? s.mounted : null,
    unitState: typeof s.mount_unit_state === 'string' ? s.mount_unit_state : undefined,
    readOnly: options === null ? null : options.includes('ro'),
    size: num(s.size_bytes),
    free: num(s.free_bytes),
  };
}

/** Why a filesystem cannot back an export right now (shared with the NFS producer). */
export function fsUnavailableReason(v: FsView): 'unmounted' | 'unit_failed' | 'ro_option' | null {
  if (v.unitState === 'failed') return 'unit_failed';
  if (v.mounted === false) return 'unmounted';
  if (v.mounted === true && v.readOnly === true) return 'ro_option';
  return null;
}

const projection = (v: FsView): Record<string, unknown> => ({
  mounted: v.mounted,
  mount_unit_state: v.unitState,
  read_only: v.readOnly,
});

type Level = 'none' | 'warning' | 'critical';
const LEVEL_SEVERITY: Record<Exclude<Level, 'none'>, Severity> = {
  warning: 'warning',
  critical: 'critical',
};

interface Thresholds {
  warning_enter: number;
  warning_clear: number;
  critical_enter: number;
  critical_clear: number;
}

function thresholdsFor(config: EngineConfig, id: string): Thresholds {
  const g = config.capacity;
  const o = config.capacity.per_filesystem[id] ?? {};
  return {
    warning_enter: o.warning_enter ?? g.warning_enter,
    warning_clear: o.warning_clear ?? g.warning_clear,
    critical_enter: o.critical_enter ?? g.critical_enter,
    critical_clear: o.critical_clear ?? g.critical_clear,
  };
}

/** One hysteresis step; iterated until stable so a large drop settles in one event. */
function nextLevel(level: Level, used: number, t: Thresholds): Level {
  switch (level) {
    case 'none':
      if (used >= t.critical_enter) return 'critical';
      if (used >= t.warning_enter) return 'warning';
      return 'none';
    case 'warning':
      if (used >= t.critical_enter) return 'critical';
      if (used < t.warning_clear) return 'none';
      return 'warning';
    case 'critical':
      if (used < t.critical_clear) return 'warning';
      return 'critical';
  }
}

function evaluateCapacity(ctx: ChangeCtx, id: string, cur: FsView, baseline: boolean): void {
  if (cur.size === null || cur.free === null || cur.size <= 0) return;
  const used = Math.round(((cur.size - cur.free) / cur.size) * 1000) / 10;
  const t = thresholdsFor(ctx.config, id);
  const key = META_KEYS.capacity(id);
  const before: Level = ctx.meta.get<Level>(key) ?? 'none';
  let level = before;
  for (let i = 0; i < 3; i++) {
    const n = nextLevel(level, used, t);
    if (n === level) break;
    level = n;
  }
  if (level === before) return;
  const type =
    level === 'none'
      ? 'filesystem.capacity.cleared'
      : level === 'warning'
        ? 'filesystem.capacity.warning'
        : 'filesystem.capacity.critical';
  const enter = level === 'critical' ? t.critical_enter : t.warning_enter;
  const clear = level === 'critical' ? t.critical_clear : t.warning_clear;
  ctx.emit({
    feed: 'storage',
    type,
    subject: { kind: 'Filesystem', id },
    args: { filesystem: id, usedPct: used },
    threshold: { metric: 'used_pct', value: used, unit: 'percent', enter, clear },
    ...(before !== 'none' ? { previous: { severity: LEVEL_SEVERITY[before], level: before } } : {}),
    current: { level, used_pct: used },
    ...(baseline ? { reasonCode: 'baseline' as const } : { reasonCode: 'hysteresis' as const }),
    details: {
      filesystem: id,
      ...(cur.mountpoint !== undefined ? { mountpoint: cur.mountpoint } : {}),
      usedPct: used,
      sizeBytes: cur.size,
      freeBytes: cur.free,
      level,
      observedAt: ctx.batch.observedAt,
    },
  });
  if (level === 'none') ctx.meta.delete(key);
  else ctx.meta.set(key, level);
}

function baseDetails(ctx: ChangeCtx, id: string, v: FsView | null): Record<string, unknown> {
  return {
    filesystem: id,
    ...(v?.mountpoint !== undefined ? { mountpoint: v.mountpoint } : {}),
    ...(v?.backingDevice !== undefined ? { backingDevice: v.backingDevice } : {}),
    ...(v?.unitState !== undefined ? { mountUnitState: v.unitState } : {}),
    ...(v?.mounted !== null && v?.mounted !== undefined ? { mounted: v.mounted } : {}),
    observedAt: ctx.batch.observedAt,
  };
}

function onFilesystemChange(ctx: ChangeCtx): void {
  const { id } = ctx;
  const prev = fsView(ctx.previous);
  const cur = fsView(ctx.current);
  const subject = { kind: 'Filesystem' as const, id };

  if (cur === null) {
    if (prev === null) return;
    const cause = ctx.correlate(['fs.unmanage'], subject);
    ctx.emit({
      feed: 'storage',
      type: 'filesystem.definition.removed',
      subject,
      args: { filesystem: id },
      previous: projection(prev),
      details: baseDetails(ctx, id, prev),
      ...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),
    });
    ctx.meta.delete(META_KEYS.capacity(id));
    return;
  }

  if (prev === null) {
    if (ctx.baselineDone('Filesystem')) {
      const cause = ctx.correlate(['fs.create'], subject);
      ctx.emit({
        feed: 'storage',
        type: 'filesystem.definition.added',
        subject,
        args: { filesystem: id },
        current: projection(cur),
        details: baseDetails(ctx, id, cur),
        ...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),
      });
    }
    evaluateCapacity(ctx, id, cur, true);
    return;
  }

  // Mount lifecycle.
  const unitFailedNow = cur.unitState === 'failed' && prev.unitState !== 'failed';
  if (prev.mounted === true && (cur.mounted === false || unitFailedNow)) {
    ctx.emit({
      feed: 'storage',
      type: 'filesystem.mount.lost',
      subject,
      args: { filesystem: id },
      reasonCode: unitFailedNow ? 'unit_failed' : 'unmounted',
      previous: projection(prev),
      current: projection(cur),
      details: baseDetails(ctx, id, cur),
    });
  } else if (prev.mounted === false && cur.mounted === false && unitFailedNow) {
    const cause = ctx.correlate(['fs.mount'], subject, ['failed']);
    if (cause !== undefined) {
      ctx.emit({
        feed: 'storage',
        type: 'filesystem.mount.failed',
        subject,
        args: { filesystem: id },
        reasonCode: 'unit_failed',
        previous: projection(prev),
        current: projection(cur),
        details: baseDetails(ctx, id, cur),
        cause,
        timeAccuracy: 'task',
      });
    }
  } else if (prev.mounted === false && cur.mounted === true) {
    ctx.emit({
      feed: 'storage',
      type: 'filesystem.mount.restored',
      subject,
      args: { filesystem: id },
      previous: { ...projection(prev), severity: 'error' },
      current: projection(cur),
      details: baseDetails(ctx, id, cur),
    });
  }

  // Read-only, only while mounted on both sides.
  if (
    prev.mounted === true &&
    cur.mounted === true &&
    prev.readOnly !== null &&
    cur.readOnly !== null
  ) {
    if (!prev.readOnly && cur.readOnly) {
      ctx.emit({
        feed: 'storage',
        type: 'filesystem.read_only.entered',
        subject,
        args: { filesystem: id },
        reasonCode: 'ro_option',
        previous: projection(prev),
        current: projection(cur),
        details: baseDetails(ctx, id, cur),
      });
    } else if (prev.readOnly && !cur.readOnly) {
      ctx.emit({
        feed: 'storage',
        type: 'filesystem.read_only.cleared',
        subject,
        args: { filesystem: id },
        previous: { ...projection(prev), severity: 'error' },
        current: projection(cur),
        details: baseDetails(ctx, id, cur),
      });
    }
  }

  evaluateCapacity(ctx, id, cur, false);
}

export const storageProducer: Producer = { kinds: ['Filesystem'], onChange: onFilesystemChange };
