/**
 * Unix domain socket client for the nfs-helper daemon.
 * Newline-delimited JSON protocol.
 */

import * as net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config/serverConfig.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import type {
  NfsRequest,
  NfsResponse,
  ExportEntry,
  QuotaSpec,
  SessionInfo,
  NfsConfFixRequest,
  NfsConfFixResult,
} from '../types/nfs.js';

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
        reject(
          new McpToolError(
            ErrorCode.INTERNAL,
            `Cannot connect to nfs-helper at ${socketPath}: ${err.message}. Is xinas-nfs-helper.service running?`,
          ),
        );
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

export interface AddExportOptions {
  /** When true, the helper will mkdir the export path if it does not exist (single level; parent must exist). */
  createPath?: boolean;
  /** Octal mode string (e.g. "0755", "1777") applied to the newly-created directory. Ignored when createPath is false. */
  pathMode?: string;
}

export async function addExport(entry: ExportEntry, opts: AddExportOptions = {}): Promise<void> {
  const req: NfsRequest = { op: 'add_export', request_id: uuidv4(), entry };
  if (opts.createPath) {
    req.create_path = true;
    if (opts.pathMode) req.path_mode = opts.pathMode;
  }
  const resp = await send(req);
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

export async function fixNfsConf(req: NfsConfFixRequest): Promise<NfsConfFixResult> {
  const resp = await send({
    op: 'fix_nfs_conf',
    request_id: uuidv4(),
    ...req,
  });
  checkResponse(resp);
  return resp.result as NfsConfFixResult;
}
