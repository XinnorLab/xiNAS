/**
 * ProbeHost (S7 T5, ADR-0009 §deep; rewritten in S19a T2 — spec §9.3,
 * D-08, ADR-0018 §4; hardened for validation F05/F06/F07): the privileged
 * verbs behind the active health probes. Every artifact is per run and
 * every outcome says what happened to it. `runId` is untrusted input
 * embedded in a path, so both verbs reject anything outside
 * `ARTIFACT_RUN_RE` before it can reach one (F06).
 *
 *  - fsIo: under `<mountpoint>/.xinas-health` (a directory that must sit
 *    on the mountpoint's own device, be owned by us, must not be a
 *    symlink and must not be group/world-writable — F07) create
 *    `probe-<run>-<random>` with O_CREAT|O_EXCL|O_NOFOLLOW, write 4 KiB,
 *    fsync, read it back through a fresh open, unlink it. Node has no
 *    `openat`, so the post-open fstat (same device, one link, plain
 *    file) stands in for it. The unlink is preceded by an `lstat`
 *    checked against the inode/device this run's own create step saw;
 *    a mismatch means the name was swapped and nothing is removed
 *    (F07). A failed or refused unlink is `cleanup.status: 'failed'`.
 *  - nfsLoopback: PID1-DELEGATED `systemd-mount localhost:<export>` at a
 *    per-run `<root>/<run>-<random>/mnt` (the S5 pattern — PID1 performs
 *    the mount so the probe inherits `.mount` unit semantics), list it.
 *    However the mount step ends, `systemd-umount` is always attempted
 *    (the client's own failure or timeout does not prove PID1 did not
 *    mount), then `st_dev` of `<mnt>` is compared with its parent: a
 *    differing device means something is still mounted and the
 *    directory is left in place; otherwise `rmdir` removes the two
 *    per-run directories — never a recursive delete (F05). Loopback
 *    probes are serialized by an in-process flag plus an O_EXCL lock
 *    file whose pid is checked for staleness; a held lock is
 *    `PROBE_IN_PROGRESS`.
 *
 * Every step is bounded by the run's `timeoutMs` ON THE AGENT: a step
 * that overruns ends the probe with `TIMEOUT` and cleanup is still
 * attempted. Both verbs return outcomes instead of throwing — a failed
 * probe is a RESULT, not an RPC failure.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  type FileHandle,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARTIFACT_RUN_RE,
  PROBE_DIR_NAME,
  PROBE_PAYLOAD_BYTES,
  type ProbeCleanup,
  type ProbeOutcome,
  type ProbeRunOptions,
  type ProbeStage,
} from '../../lib/health/probe-types.js';

const DEFAULT_ROOT = '/run/xinas/health-probe';
const LOCK_NAME = '.lock';
const PAYLOAD = Buffer.alloc(PROBE_PAYLOAD_BYTES, 'xinas-health-probe\n');
const CREATE_ATTEMPTS = 3;
const UMOUNT_TIMEOUT_MS = 20_000;

/** Test-only seams: let a test slow or sabotage a single step. */
export interface FsIoHooks {
  beforeFsync?(): Promise<void> | void;
  beforeUnlink?(): Promise<void> | void;
}

export interface ProbeHost {
  fsIo(mountpoint: string, opts: ProbeRunOptions, hooks?: FsIoHooks): Promise<ProbeOutcome>;
  nfsLoopback(exportPath: string, opts: ProbeRunOptions): Promise<ProbeOutcome>;
}

export interface RealProbeHostDeps {
  /** Loopback root; default /run/xinas/health-probe. */
  root?: string;
  /** Owner the probe directory must have; default the agent's own uid (root in production). */
  uid?: number;
  /** 16 hex chars per call; default randomBytes(8). */
  random?: () => string;
  /** systemd-mount / systemd-umount runner; default execFile with a SIGKILL timeout. */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<void>;
  clock?: () => number;
}

class StageError extends Error {
  constructor(
    readonly stage: ProbeStage,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

const errCode = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'ERROR';
};
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const toError = (err: unknown, fallbackStage: ProbeStage): NonNullable<ProbeOutcome['error']> =>
  err instanceof StageError
    ? { code: err.code, message: err.message, stage: err.stage }
    : { code: errCode(err), message: errMessage(err), stage: fallbackStage };

/**
 * F06: `runId` is embedded verbatim into an artifact name (and, for
 * `nfsLoopback`, a directory name under `root`), so it is checked before
 * it can reach a path — a null runId (the deep-probe caller) is fine.
 */
const runIdInvalid = (runId: string | null, stage: ProbeStage): StageError | null =>
  runId !== null && !ARTIFACT_RUN_RE.test(runId)
    ? new StageError(stage, 'RUN_ID_INVALID', 'run id may only contain letters, digits and dashes')
    : null;

/** A step runner bounded by the run deadline; an overrun rejects with TIMEOUT. */
function makeStepper(deadline: number, clock: () => number) {
  return async function step<T>(stage: ProbeStage, fn: () => Promise<T>): Promise<T> {
    const left = deadline - clock();
    if (left <= 0) throw new StageError(stage, 'TIMEOUT', `probe timed out before ${stage}`);
    let timer: NodeJS.Timeout | undefined;
    const work = fn();
    // An abandoned step (we stop waiting on timeout) must never surface as
    // an unhandled rejection later.
    work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StageError(stage, 'TIMEOUT', `probe timed out during ${stage}`)),
            left,
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof StageError) throw err;
      throw new StageError(stage, errCode(err), errMessage(err));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

const defaultExec = (file: string, args: string[], timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, _stdout, stderr) => {
      if (err !== null)
        reject(new Error(`${file} ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve();
    });
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM'; // exists, owned by someone else
  }
};

/** A directory is a mountpoint when its device differs from its parent's. */
async function isMountpoint(path: string): Promise<boolean> {
  try {
    const [self, parent] = await Promise.all([stat(path), stat(join(path, '..'))]);
    return self.dev !== parent.dev;
  } catch {
    return false;
  }
}

export function createRealProbeHost(deps: RealProbeHostDeps = {}): ProbeHost {
  const root = deps.root ?? DEFAULT_ROOT;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const random = deps.random ?? (() => randomBytes(8).toString('hex'));
  const exec = deps.exec ?? defaultExec;
  const clock = deps.clock ?? Date.now;
  const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = constants;
  let loopbackBusy = false;

  async function acquireLock(lockPath: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(lockPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
        try {
          await fh.write(`${process.pid}\n`);
        } finally {
          await fh.close();
        }
        return;
      } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
        const raw = await readFile(lockPath, 'utf8').catch(() => '');
        const pid = Number.parseInt(raw.trim(), 10);
        const held = Number.isInteger(pid) && pid > 0 && isAlive(pid);
        if (held || attempt === 1) {
          throw new Error(`another loopback probe holds ${lockPath} (pid ${raw.trim() || '?'})`);
        }
        await unlink(lockPath).catch(() => undefined); // stale lock: reclaim once
      }
    }
  }

  return {
    async fsIo(mountpoint, opts, hooks): Promise<ProbeOutcome> {
      const startedAt = new Date(clock()).toISOString();
      const step = makeStepper(clock() + opts.timeoutMs, clock);
      let artifact: ProbeOutcome['artifact'] = null;
      let cleanup: ProbeCleanup = { status: 'not_needed' };
      let error: ProbeOutcome['error'];
      let mntFh: FileHandle | undefined;
      let dirFh: FileHandle | undefined;
      let fh: FileHandle | undefined;
      let filePath: string | undefined;
      let createdIno: { ino: number; dev: number } | undefined;
      try {
        const bad = runIdInvalid(opts.runId, 'dir');
        if (bad !== null) throw bad;

        // 1. The mountpoint itself, never through a symlink.
        mntFh = await step('open', () => open(mountpoint, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
        const mntHandle = mntFh;
        const mntStat = await step('open', () => mntHandle.stat());

        // 2. The probe directory: created 0700 if absent, then opened with
        //    O_NOFOLLOW and checked to be a plain directory on the same
        //    device, owned by us.
        const dirPath = join(mountpoint, PROBE_DIR_NAME);
        await step('dir', async () => {
          try {
            await mkdir(dirPath, { mode: 0o700 });
          } catch (err) {
            if (errCode(err) !== 'EEXIST') throw err;
          }
        });
        dirFh = await step('dir', async () => {
          try {
            return await open(dirPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          } catch (err) {
            const code = errCode(err);
            if (code === 'ELOOP' || code === 'ENOTDIR') {
              throw new StageError(
                'dir',
                'probe_dir_untrusted',
                `${PROBE_DIR_NAME} is not a plain directory (${code})`,
              );
            }
            throw err;
          }
        });
        const dirHandle = dirFh;
        const dirStat = await step('dir', () => dirHandle.stat());
        if (
          !dirStat.isDirectory() ||
          dirStat.dev !== mntStat.dev ||
          dirStat.uid !== uid ||
          (dirStat.mode & 0o022) !== 0
        ) {
          throw new StageError(
            'dir',
            'probe_dir_untrusted',
            `${PROBE_DIR_NAME} must be a directory on the mountpoint's device, owned by uid ${uid}, not group/world-writable`,
          );
        }

        // 3. Create the per-run file exclusively; a colliding name retries.
        const created = await step('create', async () => {
          for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
            const candidate = join(dirPath, `probe-${opts.runId ?? 'none'}-${random()}`);
            try {
              const handle = await open(candidate, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
              return { handle, path: candidate };
            } catch (err) {
              if (errCode(err) !== 'EEXIST' || attempt === CREATE_ATTEMPTS - 1) throw err;
            }
          }
          throw new StageError('create', 'EEXIST', 'could not find a free probe file name');
        });
        fh = created.handle;
        filePath = created.path;
        artifact = { kind: 'file', path: created.path };
        const fileStat = await step('create', () => created.handle.stat());
        if (!fileStat.isFile() || fileStat.nlink !== 1 || fileStat.dev !== mntStat.dev) {
          throw new StageError(
            'create',
            'probe_dir_untrusted',
            'the created probe file is not a plain file on the mountpoint device',
          );
        }
        createdIno = { ino: fileStat.ino, dev: fileStat.dev };

        // 4. Write, fsync, close.
        await step('write', () => created.handle.write(PAYLOAD, 0, PAYLOAD.length, 0));
        await step('fsync', async () => {
          await hooks?.beforeFsync?.();
          await created.handle.sync();
        });
        await step('fsync', () => created.handle.close());
        fh = undefined;

        // 5. Read it back through a fresh open of the same inode.
        await step('read', async () => {
          const rfh = await open(created.path, O_RDONLY | O_NOFOLLOW);
          try {
            const st = await rfh.stat();
            if (st.ino !== fileStat.ino) {
              throw new StageError(
                'read',
                'READ_BACK_MISMATCH',
                'the probe file was replaced between write and read',
              );
            }
            const buf = Buffer.alloc(PAYLOAD.length);
            const { bytesRead } = await rfh.read(buf, 0, buf.length, 0);
            if (bytesRead !== PAYLOAD.length || !buf.equals(PAYLOAD)) {
              throw new StageError(
                'read',
                'READ_BACK_MISMATCH',
                'read-back differs from the written payload',
              );
            }
          } finally {
            await rfh.close();
          }
        });
      } catch (err) {
        error = toError(err, 'open');
      } finally {
        if (fh !== undefined) await fh.close().catch(() => undefined);
        // 6. Only the file this run created is ever unlinked: an lstat of the
        //    name must still show the inode/device this run's `create` step
        //    saw, or the name was swapped underneath us (validation F07).
        if (filePath !== undefined) {
          const path = filePath;
          try {
            await hooks?.beforeUnlink?.();
            const now = await lstat(path);
            if (
              createdIno === undefined ||
              !now.isFile() ||
              now.ino !== createdIno.ino ||
              now.dev !== createdIno.dev
            ) {
              cleanup = { status: 'failed', detail: 'probe file was replaced; not removed' };
            } else {
              await unlink(path);
              cleanup = { status: 'clean' };
            }
          } catch (err) {
            cleanup = { status: 'failed', detail: `${errCode(err)}: ${errMessage(err)}` };
          }
        }
        if (dirFh !== undefined) await dirFh.close().catch(() => undefined);
        if (mntFh !== undefined) await mntFh.close().catch(() => undefined);
      }
      return {
        ok: error === undefined,
        started_at: startedAt,
        completed_at: new Date(clock()).toISOString(),
        artifact,
        ...(error !== undefined ? { error } : {}),
        cleanup,
      };
    },

    async nfsLoopback(exportPath, opts): Promise<ProbeOutcome> {
      const startedAt = new Date(clock()).toISOString();
      const deadline = clock() + opts.timeoutMs;
      const step = makeStepper(deadline, clock);
      const refused = (message: string): ProbeOutcome => ({
        ok: false,
        started_at: startedAt,
        completed_at: new Date(clock()).toISOString(),
        artifact: null,
        error: { code: 'PROBE_IN_PROGRESS', message, stage: 'lock' },
        cleanup: { status: 'not_needed' },
      });
      const bad = runIdInvalid(opts.runId, 'lock');
      if (bad !== null) {
        return {
          ok: false,
          started_at: startedAt,
          completed_at: new Date(clock()).toISOString(),
          artifact: null,
          error: toError(bad, 'lock'),
          cleanup: { status: 'not_needed' },
        };
      }
      if (loopbackBusy) return refused('another loopback probe is in flight on this node');
      loopbackBusy = true;
      const lockPath = join(root, LOCK_NAME);
      let lockHeld = false;
      let artifact: ProbeOutcome['artifact'] = null;
      let cleanup: ProbeCleanup = { status: 'not_needed' };
      let error: ProbeOutcome['error'];
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        try {
          await acquireLock(lockPath);
          lockHeld = true;
        } catch (err) {
          return refused(errMessage(err));
        }
        const dir = join(root, `${opts.runId ?? 'none'}-${random()}`);
        const mnt = join(dir, 'mnt');
        await mkdir(mnt, { recursive: true, mode: 0o700 });
        artifact = { kind: 'mountpoint', path: mnt };
        let mountAttempted = false;
        try {
          mountAttempted = true;
          await step('mount', () =>
            exec(
              'systemd-mount',
              ['--collect', `localhost:${exportPath}`, mnt],
              Math.max(1, deadline - clock()),
            ),
          );
          await step('readdir', () => readdir(mnt));
        } catch (err) {
          error = toError(err, 'mount');
        } finally {
          // The client's death does not prove PID1 did not mount: always
          // umount, then look at real state (validation F05) — never rely
          // on the command's own exit status, and never delete recursively.
          let umountError: string | null = null;
          if (mountAttempted) {
            try {
              await exec('systemd-umount', [mnt], UMOUNT_TIMEOUT_MS);
            } catch (err) {
              umountError = errMessage(err);
            }
          }
          const stillMounted = await isMountpoint(mnt);
          if (stillMounted) {
            cleanup = {
              status: 'failed',
              detail: `mountpoint still mounted${umountError !== null ? ` (systemd-umount: ${umountError})` : ''}`,
            };
          } else {
            try {
              await rmdir(mnt);
              await rmdir(dir);
              cleanup = { status: 'clean' };
            } catch (err) {
              cleanup = { status: 'failed', detail: `rmdir: ${errCode(err)}: ${errMessage(err)}` };
            }
          }
        }
      } catch (err) {
        error = toError(err, 'lock');
      } finally {
        if (lockHeld) await unlink(lockPath).catch(() => undefined);
        loopbackBusy = false;
      }
      return {
        ok: error === undefined,
        started_at: startedAt,
        completed_at: new Date(clock()).toISOString(),
        artifact,
        ...(error !== undefined ? { error } : {}),
        cleanup,
      };
    },
  };
}
