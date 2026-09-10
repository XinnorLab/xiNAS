/**
 * The fs_io helper the agent runs as a PID1 transient unit (S19 §9.3
 * "Execution boundary", validation B01): `node fsio-child.js <mountpoint>
 * <run_id|none> <timeout_ms>` → one JSON ProbeOutcome on stdout, exit 0.
 * Every failure, including bad arguments, is an outcome — the parent
 * treats a non-zero exit as "artifact state unknown".
 *
 * The unit is what makes the mountpoint writable (`ReadWritePaths`); the
 * probe itself is the SAME hardened in-process implementation the agent
 * would run, so the checks of spec §9.3 steps 1–6 apply unchanged.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProbeOutcome } from '../../lib/health/probe-types.js';
import { createRealProbeHost } from './probe-host.js';

export async function runFsIoChild(argv: string[]): Promise<ProbeOutcome> {
  const now = new Date().toISOString();
  const [mountpoint, runArg, timeoutArg] = argv;
  const timeoutMs = Number(timeoutArg);
  if (
    mountpoint === undefined ||
    !mountpoint.startsWith('/') ||
    runArg === undefined ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000
  ) {
    return {
      ok: false,
      started_at: now,
      completed_at: now,
      artifact: null,
      error: {
        code: 'INVALID_ARGS',
        message: 'usage: fsio-child <mountpoint> <run_id|none> <timeout_ms>',
        stage: 'open',
      },
      cleanup: { status: 'not_needed' },
    };
  }
  const host = createRealProbeHost({ fsIoMode: 'in_process' });
  return host.fsIo(mountpoint, { runId: runArg === 'none' ? null : runArg, timeoutMs });
}

/**
 * Whether this module is the process entry point (review fix 2). Node's
 * ESM loader resolves `import.meta.url` through any symlinks in the path
 * it loaded, but leaves `process.argv[1]` exactly as invoked. Under the
 * release layout `systemd-run` executes through (a `current` symlink
 * pointing at the versioned install dir), those two strings then never
 * compare equal, `isMain` was false, and the helper silently printed
 * nothing — the parent read that as `FSIO_HELPER_FAILED` ("printed no
 * outcome") on every production `fs_io`. Resolving `argv1` through the
 * filesystem before comparing fixes it; an `argv1` that cannot be
 * resolved (already gone, or not a real path) just means "not main".
 */
export function isMainModule(argv1: string | undefined, selfPath: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === selfPath;
  } catch {
    return false;
  }
}

const isMain = isMainModule(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  runFsIoChild(process.argv.slice(2)).then(
    (outcome) => {
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      process.exitCode = 0;
    },
    (err) => {
      const now = new Date().toISOString();
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          started_at: now,
          completed_at: now,
          artifact: null,
          error: {
            code: 'ERROR',
            message: err instanceof Error ? err.message : String(err),
            stage: 'open',
          },
          cleanup: { status: 'failed', detail: 'helper crashed' },
        } satisfies ProbeOutcome)}\n`,
      );
      process.exitCode = 0;
    },
  );
}
