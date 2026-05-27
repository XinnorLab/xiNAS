import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../api/server.js';

describe('startServer', () => {
  it('binds on a TCP port and accepts a request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-api-server-'));
    try {
      const handle = await startServer({
        inline: {
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
          state: { databasePath: join(dir, 'xinas.db'), auditJsonlPath: join(dir, 'audit.jsonl') },
        },
      });
      try {
        const port = (handle.address as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          headers: { Authorization: 'Bearer tok-admin' },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.result.overall).toBe('ok');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
