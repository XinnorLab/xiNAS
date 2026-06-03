import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNfsProbe } from '../../../agent/probe/nfs.js';

/**
 * Starts a mock helper server on a temp socket.
 * Responds to every line with JSON for the requested op.
 */
function startMockHelper(socketPath: string, responses: Record<string, unknown>) {
  return new Promise<ReturnType<typeof createNetServer>>((resolve) => {
    const server = createNetServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const req = JSON.parse(line) as { op: string };
          const resp = responses[req.op] ?? { error: 'unknown op' };
          conn.write(JSON.stringify(resp) + '\n');
        } catch {
          conn.write(JSON.stringify({ error: 'parse error' }) + '\n');
        }
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

describe('NfsProbe', () => {
  const socketPath = join(tmpdir(), `xinas-test-helper-${process.pid}.sock`);
  let server: ReturnType<typeof createNetServer>;

  // Use the nested clients format that parseListExports expects
  const exportsFixture = {
    exports: [
      {
        path: '/srv/share01',
        clients: [{ host_pattern: '10.0.0.0/24', options: ['rw', 'no_root_squash'] }],
      },
    ],
  };
  // parseListSessions expects flat sessions array with these fields
  const sessionsFixture = {
    sessions: [
      {
        client_addr: '10.0.0.5',
        client_hostname: 'client-01',
        export_path: '/srv/share01',
        proto_version: 'v4.1',
        locked_files: 0,
      },
    ],
  };

  afterAll(async () => {
    server?.close();
    await import('node:fs/promises').then((fs) => fs.unlink(socketPath).catch(() => {}));
  });

  it('listExports() returns parsed exports from mock helper', async () => {
    server = await startMockHelper(socketPath, {
      list_exports: exportsFixture,
      list_sessions: sessionsFixture,
    });
    const probe = createNfsProbe({ helperSocket: socketPath });
    const exports_ = await probe.listExports();
    expect(exports_).toHaveLength(1);
    expect(exports_[0]?.export_path).toBe('/srv/share01');
  });

  it('listSessions() returns parsed sessions from mock helper', async () => {
    const probe = createNfsProbe({ helperSocket: socketPath });
    const sessions = await probe.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.spec.client_addr).toBe('10.0.0.5');
    expect(sessions[0]?.status.proto_version).toBe('v4.1');
  });

  it('callHelper() rejects when socket is absent', async () => {
    const probe = createNfsProbe({ helperSocket: '/tmp/does-not-exist-xinas.sock' });
    await expect(probe.listExports()).rejects.toThrow();
  });
});
