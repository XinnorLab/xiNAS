/**
 * BundleHost (S7 T7): the host-data verbs behind the support-bundle
 * executor — journals, config copies, xicli output, the snapshot
 * index. The executor owns the work directory, tar, redaction, and
 * retention; this seam only COLLECTS.
 *
 * SECURITY: xicliLicenseText's raw output is recoverable license
 * material — the executor parses it (lib/parse/xicli-license) and
 * writes ONLY the parsed struct into the bundle.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

export interface BundleHost {
  /** Last `lines` journal lines for a unit ('' when journalctl/unit absent). */
  journalTail(unit: string, lines: number): Promise<string>;
  /** Read a host config file; null when absent/unreadable. */
  readHostFile(path: string): Promise<string | null>;
  /** Raw `xicli license show` (RECOVERABLE MATERIAL — parse before use); null = xicli absent. */
  xicliLicenseText(): Promise<string | null>;
  /** `xicli <args> -f json` style output; null on failure. */
  xicliJson(args: string[]): Promise<string | null>;
  /** Snapshot ids under the config-history store; null when absent. */
  snapshotIndex(): Promise<string[] | null>;
}

function execText(file: string, args: string[], timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err !== null ? null : stdout);
    });
  });
}

const SNAPSHOT_DIR = '/var/lib/xinas/config-history/snapshots';

export function createRealBundleHost(): BundleHost {
  return {
    async journalTail(unit: string, lines: number): Promise<string> {
      const out = await execText('journalctl', [
        '-u',
        unit,
        '-n',
        String(lines),
        '--no-pager',
        '-o',
        'short-iso',
      ]);
      return out ?? '';
    },

    async readHostFile(path: string): Promise<string | null> {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },

    xicliLicenseText(): Promise<string | null> {
      return execText('xicli', ['license', 'show']);
    },

    xicliJson(args: string[]): Promise<string | null> {
      return execText('xicli', args);
    },

    async snapshotIndex(): Promise<string[] | null> {
      try {
        return (await readdir(SNAPSHOT_DIR)).sort();
      } catch {
        return null;
      }
    },
  };
}
