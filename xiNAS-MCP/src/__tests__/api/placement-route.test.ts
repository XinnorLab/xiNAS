/**
 * S20 §5 — GET /api/v1/placement/observations end to end: auth, the three
 * 503s, growing ages, desired-share reconciliation, and the response's
 * conformance to the PlacementObservations component schema.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import AjvImport from 'ajv';
import addFormatsImport from 'ajv-formats';
import yaml from 'js-yaml';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG, mcpVisible } from '../../api/mcp/catalog.js';
import { ObservedReceipts } from '../../api/placement/receipts.js';
import { PLACEMENT_ROW_KEY } from '../../api/placement/read.js';
import { encExportId } from '../../lib/nfs-export-id.js';
import { ADMIN_TOKEN, OPERATOR_TOKEN, VIEWER_TOKEN, buildTestApp, seedShare } from './_helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: Ajv's CJS typings under NodeNext.
const Ajv = AjvImport as any;
// biome-ignore lint/suspicious/noExplicitAny: same.
const addFormats = addFormatsImport as any;

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, '..', '..', '..', '..', 'docs', 'control-path', 'api-v1.yaml');

const AT = '2026-09-22T12:00:00.000Z';
const SHARE_A = encExportId('/srv/nfs/share-a');

/** A row as the agent's collector publishes it (collectors/placement). */
function agentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const exportA = `export:${SHARE_A}`;
  return {
    kind: 'PlacementObservations',
    id: 'default',
    status: {
      schema_version: '1.0',
      controller_id: 'ctl-1',
      server_epoch: 'ctl-1:2026-09-22T10:00:00.000Z:77',
      source_generation: 3,
      generated_at: AT,
      snapshot_status: 'COMPLETE',
      collection_period_ms: 5000,
      capabilities: ['identity'],
      coverage: [{ check: 'identity', required: true, status: 'EVALUATED' }],
      shares: [
        {
          share_id: SHARE_A,
          incarnation: `${SHARE_A}:42`,
          export_path: '/srv/nfs/share-a',
          collection_status: 'SUCCESS',
          observed_at: AT,
          observed_mono_ms: 1000,
          filesystem_ref: 'fs:srv-nfs.mount',
          export_ref: exportA,
          service_ref: 'nfs:nfs-server',
          reason_codes: [],
        },
      ],
      resources: [
        {
          id: 'fs:srv-nfs.mount',
          incarnation: 'u:/dev/xi_data',
          collection_status: 'SUCCESS',
          observed_at: AT,
          observed_mono_ms: 1000,
          reason_codes: [],
          details: {
            kind: 'FILESYSTEM',
            uuid: 'u',
            incarnation: 'u:/dev/xi_data',
            mountpoint: '/srv/nfs',
            source_device: '/dev/xi_data',
            fs_type: 'xfs',
            mounted: true,
            writable: true,
            mount_options: ['rw'],
            super_options: ['rw'],
            external_dependencies_resolved: true,
            array_refs: [],
            log_mode: 'INTERNAL',
          },
        },
        {
          id: exportA,
          incarnation: `${exportA}:42`,
          collection_status: 'SUCCESS',
          observed_at: AT,
          observed_mono_ms: 1000,
          reason_codes: [],
          details: {
            kind: 'EXPORT',
            export_path: '/srv/nfs/share-a',
            present: true,
            source: '/etc/exports',
            rules: [{ client: '10.0.0.0/8', writable: true, security: ['sys'], options: ['rw'] }],
          },
        },
        {
          id: 'nfs:nfs-server',
          incarnation: 'nfs:nfs-server:active',
          collection_status: 'SUCCESS',
          observed_at: AT,
          observed_mono_ms: 1100,
          reason_codes: [],
          details: { kind: 'NFS_SERVICE', running: true, protocols: ['NFSv3'], reason_codes: [] },
        },
      ],
      sources: {
        arrays: { status: 'ok', observed_at: AT, mono_ms: 1000 },
        filesystems: { status: 'ok', observed_at: AT, mono_ms: 1000 },
        exports: { status: 'ok', observed_at: AT, mono_ms: 1000 },
        nfs_service: { status: 'ok', observed_at: AT, mono_ms: 1100 },
        nfsd_versions: { status: 'ok', observed_at: AT, mono_ms: 1100 },
      },
      published_mono_ms: 1200,
      collector: { cycle_ms: 200, deadline_hit: false, skipped_ticks: 0 },
      observed_at: AT,
      ...over,
    },
  };
}

describe('GET /api/v1/placement/observations', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  let nowMono = 100_000;
  let receipts: ObservedReceipts;
  // biome-ignore lint/suspicious/noExplicitAny: Ajv validator.
  let validateResult: any;

  beforeAll(async () => {
    const raw = yaml.load(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
    const resolved = (await $RefParser.dereference(raw)) as {
      components: { schemas: Record<string, unknown> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validateResult = ajv.compile(resolved.components.schemas.PlacementObservations as object);
  });

  beforeEach(async () => {
    setup = await buildTestApp();
    nowMono = 100_000;
    // A controllable receipt clock in place of the one createApp minted.
    receipts = new ObservedReceipts(() => nowMono);
    setup.ctx.observed_receipts = receipts;
  });

  afterEach(() => setup.cleanup());

  /** Store the row the way the ingest does and stamp its receipt. */
  function storeRow(over: Record<string, unknown> = {}): number {
    const put = setup.state.kv.put(PLACEMENT_ROW_KEY, agentRow(over));
    if (!put.ok) throw new Error(`kv.put refused: ${put.reason}`);
    receipts.record('PlacementObservations', 'default', put.value.revision);
    return put.value.revision;
  }

  const get = (token?: string) => {
    const req = request(setup.app).get('/api/v1/placement/observations');
    return token === undefined ? req : req.set('Authorization', token);
  };

  it('401 without a token', async () => {
    const res = await get();
    expect(res.status).toBe(401);
  });

  it('503 SOURCE_NOT_READY with no row', async () => {
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.result).toBeNull();
    expect(res.body.errors[0].code).toBe('SOURCE_NOT_READY');
  });

  it('503 SOURCE_NOT_READY when the row exists but this api process has no receipt (restart)', async () => {
    setup.state.kv.put(PLACEMENT_ROW_KEY, agentRow());
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.errors[0].code).toBe('SOURCE_NOT_READY');
    expect(res.body.errors[0].details.row_present).toBe(true);
  });

  it('viewer, operator and admin all read 200 with the projected result', async () => {
    const revision = storeRow();
    nowMono += 400;
    for (const token of [VIEWER_TOKEN, OPERATOR_TOKEN, ADMIN_TOKEN]) {
      const res = await get(token);
      expect(res.status, token).toBe(200);
      expect(res.body.state_revision).toBe(revision);
      expect(res.body.result.source_generation).toBe(3);
      expect(res.body.result.server_epoch).toBe('ctl-1:2026-09-22T10:00:00.000Z:77');
      // 400 ms since receipt + 200 ms intra-cycle offset.
      expect(res.body.result.shares[0].evidence_age_ms).toBe(600);
      expect(res.body.result.shares[0]).not.toHaveProperty('observed_mono_ms');
      expect(res.body.result).not.toHaveProperty('published_mono_ms');
    }
  });

  it('ages grow between two reads (API-14)', async () => {
    storeRow();
    nowMono += 100;
    const a = await get(VIEWER_TOKEN);
    nowMono += 2_000;
    const b = await get(VIEWER_TOKEN);
    expect(b.body.result.shares[0].evidence_age_ms - a.body.result.shares[0].evidence_age_ms).toBe(
      2_000,
    );
    expect(
      b.body.result.resources[2].evidence_age_ms - a.body.result.resources[2].evidence_age_ms,
    ).toBe(2_000);
  });

  it('503 SOURCE_STALE once the receipt is older than 2 × period + 2 s', async () => {
    storeRow();
    nowMono += 12_000;
    expect((await get(VIEWER_TOKEN)).status).toBe(200);
    nowMono += 1;
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.errors[0].code).toBe('SOURCE_STALE');
    expect(res.body.errors[0].details).toEqual({
      age_ms: 12_001,
      limit_ms: 12_000,
      collection_period_ms: 5000,
    });
  });

  it('reconciles with desired shares: observed+desired keeps the desired id, desired-only is EXPORT_ABSENT, observed-only is SHARE_UNMANAGED', async () => {
    seedShare(setup.state, 'share-a'); // path /srv/nfs/share-a, fsid 42
    seedShare(setup.state, 'share-b'); // path /srv/nfs/share-b — no export line
    storeRow();
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(200);
    const shares = res.body.result.shares as Array<Record<string, unknown>>;
    expect(shares.map((s) => [s.share_id, s.collection_status, s.reason_codes])).toEqual([
      ['share-a', 'SUCCESS', []],
      ['share-b', 'UNKNOWN', ['EXPORT_ABSENT']],
    ]);
    expect(shares[0]?.incarnation).toBe('share-a:42');
    const absent = (res.body.result.resources as Array<Record<string, unknown>>).find(
      (r) => r.id === `export:${encExportId('/srv/nfs/share-b')}`,
    );
    expect(absent?.details).toMatchObject({ kind: 'EXPORT', present: false });
    expect(shares[1]?.export_ref).toBe(absent?.id);

    // Without the desired row the same export reads as unmanaged.
    setup.state.kv.delete('/xinas/v1/desired/Share/share-a');
    setup.state.kv.delete('/xinas/v1/desired/Share/share-b');
    const again = await get(VIEWER_TOKEN);
    expect(again.body.result.shares[0].reason_codes).toEqual(['SHARE_UNMANAGED']);
  });

  it('503 SNAPSHOT_TOO_LARGE above 256 shares (API-03)', async () => {
    for (let i = 0; i < 257; i++) seedShare(setup.state, `s${i}`);
    storeRow();
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.errors[0].code).toBe('SNAPSHOT_TOO_LARGE');
    expect(res.body.errors[0].details.shares).toBe(258);
  });

  it('a FAILED snapshot is still a 200 (the connector denies on it)', async () => {
    storeRow({ snapshot_status: 'FAILED', shares: [], resources: [] });
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.snapshot_status).toBe('FAILED');
  });

  it('the result validates against the PlacementObservations component schema', async () => {
    seedShare(setup.state, 'share-a');
    seedShare(setup.state, 'share-b');
    storeRow();
    const res = await get(VIEWER_TOKEN);
    const ok = validateResult(res.body.result);
    expect(validateResult.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the MCP catalog exposes placement.observations as a viewer read tool', () => {
    const entry = CATALOG.find((e) => e.name === 'placement.observations');
    expect(entry).toMatchObject({
      method: 'GET',
      path: '/placement/observations',
      mutability: 'read',
      requires_mcp_apply: false,
      min_role: 'viewer',
    });
    expect(mcpVisible(entry as NonNullable<typeof entry>)).toBe(true);
  });

  it('a push through /internal/v1/observed stamps the receipt clock (the ingest hook)', async () => {
    // The auth middleware resolves bearer tokens from config.tokens per
    // request, so an internal_agent credential can be added after build.
    setup.config.tokens['tok-agent'] = { principal: 'agent:root', role: 'internal_agent' };
    const push = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', 'Bearer tok-agent')
      .send({
        observed_at: AT,
        controller_id: setup.config.controller_id,
        deltas: [{ kind: 'PlacementObservations', id: 'default', op: 'upsert', value: agentRow() }],
        complete_snapshots: ['PlacementObservations'],
      });
    expect(push.status, JSON.stringify(push.body)).toBe(200);
    expect(push.body.result.accepted).toBe(1);
    nowMono += 300;
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.shares[0].evidence_age_ms).toBe(500);
    expect(res.body.state_revision).toBe(push.body.state_revision);
  });
});
