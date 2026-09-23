/**
 * Parser for `/var/lib/nfs/etab` — the master export table exportfs(8)
 * maintains ("exportfs ... maintains the table of exports in
 * /var/lib/nfs/etab", nfs-utils 2.6; rpc.mountd consults it when a client
 * mounts). Unlike `/etc/exports` it holds what `exportfs` actually applied,
 * with every option expanded, so it is the "effective export" evidence the
 * S20 placement source publishes (API-10, XMOD-13).
 *
 * Line shape (one export per line, tab-separated):
 *
 *   /mnt/data\t*(rw,sync,wdelay,hide,nocrossmnt,secure,no_root_squash,...,sec=sys,...)
 *
 * Paths with blanks are octal-escaped (`\040`), as in /proc/mounts.
 * Pure; no I/O.
 */

export interface EtabEntry {
  export_path: string;
  host_pattern: string;
  /** The expanded option list exactly as etab prints it. */
  options: string[];
}

function unescapePath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

export function parseEtab(text: string): EtabEntry[] {
  const out: EtabEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // path, then whitespace, then client(options)
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const exportPath = unescapePath(m[1] as string);
    const rest = m[2] as string;
    const open = rest.lastIndexOf('(');
    const close = rest.endsWith(')') ? rest.length - 1 : -1;
    if (open <= 0 || close <= open) continue;
    const host = rest.slice(0, open).trim();
    const options = rest
      .slice(open + 1, close)
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    if (host.length === 0) continue;
    out.push({ export_path: exportPath, host_pattern: host, options });
  }
  return out;
}
