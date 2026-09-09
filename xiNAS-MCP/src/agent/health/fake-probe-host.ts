/**
 * File-backed fake ProbeHost (S7 T5; S19a interface) — fixture/e2e seam.
 *
 * State file `<dir>/probe-host-state.json`:
 *   { "fail_touch": ["/mnt/bad"], "fail_loopback": ["/mnt/bad"],
 *     "ops": ["touch:/mnt/a", "loopback:/mnt/a"] }
 * Mountpoints/exports listed in the fail arrays return ok:false (the
 * `-fail` hook pattern); every call is appended to `ops` so e2e can
 * assert the probes actually ran (and that loopback UNMOUNTED —
 * a `loopback-umount:` op follows every `loopback:` op). The op strings
 * are unchanged from S7 on purpose: the e2e suite reads them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProbeOutcome, ProbeRunOptions } from '../../lib/health/probe-types.js';
import type { ProbeHost } from './probe-host.js';

interface ProbeHostState {
  fail_touch?: string[];
  fail_loopback?: string[];
  ops?: string[];
}

export function createFakeProbeHost(dir: string): ProbeHost {
  const statePath = join(dir, 'probe-host-state.json');

  const load = (): ProbeHostState =>
    existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as ProbeHostState) : {};

  const record = (op: string): ProbeHostState => {
    const state = load();
    state.ops = [...(state.ops ?? []), op];
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    return state;
  };

  const outcome = (
    ok: boolean,
    artifact: ProbeOutcome['artifact'],
    error?: ProbeOutcome['error'],
  ): ProbeOutcome => {
    const now = new Date().toISOString();
    return {
      ok,
      started_at: now,
      completed_at: now,
      artifact,
      ...(error !== undefined ? { error } : {}),
      cleanup: { status: 'clean' },
    };
  };

  return {
    async fsIo(mountpoint: string, opts: ProbeRunOptions): Promise<ProbeOutcome> {
      const state = record(`touch:${mountpoint}`);
      const artifact = {
        kind: 'file' as const,
        path: `${mountpoint}/.xinas-health/probe-${opts.runId ?? 'none'}-fake`,
      };
      if ((state.fail_touch ?? []).includes(mountpoint)) {
        return outcome(false, artifact, {
          code: 'FAKE_FAIL',
          message: `fake touch failure at ${mountpoint}`,
          stage: 'write',
        });
      }
      return outcome(true, artifact);
    },

    async nfsLoopback(exportPath: string, opts: ProbeRunOptions): Promise<ProbeOutcome> {
      const state = record(`loopback:${exportPath}`);
      const artifact = {
        kind: 'mountpoint' as const,
        path: `/run/xinas/health-probe/${opts.runId ?? 'none'}-fake/mnt`,
      };
      try {
        if ((state.fail_loopback ?? []).includes(exportPath)) {
          return outcome(false, artifact, {
            code: 'FAKE_FAIL',
            message: `fake loopback failure for ${exportPath}`,
            stage: 'mount',
          });
        }
        return outcome(true, artifact);
      } finally {
        record(`loopback-umount:${exportPath}`);
      }
    },
  };
}
