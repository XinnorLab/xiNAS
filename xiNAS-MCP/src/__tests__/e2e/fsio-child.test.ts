// @vitest-environment node
/**
 * End-to-end (S19 §9.3 "Execution boundary", validation B01): the built
 * `dist/agent/health/fsio-child.js` is what the transient unit runs, so
 * the compiled entry must print ONE JSON ProbeOutcome on stdout and exit
 * 0 — including when its arguments are wrong.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const CHILD = join(PROJECT_ROOT, 'dist/agent/health/fsio-child.js');
const base = mkdtempSync(join(tmpdir(), 'xinas-fsio-e2e-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

interface Outcome {
  ok: boolean;
  artifact: { kind: string; path: string } | null;
  error?: { code: string };
  cleanup: { status: string };
}

describe('dist/agent/health/fsio-child.js', () => {
  it('prints one JSON ProbeOutcome and exits 0', async () => {
    const { stdout } = await run(process.execPath, [CHILD, base, 'none', '5000']);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    const outcome = JSON.parse(stdout) as Outcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.cleanup.status).toBe('clean');
    expect(outcome.artifact?.path.startsWith(join(base, '.xinas-health', 'probe-none-'))).toBe(
      true,
    );
    expect(readdirSync(join(base, '.xinas-health'))).toEqual([]);
  });

  it('bad arguments are an outcome on stdout, still exit 0', async () => {
    const { stdout } = await run(process.execPath, [CHILD, 'relative', 'none', '5000']);
    const outcome = JSON.parse(stdout) as Outcome;
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('INVALID_ARGS');
  });
});
