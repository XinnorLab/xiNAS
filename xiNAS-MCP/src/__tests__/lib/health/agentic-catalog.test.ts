import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../api/mcp/catalog.js';
import {
  AGENTIC_CATALOG,
  type AgenticCatalog,
  type AgenticCheck,
  MCP_CHECK_IDS,
  type ValidationRefs,
  validateAgenticCatalog,
} from '../../../lib/health/agentic-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILES = resolve(here, '../../../../../healthcheck_profiles');

/** section → checks and the expectation keys, unioned over the shipped profiles. */
function shipped(): { baseline: Record<string, string[]>; expectationKeys: string[] } {
  const sections: Record<string, Set<string>> = {};
  const keys = new Set<string>();
  for (const f of readdirSync(PROFILES).filter((f) => f.endsWith('.yml'))) {
    const doc = yaml.load(readFileSync(join(PROFILES, f), 'utf8')) as {
      sections: Record<string, { checks?: string[] }>;
      expectations?: Record<string, unknown>;
    };
    for (const [section, v] of Object.entries(doc.sections)) {
      sections[section] ??= new Set();
      for (const c of v.checks ?? []) sections[section].add(c);
    }
    for (const k of Object.keys(doc.expectations ?? {})) keys.add(k);
  }
  return {
    baseline: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, [...v]])),
    expectationKeys: [...keys],
  };
}

const refs = (): ValidationRefs => ({
  mcpCheckIds: new Set(MCP_CHECK_IDS),
  tools: new Set(CATALOG.map((e) => e.name)),
  ...shipped(),
});

const clone = (): AgenticCatalog => structuredClone(AGENTIC_CATALOG);
const check = (cat: AgenticCatalog, id: string): AgenticCheck => {
  const c = cat.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no row ${id}`);
  return c;
};

/** S19b T6 — spec §10: the versioned check catalog, validated against its sources. */
describe('agentic check catalog', () => {
  it('is version 1, covers HC-01..HC-12 with unique ids, and validates against its sources', () => {
    expect(AGENTIC_CATALOG.version).toBe('1');
    expect(validateAgenticCatalog(AGENTIC_CATALOG, refs())).toEqual([]);
    const areas = [...new Set(AGENTIC_CATALOG.checks.map((c) => c.area))].sort();
    expect(areas).toEqual(
      Array.from({ length: 12 }, (_, i) => `HC-${String(i + 1).padStart(2, '0')}`),
    );
    const ids = AGENTIC_CATALOG.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of AGENTIC_CATALOG.checks) expect(c.version).toBe(1);
  });

  it('MCP_CHECK_IDS lists every deterministic check id the three profiles produce', () => {
    for (const id of [
      'agent.connectivity',
      'agent.collectors',
      'disk.health',
      'drift.netplan',
      'drift.nfs-conf',
      'drift.nfs-exports',
      'filesystem.io',
      'filesystem.mounts',
      'network.duplicate-netplan',
      'network.rdma-live',
      'network.rdma-readiness',
      'nfs.exports',
      'nfs.loopback',
      'nfs.server',
      'systemd.units',
      'tuning.sysctl',
      'xiraid.arrays',
      'xiraid.license',
      'xiraid.service',
    ]) {
      expect(MCP_CHECK_IDS, id).toContain(id);
    }
  });

  it('the honesty rows: HC-11 is no_source and mandatory only for service_path; HC-12 is the only active probe', () => {
    const client = check(AGENTIC_CATALOG, 'HC-11.client-path');
    expect(client.no_source).toBe(true);
    expect(client.inputs).toEqual([]);
    expect(client.mandatory_for).toEqual(['service_path']);
    const probes = AGENTIC_CATALOG.checks.filter((c) => c.side_effects === 'active_probe');
    expect(probes.map((c) => c.id)).toEqual(['HC-12.active-probe']);
    expect(probes[0]?.requires_policy).toBe('bounded_active');
    expect(check(AGENTIC_CATALOG, 'HC-04.disk-health-mcp').no_source).toBe(true);
    // every other row names at least one producer
    for (const c of AGENTIC_CATALOG.checks) {
      if (!c.no_source) expect(c.inputs.length, c.id).toBeGreaterThan(0);
    }
  });

  it.each([
    [
      'an mcp check id that no profile produces',
      (c: AgenticCatalog) =>
        check(c, 'HC-03.arrays').inputs.push({
          source: 'mcp:health.check',
          check_id: 'xiraid.nope',
          freshness: 'per_call',
        }),
      'xiraid.nope',
    ],
    [
      'a baseline check missing from every shipped profile',
      (c: AgenticCatalog) =>
        check(c, 'HC-03.arrays').inputs.push({
          source: 'baseline',
          section: 'storage',
          check: 'raid_magic',
          freshness: 'per_call',
        }),
      'raid_magic',
    ],
    [
      'a read of a tool that is not in the catalog',
      (c: AgenticCatalog) =>
        check(c, 'HC-03.arrays').inputs.push({
          source: 'read:arrays.magic',
          freshness: 'per_call',
        }),
      'arrays.magic',
    ],
    [
      'an expectations key the profiles do not define',
      (c: AgenticCatalog) => {
        check(c, 'HC-05.filesystems').criterion += ' and expectations.fs_magic';
      },
      'fs_magic',
    ],
    [
      'a no_source row that still lists an input',
      (c: AgenticCatalog) =>
        check(c, 'HC-11.client-path').inputs.push({
          source: 'read:shares.list',
          freshness: 'per_call',
        }),
      'HC-11.client-path',
    ],
    [
      'an outcome map that does not cover a source it consumes',
      (c: AgenticCatalog) => {
        delete check(c, 'HC-03.arrays').outcome_map['baseline:SKIP'];
      },
      'baseline:SKIP',
    ],
    [
      'a failing outcome without a severity',
      (c: AgenticCatalog) => {
        delete check(c, 'HC-03.arrays').severity_map['mcp:critical'];
      },
      'mcp:critical',
    ],
    [
      'a duplicate id',
      (c: AgenticCatalog) => {
        c.checks.push(structuredClone(check(c, 'HC-03.arrays')));
      },
      'duplicate',
    ],
    [
      'an active probe row without a probe input',
      (c: AgenticCatalog) => {
        check(c, 'HC-12.active-probe').inputs = [];
      },
      'HC-12.active-probe',
    ],
  ])('the validator rejects %s', (_label, mutate, needle) => {
    const broken = clone();
    mutate(broken);
    const problems = validateAgenticCatalog(broken, refs());
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(needle);
  });
});
