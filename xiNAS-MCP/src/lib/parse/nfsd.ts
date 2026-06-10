/**
 * Pure parsers for the /proc/fs/nfsd runtime files the NfsProfile probe
 * reads to build status.running (S3 §3.4): threads, versions, portlist.
 *
 * No side effects. Safe to import from anywhere.
 */

/**
 * /proc/fs/nfsd/threads — a single integer line (running nfsd thread
 * count; 0 when the module is loaded but no servers are running).
 * Non-integer content → null.
 */
export function parseNfsdThreads(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/**
 * /proc/fs/nfsd/versions — one line of ±N / ±4.x tokens, e.g.
 * `-2 +3 +4 +4.1 +4.2`. Returns the ENABLED versions mapped to the
 * OpenAPI NfsProfile version strings: '3', '4.0', '4.1', '4.2'.
 *
 * Token semantics pinned against the kernel writer
 * (fs/nfsd/nfsctl.c, nfsd_print_version_support, checked at v6.8):
 *   - Major versions print bare `±2` / `±3` / `±4`.
 *   - For v4 minor 0, the kernel prints NOTHING when it is enabled and
 *     `-4.0` when it is disabled — so a bare `+4` implies 4.0 unless a
 *     later explicit `±4.0` token overrides it (tokens are applied
 *     left-to-right; majors precede minors in kernel output).
 *   - Minors >= 1 always print explicitly (`±4.1`, `±4.2`).
 * NFSv2 (`±2`) has no OpenAPI string and is ignored, as is junk.
 */
export function parseNfsdVersions(text: string): string[] {
  const enabled = new Set<string>();
  const apply = (version: string, on: boolean): void => {
    if (on) enabled.add(version);
    else enabled.delete(version);
  };

  for (const token of text.trim().split(/\s+/)) {
    const m = /^([+-])(\d+(?:\.\d+)?)$/.exec(token);
    if (!m) continue;
    const on = m[1] === '+';
    const num = m[2] as string;
    if (num === '3') apply('3', on);
    // Bare `4` is the v4 major toggle and carries the 4.0 baseline.
    else if (num === '4' || num === '4.0') apply('4.0', on);
    else if (num === '4.1' || num === '4.2') apply(num, on);
    // `2` and anything else: no OpenAPI mapping — ignored.
  }

  // Stable, spec-ordered output regardless of token order.
  return ['3', '4.0', '4.1', '4.2'].filter((v) => enabled.has(v));
}

export interface ParsedNfsdPortlist {
  rdma_listening: boolean;
  rdma_port: number | null;
}

/**
 * /proc/fs/nfsd/portlist — one `<transport> <port>` line per listener,
 * e.g. `rdma 20049` / `rdma6 20049` / `tcp 2049` / `udp 2049`.
 * rdma_listening = any rdma/rdma6 line; rdma_port = the first such
 * line's port (null when absent or unparsable).
 */
export function parseNfsdPortlist(text: string): ParsedNfsdPortlist {
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const transport = fields[0];
    if (transport !== 'rdma' && transport !== 'rdma6') continue;
    const port = fields[1] !== undefined && /^\d+$/.test(fields[1]) ? Number(fields[1]) : null;
    return { rdma_listening: true, rdma_port: port };
  }
  return { rdma_listening: false, rdma_port: null };
}
