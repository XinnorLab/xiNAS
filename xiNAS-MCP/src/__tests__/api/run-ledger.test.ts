import { describe, expect, it } from 'vitest';
import { HEALTH_PROMPT_DEFAULTS } from '../../api/config.js';
import { RunLedger, type RunVersions, digestOf } from '../../api/health/run-ledger.js';

const VERSIONS: RunVersions = {
  prompt: '1.0.0',
  template_sha256: 'a'.repeat(64),
  policy: '1',
  catalog: '1',
  report_schema: '1',
  server: '1.0.0',
};

function ledger(over: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000_000;
  const l = new RunLedger({ now: () => now, ttlMs: over.ttlMs ?? 900_000, ...over });
  return { l, tick: (ms: number) => (now += ms), now: () => now };
}

const mint = (l: RunLedger, principal = 'op:alice') =>
  l.mint({
    principal,
    role: 'operator',
    versions: VERSIONS,
    limits: HEALTH_PROMPT_DEFAULTS.limits,
  });

/** S19b T5 — spec §6.3 (D-10): the in-memory run ledger. */
describe('RunLedger', () => {
  it('mints a uuid run with the TTL, the versions and the limits it started with', () => {
    const { l, now } = ledger();
    const run = mint(l);
    expect(run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.issued_at).toBe(now());
    expect(run.expires_at).toBe(now() + 900_000);
    expect(run).toMatchObject({
      principal: 'op:alice',
      role: 'operator',
      versions: VERSIONS,
      limits: HEALTH_PROMPT_DEFAULTS.limits,
      probes_started: 0,
      reports: [],
    });
    expect(l.get(run.run_id)?.run_id).toBe(run.run_id);
    expect(mint(l).run_id).not.toBe(run.run_id);
  });

  it('forgets a run at expires_at; sweep() reports how many it dropped', () => {
    const { l, tick } = ledger({ ttlMs: 1_000 });
    const a = mint(l);
    tick(999);
    expect(l.get(a.run_id)).not.toBeNull();
    tick(1);
    expect(l.get(a.run_id)).toBeNull();
    const b = mint(l);
    tick(500);
    expect(l.sweep()).toBe(0);
    tick(500);
    expect(l.sweep()).toBe(1);
    expect(l.get(b.run_id)).toBeNull();
    expect(l.size).toBe(0);
  });

  it('records report digests over the canonical JSON of args and result', () => {
    const { l } = ledger();
    const run = mint(l);
    expect(l.record('nope', 'health.check', {}, {}, '2026-09-09T10:00:00Z')).toBe(false);
    const result = { overall: 'ok', checks: [{ id: 'a', status: 'ok' }] };
    expect(
      l.record(run.run_id, 'health.check', { profile: 'quick' }, result, '2026-09-09T10:00:00Z'),
    ).toBe(true);
    expect(l.get(run.run_id)?.reports).toEqual([
      {
        tool: 'health.check',
        args_digest: digestOf({ profile: 'quick' }),
        report_digest: digestOf(result),
        collected_at: '2026-09-09T10:00:00Z',
      },
    ]);
    expect(digestOf({ b: 1, a: { d: 2, c: 3 } })).toBe(digestOf({ a: { c: 3, d: 2 }, b: 1 }));
    expect(digestOf(result)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf(result)).not.toBe(digestOf({ ...result, overall: 'degraded' }));
  });

  it('counts probes per run against a maximum; an unknown run is distinguishable', () => {
    const { l } = ledger();
    const run = mint(l);
    expect(l.startProbe(run.run_id, 2)).toBe('ok');
    expect(l.startProbe(run.run_id, 2)).toBe('ok');
    expect(l.startProbe(run.run_id, 2)).toBe('exhausted');
    expect(l.get(run.run_id)?.probes_started).toBe(2);
    expect(l.startProbe('nope', 2)).toBe('unknown');
    const zero = mint(l);
    expect(l.startProbe(zero.run_id, 0)).toBe('exhausted');
    expect(l.get(zero.run_id)?.probes_started).toBe(0);
  });

  it('F03: reads and writes are bound to the minting principal', () => {
    const { l } = ledger();
    const run = mint(l, 'op:alice');
    expect(l.get(run.run_id, 'op:bob')).toBeNull();
    expect(l.get(run.run_id, 'op:alice')).toBe(run);
    expect(
      l.record(
        run.run_id,
        'health.check',
        { profile: 'quick' },
        {},
        '2026-09-09T10:00:00Z',
        'op:bob',
      ),
    ).toBe(false);
    expect(l.startProbe(run.run_id, 4, 'op:bob')).toBe('unknown');
    expect(
      l.record(
        run.run_id,
        'health.check',
        { profile: 'quick' },
        {},
        '2026-09-09T10:00:00Z',
        'op:alice',
      ),
    ).toBe(true);
    expect(l.setDeclaredAbsent(run.run_id, ['raid'])).toBe(true);
    expect(run.declared_absent).toEqual(['raid']);
  });

  it('is bounded: past maxEntries the oldest live run is evicted, expired ones first', () => {
    const { l, tick } = ledger({ ttlMs: 10_000, maxEntries: 2 });
    const a = mint(l);
    tick(1);
    const b = mint(l);
    tick(1);
    const c = mint(l);
    expect(l.size).toBe(2);
    expect(l.get(a.run_id)).toBeNull();
    expect(l.get(b.run_id)).not.toBeNull();
    expect(l.get(c.run_id)).not.toBeNull();
    tick(10_000);
    const d = mint(l);
    expect(l.size).toBe(1);
    expect(l.get(d.run_id)).not.toBeNull();
  });
});
