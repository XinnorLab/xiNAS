import { describe, expect, it } from 'vitest';
import {
  XINAS_NETPLAN,
  netplanHashes,
  parseNetplanFiles,
} from '../../../lib/parse/netplan.js';

const XINAS = `
network:
  version: 2
  renderer: networkd
  ethernets:
    ibp65s0:
      dhcp4: false
      addresses: [10.10.1.1/24]
      mtu: 4092
      routes:
        - to: 10.10.1.0/24
          scope: link
          table: 100
      routing-policy:
        - from: 10.10.1.1
          table: 100
          priority: 100
    ibp9s0f0:
      dhcp4: false
      addresses: [10.10.2.1/24]
      routing-policy:
        - from: 10.10.2.1
          table: 101
          priority: 101
`;

const CLOUD_INIT = `
network:
  version: 2
  ethernets:
    eno1:
      dhcp4: true
    ibp65s0:
      addresses: [192.168.99.5/24]
`;

const FILES = {
  [XINAS_NETPLAN]: XINAS,
  '/etc/netplan/50-cloud-init.yaml': CLOUD_INIT,
};

describe('parseNetplanFiles', () => {
  it('extracts stanzas with 99-xinas ownership precedence', () => {
    const parsed = parseNetplanFiles(FILES);
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
    // eno1 only exists in the foreign file → owned by it
    expect(parsed.stanzas.eno1?.file).toBe('/etc/netplan/50-cloud-init.yaml');
  });

  it('duplicates list FOREIGN files only (the owning 99-xinas entry is not a duplicate)', () => {
    const parsed = parseNetplanFiles(FILES);
    expect(parsed.duplicates).toEqual({
      ibp65s0: ['/etc/netplan/50-cloud-init.yaml'],
    });
    expect(parsed.perFileIfaces['/etc/netplan/50-cloud-init.yaml']).toEqual(
      ['eno1', 'ibp65s0'],
    );
  });

  it('unparsable foreign YAML is reported, never thrown', () => {
    const parsed = parseNetplanFiles({
      ...FILES,
      '/etc/netplan/01-broken.yaml': 'network: [unclosed',
    });
    expect(parsed.unparsable_files).toEqual(['/etc/netplan/01-broken.yaml']);
    expect(parsed.stanzas.ibp65s0?.file).toBe(XINAS_NETPLAN);
  });
});

describe('netplanHashes', () => {
  it('is deterministic and splits world vs xinas hashes', () => {
    const a = netplanHashes(FILES);
    const b = netplanHashes(FILES);
    expect(a).toEqual(b);
    expect(a.world_config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.xinas_file_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('editing a FOREIGN file changes world but not xinas hash', () => {
    const base = netplanHashes(FILES);
    const edited = netplanHashes({
      ...FILES,
      '/etc/netplan/50-cloud-init.yaml': `${CLOUD_INIT}\n# touched`,
    });
    expect(edited.world_config_hash).not.toBe(base.world_config_hash);
    expect(edited.xinas_file_hash).toBe(base.xinas_file_hash);
  });

  it('editing 99-xinas changes both; absent 99-xinas → empty xinas hash', () => {
    const base = netplanHashes(FILES);
    const edited = netplanHashes({ ...FILES, [XINAS_NETPLAN]: `${XINAS}\n# v2` });
    expect(edited.world_config_hash).not.toBe(base.world_config_hash);
    expect(edited.xinas_file_hash).not.toBe(base.xinas_file_hash);

    const absent = netplanHashes({ '/etc/netplan/50-cloud-init.yaml': CLOUD_INIT });
    expect(absent.xinas_file_hash).toBe('');
  });

  it('hash is independent of object key insertion order', () => {
    const reversed = netplanHashes({
      '/etc/netplan/50-cloud-init.yaml': CLOUD_INIT,
      [XINAS_NETPLAN]: XINAS,
    });
    expect(reversed.world_config_hash).toBe(netplanHashes(FILES).world_config_hash);
  });
});
