/**
 * Fixture-backed BundleHost (S7 T7) — e2e/test seam.
 *
 * Reads from the fixture directory:
 *   journals.json        { "<unit>": "<text>" }
 *   bundle-configs.json  { "</path>": "<content>" }
 *   xicli-license.txt    raw license text (the SAME file the probe uses)
 *   xicli-raid.json      raw `xicli raid show` output
 *   xicli-pool.json      raw `xicli pool show` output
 *   snapshots-index.json [ "<snapshot-id>", ... ]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleHost } from './bundle-host.js';

function readJson<T>(dir: string, file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readText(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

export function createFakeBundleHost(dir: string): BundleHost {
  return {
    async journalTail(unit: string): Promise<string> {
      return readJson<Record<string, string>>(dir, 'journals.json', {})[unit] ?? '';
    },
    async readHostFile(path: string): Promise<string | null> {
      return readJson<Record<string, string>>(dir, 'bundle-configs.json', {})[path] ?? null;
    },
    async xicliLicenseText(): Promise<string | null> {
      return readText(dir, 'xicli-license.txt');
    },
    async xicliJson(args: string[]): Promise<string | null> {
      const file = args[0] === 'raid' ? 'xicli-raid.json' : 'xicli-pool.json';
      return readText(dir, file);
    },
    async snapshotIndex(): Promise<string[] | null> {
      return readJson<string[] | null>(dir, 'snapshots-index.json', null);
    },
  };
}
