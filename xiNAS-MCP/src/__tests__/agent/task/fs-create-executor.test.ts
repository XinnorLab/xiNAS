import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeFsHost } from '../../../agent/fs/fake-host.js';
import { makeFsCreateExecutor } from '../../../agent/task/fs-executor.js';
import type { ExecutorContext } from '../../../agent/task/types.js';

function makeCtx(spec: unknown): ExecutorContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    spec,
    lines,
    emitOutput(line: string): void {
      lines.push(line);
    },
    isCancelRequested: () => false,
  };
}

function enrichedSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backing_device: '/dev/xi_data',
    mountpoint: '/mnt/data',
    log_device: '/dev/xi_log',
    log_size: '1G',
    unit_name: 'mnt-data.mount',
    unit_text: [
      '[Mount]',
      'What=/dev/xi_data',
      'Where=/mnt/data',
      'Options=defaults,logdev=/dev/xi_log',
      'Type=xfs',
      '',
    ].join('\n'),
    resolved: {
      device: '/dev/xi_data',
      label: 'data',
      su_kb: 128,
      sw: 3,
      sector_size: 4096,
      log_device: '/dev/xi_log',
      log_size_bytes: 1073741824,
    },
    ...over,
  };
}

async function runAllStages(
  executor: ReturnType<typeof makeFsCreateExecutor>,
  ctx: ExecutorContext,
): Promise<void> {
  for (const stage of executor.stages) {
    await stage.run(ctx);
  }
}

describe('fs.create executor', () => {
  let dir: string;
  let host: ReturnType<typeof createFakeFsHost>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-fs-exec-'));
    host = createFakeFsHost(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy path: preflight → mkfs → install_unit → mount → verify (no clamp on a big device)', async () => {
    const executor = makeFsCreateExecutor({ host });
    const ctx = makeCtx(enrichedSpec());
    await runAllStages(executor, ctx);

    const ops = host.ops();
    expect(ops).toContain(
      'mkfs.xfs -f -L data -d su=128k,sw=3 -l logdev=/dev/xi_log,size=1073741824 -s size=4096 /dev/xi_data',
    );
    expect(ops).toContain('writeUnit:mnt-data.mount');
    expect(ops).toContain('enableNow:mnt-data.mount');
    expect(await host.readMounts()).toEqual([
      { source: '/dev/xi_data', mountpoint: '/mnt/data' },
    ]);
    expect(ctx.lines.some((l) => l.includes('clamped'))).toBe(false);
  });

  it('clamps the log size to blockdev --getsize64 (review P1 golden)', async () => {
    host.seedDeviceSize('/dev/xi_log', 536870912); // 512 MiB device, 1G requested
    const executor = makeFsCreateExecutor({ host });
    const ctx = makeCtx(enrichedSpec());
    await runAllStages(executor, ctx);

    expect(
      host.ops().some((op) => op.includes('logdev=/dev/xi_log,size=536870912')),
    ).toBe(true);
    expect(ctx.lines.some((l) => l.includes('log size clamped'))).toBe(true);
  });

  it('blkid gate: existing filesystem without force aborts preflight; force proceeds', async () => {
    host.seedBlkid('/dev/xi_data', { fstype: 'xfs', label: 'old', uuid: 'u-old' });
    const executor = makeFsCreateExecutor({ host });
    await expect(executor.stages[0]?.run(makeCtx(enrichedSpec()))).rejects.toThrow(
      /already carries a xfs filesystem.*force: true/,
    );
    // mkfs untouched
    expect(host.ops().filter((o) => o.startsWith('mkfs'))).toEqual([]);

    const forcedCtx = makeCtx(enrichedSpec({ force: true }));
    await runAllStages(makeFsCreateExecutor({ host }), forcedCtx);
    expect(forcedCtx.lines.some((l) => l.includes('overwritten (force)'))).toBe(true);
  });

  it('owner_policy is applied after mount', async () => {
    const executor = makeFsCreateExecutor({ host });
    const ctx = makeCtx(enrichedSpec({ owner_policy: { uid: 1000, gid: 1000, mode: '0775' } }));
    await runAllStages(executor, ctx);
    expect(host.ops().some((op) => op.startsWith('ownerPolicy:/mnt/data:'))).toBe(true);
  });

  it('mount failure → rollback removes the unit without stop (live-state)', async () => {
    // '-fail' stem in the unit name trips the fake's enableNow hook.
    const spec = enrichedSpec({
      mountpoint: '/mnt/x-fail',
      unit_name: 'mnt-x\\x2dfail.mount'.replace('\\\\', '\\'),
      unit_text: '[Mount]\nWhat=/dev/xi_data\nWhere=/mnt/x-fail\nType=xfs\n',
    });
    // simpler: a unit literally named with a -fail stem
    (spec as Record<string, unknown>).unit_name = 'mnt-x-fail.mount';

    const executor = makeFsCreateExecutor({ host });
    const ctx = makeCtx(spec);
    await executor.stages[0]?.run(ctx); // preflight
    await executor.stages[1]?.run(ctx); // mkfs
    await executor.stages[2]?.run(ctx); // install_unit
    await expect(executor.stages[3]?.run(ctx)).rejects.toThrow(/forced enableNow/);

    await executor.rollback(ctx);
    const ops = host.ops();
    expect(ops).toContain('removeUnit:mnt-x-fail.mount');
    expect(ops.filter((o) => o.startsWith('stop:'))).toEqual([]); // never mounted
    expect(ops.filter((o) => o === 'daemon-reload').length).toBeGreaterThanOrEqual(2);
    expect(ctx.lines.some((l) => l.includes('device left unmanaged'))).toBe(true);
  });

  it('rollback after a successful mount stops the unit first', async () => {
    const executor = makeFsCreateExecutor({ host });
    const ctx = makeCtx(enrichedSpec());
    await runAllStages(executor, ctx);
    await executor.rollback(ctx);
    const ops = host.ops();
    expect(ops).toContain('stop:mnt-data.mount');
    expect(ops).toContain('removeUnit:mnt-data.mount');
    expect(await host.readMounts()).toEqual([]);
    expect(await host.readUnit('mnt-data.mount')).toBeNull();
  });

  it('missing resolved inputs → clear executor error', async () => {
    const executor = makeFsCreateExecutor({ host });
    const bad = enrichedSpec();
    delete bad.resolved;
    await expect(executor.stages[0]?.run(makeCtx(bad))).rejects.toThrow(
      /missing the plan-resolved mkfs inputs/,
    );
  });
});
