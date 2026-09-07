import { describe, expect, it } from 'vitest';
import { DANGEROUS_FLAG_REQUIRED } from '../../../api/plan/blockers.js';
import { CATALOG } from '../../../api/mcp/catalog.js';
import {
  type FsCreateFacts,
  parseFsCreateSpec,
  validateFsCreate,
} from '../../../lib/fs/validate.js';

/**
 * A7: `dangerous_flag_required` is ONE constant across the api layer — the
 * two providers that emit it, the engine that enforces the real flag, the
 * MCP confirmation service and the three route files that filter it out of
 * their blocker re-check (ruling R-10.1) all import it.
 *
 * `lib/fs/validate.ts` is the one producer that cannot: `lib/` is pure and
 * imports nothing from `api/`, so adding the first `lib/ → api/` edge to
 * share a string would cost more than it buys. This file is the guard
 * `blockers.ts` names in its place — a rename on either side fails here
 * rather than silently splitting the code in two, which would make S15
 * gate 7 refuse every `force: true` MCP apply while every other test stayed
 * green.
 */
const FACTS: FsCreateFacts = {
  arraysByVolume: new Map([
    [
      '/dev/xi_data',
      { name: 'data', level: 'raid5', member_disk_ids: ['a', 'b', 'c', 'd'], strip_size_kib: 128 },
    ],
  ]),
  filesystems: [],
};

describe('DANGEROUS_FLAG_REQUIRED (A7)', () => {
  it('is exactly the literal the pure lib validator still emits', () => {
    const blockers = validateFsCreate(
      parseFsCreateSpec({
        backing_device: '/dev/xi_data',
        mountpoint: '/mnt/data',
        su_kb: 128,
        sw: 3,
        force: true,
      }),
      FACTS,
    );
    expect(blockers.map((b) => b.code)).toEqual([DANGEROUS_FLAG_REQUIRED]);
    expect(DANGEROUS_FLAG_REQUIRED).toBe('dangerous_flag_required');
  });

  it('is not a catalog operation kind or tool name (it is a blocker code)', () => {
    // Cheap sanity that the constant did not get re-pointed at some other
    // vocabulary during a refactor.
    expect(CATALOG.some((e) => e.name === DANGEROUS_FLAG_REQUIRED)).toBe(false);
    expect(CATALOG.some((e) => (e.operation_kinds ?? []).includes(DANGEROUS_FLAG_REQUIRED))).toBe(
      false,
    );
  });
});
