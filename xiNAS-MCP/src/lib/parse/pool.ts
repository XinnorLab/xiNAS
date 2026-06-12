/**
 * xiRAID pool parsing (S9 T7, ADR-0011).
 *
 * `pool_show` payloads come in two shapes in the wild (the TUI handles
 * both): an ARRAY of pool objects, or a DICT keyed by pool name. Both
 * normalize to `{name, drives, active}`. `referenced_by` is NOT
 * computed here — it joins observed arrays' `spare_pool` at read time
 * (api-side) so a just-swept array is never missed.
 */

export interface ObservedPool {
  name: string;
  drives: string[];
  active: boolean;
}

function normalizeOne(name: string, raw: Record<string, unknown>): ObservedPool {
  const drivesRaw = raw.drives ?? raw.devices;
  const drives = Array.isArray(drivesRaw)
    ? drivesRaw
        .map((d) => {
          if (typeof d === 'string') return d;
          // the dict shape sometimes lists devices as [index, path] pairs
          if (Array.isArray(d) && typeof d[d.length - 1] === 'string') {
            return d[d.length - 1] as string;
          }
          return null;
        })
        .filter((d): d is string => d !== null)
    : [];
  const active =
    typeof raw.active === 'boolean'
      ? raw.active
      : typeof raw.state === 'string'
        ? raw.state.toLowerCase() === 'active'
        : false;
  return { name, drives, active };
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
