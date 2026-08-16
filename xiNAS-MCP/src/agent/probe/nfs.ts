/**
 * NFS helper probe — privileged layer.
 *
 * Unix-socket client for /run/xinas-nfs-helper.sock.
 * callHelper(op, params) connects, writes JSON + newline, reads one line, parses.
 * Implements listExports(), listSessions(), fixNfsConf() delegating to
 * parseListExports / parseListSessions (B6).
 *
 * Injectable socket factory for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { type Socket, createConnection } from 'node:net';
import {
  type ObservedExportRule,
  type ObservedNfsSession,
  parseListExports,
  parseListSessions,
} from '../../lib/parse/nfs.js';

export type SocketFactory = (path: string) => Socket;

/** Max bytes buffered from the nfs-helper before a response is rejected. */
const MAX_RESP_BYTES = 1024 * 1024; // 1 MiB

/**
 * Connect-time failures that mean "the helper daemon is not there", as opposed
 * to a helper that answered: no socket file (not running), a stale socket file
 * with no listener, or a socket we may not open.
 */
const HELPER_DOWN_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES']);

/**
 * Turn a raw libuv connect error into one that names the component and the
 * way back. `connect ENOENT /run/xinas-nfs-helper.sock` reaches the operator
 * verbatim — through a task's `error_message` and the TUI error dialog — and
 * says neither "the helper is down" nor how to fix it. Errors from a helper
 * that DID answer are passed through untouched: they already identify
 * themselves and carry the helper's own code
 * (docs/control-path/nfs-helper-service-spec.md §4).
 */
function wrapConnectError(err: unknown, socketPath: string): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === undefined || !HELPER_DOWN_CODES.has(code)) return err;
  const cause = err instanceof Error ? err.message : String(err);
  return new Error(
    `nfs-helper is not reachable at ${socketPath} (${code}): ${cause} — ` +
      'xinas-nfs-helper.service is not running; start it with: ' +
      'systemctl start xinas-nfs-helper',
    { cause: err },
  );
}

interface NfsProbeOptions {
  helperSocket?: string;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
}

export interface NfsProbe {
  callHelper(op: string, params?: Record<string, unknown>): Promise<unknown>;
  listExports(): Promise<ObservedExportRule[]>;
  listSessions(): Promise<ObservedNfsSession[]>;
  fixNfsConf(): Promise<{ changed: boolean; message?: string }>;
}

export function createNfsProbe(opts: NfsProbeOptions = {}): NfsProbe {
  const helperSocket = opts.helperSocket ?? '/run/xinas-nfs-helper.sock';
  const sockFactory = opts.socketFactory ?? ((path) => createConnection(path));
  const timeout = opts.timeoutMs ?? 5000;

  async function callHelper(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const conn = sockFactory(helperSocket);
      let buf = '';
      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error(`nfs-helper call '${op}' timed out after ${timeout}ms`));
      }, timeout);

      conn.on('connect', () => {
        conn.write(JSON.stringify({ op, ...params }) + '\n');
      });
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        // Defense-in-depth: even though the helper is a trusted local
        // process and the timeout bounds the wait, cap the buffer so a
        // misbehaving/compromised helper streaming without a newline can't
        // force a large allocation in the root agent.
        if (buf.length > MAX_RESP_BYTES) {
          clearTimeout(timer);
          conn.destroy();
          reject(new Error(`nfs-helper call '${op}' response exceeded ${MAX_RESP_BYTES} bytes`));
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          const line = buf.slice(0, nl);
          conn.destroy();
          try {
            resolve(JSON.parse(line));
          } catch (e) {
            reject(new Error(`nfs-helper: invalid JSON response for op '${op}': ${e}`));
          }
        }
      });
      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(wrapConnectError(err, helperSocket));
      });
    });
  }

  return {
    callHelper,

    async listExports(): Promise<ObservedExportRule[]> {
      const resp = await callHelper('list_exports');
      // parseListExports expects a raw JSON string
      return parseListExports(JSON.stringify(resp));
    },

    async listSessions(): Promise<ObservedNfsSession[]> {
      const resp = await callHelper('list_sessions');
      // parseListSessions expects a raw JSON string
      return parseListSessions(JSON.stringify(resp));
    },

    async fixNfsConf(): Promise<{ changed: boolean; message?: string }> {
      const resp = (await callHelper('fix_nfs_conf')) as { changed?: boolean; message?: string };
      return {
        changed: resp.changed ?? false,
        ...(resp.message !== undefined ? { message: resp.message } : {}),
      };
    },
  };
}
