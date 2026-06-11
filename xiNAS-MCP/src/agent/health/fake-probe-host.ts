/**
 * File-backed fake ProbeHost (S7 T5) — fixture/e2e seam.
 *
 * State file `<dir>/probe-host-state.json`:
 *   { "fail_touch": ["/mnt/bad"], "fail_loopback": ["/mnt/bad"],
 *     "ops": ["touch:/mnt/a", "loopback:/mnt/a"] }
 * Mountpoints/exports listed in the fail arrays return ok:false (the
 * `-fail` hook pattern); every call is appended to `ops` so e2e can
 * assert the probes actually ran (and that loopback UNMOUNTED —
 * a `loopback-umount:` op follows every `loopback:` op).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProbeHost } from './probe-host.js';

interface ProbeHostState {
  fail_touch?: string[];
  fail_loopback?: string[];
  ops?: string[];
}

export function createFakeProbeHost(dir: string): ProbeHost {
  const statePath = join(dir, 'probe-host-state.json');

  const load = (): ProbeHostState =>
    existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as ProbeHostState)
      : {};

  const record = (op: string): ProbeHostState => {
    const state = load();
    state.ops = [...(state.ops ?? []), op];
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    return state;
  };

  return {
    async touchProbe(mountpoint: string): Promise<{ ok: boolean; error?: string }> {
      const state = record(`touch:${mountpoint}`);
      if ((state.fail_touch ?? []).includes(mountpoint)) {
        return { ok: false, error: `fake touch failure at ${mountpoint}` };
      }
      return { ok: true };
    },

    async loopbackMount(exportPath: string): Promise<{ ok: boolean; error?: string }> {
      const state = record(`loopback:${exportPath}`);
      try {
        if ((state.fail_loopback ?? []).includes(exportPath)) {
          return { ok: false, error: `fake loopback failure for ${exportPath}` };
        }
        return { ok: true };
      } finally {
        record(`loopback-umount:${exportPath}`);
      }
    },
  };
}
