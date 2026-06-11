import { describe, expect, it } from 'vitest';
import { XINAS_NETPLAN, parseNetplanFiles } from '../../../lib/parse/netplan.js';
import { connectedSubnet, renderNetplan } from '../../../lib/net/render.js';

const ROWS = [
  {
    name: 'ibp9s0f0',
    addresses: ['10.10.2.1/24'],
    enabled: true,
    pbr_table_id: 101,
  },
  {
    name: 'ibp65s0',
    addresses: ['10.10.1.1/24'],
    mtu: 4092,
    enabled: true,
    pbr_table_id: 100,
  },
];

describe('connectedSubnet', () => {
  it.each([
    ['10.10.1.1/24', '10.10.1.0/24'],
    ['192.168.5.77/16', '192.168.0.0/16'],
    ['10.0.0.9/30', '10.0.0.8/30'],
  ])('%s → %s', (cidr, subnet) => {
    expect(connectedSubnet(cidr)).toBe(subnet);
  });
});

describe('renderNetplan (day-1 template parity)', () => {
  it('renders the full file: sorted ifaces, dhcp4 off, PBR route + policy', () => {
    const text = renderNetplan(ROWS);
    const parsed = parseNetplanFiles({ [XINAS_NETPLAN]: text });
    // round-trip: stanzas match the desired rows
    expect(parsed.stanzas.ibp65s0).toEqual({
      file: XINAS_NETPLAN,
      addresses: ['10.10.1.1/24'],
      mtu: 4092,
      pbr_table_id: 100,
    });
    expect(parsed.stanzas.ibp9s0f0).toEqual({
      file: XINAS_NETPLAN,
      addresses: ['10.10.2.1/24'],
      pbr_table_id: 101,
    });
    // sorted iface order + day-1 shape facts
    expect(text.indexOf('ibp65s0')).toBeLessThan(text.indexOf('ibp9s0f0'));
    expect(text).toContain('version: 2');
    expect(text).toContain('renderer: networkd');
    expect(text).toContain('dhcp4: false');
    expect(text).toContain('to: 10.10.1.0/24');
    expect(text).toContain('scope: link');
    expect(text).toContain('from: 10.10.1.1');
    expect(text).toContain('priority: 100');
    expect(text.startsWith('# Managed by xiNAS')).toBe(true);
  });

  it('is deterministic (byte-equal across calls and input order)', () => {
    const a = renderNetplan(ROWS);
    const b = renderNetplan([...ROWS].reverse());
    expect(a).toBe(b);
  });

  it('disabled rows are omitted from the render', () => {
    const text = renderNetplan([
      ...ROWS,
      { name: 'ibpX', addresses: ['10.10.9.1/24'], enabled: false, pbr_table_id: 102 },
    ]);
    expect(text).not.toContain('ibpX');
  });

  it('multi-address rows: one routing-policy entry per address, same table', () => {
    const text = renderNetplan([
      {
        name: 'ibp65s0',
        addresses: ['10.10.1.1/24', '10.10.1.2/24'],
        enabled: true,
        pbr_table_id: 100,
      },
    ]);
    expect(text).toContain('from: 10.10.1.1');
    expect(text).toContain('from: 10.10.1.2');
    const tables = text.match(/table: 100/g) ?? [];
    expect(tables.length).toBeGreaterThanOrEqual(3); // route + 2 policies
  });
});
