/**
 * Generic long-lived subprocess supervisor.
 *
 * Spawns the given command, reads stdout line-by-line, calls onLine for
 * each. On subprocess death, restarts with the given backoff schedule
 * (repeating the last interval forever). Structured-log on each restart.
 *
 * Privileged layer: may call child_process.spawn. Do NOT import from
 * outside src/agent/.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface MonitorOptions {
  cmd: string;
  args: string[];
  onLine: (line: string) => void;
  onError: (err: Error) => void;
  /** Backoff schedule in ms. Repeats last element forever. Default: [1000, 2000, 5000]. */
  backoffMs?: number[];
}

export interface MonitorHandle {
  stop(): Promise<void>;
}

export function startMonitor(opts: MonitorOptions): MonitorHandle {
  const backoff = opts.backoffMs ?? [1000, 2000, 5000];
  let stopped = false;
  let child: ChildProcess | null = null;
  let attempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopPromise: Promise<void> | null = null;

  function launch(): void {
    if (stopped) return;
    child = spawn(opts.cmd, opts.args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!stopped) opts.onLine(line);
    });
    child.on('error', (err) => {
      if (!stopped) opts.onError(err);
    });
    child.on('close', (_code) => {
      rl.close();
      if (stopped) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 5000;
      attempt++;
      // structured-log line on stderr so journald captures it
      process.stderr.write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: 'warn',
          subsystem: 'subprocess-monitor',
          event: 'restart',
          cmd: opts.cmd,
          attempt,
          backoff_ms: delay,
        }) + '\n',
      );
      restartTimer = setTimeout(launch, delay);
    });
  }

  launch();

  return {
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopped = true;
      if (restartTimer !== null) clearTimeout(restartTimer);
      stopPromise = new Promise((resolve) => {
        if (!child || child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('close', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child?.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 1000);
      });
      return stopPromise;
    },
  };
}
