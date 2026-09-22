/**
 * S20 §4.2: the installed xiRAID Classic version, for the ARRAY resource's
 * `version` / `build` (the connector's compatibility manifest keys on them).
 *
 * The daemon's raid_show payload does not carry its version, so the source
 * is the package manager: `dpkg-query -W -f='${Version}' xiraid-core`
 * (Ubuntu is the only supported platform). This is read ONCE per agent
 * process and cached — the 5 s placement cycle spawns nothing (spec §4.1);
 * a failed read is retried on a later cycle no more than once a minute.
 *
 * `version` is the upstream part (`4.4.0`), `build` the full package
 * version (`4.4.0-43861`), both as the package manager prints them.
 */

import { execFile as nodeExecFile } from 'node:child_process';

export interface XiraidVersion {
  version: string;
  build: string;
}

export interface XiraidVersionSource {
  /** null when the version cannot be determined (package absent, dpkg failed). */
  get(): Promise<XiraidVersion | null>;
}

type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout?: number },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** Parse a dpkg `${Version}` string into the published pair. */
export function parseXiraidPackageVersion(text: string): XiraidVersion | null {
  const build = text.trim();
  if (build.length === 0) return null;
  // Debian versions are [epoch:]upstream[-revision]; the upstream part ends
  // at the LAST hyphen (a revision may not contain one).
  const withoutEpoch = build.includes(':') ? build.slice(build.indexOf(':') + 1) : build;
  const dash = withoutEpoch.lastIndexOf('-');
  const version = dash > 0 ? withoutEpoch.slice(0, dash) : withoutEpoch;
  return { version, build };
}

export function createXiraidVersionSource(
  opts: {
    execFile?: ExecFileFn;
    packageName?: string;
    retryAfterMs?: number;
    now?: () => number;
  } = {},
): XiraidVersionSource {
  const ef: ExecFileFn = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const pkg = opts.packageName ?? 'xiraid-core';
  const retryAfter = opts.retryAfterMs ?? 60_000;
  const now = opts.now ?? ((): number => Date.now());
  let cached: XiraidVersion | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;

  return {
    async get(): Promise<XiraidVersion | null> {
      if (cached !== null) return cached;
      if (now() - lastAttempt < retryAfter) return null;
      lastAttempt = now();
      const stdout = await new Promise<string | null>((resolve) => {
        try {
          ef('dpkg-query', ['-W', '-f=${Version}', pkg], { timeout: 5_000 }, (err, out) =>
            resolve(err ? null : out),
          );
        } catch {
          resolve(null);
        }
      });
      cached = stdout === null ? null : parseXiraidPackageVersion(stdout);
      return cached;
    },
  };
}

/** A fixed answer (fixture mode and tests). */
export function fixedXiraidVersionSource(value: XiraidVersion | null): XiraidVersionSource {
  return { get: () => Promise.resolve(value) };
}
