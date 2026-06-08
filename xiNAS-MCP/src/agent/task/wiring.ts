/**
 * Agent task subsystem wiring (S2 T7).
 *
 * Constructs the {@link ExecutorRegistry} (seeded with the reference executor),
 * the {@link XinasHistoryBridge} (backed by a real `execFile` subprocess
 * runner), the {@link TaskRunner}, and the progress publisher, returning the
 * pieces `agent-server.ts` needs to register the three `task.*` RPC handlers.
 *
 * Kept out of `agent-server.ts` so the privileged subprocess plumbing
 * (`execFile` -> `python3 -m xinas_history`) has one home and can be unit-tested
 * without booting the whole agent.
 */
import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { AgentConfig } from '../config.js';
import { parseIdmapConf } from '../../lib/parse/idmap.js';
import { buildNfsExecutors, type NfsExecutorDeps } from './nfs-executor.js';
import { createNfsHelperClientFromProbe } from './nfs-helper-client.js';
import { createProgressPublisher } from './progress-publisher.js';
import { ExecutorRegistry } from './registry.js';
import { TaskRunner } from './runner.js';
import type { PublishProgress } from './types.js';
import {
  type RunSubprocess,
  type SubprocessResult,
  XinasHistoryBridge,
} from './xinas-history-bridge.js';

/** Default nfs-helper UDS path (matches the read-path probe + convergence). */
const DEFAULT_NFS_HELPER_SOCKET = '/run/xinas-nfs-helper.sock';
/** Default round-trip timeout for nfs-helper write ops, in milliseconds. */
const DEFAULT_NFS_HELPER_TIMEOUT_MS = 5000;
/** idmapd config file the `readIdmapDomain` reader parses. */
const IDMAPD_CONF_PATH = '/etc/idmapd.conf';

/**
 * Production {@link NfsExecutorDeps}: the typed helper write client over the
 * same UDS the read-path probe uses, plus a `readIdmapDomain` that parses
 * `/etc/idmapd.conf` (the prior-domain rollback target for `nfs-idmap.set`).
 * On ENOENT / read / parse error the domain is reported as unset (undefined),
 * so a fresh install with no idmapd.conf yields a prior-unset (no-op) rollback.
 */
function buildNfsExecutorDeps(): NfsExecutorDeps {
  const helper = createNfsHelperClientFromProbe({
    helperSocket: DEFAULT_NFS_HELPER_SOCKET,
    timeoutMs: DEFAULT_NFS_HELPER_TIMEOUT_MS,
  });
  const readIdmapDomain = async (): Promise<string | undefined> => {
    try {
      const raw = await readFile(IDMAPD_CONF_PATH, 'utf8');
      return parseIdmapConf(raw).domain;
    } catch {
      return undefined;
    }
  };
  return { helper, readIdmapDomain };
}

/** What the task RPC handlers need from the wiring. */
export interface TaskSubsystem {
  registry: ExecutorRegistry;
  runner: TaskRunner;
  publish: PublishProgress;
}

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (
    err: (Error & { code?: number | string | null }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

/**
 * `execFile`-backed {@link RunSubprocess}: runs argv[0] with the rest as args and
 * resolves `{ stdout, code }`. A non-zero exit resolves (not rejects) with the
 * captured exit code so the bridge can format its own error; a spawn failure
 * (ENOENT etc.) surfaces code 127. stderr is merged into stdout so the bridge's
 * error message carries it.
 */
export function execFileRunSubprocess(argv: string[]): Promise<SubprocessResult> {
  const ef = nodeExecFile as unknown as ExecFileFn;
  const [program, ...args] = argv;
  return new Promise<SubprocessResult>((resolve) => {
    ef(program ?? '', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      if (err === null) {
        resolve({ stdout: out, code: 0 });
        return;
      }
      // execFile sets err.code to the numeric exit code on a non-zero exit, or
      // to a spawn-error string (ENOENT) when the program couldn't run.
      const code = typeof err.code === 'number' ? err.code : 127;
      resolve({ stdout: out, code });
    });
  });
}

/**
 * Build the task subsystem from the agent config. Pure construction — no
 * subprocess is spawned and no progress is published until a `task.begin`
 * drives the runner.
 */
export function buildTaskSubsystem(
  config: AgentConfig,
  opts: { runSubprocess?: RunSubprocess; nfsDeps?: NfsExecutorDeps } = {},
): TaskSubsystem {
  const registry = new ExecutorRegistry();
  // Register the real NFS executors (share.* + nfs-idmap.set) over the helper
  // client; tests may inject `nfsDeps` to override the helper/idmap reader.
  const nfsDeps = opts.nfsDeps ?? buildNfsExecutorDeps();
  for (const ex of buildNfsExecutors(nfsDeps)) {
    registry.register(ex);
  }
  const bridge = new XinasHistoryBridge({
    runSubprocess: opts.runSubprocess ?? execFileRunSubprocess,
  });
  const runner = new TaskRunner({ bridge });
  const publish = createProgressPublisher({
    apiSocketPath: config.api_socket,
    agentToken: config.agent_token,
  });
  return { registry, runner, publish };
}
