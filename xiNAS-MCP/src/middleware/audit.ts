/**
 * Audit logger.
 * Appends tamper-evident (hash-chained) JSON lines to audit log file.
 * Also writes to syslog via /dev/log Unix datagram socket.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';
import { loadConfig, ensureAuditLogDir } from '../config/serverConfig.js';

export interface AuditEntry {
  request_id: string;
  principal: string;
  timestamp: string;
  controller_id: string;
  tool_name: string;
  parameters_hash: string;
  result_hash: string;
  job_id?: string;
  duration_ms: number;
  error?: string;
  prev_hash: string;
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashObject(obj: unknown): string {
  return sha256(JSON.stringify(obj));
}

let lastHash = '0'.repeat(64);

function writeSyslog(message: string): void {
  try {
    // PRI = facility(1=user) * 8 + severity(6=info) = 14
    const msg = `<14>xinas-mcp: ${message}`;
    const buf = Buffer.from(msg);
    // Best-effort connection to /dev/log Unix socket
    const conn = net.createConnection('/dev/log');
    conn.on('connect', () => { conn.write(buf); conn.end(); });
    conn.on('error', () => { /* ignore */ });
  } catch {
    // Syslog is best-effort — never fail the main operation
  }
}

export class AuditLogger {
  static async log(entry: Omit<AuditEntry, 'prev_hash'>): Promise<void> {
    const config = loadConfig();
    ensureAuditLogDir();

    const fullEntry: AuditEntry = {
      ...entry,
      prev_hash: lastHash,
    };

    const line = JSON.stringify(fullEntry) + '\n';
    lastHash = sha256(line);

    try {
      fs.appendFileSync(config.audit_log_path, line, { mode: 0o640 });
    } catch {
      // Non-fatal
    }

    // Syslog (best-effort)
    const syslogMsg = `${entry.tool_name} by ${entry.principal} [${entry.request_id}] ${entry.error ? `ERROR: ${entry.error}` : 'OK'} (${entry.duration_ms}ms)`;
    writeSyslog(syslogMsg);
  }

  static hashParams(params: unknown): string {
    return hashObject(params);
  }

  static hashResult(result: unknown): string {
    return hashObject(result);
  }
}
