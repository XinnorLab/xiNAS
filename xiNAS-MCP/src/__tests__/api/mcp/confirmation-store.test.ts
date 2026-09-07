import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CreateConfirmationInput,
  ConfirmationStore,
} from '../../../api/mcp/confirmation/store.js';
import { runMigrations } from '../../../state/migrations.js';

function harness() {
  const db = new Database(':memory:');
  runMigrations(db);
  let clock = 1_000_000;
  let n = 0;
  const store = new ConfirmationStore({ db, now: () => clock, newId: () => `c-${(n += 1)}` });
  return {
    db,
    store,
    setClock: (v: number) => {
      clock = v;
    },
  };
}

const input: CreateConfirmationInput = {
  mode: 'form',
  principal: 'admin:demo',
  role: 'admin',
  tool_name: 'shares.update',
  operation_kind: 'share.update',
  arguments_hash: 'ah',
  plan_id: 'plan-1',
  plan_hash: 'ph',
  plan_document_hash: 'dh',
  idempotency_key: 'ik',
  expected_revision: 42,
  risk_level: 'changing_access',
  rollback_model: 'changing_access',
  request_state_nonce_hash: 'nh1',
  ttl_ms: 300_000,
  correlation_id: 'corr',
  request_id: 'req',
  node_id: 'node',
};

describe('ConfirmationStore (S15 §6)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('creates a pending round-1 record with expires_at = created_at + ttl', () => {
    const r = h.store.create(input);
    expect(r).toMatchObject({
      confirmation_id: 'c-1',
      status: 'pending',
      round: 1,
      created_at: 1_000_000,
      expires_at: 1_300_000,
    });
    expect(h.store.get('c-1')).toEqual(r);
    expect(h.store.get('nope')).toBeNull();
  });

  it('findOpenByBindings matches pending/approved rows with equal bindings only', () => {
    h.store.create(input);
    const key = {
      principal: 'admin:demo',
      tool_name: 'shares.update',
      arguments_hash: 'ah',
      plan_id: 'plan-1',
      idempotency_key: 'ik',
      expected_revision: 42,
    };
    expect(h.store.findOpenByBindings(key)?.confirmation_id).toBe('c-1');
    expect(h.store.findOpenByBindings({ ...key, expected_revision: 43 })).toBeNull();
    h.store.decline('c-1', 'op', 'bearer');
    expect(h.store.findOpenByBindings(key)).toBeNull();
  });

  it('findOpenByBindings also matches an approved record (F6)', () => {
    h.store.create(input);
    h.store.approve('c-1', 'admin:other', 'bearer', 'web');
    const key = {
      principal: 'admin:demo',
      tool_name: 'shares.update',
      arguments_hash: 'ah',
      plan_id: 'plan-1',
      idempotency_key: 'ik',
      expected_revision: 42,
    };
    expect(h.store.findOpenByBindings(key)?.confirmation_id).toBe('c-1');
  });

  it('reissue bumps the round and swaps the nonce hash; a 4th round is refused by the caller, not here', () => {
    h.store.create(input);
    const r2 = h.store.reissue('c-1', 'nh2');
    expect(r2).toMatchObject({ round: 2, request_state_nonce_hash: 'nh2' });
    h.store.expire('c-1', 'round_limit');
    expect(h.store.reissue('c-1', 'nh3')).toBeNull(); // terminal rows never move again
  });

  it('approve / decline / cancel / expire are guarded transitions and terminal rows are frozen', () => {
    h.store.create({ ...input, mode: 'url' });
    expect(h.store.approve('c-1', 'admin:other', 'bearer', 'web', 'ok')).toMatchObject({
      status: 'approved',
      approved_by: 'admin:other',
      approval_channel: 'bearer',
      approval_interface: 'web',
      decision_reason: 'ok',
      approved_at: 1_000_000,
    });
    expect(h.store.approve('c-1', 'x', 'bearer')).toBeNull(); // not pending any more
    expect(h.store.decline('c-1', 'admin:other', 'uds_break_glass')).toMatchObject({
      status: 'declined',
      approval_channel: 'bearer',
    }); // channel of the APPROVAL is kept; the decline's own channel is in the audit row
    expect(h.store.cancel('c-1', 'admin:demo')).toBeNull();
    expect(h.store.expire('c-1', 'ttl')).toBeNull();
    expect(h.store.approve('c-1', 'x', 'bearer')).toBeNull();
    expect(h.store.get('c-1')?.status).toBe('declined');
  });

  it('consume: form needs pending, url needs approved; both refuse an expired row; single use', () => {
    h.store.create(input); // c-1 form
    h.store.create({ ...input, mode: 'url', idempotency_key: 'ik2' }); // c-2 url
    expect(
      h.store.consume({
        confirmation_id: 'c-2',
        task_id: 't-1',
        from: 'approved',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(false);
    h.store.approve('c-2', 'admin:other', 'bearer', 'web');
    expect(
      h.store.consume({
        confirmation_id: 'c-2',
        task_id: 't-1',
        from: 'approved',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(true);
    expect(h.store.get('c-2')).toMatchObject({
      status: 'consumed',
      consumed_task_id: 't-1',
      consumed_at: 1_000_001,
      approved_by: 'admin:other',
    });
    expect(
      h.store.consume({
        confirmation_id: 'c-2',
        task_id: 't-2',
        from: 'approved',
        principal: 'admin:demo',
        now: 1_000_002,
      }),
    ).toBe(false);

    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-3',
        from: 'pending',
        principal: 'admin:demo',
        now: 1_300_000,
      }),
    ).toBe(false); // expired
    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-3',
        from: 'pending',
        principal: 'admin:demo',
        now: 1_299_999,
      }),
    ).toBe(true);
    expect(h.store.get('c-1')).toMatchObject({
      status: 'consumed',
      approved_by: 'admin:demo',
      approval_channel: 'mcp_form',
      approved_at: 1_299_999,
    });
  });

  it('consume binds mode to the from status: an approved url record only consumes via from=approved, an approved form record via neither (F3)', () => {
    h.store.create({ ...input, mode: 'url' }); // c-1, url
    h.store.approve('c-1', 'admin:other', 'bearer', 'web'); // approved
    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-1',
        from: 'pending',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(false);
    expect(h.store.get('c-1')?.status).toBe('approved');
    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-1',
        from: 'approved',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(true);

    // Mirror: a form record that reached 'approved' status must NOT consume via
    // from: 'approved' — mode = CASE 'approved' WHEN ... THEN 'url' does not match 'form'.
    h.store.create({ ...input, mode: 'form', idempotency_key: 'ik2' }); // c-2, form
    h.store.approve('c-2', 'admin:other', 'bearer', 'web'); // approved
    expect(
      h.store.consume({
        confirmation_id: 'c-2',
        task_id: 't-2',
        from: 'approved',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(false);
    expect(h.store.get('c-2')?.status).toBe('approved');
  });

  it('the consumed_task_id partial UNIQUE index trips when two confirmations share a task_id (F6)', () => {
    h.store.create(input); // c-1, ik
    h.store.create({ ...input, idempotency_key: 'ik2' }); // c-2, different bindings
    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-1',
        from: 'pending',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(true);
    let thrown: unknown;
    try {
      h.store.consume({
        confirmation_id: 'c-2',
        task_id: 't-1',
        from: 'pending',
        principal: 'admin:demo',
        now: 1_000_001,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });

  it('countOpen counts pending + approved, per principal and globally', () => {
    h.store.create(input);
    h.store.create({ ...input, idempotency_key: 'b', principal: 'admin:two' });
    h.store.create({ ...input, idempotency_key: 'c', mode: 'url' });
    h.store.approve('c-3', 'x', 'bearer');
    h.store.decline('c-2', 'x', 'bearer');
    expect(h.store.countOpen()).toBe(2);
    expect(h.store.countOpen('admin:demo')).toBe(2);
    expect(h.store.countOpen('admin:two')).toBe(0);
    // the scrape-time gauge source: pending + approved, per mode (review P2)
    expect(h.store.countPendingByMode()).toEqual({ form: 1, url: 1 });
  });

  it('a lapsed TTL is invisible to open reads even before the sweeper runs: expires_at === now is NOT open (F1, S15 §6.3)', () => {
    h.store.create(input); // c-1, created_at 1_000_000, ttl 300_000 -> expires_at 1_300_000
    const key = {
      principal: 'admin:demo',
      tool_name: 'shares.update',
      arguments_hash: 'ah',
      plan_id: 'plan-1',
      idempotency_key: 'ik',
      expected_revision: 42,
    };

    h.setClock(1_300_000); // the boundary: expires_at === now
    expect(h.store.findOpenByBindings(key)).toBeNull();
    expect(h.store.countOpen()).toBe(0);
    expect(h.store.countOpen('admin:demo')).toBe(0);
    expect(h.store.countPendingByMode()).toEqual({ form: 0, url: 0 });
    // get() and list() stay raw: the REST GET must still show the stored status
    // until the sweeper actually flips it, and consume() carries its own guard.
    expect(h.store.get('c-1')?.status).toBe('pending');

    h.setClock(1_299_999); // one tick earlier: still open
    expect(h.store.findOpenByBindings(key)?.confirmation_id).toBe('c-1');
    expect(h.store.countOpen()).toBe(1);
    expect(h.store.countOpen('admin:demo')).toBe(1);
    expect(h.store.countPendingByMode()).toEqual({ form: 1, url: 0 });
  });

  it('approve refuses an expired-but-not-yet-swept row: expires_at === now returns null (record stays pending, untouched by this guard — the sweep flips it), expires_at - 1 succeeds (F1, S15 §6.3)', () => {
    h.store.create({ ...input, mode: 'url' }); // c-1, created_at 1_000_000, expires_at 1_300_000
    h.setClock(1_300_000); // the boundary: expires_at === now
    expect(h.store.approve('c-1', 'admin:other', 'bearer')).toBeNull();
    expect(h.store.get('c-1')?.status).toBe('pending');

    h.setClock(1_299_999); // one tick earlier: still open
    expect(h.store.approve('c-1', 'admin:other', 'bearer')).toMatchObject({
      status: 'approved',
      approved_by: 'admin:other',
    });
  });

  it('sweepExpired expires only open rows past expires_at and reports them; prune deletes old terminals', () => {
    h.store.create(input);
    h.store.create({ ...input, idempotency_key: 'b' });
    h.store.decline('c-2', 'x', 'bearer');
    expect(h.store.sweepExpired(1_299_999, 'ttl')).toEqual([]);
    const swept = h.store.sweepExpired(1_300_000, 'restart_sweep');
    expect(swept.map((r) => r.confirmation_id)).toEqual(['c-1']);
    expect(h.store.get('c-1')).toMatchObject({
      status: 'expired',
      expired_reason: 'restart_sweep',
    });
    expect(h.store.pruneTerminal(1_000_001)).toBe(2);
    expect(h.store.list({})).toEqual([]);
  });

  it('pruneTerminal only deletes terminal rows; an open row past the cutoff survives (F6)', () => {
    h.store.create(input); // c-1, pending
    h.store.create({ ...input, idempotency_key: 'b' }); // c-2
    h.store.decline('c-2', 'x', 'bearer'); // c-2 -> terminal
    expect(h.store.pruneTerminal(2_000_000)).toBe(1);
    expect(h.store.get('c-1')?.status).toBe('pending');
    expect(h.store.get('c-2')).toBeNull();
  });

  it('pruneTerminal cutoff is strict: created_at === cutoff survives, created_at === cutoff - 1 is deleted (F6)', () => {
    h.store.create(input); // c-1, created_at 1_000_000
    h.store.decline('c-1', 'x', 'bearer');
    h.setClock(1_000_001);
    h.store.create({ ...input, idempotency_key: 'b' }); // c-2, created_at 1_000_001
    h.store.decline('c-2', 'x', 'bearer');

    expect(h.store.pruneTerminal(1_000_000)).toBe(0); // c-1.created_at === cutoff: NOT deleted
    expect(h.store.get('c-1')).not.toBeNull();

    expect(h.store.pruneTerminal(1_000_001)).toBe(1); // c-1.created_at === cutoff - 1: deleted
    expect(h.store.get('c-1')).toBeNull();
    expect(h.store.get('c-2')).not.toBeNull(); // c-2.created_at === cutoff: still survives
  });

  it('list filters by status/principal, newest first, honoring limit', () => {
    h.store.create(input);
    h.setClock(2_000_000);
    h.store.create({ ...input, idempotency_key: 'b' });
    expect(h.store.list({}).map((r) => r.confirmation_id)).toEqual(['c-2', 'c-1']);
    expect(h.store.list({ limit: 1 }).map((r) => r.confirmation_id)).toEqual(['c-2']);
    expect(h.store.list({ principal: 'nobody' })).toEqual([]);
    expect(h.store.list({ status: 'pending' })).toHaveLength(2);
  });

  it('M3: list uses one prepared statement per filter shape, not a fresh prepare per call', () => {
    h.store.create(input);
    // Four distinct shapes × repeated calls — the assertion is behavioural
    // (identical answers) plus the statement cache being bounded by shape.
    for (let i = 0; i < 5; i += 1) {
      expect(h.store.list({}).map((r) => r.confirmation_id)).toEqual(['c-1']);
      expect(h.store.list({ status: 'pending' }).map((r) => r.confirmation_id)).toEqual(['c-1']);
      expect(h.store.list({ principal: 'admin:demo' }).map((r) => r.confirmation_id)).toEqual([
        'c-1',
      ]);
      expect(
        h.store
          .list({ status: 'pending', principal: 'admin:demo', limit: 10 })
          .map((r) => r.confirmation_id),
      ).toEqual(['c-1']);
      expect(h.store.list({ status: 'declined' })).toEqual([]);
      expect(h.store.list({ principal: 'nobody' })).toEqual([]);
    }
    expect(h.store.listStatementShapes()).toBe(4);
  });

  // ── A6 (final review M1, M2): the two missing guarded-UPDATE clauses ──

  it('A6/M1: reissue refuses a row at or past its expiry (the sweeper may not have run yet)', () => {
    h.store.create(input); // expires_at = 1_300_000
    h.setClock(1_299_999);
    expect(h.store.reissue('c-1', 'nh2')?.round).toBe(2);
    h.setClock(1_300_000); // exactly at expiry — `expires_at > now` is false
    expect(h.store.reissue('c-1', 'nh3')).toBeNull();
    h.setClock(1_400_000);
    expect(h.store.reissue('c-1', 'nh4')).toBeNull();
    // …and the row was not touched by either refused attempt.
    const row = h.store.get('c-1');
    expect(row?.round).toBe(2);
    expect(row?.request_state_nonce_hash).toBe('nh2');
    expect(row?.status).toBe('pending');
  });

  it('A6/M2: consume refuses a different principal and leaves the row pending', () => {
    h.store.create(input);
    h.setClock(1_000_001);
    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-1',
        from: 'pending',
        principal: 'admin:someone-else',
        now: 1_000_001,
      }),
    ).toBe(false);
    const row = h.store.get('c-1');
    expect(row?.status).toBe('pending');
    expect(row?.consumed_task_id).toBeUndefined();
    expect(row?.consumed_at).toBeUndefined();
    expect(row?.approved_by).toBeUndefined();
    // The record's OWN principal still consumes it.
    expect(
      h.store.consume({
        confirmation_id: 'c-1',
        task_id: 't-1',
        from: 'pending',
        principal: 'admin:demo',
        now: 1_000_001,
      }),
    ).toBe(true);
    expect(h.store.get('c-1')?.status).toBe('consumed');
  });
});
