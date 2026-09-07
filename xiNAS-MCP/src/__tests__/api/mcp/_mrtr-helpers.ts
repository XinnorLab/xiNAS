import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { join } from 'node:path';

/**
 * Shared wire-format helpers for the MCP MRTR confirmation integration
 * suites (S15 Task 10, Task 14). Extracted from `mcp-confirmation.test.ts`
 * (its original home) so `confirmation-restart.test.ts` (Task 14 — the
 * expiry-sweep / restart-recovery suite) can drive the exact same modern
 * `tools/call` wire format — `rpc`/`call`/`planShareUpdate`-style request
 * building, response unwrapping, and audit-log reading — against a SECOND
 * `startServer()` boot without duplicating it.
 *
 * `port` is an explicit parameter everywhere (never a closed-over module
 * variable): a restart test boots the server twice on the same
 * `databasePath`, and the two boots bind two DIFFERENT ports.
 */

export interface RpcResult {
  status: number;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export function rpc(
  port: number,
  message: unknown,
  opts: { token?: string } = {},
): Promise<RpcResult> {
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Plain REST call (loopback-free — a real client request) for e.g. the plan-ownership / REST-approval tests. */
export function restCall(
  port: number,
  token: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1${path}`,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export const META = (elicitation?: Record<string, object>) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'conformance', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': elicitation === undefined ? {} : { elicitation },
});
export const FORM = { form: {} };
export const BOTH = { form: {}, url: {} };

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export async function call(
  port: number,
  token: string,
  id: string | number,
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  caps: Record<string, object> | undefined = FORM,
): Promise<RpcResult> {
  return rpc(
    port,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { _meta: META(caps), name, arguments: args, ...extra },
    },
    { token },
  );
}

export interface ToolResultBody {
  resultType?: string;
  content?: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState?: string;
}

export function toolResultOf(res: RpcResult): ToolResultBody {
  return (res.body.result ?? {}) as ToolResultBody;
}

export interface ToolPayload {
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** Parse the JSON text body of a COMPLETE (non-input_required) tool result. */
export function payloadOf(res: RpcResult): ToolPayload {
  const r = toolResultOf(res);
  if (r.content === undefined) return {};
  return JSON.parse(r.content[0]?.text ?? '{}') as ToolPayload;
}

export function rpcErrorOf(
  res: RpcResult,
): { code: number; message: string; data?: Record<string, unknown> } | undefined {
  return res.body.error as
    | { code: number; message: string; data?: Record<string, unknown> }
    | undefined;
}

export interface AuditRow {
  kind?: string;
  principal?: string;
  client_type?: string;
  payload?: Record<string, unknown>;
}

export function auditRows(dir: string): AuditRow[] {
  try {
    return readFileSync(join(dir, 'a.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRow);
  } catch {
    return [];
  }
}

/** A plain `shares.update` plan (S15 Task 10/14 fixture) — risk_level 'changing_access', form mode. */
export async function planShareUpdate(
  port: number,
  token: string,
  shareId = 'share-a',
  clients: Array<{ pattern: string; options: string[] }> = [
    { pattern: '10.0.0.0/8', options: ['ro'] },
  ],
): Promise<{ plan_id: string; expected_revision: number; risk_level: string }> {
  const res = await call(port, token, nextId('plan-share'), 'shares.update', {
    id: shareId,
    mode: 'plan',
    spec: { clients },
  });
  const payload = payloadOf(res);
  const result = payload.result as {
    plan_id: string;
    state_revision_expected: number;
    risk_level: string;
  };
  return {
    plan_id: result.plan_id,
    expected_revision: result.state_revision_expected,
    risk_level: result.risk_level,
  };
}

/**
 * `filesystems.create` with `spec.force: true` is risk_level 'destructive'
 * / rollback_model 'unsupported', and its plan carries the engine-owned
 * advisory `dangerous_flag_required` blocker (`lib/fs/validate.ts`
 * `validateFsCreate`) — the same static advisory `arrays.delete` and
 * `config.rollback` attach. Fix round 1 (F1, ruling R-10.1) made Gate 7
 * exclude that one code (every REST apply route already filters it the
 * same way; `TaskEngine.apply` enforces the real `dangerous` flag at
 * apply time), so the REAL, unmodified plan document now reaches url
 * mode over MCP — no hand-edited blockers/hash needed here.
 */
export async function planFsCreateForce(
  port: number,
  token: string,
  mountpoint: string,
  backingDevice = '/dev/xi_data',
): Promise<{
  plan_id: string;
  expected_revision: number;
  risk_level: string;
  blockers: unknown[];
}> {
  const res = await call(port, token, nextId('plan-fs'), 'filesystems.create', {
    mode: 'plan',
    spec: { backing_device: backingDevice, mountpoint, force: true },
  });
  const payload = payloadOf(res);
  const result = payload.result as {
    plan_id: string;
    state_revision_expected: number;
    risk_level: string;
    blockers: unknown[];
  };
  return {
    plan_id: result.plan_id,
    expected_revision: result.state_revision_expected,
    risk_level: result.risk_level,
    blockers: result.blockers,
  };
}
