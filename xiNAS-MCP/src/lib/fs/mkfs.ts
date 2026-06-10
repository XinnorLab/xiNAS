/**
 * mkfs.xfs argv construction — day-1 raid_fs parity (S5, ADR-0007):
 *
 *   mkfs.xfs -f -L <label> -d su=<su>k,sw=<sw>
 *            [-l logdev=<log_device>,size=<effective_log_size>]
 *            -s size=<sector> <device>
 *
 * `-f` is always passed (day-1 behavior — leftover signatures on a
 * "clean" device must not abort); the SAFETY gate against overwriting a
 * real filesystem is the executor's blkid preflight + the engine's
 * dangerous flag, not the absence of -f.
 *
 * Pure. No I/O.
 */

export interface ResolvedMkfsInputs {
  device: string;
  label: string;
  su_kb: number;
  sw: number;
  sector_size: number;
  log_device?: string;
  /** Bytes — ALREADY clamped by the caller (executor: min(requested, blockdevSize)). */
  log_size_bytes?: number;
}

/** `1G`/`512M`/`1073741824` → bytes (binary units, the Ansible convention). */
export function humanToBytes(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)I?B?$/i.exec(size.trim());
  if (!m) throw new Error(`unparsable size '${size}'`);
  const value = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  const exp = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit];
  if (exp === undefined) throw new Error(`unparsable size unit '${size}'`);
  return Math.floor(value * 1024 ** exp);
}

export function buildMkfsArgs(inputs: ResolvedMkfsInputs): string[] {
  return [
    '-f',
    '-L',
    inputs.label,
    '-d',
    `su=${inputs.su_kb}k,sw=${inputs.sw}`,
    ...(inputs.log_device !== undefined
      ? [
          '-l',
          `logdev=${inputs.log_device}${
            inputs.log_size_bytes !== undefined ? `,size=${inputs.log_size_bytes}` : ''
          }`,
        ]
      : []),
    '-s',
    `size=${inputs.sector_size}`,
    inputs.device,
  ];
}
