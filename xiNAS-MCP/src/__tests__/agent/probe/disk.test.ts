import type { ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDiskProbe } from '../../../agent/probe/disk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fake execFile that returns lsblk fixture JSON
function makeExecFile(stdout: string) {
  return (
    _file: string,
    _args: string[],
    _opts: ExecFileOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, stdout, '');
  };
}

// Fake spawn that emits lines to stdout then stays quiet
function makeSpawnLineEmitter(lines: string[]) {
  return (_cmd: string, _args: string[]) => {
    const { EventEmitter } = require('node:events');
    const proc = new EventEmitter() as any;
    const { Readable } = require('node:stream');
    proc.stdout = Readable.from(lines.map((l) => l + '\n'));
    proc.stderr = Readable.from([]);
    proc.kill = () => {
      proc.emit('close', 0);
    };
    proc.exitCode = null;
    setTimeout(() => {
      /* stay alive */
    }, 60000);
    return proc;
  };
}

describe('DiskProbe', () => {
  const fixturePath = join(__dirname, '../../lib/parse/__fixtures__/lsblk-clean-controller.json');

  it('snapshot() returns parsed disks via injected execFile', async () => {
    const fixture = readFileSync(fixturePath, 'utf8');
    const probe = createDiskProbe({ execFile: makeExecFile(fixture) as any });
    const disks = await probe.snapshot();
    expect(disks.length).toBeGreaterThanOrEqual(3);
    expect(disks.some((d) => d.id === 'nvme0n1')).toBe(true);
  });

  it('snapshot() throws on lsblk non-zero exit', async () => {
    const probe = createDiskProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => {
        cb(new Error('lsblk: permission denied'), '', 'permission denied');
      },
    });
    await expect(probe.snapshot()).rejects.toThrow(/lsblk/);
  });

  it('startEventStream() emits delta on udevadm add record', async () => {
    const udevRecord = [
      'KERNEL[123.456] add      /devices/pci0000:00/nvme2 (block)',
      'ACTION=add',
      'DEVNAME=/dev/nvme2n1',
      '', // blank line terminates record
    ];
    const deltas: Array<{ action: string; devname: string }> = [];
    const fixture = readFileSync(fixturePath, 'utf8');
    const probe = createDiskProbe({
      execFile: makeExecFile(fixture) as any,
      spawnMonitor: (opts) => {
        // immediately replay the udevadm lines
        for (const line of udevRecord) opts.onLine(line);
        return { stop: async () => {} };
      },
    });
    probe.startEventStream((delta) => deltas.push(delta as any));
    await new Promise((r) => setTimeout(r, 50));
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]?.action).toBe('add');
    expect(deltas[0]?.devname).toMatch(/nvme2n1/);
  });
});
