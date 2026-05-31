/**
 * Pure parser for `ip -j addr show` output. Emits typed
 * ObservedNetworkInterface objects matching api-v1.yaml's
 * NetworkInterface schema.
 *
 * No side effects. Safe to import from anywhere.
 */

interface RawAddrInfo {
  family?: string;
  local?: string;
  prefixlen?: number;
  scope?: string;
}

interface RawIpInterface {
  ifname: string;
  mtu?: number;
  operstate?: string;
  address?: string;
  addr_info?: RawAddrInfo[];
}

export interface ObservedNetworkInterface {
  kind: 'NetworkInterface';
  id: string;
  status: {
    name: string;
    operstate: string;
    ip4_addresses: string[];
    ip6_addresses: string[];
    mtu?: number;
    mac?: string;
  };
}

export function parseIpJson(raw: string): ObservedNetworkInterface[] {
  let parsed: RawIpInterface[];
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseIpJson: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('parseIpJson: expected a JSON array at the top level');
  }
  return parsed.map<ObservedNetworkInterface>((iface) => {
    const addrInfo = iface.addr_info ?? [];
    const ip4_addresses = addrInfo
      .filter((a) => a.family === 'inet' && a.local !== undefined)
      .map((a) => `${a.local}/${a.prefixlen ?? ''}`);
    const ip6_addresses = addrInfo
      .filter((a) => a.family === 'inet6' && a.local !== undefined)
      .map((a) => `${a.local}/${a.prefixlen ?? ''}`);
    return {
      kind: 'NetworkInterface',
      id: iface.ifname,
      status: {
        name: iface.ifname,
        operstate: iface.operstate ?? 'UNKNOWN',
        ip4_addresses,
        ip6_addresses,
        ...(iface.mtu !== undefined ? { mtu: iface.mtu } : {}),
        ...(iface.address !== undefined ? { mac: iface.address } : {}),
      },
    };
  });
}
