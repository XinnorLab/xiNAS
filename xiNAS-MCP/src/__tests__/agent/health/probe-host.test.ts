import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFakeProbeHost } from '../../../agent/health/fake-probe-host.js';
import {
  CLEANUP_GRACE_MS,
  createRealProbeHost,
  defaultExecCapture,
  execCaptureCode,
  execCaptureTimeoutMs,
} from '../../../agent/health/probe-host.js';
import { PROBE_DIR_NAME } from '../../../lib/health/probe-types.js';

const base = mkdtempSync(join(tmpdir(), 'xinas-probe-host-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string): string => {
  const d = join(base, name);
  mkdirSync(d);
  return d;
};
const opts = { runId: 'run-1', timeoutMs: 5_000 };

/** S19a T2 — spec §9.3: every artifact is per run, checked, and self-reporting. */
describe('createRealProbeHost.fsIo (spec §9.3)', () => {
  it('writes a unique per-run file under .xinas-health, reads it back, unlinks it, reports clean', async () => {
    const mnt = fresh('ok');
    const host = createRealProbeHost({ random: () => 'deadbeefdeadbeef' });
    const r = await host.fsIo(mnt, opts);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.artifact).toEqual({
      kind: 'file',
      path: join(mnt, PROBE_DIR_NAME, 'probe-run-1-deadbeefdeadbeef'),
    });
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual([]);
    expect(Date.parse(r.completed_at)).toBeGreaterThanOrEqual(Date.parse(r.started_at));
  });

  it('never overwrites an existing name: a colliding random retries, the foreign file is untouched', async () => {
    const mnt = fresh('unique');
    let n = 0;
    const host = createRealProbeHost({
      random: () => (n++ < 2 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb'),
    });
    mkdirSync(join(mnt, PROBE_DIR_NAME));
    writeFileSync(join(mnt, PROBE_DIR_NAME, 'probe-run-1-aaaaaaaaaaaaaaaa'), 'someone else');
    const r = await host.fsIo(mnt, opts);
    expect(r.ok).toBe(true);
    expect(r.artifact?.path).toContain('bbbbbbbbbbbbbbbb');
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual(['probe-run-1-aaaaaaaaaaaaaaaa']);
    expect(readFileSync(join(mnt, PROBE_DIR_NAME, 'probe-run-1-aaaaaaaaaaaaaaaa'), 'utf8')).toBe(
      'someone else',
    );
  });

  it('a symlinked .xinas-health is refused before anything is written', async () => {
    const mnt = fresh('symlink');
    const elsewhere = fresh('elsewhere');
    symlinkSync(elsewhere, join(mnt, PROBE_DIR_NAME));
    const r = await createRealProbeHost().fsIo(mnt, opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'probe_dir_untrusted', stage: 'dir' });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(r.artifact).toBeNull();
    expect(r.cleanup).toEqual({ status: 'not_needed' });
  });

  it('a probe directory owned by someone else is refused', async () => {
    const mnt = fresh('owner');
    const r = await createRealProbeHost({ uid: (process.getuid?.() ?? 0) + 1 }).fsIo(mnt, opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'probe_dir_untrusted', stage: 'dir' });
  });

  it('a cleanup failure is reported, never swallowed', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const mnt = fresh('cleanup');
    const host = createRealProbeHost({ random: () => 'cafecafecafecafe' });
    const dir = join(mnt, PROBE_DIR_NAME);
    mkdirSync(dir, { mode: 0o700 });
    const r = await host.fsIo(mnt, opts, { beforeUnlink: () => chmodSync(dir, 0o500) });
    chmodSync(dir, 0o700);
    expect(r.ok).toBe(true);
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/EACCES|EPERM/);
    expect(readdirSync(dir)).toEqual(['probe-run-1-cafecafecafecafe']);
  });

  it('a missing mountpoint fails at the open stage with nothing to clean', async () => {
    const r = await createRealProbeHost().fsIo(join(base, 'nope'), opts);
    expect(r).toMatchObject({
      ok: false,
      artifact: null,
      error: { code: 'ENOENT', stage: 'open' },
      cleanup: { status: 'not_needed' },
    });
  });

  it('a step that exceeds the timeout ends the probe with TIMEOUT and still unlinks', async () => {
    const mnt = fresh('timeout');
    const host = createRealProbeHost({ random: () => 'feedfeedfeedfeed' });
    const r = await host.fsIo(
      mnt,
      { runId: null, timeoutMs: 30 },
      { beforeFsync: () => new Promise((res) => setTimeout(res, 300)) },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'TIMEOUT', stage: 'fsync' });
    expect(r.artifact?.path).toContain('probe-none-feedfeedfeedfeed');
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual([]);
  });
});

describe('createRealProbeHost.nfsLoopback (spec §9.3)', () => {
  it('mounts at a per-run directory, lists, unmounts, removes the directory and the lock', async () => {
    const root = fresh('loop-root');
    const calls: string[][] = [];
    const host = createRealProbeHost({
      root,
      random: () => 'abcdabcdabcdabcd',
      exec: async (file, args) => {
        calls.push([file, ...args]);
      },
    });
    const r = await host.nfsLoopback('/srv/data', opts);
    expect(r.ok).toBe(true);
    const mnt = join(root, 'run-1-abcdabcdabcdabcd', 'mnt');
    expect(r.artifact).toEqual({ kind: 'mountpoint', path: mnt });
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(calls).toEqual([
      ['systemd-mount', '--collect', 'localhost:/srv/data', mnt],
      ['systemd-umount', mnt],
    ]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('a second concurrent loopback is refused with PROBE_IN_PROGRESS while the first holds the lock', async () => {
    const root = fresh('loop-lock');
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const host = createRealProbeHost({
      root,
      exec: async (file) => {
        if (file === 'systemd-mount') await gate;
      },
    });
    const first = host.nfsLoopback('/srv/a', opts);
    await new Promise((res) => setTimeout(res, 20));
    const second = await host.nfsLoopback('/srv/b', opts);
    expect(second).toMatchObject({
      ok: false,
      artifact: null,
      error: { code: 'PROBE_IN_PROGRESS', stage: 'lock' },
      cleanup: { status: 'not_needed' },
    });
    release();
    expect((await first).ok).toBe(true);
    // the lock is released afterwards
    expect((await host.nfsLoopback('/srv/c', opts)).ok).toBe(true);
  });

  it('a stale lock left by a dead process is reclaimed', async () => {
    const root = fresh('loop-stale');
    writeFileSync(join(root, '.lock'), '999999999\n'); // no such pid
    const host = createRealProbeHost({ root, exec: async () => {} });
    expect((await host.nfsLoopback('/srv/a', opts)).ok).toBe(true);
  });

  it('a lock held by a live process (a second agent) is refused, and that lock is left alone', async () => {
    // The in-process gate (F08) covers this host's own verbs; the lock
    // file is what still serializes a SECOND agent process.
    const root = fresh('loop-foreign-lock');
    const lock = join(root, '.lock');
    writeFileSync(lock, `${process.pid}\n`);
    const host = createRealProbeHost({ root, exec: async () => {} });
    const r = await host.nfsLoopback('/srv/a', opts);
    expect(r).toMatchObject({
      ok: false,
      artifact: null,
      error: { code: 'PROBE_IN_PROGRESS', stage: 'lock' },
      cleanup: { status: 'not_needed' },
    });
    expect(existsSync(lock)).toBe(true);
  });

  it('a failed umount command alone does not block cleanup once the device check finds nothing mounted (F05)', async () => {
    // The old behavior trusted the umount command's own exit status; F05
    // replaces that with a real `st_dev` check, so a command-level "busy"
    // with nothing actually left behind still cleans up (see the
    // `isMountpoint`-injected test below for the case where the device
    // check itself says something is still mounted, and the "F05: an
    // ambiguous mount failure..." regression test for the case where the
    // mountpoint directory holds foreign content instead).
    const root = fresh('loop-umount');
    const host = createRealProbeHost({
      root,
      random: () => '0000000000000000',
      exec: async (file) => {
        if (file === 'systemd-umount') throw new Error('busy');
      },
    });
    const r = await host.nfsLoopback('/srv/data', opts);
    expect(r.ok).toBe(true);
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a mount failure is the result, not a throw, and leaves nothing behind', async () => {
    const root = fresh('loop-fail');
    const host = createRealProbeHost({
      root,
      exec: async (file) => {
        if (file === 'systemd-mount') throw new Error('mount.nfs: access denied');
      },
    });
    const r = await host.nfsLoopback('/srv/data', opts);
    expect(r).toMatchObject({ ok: false, error: { stage: 'mount' }, cleanup: { status: 'clean' } });
    expect(r.error?.message).toContain('access denied');
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('createFakeProbeHost', () => {
  it('honors fail lists and records the op strings the e2e suite reads', async () => {
    const dir = fresh('fake');
    writeFileSync(
      join(dir, 'probe-host-state.json'),
      JSON.stringify({ fail_touch: ['/mnt/bad'], fail_loopback: ['/srv/bad'] }),
    );
    const host = createFakeProbeHost(dir);
    const ok = await host.fsIo('/mnt/ok', opts);
    expect(ok.ok).toBe(true);
    expect(ok.artifact?.kind).toBe('file');
    expect(ok.cleanup).toEqual({ status: 'clean' });
    const bad = await host.fsIo('/mnt/bad', opts);
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain('fake touch failure');
    expect((await host.nfsLoopback('/srv/ok', opts)).ok).toBe(true);
    expect((await host.nfsLoopback('/srv/bad', opts)).ok).toBe(false);
    const state = JSON.parse(readFileSync(join(dir, 'probe-host-state.json'), 'utf8'));
    expect(state.ops).toEqual([
      'touch:/mnt/ok',
      'touch:/mnt/bad',
      'loopback:/srv/ok',
      'loopback-umount:/srv/ok',
      'loopback:/srv/bad',
      'loopback-umount:/srv/bad',
    ]);
  });
});

describe('validation F05/F06/F07 regressions', () => {
  it('F05: an ambiguous mount failure never deletes below the mountpoint and does not report clean', async () => {
    const root = fresh('f05');
    let marker = '';
    const called: string[] = [];
    const host = createRealProbeHost({
      root,
      exec: async (file, args) => {
        called.push(file);
        if (file === 'systemd-mount') {
          marker = join(args[2]!, 'FOREIGN-DATA');
          writeFileSync(marker, 'data visible at the mountpoint');
          throw new Error('mount client timed out after submission');
        }
      },
    });
    const r = await host.nfsLoopback('/export', { runId: 'run', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(called).toEqual(['systemd-mount', 'systemd-umount']);
    expect(existsSync(marker)).toBe(true);
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/not empty|still mounted/);
  });

  it('F06: the host refuses a run id that could leave its root', async () => {
    const root = fresh('f06');
    let mounted = '';
    const host = createRealProbeHost({
      root,
      exec: async (file, args) => {
        if (file === 'systemd-mount') mounted = args[2]!;
      },
    });
    const r = await host.nfsLoopback('/export', { runId: '../outside', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('RUN_ID_INVALID');
    expect(mounted).toBe('');
    expect(readdirSync(root)).toEqual([]);
  });

  it('F06: fsIo refuses a run id that could leave the probe directory, before anything is created', async () => {
    const mnt = fresh('f06-fsio');
    const r = await createRealProbeHost().fsIo(mnt, { runId: '../outside', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'RUN_ID_INVALID', stage: 'dir' });
    expect(r.cleanup).toEqual({ status: 'not_needed' });
    expect(existsSync(join(mnt, PROBE_DIR_NAME))).toBe(false);
  });

  it('F07: a group/world-writable probe directory is untrusted', async () => {
    const mnt = fresh('f07-mode');
    mkdirSync(join(mnt, PROBE_DIR_NAME));
    chmodSync(join(mnt, PROBE_DIR_NAME), 0o777);
    const r = await createRealProbeHost().fsIo(mnt, opts);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('probe_dir_untrusted');
    expect(r.cleanup.status).toBe('not_needed');
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual([]);
  });

  it('F07: cleanup unlinks only the inode it created', async () => {
    const mnt = fresh('f07-inode');
    const dir = join(mnt, PROBE_DIR_NAME);
    let original = '';
    let replacement = '';
    const r = await createRealProbeHost().fsIo(mnt, opts, {
      beforeUnlink: () => {
        replacement = join(dir, readdirSync(dir)[0]!);
        original = `${replacement}.moved`;
        renameSync(replacement, original);
        writeFileSync(replacement, 'FOREIGN-DATA');
      },
    });
    expect(r.ok).toBe(true);
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/replaced/);
    expect(readFileSync(replacement, 'utf8')).toBe('FOREIGN-DATA');
    expect(existsSync(original)).toBe(true);
  });

  it('F07: an unresolved create-stage identity is reported as identity unknown, not replaced, and the file survives', async () => {
    const mnt = fresh('f07-identity-unknown');
    const base = 1_700_000_000_000;
    let calls = 0;
    // Two clock() reads happen before fsIo's try (startedAt, deadline),
    // then one per step() call: 'open' x2, 'dir' x3, 'create' (the
    // O_CREAT|O_EXCL open) x1 — that is 8 reads. The 9th read is at the
    // top of the *second* 'create' step, the post-open fstat that records
    // createdIno. Returning a time already past the deadline there means
    // the file was opened (filePath is set) but its identity fstat never
    // ran, so createdIno stays undefined.
    const clock = () => {
      calls += 1;
      return calls >= 9 ? base + 10_000 : base;
    };
    const host = createRealProbeHost({ clock, random: () => 'deedbeefdeedbeef' });
    const r = await host.fsIo(mnt, { runId: 'run-1', timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'TIMEOUT', stage: 'create' });
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/identity unknown/);
    const filePath = join(mnt, PROBE_DIR_NAME, 'probe-run-1-deedbeefdeedbeef');
    expect(existsSync(filePath)).toBe(true);
  });

  it('F05 cleanup bound: an umount after a full-budget mount timeout is capped at CLEANUP_GRACE_MS', async () => {
    const root = fresh('umount-bound');
    let now = 1_000_000;
    const clock = () => now;
    let umountTimeoutMs: number | undefined;
    const host = createRealProbeHost({
      root,
      clock,
      exec: async (file, _args, timeoutMs) => {
        if (file === 'systemd-mount') {
          now += 1000; // the mount step consumes the whole run budget
          throw new Error('mount timed out');
        }
        if (file === 'systemd-umount') umountTimeoutMs = timeoutMs;
      },
    });
    const r = await host.nfsLoopback('/export', { runId: 'run', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(umountTimeoutMs).toBeDefined();
    expect(umountTimeoutMs as number).toBeLessThanOrEqual(CLEANUP_GRACE_MS);
  });

  it('F05: when the device check itself says something is still mounted, cleanup is failed and both directories survive untouched', async () => {
    const root = fresh('loop-stillmounted');
    const calls: string[] = [];
    const host = createRealProbeHost({
      root,
      random: () => 'cafefeedcafefeed',
      isMountpoint: async () => true,
      exec: async (file) => {
        calls.push(file);
        if (file === 'systemd-mount') throw new Error('mount client timed out');
      },
    });
    const r = await host.nfsLoopback('/export', opts);
    const dir = join(root, 'run-1-cafefeedcafefeed');
    const mnt = join(dir, 'mnt');
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['systemd-mount', 'systemd-umount']);
    expect(r.cleanup).toEqual({ status: 'failed', detail: 'mountpoint still mounted' });
    expect(existsSync(mnt)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});

/** F08 — spec §9.5: the host, not the RPC handler, is the admission point. */
describe('F08: one active probe per node, any entry point', () => {
  it('refuses a loopback while an fs_io is in flight, and admits the next one after it ends', async () => {
    const mnt = fresh('gate-a');
    const host = createRealProbeHost({
      root: fresh('gate-root'),
      exec: async () => undefined,
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = host.fsIo(mnt, opts, { beforeFsync: () => held });
    await new Promise((r) => setTimeout(r, 20));
    expect(host.busy()).toEqual({ probe: 'fs_io', path: mnt });
    const second = await host.nfsLoopback('/export', { runId: 'run-1', timeoutMs: 1000 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatchObject({ code: 'PROBE_IN_PROGRESS', stage: 'lock' });
    expect(second).toMatchObject({ artifact: null, cleanup: { status: 'not_needed' } });
    release();
    expect((await first).ok).toBe(true);
    expect(host.busy()).toBeNull();
    const third = await host.fsIo(mnt, opts);
    expect(third.ok).toBe(true);
  });

  it('refuses an fs_io while a loopback is in flight', async () => {
    const root = fresh('gate-loop');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = createRealProbeHost({
      root,
      exec: async (file) => {
        if (file === 'systemd-mount') await held;
      },
    });
    const first = host.nfsLoopback('/export', opts);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.busy()).toEqual({ probe: 'nfs_loopback', path: '/export' });
    const mnt = fresh('gate-loop-mnt');
    const second = await host.fsIo(mnt, opts);
    expect(second.ok).toBe(false);
    expect(second.error).toMatchObject({ code: 'PROBE_IN_PROGRESS', stage: 'lock' });
    // Refused at the door: nothing was created under the mountpoint.
    expect(existsSync(join(mnt, PROBE_DIR_NAME))).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    expect(host.busy()).toBeNull();
  });

  it('review fix 6: the gate releases even when an inner verb step throws instead of settling cleanly', async () => {
    // nfsLoopbackInner's post-mount `isMountpoint` check is not itself
    // wrapped in a try/catch; a throw there propagates out of the mount
    // step's `finally` and is caught only by the function's OUTER
    // try/catch, which turns it into a result rather than a rejection.
    // admitted()'s own finally must still release the gate in that case.
    const root = fresh('gate-throw');
    const host = createRealProbeHost({
      root,
      exec: async (file) => {
        if (file === 'systemd-mount') throw new Error('mount failed');
      },
      isMountpoint: async () => {
        throw new Error('boom');
      },
    });
    const r = await host.nfsLoopback('/export', opts);
    expect(r.ok).toBe(false);
    expect(host.busy()).toBeNull();
    const mnt = fresh('gate-throw-mnt');
    const next = await host.fsIo(mnt, opts);
    expect(next.ok).toBe(true);
  });
});

/** B01 — spec §9.3 "Execution boundary": the write leaves the agent's namespace. */
describe('B01: fs_io delegated to a PID1 transient unit', () => {
  const outcome = {
    ok: true,
    started_at: '2026-09-10T00:00:00.000Z',
    completed_at: '2026-09-10T00:00:01.000Z',
    artifact: { kind: 'file', path: '/mnt/data/.xinas-health/probe-none-abc' },
    cleanup: { status: 'clean' },
  };

  it('spawns systemd-run with one writable path and returns the child outcome', async () => {
    const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      random: () => 'cafebabecafebabe',
      execCapture: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs });
        return { stdout: `${JSON.stringify(outcome)}\n`, stderr: '', code: 0 };
      },
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 20_000 });
    expect(r).toEqual(outcome);
    expect(calls).toHaveLength(1);
    const { file, args, timeoutMs } = calls[0]!;
    expect(file).toBe('systemd-run');
    expect(args.slice(0, 5)).toEqual(['--wait', '--pipe', '--collect', '--quiet', '--unit']);
    expect(args[5]).toBe('xinas-health-fsio-cafebabecafebabe');
    expect(args).toContain('ReadWritePaths=/mnt/data');
    expect(args).toContain('ProtectSystem=strict');
    expect(args).toContain('PrivateTmp=true');
    expect(args).toContain('ProtectHome=true');
    expect(args).toContain('NoNewPrivileges=true');
    expect(args).toContain('RuntimeMaxSec=23');
    // …, node, fsio-child, <mountpoint> <run_id|none> <timeout_ms>
    expect(args.at(-5)).toBe(process.execPath);
    expect(args.at(-4)).toMatch(/agent\/health\/fsio-child\.(js|ts)$/);
    expect(args.at(-3)).toBe('/mnt/data');
    expect(args.slice(-2)).toEqual(['none', '20000']);
    expect(timeoutMs).toBe(20_000);
  });

  it('the run id reaches the helper verbatim', async () => {
    let seen: string[] = [];
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async (_file, args) => {
        seen = args;
        return { stdout: JSON.stringify(outcome), stderr: '', code: 0 };
      },
    });
    await host.fsIo('/mnt/data', { runId: 'run-1', timeoutMs: 5_000 });
    expect(seen.slice(-2)).toEqual(['run-1', '5000']);
    expect(seen).toContain('RuntimeMaxSec=8');
  });

  it("final review 1: both helper bounds sit inside the api's timeout_s + 5 s wait", async () => {
    // The api waits `timeout_s * 1000 + 5_000` for the RPC (routes/health.ts).
    // systemd must kill the unit first and `execFile` second, so a wedged
    // helper comes back as FSIO_HELPER_FAILED + cleanup: failed, never as a
    // generic api timeout (§9.3 "Execution boundary", PROBE-03).
    const timeoutMs = 20_000;
    expect(execCaptureTimeoutMs(timeoutMs)).toBe(timeoutMs + CLEANUP_GRACE_MS);
    expect(execCaptureTimeoutMs(timeoutMs)).toBeLessThan(timeoutMs + 5_000);
    let seen: string[] = [];
    let passed = 0;
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async (_file, args, ms) => {
        seen = args;
        passed = ms;
        return { stdout: JSON.stringify(outcome), stderr: '', code: 0 };
      },
    });
    await host.fsIo('/mnt/data', { runId: null, timeoutMs });
    expect(seen).toContain(`RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 3}`);
    expect(execCaptureTimeoutMs(passed)).toBeLessThan(timeoutMs + 5_000);
  });

  it('a helper that exits non-zero is a failed probe with unknown cleanup', async () => {
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => ({
        stdout: '',
        stderr: 'Failed to start transient service unit',
        code: 1,
      }),
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'FSIO_HELPER_FAILED', stage: 'open' });
    expect(r.error?.message).toContain('Failed to start');
    expect(r.cleanup).toEqual({
      status: 'failed',
      detail: 'artifact state unknown: helper exited 1',
    });
  });

  it('a helper that prints no usable outcome is a failed probe with unknown cleanup', async () => {
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => ({ stdout: 'not json\n', stderr: '', code: 0 }),
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'FSIO_HELPER_FAILED', stage: 'open' });
    expect(r.cleanup).toEqual({ status: 'failed', detail: 'artifact state unknown: no outcome' });
  });

  it('a spawn that throws is a failed probe, not a rejection', async () => {
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('spawn ENOENT');
    expect(r.cleanup).toEqual({
      status: 'failed',
      detail: 'artifact state unknown: helper did not run',
    });
    expect(host.busy()).toBeNull();
  });

  it('review fix 3a: an invalid run id is refused before the transient unit is spawned', async () => {
    let spawned = 0;
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => {
        spawned += 1;
        return { stdout: JSON.stringify(outcome), stderr: '', code: 0 };
      },
    });
    const r = await host.fsIo('/mnt/data', { runId: '../outside', timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'RUN_ID_INVALID', stage: 'dir' });
    expect(r.cleanup).toEqual({ status: 'not_needed' });
    expect(spawned).toBe(0);
  });

  it('review fix 3b: a mountpoint that is not an absolute path without whitespace is refused before the transient unit is spawned', async () => {
    // `ReadWritePaths=` splits its value on whitespace, and reads a leading
    // `-` as "optional" and a leading `+` as root-relative — so only an
    // absolute, whitespace-free path can be granted safely.
    let spawned = 0;
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => {
        spawned += 1;
        return { stdout: JSON.stringify(outcome), stderr: '', code: 0 };
      },
    });
    for (const bad of ['/mnt/my data', '-mnt', '+mnt/data', 'mnt/data']) {
      const r = await host.fsIo(bad, { runId: null, timeoutMs: 5_000 });
      expect(r.ok, bad).toBe(false);
      expect(r.error, bad).toEqual({
        code: 'MOUNTPOINT_UNSUPPORTED',
        message: 'the PID1 fs_io boundary needs an absolute mountpoint path without whitespace',
        stage: 'open',
      });
      expect(r.cleanup, bad).toEqual({ status: 'not_needed' });
    }
    expect(spawned).toBe(0);
  });

  it('review fix 5: a helper timeout (execCapture code -1) is reported as a timeout, not exit 127', async () => {
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => ({ stdout: '', stderr: 'timed out after 10000 ms', code: -1 }),
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({
      code: 'FSIO_HELPER_FAILED',
      message: 'systemd-run timed out after 5000 ms',
      stage: 'open',
    });
    expect(r.cleanup).toEqual({
      status: 'failed',
      detail: 'artifact state unknown: helper timed out',
    });
  });

  it("the default mode is in_process: no helper is spawned and the mountpoint's own file is written", async () => {
    const mnt = fresh('default-mode');
    let spawned = 0;
    const host = createRealProbeHost({
      random: () => 'add0add0add0add0',
      execCapture: async () => {
        spawned += 1;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const r = await host.fsIo(mnt, opts);
    expect(r.ok).toBe(true);
    expect(spawned).toBe(0);
    expect(r.artifact?.path).toBe(join(mnt, PROBE_DIR_NAME, 'probe-run-1-add0add0add0add0'));
  });
});

/**
 * B01 review, round 2 — `execFile` sets `err.signal` to `null` (not
 * `undefined`) on an ordinary non-zero exit; `@types/node` declares
 * `signal?: NodeJS.Signals` without `null`, so `err.signal !== undefined`
 * misclassified every such exit as a timeout. `execCaptureCode` is the pure
 * classifier under test, independent of `execFile`'s own timing.
 */
describe('execCaptureCode (Task 3 review, round 2)', () => {
  it('null (a clean exit) is code 0', () => {
    expect(execCaptureCode(null)).toBe(0);
  });

  it('an ordinary non-zero exit reports signal: null, not undefined — this is the bug this fix closes', () => {
    const err = Object.assign(new Error('Command failed'), {
      code: 1,
      signal: null,
      killed: false,
    });
    expect(execCaptureCode(err)).toBe(1);
  });

  it('killed: true with a SIGKILL signal is the -1 (timeout/killed) sentinel', () => {
    const err = Object.assign(new Error('Command failed'), {
      code: null,
      signal: 'SIGKILL',
      killed: true,
    });
    expect(execCaptureCode(err)).toBe(-1);
  });

  it('a string signal alone (killed: false) is still the -1 sentinel', () => {
    const err = Object.assign(new Error('Command failed'), {
      code: null,
      signal: 'SIGTERM',
      killed: false,
    });
    expect(execCaptureCode(err)).toBe(-1);
  });

  it('a spawn-level string code (no numeric exit) falls back to 127', () => {
    const err = Object.assign(new Error('spawn systemd-run ENOENT'), { code: 'ENOENT' });
    expect(execCaptureCode(err)).toBe(127);
  });
});

describe('defaultExecCapture (Task 3 review, round 2)', () => {
  it('a real child exiting non-zero reports its own code, stdout and stderr — not a timeout', async () => {
    const r = await defaultExecCapture('/bin/sh', ['-c', 'echo out; echo err 1>&2; exit 3'], 5_000);
    expect(r).toEqual({ stdout: 'out\n', stderr: 'err\n', code: 3 });
  });
});
