/**
 * Network probe — privileged layer.
 *
 * snapshot()         → runs `ip -j addr show` via execFile → parseIpJson
 * startEventStream() → spawns `ip -j monitor link addr`; each JSON-array
 *                      line (one batch per event) → parseIpJson; fires
 *                      onDelta per interface in the batch.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
import { type ObservedNetworkInterface, parseIpJson } from '../../lib/parse/network.js';
import { type MonitorHandle, type MonitorOptions, startMonitor } from './subprocess-monitor.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

type SpawnMonitorFn = (opts: MonitorOptions) => MonitorHandle;

interface NetworkProbeOptions {
  execFile?: ExecFileFn;
  spawnMonitor?: SpawnMonitorFn;
}

export interface NetworkProbe {
  snapshot(): Promise<ObservedNetworkInterface[]>;
  startEventStream(onDelta: (iface: ObservedNetworkInterface) => void): MonitorHandle;
}

function execFilePromise(
  ef: ExecFileFn,
  file: string,
  args: string[],
  opts: ExecFileOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    ef(file, args, opts, (err, stdout, _stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function createNetworkProbe(opts: NetworkProbeOptions = {}): NetworkProbe {
  const ef = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const spawnMon = opts.spawnMonitor ?? startMonitor;

  return {
    async snapshot(): Promise<ObservedNetworkInterface[]> {
      const stdout = await execFilePromise(ef, 'ip', ['-j', 'addr', 'show'], {});
      return parseIpJson(stdout);
    },

    startEventStream(onDelta: (iface: ObservedNetworkInterface) => void): MonitorHandle {
      return spawnMon({
        cmd: 'ip',
        args: ['-j', 'monitor', 'link', 'addr'],
        onLine(line) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return;
          try {
            // ip -j monitor emits one JSON array per event batch
            const normalized = trimmed.startsWith('{') ? `[${trimmed}]` : trimmed;
            const ifaces = parseIpJson(normalized);
            for (const iface of ifaces) onDelta(iface);
          } catch {
            // partial / malformed line — skip
          }
        },
        onError(err) {
          process.stderr.write(
            JSON.stringify({
              level: 'warn',
              subsystem: 'network-probe',
              event: 'monitor-error',
              error: err.message,
            }) + '\n',
          );
        },
      });
    },
  };
}
