// @vitest-environment node
/**
 * S15 Task 16 — interoperability with the released MCP v2 client
 * (`@modelcontextprotocol/client` 2.0.0, protocol `2026-07-28`) driving the
 * MRTR confirmation flows for real: `versionNegotiation` era selection
 * (S14 AC10/AC11), and the form/decline/url-round-limit confirmation cases
 * through the SDK's own multi-round-trip `inputRequired` auto-fulfilment
 * (registered `elicitation/create` handler), not the hand-rolled JSON-RPC
 * helpers `mcp-confirmation.test.ts` uses. `_mrtr-helpers.ts`'s
 * `planShareUpdate` / `planFsCreateForce` (raw fetch, not the SDK client)
 * still create the plans — planning a confirmable apply is unrelated to the
 * client under test here.
 *
 * Deviations from the task brief, reconciled against the installed
 * `@modelcontextprotocol/client@2.0.0` typings
 * (`node_modules/@modelcontextprotocol/client/dist/index.d.mts`):
 *
 *  - `client.callTool()`'s return type is `CallToolResult`, which is
 *    `StripWireOnly<...>` — the wire-only `resultType` discriminator
 *    ("input_required" vs "complete") is stripped by the SDK before the
 *    result reaches caller code at all, for BOTH outcomes. With
 *    `inputRequired.autoFulfill: true` (the default; set explicitly here
 *    per the brief), `callTool()` only ever resolves once a "complete"
 *    result comes back (or rejects if the driver's own `maxRounds`, default
 *    10, is exceeded first — never hit here, since the server's confirmation
 *    round limit is 3). So "callTool resolves with resultType complete"
 *    is checked as "callTool() resolves normally" rather than by reading a
 *    `resultType` field that the SDK never exposes.
 *  - A tool-level failure (`CONFIRMATION_DECLINED`, `CONFIRMATION_ROUND_LIMIT`)
 *    is carried as `isError: true` on an otherwise normal, resolved
 *    `CallToolResult` (MCP spec: tool errors are results, not JSON-RPC
 *    errors) — `callTool()` does not throw for either case; the assertions
 *    below parse `result.content[0].text` the same way `payloadOf()` does
 *    for the raw-wire suite.
 *  - The elicitation handler receives `ElicitRequest` (`{ method, params }`);
 *    `params` is `ElicitRequestFormParams | ElicitRequestURLParams`, the
 *    exact object `ConfirmationService.elicitation()` builds
 *    (`src/api/mcp/confirmation/service.ts`) — `{ mode: 'form', message,
 *    requestedSchema }` or `{ mode: 'url', message, url }`. The handler
 *    return value is `ElicitResult` (`{ action, content? }`), matching the
 *    server's `input.mrtr.inputResponses.confirm_apply` read in `retry()`.
 *  - AC10's "no initialize" is checked as "no `Mcp-Session-Id` response
 *    header on any request the transport made" — the SDK's modern era is
 *    stateless (no session), while a legacy `initialize` mints one (see
 *    `mcp-confirmation.test.ts`'s legacy-client case) — via a wrapped
 *    `fetch` passed as `StreamableHTTPClientTransportOptions.fetch`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../../api/server.js';
import { type MockAgentServer, seedShare, startMockAgentServer } from '../_helpers.js';
import { nextId, planFsCreateForce, planShareUpdate } from './_mrtr-helpers.js';

type ElicitParams = ElicitRequestFormParams | ElicitRequestURLParams;

interface ToolCallPayload {
  result?: { task_id?: string };
  error?: { code?: string; details?: Record<string, unknown> };
}

function payloadOf(result: { content?: Array<{ type: 'text'; text: string }> }): ToolCallPayload {
  const text = result.content?.[0]?.text;
  return text === undefined ? {} : (JSON.parse(text) as ToolCallPayload);
}

describe('@modelcontextprotocol/client 2.0.0 ↔ xinas-api S15 MRTR confirmation', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let mockAgent: MockAgentServer;
  let port: number;

  function getConfirmationByPlanId(planId: string): Record<string, unknown> | undefined {
    return handle.state.db
      .prepare('SELECT * FROM mcp_confirmations WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(planId) as Record<string, unknown> | undefined;
  }

  function countTasksByPlan(planId: string): number {
    return (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(planId) as {
        n: number;
      }
    ).n;
  }

  // The interop client's registered `elicitation/create` handler delegates
  // to whichever behavior the current test installed — vitest runs the
  // `it`s in this file sequentially, so there is no cross-test race.
  let elicitBehavior: (params: ElicitParams) => ElicitResult | Promise<ElicitResult> = () => ({
    action: 'decline',
  });
  const seenElicitations: ElicitParams[] = [];

  async function connectInteropClient(token = 'tok-admin'): Promise<Client> {
    const client = new Client(
      { name: 'xinas-interop', version: '0.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        capabilities: { elicitation: { form: {}, url: {} } },
        inputRequired: { autoFulfill: true },
      },
    );
    client.setRequestHandler('elicitation/create', async (req) => {
      seenElicitations.push(req.params);
      return elicitBehavior(req.params);
    });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-sdk-v2-'));
    const agentSock = join(dir, 'agent.sock');
    mockAgent = await startMockAgentServer(agentSock);
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000d1',
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        agent: { socket: agentSock },
        mcp: {
          allow_apply: true,
          confirmation: {
            approval_url_base: 'http://127.0.0.1:1',
            url_wait_seconds: 1,
            max_pending_per_principal: 50,
            max_pending_total: 1000,
            create_rate_per_minute: 600,
          },
        },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-interop-form');
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
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    await mockAgent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── S14 AC10/AC11 — era negotiation ─────────────────────────────────────

  it('S14 AC10: auto mode negotiates 2026-07-28 with no legacy session (no Mcp-Session-Id header)', async () => {
    const seenHeaders: Headers[] = [];
    const recordingFetch: FetchLike = async (url, init) => {
      const res = await fetch(url, init);
      seenHeaders.push(res.headers);
      return res;
    };
    const client = new Client(
      { name: 'xinas-interop-auto', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer tok-admin' } },
      fetch: recordingFetch,
    });
    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(seenHeaders.length).toBeGreaterThan(0);
      expect(seenHeaders.every((h) => h.get('mcp-session-id') === null)).toBe(true);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('S14 AC11: pinned to 2026-07-28 connects', async () => {
    const client = new Client(
      { name: 'xinas-interop-pinned', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer tok-admin' } },
    });
    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    } finally {
      await client.close().catch(() => {});
    }
  });

  // ── S15 form flow ───────────────────────────────────────────────────────

  it('form flow end to end: the elicitation handler sees the generated message and returns APPLY → task', async () => {
    let seenForm: ElicitRequestFormParams | undefined;
    elicitBehavior = (params) => {
      if (params.mode === 'form') seenForm = params;
      return { action: 'accept', content: { decision: 'APPLY' } };
    };
    const { plan_id, expected_revision, risk_level } = await planShareUpdate(
      port,
      'tok-admin',
      'share-interop-form',
    );
    expect(risk_level).toBe('changing_access');

    const client = await connectInteropClient();
    try {
      const result = await client.callTool({
        name: 'shares.update',
        arguments: {
          id: 'share-interop-form',
          mode: 'apply',
          plan_id,
          expected_revision,
          idempotency_key: nextId('interop-ik'),
        },
      });
      expect(result.isError ?? false).toBe(false);
      expect(seenForm?.mode).toBe('form');
      expect(seenForm?.message).toContain('share-interop-form');
      const decisionProperty = (
        seenForm?.requestedSchema.properties as Record<string, { enum?: string[] }>
      ).decision;
      expect(decisionProperty?.enum).toEqual(['APPLY']);

      const payload = payloadOf(result as { content?: Array<{ type: 'text'; text: string }> });
      expect(typeof payload.result?.task_id).toBe('string');

      const consumed = getConfirmationByPlanId(plan_id);
      expect(consumed?.status).toBe('consumed');
      expect(consumed?.consumed_task_id).toBe(payload.result?.task_id);
      // Task 16 follow-up: the released client's automatic input_required
      // round-trip must produce exactly ONE apply task. The client re-sends
      // the same tools/call with the echoed requestState, so a gate that
      // failed to recognise the retry would leave two.
      expect(countTasksByPlan(plan_id)).toBe(1);
    } finally {
      await client.close().catch(() => {});
    }
  }, 10_000);

  it('decline in the handler → CONFIRMATION_DECLINED, no task', async () => {
    elicitBehavior = (params) => {
      if (params.mode === 'form') return { action: 'decline' };
      return { action: 'accept' };
    };
    seedShare(handle.state, 'share-interop-decline');
    const { plan_id, expected_revision } = await planShareUpdate(
      port,
      'tok-admin',
      'share-interop-decline',
    );

    const client = await connectInteropClient();
    try {
      const result = await client.callTool({
        name: 'shares.update',
        arguments: {
          id: 'share-interop-decline',
          mode: 'apply',
          plan_id,
          expected_revision,
          idempotency_key: nextId('interop-ik'),
        },
      });
      expect(result.isError).toBe(true);
      const payload = payloadOf(result as { content?: Array<{ type: 'text'; text: string }> });
      expect(payload.error?.code).toBe('CONFIRMATION_DECLINED');
      expect(getConfirmationByPlanId(plan_id)?.status).toBe('declined');
      expect(countTasksByPlan(plan_id)).toBe(0);
    } finally {
      await client.close().catch(() => {});
    }
  }, 10_000);

  // ── S15 url round limit ─────────────────────────────────────────────────

  it('URL elicitation reaches the handler with the approval URL; accept before the operator decides → ' +
    'the client sees another input_required round (autoFulfill re-drives it) and finally CONFIRMATION_ROUND_LIMIT', async () => {
    const seenUrls: string[] = [];
    elicitBehavior = (params) => {
      if (params.mode === 'url') seenUrls.push(params.url);
      return { action: 'accept' };
    };
    const { plan_id, expected_revision } = await planFsCreateForce(
      port,
      'tok-admin',
      '/mnt/interop-round',
    );

    const client = await connectInteropClient();
    try {
      const result = await client.callTool({
        name: 'filesystems.create',
        arguments: {
          mode: 'apply',
          plan_id,
          expected_revision,
          idempotency_key: nextId('interop-ik'),
          dangerous: true,
        },
      });
      expect(result.isError).toBe(true);
      const payload = payloadOf(result as { content?: Array<{ type: 'text'; text: string }> });
      expect(payload.error?.code).toBe('CONFIRMATION_ROUND_LIMIT');

      // MAX_ROUNDS is 3 (src/api/mcp/confirmation/types.ts): the initial
      // elicit plus two reissues, each re-invoking the handler, before the
      // third retry's reissue attempt hits the limit and answers with a
      // terminal (non-input_required) error instead of a fourth round.
      const record = getConfirmationByPlanId(plan_id);
      expect(seenUrls).toEqual([
        `http://127.0.0.1:1/mcp/approvals/${record?.confirmation_id as string}`,
        `http://127.0.0.1:1/mcp/approvals/${record?.confirmation_id as string}`,
        `http://127.0.0.1:1/mcp/approvals/${record?.confirmation_id as string}`,
      ]);
      expect(record?.status).toBe('expired');
      expect(record?.expired_reason).toBe('round_limit');
      expect(countTasksByPlan(plan_id)).toBe(0);
    } finally {
      await client.close().catch(() => {});
    }
  }, 15_000);
});
