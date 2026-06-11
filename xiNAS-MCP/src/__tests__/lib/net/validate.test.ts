import { describe, expect, it } from 'vitest';
import {
  type NetFacts,
  allocatePool,
  allocateTableId,
  parseIfaceUpdateSpec,
  parsePoolSpec,
  validateIfaceUpdate,
  validatePool,
} from '../../../lib/net/validate.js';

const codes = (blockers: Array<{ code: string }>): string[] => blockers.map((b) => b.code);

function facts(over: Partial<NetFacts> = {}): NetFacts {
  return {
    managed: [
      {
        name: 'ibp65s0',
        desired: {
          name: 'ibp65s0',
          addresses: ['10.10.1.1/24'],
          enabled: true,
          pbr_table_id: 100,
        },
      },
      { name: 'ibp9s0f0', stanza: { file: '/etc/netplan/99-xinas.yaml', addresses: ['10.10.2.1/24'], pbr_table_id: 101 } },
    ],
    duplicates: {},
    usedTableIds: new Set([100, 101]),
    desiredAddressByIface: { ibp65s0: ['10.10.1.1/24'] },
    ...over,
  };
}

describe('parseIfaceUpdateSpec / parsePoolSpec', () => {
  it('tolerant narrowing; junk throws; at least one writable key required', () => {
    expect(parseIfaceUpdateSpec({ addresses: ['10.10.5.1/24'], extra_enrichment: 1 }).addresses)
      .toEqual(['10.10.5.1/24']);
    expect(parseIfaceUpdateSpec({ mtu: 4092 }).mtu).toBe(4092);
    expect(parseIfaceUpdateSpec({ enabled: false }).enabled).toBe(false);
    expect(() => parseIfaceUpdateSpec(null)).toThrow(/object/);
    expect(() => parseIfaceUpdateSpec({ cleanup: true })).toThrow(/at least one/i);
    expect(() => parseIfaceUpdateSpec({ addresses: 'not-array' })).toThrow(/addresses/);
  });

  it('pool spec: start IPv4 + prefix 8–30 required', () => {
    expect(parsePoolSpec({ start: '10.10.1.1', prefix: 24 })).toMatchObject({
      start: '10.10.1.1',
      prefix: 24,
    });
    expect(() => parsePoolSpec({ start: 'nope', prefix: 24 })).toThrow(/start/);
    expect(() => parsePoolSpec({ start: '10.0.0.1', prefix: 31 })).toThrow(/prefix/);
  });
});

describe('allocateTableId / allocatePool', () => {
  it('lowest free in [100,199]; exhaustion → null', () => {
    expect(allocateTableId(new Set([100, 101]))).toBe(102);
    expect(allocateTableId(new Set())).toBe(100);
    const all = new Set(Array.from({ length: 100 }, (_v, i) => 100 + i));
    expect(allocateTableId(all)).toBeNull();
  });

  it('day-1 pool formula; third-octet overflow → null', () => {
    expect(allocatePool('10.10.1.1', 24, ['b', 'a', 'c'])).toEqual({
      a: '10.10.1.1/24',
      b: '10.10.2.1/24',
      c: '10.10.3.1/24',
    });
    expect(allocatePool('10.10.254.1', 24, ['a', 'b', 'c'])).toBeNull();
  });
});

describe('validateIfaceUpdate', () => {
  const SPEC = { addresses: ['10.10.5.1/24'] };

  it('clean update → no blockers', () => {
    expect(validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec(SPEC), facts())).toEqual([]);
  });

  it('duplicate without cleanup blocks; with cleanup it does not', () => {
    const f = facts({ duplicates: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] } });
    expect(
      codes(validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec(SPEC), f)),
    ).toContain('duplicate_netplan_definition');
    expect(
      validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec({ ...SPEC, cleanup: true }), f),
    ).toEqual([]);
  });

  it('blocker table: addresses_invalid, mtu_invalid, address_conflict, pbr_table_exhausted', () => {
    expect(
      codes(validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec({ addresses: ['bogus'] }), facts())),
    ).toContain('addresses_invalid');
    expect(
      codes(validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec({ mtu: 1279 }), facts())),
    ).toContain('mtu_invalid');
    expect(
      codes(validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec({ mtu: 65521 }), facts())),
    ).toContain('mtu_invalid');
    expect(
      validateIfaceUpdate('ibp65s0', parseIfaceUpdateSpec({ mtu: 65520 }), facts()),
    ).toEqual([]);
    // 10.10.1.1/24 is ibp65s0's own address — updating ibp9s0f0 to it conflicts
    expect(
      codes(
        validateIfaceUpdate('ibp9s0f0', parseIfaceUpdateSpec({ addresses: ['10.10.1.1/24'] }), facts()),
      ),
    ).toContain('address_conflict');
    // a NEW iface (no table yet) with the pool exhausted
    const exhausted = facts({
      usedTableIds: new Set(Array.from({ length: 100 }, (_v, i) => 100 + i)),
      managed: [{ name: 'ibpNew' }],
      desiredAddressByIface: {},
    });
    expect(
      codes(validateIfaceUpdate('ibpNew', parseIfaceUpdateSpec(SPEC), exhausted)),
    ).toContain('pbr_table_exhausted');
  });
});

describe('validatePool', () => {
  it('clean pool → no blockers; overflow and empty pools block', () => {
    expect(validatePool(parsePoolSpec({ start: '10.10.1.1', prefix: 24 }), facts())).toEqual([]);
    expect(
      codes(validatePool(parsePoolSpec({ start: '10.10.255.1', prefix: 24 }), facts())),
    ).toContain('pool_overflow');
    expect(
      codes(validatePool(parsePoolSpec({ start: '10.10.1.1', prefix: 24 }), facts({ managed: [] }))),
    ).toContain('no_managed_interfaces');
  });

  it('duplicates gate the pool too (cleanup clears it)', () => {
    const f = facts({ duplicates: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] } });
    expect(codes(validatePool(parsePoolSpec({ start: '10.10.1.1', prefix: 24 }), f))).toContain(
      'duplicate_netplan_definition',
    );
    expect(
      validatePool(parsePoolSpec({ start: '10.10.1.1', prefix: 24, cleanup: true }), f),
    ).toEqual([]);
  });
});
