/**
 * File-backed fake XiraidTransport (S3 T5, extended S4 T2) — the agent's
 * fixture-mode stand-in for the xiRAID daemon, mirroring the probe fixture
 * pattern (XINAS_AGENT_PROBE_MODE=fixture:<dir>, convergence J3).
 *
 * State lives at <dir>/xiraid-state.json:
 *   { arrays: [...], pools: [{name, drives, active}],
 *     import_candidates: [{uuid, name, level, devices, recoverable}],
 *     tombstones: [{name, data_wiped}] }
 * Array entries mimic the raid_show per-array shape the parser consumes
 * (name, level, devices, state, sparepool?, tuning echoes, ...). The file
 * lets the e2e seed state and lets separate transport instances
 * (collector + executor + test assertions) share one view.
 *
 * Deterministic failure hooks (no randomness, per the workflow rules):
 *  - any mutating verb against a name ending '-fail' REJECTS (the S3
 *    roll-fail pattern, extended to every S4 verb);
 *  - a raidModify carrying TUNING keys (any field beyond name/sparepool)
 *    against a name ending '-fail-tuning' REJECTS — this targets the
 *    modify executor's apply_tuning stage specifically while pool ops on
 *    `xnsp_<name>` still succeed (a plain '-fail' name would trip the
 *    pool ops first).
 *  - deleting an ACTIVE pool rejects (forces the deactivate-first order,
 *    analyst doc §3.8).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RaidCreateRequest, RaidDestroyRequest, RaidModifyRequest } from '../../grpc/raid.js';
import type { XiraidTransport } from './client.js';

interface FakeArray {
  name: string;
  level: string;
  devices: string[];
  state: string[];
  sparepool?: string;
  [key: string]: unknown;
}

interface FakePool {
  name: string;
  drives: string[];
  active: boolean;
}

export interface FakeImportCandidate {
  uuid: string;
  name: string;
  level: string;
  devices: string[];
  recoverable: boolean;
}

interface FakeTombstone {
  name: string;
  data_wiped: boolean;
}

interface FakeState {
  arrays: FakeArray[];
  pools: FakePool[];
  import_candidates: FakeImportCandidate[];
  tombstones: FakeTombstone[];
}

/** Test-support accessors the fake exposes beyond the transport contract. */
export interface FakeXiraidHandle {
  seedImportCandidates(candidates: FakeImportCandidate[]): void;
  tombstones(): FakeTombstone[];
}

function statePath(dir: string): string {
  return join(dir, 'xiraid-state.json');
}

function load(dir: string): FakeState {
  const path = statePath(dir);
  if (!existsSync(path)) {
    return { arrays: [], pools: [], import_candidates: [], tombstones: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeState>;
  return {
    arrays: parsed.arrays ?? [],
    pools: parsed.pools ?? [],
    import_candidates: parsed.import_candidates ?? [],
    tombstones: parsed.tombstones ?? [],
  };
}

function save(dir: string, state: FakeState): void {
  mkdirSync(dirname(statePath(dir)), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function failHook(name: string): void {
  if (name.endsWith('-fail')) {
    throw new Error(`fake xiraid: forced failure for '${name}'`);
  }
}

/**
 * Test-support: a transport whose every verb throws. Partial test fakes
 * spread this and override only the verbs they exercise, so widening the
 * XiraidTransport interface never silently no-ops a test.
 */
export function makeUnimplementedTransport(): XiraidTransport {
  const unused = (verb: string) => async (): Promise<never> => {
    throw new Error(`unimplemented test transport verb: ${verb}`);
  };
  return {
    raidShow: unused('raidShow'),
    raidCreate: unused('raidCreate'),
    raidDestroy: unused('raidDestroy'),
    raidModify: unused('raidModify'),
    poolCreate: unused('poolCreate'),
    poolDelete: unused('poolDelete'),
    poolAdd: unused('poolAdd'),
    poolRemove: unused('poolRemove'),
    poolActivate: unused('poolActivate'),
    poolDeactivate: unused('poolDeactivate'),
    poolShow: unused('poolShow'),
    raidImportShow: unused('raidImportShow'),
    raidImportApply: unused('raidImportApply'),
  };
}

export function createFakeXiraidTransport(dir: string): XiraidTransport & FakeXiraidHandle {
  return {
    // ---- test-support handle ----
    seedImportCandidates(candidates: FakeImportCandidate[]): void {
      const state = load(dir);
      state.import_candidates = [...candidates];
      save(dir, state);
    },
    tombstones(): FakeTombstone[] {
      return load(dir).tombstones;
    },

    // ---- raid ----
    async raidShow(): Promise<unknown> {
      return load(dir).arrays;
    },

    async raidCreate(req: RaidCreateRequest): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      if (state.arrays.some((a) => a.name === req.name)) {
        throw new Error(`fake xiraid: RAID '${req.name}' already exists`);
      }
      state.arrays.push({
        name: req.name,
        level: req.level,
        devices: [...req.drives],
        state: ['online'],
        ...(req.sparepool !== undefined ? { sparepool: req.sparepool } : {}),
        ...(req.strip_size !== undefined ? { strip_size: req.strip_size } : {}),
        ...(req.block_size !== undefined ? { block_size: req.block_size } : {}),
        ...(req.group_size !== undefined ? { group_size: req.group_size } : {}),
      });
      save(dir, state);
    },

    async raidDestroy(req: RaidDestroyRequest): Promise<void> {
      failHook(req.name ?? '');
      const state = load(dir);
      const existed = state.arrays.some((a) => a.name === req.name);
      state.arrays = state.arrays.filter((a) => a.name !== req.name);
      if (existed) {
        state.tombstones.push({ name: req.name ?? '', data_wiped: req.config_only !== true });
      }
      save(dir, state);
    },

    async raidModify(req: RaidModifyRequest): Promise<void> {
      failHook(req.name);
      const { name, ...rest } = req;
      const tuningKeys = Object.keys(rest).filter((k) => k !== 'sparepool');
      if (name.endsWith('-fail-tuning') && tuningKeys.length > 0) {
        throw new Error(`fake xiraid: forced tuning-modify failure for '${name}'`);
      }
      const state = load(dir);
      const arr = state.arrays.find((a) => a.name === name);
      if (!arr) throw new Error(`fake xiraid: no RAID named '${name}'`);
      Object.assign(arr, rest);
      save(dir, state);
    },

    // ---- pools ----
    async poolCreate(req: { name: string; drives: string[] }): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      if (state.pools.some((p) => p.name === req.name)) {
        throw new Error(`fake xiraid: pool '${req.name}' already exists`);
      }
      state.pools.push({ name: req.name, drives: [...req.drives], active: false });
      save(dir, state);
    },

    async poolDelete(req: { name: string }): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      const pool = state.pools.find((p) => p.name === req.name);
      if (!pool) throw new Error(`fake xiraid: no pool named '${req.name}'`);
      if (pool.active) {
        throw new Error(`fake xiraid: pool '${req.name}' is active — deactivate first`);
      }
      state.pools = state.pools.filter((p) => p.name !== req.name);
      save(dir, state);
    },

    async poolAdd(req: { name: string; drives: string[] }): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      const pool = state.pools.find((p) => p.name === req.name);
      if (!pool) throw new Error(`fake xiraid: no pool named '${req.name}'`);
      pool.drives = [...new Set([...pool.drives, ...req.drives])];
      save(dir, state);
    },

    async poolRemove(req: { name: string; drives: string[] }): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      const pool = state.pools.find((p) => p.name === req.name);
      if (!pool) throw new Error(`fake xiraid: no pool named '${req.name}'`);
      pool.drives = pool.drives.filter((d) => !req.drives.includes(d));
      save(dir, state);
    },

    async poolActivate(req: { name: string }): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      const pool = state.pools.find((p) => p.name === req.name);
      if (!pool) throw new Error(`fake xiraid: no pool named '${req.name}'`);
      pool.active = true;
      save(dir, state);
    },

    async poolDeactivate(req: { name: string }): Promise<void> {
      failHook(req.name);
      const state = load(dir);
      const pool = state.pools.find((p) => p.name === req.name);
      if (!pool) throw new Error(`fake xiraid: no pool named '${req.name}'`);
      pool.active = false;
      save(dir, state);
    },

    async poolShow(): Promise<unknown> {
      return load(dir).pools;
    },

    // ---- import ----
    async raidImportShow(): Promise<unknown> {
      return load(dir).import_candidates;
    },

    async raidImportApply(req: { uuid: string; new_name?: string }): Promise<void> {
      const state = load(dir);
      const idx = state.import_candidates.findIndex((c) => c.uuid === req.uuid);
      if (idx < 0) throw new Error(`fake xiraid: no importable RAID with uuid '${req.uuid}'`);
      const candidate = state.import_candidates[idx] as FakeImportCandidate;
      const name = req.new_name ?? candidate.name;
      failHook(name);
      if (state.arrays.some((a) => a.name === name)) {
        throw new Error(`fake xiraid: RAID '${name}' already exists`);
      }
      state.import_candidates.splice(idx, 1);
      state.arrays.push({
        name,
        level: candidate.level,
        devices: [...candidate.devices],
        state: ['online'],
      });
      save(dir, state);
    },
  };
}
