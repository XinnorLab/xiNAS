/**
 * Unix domain socket client for the nfs-helper daemon.
 * Newline-delimited JSON protocol.
 */

import * as net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config/serverConfig.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import type { NfsRequest, NfsResponse, ExportEntry, QuotaSpec, SessionInfo } from '../types/nfs.js';

const CONNECT_TIMEOUT_MS = 5000;

async function send(req: NfsRequest): Promise<NfsResponse> {
  const config = loadConfig();
  const socketPath = config.nfs_helper_socket;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        socket.destroy();
        reject(new McpToolError(ErrorCode.INTERNAL, `nfs-helper daemon timeout (${socketPath})`));
      }
    }, CONNECT_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        done = true;
        clearTimeout(timeout);
        const line = buffer.slice(0, nl);
        socket.destroy();
        try {
          const resp = JSON.parse(line) as NfsResponse;
          resolve(resp);
        } catch {
          reject(new McpToolError(ErrorCode.INTERNAL, `nfs-helper returned invalid JSON: ${line}`));
        }
      }
    });

    socket.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        reject(new McpToolError(
          ErrorCode.INTERNAL,
          `Cannot connect to nfs-helper at ${socketPath}: ${err.message}. Is xinas-nfs-helper.service running?`
        ));
      }
    });
  });
}

function checkResponse(resp: NfsResponse): void {
  if (!resp.ok) {
    const code = (resp.code as ErrorCode | undefined) ?? ErrorCode.INTERNAL;
    throw new McpToolError(code, resp.error ?? 'nfs-helper returned error');
  }
}

export async function listExports(): Promise<ExportEntry[]> {
  const resp = await send({ op: 'list_exports', request_id: uuidv4() });
  checkResponse(resp);
  return resp.result as ExportEntry[];
}

export async function addExport(entry: ExportEntry): Promise<void> {
  const resp = await send({ op: 'add_export', request_id: uuidv4(), entry });
  checkResponse(resp);
}

export async function removeExport(exportPath: string): Promise<void> {
  const resp = await send({ op: 'remove_export', request_id: uuidv4(), path: exportPath });
  checkResponse(resp);
}

export async function updateExport(exportPath: string, patch: Partial<ExportEntry>): Promise<void> {
  const resp = await send({ op: 'update_export', request_id: uuidv4(), path: exportPath, patch });
  checkResponse(resp);
}

export async function listSessions(): Promise<SessionInfo[]> {
  const resp = await send({ op: 'list_sessions', request_id: uuidv4() });
  checkResponse(resp);
  return resp.result as SessionInfo[];
}

export async function getSessions(exportPath: string): Promise<SessionInfo[]> {
  const resp = await send({ op: 'get_sessions', request_id: uuidv4(), path: exportPath });
  checkResponse(resp);
  return resp.result as SessionInfo[];
}

export async function setQuota(quota: QuotaSpec): Promise<void> {
  const resp = await send({ op: 'set_quota', request_id: uuidv4(), quota });
  checkResponse(resp);
}

export async function reloadExports(): Promise<void> {
  const resp = await send({ op: 'reload', request_id: uuidv4() });
  checkResponse(resp);
}
