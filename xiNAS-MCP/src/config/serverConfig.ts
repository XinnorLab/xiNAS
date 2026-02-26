/**
 * xiNAS-MCP server configuration.
 * Config file: /etc/xinas-mcp/config.json (auto-created on first run).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Role } from '../types/common.js';

const CONFIG_PATH = '/etc/xinas-mcp/config.json';
const CONFIG_DIR = '/etc/xinas-mcp';

export interface ServerConfig {
  controller_id: string;
  nfs_helper_socket: string;
  prometheus_url: string;
  audit_log_path: string;
  tokens: Record<string, Role>;
  sse_enabled: boolean;
  sse_port?: number;
}

const DEFAULTS: Omit<ServerConfig, 'controller_id'> = {
  nfs_helper_socket: '/run/xinas-nfs-helper.sock',
  prometheus_url: 'http://localhost:9827/metrics',
  audit_log_path: '/var/log/xinas/mcp-audit.jsonl',
  tokens: {},
  sse_enabled: false,
};

let _config: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  if (_config) return _config;

  let raw: Partial<ServerConfig> = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<ServerConfig>;
    } catch {
      // Use defaults if config is corrupt
    }
  }

  const config: ServerConfig = {
    controller_id: raw.controller_id ?? uuidv4(),
    nfs_helper_socket: raw.nfs_helper_socket ?? DEFAULTS.nfs_helper_socket,
    prometheus_url: raw.prometheus_url ?? DEFAULTS.prometheus_url,
    audit_log_path: raw.audit_log_path ?? DEFAULTS.audit_log_path,
    tokens: raw.tokens ?? DEFAULTS.tokens,
    sse_enabled: raw.sse_enabled ?? DEFAULTS.sse_enabled,
    ...(raw.sse_port !== undefined ? { sse_port: raw.sse_port } : {}),
  };

  // Persist if we generated a new controller_id
  if (!raw.controller_id) {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o750 });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o640 });
    } catch {
      // Non-fatal: proceed without persisting
    }
  }

  _config = config;
  return config;
}

export function getHostname(): string {
  return os.hostname();
}

/** Resolve role for an API token. Returns null if token not found. */
export function resolveTokenRole(token: string): Role | null {
  const config = loadConfig();
  return config.tokens[token] ?? null;
}

/** Ensure audit log directory exists */
export function ensureAuditLogDir(): void {
  const config = loadConfig();
  const dir = path.dirname(config.audit_log_path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }
}
