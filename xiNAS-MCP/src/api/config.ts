import { readFileSync, existsSync } from 'node:fs';

export type Role = 'viewer' | 'operator' | 'admin' | 'local_admin';

export interface TokenPrincipal {
  principal: string;
  role: Role;
}

export type ListenSpec =
  | {
      kind: 'unix';
      socket: string;
      /**
       * Optional numeric gid to chown the socket file to after binding.
       * When set, server.ts runs `chown(socketPath, -1, socketGroup)`
       * so members of that group can connect (combined with the 0o660
       * mode set unconditionally). The Phase 0 Ansible role templates
       * this from the xinas-admin group's gid. When unset, the socket
       * keeps its default ownership (the process's primary group) and
       * only the api process itself can connect — safe but unusable
       * from operator tools, so production deployments MUST set this.
       */
      socketGroup?: number;
    }
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
