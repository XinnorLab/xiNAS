import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storageProducer } from '../../../api/events/producers/storage.js';
import { type Harness, OBSERVED_AT, type Row, makeHarness, types } from './_engine-harness.js';

interface FsOpts {
  mounted?: boolean;
  unitState?: string;
  options?: string[];
  size?: number | null;
  free?: number | null;
  mountpoint?: string;
}

function fsRow(o: FsOpts = {}): Row {
  const status: Record<string, unknown> = {
    mountpoint: o.mountpoint ?? '/srv/data',
    backing_device: '/dev/xi_data',
    fs_type: 'xfs',
    mounted: o.mounted ?? true,
    mount_unit_name: 'srv-data.mount',
    mount_unit_state: o.unitState ?? 'active',
    effective_mount_options: o.options ?? ['rw', 'noatime'],
    observed_at: OBSERVED_AT,
  };
  if (o.size !== null) status.size_bytes = o.size ?? 100;
  if (o.free !== null) status.free_bytes = o.free ?? 50;
  return { kind: 'Filesystem', id: 'srv-data.mount', status };
}

describe('storage producer (S17 §8.4)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ producers: [storageProducer] });
  });
  afterEach(() => h.close());

  const step = (prev: FsOpts | null, cur: FsOpts | null) =>
    h.step(
      'Filesystem',
      'srv-data.mount',
      prev === null ? null : fsRow(prev),
      cur === null ? null : fsRow(cur),
    );

  describe('mount lifecycle', () => {
    it('mounted → unmounted is a lost mount (reason unmounted)', () => {
      const ev = step({ mounted: true }, { mounted: false, unitState: 'inactive' });
      expect(types(ev)).toEqual(['filesystem.mount.lost']);
      expect(ev[0]).toMatchObject({
        severity: 'error',
        reasonCode: 'unmounted',
        subject: { kind: 'Filesystem', id: 'srv-data.mount' },
        summary: 'Filesystem srv-data.mount: mount lost',
        details: { filesystem: 'srv-data.mount', mountpoint: '/srv/data' },
      });
      expect(ev[0]?.previous).toMatchObject({ mounted: true });
      expect(ev[0]?.current).toMatchObject({ mounted: false, mount_unit_state: 'inactive' });
    });

    it('a mount unit entering failed is a lost mount (reason unit_failed), reported once', () => {
      const ev = step({ mounted: true }, { mounted: false, unitState: 'failed' });
      expect(types(ev)).toEqual(['filesystem.mount.lost']);
      expect(ev[0]?.reasonCode).toBe('unit_failed');
    });

    it('unmounted → mounted is restored', () => {
      step({ mounted: true }, { mounted: false });
      const ev = step({ mounted: false }, { mounted: true });
      expect(types(ev)).toEqual(['filesystem.mount.restored']);
    });

    it('a failed unit on an already-unmounted filesystem with a failed fs.mount task is a failed mount', () => {
      h.close();
      h = makeHarness({
        producers: [storageProducer],
        taskLookup: (kinds, subject, states) =>
          kinds.includes('fs.mount') &&
          subject.id === 'srv-data.mount' &&
          states?.includes('failed')
            ? { taskId: 't-m', operationId: 'op-m' }
            : null,
      });
      const ev = step(
        { mounted: false, unitState: 'inactive' },
        { mounted: false, unitState: 'failed' },
      );
      expect(types(ev)).toEqual(['filesystem.mount.failed']);
      expect(ev[0]?.cause).toEqual({ taskId: 't-m', operationId: 'op-m' });
    });

    it('a failed unit on an unmounted filesystem without a task is nothing', () => {
      expect(
        types(
          step({ mounted: false, unitState: 'inactive' }, { mounted: false, unitState: 'failed' }),
        ),
      ).toEqual([]);
    });
  });

  describe('read-only', () => {
    it('rw → ro while mounted is entered; back is cleared', () => {
      let ev = step({ options: ['rw'] }, { options: ['ro', 'noatime'] });
      expect(types(ev)).toEqual(['filesystem.read_only.entered']);
      expect(ev[0]?.reasonCode).toBe('ro_option');
      ev = step({ options: ['ro'] }, { options: ['rw'] });
      expect(types(ev)).toEqual(['filesystem.read_only.cleared']);
      expect(ev[0]?.previous).toMatchObject({ severity: 'error' });
    });

    it('is not evaluated while unmounted', () => {
      expect(
        types(step({ mounted: false, options: ['rw'] }, { mounted: false, options: ['ro'] })),
      ).toEqual([]);
    });
  });

  describe('capacity hysteresis', () => {
    const at = (free: number) => step({ free: 25 }, { free });
    it('walks the levels with enter/clear thresholds', () => {
      expect(types(step({ free: 30 }, { free: 25 }))).toEqual([]); // 75 %
      let ev = at(19); // 81 %
      expect(types(ev)).toEqual(['filesystem.capacity.warning']);
      expect(ev[0]?.threshold).toEqual({
        metric: 'used_pct',
        value: 81,
        unit: 'percent',
        enter: 80,
        clear: 75,
      });
      expect(ev[0]?.summary).toBe('Filesystem srv-data.mount: capacity warning (81% used)');
      expect(types(at(12))).toEqual([]); // 88 % still warning
      ev = at(9); // 91 %
      expect(types(ev)).toEqual(['filesystem.capacity.critical']);
      expect(ev[0]?.severity).toBe('critical');
      ev = at(16); // 84 % < critical_clear
      expect(types(ev)).toEqual(['filesystem.capacity.warning']);
      expect(ev[0]?.previous).toMatchObject({ severity: 'critical' });
      expect(types(at(21))).toEqual([]); // 79 % still warning
      ev = at(26); // 74 %
      expect(types(ev)).toEqual(['filesystem.capacity.cleared']);
      expect(ev[0]?.previous).toMatchObject({ severity: 'warning' });
    });

    it('a first observation already above the threshold is reported (baseline exception)', () => {
      const ev = step(null, { free: 5 });
      expect(types(ev)).toEqual(['filesystem.capacity.critical']);
      expect(ev[0]?.reasonCode).toBe('baseline');
      expect(types(step(null, { free: 50 }))).toEqual([]);
    });

    it('missing or zero size data evaluates nothing', () => {
      expect(types(step({ free: 25 }, { size: 0, free: 0 }))).toEqual([]);
      expect(types(step({ free: 25 }, { size: null, free: 5 }))).toEqual([]);
      expect(types(step({ free: 25 }, { free: null }))).toEqual([]);
    });

    it('applies a per-filesystem override', () => {
      h.close();
      h = makeHarness({
        producers: [storageProducer],
        config: {
          capacity: {
            warning_enter: 80,
            warning_clear: 75,
            critical_enter: 90,
            critical_clear: 85,
            per_filesystem: {
              'srv-data.mount': {
                warning_enter: 85,
                warning_clear: 80,
                critical_enter: 95,
                critical_clear: 92,
              },
            },
          },
        },
      });
      expect(types(at(19))).toEqual([]); // 81 % < 85
      expect(types(at(14))).toEqual(['filesystem.capacity.warning']); // 86 %
      expect(types(at(9))).toEqual([]); // 91 % < 95
      expect(types(at(4))).toEqual(['filesystem.capacity.critical']); // 96 %
    });
  });

  describe('definitions', () => {
    it('a row appearing after the baseline is added; a deleted row is removed with its task', () => {
      h.close();
      h = makeHarness({
        producers: [storageProducer],
        taskLookup: (kinds) => (kinds.includes('fs.unmanage') ? { taskId: 't-u' } : null),
      });
      expect(types(step(null, {}))).toEqual([]);
      h.snapshot('Filesystem', ['srv-data.mount']);
      const other = { ...fsRow({ mountpoint: '/srv/other' }), id: 'srv-other.mount' };
      expect(types(h.step('Filesystem', 'srv-other.mount', null, other))).toEqual([
        'filesystem.definition.added',
      ]);
      const ev = step({}, null);
      expect(types(ev)).toEqual(['filesystem.definition.removed']);
      expect(ev[0]?.cause).toEqual({ taskId: 't-u' });
      expect(ev[0]?.severity).toBe('info');
    });
  });
});
