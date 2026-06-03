import type { ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNetworkProbe } from '../../../agent/probe/network.js';

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

function makeExecFile(stdout: string) {
  return (
    _f: string,
    _a: string[],
    _o: ExecFileOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, stdout, '');
  };
}

describe('NetworkProbe', () => {
  it('snapshot() returns parsed interfaces via injected execFile', async () => {
    // Fixture has 3 interfaces: lo, enp3s0, ibp0s4
    const fixture = readFileSync(join(fixtureDir, 'ip-addr-show.json'), 'utf8');
    const probe = createNetworkProbe({ execFile: makeExecFile(fixture) as any });
    const ifaces = await probe.snapshot();
    expect(ifaces.length).toBe(3);
    const enp3s0 = ifaces.find((i) => i.id === 'enp3s0');
    expect(enp3s0).toBeDefined();
    expect(enp3s0?.status.mac).toBe('d8:5e:d3:0a:1b:2c');
    expect(enp3s0?.status.operstate).toBe('UP');
  });

  it('startEventStream() emits delta on injected ip-monitor line', async () => {
    const fixture = readFileSync(join(fixtureDir, 'ip-addr-show.json'), 'utf8');
    const monitorLine = JSON.stringify([
      {
        ifindex: 3,
        ifname: 'ibp0s4',
        flags: ['BROADCAST', 'MULTICAST', 'UP'],
        mtu: 4092,
        operstate: 'UP',
        link_type: 'infiniband',
        address: '11:22:33:44:55:66',
        addr_info: [],
      },
    ]);
    const deltas: any[] = [];
    const probe = createNetworkProbe({
      execFile: makeExecFile(fixture) as any,
      spawnMonitor: (opts) => {
        opts.onLine(monitorLine);
        return { stop: async () => {} };
      },
    });
    probe.startEventStream((d) => deltas.push(d));
    await new Promise((r) => setTimeout(r, 50));
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]?.id).toBe('ibp0s4');
  });

  it('snapshot() throws on ip exec failure', async () => {
    const probe = createNetworkProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => {
        cb(new Error('ip: command not found'), '', '');
      },
    });
    await expect(probe.snapshot()).rejects.toThrow(/ip/);
  });
});
