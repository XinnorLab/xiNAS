/**
 * Netplan file-set parsing + hashing (S6 T2, ADR-0008).
 *
 * Pure: callers (the network probe, plan providers, executors) hand in
 * the file map; nothing here touches the filesystem. Shared by
 * duplicate detection, adoption (the per-iface stanza), and the
 * two-hash freshness/drift split:
 *
 *  - `world_config_hash` — over ALL netplan files (freshness pin: any
 *    netplan edit, foreign or ours, invalidates in-flight plans);
 *  - `xinas_file_hash`   — over 99-xinas.yaml alone (the WS9 drift
 *    anchor: foreign files legitimately exist and change).
 */

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

export const XINAS_NETPLAN = '/etc/netplan/99-xinas.yaml';

export interface NetplanStanza {
  file: string;
  addresses: string[];
  mtu?: number;
  pbr_table_id?: number;
}

export interface ParsedNetplan {
  /** iface → owning stanza (the 99-xinas definition wins when present). */
  stanzas: Record<string, NetplanStanza>;
  /** iface → FOREIGN files that also define it (the duplicate blocker's evidence). */
  duplicates: Record<string, string[]>;
  perFileIfaces: Record<string, string[]>;
  /** Foreign files whose YAML failed to parse (warning, never a crash). */
  unparsable_files: string[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface RawStanza {
  addresses?: unknown;
  mtu?: unknown;
  'routing-policy'?: unknown;
}

function toStanza(file: string, raw: RawStanza): NetplanStanza {
  const addresses = Array.isArray(raw.addresses)
    ? raw.addresses.filter((a): a is string => typeof a === 'string')
    : [];
  const policy = Array.isArray(raw['routing-policy']) ? raw['routing-policy'][0] : undefined;
  const table =
    typeof policy === 'object' && policy !== null && typeof (policy as { table?: unknown }).table === 'number'
      ? ((policy as { table: number }).table as number)
      : undefined;
  return {
    file,
    addresses,
    ...(typeof raw.mtu === 'number' ? { mtu: raw.mtu } : {}),
    ...(table !== undefined ? { pbr_table_id: table } : {}),
  };
}

export function parseNetplanFiles(files: Record<string, string>): ParsedNetplan {
  const stanzas: Record<string, NetplanStanza> = {};
  const seenIn: Record<string, string[]> = {};
  const perFileIfaces: Record<string, string[]> = {};
  const unparsable: string[] = [];

  for (const file of Object.keys(files).sort()) {
    let doc: unknown;
    try {
      doc = yaml.load(files[file] ?? '');
    } catch {
      unparsable.push(file);
      continue;
    }
    const ethernets =
      typeof doc === 'object' && doc !== null
        ? ((doc as { network?: { ethernets?: Record<string, RawStanza> } }).network?.ethernets ?? {})
        : {};
    const names = Object.keys(ethernets).sort();
    perFileIfaces[file] = names;
    for (const name of names) {
      (seenIn[name] ??= []).push(file);
      const existing = stanzas[name];
      // 99-xinas owns; otherwise first (alphabetical) file wins for the
      // stanza record — the duplicate map carries the rest.
      if (existing === undefined || file === XINAS_NETPLAN) {
        stanzas[name] = toStanza(file, ethernets[name] ?? {});
      }
    }
  }

  const duplicates: Record<string, string[]> = {};
  for (const [name, inFiles] of Object.entries(seenIn)) {
    const foreign = inFiles.filter((f) => f !== (stanzas[name]?.file ?? ''));
    // Only ifaces OWNED by 99-xinas count as duplicated (the blocker is
    // about xiNAS-managed config leaking into foreign files).
    if (stanzas[name]?.file === XINAS_NETPLAN && foreign.length > 0) {
      duplicates[name] = foreign;
    }
  }

  return { stanzas, duplicates, perFileIfaces, unparsable_files: unparsable };
}

export function netplanHashes(files: Record<string, string>): {
  world_config_hash: string;
  xinas_file_hash: string;
} {
  const sorted = Object.keys(files).sort();
  const list = sorted.map((path) => [path, sha256(files[path] ?? '')]);
  const xinas = files[XINAS_NETPLAN];
  return {
    world_config_hash: sha256(JSON.stringify(list)),
    xinas_file_hash: xinas !== undefined ? sha256(xinas) : '',
  };
}
