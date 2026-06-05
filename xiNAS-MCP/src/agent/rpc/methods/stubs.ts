/**
 * Stub handlers for every ADR-0002 enumerated method that is not yet
 * implemented in S0+S1.
 *
 * Each stub throws an error with:
 *   err.code   = 'EXECUTOR_UNSUPPORTED'
 *   err.rpcMethod = <the method name>
 *
 * The dispatcher (dispatch.ts) catches this sentinel and emits a
 * JSON-RPC -32000 envelope with data.code = 'EXECUTOR_UNSUPPORTED'.
 *
 * Why a throw and not a direct return?  The handler's return type is
 * `unknown`; a throw keeps the dispatch path symmetric (all errors go
 * through the catch block, which formats them consistently per spec).
 *
 * STUB_METHODS is exported as a plain map; merge it into the full
 * handler map in the process entry point alongside the real handlers.
 */

import type { RpcHandler } from '../dispatch.js';

export function makeStubHandler(method: string): RpcHandler {
  return function stubHandler(_params: unknown): never {
    const err = new Error('method not implemented in this build') as Error & {
      code: string;
      rpcMethod: string;
    };
    err.code = 'EXECUTOR_UNSUPPORTED';
    err.rpcMethod = method;
    throw err;
  };
}

const STUB_METHOD_NAMES = [
  // On-demand observation reads (deferred to WS12 convergence). The spec's RPC
  // table once marked these "Real", but the LIVE data path in S0/S1 is the push
  // model (Flow A: collectors -> publisher -> POST /internal/v1/observed); no
  // S0/S1 caller uses the on-demand pull surface. Registering them here makes
  // them enumerated-but-stubbed (EXECUTOR_UNSUPPORTED) instead of an unknown
  // -32601, which is the correct contract signal until WS12 wires the reads.
  'inventory.collect',
  'disks.list',
  'filesystems.list',
  'mounts.list',
  'network.snapshot',
  'systemd.units_status',
  'exports.list',
  'nfs.sessions.list',
  // Arrays (xiRAID adapter — S3/WS5)
  'arrays.create',
  'arrays.delete',
  'arrays.import',
  'arrays.list',
  // Spare (xiRAID — S3/WS5)
  'spare.set',
  // Filesystem (S4/WS6)
  'fs.create',
  'fs.mount',
  'fs.unmount',
  'fs.grow',
  'fs.set_quota_mode',
  // NFS exports (S5/WS7)
  'nfs.exports.add',
  'nfs.exports.update',
  'nfs.exports.remove',
  // NFS profile (S5/WS7)
  'nfs.profile.render',
  'nfs.profile.apply',
  'nfs.profile.observe',
  // Network (S6/WS8)
  'network.render_netplan',
  'network.flush_managed',
  'network.apply',
  // Systemd (S4/WS6)
  'systemd.reload',
  'systemd.restart',
  // Task envelope (S2/WS4): task.begin/cancel/list_inflight get real handlers
  // in a later S2 task; task.stage_report is removed entirely and replaced by
  // the agent→api push (POST /internal/v1/task_progress). None are api→agent
  // stubs — they MUST NOT be enumerated here.
  // Managed files drift (WS9)
  'managed_files.checksums',
] as const;

export type StubMethodName = (typeof STUB_METHOD_NAMES)[number];

export const STUB_METHODS: Record<string, RpcHandler> = Object.fromEntries(
  STUB_METHOD_NAMES.map((m) => [m, makeStubHandler(m)]),
);
