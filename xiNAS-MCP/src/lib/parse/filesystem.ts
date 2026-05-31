/**
 * Pure converter from a parsed systemd .mount unit (output of
 * parseSystemdUnit) + unit metadata into an ObservedFilesystem.
 *
 * No side effects. Safe to import from anywhere.
 */

import type { ParsedSystemdUnit } from './systemd-unit.js';

export interface ObservedFilesystem {
  kind: 'Filesystem';
  id: string;
  spec: {
    mountpoint: string;
    backing_device: string;
    fs_type?: string;
    options?: string[];
  };
  status: {
    mount_unit_name: string;
    // Enablement from `systemctl is-enabled` (a boolean here). The systemd
    // runtime ActiveState (active/inactive/failed/…) is a DIFFERENT field,
    // `mount_unit_state`, populated by the dbus cross-reference in the
    // Filesystem collector (E4) — NOT derivable from is-enabled. B4 sets
    // only what it knows (enablement); E4 fills mount_unit_state +
    // currently_mounted from /proc/self/mountinfo + dbus.
    mount_unit_enabled: boolean;
  };
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export function mountUnitToFilesystem(
  parsed: ParsedSystemdUnit,
  unitName: string,
  isEnabled: boolean,
): ObservedFilesystem {
  const mount = parsed.mount ?? {};
  const where = firstString(mount['Where']) ?? '';
  const what = firstString(mount['What']) ?? '';
  const type = firstString(mount['Type']);
  const optionsRaw = firstString(mount['Options']);
  const options = optionsRaw !== undefined ? optionsRaw.split(',').map((o) => o.trim()) : undefined;

  return {
    kind: 'Filesystem',
    id: unitName,
    spec: {
      mountpoint: where,
      backing_device: what,
      ...(type !== undefined ? { fs_type: type } : {}),
      ...(options !== undefined ? { options } : {}),
    },
    status: {
      mount_unit_name: unitName,
      mount_unit_enabled: isEnabled,
    },
  };
}
