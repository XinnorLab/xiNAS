import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG, ROLE_RANK, matchCatalog } from '../../api/mcp/catalog.js';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('client catalog (S8 T2)', () => {
  it('names are unique, REST-shaped, and same-route entries agree on min_role', () => {
    const names = CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of CATALOG) {
      expect(entry.name).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      // every {param} in the path appears in the input schema
      for (const m of entry.path.matchAll(/\{([^}]+)\}/g)) {
        const props = (entry.input_schema as { properties?: Record<string, unknown> }).properties;
        expect(props, `${entry.name} missing param ${m[1]}`).toHaveProperty(m[1] as string);
      }
      // same method+path entries share min_role (the rbac matcher returns the first)
      const twins = CATALOG.filter((o) => o.method === entry.method && o.path === entry.path);
      for (const twin of twins) expect(twin.min_role).toBe(entry.min_role);
    }
  });

  it('min_role spot pins (ported legacy matrix)', () => {
    const byName = new Map(CATALOG.map((e) => [e.name, e]));
    expect(byName.get('arrays.create')?.min_role).toBe('admin');
    expect(byName.get('filesystems.delete')?.min_role).toBe('admin');
    expect(byName.get('network.interfaces.update')?.min_role).toBe('admin');
    expect(byName.get('shares.create')?.min_role).toBe('operator');
    expect(byName.get('tasks.cancel')?.min_role).toBe('operator');
    expect(byName.get('arrays.list')?.min_role).toBe('viewer');
    expect(byName.get('health.check')?.min_role).toBe('viewer');
    // gate flags (ADR-0010 locked entries)
    expect(byName.get('support.bundle')?.requires_mcp_apply).toBe(false);
    expect(byName.get('tasks.cancel')?.requires_mcp_apply).toBe(false);
    expect(byName.get('shares.create')?.requires_mcp_apply).toBe(true);
    // S9: config-history/audit went LIVE; tasks.cancel is the one
    // remaining degraded entry (cancel wiring is a later slice).
    expect(byName.get('audit.query')?.status).toBe('live');
    expect(byName.get('config_history.snapshots')?.status).toBe('live');
    expect(byName.get('config_history.rollback')?.status).toBe('live');
    expect(byName.get('tasks.cancel')?.status).toBe('degraded');
    expect(byName.get('drift.report')?.status).toBe('live');
    // S9 pools entries
    expect(byName.get('pools.create')?.min_role).toBe('admin');
    expect(byName.get('pools.modify')?.min_role).toBe('operator');
    expect(byName.get('pools.delete')?.requires_mcp_apply).toBe(true);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.operator);
  });

  it('matchCatalog resolves parameterized paths; unknown → undefined', () => {
    expect(matchCatalog('GET', '/arrays/a1')?.name).toBe('arrays.get');
    expect(matchCatalog('PATCH', '/network/interfaces/ibp65s0')?.name).toBe(
      'network.interfaces.update',
    );
    expect(matchCatalog('POST', '/tasks/t-1/cancel')?.name).toBe('tasks.cancel');
    expect(matchCatalog('GET', '/shares/s1/sessions')?.name).toBe('nfs_sessions.list');
    expect(matchCatalog('GET', '/no/such/route')).toBeUndefined();
    expect(matchCatalog('PUT', '/arrays')).toBeUndefined();
  });

  describe('every entry resolves to a mounted route', () => {
    let setup: Awaited<ReturnType<typeof buildTestApp>>;
    beforeEach(async () => {
      setup = await buildTestApp();
    });
    afterEach(async () => {
      await setup.cleanup();
    });

    it('no catalog path hits the NOT_FOUND catch-all', async () => {
      for (const entry of CATALOG) {
        const path = `/api/v1${entry.path.replaceAll(/\{[^}]+\}/g, 'x')}`;
        const req = request(setup.app);
        const r =
          entry.method === 'GET'
            ? req.get(path)
            : entry.method === 'POST'
              ? req.post(path)
              : entry.method === 'PATCH'
                ? req.patch(path)
                : req.delete(path);
        const res = await r.set('Authorization', ADMIN_TOKEN).send({});
        const unknownRoute =
          res.status === 404 && JSON.stringify(res.body).includes('no such API route');
        expect(unknownRoute, `${entry.name}: ${entry.method} ${path} is not mounted`).toBe(false);
      }
    }, 30_000);
  });
});
