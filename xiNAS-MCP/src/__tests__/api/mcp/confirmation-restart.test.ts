import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../../../api/server.js';
import { ACK_DATA_LOSS } from '../../../api/mcp/confirmation/types.js';
import { type MockAgentServer, seedShare, startMockAgentServer } from '../_helpers.js';
import {
  BOTH,
  auditRows,
  call,
  nextId,
  payloadOf,
  planFsCreateForce,
  planShareUpdate,
  restCall,
  rpcErrorOf,
  toolResultOf,
} from './_mrtr-helpers.js';

/**
 * S15 Task 14 — the confirmation expiry sweep (startup + timer) and GC
 * prune, verified end to end across a real `startServer()` restart: a
 * record's TTL used to be enforced only lazily (on the client's own
 * retry) — Task 14 adds a `restart_sweep` before the startup `reconcile()`
 * and a 30 s-cadence `unref()`ed timer (S15 §6.3–6.5).
 *
 * Reuses the `rpc`/`call`/`planShareUpdate`-style wire helpers from
 * `mcp-confirmation.test.ts` — extracted into `./_mrtr-helpers.ts` for this
 * suite — driving the SAME modern `tools/call` format against TWO
 * successive `startServer()` boots over the SAME `databasePath` (a real
 * api restart, not a mock). Each test owns its own tmp dir / mock agent /
 * config — a restart lifecycle does not compose across tests the way the
 * shared-server describe block in mcp-confirmation.test.ts does.
 *
 * Deviations from the task brief (task-14-brief.md), discovered by running
 * these tests against the landed `ConfirmationService`/`store.ts` (the
 * tree has moved since the brief was written — see the task's own
 * "Context the brief cannot know"):
 *
 *  - Case 3's "changed key" sub-case: `retry()`'s binding cross-check
 *    (`verifyRetryState`, service.ts) compares the retry's
 *    `idempotency_key` against BOTH the signed `requestState` payload AND
 *    the stored record BEFORE it ever looks at `record.status` — so a
 *    changed `idempotency_key` is a `-32602` binding mismatch whether the
 *    record is pending (already covered by mcp-confirmation.test.ts case
 *    6) or, as here, already consumed. `CONFIRMATION_ALREADY_CONSUMED`
 *    (service.ts `terminalError`, case 'consumed') is reachable only from
 *    `retry()`'s pending/approved branch when a second writer consumes the
 *    record between `verifyRetryState`'s read and a `reissue`/`decline` —
 *    a genuine race, not a sequential "changed key" retry — so this suite
 *    asserts the actually-reachable `-32602`.
 *  - Case 4 (S15 fix round 1, F1): the ORIGINAL version of this case forced
 *    an overdue row by `UPDATE mcp_confirmations SET expires_at = now - 1`
 *    directly on the closed db — but `requestState` embeds the record's
 *    `expires_at` verbatim at mint time (`elicitation()`, `exp:
 *    record.expires_at`), and `retry()` requires `payload.exp ===
 *    record.expires_at` before it ever reads `record.status`. Tampering the
 *    row made the OLD requestState's embedded `exp` stop matching it, so
 *    the retry was refused at the binding-mismatch gate (`-32602`) before
 *    it could ever reach the status-based `CONFIRMATION_EXPIRED` branch —
 *    a real path, but not the one the case's own name promised. The case
 *    below instead advances a FAKED `Date` (`vi.useFakeTimers({ toFake:
 *    ['Date'] })` — timers/sockets/supertest stay real) past the
 *    naturally-computed TTL between the two boots and never touches the
 *    row: `requestState` still binds cleanly, so `retry()` reaches
 *    `record.status === 'expired'` and answers the tool error
 *    `CONFIRMATION_EXPIRED`. The original tamper-based repro is kept right
 *    after it, renamed to what it actually proves: a directly corrupted
 *    `expires_at` is refused as a binding mismatch, not treated as an
 *    expiry — a real scenario (a bad migration, a manual DB edit), just
 *    not the TTL-sweep one.
 */

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000d1';

interface Boot {
  dir: string;
  configPath: string;
  agentSock: string;
  mockAgent: MockAgentServer;
}

/** Fresh tmp dir + config file + mock agent UDS. The config is written ONCE
 *  and reused verbatim across both `startServer()` calls in a test — a
 *  real restart never rewrites its own config file. */
async function setupBoot(prefix: string): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const agentSock = join(dir, 'a.sock');
  const mockAgent = await startMockAgentServer(agentSock);
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      controller_id: CONTROLLER_ID,
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      tokens: {
        'tok-admin': { principal: 'admin:test', role: 'admin' },
        'tok-admin2': { principal: 'admin:two', role: 'admin' },
      },
      state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
      agent: { socket: agentSock },
      mcp: {
        allow_apply: true,
        confirmation: {
          approval_url_base: 'http://127.0.0.1:1',
          url_wait_seconds: 1,
          ttl_seconds: 60,
          max_pending_per_principal: 50,
          max_pending_total: 1000,
          create_rate_per_minute: 600,
        },
      },
    }),
  );
  return { dir, configPath, agentSock, mockAgent };
}

async function teardownBoot(boot: Boot): Promise<void> {
  await boot.mockAgent.close();
  rmSync(boot.dir, { recursive: true, force: true });
}

describe('MCP MRTR confirmation expiry sweep — restart recovery (S15 Task 14)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn !== undefined) await fn();
    }
  });

  it('a pending form confirmation survives restart and is consumable', async () => {
    const boot = await setupBoot('xinas-mcp-restart-1-');
    cleanups.push(() => teardownBoot(boot));

    let handle = await startServer({ configPath: boot.configPath });
    let port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-a');

    const { plan_id, expected_revision } = await planShareUpdate(port, 'tok-admin');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: nextId('ik'),
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const r1 = toolResultOf(first);
    expect(r1.resultType).toBe('input_required');
    const requestState = r1.requestState;
    expect(
      (
        handle.state.db
          .prepare('SELECT status FROM mcp_confirmations WHERE plan_id = ?')
          .get(plan_id) as {
          status: string;
        }
      ).status,
    ).toBe('pending');

    await handle.close();

    handle = await startServer({ configPath: boot.configPath });
    port = (handle.address as AddressInfo).port;

    const record = handle.state.db
      .prepare('SELECT status FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { status: string } | undefined;
    expect(record?.status).toBe('pending'); // untouched — not overdue at restart

    const second = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    });
    const r2 = toolResultOf(second);
    expect(r2.resultType).toBe('complete');
    const taskId = (payloadOf(second).result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');

    const consumed = handle.state.db
      .prepare('SELECT status, consumed_task_id FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { status: string; consumed_task_id: string };
    expect(consumed.status).toBe('consumed');
    expect(consumed.consumed_task_id).toBe(taskId);

    await handle.close();
  });

  it('an approved URL confirmation survives restart and is consumable until expiry', async () => {
    const boot = await setupBoot('xinas-mcp-restart-2-');
    cleanups.push(() => teardownBoot(boot));

    let handle = await startServer({ configPath: boot.configPath });
    let port = (handle.address as AddressInfo).port;
    handle.state.kv.put('/xinas/v1/observed/XiraidArray/data', {
      kind: 'XiraidArray',
      id: 'data',
      spec: {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        strip_size_kib: 128,
      },
      status: {
        state: 'optimal',
        volume_path: '/dev/xi_data',
        observed_at: '2026-06-10T12:00:00Z',
      },
    });

    const { plan_id, expected_revision } = await planFsCreateForce(
      port,
      'tok-admin',
      '/mnt/restart-url',
    );
    const idem = nextId('ik');
    const args = {
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
      dangerous: true,
    };

    const first = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      {},
      BOTH,
    );
    const r1 = toolResultOf(first);
    expect(r1.resultType).toBe('input_required');
    expect(r1.inputRequests?.confirm_apply?.params.mode).toBe('url');
    const requestState = r1.requestState;

    const record = handle.state.db
      .prepare('SELECT confirmation_id FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { confirmation_id: string };

    const approveRes = await restCall(
      port,
      'tok-admin2',
      'POST',
      `/mcp/confirmations/${record.confirmation_id}/approve`,
      { acknowledge: ACK_DATA_LOSS },
    );
    expect(approveRes.status).toBe(200);
    expect((approveRes.body.result as { status: string }).status).toBe('approved');

    await handle.close();

    handle = await startServer({ configPath: boot.configPath });
    port = (handle.address as AddressInfo).port;

    const stillApproved = handle.state.db
      .prepare('SELECT status FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { status: string };
    expect(stillApproved.status).toBe('approved'); // untouched — not overdue at restart

    const retried = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      { requestState, inputResponses: { confirm_apply: { action: 'accept' } } },
      BOTH,
    );
    const r2 = toolResultOf(retried);
    expect(r2.resultType).toBe('complete');
    const taskId = (payloadOf(retried).result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');

    const consumed = handle.state.db
      .prepare('SELECT status, consumed_task_id FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { status: string; consumed_task_id: string };
    expect(consumed.status).toBe('consumed');
    expect(consumed.consumed_task_id).toBe(taskId);

    await handle.close();
  }, 10_000);

  it('a consumed confirmation stays consumed across restart: identical retry replays the same task; a changed idempotency_key is refused as a binding mismatch', async () => {
    const boot = await setupBoot('xinas-mcp-restart-3-');
    cleanups.push(() => teardownBoot(boot));

    let handle = await startServer({ configPath: boot.configPath });
    let port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-a');

    const { plan_id, expected_revision } = await planShareUpdate(port, 'tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };

    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState;
    const accept = {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    };
    const applied = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, accept);
    const taskId = (payloadOf(applied).result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');

    const taskCountBefore = (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(plan_id) as {
        n: number;
      }
    ).n;
    expect(taskCountBefore).toBe(1);

    await handle.close();

    handle = await startServer({ configPath: boot.configPath });
    port = (handle.address as AddressInfo).port;

    const stillConsumed = handle.state.db
      .prepare('SELECT status, consumed_task_id FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { status: string; consumed_task_id: string };
    expect(stillConsumed.status).toBe('consumed');
    expect(stillConsumed.consumed_task_id).toBe(taskId);

    // Identical retry: same args (including idempotency_key), same requestState.
    const replay = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, accept);
    const replayed = toolResultOf(replay);
    expect(replayed.resultType).toBe('complete');
    const replayTaskId = (payloadOf(replay).result as { task_id?: string })?.task_id;
    expect(replayTaskId).toBe(taskId);
    const taskCountAfterReplay = (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(plan_id) as {
        n: number;
      }
    ).n;
    expect(taskCountAfterReplay).toBe(1); // no second task

    // Changed idempotency_key on the retry (same requestState): a binding
    // mismatch — see the file header for why this is NOT
    // CONFIRMATION_ALREADY_CONSUMED.
    const changedKeyArgs = { ...args, idempotency_key: nextId('other-ik') };
    const changedKey = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      changedKeyArgs,
      accept,
    );
    expect(rpcErrorOf(changedKey)?.code).toBe(-32602);
    const unaffected = handle.state.db
      .prepare('SELECT status, consumed_task_id FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { status: string; consumed_task_id: string };
    expect(unaffected.status).toBe('consumed');
    expect(unaffected.consumed_task_id).toBe(taskId);

    await handle.close();
  });

  it('restart past a naturally-elapsed TTL expires the record with reason restart_sweep, audits it, and the retry gets CONFIRMATION_EXPIRED', async () => {
    const boot = await setupBoot('xinas-mcp-restart-4-');
    cleanups.push(() => teardownBoot(boot));

    // Matches setupBoot's mcp.confirmation.ttl_seconds: 60.
    const ttlMs = 60_000;

    // Date only — timers, sockets, and supertest stay real; nothing here
    // relies on setInterval/setTimeout firing on a mocked clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let handle = await startServer({ configPath: boot.configPath });
      const port = (handle.address as AddressInfo).port;
      seedShare(handle.state, 'share-a');

      const { plan_id, expected_revision } = await planShareUpdate(port, 'tok-admin');
      const idem = nextId('ik');
      const args = {
        id: 'share-a',
        mode: 'apply',
        plan_id,
        expected_revision,
        idempotency_key: idem,
      };

      const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
      const r1 = toolResultOf(first);
      expect(r1.resultType).toBe('input_required');
      const requestState = r1.requestState;

      const before = handle.state.db
        .prepare(
          'SELECT confirmation_id, status, expires_at FROM mcp_confirmations WHERE plan_id = ?',
        )
        .get(plan_id) as { confirmation_id: string; status: string; expires_at: number };
      expect(before.status).toBe('pending');

      await handle.close();

      // Advance the FAKE clock past the record's real TTL. The row itself
      // is never touched — only Date.now() moves — so requestState's
      // embedded `exp` still matches record.expires_at on the retry below.
      vi.setSystemTime(Date.now() + ttlMs + 1_000);

      handle = await startServer({ configPath: boot.configPath });
      const port2 = (handle.address as AddressInfo).port;

      const swept = handle.state.db
        .prepare(
          'SELECT status, expired_reason, expires_at FROM mcp_confirmations WHERE confirmation_id = ?',
        )
        .get(before.confirmation_id) as {
        status: string;
        expired_reason: string;
        expires_at: number;
      };
      expect(swept.status).toBe('expired');
      expect(swept.expired_reason).toBe('restart_sweep');
      expect(swept.expires_at).toBe(before.expires_at); // row untouched — only the clock moved

      await handle.state.drainer.drainNow();
      const rows = auditRows(boot.dir);
      const expiredRow = rows.find(
        (r) =>
          r.kind === 'mcp.confirmation.expired' &&
          r.payload?.confirmation_id === before.confirmation_id,
      );
      expect(expiredRow).toBeDefined();
      expect(expiredRow?.payload?.reason).toBe('restart_sweep');

      // The retry: SAME requestState, row untouched — the binding
      // cross-check passes, so retry() reaches record.status === 'expired'
      // and answers the TOOL error (not a JSON-RPC error).
      const retried = await call(port2, 'tok-admin', nextId('call'), 'shares.update', args, {
        requestState,
        inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
      });
      expect(toolResultOf(retried).isError).toBe(true);
      const payload = payloadOf(retried);
      expect(payload.error?.code).toBe('CONFIRMATION_EXPIRED');
      expect(
        (payload.error?.details as { expired_reason?: string } | undefined)?.expired_reason,
      ).toBe('restart_sweep');
      const taskCount = (
        handle.state.db
          .prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?')
          .get(plan_id) as { n: number }
      ).n;
      expect(taskCount).toBe(0);

      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a directly corrupted expires_at survives restart as a binding mismatch, not CONFIRMATION_EXPIRED', async () => {
    const boot = await setupBoot('xinas-mcp-restart-4b-');
    cleanups.push(() => teardownBoot(boot));

    let handle = await startServer({ configPath: boot.configPath });
    const port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-a');

    const { plan_id, expected_revision } = await planShareUpdate(port, 'tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };

    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const r1 = toolResultOf(first);
    expect(r1.resultType).toBe('input_required');
    const requestState = r1.requestState;

    const before = handle.state.db
      .prepare('SELECT confirmation_id, status FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { confirmation_id: string; status: string };
    expect(before.status).toBe('pending');

    await handle.close();

    // Directly corrupt expires_at on the closed db file via a fresh
    // better-sqlite3 handle (e.g. simulating a bad migration or a manual
    // DB edit) — a DIFFERENT scenario from a naturally-elapsed TTL: this
    // also desynchronizes the OLD requestState's embedded `exp` from the
    // row, so the retry is refused as a binding mismatch, not routed
    // through the status-based expiry path. See the file header.
    const raw = new Database(join(boot.dir, 'x.db'));
    raw
      .prepare('UPDATE mcp_confirmations SET expires_at = ? WHERE confirmation_id = ?')
      .run(Date.now() - 1, before.confirmation_id);
    raw.close();

    handle = await startServer({ configPath: boot.configPath });
    const port2 = (handle.address as AddressInfo).port;

    const swept = handle.state.db
      .prepare('SELECT status, expired_reason FROM mcp_confirmations WHERE confirmation_id = ?')
      .get(before.confirmation_id) as { status: string; expired_reason: string };
    expect(swept.status).toBe('expired');
    expect(swept.expired_reason).toBe('restart_sweep');

    // The retry: the OLD requestState's embedded `exp` was minted against
    // the ORIGINAL expires_at, which the tamper above just changed — so
    // retry()'s binding cross-check (payload.exp !== record.expires_at)
    // refuses it as a mismatch before it ever reads record.status.
    const retried = await call(port2, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    });
    expect(rpcErrorOf(retried)?.code).toBe(-32602);
    const taskCount = (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(plan_id) as {
        n: number;
      }
    ).n;
    expect(taskCount).toBe(0);

    await handle.close();
  });

  it('the timer sweep expires an overdue record within two intervals', async () => {
    const boot = await setupBoot('xinas-mcp-restart-5-');
    cleanups.push(() => teardownBoot(boot));

    const handle = await startServer({
      configPath: boot.configPath,
      confirmationSweepIntervalMs: 50,
    });
    cleanups.push(() => handle.close());
    const port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-a');

    const { plan_id, expected_revision } = await planShareUpdate(port, 'tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    expect(toolResultOf(first).resultType).toBe('input_required');

    const record = handle.state.db
      .prepare('SELECT confirmation_id FROM mcp_confirmations WHERE plan_id = ?')
      .get(plan_id) as { confirmation_id: string };
    // Directly on the LIVE, in-process db handle — no restart needed here.
    handle.state.db
      .prepare('UPDATE mcp_confirmations SET expires_at = ? WHERE confirmation_id = ?')
      .run(Date.now() - 1, record.confirmation_id);

    // Two intervals' worth (50ms * 2 = 100ms) plus slack for CI jitter.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const swept = handle.state.db
      .prepare('SELECT status, expired_reason FROM mcp_confirmations WHERE confirmation_id = ?')
      .get(record.confirmation_id) as { status: string; expired_reason: string };
    expect(swept.status).toBe('expired');
    expect(swept.expired_reason).toBe('ttl');
  });
});
