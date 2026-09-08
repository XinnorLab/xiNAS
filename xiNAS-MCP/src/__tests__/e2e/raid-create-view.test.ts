/**
 * S18 RAID Create view in a real Chromium (report I-05/I-06/I-07): keyboard
 * typing into the name field, paste and mid-string edits, Tab order,
 * keyboard disk selection, plan staleness, a failed refresh, a degraded
 * refresh and spare-pool exclusion by device path. The host is a fixture
 * page that speaks the MCP Apps bridge (`ui/initialize`, `tools/call`,
 * `ui/message`) over postMessage; no storage apply ever happens.
 *
 * Needs the Vite bundle (`npm run build`, or `npm run build:ui`) and a
 * Chromium from `npm run test:e2e:browsers`.
 */
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { type Browser, type FrameLocator, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { raidCreateAppConfig } from '../../api/routes/storage.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const BUNDLE = join(PROJECT_ROOT, 'dist/mcp-apps/raid-create.html');

const config = raidCreateAppConfig();
const disks = Array.from({ length: 6 }, (_, i) => ({
  id: `serial-disk-${i}`,
  status: {
    device_path: `/dev/nvme${i}n1`,
    serial: `serial-${i}`,
    capacity_bytes: 1e12,
    safe_for_use: true,
    mounted: false,
    system_disk: false,
  },
}));
const plan = {
  plan_id: '00000000-0000-4000-8000-000000000099',
  state_revision_expected: 0,
  risk_level: 'non_disruptive',
  rollback_model: 'non_disruptive',
  blockers: [],
  warnings: [],
  affected_resources: [{ kind: 'XiraidArray', id: 'data_01' }],
  diff: { action: 'create' },
};

/** The host fixture: answers the bridge; `window.fixture` flags drive failures. */
const hostPage = `<!doctype html><html><body>
<iframe id="view" src="/app" style="width:100%;height:100vh;border:0"></iframe>
<script>
const config = ${JSON.stringify(config)}, disks = ${JSON.stringify(disks)}, plan = ${JSON.stringify(plan)};
window.fixture = { calls: [], failTool: null, pooled: false, degraded: false, advisory: false, lastHandoff: null };
window.addEventListener('message', (e) => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0' || m.id === undefined) return;
  let result;
  if (m.method === 'ui/initialize') {
    result = { protocolVersion: '2026-01-26', hostInfo: { name: 'fixture-host', version: '1' },
      hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: 'light' } };
  } else if (m.method === 'tools/call') {
    window.fixture.calls.push(m.params);
    const name = m.params.name;
    if (window.fixture.failTool === name) {
      result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INTERNAL', message: name + ' failed (fixture)' } }) }] };
    } else {
      const value = name === 'mcp_apps.raid_create' ? config : name === 'disks.list' ? disks : name === 'arrays.list' ? []
        : name === 'pools.list' ? (window.fixture.pooled ? [{ name: 'spares', drives: ['/dev/nvme0n1'], active: true }] : []) : plan;
      const warnings = window.fixture.degraded && name === 'disks.list' ? [{ code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'Inventory is stale (fixture)' }]
        : window.fixture.advisory && name === 'disks.list' ? [{ code: 'EXECUTOR_DEGRADED', message: 'advisory (fixture)' }] : undefined;
      result = { content: [{ type: 'text', text: JSON.stringify({ result: value, ...(warnings ? { warnings } : {}) }) }] };
    }
  } else if (m.method === 'ui/message') { window.fixture.lastHandoff = m.params; result = {}; }
  else result = {};
  e.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
});
</script></body></html>`;

describe('RAID Create view in Chromium (S18 §6.1, §9, §10)', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let view: FrameLocator;
  let url: string;

  beforeAll(async () => {
    const bundle = readFileSync(BUNDLE);
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/app' ? bundle : hostPage);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(url);
    view = page.frameLocator('#view');
    await view.locator('#array-name').waitFor();
    await view.locator('[data-disk-id]').first().waitFor();
  });

  const fixture = (patch: Record<string, unknown>) =>
    page.evaluate(
      (p) => Object.assign((window as unknown as { fixture: object }).fixture, p),
      patch,
    );
  const calls = () =>
    page.evaluate(
      () => (window as unknown as { fixture: { calls: Array<{ name: string }> } }).fixture.calls,
    );
  const focusedId = () =>
    view.locator('body').evaluate((body) => {
      const el = body.ownerDocument.activeElement as HTMLElement | null;
      return el?.id || (el as HTMLInputElement | null)?.dataset?.diskId || el?.tagName || null;
    });

  it('accepts character-by-character typing, keeps focus and caret, paste and mid-string edits (I-05)', async () => {
    await view.locator('#array-name').click();
    await page.keyboard.type('data_01', { delay: 20 });
    expect(await view.locator('#array-name').inputValue()).toBe('data_01');
    expect(await focusedId()).toBe('array-name');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');
    expect(await view.locator('#array-name').inputValue()).toBe('dataX_01');
    expect(
      await view.locator('#array-name').evaluate((el) => (el as HTMLInputElement).selectionStart),
    ).toBe(5);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('pasted_name');
    expect(await view.locator('#array-name').inputValue()).toBe('pasted_name');
    expect(await focusedId()).toBe('array-name');
  }, 30_000);

  it('Tab and Shift+Tab move through the form; Space toggles a focused disk and keeps focus on it', async () => {
    await view.locator('#array-name').click();
    await page.keyboard.press('Tab');
    expect(await focusedId()).toBe('raid-level');
    await page.keyboard.press('Shift+Tab');
    expect(await focusedId()).toBe('array-name');
    await view.locator('[data-disk-id="serial-disk-1"]').focus();
    await page.keyboard.press('Space');
    expect(await view.locator('[data-disk-id="serial-disk-1"]').isChecked()).toBe(true);
    expect(await focusedId()).toBe('serial-disk-1');
    await page.keyboard.press('Tab');
    expect(await focusedId()).toBe('serial-disk-2');
  }, 30_000);

  it('one plan request per click; a later edit marks the plan stale and disables the handoff', async () => {
    await view.locator('#array-name').fill('data_01');
    for (let i = 0; i < 4; i++) await view.locator(`[data-disk-id="serial-disk-${i}"]`).check();
    await view.locator('#plan-button').click();
    await view.locator('#handoff-button').waitFor();
    expect((await calls()).filter((c) => c.name === 'arrays.create')).toHaveLength(1);
    expect(await view.locator('#handoff-button').isEnabled()).toBe(true);
    await view.locator('#array-name').click();
    await page.keyboard.type('x');
    expect(await view.locator('.plan-state').innerText()).toBe('STALE');
    expect(await view.locator('#handoff-button').isEnabled()).toBe(false);
  }, 30_000);

  it('a failed inventory call keeps the old rows visible but blocks plan and handoff until a clean refresh (I-06)', async () => {
    await view.locator('#array-name').fill('data_01');
    for (let i = 0; i < 4; i++) await view.locator(`[data-disk-id="serial-disk-${i}"]`).check();
    await view.locator('#plan-button').click();
    await view.locator('#handoff-button').waitFor();
    await fixture({ failTool: 'pools.list' });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor();
    expect(await view.locator('#inventory-banner').innerText()).toContain('pools.list failed');
    expect(await view.locator('#plan-button').isEnabled()).toBe(false);
    expect(await view.locator('#handoff-button').count()).toBe(0);
    expect(await view.locator('[data-disk-id]').count()).toBe(6);
    await fixture({ failTool: null });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor({ state: 'detached' });
    expect(await view.locator('#plan-button').isEnabled()).toBe(true);
  }, 30_000);

  it('a DEGRADED_* warning is shown and blocks planning; an advisory warning does not (I-06)', async () => {
    await view.locator('#array-name').fill('data_01');
    for (let i = 0; i < 4; i++) await view.locator(`[data-disk-id="serial-disk-${i}"]`).check();
    await fixture({ degraded: true });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor();
    expect(await view.locator('#inventory-banner').innerText()).toContain(
      'DEGRADED_BACKEND_UNAVAILABLE',
    );
    expect(await view.locator('#plan-button').isEnabled()).toBe(false);
    await fixture({ degraded: false });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor({ state: 'detached' });
    expect(await view.locator('#plan-button').isEnabled()).toBe(true);
    await fixture({ advisory: true });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-advisories').waitFor();
    expect(await view.locator('#inventory-advisories').innerText()).toContain('EXECUTOR_DEGRADED');
    expect(await view.locator('#inventory-banner').count()).toBe(0);
    expect(await view.locator('#plan-button').isEnabled()).toBe(true);
  }, 30_000);

  it('a disk that joins a spare pool is deselected and disabled by device path; others stay selectable (I-07)', async () => {
    await view.locator('[data-disk-id="serial-disk-0"]').check();
    await view.locator('[data-disk-id="serial-disk-1"]').check();
    await fixture({ pooled: true });
    await view.locator('#refresh-button').click();
    await view.locator('[data-disk-id="serial-disk-0"]:disabled').waitFor();
    expect(await view.locator('[data-disk-id="serial-disk-0"]').isChecked()).toBe(false);
    expect(
      await view.locator('.disk-card:has([data-disk-id="serial-disk-0"]) .disk-reason').innerText(),
    ).toBe('Assigned to a spare pool');
    expect(await view.locator('[data-disk-id="serial-disk-1"]').isEnabled()).toBe(true);
    expect(await view.locator('[data-disk-id="serial-disk-1"]').isChecked()).toBe(true);
  }, 30_000);
});
