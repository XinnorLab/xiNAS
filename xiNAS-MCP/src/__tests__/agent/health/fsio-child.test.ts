import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isMainModule, runFsIoChild } from '../../../agent/health/fsio-child.js';
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

/**
 * review fix 2 — Node realpaths the ESM main module's `import.meta.url`
 * but not `process.argv[1]`, so a symlinked dist path (the layout
 * `systemd-run` executes under) made the old string comparison false and
 * every production `fs_io` became `FSIO_HELPER_FAILED` ("printed no
 * outcome"): the child never ran its `isMain` block at all.
 */
describe('isMainModule (B01 review fix 2)', () => {
  it('true when argv1 is exactly the self path', () => {
    // `selfPath` mirrors what the real code always passes: the ALREADY
    // realpath'd result of `fileURLToPath(import.meta.url)` — so it is
    // `realpathSync(target)`, not `target` itself, exactly like on a
    // host where a symlinked parent directory (e.g. macOS's `/var` ->
    // `/private/var`) sits above the file even with no symlink involved
    // in the fsio-child path itself.
    const target = join(base, 'target.js');
    writeFileSync(target, '');
    const selfPath = realpathSync(target);
    expect(isMainModule(target, selfPath)).toBe(true);
  });

  it('true when argv1 is a symlink to the self path (the systemd-run dist layout)', () => {
    const real = join(base, 'real.js');
    writeFileSync(real, '');
    const link = join(base, 'linked.js');
    symlinkSync(real, link);
    const selfPath = realpathSync(real);
    expect(isMainModule(link, selfPath)).toBe(true);
  });

  it('false for a different file', () => {
    const a = join(base, 'a.js');
    const b = join(base, 'b.js');
    writeFileSync(a, '');
    writeFileSync(b, '');
    expect(isMainModule(a, b)).toBe(false);
  });

  it('false when argv1 is undefined', () => {
    expect(isMainModule(undefined, join(base, 'whatever.js'))).toBe(false);
  });

  it('false when argv1 cannot be resolved on disk', () => {
    expect(isMainModule(join(base, 'does-not-exist.js'), join(base, 'whatever.js'))).toBe(false);
  });
});
