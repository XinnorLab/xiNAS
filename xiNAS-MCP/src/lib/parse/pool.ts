/**
 * xiRAID pool parsing (S9 T7, ADR-0011).
 *
 * `pool_show` payloads come in two shapes in the wild (the TUI handles
 * both): an ARRAY of pool objects, or a DICT keyed by pool name. Both
 * normalize to `{name, drives, active}`. `referenced_by` is NOT
 * computed here — it joins observed arrays' `spare_pool` at read time
 * (api-side) so a just-swept array is never missed.
 *
 * The real xiRAID 4.3.x daemon emits the dict shape, and reports
 * `state` as a LIST of words (`{"e": {"devices": [], "name": "e",
 * "serials": [], "sizes": [], "state": ["active"]}}`) — the same
 * vocabulary `raid_show` uses for an array's state. Reading `state`
 * as a bare string leaves every live pool observed as INACTIVE, which
 * disarms the `pool_active` plan blocker AND the delete executor's
 * live preflight. Both shapes are covered below; cover both in tests.
 */

export interface ObservedPool {
  name: string;
  drives: string[];
  active: boolean;
}

/** The device path out of one `devices` entry, whatever shape it takes. */
function devicePath(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  // Tuple shape: [index, "/dev/…"] or, like raid_show, [index, "/dev/…",
  // [states]]. Scan for the path rather than indexing a fixed position —
  // a trailing serial/state element must not be mistaken for the device.
  if (Array.isArray(entry)) {
    const path = entry.find((x): x is string => typeof x === 'string' && x.startsWith('/dev/'));
    return path ?? null;
  }
  return null;
}

/** `active` from either the boolean field or the state-word vocabulary. */
function isActive(raw: Record<string, unknown>): boolean {
  if (typeof raw.active === 'boolean') return raw.active;
  const state = raw.state;
  const word = typeof state === 'string' ? state : Array.isArray(state) ? state[0] : undefined;
  return typeof word === 'string' && word.toLowerCase() === 'active';
}

function normalizeOne(name: string, raw: Record<string, unknown>): ObservedPool {
  const drivesRaw = raw.drives ?? raw.devices;
  const drives = Array.isArray(drivesRaw)
    ? drivesRaw.map(devicePath).filter((d): d is string => d !== null)
    : [];
  return { name, drives, active: isActive(raw) };
}

export function parsePoolShow(payload: unknown): ObservedPool[] {
  if (Array.isArray(payload)) {
    const out: ObservedPool[] = [];
    for (const entry of payload) {
      if (typeof entry !== 'object' || entry === null) continue;
      const o = entry as Record<string, unknown>;
      if (typeof o.name !== 'string' || o.name.length === 0) continue;
      out.push(normalizeOne(o.name, o));
    }
    return out;
  }
  if (typeof payload === 'object' && payload !== null) {
    return Object.entries(payload as Record<string, unknown>)
      .filter((e): e is [string, Record<string, unknown>] => {
        const v = e[1];
        return typeof v === 'object' && v !== null;
      })
      .map(([name, raw]) => normalizeOne(name, raw));
  }
  return [];
}
