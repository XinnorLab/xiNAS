/**
 * ProbeHost (S7 T5, ADR-0009 §deep): the privileged verbs behind the
 * deep health probes.
 *
 *  - touchProbe: write/read/delete `.xinas-health-probe` in a
 *    mountpoint — proves the filesystem accepts I/O end to end.
 *  - loopbackMount: PID1-DELEGATED `systemd-mount localhost:<export>`
 *    at /run/xinas/health-probe/mnt (the S5 pattern — the agent holds
 *    no CAP_SYS_ADMIN; PID1 performs the mount), list the root, then
 *    `systemd-umount`. The unmount runs in `finally` so a listing
 *    failure never leaks a mount.
 *
 * Both verbs return rich errors instead of throwing — a failed probe
 * is a RESULT (the check goes critical), not an RPC failure.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOOPBACK_MOUNTPOINT = '/run/xinas/health-probe/mnt';
const PROBE_FILENAME = '.xinas-health-probe';
const PROBE_PAYLOAD = 'xinas-health-probe\n';

export interface ProbeHost {
  /** Write/read-back/delete the probe file in `mountpoint`. */
  touchProbe(mountpoint: string): Promise<{ ok: boolean; error?: string }>;
  /** Loopback-mount `exportPath`, list it, unmount. */
  loopbackMount(exportPath: string): Promise<{ ok: boolean; error?: string }>;
}

function run(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err !== null) {
        reject(new Error(`${file} ${args.join(' ')} failed: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });
}

export function createRealProbeHost(): ProbeHost {
  return {
    async touchProbe(mountpoint: string): Promise<{ ok: boolean; error?: string }> {
      const path = join(mountpoint, PROBE_FILENAME);
      try {
        await writeFile(path, PROBE_PAYLOAD, 'utf8');
        const back = await readFile(path, 'utf8');
        if (back !== PROBE_PAYLOAD) {
          return { ok: false, error: 'read-back mismatch' };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        try {
          await unlink(path);
        } catch {
          /* nothing to clean (write failed) or already gone */
        }
      }
    },

    async loopbackMount(exportPath: string): Promise<{ ok: boolean; error?: string }> {
      try {
        await mkdir(LOOPBACK_MOUNTPOINT, { recursive: true });
        // PID1 performs the mount; --collect makes the transient unit
        // garbage-collect on failure instead of lingering.
        await run(
          'systemd-mount',
          ['--collect', `localhost:${exportPath}`, LOOPBACK_MOUNTPOINT],
          20_000,
        );
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      try {
        await readdir(LOOPBACK_MOUNTPOINT);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        try {
          await run('systemd-umount', [LOOPBACK_MOUNTPOINT], 20_000);
        } catch {
          /* surfaced via journals; the transient unit is --collect'ed */
        }
      }
    },
  };
}
