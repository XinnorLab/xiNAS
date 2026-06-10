/**
 * Disk probe — privileged layer.
 *
 * snapshot()         → runs `lsblk --json` via execFile → parseLsblkOutput
 * startEventStream() → spawns `udevadm monitor --udev --subsystem-match=block
 *                      --property`; parses blank-line-terminated records into
 *                      { action, devname }; fires onDelta for add/remove/change.
 *
 * All dependencies injectable for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
import { type ObservedDisk, parseLsblkOutput } from '../../lib/parse/disk.js';
import { type MonitorHandle, type MonitorOptions, startMonitor } from './subprocess-monitor.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

type SpawnMonitorFn = (opts: MonitorOptions) => MonitorHandle;

interface DiskProbeOptions {
  execFile?: ExecFileFn;
  spawnMonitor?: SpawnMonitorFn;
}

export interface UdevDelta {
  action: string;
  devname: string;
  subsystem?: string;
}

export interface DiskProbe {
  snapshot(): Promise<ObservedDisk[]>;
  startEventStream(onDelta: (delta: UdevDelta) => void): MonitorHandle;
}

/** Wrap an execFile-style callback fn into a Promise returning { stdout, stderr }. */
function execFilePromise(
  ef: ExecFileFn,
  file: string,
  args: string[],
  opts: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    ef(file, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export function createDiskProbe(opts: DiskProbeOptions = {}): DiskProbe {
  const ef: ExecFileFn = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const spawnMon = opts.spawnMonitor ?? startMonitor;

  return {
    async snapshot(): Promise<ObservedDisk[]> {
      const { stdout } = await execFilePromise(
        ef,
        'lsblk',
        // --bytes: numeric SIZE so the parser derives capacity_bytes;
        // MOUNTPOINTS: system-disk/mounted/safe_for_use derivation (S3 T2).
        ['--json', '--bytes', '--output', 'NAME,SIZE,TYPE,MODEL,SERIAL,TRAN,WWN,MOUNTPOINTS'],
        {},
      );
      return parseLsblkOutput(stdout);
    },

    startEventStream(onDelta: (delta: UdevDelta) => void): MonitorHandle {
      // udevadm property-format: blank-line-terminated records
      const pending: Record<string, string> = {};
      return spawnMon({
        cmd: 'udevadm',
        args: ['monitor', '--udev', '--subsystem-match=block', '--property'],
        onLine(line) {
          if (line.trim() === '') {
            // end of record — emit if we have ACTION + DEVNAME
            const action = pending['ACTION'];
            const devname = pending['DEVNAME'];
            if (action && devname) {
              onDelta({
                action,
                devname,
                ...(pending['SUBSYSTEM'] !== undefined ? { subsystem: pending['SUBSYSTEM'] } : {}),
              });
            }
            for (const k of Object.keys(pending)) delete pending[k];
          } else {
            const eq = line.indexOf('=');
            if (eq > 0) {
              const key = line.slice(0, eq).trim();
              const val = line.slice(eq + 1).trim();
              pending[key] = val;
            }
          }
        },
        onError(err) {
          process.stderr.write(
            JSON.stringify({
              level: 'warn',
              subsystem: 'disk-probe',
              event: 'udevadm-error',
              error: err.message,
            }) + '\n',
          );
        },
      });
    },
  };
}
