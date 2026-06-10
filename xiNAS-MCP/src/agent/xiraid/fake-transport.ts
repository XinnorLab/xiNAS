/**
 * File-backed fake XiraidTransport (S3 T5) — the agent's fixture-mode
 * stand-in for the xiRAID daemon, mirroring the probe fixture pattern
 * (XINAS_AGENT_PROBE_MODE=fixture:<dir>, convergence J3).
 *
 * State lives at <dir>/xiraid-state.json: { "arrays": [ ... ] }. Each
 * array entry mimics the raid_show per-array shape the parser consumes
 * (name, level, devices, state, strip_size, ...). Persisting to a file
 * lets the e2e suite seed state and lets separate transport instances
 * (collector + executor + test assertions) share one view.
 *
 * Deterministic failure hook: raidCreate REJECTS when the requested name
 * ends with '-fail' — the e2e failure→rollback path uses it. (Mirrors
 * the reference executor's spec.fail_at_stage escape hatch; no
 * randomness, per the no-Date.now/Math.random workflow rules.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RaidCreateRequest, RaidDestroyRequest } from '../../grpc/raid.js';
import type { XiraidTransport } from './client.js';

interface FakeArray {
  name: string;
  level: string;
  devices: string[];
  state: string[];
  [key: string]: unknown;
}

interface FakeState {
  arrays: FakeArray[];
}

function statePath(dir: string): string {
  return join(dir, 'xiraid-state.json');
}

function load(dir: string): FakeState {
  const path = statePath(dir);
  if (!existsSync(path)) return { arrays: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeState>;
  return { arrays: parsed.arrays ?? [] };
}

function save(dir: string, state: FakeState): void {
  mkdirSync(dirname(statePath(dir)), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

export function createFakeXiraidTransport(dir: string): XiraidTransport {
  return {
    async raidShow(): Promise<unknown> {
      return load(dir).arrays;
    },

    async raidCreate(req: RaidCreateRequest): Promise<void> {
      if (req.name.endsWith('-fail')) {
        throw new Error(`fake xiraid: forced create failure for '${req.name}'`);
      }
      const state = load(dir);
      if (state.arrays.some((a) => a.name === req.name)) {
        throw new Error(`fake xiraid: RAID '${req.name}' already exists`);
      }
      state.arrays.push({
        name: req.name,
        level: req.level,
        devices: [...req.drives],
        state: ['online'],
        ...(req.strip_size !== undefined ? { strip_size: req.strip_size } : {}),
        ...(req.block_size !== undefined ? { block_size: req.block_size } : {}),
        ...(req.group_size !== undefined ? { group_size: req.group_size } : {}),
      });
      save(dir, state);
    },

    async raidDestroy(req: RaidDestroyRequest): Promise<void> {
      const state = load(dir);
      state.arrays = state.arrays.filter((a) => a.name !== req.name);
      save(dir, state);
    },
  };
}
