/**
 * Pure parser for `lsblk --json` output. Emits typed Disk objects
 * matching api-v1.yaml's Disk schema (subset — full status fields
 * stamped by the agent's probe layer, not here).
 *
 * S3 T2 enrichment (ADR-0006 §Disk references): with `--bytes` +
 * `MOUNTPOINTS` in the lsblk invocation, the parser also derives
 * `device_path`, `capacity_bytes`, `system_disk`, `mounted`, and
 * `safe_for_use` (= !system_disk && !mounted). It stays tolerant of the
 * old human-readable SIZE strings (then `capacity_bytes` is omitted).
 *
 * No side effects. Safe to import from anywhere.
 */

interface RawBlockDevice {
  name: string;
  type?: string;
  size?: number | string;
  model?: string;
  serial?: string;
  tran?: string;
  wwn?: string;
  mountpoints?: (string | null)[];
  children?: RawBlockDevice[];
}

/** Descendant mountpoints that mark the disk as the system disk. */
const SYSTEM_MOUNTPOINTS = new Set(['/', '/boot', '/boot/efi']);

export interface ObservedDisk {
  kind: 'Disk';
  id: string;
  status: {
    name: string;
    device_path: string;
    model?: string;
    serial?: string;
    transport?: string;
    wwn?: string;
    size_text?: string;
    capacity_bytes?: number;
    system_disk: boolean;
    mounted: boolean;
    safe_for_use: boolean;
  };
}

export function parseLsblkOutput(raw: string): ObservedDisk[] {
  let parsed: { blockdevices?: RawBlockDevice[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseLsblkOutput: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const devices = parsed.blockdevices ?? [];
  return devices
    .filter((d) => d.type === 'disk' || d.type === undefined)
    .map<ObservedDisk>((d) => {
      const capacityBytes = typeof d.size === 'number' ? d.size : undefined;
      const sizeText =
        capacityBytes !== undefined
          ? formatBytes(capacityBytes)
          : typeof d.size === 'string'
            ? d.size
            : undefined;
      const mountpoints = collectMountpoints(d);
      const systemDisk = mountpoints.some((m) => SYSTEM_MOUNTPOINTS.has(m));
      const mounted = mountpoints.length > 0;
      return {
        kind: 'Disk',
        // PROVISIONAL: id is the device name here; the Phase E (E2) collector
        // replaces it with the stable serial+namespace key before the observation
        // is published to the api-v1.yaml Disk schema.
        id: d.name,
        status: {
          name: d.name,
          device_path: `/dev/${d.name}`,
          // lsblk emits `null` (not omitted) for these on virtual block
          // devices — e.g. xiRAID volumes /dev/xi_data, /dev/xi_log have no
          // model/serial/transport/wwn. The api Disk schema types them as
          // `string`, and inbound validation strips `required` but still checks
          // TYPE, so a JSON `null` fails "must be string" and — because the
          // observed endpoint fail-closes the WHOLE batch on one bad delta —
          // silently dropped EVERY disk on real hardware. Guard on `string`
          // (not `!== undefined`, which lets `null` through).
          ...(typeof d.model === 'string' ? { model: d.model } : {}),
          ...(typeof d.serial === 'string' ? { serial: d.serial } : {}),
          ...(typeof d.tran === 'string' ? { transport: d.tran } : {}),
          ...(typeof d.wwn === 'string' ? { wwn: d.wwn } : {}),
          ...(sizeText !== undefined ? { size_text: sizeText } : {}),
          ...(capacityBytes !== undefined ? { capacity_bytes: capacityBytes } : {}),
          system_disk: systemDisk,
          mounted,
          safe_for_use: !systemDisk && !mounted,
        },
      };
    });
}

/** All non-null mountpoints of a device and its descendants. */
function collectMountpoints(device: RawBlockDevice): string[] {
  const out: string[] = [];
  const walk = (d: RawBlockDevice): void => {
    for (const m of d.mountpoints ?? []) {
      if (m !== null) out.push(m);
    }
    for (const child of d.children ?? []) walk(child);
  };
  walk(device);
  return out;
}

/** Binary-units human size (lsblk style: one decimal, T/G/M/K). */
function formatBytes(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    value >= 10 || Number.isInteger(value)
      ? Math.round(value * 10) / 10
      : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}
