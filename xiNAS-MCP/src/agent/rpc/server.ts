/**
 * UDS RPC server for xinas-agent.
 *
 * Binds a Unix domain socket at `socketPath`.  After binding:
 *   - `chmodSync(socketPath, 0o660)` so only owner and group can connect.
 *   - `chownSync(socketPath, -1, socketGroupGid)` to assign the xinas-api
 *     group (gid resolved by the caller from the group name at boot time).
 *     `-1` for uid preserves the existing owner (root when running as root).
 *
 * Per connection: buffers incoming data, splits on '\n', feeds each
 * complete line to the dispatcher, writes the response line followed
 * by '\n' back to the socket.  Connections are not multiplexed — each
 * request/response pair is processed in order on its connection.
 *
 * Returns a handle with a `close()` method that stops accepting new
 * connections and resolves when the server socket is closed.
 */

import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { log } from '../log.js';

// Cap the per-connection read buffer. A client that never sends '\n' would
// otherwise grow `buf` without bound and OOM the root daemon (DoS guard).
const MAX_LINE_BYTES = 1024 * 1024; // 1 MB

export interface AgentRpcServerOptions {
  socketPath: string;
  dispatch: (line: string) => Promise<string>;
  socketGroupGid: number;
}

export interface AgentRpcServerHandle {
  close(): Promise<void>;
}

export async function createAgentRpcServer(
  opts: AgentRpcServerOptions,
): Promise<AgentRpcServerHandle> {
  const { socketPath, dispatch, socketGroupGid } = opts;

  // Clean up any stale socket file from a previous run.
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server: Server = createServer((socket: Socket) => {
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE_BYTES) {
        if (!socket.destroyed) {
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Invalid Request: request too large' },
            })}\n`,
          );
        }
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        dispatch(line)
          .then((response) => {
            if (!socket.destroyed) socket.write(`${response}\n`);
          })
          .catch(() => {
            // dispatch itself should never throw; defensive fallback.
            if (!socket.destroyed) {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: null,
                  error: { code: -32603, message: 'Internal error' },
                })}\n`,
              );
            }
          });
      }
    });
    socket.on('error', () => socket.destroy());
  });

  // Tighten umask so the UDS is born 0660 (not 0755 / world-connectable)
  // for the window between bind and the post-listen chmod. Restored inside
  // the listen callback / on error — NOT in a synchronous finally, because
  // listen is async and the socket is created after the call returns.
  const prevUmask = process.umask(0o117); // socket born 0660
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      process.umask(prevUmask);
      reject(err);
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      process.umask(prevUmask); // restore right after bind
      server.removeListener('error', onError);
      try {
        chmodSync(socketPath, 0o660);
        chownSync(socketPath, -1, socketGroupGid);
      } catch (err) {
        // The socket is the only auth gate. As root (production) a
        // mis-permissioned socket must not serve — fail closed so systemd
        // Restart=on-failure retries. As non-root (test/dev) chown to a
        // foreign gid fails as expected; tolerate with a warn.
        const isRoot = process.getuid?.() === 0;
        if (isRoot) {
          log('error', 'rpc', 'socket_perm_failed', {
            socket: socketPath,
            error: err instanceof Error ? err.message : String(err),
          });
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        log('warn', 'rpc', 'socket_perm_skipped', {
          socket: socketPath,
          reason: 'not running as root (test/dev)',
        });
      }
      resolve();
    });
  });

  return {
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
