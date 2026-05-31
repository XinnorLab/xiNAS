import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIpJson } from '../../../lib/parse/network.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseIpJson', () => {
  it('parses a typical ip -j addr show output into ObservedNetworkInterface[]', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/ip-addr-show.json'), 'utf8');
    const ifaces = parseIpJson(raw);
    expect(ifaces).toHaveLength(3);

    const eth = ifaces.find((i) => i.id === 'enp3s0');
    expect(eth).toBeDefined();
    expect(eth?.status.mac).toBe('d8:5e:d3:0a:1b:2c');
    expect(eth?.status.mtu).toBe(1500);
    expect(eth?.status.operstate).toBe('UP');
    expect(eth?.status.ip4_addresses).toContain('10.0.0.5/24');
    expect(eth?.status.ip6_addresses).toContain('fe80::da5e:d3ff:fe0a:1b2c/64');

    const ib = ifaces.find((i) => i.id === 'ibp0s4');
    expect(ib).toBeDefined();
    expect(ib?.status.mtu).toBe(4092);
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => parseIpJson('not json')).toThrow(/JSON/);
  });

  it('handles an interface with no addr_info gracefully', () => {
    const raw = JSON.stringify([
      { ifindex: 3, ifname: 'eth0', flags: [], mtu: 1500, operstate: 'DOWN', link_type: 'ether' },
    ]);
    const ifaces = parseIpJson(raw);
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0]?.id).toBe('eth0');
    expect(ifaces[0]?.status.ip4_addresses).toEqual([]);
    expect(ifaces[0]?.status.ip6_addresses).toEqual([]);
    expect(ifaces[0]?.status.mac).toBeUndefined();
  });

  it('emits bare address (no trailing slash) when prefixlen is absent', () => {
    const raw = JSON.stringify([
      {
        ifname: 'ib0',
        operstate: 'UP',
        addr_info: [{ family: 'inet', local: '10.1.2.3' }],
      },
    ]);
    const ifaces = parseIpJson(raw);
    expect(ifaces).toHaveLength(1);
    const addr = ifaces[0]?.status.ip4_addresses[0];
    expect(addr).toBe('10.1.2.3');
    expect(addr).not.toContain('/');
  });
});
