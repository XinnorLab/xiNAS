/**
 * Full-file render of /etc/netplan/99-xinas.yaml from desired
 * NetworkInterface rows (S6 T2, ADR-0008 §Render).
 *
 * Day-1 template parity (collection/roles/net_controllers/templates/
 * netplan.yaml.j2): per enabled interface — dhcp4 off, addresses, mtu,
 * the connected-subnet route in the interface's allocated PBR table
 * (scope: link), and one routing-policy entry per address
 * (from <ip>, table = priority = pbr_table_id).
 *
 * Deterministic: interfaces sorted by name, stable key order — a
 * re-render of the same rows is byte-identical (the xinas_file_hash
 * drift check depends on this). Pure; no I/O.
 */

import yaml from 'js-yaml';

export interface DesiredIfaceSpec {
  name: string;
  addresses: string[];
  mtu?: number;
  enabled: boolean;
  pbr_table_id: number;
}

/** '10.10.1.1/24' → '10.10.1.0/24' (IPv4 network address of the CIDR). */
export function connectedSubnet(cidr: string): string {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const octets = (ip ?? '').split('.').map(Number);
  if (octets.length !== 4 || octets.some(Number.isNaN) || !Number.isInteger(prefix)) {
    throw new Error(`connectedSubnet: unparsable CIDR '${cidr}'`);
  }
  const addr = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (addr & mask) >>> 0;
  return `${(net >>> 24) & 0xff}.${(net >>> 16) & 0xff}.${(net >>> 8) & 0xff}.${net & 0xff}/${prefix}`;
}

const HEADER =
  '# Managed by xiNAS — render of desired NetworkInterface state (ADR-0008).\n' +
  '# Do not hand-edit: every network apply rewrites this file in full.\n';

export function renderNetplan(rows: DesiredIfaceSpec[]): string {
  const ethernets: Record<string, unknown> = {};
  for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!row.enabled) continue;
    const first = row.addresses[0];
    ethernets[row.name] = {
      dhcp4: false,
      addresses: row.addresses,
      ...(row.mtu !== undefined ? { mtu: row.mtu } : {}),
      ...(first !== undefined
        ? {
            routes: [
              { to: connectedSubnet(first), scope: 'link', table: row.pbr_table_id },
            ],
            'routing-policy': row.addresses.map((cidr) => ({
              from: cidr.split('/')[0],
              table: row.pbr_table_id,
              priority: row.pbr_table_id,
            })),
          }
        : {}),
    };
  }
  const doc = { network: { version: 2, renderer: 'networkd', ethernets } };
  return HEADER + yaml.dump(doc, { sortKeys: false, lineWidth: 120 });
}
