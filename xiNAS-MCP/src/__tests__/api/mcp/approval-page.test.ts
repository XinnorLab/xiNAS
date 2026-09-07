import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_PAGE_HEADERS } from '../../../api/mcp/confirmation/approval-page.js';
import { ADMIN_TOKEN, buildTestApp } from '../_helpers.js';

/**
 * A minimal browser-DOM element stub for the F7 vm harness: exactly the
 * shape `approval-page.ts`'s script touches (`textContent`, `value`,
 * `checked`, `disabled`, `hidden`, `addEventListener`, `appendChild`,
 * `getAttribute`/`setAttribute`). No rendering, no real DOM tree — the
 * script only ever reads back what it itself wrote.
 */
interface StubElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  children: StubElement[];
  listeners: Record<string, Array<(ev?: { preventDefault?: () => void }) => void>>;
  addEventListener(type: string, fn: (ev?: { preventDefault?: () => void }) => void): void;
  appendChild(child: StubElement): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function makeStubElement(): StubElement {
  let text = '';
  const attrs: Record<string, string> = {};
  const listeners: StubElement['listeners'] = {};
  const stub: StubElement = {
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    children: [],
    listeners,
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = v;
      stub.children = [];
    },
    addEventListener(type, fn) {
      const list = listeners[type] ?? (listeners[type] = []);
      list.push(fn);
    },
    appendChild(child) {
      stub.children.push(child);
    },
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    setAttribute(name, value) {
      attrs[name] = value;
    },
  };
  return stub;
}

/** Every element id `approval-page.ts`'s script addresses via `$('#id')`,
 *  plus `document.body` itself (read separately below). */
const STUB_IDS = [
  'status',
  'facts',
  'message',
  'consequences',
  'rollback',
  'diff',
  'phrase-row',
  'phrase-label',
  'approve',
  'decline',
  'login',
  'review',
  'login-form',
  'token',
  'reason',
  'reviewed',
  'phrase',
] as const;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FakeFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Await a handful of full event-loop turns so every chained `.then()` in
 *  the script's fetch promise chains (GET, then POST, then the F1 re-GET)
 *  has a chance to settle. */
async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('approval page (S15 §9.3)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('serves an identical, unauthenticated shell for any id with the security headers', async () => {
    const a = await request(setup.app).get('/mcp/approvals/abc');
    const b = await request(setup.app).get('/mcp/approvals/does-not-exist');
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toMatch(/text\/html/);
    expect(a.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(a.headers['x-frame-options']).toBe('DENY');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['referrer-policy']).toBe('no-referrer');
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    // same document modulo the id (it appears more than once) → no existence leak
    expect(a.text.replaceAll('abc', 'X')).toBe(b.text.replaceAll('does-not-exist', 'X'));
    expect(a.text).not.toMatch(/<script[^>]*src="https?:/);
    expect(a.text).toContain('Do not paste the token your MCP client uses');
  });

  it('serves the script and stylesheet with no-store and nosniff', async () => {
    const js = await request(setup.app).get('/mcp/approvals/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('no-store');
    // F2: the API path is built from a computed, prefix-aware base — not a
    // hardcoded root-absolute literal. See the dedicated prefix test below.
    expect(js.text).toContain('api/v1/mcp/confirmations');
    expect(js.text).toContain('location.pathname');
    expect(js.text).toContain('X-Xinas-Approval-Interface');
    expect(js.text).toContain('DATA MAY BE PERMANENTLY LOST');
    const css = await request(setup.app).get('/mcp/approvals/assets/app.css');
    expect(css.status).toBe(200);
  });

  it('is not audited (the /mcp prefix skip) and neutralizes a non-id path segment', async () => {
    const res = await request(setup.app).get('/mcp/approvals/..%2Fetc');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-confirmation-id="invalid"');
    expect(res.text).not.toContain('etc');
    await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    await setup.state.drainer.drainNow();
    const rows = readFileSync(join(setup.dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string });
    expect(rows.some((r) => r.kind?.startsWith('http.GET./mcp/'))).toBe(false);
    expect(rows.some((r) => r.kind === 'http.GET./api/v1/system')).toBe(true);
  });

  it('sets every APPROVAL_PAGE_HEADERS entry, with the same value, on the shell, app.js, and app.css (F5)', async () => {
    const shell = await request(setup.app).get('/mcp/approvals/abc');
    const js = await request(setup.app).get('/mcp/approvals/assets/app.js');
    const css = await request(setup.app).get('/mcp/approvals/assets/app.css');
    for (const res of [shell, js, css]) {
      for (const [header, value] of Object.entries(APPROVAL_PAGE_HEADERS)) {
        expect(res.headers[header.toLowerCase()]).toBe(value);
      }
    }
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(js.headers['content-type']).toBe('application/javascript; charset=utf-8');
  });

  it('is prefix-safe: assets are path-relative and the script derives its API base from location.pathname (F2)', async () => {
    // Simulate the app being served under a reverse-proxy path prefix, as
    // approval_url_base (https://host[:port][/prefix] — config.ts) allows.
    const wrapper = express();
    wrapper.use('/prefix', setup.app);

    const shell = await request(wrapper).get('/prefix/mcp/approvals/abc');
    expect(shell.status).toBe(200);
    expect(shell.text).not.toMatch(/src="\/mcp\//);
    expect(shell.text).not.toMatch(/href="\/mcp\//);
    expect(shell.text).toContain('src="assets/app.js"');
    expect(shell.text).toContain('href="assets/app.css"');

    const js = await request(wrapper).get('/prefix/mcp/approvals/assets/app.js');
    expect(js.status).toBe(200);
    // The pathname-derivation logic must be present…
    expect(js.text).toContain('location.pathname');
    // …and the fetch call sites must not hardcode an absolute API path —
    // they must go through the computed base instead.
    expect(js.text).not.toMatch(/api\(\s*'(GET|POST)',\s*'\/api\/v1\/mcp\/confirmations/);
  });
});

describe('operator approval page — executed script (S15 Task 12 fix1, F1/F2/F3/F4/F7)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('loads a record, approves it, and never renders "Network error." on a successful decision', async () => {
    const confirmationId = 'conf-1';
    const nowMs = Date.now();

    // A realistic url-mode, destructive record (rollback_model 'destructive'
    // so needsPhrase() asks for ACK_DATA_LOSS, not ACK_NO_ROLLBACK — the
    // path this drive exercises).
    const serverRecord: Record<string, unknown> = {
      confirmation_id: confirmationId,
      status: 'pending',
      mode: 'url',
      principal: 'admin:test',
      role: 'admin',
      tool_name: 'raid.destroy',
      operation_kind: 'raid.destroy',
      arguments_hash: 'ah-1',
      plan_id: 'plan-1',
      plan_hash: 'ph-1',
      plan_document_hash: 'pdh-1',
      idempotency_key: 'ik-1',
      expected_revision: 3,
      risk_level: 'destructive',
      rollback_model: 'destructive',
      round: 1,
      created_at: new Date(nowMs - 1_000).toISOString(),
      expires_at: new Date(nowMs + 300_000).toISOString(),
      approved_at: null,
      approved_by: null,
      approval_channel: null,
      approval_interface: null,
      declined_at: null,
      declined_by: null,
      decision_reason: null,
      consumed_at: null,
      consumed_task_id: null,
      expired_reason: null,
      correlation_id: 'corr-1',
      request_id: 'req-1',
      node_id: 'node-1',
    };
    // publicPlan(doc) shape — out-of-order keys on purpose (F4: the
    // stringifier must sort them, not echo insertion order).
    const plan = {
      plan_id: 'plan-1',
      plan_hash: 'ph-1',
      state_revision_expected: 3,
      observed_revision_expected: 3,
      observed_at: new Date(nowMs - 2_000).toISOString(),
      affected_resources: [{ kind: 'RaidArray', id: 'raid0' }],
      risk_level: 'destructive',
      client_impact: 'May affect NFS clients; review the diff.',
      blockers: [],
      warnings: [{ code: 'W1', message: 'One active session' }],
      diff: { b: 1, a: { z: 1, y: 2 }, c: [3, 1, 2] },
      rollback_model: 'destructive',
    };
    const summary = {
      message: [
        'xiNAS node test-host (controller node-1)',
        'Operation: raid.destroy (raid.destroy) on RaidArray "raid0"',
        'Risk: destructive · Rollback: destructive',
        'Client impact: May affect NFS clients; review the diff.',
        'Affected: RaidArray raid0',
        'Warnings: (1) W1 — One active session',
        'Diff (concise): {"a":{"y":2,"z":1},"b":1,"c":[3,1,2]}',
        `Plan plan-1 · hash ph-1 · expires ${new Date(nowMs + 300_000).toISOString()} (in 4m59s)`,
        'Choose APPLY to confirm. Any other action leaves xiNAS unchanged.',
      ].join('\n'),
      consequences:
        'This operation destroys data on RaidArray raid0. Data on them may be permanently lost.',
      rollback_limitation:
        'Rollback is itself destructive: undoing this operation cannot restore data.',
    };

    const jsRes = await request(setup.app).get('/mcp/approvals/assets/app.js');
    expect(jsRes.status).toBe(200);
    const source = jsRes.text;

    // Negative source assertions (F7): none of these DOM/storage APIs
    // should ever appear in the served script.
    for (const forbidden of [
      'innerHTML',
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'location.search',
    ]) {
      expect(source).not.toContain(forbidden);
    }

    const elements: Record<(typeof STUB_IDS)[number], StubElement> = Object.fromEntries(
      STUB_IDS.map((elId) => [elId, makeStubElement()]),
    ) as Record<(typeof STUB_IDS)[number], StubElement>;
    const body = makeStubElement();
    body.setAttribute('data-confirmation-id', confirmationId);

    const document = {
      body,
      querySelector(sel: string): StubElement {
        const key = sel.replace(/^#/, '') as (typeof STUB_IDS)[number];
        const found = elements[key];
        if (!found) throw new Error(`no stub element for selector ${sel}`);
        return found;
      },
      createElement(_tag: string): StubElement {
        return makeStubElement();
      },
    };

    const fetchLog: FetchCall[] = [];
    function fakeFetch(
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<FakeFetchResponse> {
      const method = init.method ?? 'GET';
      fetchLog.push({ url, method, headers: init.headers ?? {}, body: init.body });
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: { ...serverRecord, plan, summary } }),
        });
      }
      // POST approve/decline — the real route answers with record fields
      // only (sendOk(renderConfirmation(record))): no plan, no summary.
      serverRecord.status = /\/approve$/.test(url) ? 'approved' : 'declined';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { ...serverRecord } }),
      });
    }

    const location = { pathname: `/prefix/mcp/approvals/${confirmationId}`, search: '' };
    const sandbox: Record<string, unknown> = {
      document,
      fetch: fakeFetch,
      location,
      console,
      Promise,
      setTimeout,
    };
    sandbox.window = sandbox;

    vm.runInNewContext(source, sandbox);

    // Drive: set the token, click "Load the plan" (the login-form submit handler).
    elements.token.value = 'tok-secret';
    const submit = elements['login-form'].listeners.submit?.[0];
    expect(submit).toBeDefined();
    submit?.({ preventDefault: () => {} });
    await flush();

    expect(elements.status.textContent).not.toBe('Network error.');
    // F3: summary.message is rendered verbatim above the fact list.
    expect(elements.message.textContent).toBe(summary.message);
    // F4: plan.diff is rendered as a sorted-keys, 2-space-indented stringify.
    expect(elements.diff.textContent).toBe(
      [
        '{',
        '  "a": {',
        '    "y": 2,',
        '    "z": 1',
        '  },',
        '  "b": 1,',
        '  "c": [',
        '    3,',
        '    1,',
        '    2',
        '  ]',
        '}',
      ].join('\n'),
    );

    // Drive: check reviewed, type the acknowledgement phrase, click Approve.
    elements.reviewed.checked = true;
    elements.phrase.value = 'DATA MAY BE PERMANENTLY LOST';
    const approveClick = elements.approve.listeners.click?.[0];
    expect(approveClick).toBeDefined();
    approveClick?.();
    await flush();

    // F1: a successful decision must show the success line, never "Network error.".
    expect(elements.status.textContent).toBe('Approved. The MCP client may now retry its apply.');
    expect(elements.status.textContent).not.toBe('Network error.');
    // F3 stays populated after the post-decision re-render.
    expect(elements.message.textContent).toBe(summary.message);

    // F1: GET, then POST approve, then the re-GET that renders the outcome.
    expect(fetchLog.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    const postCall = fetchLog[1];
    expect(postCall).toBeDefined();
    expect(postCall?.headers.Authorization).toBe('Bearer tok-secret');
    expect(postCall?.headers['X-Xinas-Approval-Interface']).toBe('web');
    // F2: the URL is built from location.pathname's computed base, not a
    // hardcoded root-absolute path — it must carry the /prefix.
    expect(postCall?.url.startsWith('/prefix/api/v1/mcp/confirmations/')).toBe(true);
  });
});
