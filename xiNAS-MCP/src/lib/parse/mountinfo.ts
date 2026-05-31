/**
 * Pure parser for /proc/self/mountinfo lines (man 5 proc).
 *
 * Format (space-separated):
 *   mount_id parent_id major:minor root mountpoint mount_options
 *   [optional-fields] - fstype mount-source super-options
 *
 * No side effects. Safe to import from anywhere.
 */

export interface MountEntry {
  mount_id: number;
  parent_id: number;
  mountpoint: string;
  options: string[];
  fstype: string;
  source: string;
}

export function parseMountinfo(raw: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    // Fields before the '-' separator are variable-length due to optional fields.
    // Split into pre-separator and post-separator parts.
    const sepIdx = line.indexOf(' - ');
    if (sepIdx === -1) continue;

    const prePart = line.slice(0, sepIdx);
    const postPart = line.slice(sepIdx + 3); // skip ' - '

    const preFields = prePart.split(' ');
    const postFields = postPart.split(' ');

    // pre: mount_id parent_id major:minor root mountpoint mount_options [optional...]
    if (preFields.length < 6) continue;
    // post: fstype source super_options
    if (postFields.length < 2) continue;

    const mount_id = parseInt(preFields[0] ?? '', 10);
    const parent_id = parseInt(preFields[1] ?? '', 10);
    const mountpoint = preFields[4] ?? '';
    const mountOptionsRaw = preFields[5] ?? '';
    const fstype = postFields[0] ?? '';
    const source = postFields[1] ?? '';

    if (isNaN(mount_id) || isNaN(parent_id) || mountpoint === '') continue;

    entries.push({
      mount_id,
      parent_id,
      mountpoint,
      options: mountOptionsRaw.split(',').filter((o) => o !== ''),
      fstype,
      source,
    });
  }
  return entries;
}
