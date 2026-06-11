/**
 * Tuning probe (S7 T1, ADR-0009 §Tuning) — privileged layer.
 *
 * EXPECTED sysctl values are parsed from the INSTALLED drop-ins
 * (`/etc/sysctl.d/*.conf`, lexicographic order, last write wins per
 * key — sysctl(8) precedence), so customized `perf_tuning` variables
 * are honored and key names can never desync from the role. ACTUAL
 * values are read from `/proc/sys/<key with dots as slashes>`.
 *
 * Degrades, never throws: unreadable files and unparsable lines are
 * skipped; an unreadable /proc value yields `actual: null`.
 *
 * Injectable deps for test isolation. Do NOT import from outside
 * src/agent/.
 */

import { readFile as nodeReadFile, readdir as nodeReaddir } from 'node:fs/promises';

export interface TuningEntry {
  key: string;
  expected: string;
  actual: string | null;
}

export interface TuningSnapshot {
  entries: TuningEntry[];
}

export interface TuningProbe {
  snapshot(): Promise<TuningSnapshot>;
}

interface TuningProbeDeps {
  readdir?: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
}

const SYSCTL_D = '/etc/sysctl.d';
const LINE_RE = /^\s*([a-z0-9_.-]+)\s*=\s*(.+?)\s*$/i;

export function createTuningProbe(deps: TuningProbeDeps = {}): TuningProbe {
  const readdir = deps.readdir ?? ((d: string) => nodeReaddir(d));
  const readFile = deps.readFile ?? ((p: string) => nodeReadFile(p, 'utf8'));

  return {
    async snapshot(): Promise<TuningSnapshot> {
      const expected = new Map<string, string>();
      let files: string[] = [];
      try {
        files = (await readdir(SYSCTL_D)).filter((f) => f.endsWith('.conf')).sort();
      } catch {
        return { entries: [] };
      }
      for (const file of files) {
        let text: string;
        try {
          text = await readFile(`${SYSCTL_D}/${file}`);
        } catch {
          continue; // unreadable drop-in: skipped
        }
        for (const line of text.split('\n')) {
          if (line.trim().startsWith('#') || line.trim().startsWith(';')) continue;
          const m = LINE_RE.exec(line);
          if (m) expected.set(m[1] as string, m[2] as string);
        }
      }

      const entries: TuningEntry[] = [];
      for (const [key, value] of [...expected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        let actual: string | null = null;
        try {
          actual = (await readFile(`/proc/sys/${key.replaceAll('.', '/')}`)).trim();
        } catch {
          /* unreadable: actual stays null */
        }
        entries.push({ key, expected: value, actual });
      }
      return { entries };
    },
  };
}
