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

  // The real nfs-helper wire shape: { ok, result:[{path, clients:[{host, options}]}] }.
  const exportsFixture = {
    ok: true,
    result: [
      {
        path: '/srv/share01',
        clients: [{ host: '10.0.0.0/24', options: ['rw', 'no_root_squash'] }],
      },
    ],
    request_id: 'test',
  };
  // list_sessions wire shape: { ok, result:[{client_ip, nfs_version, export_path, active_locks}] }.
  const sessionsFixture = {
    ok: true,
    result: [
      {
        client_ip: '10.0.0.5',
        nfs_version: 'v4.1',
        export_path: '/srv/share01',
        active_locks: 0,
      },
    ],
    request_id: 'test',
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

  // A bare `connect ENOENT /run/xinas-nfs-helper.sock` reaches the operator
  // verbatim — through a task's error_message and the TUI's error dialog — and
  // names neither the component that is down nor the way back. The transport
  // owns the wrap so every consumer inherits it (nfs-helper-service-spec §4).
  it('callHelper() names the socket, the unit and the fix when the helper is not running', async () => {
    const probe = createNfsProbe({ helperSocket: '/tmp/does-not-exist-xinas.sock' });
    await expect(probe.listExports()).rejects.toThrow(
      /nfs-helper is not reachable at \/tmp\/does-not-exist-xinas\.sock \(ENOENT\)[\s\S]*systemctl start xinas-nfs-helper/,
    );
  });

  it('callHelper() preserves the original connect error as the cause', async () => {
    const probe = createNfsProbe({ helperSocket: '/tmp/does-not-exist-xinas.sock' });
    const err = await probe.listExports().catch((e: unknown) => e);
    expect((err as Error).cause).toMatchObject({ code: 'ENOENT' });
  });
});
