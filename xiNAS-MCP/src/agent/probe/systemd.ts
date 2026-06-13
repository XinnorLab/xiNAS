/**
 * Systemd probe — privileged layer.
 *
 * `createSystemctlProbe()` reads unit state via `systemctl show` per
 * allow-listed unit (subprocess-based, CI-fakeable through the injectable
 * execFile seam), refreshed by the SystemdUnit collector's 30 s poll
 * backstop. A dbus event subscription was prototyped earlier and dropped
 * (the node already reads healthy off the poll — see ADR-0009 §Systemd);
 * `subscribeAllowListed` is a no-op handle.
 *
 * Do NOT import from outside src/agent/.
 */

// Allow-listed units observed via `systemctl show`. The xinas services are
// appended in S7_ALLOWLIST_ADDITIONS; *.mount units for managed filesystems
// are a documented future extension (not wired today).
export const DEFAULT_ALLOWLIST: string[] = [
  'nfs-server.service',
  'nfs-mountd.service',
  'nfs-idmapd.service',
  'nfs-blkmap.service',
  'rpcbind.service',
  'rpc-statd.service',
];

// ---- S7 T1b: subprocess implementation (ADR-0009 §Systemd promotion) ----
//
// Reads unit state via `systemctl show` per allow-listed unit —
// subprocess-based, CI-fakeable, refreshed by the collector's 30 s poll
// backstop. This is the ONLY systemd probe (the earlier dbus-shaped
// prototype + its dbus-native dependency were removed once the poll proved
// sufficient to keep the node healthy). `subscribeAllowListed` is a no-op.

import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';

type ShowExecFile = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
) => void;

export interface SystemctlUnitState {
  load_state: string;
  active_state: string;
  sub_state: string;
  unit_file_state?: string;
}

export interface SystemctlProbe {
  allowList: string[];
  getUnitState(name: string): Promise<SystemctlUnitState>;
  subscribeAllowListed(units: string[], onChanged: (unit: string) => void): { stop(): void };
}

/** S7 additions to the observation allow-list (ADR-0009): the xinas
 *  services themselves. xiRAID unit names are confirmed on hardware
 *  (runbook item) before being added. */
const S7_ALLOWLIST_ADDITIONS = ['xinas-api.service', 'xinas-agent.service'];

export function createSystemctlProbe(opts: { execFile?: ShowExecFile } = {}): SystemctlProbe {
  const ef: ShowExecFile = opts.execFile ?? (nodeExecFile as unknown as ShowExecFile);

  return {
    allowList: [...DEFAULT_ALLOWLIST, ...S7_ALLOWLIST_ADDITIONS],

    getUnitState(name: string): Promise<SystemctlUnitState> {
      return new Promise((resolve) => {
        ef(
          'systemctl',
          ['show', '-p', 'LoadState,ActiveState,SubState,UnitFileState', name],
          {},
          (err, stdout) => {
            if (err !== null) {
              // Absent/unloadable unit: degrade, never throw — the collector
              // keeps sweeping the rest of the allow-list.
              resolve({ load_state: 'not-found', active_state: 'unknown', sub_state: 'unknown' });
              return;
            }
            const kv = new Map<string, string>();
            for (const line of (stdout ?? '').split('\n')) {
              const eq = line.indexOf('=');
              if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim());
            }
            const unitFileState = kv.get('UnitFileState');
            resolve({
              load_state: kv.get('LoadState') ?? 'unknown',
              active_state: kv.get('ActiveState') ?? 'unknown',
              sub_state: kv.get('SubState') ?? 'unknown',
              ...(unitFileState !== undefined && unitFileState !== ''
                ? { unit_file_state: unitFileState }
                : {}),
            });
          },
        );
      });
    },

    subscribeAllowListed(): { stop(): void } {
      // dbus subscription deferred (ADR-0009) — the 30 s poll backstop is
      // the only refresh path for now.
      return { stop(): void {} };
    },
  };
}
