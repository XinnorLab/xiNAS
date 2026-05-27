import { readFileSync, existsSync } from 'node:fs';

export type Role = 'viewer' | 'operator' | 'admin' | 'local_admin';

export interface TokenPrincipal {
  principal: string;
  role: Role;
}

export type ListenSpec =
  | { kind: 'unix'; socket: string }
  | { kind: 'tcp'; host: string; port: number };

export interface ApiConfig {
  controller_id: string;
  listen: ListenSpec;
  tokens: Record<string, TokenPrincipal>;
  state: {
    databasePath: string;
    auditJsonlPath: string;
    archiveDir?: string;
  };
}

const DEFAULT_PATH = '/etc/xinas-api/config.json';

/**
 * Load API config from a file (default `/etc/xinas-api/config.json`)
 * or take an inline object — the latter is for tests, where the file
 * doesn't exist and we want to inject a config directly.
 */
export function loadConfig(opts: { configPath?: string; inline?: ApiConfig } = {}): ApiConfig {
  if (opts.inline) return opts.inline;
  const path = opts.configPath ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `xinas-api config not found at ${path}; provide --config <path> or seed /etc/xinas-api/config.json`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as ApiConfig;
}
