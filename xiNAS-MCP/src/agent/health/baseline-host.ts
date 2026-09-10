/**
 * The baseline engine host (S19c; spec §8.3, D-09): runs the Python health
 * engine `python3 -m xinas_menu.health <profile> <log_dir> --json --no-save`
 * as a capped, sandboxed, read-only subprocess and answers its `--sections`
 * list.
 *
 * Sandbox: the profile MUST realpath-resolve inside `profiles_dir` (the
 * agent never runs an arbitrary file — a symlink out of the directory is
 * refused before anything is spawned); cwd is `module_root`; the
 * environment is `PATH`, `LANG=C.UTF-8` and `PYTHONPATH=module_root` and
 * nothing else; stdin is closed; stdout is capped at 4 MiB and stderr at
 * 64 KiB (the last 4 KiB travel in the result); the child runs in its own
 * process group and the whole group is SIGKILLed at the deadline.
 *
 * Queueing (validation F09): one engine subprocess runs at a time per
 * agent, and every caller's deadline is absolute from the moment its call
 * arrives (`now + timeoutMs`), not from the spawn — a run whose deadline
 * passes while it waits its turn is `timeout` and is never spawned. Runs
 * coalesce on the profile's realpath across the WHOLE queue, so a caller
 * of a queued or running profile joins that one subprocess (SAFE-04
 * "duplicate requests are merged") while keeping its own deadline; the
 * job itself runs against the LONGEST deadline of its participants, so an
 * initiator that gave up never cancels a run a joiner still wants. At most
 * `maxQueued` (default 4) distinct jobs are queued or running at once; a
 * further one is refused `QUEUE_FULL` instead of growing a backlog.
 * `sections()` is one more such job (key `--sections`): it coalesces and
 * counts against the same bound under the same deadline rules.
 *
 * The engine's own budget is the time left before that deadline less
 * {@link ENGINE_GRACE_MS}, so its kill timer fires first and the caller
 * sees the engine's typed `timeout` — with `duration_ms` and the stderr
 * tail — instead of the queue's bare deadline answer.
 *
 * A truncated, failed or unparseable run is a typed failure — never a
 * partial report presented as complete.
 */

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import type { HealthBaselineConfig } from '../config.js';

export const BASELINE_MODULE = 'xinas_menu.health';
export const BASELINE_ENGINE_MODULE = 'xinas_menu.health.engine';
export const STDOUT_CAP = 4 * 1024 * 1024;
export const STDERR_CAP = 64 * 1024;
export const STDERR_TAIL = 4 * 1024;
/**
 * How much of a caller's budget is reserved for the answer to travel back
 * (validation F09): the engine is killed at `deadline - ENGINE_GRACE_MS`,
 * so its own typed `timeout` result wins the race against the caller's
 * absolute deadline instead of being shadowed by it.
 */
export const ENGINE_GRACE_MS = 250;

export type BaselineStatus = 'success' | 'error' | 'timeout' | 'not_supported';

export interface BaselineError {
  code: string;
  message: string;
}

export interface BaselineRunResult {
  status: BaselineStatus;
  collected_at: string;
  duration_ms: number;
  engine: { module: typeof BASELINE_ENGINE_MODULE; version: string | null };
  /** The engine's JSON verbatim; null unless `status` is `success`. */
  report: Record<string, unknown> | null;
  stderr_tail: string;
  error?: BaselineError;
}

export interface BaselineSections {
  status: BaselineStatus;
  collected_at: string;
  sections: string[] | null;
  version: string | null;
  error?: BaselineError;
}

export interface BaselineHost {
  run(profilePath: string, timeoutMs: number): Promise<BaselineRunResult>;
  sections(timeoutMs: number): Promise<BaselineSections>;
}

export interface BaselineHostDeps {
  now?: () => number;
  stdoutCap?: number;
  stderrCap?: number;
  /**
   * How many distinct jobs may be queued or running at once (default 4) —
   * distinct profiles plus the `--sections` call, which counts like any
   * profile. A caller of a job that is already pending joins it and never
   * counts against the bound; a caller beyond it is refused `QUEUE_FULL`
   * rather than queued behind an unbounded backlog.
   */
  maxQueued?: number;
}

/** A queued or running engine job, shared by every caller that joined it. */
interface PendingJob<T> {
  /**
   * The LONGEST deadline among the participants. The job runs while any of
   * them still has budget; each of them still leaves on its own deadline.
   */
  deadline: number;
  promise: Promise<T>;
}

interface Exec {
  status: BaselineStatus;
  stdout: string;
  stdoutOverflow: boolean;
  stderr: string;
  duration_ms: number;
  error?: BaselineError;
}

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const QUEUE_DEADLINE_MESSAGE = 'the engine queue exceeded the caller deadline';
const SHARED_FAILURE_MESSAGE = 'the shared run failed';
/** The coalescing key of the `--sections` job — no realpath can collide with it. */
const SECTIONS_KEY = '--sections';

function runEngine(
  config: HealthBaselineConfig,
  args: string[],
  timeoutMs: number,
  caps: { stdout: number; stderr: number },
  now: () => number,
): Promise<Exec> {
  return new Promise((resolve) => {
    const started = now();
    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (status: BaselineStatus, error?: BaselineError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout,
        stdoutOverflow,
        stderr,
        duration_ms: Math.max(0, now() - started),
        ...(error !== undefined ? { error } : {}),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.python, args, {
        cwd: config.module_root,
        env: {
          PATH: process.env.PATH ?? DEFAULT_PATH,
          LANG: 'C.UTF-8',
          PYTHONPATH: config.module_root,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      finish(e.code === 'ENOENT' ? 'not_supported' : 'error', {
        code: e.code ?? 'SPAWN',
        message: e.message,
      });
      return;
    }

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutOverflow) return;
      if (stdout.length + chunk.length > caps.stdout) {
        stdoutOverflow = true;
        stdout = '';
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= caps.stderr) return;
      stderr += chunk.toString('utf8').slice(0, caps.stderr - stderr.length);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        finish('not_supported', {
          code: 'ENOENT',
          message: `${config.python}: interpreter not found`,
        });
      } else {
        finish('error', { code: err.code ?? 'SPAWN', message: err.message });
      }
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish('timeout', {
          code: 'TIMEOUT',
          message: `engine exceeded ${timeoutMs} ms and was killed`,
        });
        return;
      }
      if (signal !== null) {
        finish('error', { code: 'KILLED', message: `engine terminated by ${signal}` });
        return;
      }
      if (code !== 0) {
        if (/No module named/.test(stderr)) {
          finish('not_supported', {
            code: 'MODULE_ABSENT',
            message: stderr.trim().split('\n').at(-1) ?? 'module absent',
          });
        } else {
          finish('error', {
            code: `EXIT_${code ?? 'null'}`,
            message: `engine exited with ${code}`,
          });
        }
        return;
      }
      finish('success');
    });
  });
}

const tail = (s: string): string => (s.length > STDERR_TAIL ? s.slice(s.length - STDERR_TAIL) : s);

function parseObject(
  exec: Exec,
  cap: number,
): { value: Record<string, unknown> } | { error: BaselineError } {
  if (exec.stdoutOverflow) {
    return { error: { code: 'PARSE', message: `engine stdout exceeded ${cap} bytes` } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(exec.stdout);
  } catch (err) {
    return {
      error: {
        code: 'PARSE',
        message: `engine stdout is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: { code: 'PARSE', message: 'engine stdout is not a JSON object' } };
  }
  return { value: parsed as Record<string, unknown> };
}

export function makeBaselineHost(
  config: HealthBaselineConfig,
  deps: BaselineHostDeps = {},
): BaselineHost {
  const now = deps.now ?? (() => Date.now());
  const caps = { stdout: deps.stdoutCap ?? STDOUT_CAP, stderr: deps.stderrCap ?? STDERR_CAP };
  const maxQueued = deps.maxQueued ?? 4;
  let version: string | null = null;
  let sectionsCache: BaselineSections | null = null;
  /** Queued or running runs by resolved profile path — the coalescing key. */
  const pendingRuns = new Map<string, PendingJob<BaselineRunResult>>();
  /** The queued or running `--sections` job, under {@link SECTIONS_KEY}. */
  const pendingSections = new Map<string, PendingJob<BaselineSections>>();
  /** Runs and the `--sections` call share one `maxQueued` bound. */
  const queueSize = () => pendingRuns.size + pendingSections.size;
  // One engine subprocess at a time: every run and sections() call queues behind the previous one.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const stamp = () => new Date(now()).toISOString();

  /**
   * Waits for a queued or running job, but never past the caller's OWN
   * deadline: once it passes, the caller is answered with `onDeadline()`
   * while the job keeps going for whoever else joined it.
   */
  const withDeadline = <T>(
    shared: Promise<T>,
    deadline: number,
    onDeadline: () => T,
    onFailure: () => T,
  ): Promise<T> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(onDeadline()), Math.max(0, deadline - now()));
      shared.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        () => {
          clearTimeout(timer);
          resolve(onFailure());
        },
      );
    });

  /**
   * Joins the pending job for `key`, or starts one under the shared
   * `maxQueued` bound.
   *
   * Joining raises the job's deadline to the longest of its participants,
   * so an initiator whose own deadline expired never cancels a run a
   * joiner still has budget for; every caller nevertheless waits only for
   * its own deadline (`withDeadline`). `body` receives the engine budget:
   * what is left before that longest deadline, less {@link ENGINE_GRACE_MS}
   * — nothing is spawned once that is gone.
   */
  const coalesce = <T>(
    jobs: Map<string, PendingJob<T>>,
    key: string,
    deadline: number,
    answers: { onDeadline: () => T; onFailure: () => T; onFull: () => T },
    body: (budgetMs: number) => Promise<T>,
  ): Promise<T> => {
    const joined = jobs.get(key);
    if (joined !== undefined) {
      joined.deadline = Math.max(joined.deadline, deadline);
      return withDeadline(joined.promise, deadline, answers.onDeadline, answers.onFailure);
    }
    if (queueSize() >= maxQueued) return Promise.resolve(answers.onFull());
    const promise = enqueue(async () => {
      const budget = (jobs.get(key)?.deadline ?? deadline) - now() - ENGINE_GRACE_MS;
      if (budget <= 0) return answers.onDeadline();
      return body(budget);
    }).finally(() => {
      if (jobs.get(key)?.promise === promise) jobs.delete(key);
    });
    jobs.set(key, { deadline, promise });
    return withDeadline(promise, deadline, answers.onDeadline, answers.onFailure);
  };

  /** The realpath allow-list of spec §8.3; a rejected path never reaches spawn. */
  const resolveProfile = (profilePath: string): { path: string } | { error: BaselineError } => {
    let root: string;
    try {
      root = realpathSync(config.profiles_dir);
    } catch (err) {
      return {
        error: {
          code: 'PROFILES_DIR_MISSING',
          message: `${config.profiles_dir}: ${(err as Error).message}`,
        },
      };
    }
    let real: string;
    try {
      real = realpathSync(profilePath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        error: {
          code: e.code === 'ENOENT' ? 'PROFILE_NOT_FOUND' : (e.code ?? 'ERROR'),
          message: `${profilePath}: ${e.message}`,
        },
      };
    }
    if (!real.startsWith(root + sep)) {
      return {
        error: {
          code: 'OUTSIDE_PROFILES_DIR',
          message: `${profilePath} resolves outside ${config.profiles_dir}`,
        },
      };
    }
    if (!statSync(real).isFile()) {
      return { error: { code: 'PROFILE_NOT_FOUND', message: `${profilePath} is not a file` } };
    }
    return { path: real };
  };

  const failedRun = (
    error: BaselineError,
    status: BaselineStatus = 'error',
  ): BaselineRunResult => ({
    status,
    collected_at: stamp(),
    duration_ms: 0,
    engine: { module: BASELINE_ENGINE_MODULE, version },
    report: null,
    stderr_tail: '',
    error,
  });

  const failedSections = (status: BaselineStatus, error: BaselineError): BaselineSections => ({
    status,
    collected_at: stamp(),
    sections: null,
    version: null,
    error,
  });

  /** The caller's own deadline passed while the job waited its turn. */
  const timedOut = (): BaselineRunResult =>
    failedRun({ code: 'TIMEOUT', message: QUEUE_DEADLINE_MESSAGE }, 'timeout');
  const sectionsTimedOut = (): BaselineSections =>
    failedSections('timeout', { code: 'TIMEOUT', message: QUEUE_DEADLINE_MESSAGE });
  const sharedFailed = (): BaselineRunResult =>
    failedRun({ code: 'ERROR', message: SHARED_FAILURE_MESSAGE });
  const sharedSectionsFailed = (): BaselineSections =>
    failedSections('error', { code: 'ERROR', message: SHARED_FAILURE_MESSAGE });
  /** The bound is full: refused outright rather than queued behind a backlog. */
  const queueFull = (): BaselineError => ({
    code: 'QUEUE_FULL',
    message: `${maxQueued} baseline runs are already queued`,
  });
  const runAnswers = {
    onDeadline: timedOut,
    onFailure: sharedFailed,
    onFull: (): BaselineRunResult => failedRun(queueFull()),
  };
  const sectionsAnswers = {
    onDeadline: sectionsTimedOut,
    onFailure: sharedSectionsFailed,
    onFull: (): BaselineSections => failedSections('error', queueFull()),
  };

  const runOnce = async (real: string, timeoutMs: number): Promise<BaselineRunResult> => {
    const exec = await runEngine(
      config,
      ['-m', BASELINE_MODULE, real, config.log_dir, '--json', '--no-save'],
      timeoutMs,
      caps,
      now,
    );
    const base: Omit<BaselineRunResult, 'status' | 'report' | 'error'> = {
      collected_at: stamp(),
      duration_ms: exec.duration_ms,
      engine: { module: BASELINE_ENGINE_MODULE, version },
      stderr_tail: tail(exec.stderr),
    };
    if (exec.status !== 'success') {
      return {
        ...base,
        status: exec.status,
        report: null,
        ...(exec.error !== undefined ? { error: exec.error } : {}),
      };
    }
    const parsed = parseObject(exec, caps.stdout);
    if ('error' in parsed) return { ...base, status: 'error', report: null, error: parsed.error };
    return { ...base, status: 'success', report: parsed.value };
  };

  const sectionsOnce = async (timeoutMs: number): Promise<BaselineSections> => {
    // Another caller may have filled the cache while this job waited its turn.
    if (sectionsCache !== null) return sectionsCache;
    const exec = await runEngine(
      config,
      ['-m', BASELINE_MODULE, '--sections'],
      timeoutMs,
      caps,
      now,
    );
    const collected_at = stamp();
    if (exec.status !== 'success') {
      return {
        status: exec.status,
        collected_at,
        sections: null,
        version: null,
        ...(exec.error !== undefined ? { error: exec.error } : {}),
      };
    }
    const parsed = parseObject(exec, caps.stdout);
    if ('error' in parsed) {
      return { status: 'error', collected_at, sections: null, version: null, error: parsed.error };
    }
    const list = parsed.value.sections;
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
      return {
        status: 'error',
        collected_at,
        sections: null,
        version: null,
        error: { code: 'PARSE', message: '--sections output has no string array `sections`' },
      };
    }
    version = typeof parsed.value.version === 'string' ? parsed.value.version : null;
    sectionsCache = { status: 'success', collected_at, sections: list as string[], version };
    return sectionsCache;
  };

  return {
    run(profilePath, timeoutMs) {
      const resolved = resolveProfile(profilePath);
      if ('error' in resolved) return Promise.resolve(failedRun(resolved.error));
      return coalesce(pendingRuns, resolved.path, now() + timeoutMs, runAnswers, (budget) =>
        runOnce(resolved.path, budget),
      );
    },

    sections(timeoutMs) {
      if (sectionsCache !== null) return Promise.resolve(sectionsCache);
      return coalesce(
        pendingSections,
        SECTIONS_KEY,
        now() + timeoutMs,
        sectionsAnswers,
        sectionsOnce,
      );
    },
  };
}
