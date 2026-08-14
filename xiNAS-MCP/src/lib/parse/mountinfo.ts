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
  /** Per-mount VFS options (rw, relatime, nosuid, …). */
  options: string[];
  fstype: string;
  source: string;
  /**
   * Filesystem-specific super options (the last field). XFS reports its
   * external devices here — `logdev=/dev/xi_<array>`, `rtdev=…` — which is
   * how a mount can depend on a block device that is not its `source`.
   */
  super_options: string[];
}

/**
 * Mount rows as the destructive guards consume them: source + mountpoint,
 * plus whatever option lists the reader could supply. Both option lists are
 * optional so fixture/e2e readers stay valid, and both are searched for
 * external-device references.
 */
export interface MountGuardEntry {
  source: string;
  mountpoint: string;
  options?: string[];
  super_options?: string[];
}

/**
 * Decode octal escape sequences in /proc/self/mountinfo path fields.
 * The kernel encodes space as \040, tab as \011, newline as \012,
 * and backslash as \134 to avoid ambiguity in the space-delimited format.
 */
function decodeOctalEscapes(s: string): string {
  return s.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
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
    // Decode octal escapes in path fields (mountpoint and source may contain spaces etc.)
    const mountpoint = decodeOctalEscapes(preFields[4] ?? '');
    const mountOptionsRaw = preFields[5] ?? '';
    const fstype = postFields[0] ?? '';
    const source = decodeOctalEscapes(postFields[1] ?? '');
    const superOptionsRaw = postFields[2] ?? '';

    if (isNaN(mount_id) || isNaN(parent_id) || mountpoint === '') continue;

    entries.push({
      mount_id,
      parent_id,
      mountpoint,
      options: mountOptionsRaw.split(',').filter((o) => o !== ''),
      fstype,
      source,
      // Decoded like the path fields: an external-device option carries a
      // device path the guards compare against.
      super_options: decodeOctalEscapes(superOptionsRaw)
        .split(',')
        .filter((o) => o !== ''),
    });
  }
  return entries;
}
