import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFsIoChild } from '../../../agent/health/fsio-child.js';
import { PROBE_DIR_NAME } from '../../../lib/health/probe-types.js';

const base = mkdtempSync(join(tmpdir(), 'xinas-fsio-child-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** B01 — spec §9.3 "Execution boundary": the helper the transient unit runs. */
describe('fsio-child (B01)', () => {
  it('runs the hardened fs_io on the given mountpoint and returns the outcome', async () => {
    const r = await runFsIoChild([base, 'none', '5000']);
    expect(r.ok).toBe(true);
    expect(r.artifact?.path.startsWith(join(base, PROBE_DIR_NAME, 'probe-none-'))).toBe(true);
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(readdirSync(join(base, PROBE_DIR_NAME))).toEqual([]);
  });

  it('the run id reaches the artifact name', async () => {
    const r = await runFsIoChild([base, 'run-1', '5000']);
    expect(r.ok).toBe(true);
    expect(r.artifact?.path.startsWith(join(base, PROBE_DIR_NAME, 'probe-run-1-'))).toBe(true);
  });

  it('bad arguments are an outcome, not a crash', async () => {
    const r = await runFsIoChild(['relative/path', 'none', 'x']);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_ARGS');
    expect(r.artifact).toBeNull();
    expect(r.cleanup).toEqual({ status: 'not_needed' });
    expect((await runFsIoChild([])).error?.code).toBe('INVALID_ARGS');
    expect((await runFsIoChild([base, 'none', '10'])).error?.code).toBe('INVALID_ARGS');
  });

  it('a probe failure is an outcome too', async () => {
    const r = await runFsIoChild([join(base, 'no-such-mountpoint'), 'none', '5000']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'ENOENT', stage: 'open' });
  });
});
