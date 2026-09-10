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

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
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
