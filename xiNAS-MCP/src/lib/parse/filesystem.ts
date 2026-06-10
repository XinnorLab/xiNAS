/**
 * Pure converter from a parsed systemd .mount unit (output of
 * parseSystemdUnit) + unit metadata into an ObservedFilesystem.
 *
 * STATUS-ONLY (S5 T1, ADR-0007 §Observation normalization): observed
 * Filesystem rows carry every fact under `status` — the earlier `spec`
 * block was silently DROPPED by the convergence adapter's
 * `{kind, id, status}` passthrough, leaving real-host rows with nothing
 * but the unit name/enablement (and the S4 array-delete dependency walk
 * blind outside fixtures). The canonical mounted flag is `mounted`
 * (filled by the probe's mountinfo cross-reference, S5 T6); enablement
 * (`mount_unit_enabled`, from `systemctl is-enabled`) remains a distinct
 * fact from runtime state.
 *
 * No side effects. Safe to import from anywhere.
 */

import type { ParsedSystemdUnit } from './systemd-unit.js';

export interface ObservedFilesystem {
  kind: 'Filesystem';
  id: string;
  status: {
    mountpoint: string;
    backing_device: string;
    fs_type?: string;
    mount_options?: string[];
    mount_unit_name: string;
    mount_unit_enabled: boolean;
    /** Canonical runtime flag; absent until the mountinfo cross-ref fills it. */
    mounted?: boolean;
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
    status: {
      mountpoint: where,
      backing_device: what,
      ...(type !== undefined ? { fs_type: type } : {}),
      ...(options !== undefined ? { mount_options: options } : {}),
      mount_unit_name: unitName,
      mount_unit_enabled: isEnabled,
    },
  };
}
