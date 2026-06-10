/**
 * systemd unit naming + .mount rendering for the S5 filesystem adapter
 * (ADR-0007 §Identity / S5 spec §3).
 *
 * Escaping follows `systemd-escape -p` semantics (unit-tested goldens):
 *  - the path is normalized (duplicate + trailing slashes removed);
 *  - '/' becomes '-', the leading slash is dropped ('/' itself → '-');
 *  - within each component, [a-zA-Z0-9_] and non-leading '.' stay
 *    verbatim; everything else (incl. '-' and a leading '.') becomes
 *    \xNN (lowercase hex of the byte).
 *
 * The render reproduces the day-1 raid_fs mount.unit.j2 shape so a
 * day-2-created filesystem is indistinguishable from an installer one.
 *
 * Pure. No I/O.
 */

export type QuotaMode = 'none' | 'uquota' | 'gquota' | 'pquota';

/** Escape one path per systemd-escape -p (path mode). */
function escapePath(path: string): string {
  // normalize: collapse duplicate slashes, strip trailing slash (keep '/')
  const normalized = path.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  if (normalized === '/') return '-';
  const body = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  return body
    .split('/')
    .map((component) =>
      [...Buffer.from(component, 'utf8')]
        .map((byte, idx) => {
          const ch = String.fromCharCode(byte);
          const isWordChar = /[a-zA-Z0-9_]/.test(ch);
          const isSafeDot = ch === '.' && idx > 0;
          if (isWordChar || isSafeDot) return ch;
          return `\\x${byte.toString(16).padStart(2, '0')}`;
        })
        .join(''),
    )
    .join('-');
}

/** `/mnt/data` → `mnt-data.mount` (the Filesystem id, ADR-0007). */
export function unitNameForMountpoint(mountpoint: string): string {
  return `${escapePath(mountpoint)}.mount`;
}

/** `/dev/xi_data` → `dev-xi_data.device` (for Requires=/After=). */
export function deviceUnitFor(devicePath: string): string {
  return `${escapePath(devicePath)}.device`;
}

/** The mount-option flag for a quota mode (none → no flag). */
export function quotaFlagFor(mode: QuotaMode): string | undefined {
  return mode === 'none' ? undefined : mode;
}

export interface MountUnitInput {
  what: string;
  where: string;
  log_device?: string;
  mount_options?: string[];
  quota_mode?: QuotaMode;
}

/**
 * Render the .mount unit text — day-1 template parity (raid_fs
 * mount.unit.j2): Requires/After the device unit(s), Before/Conflicts
 * umount.target, Options=defaults,<opts>[,logdev=…][,<quota>],
 * Type=xfs, WantedBy=local-fs.target.
 *
 * `logdev=`/quota flags supplied via `mount_options` are de-duplicated
 * against the structured fields (the structured value wins).
 */
export function renderMountUnit(input: MountUnitInput): string {
  const deviceUnits = [
    deviceUnitFor(input.what),
    ...(input.log_device !== undefined ? [deviceUnitFor(input.log_device)] : []),
  ].join(' ');

  const quotaFlag = input.quota_mode !== undefined ? quotaFlagFor(input.quota_mode) : undefined;
  const structuredLogdev =
    input.log_device !== undefined ? `logdev=${input.log_device}` : undefined;

  const QUOTA_FLAGS = new Set(['uquota', 'gquota', 'pquota', 'usrquota', 'grpquota', 'prjquota']);
  const passthrough = (input.mount_options ?? []).filter(
    (o) => !o.startsWith('logdev=') && !QUOTA_FLAGS.has(o) && o !== 'defaults',
  );

  const options = [
    'defaults',
    ...passthrough,
    ...(structuredLogdev !== undefined ? [structuredLogdev] : []),
    ...(quotaFlag !== undefined ? [quotaFlag] : []),
  ].join(',');

  const leaf = input.where === '/' ? '/' : (input.where.split('/').filter(Boolean).pop() ?? '/');

  return [
    '[Unit]',
    `Description=xiNAS ${leaf}`,
    `Requires=${deviceUnits}`,
    `After=${deviceUnits}`,
    'Before=umount.target',
    'Conflicts=umount.target',
    '',
    '[Mount]',
    `What=${input.what}`,
    `Where=${input.where}`,
    `Options=${options}`,
    'Type=xfs',
    '',
    '[Install]',
    'WantedBy=local-fs.target',
    '',
  ].join('\n');
}
