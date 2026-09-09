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
 * process group and the whole group is SIGKILLed at the deadline. One
 * engine subprocess runs at a time per agent: concurrent callers of the
 * same profile share the in-flight run (SAFE-04 "duplicate requests are
 * merged"); a different profile waits its turn.
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
  let version: string | null = null;
  let sectionsCache: BaselineSections | null = null;
  let inFlight: { path: string; promise: Promise<BaselineRunResult> } | null = null;
  // One engine subprocess at a time: every run and sections() call queues behind the previous one.
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const stamp = () => new Date(now()).toISOString();

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

  return {
    run(profilePath, timeoutMs) {
      const resolved = resolveProfile(profilePath);
      if ('error' in resolved) return Promise.resolve(failedRun(resolved.error));
      if (inFlight !== null && inFlight.path === resolved.path) return inFlight.promise;
      const promise = queue(() => runOnce(resolved.path, timeoutMs)).finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      inFlight = { path: resolved.path, promise };
      return promise;
    },

    async sections(timeoutMs) {
      if (sectionsCache !== null) return sectionsCache;
      const exec = await queue(() =>
        runEngine(config, ['-m', BASELINE_MODULE, '--sections'], timeoutMs, caps, now),
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
        return {
          status: 'error',
          collected_at,
          sections: null,
          version: null,
          error: parsed.error,
        };
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
    },
  };
}
