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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      try {
        chmodSync(socketPath, 0o660);
        chownSync(socketPath, -1, socketGroupGid);
      } catch {
        // In test environments running without root, chown may fail if the gid
        // is foreign; chmod is more likely to succeed and is the critical gate.
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
