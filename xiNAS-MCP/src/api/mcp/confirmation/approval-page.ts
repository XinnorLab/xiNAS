import type { Express, Request, Response } from 'express';

/** S15 §9.3 — headers on every page response. */
export const APPROVAL_PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const CSS = `
:root { color-scheme: light dark; font: 15px/1.45 system-ui, sans-serif; }
body { margin: 0; padding: 24px; max-width: 880px; }
h1 { font-size: 1.3rem; }
.warn { padding: 12px; border: 2px solid #b00; border-radius: 6px; background: rgba(187,0,0,.08); }
.muted { opacity: .75; }
dl { display: grid; grid-template-columns: 12rem 1fr; gap: 4px 12px; }
dt { font-weight: 600; }
pre { white-space: pre-wrap; word-break: break-all; border: 1px solid #8884; padding: 8px; border-radius: 4px; }
button { font: inherit; padding: 8px 14px; margin-right: 8px; }
button.danger { background: #b00; color: #fff; border: 0; }
input[type=text], input[type=password] { font: inherit; width: 100%; padding: 6px; }
label { display: block; margin: 8px 0; }
#status { margin-top: 12px; font-weight: 600; }
`;

const JS = String.raw`
'use strict';
(function () {
  var ACK_DATA_LOSS = 'DATA MAY BE PERMANENTLY LOST';
  var ACK_NO_ROLLBACK = 'ROLLBACK IS NOT SUPPORTED';
  var TERMINAL_STATUSES = ['declined', 'cancelled', 'expired', 'consumed'];
  var id = document.body.getAttribute('data-confirmation-id');
  var token = '';
  var record = null;
  // F2: approval_url_base is documented as https://host[:port][/prefix]
  // (config.ts) — the page may be served under a path prefix. Derive the
  // API base from the document's own URL instead of assuming root mount.
  var apiBase = (function () {
    var marker = '/mcp/approvals/';
    var i = location.pathname.lastIndexOf(marker);
    var prefix = i === -1 ? '' : location.pathname.slice(0, i);
    return prefix + '/api/v1/mcp/confirmations';
  }());
  var $ = function (s) { return document.querySelector(s); };
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
  function setStatus(t) { $('#status').textContent = t; }
  function api(method, path, body) {
    var headers = { 'Authorization': 'Bearer ' + token, 'X-Xinas-Approval-Interface': 'web' };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }
  function needsPhrase(rec) {
    if (rec.rollback_model === 'unsupported' || rec.risk_level === 'unsupported_rollback') return ACK_NO_ROLLBACK;
    if (rec.risk_level === 'destructive') return ACK_DATA_LOSS;
    return null;
  }
  // F4: the plan hash covers the CANONICAL (sorted-keys) form of the diff —
  // render it the same way (objects: keys sorted; arrays: order kept; 2
  // -space indent) so what the operator reads matches what was hashed.
  function sortedJson(value, depth) {
    var pad = new Array(depth + 1).join('  ');
    var childPad = pad + '  ';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      var items = value.map(function (v) { return childPad + sortedJson(v, depth + 1); });
      return '[\n' + items.join(',\n') + '\n' + pad + ']';
    }
    var keys = Object.keys(value).sort();
    if (keys.length === 0) return '{}';
    var rows = keys.map(function (k) { return childPad + JSON.stringify(k) + ': ' + sortedJson(value[k], depth + 1); });
    return '{\n' + rows.join(',\n') + '\n' + pad + '}';
  }
  function render(res) {
    record = res.result;
    var plan = record.plan, s = record.summary, dl = $('#facts');
    dl.textContent = '';
    var rows = [
      ['Node', record.node_id], ['Operation', record.tool_name + ' (' + record.operation_kind + ')'],
      ['Requested by', record.principal], ['Status', record.status], ['Risk', record.risk_level],
      ['Rollback', record.rollback_model], ['Affected', plan.affected_resources.map(function (r) { return r.kind + ' ' + r.id; }).join('; ')],
      ['Warnings', plan.warnings.length ? plan.warnings.map(function (w) { return w.code + ' — ' + w.message; }).join(' | ') : 'none'],
      ['Plan id', record.plan_id], ['Plan hash', record.plan_hash], ['Expires', record.expires_at]
    ];
    rows.forEach(function (r) { dl.appendChild(el('dt', r[0])); dl.appendChild(el('dd', r[1])); });
    // F3 (spec §9.3, §10.2): the summary message carries the hostname, the
    // target resource_ref, the client impact and the server-computed
    // countdown — none of which the fact rows above repeat.
    $('#message').textContent = s.message;
    $('#consequences').textContent = s.consequences;
    $('#rollback').textContent = s.rollback_limitation;
    $('#diff').textContent = sortedJson(plan.diff, 0);
    var phrase = needsPhrase(record);
    $('#phrase-row').hidden = phrase === null;
    $('#phrase-label').textContent = phrase ? 'Type exactly: ' + phrase : '';
    $('#approve').textContent = record.risk_level === 'destructive' ? 'Approve — data may be permanently lost' : 'Approve';
    $('#approve').disabled = record.status !== 'pending' || record.mode !== 'url';
    $('#decline').disabled = !(record.status === 'pending' || record.status === 'approved');
    $('#login').hidden = true; $('#review').hidden = false;
  }
  // F1: GET the confirmation and render it. On success the status text is
  // left to the caller (successText) so a post-decision refresh can show
  // the decision outcome instead of being clobbered here. A non-200
  // response and a render exception are DISTINCT failures from a rejected
  // fetch (a real network error) — only the latter is "Network error.".
  function refresh(successText) {
    return api('GET', apiBase + '/' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200) { setStatus('Could not load the confirmation (HTTP ' + r.status + '). Check the token and role.'); return false; }
      try {
        render(r.body);
      } catch (e) {
        setStatus('Could not display the record (HTTP ' + r.status + ').');
        return false;
      }
      setStatus(successText);
      return true;
    });
  }
  $('#login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    token = $('#token').value; $('#token').value = '';
    setStatus('Loading…');
    refresh('').catch(function () { setStatus('Network error.'); });
  });
  function decide(kind) {
    var body = { reason: $('#reason').value || undefined };
    if (kind === 'approve') {
      if (!$('#reviewed').checked) { setStatus('Confirm that you reviewed the plan.'); return; }
      var phrase = needsPhrase(record);
      // The typed-phrase gate is a client-side courtesy only: the request
      // always sends the canonical constant below, and the human at the
      // keyboard is the trusted party — the server re-checks the phrase
      // itself and is what actually enforces it.
      if (phrase !== null) { if ($('#phrase').value !== phrase) { setStatus('The acknowledgement phrase does not match.'); return; } body.acknowledge = phrase; }
    }
    setStatus('Submitting…');
    api('POST', apiBase + '/' + encodeURIComponent(id) + '/' + kind, body).then(function (r) {
      if (r.status !== 200) { var e = (r.body.errors && r.body.errors[0]) || {}; setStatus('Refused: ' + (e.code || r.status) + ' ' + (e.message || '')); return; }
      // F1: the decision response carries record fields only (no plan, no
      // summary) — re-GET so the re-render has what it needs, and show the
      // decision outcome once that succeeds (refresh's own failure message
      // wins otherwise — it is more useful than a stale "Submitting…").
      var decided = r.body.result;
      var successText = kind === 'approve' ? 'Approved. The MCP client may now retry its apply.' : 'Declined. Nothing was changed.';
      return refresh(successText).then(function () {
        // F6: once the decision is terminal, the operator token has done
        // its job — drop it from the closure rather than holding it live.
        if (TERMINAL_STATUSES.indexOf(decided.status) !== -1) token = '';
      });
    }).catch(function () { setStatus('Network error.'); });
  }
  $('#approve').addEventListener('click', function () { decide('approve'); });
  $('#decline').addEventListener('click', function () { decide('decline'); });
})();
`;

function html(id: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>xiNAS — approve MCP operation</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="assets/app.css"></head>
<body data-confirmation-id="${id}">
<h1>xiNAS operator approval</h1>
<p class="muted">Confirmation <code>${id}</code>. This page approves or declines one MCP-requested operation. It stores nothing in your browser.</p>
<section id="login">
  <p class="warn">Do not paste the token your MCP client uses. Approval must come from a different credential — and a different credential is not proof of a different person: keep this token off machines the agent can read.</p>
  <form id="login-form"><label>Operator token <input id="token" type="password" autocomplete="off" required></label><button type="submit">Load the plan</button></form>
</section>
<section id="review" hidden>
  <pre id="message"></pre>
  <dl id="facts"></dl>
  <p class="warn" id="consequences"></p>
  <p id="rollback"></p>
  <h2>Diff</h2><pre id="diff"></pre>
  <label><input id="reviewed" type="checkbox"> I have reviewed the plan above.</label>
  <div id="phrase-row" hidden><label><span id="phrase-label"></span><input id="phrase" type="text" autocomplete="off"></label></div>
  <label>Reason (optional) <input id="reason" type="text" maxlength="512"></label>
  <button id="approve" class="danger" type="button">Approve</button>
  <button id="decline" type="button">Decline</button>
</section>
<p id="status"></p>
<script src="assets/app.js"></script>
</body></html>
`;
}

function setHeaders(res: Response): void {
  for (const [k, v] of Object.entries(APPROVAL_PAGE_HEADERS)) res.setHeader(k, v);
}

/** Mount on the app itself (not /api/v1): unauthenticated shell; the JS authenticates the operator. */
export function mountApprovalPage(app: Express): void {
  app.get('/mcp/approvals/assets/app.js', (_req: Request, res: Response) => {
    setHeaders(res);
    res.type('application/javascript').send(JS);
  });
  app.get('/mcp/approvals/assets/app.css', (_req: Request, res: Response) => {
    setHeaders(res);
    res.type('text/css').send(CSS);
  });
  app.get('/mcp/approvals/:id', (req: Request, res: Response) => {
    setHeaders(res);
    const raw = req.params.id as string;
    const id = ID.test(raw) ? raw : 'invalid';
    res.type('text/html').send(html(id));
  });
}
