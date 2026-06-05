import { connect } from 'node:net';

/**
 * api→agent JSON-RPC-2.0-over-NDJSON client over the agent's UDS
 * (s2-task-envelope-spec §2/§5.2). Generalized from the heartbeat probe
 * (`createAgentHealthProbe`, which now delegates here): each `call()`
 *   1. connects to `socketPath`,
 *   2. writes one NDJSON line `{"jsonrpc":"2.0","id":1,"method":<m>,"params":<p>}`,
 *   3. reads one response line and JSON-parses it,
 *   4. resolves the JSON-RPC `result`, or
 *   5. rejects with `AgentRpcError` (JSON-RPC `error`), a connect error
 *      (ECONNREFUSED/ENOENT), a malformed response, or a timeout.
 *
 * One connection per call (the agent UDS is cheap and the api is the only
 * client); the socket is always destroyed on completion so no fd leaks.
 * `task.begin` dispatch (T4) and the heartbeat tick both ride on this.
 */
export interface AgentRpcClient {
  /**
   * Perform one JSON-RPC call. Resolves the `result`; rejects with
   * `AgentRpcError` on a JSON-RPC error frame, or a plain `Error` on
   * connect-refused / malformed-response / timeout.
   */
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

/** A JSON-RPC error frame returned by the agent. Carries the RPC `data`
 * (e.g. `{ code: 'EXECUTOR_UNSUPPORTED' }`) so callers can branch. */
export class AgentRpcError extends Error {
  readonly rpcCode: number;
  readonly data: unknown;
  constructor(rpcCode: number, message: string, data: unknown) {
    super(message);
    this.name = 'AgentRpcError';
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

export function createAgentRpcClient(socketPath: string): AgentRpcClient {
  return {
    call(method, params, timeoutMs) {
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let buf = '';
        const socket = connect(socketPath);

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          fn();
        };
        const fail = (err: Error): void => finish(() => reject(err));
        const succeed = (value: unknown): void => finish(() => resolve(value));

        // NOT unref'd: this one-shot timer self-clears on every settle path
        // (success / error / timeout all clearTimeout), so it can never
        // outlive the call by more than timeoutMs. Leaving it ref'd keeps a
        // pending RPC from being silently dropped if the process is otherwise
        // idle (and avoids a vitest fake/real-timer starvation footgun).
        const timer = setTimeout(() => {
          fail(new Error(`agent RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        socket.on('connect', () => {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
        });

        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl === -1) return; // wait for a full line
          const line = buf.slice(0, nl);
          let parsed: {
            result?: unknown;
            error?: { code?: number; message?: string; data?: unknown };
          };
          try {
            parsed = JSON.parse(line) as typeof parsed;
          } catch {
            fail(new Error(`agent RPC ${method} response was not valid JSON`));
            return;
          }
          if (parsed.error) {
            fail(
              new AgentRpcError(
                parsed.error.code ?? -32000,
                parsed.error.message ?? 'unknown agent error',
                parsed.error.data,
              ),
            );
            return;
          }
          succeed(parsed.result);
        });

        socket.on('error', (err: Error) => fail(err));
        socket.on('end', () => {
          fail(new Error(`agent RPC ${method} connection closed before response`));
        });
      });
    },
  };
}
